//! Post-render quality control.
//!
//! One supervised FFmpeg pass over the verified partial output runs
//! `blackdetect`, `freezedetect`, `silencedetect`, `astats` and `ebur128`; its
//! stderr is parsed into time-ranged findings. Caption cues are checked against
//! the output duration and the frame's safe area. Findings carry a stable
//! `findingId` (SHA-256 over kind, source, subject, decisecond-rounded range and
//! revision state hash) that matches `@supa-video/qc` `computeFindingId`, so
//! the id excludes frame size and survives across delivery presets.

use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    path::Path,
    time::Duration,
};

use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};

use super::{
    delivery::SafeAreaRect,
    derived::MediaPrograms,
    error::{VideoCommandError, VideoErrorCode},
    process::{run_supervised, ProcessCancellation, ProcessFailure, ProcessSpec},
    project::graphics::GraphicsLayer,
    text_boxes::{
        caption_box, caption_font, caption_text_size, drawn_text, layer_box, renderer_pivot_size,
        resting_intervals, visible_spans, Rect,
    },
    text_layout::{load_text_font, MeasureText, TextMeasurer},
    types::{RenderCaptionInput, RenderGraphicsInputV2},
};

pub(crate) const QC_DETECTOR_VERSION: &str = "qc-v2";
pub(crate) const QC_MAX_FINDINGS: usize = 512;
pub(crate) const QC_MESSAGE_MAX: usize = 480;
pub(crate) const QC_SUBJECT_MAX: usize = 128;
const QC_STDERR_TAIL_LIMIT: usize = 512 * 1024;
const QC_STDOUT_LIMIT: usize = 64 * 1024;
const QC_FAILURE_TAIL_BYTES: usize = 1024;

/// Detector thresholds. Defaults follow the FFmpeg filter documentation
/// (`blackdetect` pix_th 0.10, `freezedetect` noise -60 dB) tightened for
/// delivery: short gaps are warnings, sustained ones block.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct QcThresholds {
    pub(crate) black_min_seconds: f64,
    pub(crate) black_blocker_seconds: f64,
    pub(crate) freeze_min_seconds: f64,
    pub(crate) freeze_blocker_seconds: f64,
    pub(crate) silence_noise_db: f64,
    pub(crate) silence_min_seconds: f64,
    pub(crate) clipping_peak_dbfs: f64,
    pub(crate) loudness_tolerance_lu: f64,
    /// Fastest comfortable reading speed for on-screen text, in characters per second.
    pub(crate) reading_chars_per_second: f64,
}

impl Default for QcThresholds {
    fn default() -> Self {
        Self {
            black_min_seconds: 0.5,
            black_blocker_seconds: 1.0,
            freeze_min_seconds: 1.0,
            freeze_blocker_seconds: 2.0,
            silence_noise_db: -50.0,
            silence_min_seconds: 2.0,
            clipping_peak_dbfs: -0.1,
            loudness_tolerance_lu: 1.0,
            reading_chars_per_second: 17.0,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QcSeverity {
    Blocker,
    Warning,
    Info,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QcSource {
    Deterministic,
    Editorial,
    Rights,
}

impl QcSource {
    fn as_str(self) -> &'static str {
        match self {
            Self::Deterministic => "deterministic",
            Self::Editorial => "editorial",
            Self::Rights => "rights",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QcFindingKind {
    BlackFrames,
    FreezeFrames,
    Silence,
    AudioClipping,
    LoudnessOffTarget,
    SubtitleOutOfBounds,
    ReadingTimeShort,
    TextOutsideSafeArea,
    TextOverlap,
    MissingMedia,
    RepeatedAsset,
    UncoveredBeat,
    MustShowMissing,
    MustNotShowPresent,
    RightsBlocked,
    MotionStutter,
    MotionDrift,
    MotionCutJump,
}

impl QcFindingKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::BlackFrames => "black_frames",
            Self::FreezeFrames => "freeze_frames",
            Self::Silence => "silence",
            Self::AudioClipping => "audio_clipping",
            Self::LoudnessOffTarget => "loudness_off_target",
            Self::SubtitleOutOfBounds => "subtitle_out_of_bounds",
            Self::ReadingTimeShort => "reading_time_short",
            Self::TextOutsideSafeArea => "text_outside_safe_area",
            Self::TextOverlap => "text_overlap",
            Self::MissingMedia => "missing_media",
            Self::RepeatedAsset => "repeated_asset",
            Self::UncoveredBeat => "uncovered_beat",
            Self::MustShowMissing => "must_show_missing",
            Self::MustNotShowPresent => "must_not_show_present",
            Self::RightsBlocked => "rights_blocked",
            Self::MotionStutter => "motion_stutter",
            Self::MotionDrift => "motion_drift",
            Self::MotionCutJump => "motion_cut_jump",
        }
    }

    pub(crate) fn is_editorial(self) -> bool {
        matches!(
            self,
            Self::RepeatedAsset
                | Self::UncoveredBeat
                | Self::MustShowMissing
                | Self::MustNotShowPresent
                | Self::MissingMedia
                | Self::MotionStutter
                | Self::MotionDrift
                | Self::MotionCutJump
        )
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QcRange {
    pub start_us: u64,
    pub end_us: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QcFinding {
    pub finding_id: String,
    pub kind: QcFindingKind,
    pub severity: QcSeverity,
    pub source: QcSource,
    /// Stable subject inside the range. Part of the `findingId` hash. One of:
    /// - an asset id, beat id or caption id;
    /// - `"<graphicsClipId>:<layerIndex>"` for a graphics text layer;
    /// - for `text_overlap`, the two involved subjects sorted (byte order) and
    ///   joined with `+`, e.g. `"<captionId>+<graphicsClipId>:0"`;
    /// - `""` when there is none.
    pub subject: String,
    pub range: QcRange,
    pub message: String,
}

impl QcFinding {
    pub(crate) fn new(
        kind: QcFindingKind,
        severity: QcSeverity,
        source: QcSource,
        subject: &str,
        range: QcRange,
        message: String,
        revision_state_hash: &str,
    ) -> Self {
        Self {
            finding_id: finding_id(kind, source, subject, range, revision_state_hash),
            kind,
            severity,
            source,
            subject: subject.to_owned(),
            range,
            message,
        }
    }

    /// Structural validity shared by native and IPC-supplied findings.
    pub(crate) fn is_well_formed(&self, revision_state_hash: &str) -> bool {
        is_sha256_hex(&self.finding_id)
            && self.range.end_us >= self.range.start_us
            && !self.message.is_empty()
            && self.message.len() <= QC_MESSAGE_MAX
            && self.subject.len() <= QC_SUBJECT_MAX
            && self.finding_id
                == finding_id(
                    self.kind,
                    self.source,
                    &self.subject,
                    self.range,
                    revision_state_hash,
                )
    }
}

pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Tenth-of-a-second bucket, round half up (`roundToDeciseconds` in TS).
pub(crate) fn round_decisecond(us: u64) -> u64 {
    us.saturating_add(50_000) / 100_000
}

/// Canonical payload with keys in sorted order; matches `findingIdPayload`.
pub(crate) fn finding_id_payload(
    kind: QcFindingKind,
    source: QcSource,
    subject: &str,
    range: QcRange,
    revision_state_hash: &str,
) -> String {
    let string = |value: &str| serde_json::to_string(value).unwrap_or_else(|_| "\"\"".into());
    format!(
        "{{\"endDs\":{},\"kind\":{},\"revisionStateHash\":{},\"source\":{},\"startDs\":{},\"subject\":{}}}",
        round_decisecond(range.end_us),
        string(kind.as_str()),
        string(revision_state_hash),
        string(source.as_str()),
        round_decisecond(range.start_us),
        string(subject),
    )
}

pub(crate) fn finding_id(
    kind: QcFindingKind,
    source: QcSource,
    subject: &str,
    range: QcRange,
    revision_state_hash: &str,
) -> String {
    hex_sha256(finding_id_payload(kind, source, subject, range, revision_state_hash).as_bytes())
}

pub(crate) fn hex_sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Deterministic order: range start, kind, id.
pub(crate) fn sort_findings(findings: &mut [QcFinding]) {
    findings.sort_by(|left, right| {
        left.range
            .start_us
            .cmp(&right.range.start_us)
            .then_with(|| left.kind.as_str().cmp(right.kind.as_str()))
            .then_with(|| left.finding_id.cmp(&right.finding_id))
    });
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum QcStatus {
    Passed,
    Warnings,
    Blocked,
}

pub(crate) fn qc_status(findings: &[QcFinding]) -> QcStatus {
    if findings
        .iter()
        .any(|finding| finding.severity == QcSeverity::Blocker)
    {
        QcStatus::Blocked
    } else if findings
        .iter()
        .any(|finding| finding.severity == QcSeverity::Warning)
    {
        QcStatus::Warnings
    } else {
        QcStatus::Passed
    }
}

/// Blockers not resolved by an accepted (non-rights) finding id, sorted.
pub(crate) fn unresolved_blockers(
    findings: &[QcFinding],
    accepted_finding_ids: &BTreeSet<String>,
) -> Vec<String> {
    findings
        .iter()
        .filter(|finding| finding.severity == QcSeverity::Blocker)
        .filter(|finding| {
            finding.source == QcSource::Rights
                || finding.kind == QcFindingKind::RightsBlocked
                || !accepted_finding_ids.contains(&finding.finding_id)
        })
        .map(|finding| finding.finding_id.clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

/// What the QC pass needs to know about the render.
#[derive(Debug, Clone)]
pub(crate) struct QcAnalysisConfig {
    pub(crate) duration_us: u64,
    pub(crate) has_audio: bool,
    pub(crate) video_hidden: bool,
    pub(crate) loudness_target_lufs: Option<f64>,
    pub(crate) thresholds: QcThresholds,
    pub(crate) timeout: Duration,
}

pub(crate) fn qc_arguments(path: &str, config: &QcAnalysisConfig) -> Vec<String> {
    let thresholds = &config.thresholds;
    let video = format!(
        "[0:v:0]blackdetect=d={}:pix_th=0.10,freezedetect=n=-60dB:d={}[qcv]",
        thresholds.black_min_seconds, thresholds.freeze_min_seconds
    );
    let mut arguments = vec![
        "-hide_banner".to_owned(),
        "-nostdin".to_owned(),
        "-nostats".to_owned(),
        "-loglevel".to_owned(),
        "info".to_owned(),
        "-i".to_owned(),
        path.to_owned(),
        "-filter_complex".to_owned(),
    ];
    if config.has_audio {
        arguments.push(format!(
            "{video};[0:a:0]silencedetect=n={}dB:d={},astats=measure_perchannel=none:measure_overall=Peak_level,ebur128=peak=true:framelog=quiet[qca]",
            thresholds.silence_noise_db, thresholds.silence_min_seconds
        ));
        arguments.extend(["-map", "[qcv]", "-map", "[qca]"].map(str::to_owned));
    } else {
        arguments.push(video);
        arguments.extend(["-map", "[qcv]"].map(str::to_owned));
    }
    arguments.extend(["-f", "null", "-"].map(str::to_owned));
    arguments
}

#[derive(Debug, Clone, Default, PartialEq)]
pub(crate) struct QcEvents {
    pub(crate) black: Vec<(f64, f64)>,
    pub(crate) freeze: Vec<(f64, Option<f64>)>,
    pub(crate) silence: Vec<(f64, Option<f64>)>,
    pub(crate) peak_dbfs: Option<f64>,
    pub(crate) integrated_lufs: Option<f64>,
}

fn field(line: &str, key: &str) -> Option<f64> {
    let start = line.find(key)? + key.len();
    let rest = line[start..].trim_start();
    let end = rest
        .find(|character: char| {
            !(character.is_ascii_digit() || matches!(character, '.' | '-' | '+' | 'e'))
        })
        .unwrap_or(rest.len());
    let value: f64 = rest[..end].parse().ok()?;
    value.is_finite().then_some(value)
}

/// Parse the QC pass stderr. Unknown lines are ignored; malformed numbers drop
/// the event rather than inventing a range.
pub(crate) fn parse_qc_log(stderr: &str) -> QcEvents {
    let mut events = QcEvents::default();
    let mut in_ebur_summary = false;
    let mut astats_overall = false;
    for line in stderr.lines() {
        if line.contains("blackdetect") && line.contains("black_start:") {
            if let (Some(start), Some(end)) =
                (field(line, "black_start:"), field(line, "black_end:"))
            {
                events.black.push((start, end));
            }
        } else if line.contains("lavfi.freezedetect.freeze_start:") {
            if let Some(start) = field(line, "freeze_start:") {
                events.freeze.push((start, None));
            }
        } else if line.contains("lavfi.freezedetect.freeze_end:") {
            if let (Some(end), Some(last)) = (field(line, "freeze_end:"), events.freeze.last_mut())
            {
                if last.1.is_none() {
                    last.1 = Some(end);
                }
            }
        } else if line.contains("silence_start:") {
            if let Some(start) = field(line, "silence_start:") {
                events.silence.push((start.max(0.0), None));
            }
        } else if line.contains("silence_end:") {
            if let (Some(end), Some(last)) =
                (field(line, "silence_end:"), events.silence.last_mut())
            {
                if last.1.is_none() {
                    last.1 = Some(end);
                }
            }
        } else if line.contains("Parsed_astats") && line.trim_end().ends_with("Overall") {
            astats_overall = true;
        } else if astats_overall && line.contains("Peak level dB:") {
            events.peak_dbfs = field(line, "Peak level dB:");
            astats_overall = false;
        } else if line.contains("Parsed_ebur128") && line.contains("Summary:") {
            in_ebur_summary = true;
        } else if in_ebur_summary && line.trim_start().starts_with("I:") {
            events.integrated_lufs = field(line, "I:");
            in_ebur_summary = false;
        }
    }
    events
}

fn seconds_to_us(seconds: f64, duration_us: u64) -> u64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0;
    }
    ((seconds * 1_000_000.0).round() as u64).min(duration_us)
}

fn range(start: f64, end: Option<f64>, duration_us: u64) -> QcRange {
    let start_us = seconds_to_us(start, duration_us);
    let end_us = end.map_or(duration_us, |end| seconds_to_us(end, duration_us));
    QcRange {
        start_us,
        end_us: end_us.max(start_us),
    }
}

fn seconds(range: QcRange) -> f64 {
    (range.end_us - range.start_us) as f64 / 1_000_000.0
}

/// Turn parsed detector events into findings.
pub(crate) fn findings_from_events(
    events: &QcEvents,
    config: &QcAnalysisConfig,
    revision_state_hash: &str,
) -> Vec<QcFinding> {
    let thresholds = &config.thresholds;
    let duration = config.duration_us;
    let whole = QcRange {
        start_us: 0,
        end_us: duration,
    };
    let mut findings = Vec::new();
    let deterministic = |kind, severity, range, message: String| {
        QcFinding::new(
            kind,
            severity,
            QcSource::Deterministic,
            "",
            range,
            message,
            revision_state_hash,
        )
    };
    // A plan that intentionally hides video renders black frames by design.
    if !config.video_hidden {
        for &(start, end) in &events.black {
            let range = range(start, Some(end), duration);
            let length = seconds(range);
            if length < thresholds.black_min_seconds {
                continue;
            }
            let severity = if length >= thresholds.black_blocker_seconds {
                QcSeverity::Blocker
            } else {
                QcSeverity::Warning
            };
            findings.push(deterministic(
                QcFindingKind::BlackFrames,
                severity,
                range,
                format!("Black picture for {length:.1} s"),
            ));
        }
        for &(start, end) in &events.freeze {
            let range = range(start, end, duration);
            let length = seconds(range);
            if length < thresholds.freeze_min_seconds {
                continue;
            }
            // A black stretch is also static; report it once, as black.
            let covered_by_black: u64 = events
                .black
                .iter()
                .map(|&(black_start, black_end)| {
                    let black = self::range(black_start, Some(black_end), duration);
                    black
                        .end_us
                        .min(range.end_us)
                        .saturating_sub(black.start_us.max(range.start_us))
                })
                .sum();
            if covered_by_black * 10 >= (range.end_us - range.start_us) * 9 {
                continue;
            }
            let severity = if length >= thresholds.freeze_blocker_seconds {
                QcSeverity::Blocker
            } else {
                QcSeverity::Warning
            };
            findings.push(deterministic(
                QcFindingKind::FreezeFrames,
                severity,
                range,
                format!("Frozen picture for {length:.1} s"),
            ));
        }
    }
    if config.has_audio {
        for &(start, end) in &events.silence {
            let range = range(start, end, duration);
            let length = seconds(range);
            if length < thresholds.silence_min_seconds {
                continue;
            }
            findings.push(deterministic(
                QcFindingKind::Silence,
                QcSeverity::Warning,
                range,
                format!("No audible sound for {length:.1} s"),
            ));
        }
        if let Some(peak) = events.peak_dbfs {
            if peak >= thresholds.clipping_peak_dbfs {
                findings.push(deterministic(
                    QcFindingKind::AudioClipping,
                    QcSeverity::Blocker,
                    whole,
                    format!("Audio peaks at {peak:.1} dBFS and will clip"),
                ));
            }
        }
        if let (Some(target), Some(measured)) =
            (config.loudness_target_lufs, events.integrated_lufs)
        {
            if (measured - target).abs() > thresholds.loudness_tolerance_lu {
                findings.push(deterministic(
                    QcFindingKind::LoudnessOffTarget,
                    QcSeverity::Blocker,
                    whole,
                    format!("Loudness is {measured:.1} LUFS; target is {target:.0} LUFS"),
                ));
            }
        }
    }
    findings
}

/// Average glyph advance as a fraction of font size for the bundled caption
/// fonts (Arial/Segoe class); conservative so overflow is reported, not hidden.
const GLYPH_ADVANCE_RATIO: f64 = 0.55;

/// Caption cues outside the output duration or wider/taller than the frame's
/// safe area at this frame size.
pub(crate) fn subtitle_findings(
    captions: &[RenderCaptionInput],
    duration_us: u64,
    width: u64,
    height: u64,
    revision_state_hash: &str,
) -> Vec<QcFinding> {
    let mut findings = Vec::new();
    for caption in captions {
        let subject = caption.caption_id.as_str();
        let range = QcRange {
            start_us: caption.start_microseconds.min(caption.end_microseconds),
            end_us: caption.end_microseconds.max(caption.start_microseconds),
        };
        let out_of_time = caption.end_microseconds > duration_us
            || caption.start_microseconds >= duration_us
            || caption.end_microseconds <= caption.start_microseconds;
        let overflow = caption.style.as_ref().and_then(|style| {
            let usable_width = width as f64
                * (1_000_u64.saturating_sub(style.safe_left_permille + style.safe_right_permille))
                    as f64
                / 1_000.0;
            let usable_height = height as f64
                * (1_000_u64.saturating_sub(style.safe_top_permille + style.safe_bottom_permille))
                    as f64
                / 1_000.0;
            let lines: Vec<&str> = caption.text.split('\n').collect();
            let longest = lines
                .iter()
                .map(|line| line.chars().count())
                .max()
                .unwrap_or(0) as f64;
            let text_width = longest * style.font_size_px as f64 * GLYPH_ADVANCE_RATIO;
            let text_height = lines.len() as f64 * style.font_size_px as f64
                + lines.len().saturating_sub(1) as f64 * style.line_spacing_px as f64;
            (text_width > usable_width || text_height > usable_height).then_some(())
        });
        if out_of_time || overflow.is_some() {
            let message = if out_of_time {
                "Caption is timed outside the export".to_owned()
            } else {
                format!("Caption does not fit the safe area at {width}×{height}")
            };
            findings.push(QcFinding::new(
                QcFindingKind::SubtitleOutOfBounds,
                QcSeverity::Blocker,
                QcSource::Deterministic,
                subject,
                QcRange {
                    start_us: range.start_us.min(duration_us),
                    end_us: range
                        .end_us
                        .min(duration_us)
                        .max(range.start_us.min(duration_us)),
                },
                message,
                revision_state_hash,
            ));
        }
    }
    findings
}

/// A timeline range clamped to the output (`start <= end <= duration`).
fn clamped_range(start_us: u64, end_us: u64, duration_us: u64) -> QcRange {
    let start = start_us.min(duration_us);
    QcRange {
        start_us: start,
        end_us: end_us.min(duration_us).max(start),
    }
}

/// Characters a viewer reads: Unicode scalars, excluding line breaks.
fn reading_chars(text: &str) -> usize {
    text.chars().filter(|c| *c != '\n' && *c != '\r').count()
}

/// True when `chars` cannot be read in `span_us` at `chars_per_second`.
fn too_fast(chars: usize, span_us: u64, chars_per_second: f64) -> bool {
    chars > 0 && (span_us as f64) * chars_per_second < chars as f64 * 1_000_000.0
}

/// Subject of a graphics text layer: its clip id and layer index.
fn graphics_text_subject(clip_id: &str, layer_index: usize) -> String {
    format!("{clip_id}:{layer_index}")
}

/// Clip-relative duration of a graphics input on the timeline.
fn graphics_span_us(input: &RenderGraphicsInputV2) -> u64 {
    input
        .end_microseconds
        .saturating_sub(input.start_microseconds)
}

/// Caption cues and graphics text shown for less time than it takes to read them (warning).
/// A caption cue is judged by its artifact's own reading-speed limit when it carries one;
/// everything else uses `chars_per_second`. Graphics text is timed by each span where its
/// layer is visible.
pub(crate) fn reading_time_findings(
    captions: &[RenderCaptionInput],
    graphics: &[RenderGraphicsInputV2],
    duration_us: u64,
    chars_per_second: f64,
    revision_state_hash: &str,
) -> Vec<QcFinding> {
    let finding = |subject: &str, start: u64, end: u64, chars: usize, chars_per_second: f64| {
        let range = clamped_range(start, end, duration_us);
        let needed = chars as f64 / chars_per_second;
        let shown = (end - start) as f64 / 1_000_000.0;
        QcFinding::new(
            QcFindingKind::ReadingTimeShort,
            QcSeverity::Warning,
            QcSource::Deterministic,
            subject,
            range,
            format!(
                "{chars} characters are on screen for {shown:.1} s; reading them needs {needed:.1} s at {chars_per_second} characters per second"
            ),
            revision_state_hash,
        )
    };
    let mut findings = Vec::new();
    for caption in captions {
        // Cues timed outside the export are already `subtitle_out_of_bounds`.
        if caption.end_microseconds <= caption.start_microseconds
            || caption.start_microseconds >= duration_us
        {
            continue;
        }
        let chars = reading_chars(&caption.text);
        let caption_rate = caption
            .max_characters_per_second
            .map(f64::from)
            .unwrap_or(chars_per_second);
        if too_fast(
            chars,
            caption.end_microseconds - caption.start_microseconds,
            caption_rate,
        ) {
            findings.push(finding(
                caption.caption_id.as_str(),
                caption.start_microseconds,
                caption.end_microseconds,
                chars,
                caption_rate,
            ));
        }
    }
    for input in graphics {
        let span_us = graphics_span_us(input);
        for (index, layer) in input.clip.layers.iter().enumerate() {
            let GraphicsLayer::Text { text, .. } = layer else {
                continue;
            };
            let chars = reading_chars(text);
            let subject = graphics_text_subject(&input.clip.id, index);
            for (start, end) in visible_spans(layer.tracks().opacity, span_us) {
                if too_fast(chars, end - start, chars_per_second) {
                    findings.push(finding(
                        &subject,
                        input.start_microseconds + start,
                        input.start_microseconds + end,
                        chars,
                        chars_per_second,
                    ));
                }
            }
        }
    }
    findings
}

/// Measurers for closed font keys. `None` when a font cannot be loaded, in which case the
/// geometric text checks skip that text (reading time still runs).
pub(crate) trait TextMeasurers {
    fn measurer(&mut self, font_key: &str) -> Option<&mut dyn MeasureText>;
}

/// Loads each font key once from a font directory, for one QC run.
pub(crate) struct FontDirMeasurers<'a> {
    font_dir: &'a Path,
    loaded: BTreeMap<String, Option<TextMeasurer>>,
}

impl<'a> FontDirMeasurers<'a> {
    pub(crate) fn new(font_dir: &'a Path) -> Self {
        Self {
            font_dir,
            loaded: BTreeMap::new(),
        }
    }
}

impl TextMeasurers for FontDirMeasurers<'_> {
    fn measurer(&mut self, font_key: &str) -> Option<&mut dyn MeasureText> {
        let font_dir = self.font_dir;
        self.loaded
            .entry(font_key.to_owned())
            .or_insert_with(|| {
                load_text_font(font_key, font_dir)
                    .ok()
                    .map(TextMeasurer::new)
            })
            .as_mut()
            .map(|measurer| measurer as &mut dyn MeasureText)
    }
}

/// Where one piece of text sits on the frame for one timeline span.
#[derive(Debug, Clone, PartialEq)]
pub(crate) struct TimedTextBox {
    pub(crate) subject: String,
    pub(crate) start_us: u64,
    pub(crate) end_us: u64,
    pub(crate) rect: Rect,
    /// Graphics text (checked against the safe area); captions have their own bounds check.
    pub(crate) graphics: bool,
}

/// Laid-out boxes of every graphics text layer during each resting interval (drawn at the
/// auto-fitted size the export uses) and of every caption cue, on the timeline.
pub(crate) fn timed_text_boxes(
    captions: &[RenderCaptionInput],
    graphics: &[RenderGraphicsInputV2],
    frame: (u64, u64),
    safe_area: &SafeAreaRect,
    measurers: &mut dyn TextMeasurers,
) -> Vec<TimedTextBox> {
    let mut boxes = Vec::new();
    for input in graphics {
        let span_us = graphics_span_us(input);
        for (index, layer) in input.clip.layers.iter().enumerate() {
            let GraphicsLayer::Text {
                text, font_size, ..
            } = layer
            else {
                continue;
            };
            let Some(measure) = measurers.measurer(&input.clip.font_key) else {
                continue;
            };
            let tracks = layer.tracks();
            let drawn = drawn_text(measure, text, font_size.get(), &tracks, safe_area);
            let pivot = renderer_pivot_size(text, f64::from(drawn.font_size), &drawn.line_breaks);
            let ink = (f64::from(drawn.width), f64::from(drawn.height));
            let subject = graphics_text_subject(&input.clip.id, index);
            for interval in resting_intervals(&tracks, span_us) {
                boxes.push(TimedTextBox {
                    subject: subject.clone(),
                    start_us: input.start_microseconds + interval.start_us,
                    end_us: input.start_microseconds + interval.end_us,
                    rect: layer_box(interval.pose, pivot, ink),
                    graphics: true,
                });
            }
        }
    }
    let (width, height) = (frame.0 as f64, frame.1 as f64);
    for caption in captions {
        if caption.end_microseconds <= caption.start_microseconds {
            continue;
        }
        let (font_key, font_size, line_spacing) = caption_font(caption.style.as_ref(), height);
        let Some(measure) = measurers.measurer(font_key) else {
            continue;
        };
        let size = caption_text_size(measure, &caption.text, font_size, line_spacing);
        boxes.push(TimedTextBox {
            subject: caption.caption_id.as_str().to_owned(),
            start_us: caption.start_microseconds,
            end_us: caption.end_microseconds,
            rect: caption_box(caption.style.as_ref(), (width, height), size),
            graphics: false,
        });
    }
    boxes
}

/// Graphics text that crosses the safe area while resting: a warning inside the frame, a
/// blocker when part of it leaves the frame. Captions keep `subtitle_out_of_bounds`.
pub(crate) fn text_safe_area_findings(
    boxes: &[TimedTextBox],
    frame: (u64, u64),
    safe_area: &SafeAreaRect,
    duration_us: u64,
    revision_state_hash: &str,
) -> Vec<QcFinding> {
    let (width, height) = (frame.0 as f64, frame.1 as f64);
    boxes
        .iter()
        .filter(|text| text.graphics && text.start_us < duration_us)
        .filter(|text| {
            !text.rect.within(
                safe_area.left,
                safe_area.top,
                safe_area.right,
                safe_area.bottom,
            )
        })
        .map(|text| {
            let off_frame = !text.rect.within(0.0, 0.0, width, height);
            let (severity, message) = if off_frame {
                (
                    QcSeverity::Blocker,
                    format!("Text is cut off by the edge of the {width}×{height} frame"),
                )
            } else {
                (
                    QcSeverity::Warning,
                    format!("Text crosses the safe area at {width}×{height}"),
                )
            };
            QcFinding::new(
                QcFindingKind::TextOutsideSafeArea,
                severity,
                QcSource::Deterministic,
                &text.subject,
                clamped_range(text.start_us, text.end_us, duration_us),
                message,
                revision_state_hash,
            )
        })
        .collect()
}

/// Two text boxes on screen at the same time that overlap (warning), for the time they share.
/// The subject is both subjects, sorted, joined with `+`.
pub(crate) fn text_overlap_findings(
    boxes: &[TimedTextBox],
    duration_us: u64,
    revision_state_hash: &str,
) -> Vec<QcFinding> {
    let mut findings = Vec::new();
    for (index, first) in boxes.iter().enumerate() {
        for second in &boxes[index + 1..] {
            if first.subject == second.subject {
                continue;
            }
            let start = first.start_us.max(second.start_us);
            let end = first.end_us.min(second.end_us);
            if start >= end
                || start >= duration_us
                || first.rect.intersection_area(&second.rect) <= 0.0
            {
                continue;
            }
            let mut subjects = [first.subject.as_str(), second.subject.as_str()];
            subjects.sort_unstable();
            findings.push(QcFinding::new(
                QcFindingKind::TextOverlap,
                QcSeverity::Warning,
                QcSource::Deterministic,
                &subjects.join("+"),
                clamped_range(start, end, duration_us),
                "Two pieces of text overlap on screen".to_owned(),
                revision_state_hash,
            ));
        }
    }
    findings
}

/// Inputs to the text checks for one output.
pub(crate) struct TextQcInput<'a> {
    pub(crate) captions: &'a [RenderCaptionInput],
    pub(crate) graphics: &'a [RenderGraphicsInputV2],
    pub(crate) frame: (u64, u64),
    pub(crate) safe_area: SafeAreaRect,
    pub(crate) duration_us: u64,
    pub(crate) chars_per_second: f64,
}

/// Reading time, safe area and overlap findings. Geometric checks skip text whose font cannot be
/// loaded; reading time always runs.
pub(crate) fn text_findings(
    input: &TextQcInput<'_>,
    measurers: &mut dyn TextMeasurers,
    revision_state_hash: &str,
) -> Vec<QcFinding> {
    let mut findings = reading_time_findings(
        input.captions,
        input.graphics,
        input.duration_us,
        input.chars_per_second,
        revision_state_hash,
    );
    let boxes = timed_text_boxes(
        input.captions,
        input.graphics,
        input.frame,
        &input.safe_area,
        measurers,
    );
    findings.extend(text_safe_area_findings(
        &boxes,
        input.frame,
        &input.safe_area,
        input.duration_us,
        revision_state_hash,
    ));
    findings.extend(text_overlap_findings(
        &boxes,
        input.duration_us,
        revision_state_hash,
    ));
    findings
}

fn bounded_tail(stderr: &[u8], redact: &str) -> String {
    let start = stderr.len().saturating_sub(QC_FAILURE_TAIL_BYTES);
    let text = String::from_utf8_lossy(&stderr[start..]);
    let text = if redact.is_empty() {
        text.into_owned()
    } else {
        text.replace(redact, "<output>")
    };
    // Drop any remaining absolute-path-looking lines.
    text.lines()
        .filter(|line| !line.contains(":\\") && !line.contains(":/"))
        .collect::<Vec<_>>()
        .join("\n")
}

pub(crate) fn qc_unavailable(
    reason: &str,
    exit_code: Option<i32>,
    stderr_tail: String,
) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::QcUnavailable,
        "Quality checks could not run on the export",
        json!({
            "operation": "qc_analysis",
            "category": "qc_unavailable",
            "reason": reason,
            "exitCode": exit_code,
            "stderrTail": stderr_tail,
        }),
    )
}

/// Run the single supervised QC pass and return its stderr. Any failure other
/// than cancellation is `qc_unavailable`; QC is never inferred to have passed.
pub(crate) async fn run_qc_pass(
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    path: &Path,
    config: &QcAnalysisConfig,
) -> Result<String, VideoCommandError> {
    let path_text = path
        .to_str()
        .ok_or_else(|| qc_unavailable("path_encoding", None, String::new()))?;
    let program = programs.verified_ffmpeg("qc_analysis").await?;
    let arguments = qc_arguments(path_text, config)
        .into_iter()
        .map(OsString::from)
        .collect();
    let result = run_supervised(
        ProcessSpec {
            program,
            args: arguments,
            current_dir: None,
            operation: "qc_analysis",
            timeout: config.timeout,
            stdout_limit: QC_STDOUT_LIMIT,
            stderr_tail_limit: QC_STDERR_TAIL_LIMIT,
        },
        cancellation,
    )
    .await;
    match result {
        Ok(output) => Ok(String::from_utf8_lossy(&output.stderr_tail).into_owned()),
        Err(ProcessFailure::Cancelled { .. }) => Err(VideoCommandError::process_cancelled(
            "qc_analysis",
            "ffmpeg",
        )),
        Err(ProcessFailure::Timeout { .. }) => Err(qc_unavailable("timeout", None, String::new())),
        Err(ProcessFailure::NonZero {
            exit_code,
            stderr_tail,
            ..
        }) => Err(qc_unavailable(
            "exit_status",
            exit_code,
            bounded_tail(&stderr_tail, path_text),
        )),
        Err(ProcessFailure::Spawn { .. }) => Err(qc_unavailable("spawn", None, String::new())),
        Err(ProcessFailure::StdoutLimit { .. }) => {
            Err(qc_unavailable("output_limit", None, String::new()))
        }
        Err(ProcessFailure::Io { .. }) => Err(qc_unavailable("io", None, String::new())),
    }
}

/// Full native QC for one output: detectors + caption bounds, sorted, capped.
pub(crate) async fn analyze_output(
    programs: &MediaPrograms,
    cancellation: ProcessCancellation,
    path: &Path,
    config: &QcAnalysisConfig,
    captions: &[RenderCaptionInput],
    frame: (u64, u64),
    revision_state_hash: &str,
) -> Result<Vec<QcFinding>, VideoCommandError> {
    let stderr = run_qc_pass(programs, cancellation, path, config).await?;
    let events = parse_qc_log(&stderr);
    let mut findings = findings_from_events(&events, config, revision_state_hash);
    findings.extend(subtitle_findings(
        captions,
        config.duration_us,
        frame.0,
        frame.1,
        revision_state_hash,
    ));
    sort_findings(&mut findings);
    findings.truncate(QC_MAX_FINDINGS);
    Ok(findings)
}

/// QC result attached to a completed render (`renderQcResultSchema`).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderQcResult {
    pub status: QcStatus,
    pub findings: Vec<QcFinding>,
    pub manifest_path: String,
    pub manifest_sha256: String,
}

/// Revision-level editorial findings computed in TS (`@supa-video/qc`
/// `editorial.ts`) from the exact revision being rendered.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EditorialEvaluation {
    pub evaluator_version: String,
    pub revision_id: String,
    pub revision_state_hash: String,
    pub findings: Vec<QcFinding>,
}

/// Everything the worker needs to run QC and decide promotion. Persisted with
/// the job so a reauthorized render runs the same checks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RenderQcContext {
    pub revision_state_hash: String,
    pub editorial: EditorialEvaluation,
    /// Present only for Deliver preset renders.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub delivery: Option<DeliveryGate>,
}

/// Deliver-time gate: findings already accepted on the source review export.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryGate {
    pub preset_id: String,
    pub width: u64,
    pub height: u64,
    pub thumbnail_at_permille: u64,
    pub source_manifest_sha256: String,
    /// Accepted finding id → accepting decision id, from the source review record.
    pub accepted: std::collections::BTreeMap<String, String>,
}

pub(crate) const EDITORIAL_EVALUATION_MAX_BYTES: usize = 512 * 1024;

pub(crate) fn invalid_editorial_evaluation(reason: &'static str) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::InvalidEditorialEvaluation,
        "The editorial check for this export is missing or does not match the project revision",
        json!({
            "operation": "start_render",
            "category": "invalid_editorial_evaluation",
            "reason": reason,
        }),
    )
}

/// IPC-boundary validation of the editorial evaluation for the revision being
/// rendered. `revision_state_hash` comes from the open project, never from the
/// client. Every failure is `invalid_editorial_evaluation`; nothing is encoded.
pub(crate) fn validate_editorial_evaluation(
    raw: Option<serde_json::Value>,
    revision_id: &str,
    revision_state_hash: Option<&str>,
) -> Result<EditorialEvaluation, VideoCommandError> {
    let raw = raw.ok_or_else(|| invalid_editorial_evaluation("missing"))?;
    let size = serde_json::to_vec(&raw)
        .map(|bytes| bytes.len())
        .unwrap_or(usize::MAX);
    if size > EDITORIAL_EVALUATION_MAX_BYTES {
        return Err(invalid_editorial_evaluation("too_large"));
    }
    let evaluation: EditorialEvaluation =
        serde_json::from_value(raw).map_err(|_| invalid_editorial_evaluation("malformed"))?;
    let state_hash =
        revision_state_hash.ok_or_else(|| invalid_editorial_evaluation("revision_not_open"))?;
    if evaluation.evaluator_version.is_empty() || evaluation.evaluator_version.len() > 64 {
        return Err(invalid_editorial_evaluation("evaluator_version"));
    }
    if evaluation.revision_id != revision_id || evaluation.revision_state_hash != state_hash {
        return Err(invalid_editorial_evaluation("revision_mismatch"));
    }
    if evaluation.findings.len() > QC_MAX_FINDINGS {
        return Err(invalid_editorial_evaluation("finding_count"));
    }
    let mut seen = BTreeSet::new();
    for finding in &evaluation.findings {
        if finding.source != QcSource::Editorial || !finding.kind.is_editorial() {
            return Err(invalid_editorial_evaluation("finding_source"));
        }
        if !finding.is_well_formed(state_hash) || !seen.insert(finding.finding_id.clone()) {
            return Err(invalid_editorial_evaluation("finding_shape"));
        }
    }
    Ok(evaluation)
}

pub(crate) fn qc_release_blocked(unresolved: &[String]) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::QcReleaseBlocked,
        "Quality checks found problems that must be resolved before delivery",
        json!({
            "operation": "qc_release_gate",
            "category": "qc_release_blocked",
            "findingIds": unresolved,
        }),
    )
}

/// QC pass budget: generous for real footage, bounded so a hung pass fails.
pub(crate) fn qc_timeout_for(duration_us: u64) -> Duration {
    let seconds = 120 + duration_us.saturating_mul(3) / 1_000_000;
    Duration::from_secs(seconds.min(6 * 60 * 60))
}

#[cfg(test)]
mod tests {
    use super::*;

    const STATE: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

    #[test]
    fn finding_id_payload_matches_the_typescript_contract() {
        let payload = finding_id_payload(
            QcFindingKind::BlackFrames,
            QcSource::Deterministic,
            "",
            QcRange {
                start_us: 1_000_000,
                end_us: 2_000_000,
            },
            STATE,
        );
        assert_eq!(
            payload,
            format!("{{\"endDs\":20,\"kind\":\"black_frames\",\"revisionStateHash\":\"{STATE}\",\"source\":\"deterministic\",\"startDs\":10,\"subject\":\"\"}}")
        );
        // Golden id shared with `@supa-video/qc` qc.test.ts.
        assert_eq!(
            hex_sha256(payload.as_bytes()),
            "6d198444bde0eaba78dd2fde8f268b9132b968b9277b6e2924c83b729a940f53"
        );
    }

    /// Golden ids for the text kinds, shared with `@supa-video/qc` qc.test.ts.
    #[test]
    fn text_finding_ids_match_typescript() {
        for (kind, golden) in [
            (
                QcFindingKind::ReadingTimeShort,
                "c3f9d2224de525d2b655b8c9039014bca20b9a0b433aefbb01d549086e48c8b1",
            ),
            (
                QcFindingKind::TextOutsideSafeArea,
                "ebde4e964f18eeeba36ad119479ae4f2ee5462441af8131cac1f048686c86dbf",
            ),
            (
                QcFindingKind::TextOverlap,
                "69f9f60aa4567153e2725f3c637b62d974e2e6a6d89546c1b536cadee82ff92f",
            ),
        ] {
            let payload = finding_id_payload(
                kind,
                QcSource::Deterministic,
                "clip:0",
                QcRange {
                    start_us: 1_000_000,
                    end_us: 2_000_000,
                },
                STATE,
            );
            assert_eq!(hex_sha256(payload.as_bytes()), golden, "{}", kind.as_str());
        }
    }

    /// Golden ids for the motion kinds, shared with `@supa-video/qc` qc.test.ts.
    #[test]
    fn motion_finding_ids_match_typescript() {
        for (kind, golden) in [
            (
                QcFindingKind::MotionStutter,
                "1682eea84e1baf8f83fce463941ee3d2361359c3b07ee8e4a3e979eba04fef98",
            ),
            (
                QcFindingKind::MotionDrift,
                "b135767305521340768f1fdb56506ea385aea295add295826ff33ce2a86d63da",
            ),
            (
                QcFindingKind::MotionCutJump,
                "18aa181ee01b6ff06185a94c64f3e064bd8de32123590646697e3799ce55b4ac",
            ),
        ] {
            let payload = finding_id_payload(
                kind,
                QcSource::Editorial,
                "clip:0",
                QcRange {
                    start_us: 1_000_000,
                    end_us: 2_000_000,
                },
                STATE,
            );
            assert_eq!(hex_sha256(payload.as_bytes()), golden, "{}", kind.as_str());
        }
    }

    #[test]
    fn editorial_evaluation_accepts_motion_kinds_only_from_editorial() {
        let revision_id = "00000000-0000-4000-8000-0000000000aa";
        let evaluation_with = |source: QcSource| {
            let findings: Vec<QcFinding> = [
                QcFindingKind::MotionStutter,
                QcFindingKind::MotionDrift,
                QcFindingKind::MotionCutJump,
            ]
            .into_iter()
            .map(|kind| {
                QcFinding::new(
                    kind,
                    QcSeverity::Warning,
                    source,
                    "00000000-0000-4000-8000-0000000001f4:0",
                    QcRange {
                        start_us: 1_000_000,
                        end_us: 2_000_000,
                    },
                    "Graphics rect layer 1 stutters".to_owned(),
                    STATE,
                )
            })
            .collect();
            json!({
                "evaluatorVersion": "editorial-v2",
                "revisionId": revision_id,
                "revisionStateHash": STATE,
                "findings": findings,
            })
        };

        let accepted = validate_editorial_evaluation(
            Some(evaluation_with(QcSource::Editorial)),
            revision_id,
            Some(STATE),
        )
        .expect("motion kinds are editorial");
        assert_eq!(accepted.findings.len(), 3);

        let rejected = validate_editorial_evaluation(
            Some(evaluation_with(QcSource::Deterministic)),
            revision_id,
            Some(STATE),
        )
        .expect_err("motion kinds must come from the editorial evaluator");
        assert_eq!(rejected.details["reason"], "finding_source");
    }

    #[test]
    fn rounding_matches_typescript() {
        for (us, ds) in [
            (0, 0),
            (49_999, 0),
            (50_000, 1),
            (1_049_999, 10),
            (1_050_000, 11),
        ] {
            assert_eq!(round_decisecond(us), ds);
        }
    }

    fn config() -> QcAnalysisConfig {
        QcAnalysisConfig {
            duration_us: 4_000_000,
            has_audio: true,
            video_hidden: false,
            loudness_target_lufs: None,
            thresholds: QcThresholds::default(),
            timeout: Duration::from_secs(60),
        }
    }

    #[test]
    fn parses_detector_lines() {
        let log = "[Parsed_blackdetect_0 @ 0x1] black_start:2 black_end:3.966667 black_duration:1.966667\n\
[Parsed_freezedetect_1 @ 0x2] lavfi.freezedetect.freeze_start: 0.966667\n\
[Parsed_silencedetect_2 @ 0x3] silence_start: 1.502\n\
[Parsed_silencedetect_2 @ 0x3] silence_end: 4.010667 | silence_duration: 2.508667\n\
[Parsed_astats_3 @ 0x4] Overall\n\
[Parsed_astats_3 @ 0x4] Peak level dB: 14.562434\n\
[Parsed_ebur128_4 @ 0x5] Summary:\n\
\n    Integrated loudness:\n    I:          -4.6 LUFS\n";
        let events = parse_qc_log(log);
        assert_eq!(events.black, vec![(2.0, 3.966667)]);
        assert_eq!(events.freeze, vec![(0.966667, None)]);
        assert_eq!(events.silence, vec![(1.502, Some(4.010667))]);
        assert_eq!(events.peak_dbfs, Some(14.562434));
        assert_eq!(events.integrated_lufs, Some(-4.6));
    }

    #[test]
    fn severity_follows_duration_thresholds() {
        let events = QcEvents {
            black: vec![(0.0, 0.7), (1.0, 3.0)],
            ..QcEvents::default()
        };
        let findings = findings_from_events(&events, &config(), STATE);
        let severities: Vec<_> = findings.iter().map(|finding| finding.severity).collect();
        assert_eq!(severities, vec![QcSeverity::Warning, QcSeverity::Blocker]);
    }

    #[test]
    fn hidden_video_suppresses_picture_findings() {
        let events = QcEvents {
            black: vec![(0.0, 4.0)],
            freeze: vec![(0.0, None)],
            ..QcEvents::default()
        };
        let mut hidden = config();
        hidden.video_hidden = true;
        assert!(findings_from_events(&events, &hidden, STATE).is_empty());
    }

    #[test]
    fn loudness_off_target_needs_a_target() {
        let events = QcEvents {
            integrated_lufs: Some(-30.0),
            ..QcEvents::default()
        };
        assert!(findings_from_events(&events, &config(), STATE).is_empty());
        let mut targeted = config();
        targeted.loudness_target_lufs = Some(-14.0);
        let findings = findings_from_events(&events, &targeted, STATE);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].kind, QcFindingKind::LoudnessOffTarget);
    }

    #[test]
    fn rights_findings_are_never_resolved_by_acceptance() {
        let rights = QcFinding::new(
            QcFindingKind::RightsBlocked,
            QcSeverity::Blocker,
            QcSource::Rights,
            "",
            QcRange {
                start_us: 0,
                end_us: 1,
            },
            "Rights withdrawn".into(),
            STATE,
        );
        let black = QcFinding::new(
            QcFindingKind::BlackFrames,
            QcSeverity::Blocker,
            QcSource::Deterministic,
            "",
            QcRange {
                start_us: 0,
                end_us: 1,
            },
            "Black".into(),
            STATE,
        );
        let accepted: BTreeSet<String> =
            [rights.finding_id.clone(), black.finding_id.clone()].into();
        assert_eq!(
            unresolved_blockers(&[rights.clone(), black], &accepted),
            vec![rights.finding_id]
        );
    }

    #[test]
    fn well_formed_checks_id_binding() {
        let finding = QcFinding::new(
            QcFindingKind::RepeatedAsset,
            QcSeverity::Warning,
            QcSource::Editorial,
            "asset",
            QcRange {
                start_us: 0,
                end_us: 10,
            },
            "Repeated".into(),
            STATE,
        );
        assert!(finding.is_well_formed(STATE));
        assert!(!finding.is_well_formed(&"b".repeat(64)));
    }

    #[test]
    fn failure_tail_is_bounded_and_path_free() {
        let mut stderr = b"x".repeat(5_000);
        stderr.extend_from_slice(
            b"\nC:\\Users\\me\\out.mp4: error\nE:/x/out.mp4: bad\nplain failure",
        );
        let tail = bounded_tail(&stderr, "");
        assert!(tail.len() <= QC_FAILURE_TAIL_BYTES);
        assert!(!tail.contains(":\\") && !tail.contains(":/"));
        assert!(tail.ends_with("plain failure"));
    }
}
