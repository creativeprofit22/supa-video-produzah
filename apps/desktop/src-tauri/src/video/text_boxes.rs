//! Where text sits on the frame: resting intervals of graphics text layers, their boxes after
//! centre scale and rotation, caption boxes, and the space auto-fit may use inside the safe area.
//!
//! Pure geometry over validated project data; measurement is injected via [`MeasureText`].

use super::{
    delivery::SafeAreaRect,
    project::graphics::{GraphicsKeyframe, LayerTracks},
    text_layout::{fit_text, FittedText, MeasureText, Size},
    types::RenderCaptionStyle,
};

/// The renderer's per-character advance estimate (`TEXT_ADVANCE_EM` in graphics-renderer). The
/// renderer scales and rotates a text layer around the centre of this estimated box, so the
/// geometry here must use it as the pivot even though the ink box is measured.
pub(crate) const RENDERER_TEXT_ADVANCE_EM: f64 = 0.55;
/// Line pitch of multi-line text in the renderer, in font sizes (`text_layout::LINE_HEIGHT_RATIO`).
pub(crate) const RENDERER_LINE_HEIGHT_EM: f64 = 1.2;
/// The drawtext box border around burned-in captions (`BOX_BORDER_PX` in `caption_render`).
const CAPTION_BOX_BORDER_PX: f64 = 12.0;

/// An axis-aligned box in frame pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Rect {
    pub(crate) left: f64,
    pub(crate) top: f64,
    pub(crate) right: f64,
    pub(crate) bottom: f64,
}

impl Rect {
    pub(crate) fn intersection_area(&self, other: &Rect) -> f64 {
        let width = self.right.min(other.right) - self.left.max(other.left);
        let height = self.bottom.min(other.bottom) - self.top.max(other.top);
        if width > 0.0 && height > 0.0 {
            width * height
        } else {
            0.0
        }
    }

    /// True when `self` lies inside `outer` (a small tolerance absorbs float noise).
    pub(crate) fn within(&self, left: f64, top: f64, right: f64, bottom: f64) -> bool {
        const EPSILON: f64 = 0.01;
        self.left >= left - EPSILON
            && self.top >= top - EPSILON
            && self.right <= right + EPSILON
            && self.bottom <= bottom + EPSILON
    }
}

/// Position, scale and rotation of a layer while it holds still.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct Pose {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) scale: f64,
    pub(crate) rotation: f64,
}

/// A clip-relative span where a layer holds one pose and is visible at both ends.
#[derive(Debug, Clone, Copy, PartialEq)]
pub(crate) struct RestingInterval {
    pub(crate) start_us: u64,
    pub(crate) end_us: u64,
    pub(crate) pose: Pose,
}

/// Value of a track at `time`, interpolating linearly between keys and holding the ends.
///
/// Easing is ignored: it is only used for visibility (`> 0`), and the supported easings keep the
/// sign of a segment's endpoints.
pub(crate) fn linear_value(keys: &[GraphicsKeyframe], time: u64) -> f64 {
    let Some(first) = keys.first() else {
        return 0.0;
    };
    if time <= first.time_microseconds {
        return first.value.get();
    }
    for pair in keys.windows(2) {
        let (a, b) = (&pair[0], &pair[1]);
        if time <= b.time_microseconds {
            let span = (b.time_microseconds - a.time_microseconds) as f64;
            let t = (time - a.time_microseconds) as f64 / span;
            return a.value.get() + (b.value.get() - a.value.get()) * t;
        }
    }
    keys.last().map_or(0.0, |key| key.value.get())
}

/// The constant value of a track over `[start, end]`, if it holds still there: the span is before
/// the first key, after the last, or between two keys of equal value with none in between.
pub(crate) fn held_value(keys: &[GraphicsKeyframe], start: u64, end: u64) -> Option<f64> {
    let first = keys.first()?;
    let last = keys.last()?;
    if end <= first.time_microseconds {
        return Some(first.value.get());
    }
    if start >= last.time_microseconds {
        return Some(last.value.get());
    }
    let before = keys
        .iter()
        .rev()
        .find(|key| key.time_microseconds <= start)?;
    let after = keys.iter().find(|key| key.time_microseconds >= end)?;
    let inner_equal = keys
        .iter()
        .filter(|key| {
            key.time_microseconds >= before.time_microseconds
                && key.time_microseconds <= after.time_microseconds
        })
        .all(|key| key.value == before.value);
    inner_equal.then_some(before.value.get())
}

/// The pose a layer ends on (last key of each track): the state auto-fit sizes for.
pub(crate) fn resting_pose(tracks: &LayerTracks<'_>) -> Pose {
    let last = |keys: &[GraphicsKeyframe], default: f64| {
        keys.last().map_or(default, |key| key.value.get())
    };
    Pose {
        x: last(tracks.x, 0.0),
        y: last(tracks.y, 0.0),
        scale: last(tracks.scale, 1.0),
        rotation: last(tracks.rotation, 0.0),
    }
}

/// Spans between consecutive keyframe times (of any track, plus 0 and the clip duration) where
/// x, y, scale and rotation hold and opacity is above zero at both ends. Fly-ins and fades are
/// therefore excluded; a layer that never moves yields one interval for its visible span.
/// Adjacent intervals with the same pose are merged.
pub(crate) fn resting_intervals(
    tracks: &LayerTracks<'_>,
    duration_us: u64,
) -> Vec<RestingInterval> {
    let mut times: Vec<u64> = [
        tracks.x,
        tracks.y,
        tracks.scale,
        tracks.rotation,
        tracks.opacity,
    ]
    .iter()
    .flat_map(|keys| keys.iter().map(|key| key.time_microseconds))
    .filter(|time| *time < duration_us)
    .chain([0, duration_us])
    .collect();
    times.sort_unstable();
    times.dedup();
    let mut intervals: Vec<RestingInterval> = Vec::new();
    for pair in times.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        let visible =
            linear_value(tracks.opacity, start) > 0.0 && linear_value(tracks.opacity, end) > 0.0;
        let pose = (|| {
            Some(Pose {
                x: held_value(tracks.x, start, end)?,
                y: held_value(tracks.y, start, end)?,
                scale: held_value(tracks.scale, start, end)?,
                rotation: held_value(tracks.rotation, start, end)?,
            })
        })();
        let (true, Some(pose)) = (visible, pose) else {
            continue;
        };
        match intervals.last_mut() {
            Some(previous) if previous.end_us == start && previous.pose == pose => {
                previous.end_us = end
            }
            _ => intervals.push(RestingInterval {
                start_us: start,
                end_us: end,
                pose,
            }),
        }
    }
    intervals
}

/// Clip-relative spans where the opacity track is above zero, clamped to `[0, duration_us]`.
pub(crate) fn visible_spans(opacity: &[GraphicsKeyframe], duration_us: u64) -> Vec<(u64, u64)> {
    let mut times: Vec<u64> = opacity
        .iter()
        .map(|key| key.time_microseconds)
        .filter(|time| *time < duration_us)
        .chain([0, duration_us])
        .collect();
    times.sort_unstable();
    times.dedup();
    let mut spans: Vec<(u64, u64)> = Vec::new();
    for pair in times.windows(2) {
        let (start, end) = (pair[0], pair[1]);
        // Linear segments: visible inside unless both ends are zero.
        let midpoint = start + (end - start) / 2;
        if linear_value(opacity, start) <= 0.0
            && linear_value(opacity, end) <= 0.0
            && linear_value(opacity, midpoint) <= 0.0
        {
            continue;
        }
        match spans.last_mut() {
            Some(previous) if previous.1 == start => previous.1 = end,
            _ => spans.push((start, end)),
        }
    }
    spans
}

/// The box the renderer scales and rotates a text layer around (mirrors the renderer's
/// `Layer::bounds`): estimated width of the longest line, and one font size of height plus one
/// line height per extra line.
pub(crate) fn renderer_pivot_size(text: &str, font_size: f64, line_breaks: &[usize]) -> (f64, f64) {
    let mut longest = 0usize;
    let mut start = 0usize;
    for end in line_breaks.iter().copied().chain([text.len()]) {
        longest = longest.max(text.get(start..end).map_or(0, |line| line.chars().count()));
        start = end;
    }
    let lines = line_breaks.len() as f64;
    (
        (longest as f64 * RENDERER_TEXT_ADVANCE_EM * font_size).max(1.0),
        font_size + lines * RENDERER_LINE_HEIGHT_EM * font_size,
    )
}

/// Axis-aligned frame box of a `ink_width`×`ink_height` box at the layer origin, after the
/// renderer's transform: scale and clockwise rotation around the pivot box's centre.
pub(crate) fn layer_box(pose: Pose, pivot: (f64, f64), ink: (f64, f64)) -> Rect {
    let (sin, cos) = pose.rotation.to_radians().sin_cos();
    let scale = pose.scale.max(0.0);
    let (cx, cy) = (pivot.0 / 2.0, pivot.1 / 2.0);
    let corners = [(0.0, 0.0), (ink.0, 0.0), (0.0, ink.1), (ink.0, ink.1)].map(|(px, py)| {
        let (dx, dy) = ((px - cx) * scale, (py - cy) * scale);
        (
            pose.x + cx + dx * cos - dy * sin,
            pose.y + cy + dx * sin + dy * cos,
        )
    });
    corners.iter().fold(
        Rect {
            left: f64::INFINITY,
            top: f64::INFINITY,
            right: f64::NEG_INFINITY,
            bottom: f64::NEG_INFINITY,
        },
        |rect, (x, y)| Rect {
            left: rect.left.min(*x),
            top: rect.top.min(*y),
            right: rect.right.max(*x),
            bottom: rect.bottom.max(*y),
        },
    )
}

/// The space an unrotated text layer may grow into: from its pose's left/top edge (with the
/// pivot from its authored text) to the safe area's right/bottom edge, divided by scale.
///
/// `None` when the layer is rotated, invisibly scaled, or already starts outside the safe area on
/// the left/top — shrinking cannot fix a position, so QC reports it instead.
pub(crate) fn fit_available(pose: Pose, pivot: (f64, f64), safe: &SafeAreaRect) -> Option<Size> {
    if pose.rotation.rem_euclid(360.0) != 0.0 || pose.scale <= 0.0 {
        return None;
    }
    let left = pose.x + pivot.0 * (1.0 - pose.scale) / 2.0;
    let top = pose.y + pivot.1 * (1.0 - pose.scale) / 2.0;
    if left < safe.left - 0.01 || top < safe.top - 0.01 {
        return None;
    }
    Some(Size {
        width: ((safe.right - left) / pose.scale).max(0.0) as f32,
        height: ((safe.bottom - top) / pose.scale).max(0.0) as f32,
    })
}

/// Fits a graphics text layer into the safe area at its resting pose (shrink, then wrap).
/// Rotated layers keep their authored size (`None`), as does text whose position cannot fit.
pub(crate) fn fit_graphics_text(
    measure: &mut dyn MeasureText,
    text: &str,
    font_size: f64,
    tracks: &LayerTracks<'_>,
    safe: &SafeAreaRect,
) -> Option<FittedText> {
    let pose = resting_pose(tracks);
    let mut available = fit_available(pose, renderer_pivot_size(text, font_size, &[]), safe)?;
    let mut fitted = fit_text(measure, text, font_size as f32, available);
    // The renderer's pivot follows the fitted size and lines, which moves a scaled layer's edges.
    // Every edge is linear in the font size and collapses onto the pose origin at size 0, so
    // scaling the box by (room ÷ reach) lands a shrink-only fit exactly; wraps converge quickly.
    for _ in 0..4 {
        let pivot = renderer_pivot_size(text, f64::from(fitted.font_size), &fitted.line_breaks);
        let drawn = layer_box(
            pose,
            pivot,
            (f64::from(fitted.width), f64::from(fitted.height)),
        );
        let ratio = |edge: f64, limit: f64, origin: f64| {
            if edge > limit + 0.01 && edge > origin {
                ((limit - origin) / (edge - origin)).clamp(0.0, 1.0) * 0.9999
            } else {
                1.0
            }
        };
        let ratio_x = ratio(drawn.right, safe.right, pose.x);
        let ratio_y = ratio(drawn.bottom, safe.bottom, pose.y);
        if ratio_x >= 1.0 && ratio_y >= 1.0 {
            break;
        }
        available = Size {
            width: (f64::from(available.width) * ratio_x) as f32,
            height: (f64::from(available.height) * ratio_y) as f32,
        };
        fitted = fit_text(measure, text, font_size as f32, available);
    }
    Some(fitted)
}

/// Size and lines a graphics text layer is drawn with: auto-fitted when possible, else authored.
pub(crate) fn drawn_text(
    measure: &mut dyn MeasureText,
    text: &str,
    font_size: f64,
    tracks: &LayerTracks<'_>,
    safe: &SafeAreaRect,
) -> FittedText {
    fit_graphics_text(measure, text, font_size, tracks, safe).unwrap_or_else(|| {
        let layout = measure.layout(text, font_size as f32, None);
        FittedText {
            font_size: font_size as f32,
            line_breaks: Vec::new(),
            width: layout.width,
            height: layout.height,
            fits: true,
        }
    })
}

/// The burned-in caption's box (text plus drawtext border) for a measured `text_size`, placed
/// with the same expressions as `caption_render`: styled captions clamp the anchored text into
/// the style's safe area, unstyled ones sit centred above the bottom twelfth.
pub(crate) fn caption_box(
    style: Option<&RenderCaptionStyle>,
    frame: (f64, f64),
    text_size: (f64, f64),
) -> Rect {
    let (w, h) = frame;
    let (text_w, text_h) = text_size;
    let border = CAPTION_BOX_BORDER_PX;
    let (x, y) = match style {
        None => ((w - text_w) / 2.0, h - text_h - h / 12.0),
        Some(style) => {
            let permille = |value: u64| value as f64 / 1000.0;
            let left = w * permille(style.safe_left_permille) + border;
            let right = w * (1.0 - permille(style.safe_right_permille)) - border;
            let top = h * permille(style.safe_top_permille) + border;
            let bottom = h * (1.0 - permille(style.safe_bottom_permille)) - border;
            let anchor_x = w * permille(style.anchor_x_permille);
            let anchor_y = h * permille(style.anchor_y_permille);
            let raw_x = match style.horizontal.as_str() {
                "left" => anchor_x,
                "right" => anchor_x - text_w,
                _ => anchor_x - text_w / 2.0,
            };
            let raw_y = match style.vertical.as_str() {
                "top" => anchor_y,
                "bottom" => anchor_y - text_h,
                _ => anchor_y - text_h / 2.0,
            };
            (
                left.max(raw_x.min(right - text_w)),
                top.max(raw_y.min(bottom - text_h)),
            )
        }
    };
    Rect {
        left: x - border,
        top: y - border,
        right: x + text_w + border,
        bottom: y + text_h + border,
    }
}

/// Font key and pixel size a caption is drawn with (unstyled captions: Arial at `h/18`).
pub(crate) fn caption_font(
    style: Option<&RenderCaptionStyle>,
    frame_height: f64,
) -> (&str, f64, f64) {
    match style {
        Some(style) => (
            style.font.as_str(),
            style.font_size_px as f64,
            style.line_spacing_px as f64,
        ),
        None => ("arial-regular", frame_height / 18.0, 0.0),
    }
}

/// Measured caption text size: shaped lines (explicit `\n` only) plus drawtext line spacing.
pub(crate) fn caption_text_size(
    measure: &mut dyn MeasureText,
    text: &str,
    font_size: f64,
    line_spacing: f64,
) -> (f64, f64) {
    let layout = measure.layout(text, font_size as f32, None);
    let lines = layout.lines.len().max(1) as f64;
    (
        f64::from(layout.width),
        f64::from(layout.height) + (lines - 1.0) * line_spacing,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::{project::graphics::GraphicsNumber, text_layout::TextLayoutResult};

    fn key(time_ms: u64, value: f64) -> GraphicsKeyframe {
        GraphicsKeyframe {
            time_microseconds: time_ms * 1000,
            value: GraphicsNumber(value),
            easing: None,
        }
    }

    fn hold(value: f64) -> Vec<GraphicsKeyframe> {
        vec![key(0, value)]
    }

    struct Tracks {
        x: Vec<GraphicsKeyframe>,
        y: Vec<GraphicsKeyframe>,
        scale: Vec<GraphicsKeyframe>,
        rotation: Vec<GraphicsKeyframe>,
        opacity: Vec<GraphicsKeyframe>,
    }

    impl Tracks {
        fn still(x: f64, y: f64) -> Self {
            Self {
                x: hold(x),
                y: hold(y),
                scale: hold(1.0),
                rotation: hold(0.0),
                opacity: hold(1.0),
            }
        }

        fn view(&self) -> LayerTracks<'_> {
            LayerTracks {
                x: &self.x,
                y: &self.y,
                scale: &self.scale,
                rotation: &self.rotation,
                opacity: &self.opacity,
            }
        }
    }

    #[test]
    fn linear_value_interpolates_and_holds_ends() {
        let keys = [key(100, 0.0), key(200, 1.0)];
        assert_eq!(linear_value(&keys, 0), 0.0);
        assert_eq!(linear_value(&keys, 150_000), 0.5);
        assert_eq!(linear_value(&keys, 500_000), 1.0);
    }

    #[test]
    fn held_value_needs_equal_enclosing_keys() {
        let keys = [key(0, 10.0), key(500, 10.0), key(1000, 20.0)];
        assert_eq!(held_value(&keys, 0, 500_000), Some(10.0));
        assert_eq!(held_value(&keys, 500_000, 1_000_000), None);
        assert_eq!(held_value(&keys, 1_000_000, 2_000_000), Some(20.0));
    }

    #[test]
    fn fly_in_and_fade_in_are_not_resting() {
        // Slides in from off-screen over 0.5 s, fades in over 0.2 s, then holds for 1.5 s.
        let mut tracks = Tracks::still(0.0, 100.0);
        tracks.x = vec![key(0, -800.0), key(500, 100.0)];
        tracks.opacity = vec![key(0, 0.0), key(200, 1.0)];
        let intervals = resting_intervals(&tracks.view(), 2_000_000);
        assert_eq!(
            intervals,
            vec![RestingInterval {
                start_us: 500_000,
                end_us: 2_000_000,
                pose: Pose {
                    x: 100.0,
                    y: 100.0,
                    scale: 1.0,
                    rotation: 0.0
                },
            }]
        );
    }

    #[test]
    fn invisible_layers_have_no_resting_interval_and_a_still_layer_has_one() {
        let mut tracks = Tracks::still(10.0, 20.0);
        assert_eq!(resting_intervals(&tracks.view(), 1_000_000).len(), 1);
        tracks.opacity = hold(0.0);
        assert!(resting_intervals(&tracks.view(), 1_000_000).is_empty());
    }

    #[test]
    fn visible_spans_follow_opacity() {
        let opacity = [key(0, 0.0), key(200, 1.0), key(1000, 1.0), key(1200, 0.0)];
        assert_eq!(visible_spans(&opacity, 2_000_000), vec![(0, 1_200_000)]);
        assert_eq!(visible_spans(&hold(1.0), 3_000_000), vec![(0, 3_000_000)]);
        assert!(visible_spans(&hold(0.0), 3_000_000).is_empty());
    }

    #[test]
    fn layer_box_scales_and_rotates_around_the_pivot_centre() {
        let pose = |scale, rotation| Pose {
            x: 100.0,
            y: 200.0,
            scale,
            rotation,
        };
        assert_eq!(
            layer_box(pose(1.0, 0.0), (400.0, 50.0), (380.0, 60.0)),
            Rect {
                left: 100.0,
                top: 200.0,
                right: 480.0,
                bottom: 260.0
            }
        );
        // Half scale around (300, 225).
        assert_eq!(
            layer_box(pose(0.5, 0.0), (400.0, 50.0), (400.0, 50.0)),
            Rect {
                left: 200.0,
                top: 212.5,
                right: 400.0,
                bottom: 237.5
            }
        );
        // 90° turns a 400×50 box into 50×400 around the same centre.
        let turned = layer_box(pose(1.0, 90.0), (400.0, 50.0), (400.0, 50.0));
        for (got, want) in [
            (turned.left, 275.0),
            (turned.top, 25.0),
            (turned.right, 325.0),
            (turned.bottom, 425.0),
        ] {
            assert!((got - want).abs() < 1e-9, "{turned:?}");
        }
    }

    #[test]
    fn pivot_size_mirrors_the_renderer_bounds() {
        let (w, h) = renderer_pivot_size("abcd", 100.0, &[]);
        assert!((w - 220.0).abs() < 1e-9 && h == 100.0);
        // Two lines: the longer is 3 chars; height adds one 1.2× line.
        let (w, h) = renderer_pivot_size("ab cde", 100.0, &[3]);
        assert!((w - 165.0).abs() < 1e-9 && (h - 220.0).abs() < 1e-6);
    }

    #[test]
    fn fit_available_measures_to_the_safe_area_edge() {
        let safe = SafeAreaRect {
            left: 96.0,
            top: 54.0,
            right: 1824.0,
            bottom: 1026.0,
        };
        let pose = |x, y, scale, rotation| Pose {
            x,
            y,
            scale,
            rotation,
        };
        assert_eq!(
            fit_available(pose(100.0, 900.0, 1.0, 0.0), (500.0, 60.0), &safe),
            Some(Size {
                width: 1724.0,
                height: 126.0
            })
        );
        // Scale 2 around a 500×60 pivot: left edge moves to x − 250, room halves.
        assert_eq!(
            fit_available(pose(400.0, 100.0, 2.0, 0.0), (500.0, 60.0), &safe),
            Some(Size {
                width: (1824.0 - 150.0) / 2.0,
                height: (1026.0 - 70.0) / 2.0
            })
        );
        assert_eq!(
            fit_available(pose(100.0, 900.0, 1.0, 15.0), (500.0, 60.0), &safe),
            None
        );
        assert_eq!(
            fit_available(pose(10.0, 900.0, 1.0, 0.0), (500.0, 60.0), &safe),
            None
        );
    }

    #[test]
    fn caption_box_uses_the_drawtext_placement() {
        // Unstyled, 1920×1080: centred, bottom at h − h/12, plus the 12 px border.
        assert_eq!(
            caption_box(None, (1920.0, 1080.0), (400.0, 72.0)),
            Rect {
                left: 748.0,
                top: 906.0,
                right: 1172.0,
                bottom: 1002.0
            }
        );
        let style = RenderCaptionStyle {
            font: "arial-regular".into(),
            font_size_px: 48,
            line_spacing_px: 8,
            color_rgba: "#ffffffff".into(),
            horizontal: "center".into(),
            vertical: "bottom".into(),
            anchor_x_permille: 500,
            anchor_y_permille: 1000,
            safe_top_permille: 50,
            safe_right_permille: 50,
            safe_bottom_permille: 100,
            safe_left_permille: 50,
        };
        // Anchored at the very bottom, clamped up to the 10 % safe edge minus the border.
        let rect = caption_box(Some(&style), (1000.0, 1000.0), (300.0, 100.0));
        assert_eq!(
            rect,
            Rect {
                left: 338.0,
                top: 776.0,
                right: 662.0,
                bottom: 900.0
            }
        );
    }

    struct FixedMeasure;

    impl MeasureText for FixedMeasure {
        fn layout(&mut self, text: &str, size: f32, _max: Option<f32>) -> TextLayoutResult {
            let lines: Vec<_> = text.split('\n').collect();
            let mut ranges = Vec::new();
            let mut start = 0;
            for line in &lines {
                ranges.push(start..start + line.len());
                start += line.len() + 1;
            }
            let longest = lines
                .iter()
                .map(|line| line.chars().count())
                .max()
                .unwrap_or(0);
            TextLayoutResult {
                width: longest as f32 * size * 0.5,
                height: lines.len() as f32 * size * 1.2,
                line_height: size * 1.2,
                lines: ranges,
            }
        }
    }

    #[test]
    fn caption_text_size_adds_line_spacing_between_lines() {
        assert_eq!(
            caption_text_size(&mut FixedMeasure, "ab\ncdef", 10.0, 4.0),
            (20.0, 28.0)
        );
        assert_eq!(caption_font(None, 1080.0), ("arial-regular", 60.0, 0.0));
    }

    #[test]
    fn rotated_layers_are_drawn_at_their_authored_size() {
        let safe = SafeAreaRect {
            left: 0.0,
            top: 0.0,
            right: 100.0,
            bottom: 100.0,
        };
        let mut tracks = Tracks::still(0.0, 0.0);
        tracks.rotation = hold(10.0);
        let drawn = drawn_text(
            &mut FixedMeasure,
            "a long line of text",
            40.0,
            &tracks.view(),
            &safe,
        );
        assert_eq!(drawn.font_size, 40.0);
        assert!(drawn.line_breaks.is_empty());
    }

    #[test]
    fn scaled_layers_refit_until_the_drawn_box_is_inside() {
        // Scale 2: the pivot shrinks with the font, moving the left edge right; the refit loop
        // must still land the drawn box inside the safe right edge.
        let safe = SafeAreaRect {
            left: 0.0,
            top: 0.0,
            right: 1000.0,
            bottom: 1000.0,
        };
        let mut tracks = Tracks::still(300.0, 300.0);
        tracks.scale = hold(2.0);
        tracks.x = hold(500.0);
        let text = "abcdefghijklmnopqrst";
        let fitted =
            fit_graphics_text(&mut FixedMeasure, text, 40.0, &tracks.view(), &safe).unwrap();
        assert!(fitted.font_size < 40.0);
        let pose = resting_pose(&tracks.view());
        let pivot = renderer_pivot_size(text, f64::from(fitted.font_size), &fitted.line_breaks);
        let drawn = layer_box(
            pose,
            pivot,
            (f64::from(fitted.width), f64::from(fitted.height)),
        );
        assert!(drawn.right <= 1000.01, "{drawn:?}");
    }
}
