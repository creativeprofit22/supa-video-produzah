//! Graphics description: the versioned JSON input of the renderer.
//!
//! Untrusted input is parsed with `deny_unknown_fields` and checked against fixed bounds before
//! any rendering happens; everything after `GraphicsDescription::parse` works with validated data.

use std::{fmt, path::PathBuf};

use serde::Deserialize;

pub const SCHEMA_VERSION: u32 = 1;
pub const MAX_CANVAS_SIZE: u32 = 4096;
pub const MAX_DURATION_FRAMES: u32 = 36_000;
pub const MAX_LAYERS: usize = 64;
pub const MAX_TEXT_CHARS: usize = 500;
pub const MAX_KEYFRAMES: usize = 256;
pub const MAX_FRAME_RATE: u32 = 240;
pub const MAX_DESCRIPTION_BYTES: usize = 1024 * 1024;
/// Positions may leave the canvas (for fly-ins) but stay within this many canvases of it.
const POSITION_MARGIN_CANVASES: f64 = 4.0;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphicsDescription {
    pub schema_version: u32,
    pub canvas: Canvas,
    pub frame_rate: FrameRate,
    pub duration_frames: u32,
    pub font: FontSpec,
    pub layers: Vec<Layer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Canvas {
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(deny_unknown_fields)]
pub struct FrameRate {
    pub numerator: u32,
    pub denominator: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct FontSpec {
    /// Absolute path of a `.ttf`/`.otf` file; the only font the renderer loads.
    pub file: PathBuf,
    /// Family name inside that file, used for every text layer.
    pub family: String,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Layer {
    #[serde(rename_all = "camelCase")]
    Rect {
        width: f64,
        height: f64,
        corner_radius: f64,
        fill: String,
        x: Track,
        y: Track,
        opacity: Track,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        font_size: f64,
        fill: String,
        x: Track,
        y: Track,
        opacity: Track,
    },
}

/// Keyframed value; before the first and after the last keyframe the value holds.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Track {
    pub keyframes: Vec<Keyframe>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keyframe {
    pub frame: u32,
    pub value: f64,
    /// Easing of the segment that starts at this keyframe.
    #[serde(default)]
    pub easing: Easing,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Easing {
    #[default]
    Linear,
    EaseIn,
    EaseOut,
    EaseInOut,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DescriptionError {
    TooLarge {
        bytes: usize,
    },
    Malformed(String),
    UnsupportedSchemaVersion(u32),
    CanvasSize {
        width: u32,
        height: u32,
    },
    FrameRate {
        numerator: u32,
        denominator: u32,
    },
    Duration(u32),
    LayerCount(usize),
    FontFile(String),
    FontFamily,
    Text {
        layer: usize,
    },
    Color {
        layer: usize,
    },
    Size {
        layer: usize,
    },
    Track {
        layer: usize,
        property: &'static str,
        reason: &'static str,
    },
}

impl fmt::Display for DescriptionError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { bytes } => {
                write!(
                    f,
                    "description is {bytes} bytes; limit is {MAX_DESCRIPTION_BYTES}"
                )
            }
            Self::Malformed(reason) => write!(f, "description is malformed: {reason}"),
            Self::UnsupportedSchemaVersion(version) => {
                write!(
                    f,
                    "schemaVersion {version} is not supported; expected {SCHEMA_VERSION}"
                )
            }
            Self::CanvasSize { width, height } => write!(
                f,
                "canvas {width}x{height} is outside 2..={MAX_CANVAS_SIZE} or has an odd side"
            ),
            Self::FrameRate {
                numerator,
                denominator,
            } => write!(
                f,
                "frame rate {numerator}/{denominator} must be positive and at most {MAX_FRAME_RATE} fps"
            ),
            Self::Duration(frames) => {
                write!(
                    f,
                    "durationFrames {frames} is outside 1..={MAX_DURATION_FRAMES}"
                )
            }
            Self::LayerCount(count) => write!(f, "{count} layers; limit is {MAX_LAYERS}"),
            Self::FontFile(reason) => write!(f, "font file is invalid: {reason}"),
            Self::FontFamily => write!(f, "font family must be 1..=64 printable characters"),
            Self::Text { layer } => write!(
                f,
                "layer {layer}: text must be 1..={MAX_TEXT_CHARS} characters without control characters"
            ),
            Self::Color { layer } => write!(f, "layer {layer}: fill must be #RRGGBB"),
            Self::Size { layer } => write!(
                f,
                "layer {layer}: size is not finite, positive or within bounds"
            ),
            Self::Track {
                layer,
                property,
                reason,
            } => {
                write!(f, "layer {layer}: {property} track {reason}")
            }
        }
    }
}

impl std::error::Error for DescriptionError {}

impl GraphicsDescription {
    /// Parses and validates untrusted description bytes.
    pub fn parse(bytes: &[u8]) -> Result<Self, DescriptionError> {
        if bytes.len() > MAX_DESCRIPTION_BYTES {
            return Err(DescriptionError::TooLarge { bytes: bytes.len() });
        }
        let description: Self = serde_json::from_slice(bytes)
            .map_err(|error| DescriptionError::Malformed(error.to_string()))?;
        description.validate()?;
        Ok(description)
    }

    fn validate(&self) -> Result<(), DescriptionError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(DescriptionError::UnsupportedSchemaVersion(
                self.schema_version,
            ));
        }
        let Canvas { width, height } = self.canvas;
        // Even sides keep the overlay usable by 4:2:0 encoders downstream.
        let side_ok = |side: u32| (2..=MAX_CANVAS_SIZE).contains(&side) && side.is_multiple_of(2);
        if !side_ok(width) || !side_ok(height) {
            return Err(DescriptionError::CanvasSize { width, height });
        }
        let FrameRate {
            numerator,
            denominator,
        } = self.frame_rate;
        if numerator == 0
            || denominator == 0
            || u64::from(numerator) > u64::from(MAX_FRAME_RATE) * u64::from(denominator)
        {
            return Err(DescriptionError::FrameRate {
                numerator,
                denominator,
            });
        }
        if !(1..=MAX_DURATION_FRAMES).contains(&self.duration_frames) {
            return Err(DescriptionError::Duration(self.duration_frames));
        }
        if self.layers.len() > MAX_LAYERS {
            return Err(DescriptionError::LayerCount(self.layers.len()));
        }
        validate_font(&self.font)?;
        let limits = Limits {
            width: f64::from(width),
            height: f64::from(height),
            duration_frames: self.duration_frames,
        };
        for (index, layer) in self.layers.iter().enumerate() {
            validate_layer(index, layer, &limits)?;
        }
        Ok(())
    }
}

struct Limits {
    width: f64,
    height: f64,
    duration_frames: u32,
}

fn validate_font(font: &FontSpec) -> Result<(), DescriptionError> {
    if !font.file.is_absolute() {
        return Err(DescriptionError::FontFile(
            "path must be absolute".to_owned(),
        ));
    }
    let extension = font
        .file
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase);
    if !matches!(extension.as_deref(), Some("ttf" | "otf")) {
        return Err(DescriptionError::FontFile(
            "extension must be .ttf or .otf".to_owned(),
        ));
    }
    match std::fs::metadata(&font.file) {
        Ok(metadata) if metadata.is_file() => {}
        Ok(_) => return Err(DescriptionError::FontFile("path is not a file".to_owned())),
        Err(error) => return Err(DescriptionError::FontFile(error.kind().to_string())),
    }
    let family_chars = font.family.chars().count();
    if !(1..=64).contains(&family_chars) || font.family.chars().any(char::is_control) {
        return Err(DescriptionError::FontFamily);
    }
    Ok(())
}

fn validate_layer(index: usize, layer: &Layer, limits: &Limits) -> Result<(), DescriptionError> {
    let max_side = f64::from(MAX_CANVAS_SIZE) * POSITION_MARGIN_CANVASES;
    let (fill, x, y, opacity) = match layer {
        Layer::Rect {
            width,
            height,
            corner_radius,
            fill,
            x,
            y,
            opacity,
        } => {
            let size_ok = |value: f64| value.is_finite() && value > 0.0 && value <= max_side;
            if !size_ok(*width)
                || !size_ok(*height)
                || !corner_radius.is_finite()
                || *corner_radius < 0.0
                || *corner_radius > width.min(*height) / 2.0
            {
                return Err(DescriptionError::Size { layer: index });
            }
            (fill, x, y, opacity)
        }
        Layer::Text {
            text,
            font_size,
            fill,
            x,
            y,
            opacity,
        } => {
            let chars = text.chars().count();
            if !(1..=MAX_TEXT_CHARS).contains(&chars) || text.chars().any(char::is_control) {
                return Err(DescriptionError::Text { layer: index });
            }
            if !font_size.is_finite() || *font_size < 1.0 || *font_size > 1000.0 {
                return Err(DescriptionError::Size { layer: index });
            }
            (fill, x, y, opacity)
        }
    };
    if parse_hex_color(fill).is_none() {
        return Err(DescriptionError::Color { layer: index });
    }
    let x_range =
        -limits.width * POSITION_MARGIN_CANVASES..=limits.width * (1.0 + POSITION_MARGIN_CANVASES);
    let y_range = -limits.height * POSITION_MARGIN_CANVASES
        ..=limits.height * (1.0 + POSITION_MARGIN_CANVASES);
    validate_track(index, "x", x, &x_range, limits.duration_frames)?;
    validate_track(index, "y", y, &y_range, limits.duration_frames)?;
    validate_track(
        index,
        "opacity",
        opacity,
        &(0.0..=1.0),
        limits.duration_frames,
    )
}

fn validate_track(
    layer: usize,
    property: &'static str,
    track: &Track,
    range: &std::ops::RangeInclusive<f64>,
    duration_frames: u32,
) -> Result<(), DescriptionError> {
    let error = |reason| {
        Err(DescriptionError::Track {
            layer,
            property,
            reason,
        })
    };
    if track.keyframes.is_empty() {
        return error("needs at least one keyframe");
    }
    if track.keyframes.len() > MAX_KEYFRAMES {
        return error("has too many keyframes");
    }
    let mut previous = None;
    for keyframe in &track.keyframes {
        if keyframe.frame >= duration_frames {
            return error("has a keyframe after the last frame");
        }
        if previous.is_some_and(|frame| keyframe.frame <= frame) {
            return error("keyframes must have strictly increasing frames");
        }
        if !keyframe.value.is_finite() || !range.contains(&keyframe.value) {
            return error("has a value out of range");
        }
        previous = Some(keyframe.frame);
    }
    Ok(())
}

/// `#RRGGBB` → (r, g, b). Only this exact form is accepted.
pub fn parse_hex_color(value: &str) -> Option<(u8, u8, u8)> {
    let hex = value.strip_prefix('#')?;
    if hex.len() != 6 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    let channel = |start| u8::from_str_radix(&hex[start..start + 2], 16).ok();
    Some((channel(0)?, channel(2)?, channel(4)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    fn font_file() -> PathBuf {
        PathBuf::from(r"C:\Windows\Fonts\arial.ttf")
    }

    fn valid() -> Value {
        json!({
            "schemaVersion": 1,
            "canvas": { "width": 1080, "height": 1920 },
            "frameRate": { "numerator": 30, "denominator": 1 },
            "durationFrames": 60,
            "font": { "file": font_file(), "family": "Arial" },
            "layers": [
                {
                    "kind": "rect", "width": 400.0, "height": 200.0, "cornerRadius": 24.0,
                    "fill": "#FF3355",
                    "x": { "keyframes": [
                        { "frame": 0, "value": 100.0, "easing": "easeInOut" },
                        { "frame": 59, "value": 580.0 }
                    ] },
                    "y": { "keyframes": [{ "frame": 0, "value": 300.0 }] },
                    "opacity": { "keyframes": [{ "frame": 0, "value": 1.0 }] }
                },
                {
                    "kind": "text", "text": "Hello", "fontSize": 96.0, "fill": "#ffffff",
                    "x": { "keyframes": [{ "frame": 0, "value": 120.0 }] },
                    "y": { "keyframes": [{ "frame": 0, "value": 900.0 }] },
                    "opacity": { "keyframes": [
                        { "frame": 0, "value": 0.0 },
                        { "frame": 15, "value": 1.0, "easing": "easeOut" }
                    ] }
                }
            ]
        })
    }

    fn parse(value: &Value) -> Result<GraphicsDescription, DescriptionError> {
        GraphicsDescription::parse(&serde_json::to_vec(value).unwrap())
    }

    fn with(mut value: Value, pointer: &str, replacement: Value) -> Value {
        *value.pointer_mut(pointer).unwrap() = replacement;
        value
    }

    #[cfg(windows)]
    #[test]
    fn accepts_a_valid_description() {
        let description = parse(&valid()).unwrap();

        assert_eq!(
            description.canvas,
            Canvas {
                width: 1080,
                height: 1920
            }
        );
        assert_eq!(description.layers.len(), 2);
        assert!(matches!(&description.layers[1], Layer::Text { text, .. } if text == "Hello"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_each_invalid_field() {
        let text = "x".repeat(MAX_TEXT_CHARS + 1);
        let too_many_layers = Value::Array(vec![valid()["layers"][0].clone(); MAX_LAYERS + 1]);
        type Case = (&'static str, Value, fn(&DescriptionError) -> bool);
        let cases: Vec<Case> = vec![
            ("schema", with(valid(), "/schemaVersion", json!(2)), |e| {
                matches!(e, DescriptionError::UnsupportedSchemaVersion(2))
            }),
            (
                "unknown field",
                with(
                    valid(),
                    "/canvas",
                    json!({"width": 2, "height": 2, "depth": 1}),
                ),
                |e| matches!(e, DescriptionError::Malformed(_)),
            ),
            (
                "wide canvas",
                with(valid(), "/canvas/width", json!(4098)),
                |e| matches!(e, DescriptionError::CanvasSize { .. }),
            ),
            (
                "odd canvas",
                with(valid(), "/canvas/height", json!(1919)),
                |e| matches!(e, DescriptionError::CanvasSize { .. }),
            ),
            (
                "zero fps",
                with(valid(), "/frameRate/denominator", json!(0)),
                |e| matches!(e, DescriptionError::FrameRate { .. }),
            ),
            (
                "long",
                with(valid(), "/durationFrames", json!(MAX_DURATION_FRAMES + 1)),
                |e| matches!(e, DescriptionError::Duration(_)),
            ),
            ("empty", with(valid(), "/durationFrames", json!(0)), |e| {
                matches!(e, DescriptionError::Duration(0))
            }),
            ("layers", with(valid(), "/layers", too_many_layers), |e| {
                matches!(e, DescriptionError::LayerCount(_))
            }),
            (
                "font missing",
                with(
                    valid(),
                    "/font/file",
                    json!(r"C:\Windows\Fonts\no-such-font.ttf"),
                ),
                |e| matches!(e, DescriptionError::FontFile(_)),
            ),
            (
                "font not ttf",
                with(valid(), "/font/file", json!(r"C:\Windows\notepad.exe")),
                |e| matches!(e, DescriptionError::FontFile(_)),
            ),
            (
                "font relative",
                with(valid(), "/font/file", json!("arial.ttf")),
                |e| matches!(e, DescriptionError::FontFile(_)),
            ),
            ("family", with(valid(), "/font/family", json!("")), |e| {
                matches!(e, DescriptionError::FontFamily)
            }),
            (
                "text long",
                with(valid(), "/layers/1/text", json!(text)),
                |e| matches!(e, DescriptionError::Text { layer: 1 }),
            ),
            (
                "text control",
                with(valid(), "/layers/1/text", json!("a\u{0007}b")),
                |e| matches!(e, DescriptionError::Text { layer: 1 }),
            ),
            (
                "color",
                with(valid(), "/layers/0/fill", json!("red")),
                |e| matches!(e, DescriptionError::Color { layer: 0 }),
            ),
            (
                "radius",
                with(valid(), "/layers/0/cornerRadius", json!(150.0)),
                |e| matches!(e, DescriptionError::Size { layer: 0 }),
            ),
            (
                "font size",
                with(valid(), "/layers/1/fontSize", json!(0.5)),
                |e| matches!(e, DescriptionError::Size { layer: 1 }),
            ),
            (
                "no keyframes",
                with(valid(), "/layers/0/y/keyframes", json!([])),
                |e| {
                    matches!(
                        e,
                        DescriptionError::Track {
                            layer: 0,
                            property: "y",
                            ..
                        }
                    )
                },
            ),
            (
                "order",
                with(valid(), "/layers/0/x/keyframes/1/frame", json!(0)),
                |e| {
                    matches!(
                        e,
                        DescriptionError::Track {
                            layer: 0,
                            property: "x",
                            ..
                        }
                    )
                },
            ),
            (
                "past end",
                with(valid(), "/layers/0/x/keyframes/1/frame", json!(60)),
                |e| {
                    matches!(
                        e,
                        DescriptionError::Track {
                            layer: 0,
                            property: "x",
                            ..
                        }
                    )
                },
            ),
            (
                "opacity",
                with(valid(), "/layers/1/opacity/keyframes/1/value", json!(1.5)),
                |e| {
                    matches!(
                        e,
                        DescriptionError::Track {
                            layer: 1,
                            property: "opacity",
                            ..
                        }
                    )
                },
            ),
            (
                "far away",
                with(valid(), "/layers/0/x/keyframes/0/value", json!(1.0e9)),
                |e| {
                    matches!(
                        e,
                        DescriptionError::Track {
                            layer: 0,
                            property: "x",
                            ..
                        }
                    )
                },
            ),
            (
                "easing",
                with(valid(), "/layers/0/x/keyframes/0/easing", json!("spring")),
                |e| matches!(e, DescriptionError::Malformed(_)),
            ),
            (
                "kind",
                with(valid(), "/layers/0/kind", json!("image")),
                |e| matches!(e, DescriptionError::Malformed(_)),
            ),
        ];

        for (name, input, expected) in cases {
            let error = parse(&input).expect_err(name);
            assert!(expected(&error), "{name}: unexpected {error:?}");
        }
    }

    #[test]
    fn rejects_oversized_input_before_parsing() {
        let bytes = vec![b' '; MAX_DESCRIPTION_BYTES + 1];

        let error = GraphicsDescription::parse(&bytes).unwrap_err();

        assert_eq!(
            error,
            DescriptionError::TooLarge {
                bytes: MAX_DESCRIPTION_BYTES + 1
            }
        );
    }

    #[test]
    fn parses_hex_colors_strictly() {
        let cases = [
            ("#ff3355", Some((255, 51, 85))),
            ("#FFFFFF", Some((255, 255, 255))),
            ("ff3355", None),
            ("#fff", None),
            ("#gg0000", None),
            ("#ff33551", None),
        ];
        for (input, expected) in cases {
            assert_eq!(parse_hex_color(input), expected, "{input}");
        }
    }
}
