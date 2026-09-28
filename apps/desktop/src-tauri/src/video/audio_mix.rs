//! Final audio mix: role-based ducking/cleanup graph (mirror of
//! `packages/video-render/src/audio-mix.ts`), two-pass `loudnorm`, and the
//! post-render loudness report.
//!
//! Pass-1 parsing and the linear gate follow veedstudio/open-edit
//! mux-audio.ts: anchor on `"input_i"`, coerce every value to a finite number,
//! and never build a pass-2 filter from silence or `-inf`. The post-render
//! check follows open-edit check-delivery.ts: `ebur128=peak=true`, parse only
//! after the last `Summary:`, and an unmeasurable file is a finding, not a pass.

use serde::{Deserialize, Serialize};

use super::project::types::{SequenceLoudnessTarget, TrackAudioRole};
use super::types::RenderVideoInputV2;

pub(crate) const DIALOGUE_CLEANUP_FILTER: &str = "highpass=f=80,afftdn=nr=12:nf=-40";
pub(crate) const DUCKING_FILTER: &str =
    "sidechaincompress=threshold=0.03:ratio=8:attack=20:release=600";
const LOUDNESS_RANGE_TARGET_LU: f64 = 11.0;
/// loudnorm aims this far below the ceiling so AAC overshoot stays under it.
const TRUE_PEAK_HEADROOM_DB: f64 = 0.5;
/// Integrated loudness tolerance for a passing report.
pub(crate) const LOUDNESS_TOLERANCE_LU: f64 = 1.0;

fn one_decimal(value: f64) -> String {
    format!("{value:.1}")
}

fn loudnorm_target(mix: &SequenceLoudnessTarget) -> String {
    format!(
        "loudnorm=I={}:TP={}:LRA={}",
        one_decimal(mix.integrated_lufs as f64),
        one_decimal(mix.true_peak_ceiling_dbtp as f64 - TRUE_PEAK_HEADROOM_DB),
        one_decimal(LOUDNESS_RANGE_TARGET_LU),
    )
}

fn mix_of(labels: &[String], output: &str, tail: &str) -> String {
    if labels.len() == 1 {
        let tail = if tail.is_empty() { "anull" } else { tail };
        return format!("[{}]{tail}[{output}]", labels[0]);
    }
    let inputs = labels
        .iter()
        .map(|label| format!("[{label}]"))
        .collect::<String>();
    let tail = if tail.is_empty() {
        String::new()
    } else {
        format!(",{tail}")
    };
    format!(
        "{inputs}amix=inputs={}:duration=longest:normalize=0{tail}[{output}]",
        labels.len()
    )
}

/// The audible inputs in plan order, with their mix roles.
pub(crate) fn audible_inputs(
    inputs: &[RenderVideoInputV2],
) -> Vec<(usize, Option<TrackAudioRole>)> {
    inputs
        .iter()
        .enumerate()
        .filter(|(_, input)| !input.muted && input.has_audio)
        .map(|(index, input)| (index, input.audio_role))
        .collect()
}

/// Mirrors `audioMixFilters`. Returns `Err` when ducking has no dialogue.
pub(crate) fn audio_mix_filters(
    audible: &[(usize, Option<TrackAudioRole>)],
    mix: Option<&SequenceLoudnessTarget>,
    duration: &str,
) -> Result<Vec<String>, &'static str> {
    if audible.is_empty() {
        return Ok(Vec::new());
    }
    let mut parts = Vec::new();
    let cleanup = mix.is_some_and(|mix| mix.dialogue_cleanup);
    let label = |index: usize, role: Option<TrackAudioRole>| {
        if cleanup && role == Some(TrackAudioRole::Dialogue) {
            format!("c{index}")
        } else {
            format!("a{index}")
        }
    };
    for (index, role) in audible {
        if cleanup && *role == Some(TrackAudioRole::Dialogue) {
            parts.push(format!("[a{index}]{DIALOGUE_CLEANUP_FILTER}[c{index}]"));
        }
    }
    let mut final_labels: Vec<String> = audible
        .iter()
        .map(|(index, role)| label(*index, *role))
        .collect();
    if mix.is_some_and(|mix| mix.ducking) {
        let dialogue: Vec<String> = audible
            .iter()
            .filter(|(_, role)| *role == Some(TrackAudioRole::Dialogue))
            .map(|(index, role)| label(*index, *role))
            .collect();
        let music: Vec<String> = audible
            .iter()
            .filter(|(_, role)| *role == Some(TrackAudioRole::Music))
            .map(|(index, role)| label(*index, *role))
            .collect();
        if dialogue.is_empty() {
            return Err("ducking_without_dialogue");
        }
        if !music.is_empty() {
            if dialogue.len() == 1 {
                parts.push(format!("[{}]asplit=2[dmix][dkey0]", dialogue[0]));
            } else {
                let inputs = dialogue
                    .iter()
                    .map(|value| format!("[{value}]"))
                    .collect::<String>();
                parts.push(format!(
                    "{inputs}amix=inputs={}:duration=longest:normalize=0,asplit=2[dmix][dkey0]",
                    dialogue.len()
                ));
            }
            parts.push(format!("[dkey0]apad=whole_dur={duration}[dkey]"));
            let music_bus = if music.len() > 1 {
                parts.push(mix_of(&music, "mbus", ""));
                "mbus".to_owned()
            } else {
                music[0].clone()
            };
            parts.push(format!("[{music_bus}][dkey]{DUCKING_FILTER}[mduck]"));
            final_labels = vec!["dmix".to_owned(), "mduck".to_owned()];
            final_labels.extend(
                audible
                    .iter()
                    .filter(|(_, role)| {
                        !matches!(role, Some(TrackAudioRole::Dialogue | TrackAudioRole::Music))
                    })
                    .map(|(index, role)| label(*index, *role)),
            );
        }
    }
    let tail = mix.map(loudnorm_target).unwrap_or_default();
    parts.push(mix_of(&final_labels, "aout", &tail));
    Ok(parts)
}

// ---------------------------------------------------------------------------
// Two-pass loudnorm
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct LoudnormMeasurement {
    pub(crate) input_i: f64,
    pub(crate) input_tp: f64,
    pub(crate) input_lra: f64,
    pub(crate) input_thresh: f64,
    pub(crate) target_offset: f64,
}

/// Parses loudnorm's pass-1 JSON from stderr, anchored on the last
/// `"input_i"` so braces in later warnings cannot confuse it. `None` means
/// unmeasurable (missing keys, non-numeric or non-finite values such as `-inf`).
pub(crate) fn parse_loudnorm_measurement(stderr: &str) -> Option<LoudnormMeasurement> {
    let anchor = stderr.rfind("\"input_i\"")?;
    let start = stderr[..anchor].rfind('{')?;
    let end = anchor + stderr[anchor..].find('}')?;
    let json: serde_json::Map<String, serde_json::Value> =
        serde_json::from_str(&stderr[start..=end]).ok()?;
    let number = |key: &str| -> Option<f64> {
        let value = match json.get(key)? {
            serde_json::Value::String(text) => text.trim().parse::<f64>().ok()?,
            serde_json::Value::Number(number) => number.as_f64()?,
            _ => return None,
        };
        value.is_finite().then_some(value)
    };
    Some(LoudnormMeasurement {
        input_i: number("input_i")?,
        input_tp: number("input_tp")?,
        input_lra: number("input_lra")?,
        input_thresh: number("input_thresh")?,
        target_offset: number("target_offset")?,
    })
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NormalizationMode {
    /// Single linear gain from the measurement; no pumping.
    Measured,
    /// loudnorm's dynamic mode (would exceed the ceiling or range linearly).
    Dynamic,
    /// Nothing measurable (silence); audio left untouched.
    None,
}

/// Mirrors loudnorm's own linear-mode gate so the report can say which mode
/// actually ran instead of FFmpeg switching silently.
pub(crate) fn normalization_decision(
    measurement: Option<&LoudnormMeasurement>,
    mix: &SequenceLoudnessTarget,
) -> (NormalizationMode, Option<&'static str>) {
    let Some(measured) = measurement else {
        return (NormalizationMode::None, Some("unmeasurable_or_silent"));
    };
    if measured.input_i == 0.0 || measured.input_i < -70.0 {
        return (NormalizationMode::None, Some("silent"));
    }
    let target_tp = mix.true_peak_ceiling_dbtp as f64 - TRUE_PEAK_HEADROOM_DB;
    let gain = mix.integrated_lufs as f64 - measured.input_i;
    if measured.input_tp + gain > target_tp {
        return (
            NormalizationMode::Dynamic,
            Some("true_peak_would_exceed_ceiling"),
        );
    }
    if measured.input_lra == 0.0 {
        return (NormalizationMode::Dynamic, Some("zero_loudness_range"));
    }
    if measured.input_lra > LOUDNESS_RANGE_TARGET_LU {
        return (
            NormalizationMode::Dynamic,
            Some("loudness_range_above_target"),
        );
    }
    (NormalizationMode::Measured, None)
}

/// The pass-2 loudnorm node. `Measured` feeds the measurement back with
/// `linear=true`; `Dynamic` keeps the single-pass node; `None` bypasses.
pub(crate) fn pass_two_loudnorm(
    mix: &SequenceLoudnessTarget,
    mode: NormalizationMode,
    measurement: Option<&LoudnormMeasurement>,
) -> String {
    match (mode, measurement) {
        (NormalizationMode::Measured, Some(measured)) => format!(
            "{}:measured_I={:.2}:measured_TP={:.2}:measured_LRA={:.2}:measured_thresh={:.2}:offset={:.2}:linear=true:print_format=summary",
            loudnorm_target(mix),
            measured.input_i,
            measured.input_tp,
            measured.input_lra,
            measured.input_thresh,
            measured.target_offset,
        ),
        (NormalizationMode::None, _) => "anull".to_owned(),
        _ => loudnorm_target(mix),
    }
}

/// Rewrites the validated argv for pass 1 (measure only, no output file) or
/// pass 2 (loudnorm node replaced). Only the exact placeholder node that the
/// validator already matched is replaced, so the graph cannot be widened.
pub(crate) fn with_loudnorm_node(
    arguments: &[String],
    mix: &SequenceLoudnessTarget,
    replacement: &str,
) -> Option<Vec<String>> {
    let placeholder = format!("{}[aout]", loudnorm_target(mix));
    let filter_index = arguments
        .iter()
        .position(|argument| argument == "-filter_complex")?
        + 1;
    let graph = arguments.get(filter_index)?;
    if graph.matches(&placeholder).count() != 1 {
        return None;
    }
    let mut next = arguments.to_vec();
    next[filter_index] = graph.replace(&placeholder, &format!("{replacement}[aout]"));
    Some(next)
}

/// Pass-1 argv: same inputs and graph with a JSON-printing loudnorm, audio
/// only, discarded to the null muxer.
pub(crate) fn measurement_arguments(
    execution_arguments: &[String],
    mix: &SequenceLoudnessTarget,
) -> Option<Vec<String>> {
    // astats before loudnorm measures clipping in the pre-normalization mix.
    let with_json = with_loudnorm_node(
        execution_arguments,
        mix,
        &format!(
            "astats=metadata=0:measure_perchannel=none:measure_overall=Peak_level+Peak_count,{}:print_format=json",
            loudnorm_target(mix)
        ),
    )?;
    let filter_index = with_json
        .iter()
        .position(|argument| argument == "-filter_complex")?;
    let graph = with_json.get(filter_index + 1)?.clone();
    let duration_index = with_json.iter().rposition(|argument| argument == "-t")?;
    let duration = with_json.get(duration_index + 1)?.clone();
    let mut arguments: Vec<String> = with_json[..filter_index]
        .iter()
        .filter(|argument| argument.as_str() != "-y")
        .cloned()
        .collect();
    // Drop the progress stream: pass 1 must not drive the UI progress bar.
    if let Some(progress) = arguments
        .iter()
        .position(|argument| argument == "-progress")
    {
        arguments.drain(progress..=progress + 1);
    }
    if let Some(level) = arguments
        .iter()
        .position(|argument| argument == "-loglevel")
    {
        arguments[level + 1] = "info".to_owned();
    }
    arguments.extend([
        "-filter_complex".to_owned(),
        graph,
        // Every graph output must be consumed, so the video chain is mapped
        // too (null muxer: nothing is encoded).
        "-map".to_owned(),
        "[vout]".to_owned(),
        "-map".to_owned(),
        "[aout]".to_owned(),
        "-t".to_owned(),
        duration,
        "-f".to_owned(),
        "null".to_owned(),
        "-".to_owned(),
    ]);
    Some(arguments)
}

// ---------------------------------------------------------------------------
// Post-render measurement and report
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Ebur128Summary {
    pub(crate) integrated_lufs: f64,
    pub(crate) loudness_range_lu: f64,
    pub(crate) true_peak_dbtp: f64,
}

fn summary_value(summary: &str, label: &str) -> Option<f64> {
    summary.lines().find_map(|line| {
        let rest = line.trim().strip_prefix(label)?;
        let value = rest.split_whitespace().next()?.parse::<f64>().ok()?;
        value.is_finite().then_some(value)
    })
}

/// Parses only the text after the last `Summary:`. `None` = unmeasurable.
pub(crate) fn parse_ebur128_summary(stderr: &str) -> Option<Ebur128Summary> {
    let summary = &stderr[stderr.rfind("Summary:")?..];
    let integrated = summary.find("Integrated loudness:")?;
    let range = summary.find("Loudness range:")?;
    let peak = summary.find("True peak:")?;
    Some(Ebur128Summary {
        integrated_lufs: summary_value(&summary[integrated..], "I:")?,
        loudness_range_lu: summary_value(&summary[range..], "LRA:")?,
        true_peak_dbtp: summary_value(&summary[peak..], "Peak:")?,
    })
}

/// `astats` overall `Peak count` at full scale over the mix, i.e. clipped samples.
pub(crate) fn parse_clipped_samples(stderr: &str) -> Option<u64> {
    let overall = &stderr[stderr.rfind("Overall")?..];
    let peak_level = summary_value(overall, "Peak level dB:");
    let count = overall.lines().find_map(|line| {
        let rest = line.split("Peak count:").nth(1)?;
        rest.trim().parse::<f64>().ok()
    })?;
    // Peak count counts samples at the peak level; only full-scale peaks clip.
    Some(if peak_level.is_some_and(|level| level >= -0.01) {
        count.max(0.0) as u64
    } else {
        0
    })
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LoudnessReport {
    pub schema_version: u8,
    pub target_integrated_lufs: i64,
    pub true_peak_ceiling_dbtp: i64,
    pub tolerance_lu: f64,
    pub normalization_mode: NormalizationMode,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub normalization_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub measured_input_lufs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_integrated_lufs: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_true_peak_dbtp: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_loudness_range_lu: Option<f64>,
    pub source_clipped_samples: u64,
    pub ducking: bool,
    pub dialogue_cleanup: bool,
    pub passed: bool,
    pub findings: Vec<String>,
}

pub(crate) fn build_loudness_report(
    mix: &SequenceLoudnessTarget,
    mode: NormalizationMode,
    reason: Option<&str>,
    measurement: Option<&LoudnormMeasurement>,
    output: Option<&Ebur128Summary>,
    clipped: Option<u64>,
) -> LoudnessReport {
    let mut findings = Vec::new();
    let ceiling = mix.true_peak_ceiling_dbtp as f64;
    let mut passed = true;
    match output {
        None => {
            passed = false;
            findings.push("output_loudness_could_not_be_measured".to_owned());
        }
        Some(summary) => {
            if mode != NormalizationMode::None
                && (summary.integrated_lufs - mix.integrated_lufs as f64).abs()
                    > LOUDNESS_TOLERANCE_LU
            {
                passed = false;
                findings.push("integrated_loudness_out_of_tolerance".to_owned());
            }
            if summary.true_peak_dbtp > ceiling {
                passed = false;
                findings.push("true_peak_above_ceiling".to_owned());
            }
        }
    }
    if mode == NormalizationMode::None {
        findings.push("audio_not_normalized".to_owned());
    }
    if mode == NormalizationMode::Dynamic {
        findings.push("dynamic_normalization_used".to_owned());
    }
    match clipped {
        Some(0) => {}
        Some(_) => findings.push("source_mix_clipped".to_owned()),
        None => findings.push("clipping_could_not_be_measured".to_owned()),
    }
    LoudnessReport {
        schema_version: 1,
        target_integrated_lufs: mix.integrated_lufs,
        true_peak_ceiling_dbtp: mix.true_peak_ceiling_dbtp,
        tolerance_lu: LOUDNESS_TOLERANCE_LU,
        normalization_mode: mode,
        normalization_reason: reason.map(str::to_owned),
        measured_input_lufs: measurement.map(|value| value.input_i),
        output_integrated_lufs: output.map(|value| value.integrated_lufs),
        output_true_peak_dbtp: output.map(|value| value.true_peak_dbtp),
        output_loudness_range_lu: output.map(|value| value.loudness_range_lu),
        source_clipped_samples: clipped.unwrap_or(0),
        ducking: mix.ducking,
        dialogue_cleanup: mix.dialogue_cleanup,
        passed,
        findings,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn target(ducking: bool, cleanup: bool) -> SequenceLoudnessTarget {
        SequenceLoudnessTarget {
            integrated_lufs: -16,
            true_peak_ceiling_dbtp: -1,
            ducking,
            dialogue_cleanup: cleanup,
        }
    }

    /// Byte-identical to `AUDIO_MIX_GOLDEN` in audio-mix.test.ts.
    #[test]
    fn mix_graph_matches_ts_golden() {
        let audible = [
            (0, Some(TrackAudioRole::Dialogue)),
            (1, Some(TrackAudioRole::Music)),
            (2, Some(TrackAudioRole::Sfx)),
        ];
        assert_eq!(
            audio_mix_filters(&audible, Some(&target(true, true)), "12.000000")
                .unwrap()
                .join(";"),
            [
                "[a0]highpass=f=80,afftdn=nr=12:nf=-40[c0]",
                "[c0]asplit=2[dmix][dkey0]",
                "[dkey0]apad=whole_dur=12.000000[dkey]",
                "[a1][dkey]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=600[mduck]",
                "[dmix][mduck][a2]amix=inputs=3:duration=longest:normalize=0,loudnorm=I=-16.0:TP=-1.5:LRA=11.0[aout]",
            ]
            .join(";")
        );
    }

    #[test]
    fn legacy_mix_is_unchanged_and_ducking_without_dialogue_is_rejected() {
        assert_eq!(
            audio_mix_filters(&[(0, None)], None, "1.000000").unwrap(),
            ["[a0]anull[aout]"]
        );
        assert_eq!(
            audio_mix_filters(
                &[(0, Some(TrackAudioRole::Music))],
                Some(&target(true, false)),
                "1.000000"
            ),
            Err("ducking_without_dialogue")
        );
    }

    const PASS_ONE: &str = r#"[Parsed_loudnorm_9 @ 0x1] warning: {weird} braces
[Parsed_loudnorm_9 @ 0x1]
{
	"input_i" : "-15.93",
	"input_tp" : "-1.82",
	"input_lra" : "7.20",
	"input_thresh" : "-27.80",
	"output_i" : "-16.91",
	"output_tp" : "-2.90",
	"output_lra" : "4.50",
	"output_thresh" : "-28.53",
	"normalization_type" : "dynamic",
	"target_offset" : "0.91"
}
[out#0] trailing {brace} after the json
"#;

    #[test]
    fn parses_pass_one_json_anchored_on_input_i_despite_other_braces() {
        let measured = parse_loudnorm_measurement(PASS_ONE).unwrap();
        assert_eq!(measured.input_i, -15.93);
        assert_eq!(measured.target_offset, 0.91);
        let (mode, reason) = normalization_decision(Some(&measured), &target(false, false));
        assert_eq!((mode, reason), (NormalizationMode::Measured, None));
        assert_eq!(
            pass_two_loudnorm(&target(false, false), mode, Some(&measured)),
            "loudnorm=I=-16.0:TP=-1.5:LRA=11.0:measured_I=-15.93:measured_TP=-1.82:measured_LRA=7.20:measured_thresh=-27.80:offset=0.91:linear=true:print_format=summary"
        );
    }

    #[test]
    fn silence_and_non_finite_measurements_never_build_a_pass_two_filter() {
        let silent = PASS_ONE
            .replace("\"-15.93\"", "\"-inf\"")
            .replace("\"-1.82\"", "\"-inf\"");
        assert_eq!(parse_loudnorm_measurement(&silent), None);
        let (mode, reason) = normalization_decision(None, &target(false, false));
        assert_eq!(mode, NormalizationMode::None);
        assert_eq!(reason, Some("unmeasurable_or_silent"));
        assert_eq!(
            pass_two_loudnorm(&target(false, false), mode, None),
            "anull"
        );
        assert_eq!(parse_loudnorm_measurement("ffmpeg exited with 1"), None);
    }

    #[test]
    fn linear_gate_reports_dynamic_mode_with_the_reason() {
        let mut loud_peaks = parse_loudnorm_measurement(PASS_ONE).unwrap();
        loud_peaks.input_i = -30.0; // +14 dB of gain would push -1.82 dBTP far above the ceiling.
        assert_eq!(
            normalization_decision(Some(&loud_peaks), &target(false, false)),
            (
                NormalizationMode::Dynamic,
                Some("true_peak_would_exceed_ceiling")
            )
        );
        let mut wide = parse_loudnorm_measurement(PASS_ONE).unwrap();
        wide.input_lra = 18.0;
        assert_eq!(
            normalization_decision(Some(&wide), &target(false, false)).0,
            NormalizationMode::Dynamic
        );
    }

    #[test]
    fn parses_only_the_last_ebur128_summary_and_fails_unmeasurable_output() {
        let stderr = "Summary:\n  Integrated loudness:\n    I:  -40.0 LUFS\n\
            [Parsed_ebur128_0] Summary:\n\n  Integrated loudness:\n    I:         -15.5 LUFS\n    Threshold: -29.4 LUFS\n\n  Loudness range:\n    LRA:        18.9 LU\n\n  True peak:\n    Peak:       -1.8 dBFS\n";
        let summary = parse_ebur128_summary(stderr).unwrap();
        assert_eq!(summary.integrated_lufs, -15.5);
        assert_eq!(summary.true_peak_dbtp, -1.8);
        let report = build_loudness_report(
            &target(false, false),
            NormalizationMode::Measured,
            None,
            None,
            Some(&summary),
            Some(0),
        );
        assert!(report.passed, "{:?}", report.findings);

        let unmeasured = build_loudness_report(
            &target(false, false),
            NormalizationMode::Measured,
            None,
            None,
            parse_ebur128_summary("  I: -inf LUFS").as_ref(),
            Some(0),
        );
        assert!(!unmeasured.passed);
        assert!(unmeasured
            .findings
            .contains(&"output_loudness_could_not_be_measured".to_owned()));
    }

    #[test]
    fn out_of_tolerance_or_over_ceiling_fails_and_clipping_is_reported() {
        let summary = |i: f64, tp: f64| Ebur128Summary {
            integrated_lufs: i,
            loudness_range_lu: 5.0,
            true_peak_dbtp: tp,
        };
        let check = |i: f64, tp: f64, clipped: Option<u64>| {
            build_loudness_report(
                &target(false, false),
                NormalizationMode::Measured,
                None,
                None,
                Some(&summary(i, tp)),
                clipped,
            )
        };
        assert!(!check(-17.2, -2.0, Some(0)).passed);
        assert!(!check(-16.0, -0.8, Some(0)).passed);
        let clipped = check(-16.0, -2.0, Some(12));
        assert!(
            clipped.passed,
            "clipping in the source is reported, not hidden"
        );
        assert!(clipped.findings.contains(&"source_mix_clipped".to_owned()));
        assert_eq!(clipped.source_clipped_samples, 12);
        assert_eq!(
            parse_clipped_samples("Overall\nPeak level dB: 0.000000\nPeak count: 12.000000\n"),
            Some(12)
        );
        assert_eq!(
            parse_clipped_samples("Overall\nPeak level dB: -3.2\nPeak count: 2.0\n"),
            Some(0)
        );
    }
}
