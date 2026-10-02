//! Text QC: reading time, graphics text outside the safe area, and overlapping text boxes.
//!
//! A fixed-advance fake measurer keeps the geometry exact and platform-independent; one test runs
//! the whole check with the real Windows fonts.

use serde_json::{json, Value};

use crate::video::{
    delivery::{safe_area_for_frame, SafeAreaRect},
    qc::{
        reading_time_findings, text_findings, QcFinding, QcFindingKind, QcRange, QcSeverity,
        QcSource, TextMeasurers, TextQcInput,
    },
    text_layout::{MeasureText, TextLayoutResult},
    types::{RenderCaptionInput, RenderGraphicsInputV2},
};

const STATE: &str = "6666666666666666666666666666666666666666666666666666666666666666";
const CLIP_ID: &str = "7f000000-0000-4000-8000-000000000009";
const CAPTION_ID: &str = "66666666-6666-4666-8666-666666666602";

/// Every char is `0.5 × size` wide; explicit `\n` breaks lines; no wrapping.
struct FixedAdvance;

impl MeasureText for FixedAdvance {
    fn layout(&mut self, text: &str, size: f32, _max_width: Option<f32>) -> TextLayoutResult {
        let mut lines = Vec::new();
        let mut start = 0;
        for (index, c) in text.char_indices() {
            if c == '\n' {
                lines.push(start..index + 1);
                start = index + 1;
            }
        }
        lines.push(start..text.len());
        let width = text
            .split('\n')
            .map(|line| line.chars().count() as f32 * size * 0.5)
            .fold(0.0, f32::max);
        TextLayoutResult {
            height: size * 1.2 * lines.len() as f32,
            lines,
            line_height: size * 1.2,
            width,
        }
    }
}

struct Fake {
    measure: FixedAdvance,
    available: bool,
}

impl TextMeasurers for Fake {
    fn measurer(&mut self, _font_key: &str) -> Option<&mut dyn MeasureText> {
        self.available
            .then_some(&mut self.measure as &mut dyn MeasureText)
    }
}

fn fake() -> Fake {
    Fake {
        measure: FixedAdvance,
        available: true,
    }
}

fn keys(points: &[(u64, f64)]) -> Value {
    Value::Array(
        points
            .iter()
            .map(|(time, value)| json!({ "timeMicroseconds": time, "value": value }))
            .collect(),
    )
}

/// One text layer on a 4 s graphics clip placed at timeline `start_us`.
fn graphics(
    start_us: u64,
    text: &str,
    size: f64,
    x: Value,
    y: Value,
    opacity: Value,
) -> RenderGraphicsInputV2 {
    serde_json::from_value(json!({
        "trackId": "7f000000-0000-4000-8000-000000000002",
        "clip": {
            "graphicsVersion": 1, "id": CLIP_ID,
            "timelineStart": { "value": 0, "rateNumerator": 30, "rateDenominator": 1 },
            "duration": { "value": 120, "rateNumerator": 30, "rateDenominator": 1 },
            "fontKey": "arial-regular",
            "layers": [{ "kind": "text", "text": text, "fontSize": size, "fill": "#FFFFFF",
                "x": x, "y": y, "scale": keys(&[(0, 1.0)]), "rotation": keys(&[(0, 0.0)]),
                "opacity": opacity }]
        },
        "startMicroseconds": start_us,
        "endMicroseconds": start_us + 4_000_000,
        "imagePathsByAssetId": {},
    }))
    .expect("graphics fixture must deserialize")
}

fn still(start_us: u64, text: &str, size: f64, x: f64, y: f64) -> RenderGraphicsInputV2 {
    graphics(
        start_us,
        text,
        size,
        keys(&[(0, x)]),
        keys(&[(0, y)]),
        keys(&[(0, 1.0)]),
    )
}

fn caption(text: &str, start: u64, end: u64) -> RenderCaptionInput {
    serde_json::from_value(json!({
        "trackId": "66666666-6666-4666-8666-666666666601",
        "captionId": CAPTION_ID,
        "startMicroseconds": start,
        "endMicroseconds": end,
        "text": text,
    }))
    .expect("caption fixture must deserialize")
}

const FRAME: (u64, u64) = (1920, 1080);

fn safe() -> SafeAreaRect {
    safe_area_for_frame(FRAME.0, FRAME.1, Some("landscape_16x9_1080p"))
}

fn run(
    captions: &[RenderCaptionInput],
    graphics: &[RenderGraphicsInputV2],
    measurers: &mut dyn TextMeasurers,
) -> Vec<QcFinding> {
    text_findings(
        &TextQcInput {
            captions,
            graphics,
            frame: FRAME,
            safe_area: safe(),
            duration_us: 10_000_000,
            chars_per_second: 17.0,
        },
        measurers,
        STATE,
    )
}

fn of_kind(findings: &[QcFinding], kind: QcFindingKind) -> Vec<&QcFinding> {
    findings
        .iter()
        .filter(|finding| finding.kind == kind)
        .collect()
}

#[test]
fn reading_time_at_exactly_17_cps_passes_and_faster_warns() {
    // 34 characters (the line break does not count) need exactly 2 s.
    let text = "Seventeen chars!!\nSeventeen chars!!";
    let exact = caption(text, 1_000_000, 3_000_000);
    assert!(reading_time_findings(&[exact], &[], 10_000_000, 17.0, STATE).is_empty());

    let fast = caption(text, 1_000_000, 2_999_999);
    let findings = reading_time_findings(&[fast], &[], 10_000_000, 17.0, STATE);
    assert_eq!(findings.len(), 1);
    let finding = &findings[0];
    assert_eq!(finding.kind, QcFindingKind::ReadingTimeShort);
    assert_eq!(finding.severity, QcSeverity::Warning);
    assert_eq!(finding.source, QcSource::Deterministic);
    assert_eq!(finding.subject, CAPTION_ID);
    assert_eq!(
        finding.range,
        QcRange {
            start_us: 1_000_000,
            end_us: 2_999_999
        }
    );
    assert!(finding.is_well_formed(STATE));
}

#[test]
fn reading_time_judges_a_caption_cue_by_its_artifact_rate() {
    // 38 characters on screen for 2 s is 19 cps: fine at the artifact's 20 cps,
    // too fast for the 17 cps default.
    let text = "Nineteen chars here\nNineteen chars here";
    let default_rate = caption(text, 1_000_000, 3_000_000);
    let artifact_rate = RenderCaptionInput {
        max_characters_per_second: Some(20),
        ..default_rate.clone()
    };

    assert!(reading_time_findings(&[artifact_rate], &[], 10_000_000, 17.0, STATE).is_empty());
    let findings = reading_time_findings(&[default_rate], &[], 10_000_000, 17.0, STATE);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].kind, QcFindingKind::ReadingTimeShort);
    assert_eq!(findings[0].severity, QcSeverity::Warning);
}

#[test]
fn reading_time_reports_the_artifact_rate_a_cue_misses() {
    // 38 characters in 1.5 s is ~25 cps, too fast even at the artifact's 20 cps.
    let fast = RenderCaptionInput {
        max_characters_per_second: Some(20),
        ..caption(
            "Nineteen chars here\nNineteen chars here",
            1_000_000,
            2_500_000,
        )
    };
    let findings = reading_time_findings(&[fast], &[], 10_000_000, 17.0, STATE);
    assert_eq!(findings.len(), 1);
    assert!(findings[0].message.contains("at 20 characters per second"));
}

#[test]
fn reading_time_times_graphics_text_by_its_visible_span_on_the_timeline() {
    // Clip at 2 s; text fades in over 0.5 s and is gone at 1.5 s: visible 0..1.5 s clip time.
    // 34 chars need 2 s, so it is too fast; the range is on the timeline.
    let opacity = keys(&[(0, 0.0), (500_000, 1.0), (1_000_000, 1.0), (1_500_000, 0.0)]);
    let layer = graphics(
        2_000_000,
        "Seventeen chars!! Seventeen chars!",
        48.0,
        keys(&[(0, 200.0)]),
        keys(&[(0, 200.0)]),
        opacity,
    );
    let findings = reading_time_findings(&[], &[layer], 10_000_000, 17.0, STATE);
    assert_eq!(findings.len(), 1);
    assert_eq!(findings[0].subject, format!("{CLIP_ID}:0"));
    assert_eq!(
        findings[0].range,
        QcRange {
            start_us: 2_000_000,
            end_us: 3_500_000
        }
    );

    // Visible for the whole 4 s clip: readable.
    let steady = still(
        2_000_000,
        "Seventeen chars!! Seventeen chars!",
        48.0,
        200.0,
        200.0,
    );
    assert!(reading_time_findings(&[], &[steady], 10_000_000, 17.0, STATE).is_empty());
}

#[test]
fn rotated_text_crossing_the_safe_area_warns_and_leaving_the_frame_blocks() {
    // Rotated layers are not auto-fitted, so their authored box is checked as drawn.
    let rotated = |x: f64| {
        let mut input = still(0, "Rotated label", 40.0, x, 500.0);
        if let crate::video::project::graphics::GraphicsLayer::Text { rotation, .. } =
            &mut input.clip.layers[0]
        {
            *rotation = serde_json::from_value(keys(&[(0, 90.0)])).unwrap();
        }
        input
    };
    // Unrotated box: 13 chars × 20 = 260 wide, 48 tall; turned 90° about its centre it is
    // 48 wide and 260 tall, turned about the pivot centre x + 143 (0.55 em × 13 = 286 wide).
    // x = -100 → box spans x 15..63: inside the frame, left of the 96 px safe edge.
    let inside_frame = run(&[], &[rotated(-100.0)], &mut fake());
    let safe_area = of_kind(&inside_frame, QcFindingKind::TextOutsideSafeArea);
    assert_eq!(safe_area.len(), 1, "{inside_frame:?}");
    assert_eq!(safe_area[0].severity, QcSeverity::Warning);
    assert_eq!(
        safe_area[0].range,
        QcRange {
            start_us: 0,
            end_us: 4_000_000
        }
    );

    // x = -150 → box spans x -35..13: cut off by the frame edge.
    let off_frame = run(&[], &[rotated(-150.0)], &mut fake());
    let safe_area = of_kind(&off_frame, QcFindingKind::TextOutsideSafeArea);
    assert_eq!(safe_area.len(), 1);
    assert_eq!(safe_area[0].severity, QcSeverity::Blocker);

    // Well inside: nothing.
    assert!(of_kind(
        &run(&[], &[rotated(800.0)], &mut fake()),
        QcFindingKind::TextOutsideSafeArea
    )
    .is_empty());
}

#[test]
fn unrotated_text_that_cannot_be_fitted_is_flagged() {
    // One unbreakable word wider than the safe area even at the 80 % floor.
    // 100 chars × 0.5 × 38.4 px (the floor of 48) = 1920 px, wider than the 1728 px safe area.
    let word = "W".repeat(100);
    let findings = run(&[], &[still(0, &word, 48.0, 100.0, 300.0)], &mut fake());
    let safe_area = of_kind(&findings, QcFindingKind::TextOutsideSafeArea);
    assert_eq!(safe_area.len(), 1, "{findings:?}");
    assert_eq!(safe_area[0].severity, QcSeverity::Blocker);

    // Text that auto-fit can shrink into place is not flagged.
    let fitted = run(
        &[],
        &[still(0, "A heading that is a bit wide", 96.0, 600.0, 300.0)],
        &mut fake(),
    );
    assert!(
        of_kind(&fitted, QcFindingKind::TextOutsideSafeArea).is_empty(),
        "{fitted:?}"
    );
}

#[test]
fn fly_in_from_off_screen_is_not_flagged() {
    // Starts at x = -800 (off frame) and slides to 400 by 0.5 s, then rests there.
    let fly_in = graphics(
        0,
        "Welcome",
        60.0,
        keys(&[(0, -800.0), (500_000, 400.0)]),
        keys(&[(0, 400.0)]),
        keys(&[(0, 1.0)]),
    );
    let findings = run(&[], &[fly_in], &mut fake());
    assert!(
        of_kind(&findings, QcFindingKind::TextOutsideSafeArea).is_empty(),
        "{findings:?}"
    );

    // The same layer resting off screen after the move is flagged for the resting span only.
    let flies_out = graphics(
        0,
        "Goodbye",
        60.0,
        keys(&[(0, 400.0), (1_000_000, 400.0), (1_500_000, 1900.0)]),
        keys(&[(0, 400.0)]),
        keys(&[(0, 1.0)]),
    );
    let findings = run(&[], &[flies_out], &mut fake());
    let safe_area = of_kind(&findings, QcFindingKind::TextOutsideSafeArea);
    assert_eq!(safe_area.len(), 1, "{findings:?}");
    assert_eq!(
        safe_area[0].range,
        QcRange {
            start_us: 1_500_000,
            end_us: 4_000_000
        }
    );
}

#[test]
fn caption_and_graphics_overlap_only_while_both_are_on_screen() {
    // Unstyled caption: Arial at 1080/18 = 60 px, centred, bottom edge 90 px above the frame
    // bottom. "Hello there" is 11 × 30 = 330 wide, 72 tall → box (with the 12 px border)
    // x 783..1137, y 906..1002. A graphics label at y 920 across the centre overlaps it.
    let cue = caption("Hello there", 3_000_000, 5_000_000);
    let label = still(1_000_000, "Lower third", 40.0, 800.0, 920.0);
    let findings = run(std::slice::from_ref(&cue), &[label], &mut fake());
    let overlaps = of_kind(&findings, QcFindingKind::TextOverlap);
    assert_eq!(overlaps.len(), 1, "{findings:?}");
    let overlap = overlaps[0];
    assert_eq!(overlap.severity, QcSeverity::Warning);
    // Graphics 1..5 s, caption 3..5 s → shared 3..5 s.
    assert_eq!(
        overlap.range,
        QcRange {
            start_us: 3_000_000,
            end_us: 5_000_000
        }
    );
    let mut subjects = [CAPTION_ID.to_owned(), format!("{CLIP_ID}:0")];
    subjects.sort();
    assert_eq!(overlap.subject, subjects.join("+"));
    assert!(overlap.is_well_formed(STATE));

    // Same place, different time: no overlap.
    let later = still(5_000_000, "Lower third", 40.0, 800.0, 920.0);
    assert!(of_kind(
        &run(std::slice::from_ref(&cue), &[later], &mut fake()),
        QcFindingKind::TextOverlap
    )
    .is_empty());
    // Same time, different place: no overlap.
    let top = still(1_000_000, "Lower third", 40.0, 800.0, 200.0);
    assert!(of_kind(
        &run(&[cue], &[top], &mut fake()),
        QcFindingKind::TextOverlap
    )
    .is_empty());
}

#[test]
fn missing_fonts_skip_geometry_but_keep_reading_time() {
    let cue = caption("This caption is shown far too briefly", 0, 500_000);
    let label = still(0, "Lower third", 40.0, -150.0, 920.0);
    let mut no_fonts = Fake {
        measure: FixedAdvance,
        available: false,
    };
    let findings = run(&[cue], &[label], &mut no_fonts);
    assert!(findings
        .iter()
        .all(|finding| finding.kind == QcFindingKind::ReadingTimeShort));
    assert_eq!(findings.len(), 1);
}

/// The real measurement path: Arial from the Windows font directory.
#[cfg(windows)]
#[test]
fn real_fonts_flag_overlap_between_caption_and_graphics() {
    use crate::video::{graphics_export::FONT_DIRECTORY, qc::FontDirMeasurers};
    let cue = caption("Hello there", 0, 2_000_000);
    let label = still(0, "Lower third", 40.0, 800.0, 920.0);
    let mut measurers = FontDirMeasurers::new(std::path::Path::new(FONT_DIRECTORY));
    let findings = run(&[cue], &[label], &mut measurers);
    assert_eq!(
        of_kind(&findings, QcFindingKind::TextOverlap).len(),
        1,
        "{findings:?}"
    );
}
