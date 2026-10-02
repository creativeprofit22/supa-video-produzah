//! Graphics description: the versioned JSON input of the renderer.
//!
//! Untrusted input is parsed with `deny_unknown_fields` and checked against fixed bounds before
//! any rendering happens; everything after `GraphicsDescription::parse` works with validated data.
//!
//! Schema 2 (docs/adr/0003-graphics-clips.md): every layer has `x`, `y`, `scale`, `rotation` and
//! `opacity` keyframe tracks with structured easing; keyframe frames may be fractional (they come
//! from microsecond times). `x`/`y` place the layer's top-left corner (text: the top of the first
//! line's `fontSize`-tall box); `scale` and `rotation` (degrees, clockwise) apply around the layer
//! center. Images are embedded as bounded `data:` URIs, so the renderer never opens other files.
//!
//! Text layers may carry an optional, non-empty `lineBreaks` array: byte offsets where each new
//! line starts, strictly ascending, strictly inside the text and on char boundaries; absent means
//! one line. Lines are drawn `TEXT_LINE_HEIGHT_EM` (1.2) font sizes apart. The scale/rotation
//! pivot box (`Layer::bounds`) is the longest line's estimated width (`TEXT_ADVANCE_EM` per char)
//! by `fontSize` plus one line pitch per extra line; the desktop's `video::text_boxes` mirrors it.
//! See docs/adr/0003-graphics-clips.md ("Text auto-fit (`lineBreaks`)").

use std::{fmt, path::PathBuf};

use serde::Deserialize;

use crate::easing::Easing;

pub const SCHEMA_VERSION: u32 = 2;
pub const MAX_CANVAS_SIZE: u32 = 4096;
pub const MAX_DURATION_FRAMES: u32 = 36_000;
pub const MAX_LAYERS: usize = 64;
pub const MAX_TEXT_CHARS: usize = 500;
pub const MAX_KEYFRAMES: usize = 256;
pub const MAX_UNIT_KEYFRAMES: usize = 16;
pub const MAX_FRAME_RATE: u32 = 240;
/// One hour at the maximum frame rate: keyframes may sit past the end but are never reached.
pub const MAX_KEYFRAME_FRAME: f64 = 864_000.0;
pub const MAX_IMAGES: usize = 16;
pub const MAX_IMAGE_SIDE: u32 = 4096;
pub const MAX_IMAGE_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_TOTAL_IMAGE_BYTES: usize = 40 * 1024 * 1024;
pub const MAX_DESCRIPTION_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_SCALE: f64 = 100.0;
pub const MAX_ROTATION_DEGREES: f64 = 36_000.0;
pub const MAX_FONT_SIZE: f64 = 1_000.0;
/// Text box width estimate until real glyph layout exists: 0.55 em per character. Shared with
/// the TypeScript presets (`graphicsLayerBounds`) so scale and rotation pivot on the same center.
pub const TEXT_ADVANCE_EM: f64 = 0.55;
/// Line pitch of wrapped text, in font sizes (the desktop's `text_layout::LINE_HEIGHT_RATIO`).
pub const TEXT_LINE_HEIGHT_EM: f64 = 1.2;
/// Position and unit offset bound in pixels, the same as the project's graphics clips, so every
/// valid project clip yields a valid description.
pub const MAX_POSITION: f64 = 32_768.0;
/// Layer side bound in pixels, the same as the project's graphics clips.
pub const MAX_LAYER_SIDE: f64 = 16_384.0;

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphicsDescription {
    pub schema_version: u32,
    pub canvas: Canvas,
    pub frame_rate: FrameRate,
    pub duration_frames: u32,
    pub font: FontSpec,
    #[serde(default)]
    pub images: Vec<EmbeddedImage>,
    pub layers: Vec<Layer>,
    /// Container bytes of `images`, decoded during validation.
    #[serde(skip)]
    pub image_bytes: Vec<Vec<u8>>,
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

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct EmbeddedImage {
    /// `data:image/png;base64,…` or `data:image/jpeg;base64,…`.
    pub data: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TextSplit {
    Word,
    Letter,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TextUnits {
    pub split: TextSplit,
    /// One track per unit, multiplied with the layer opacity.
    pub opacity: Vec<Vec<Keyframe>>,
    /// One track per unit, added to the layer y in pixels.
    pub offset_y: Vec<Vec<Keyframe>>,
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
        x: Vec<Keyframe>,
        y: Vec<Keyframe>,
        scale: Vec<Keyframe>,
        rotation: Vec<Keyframe>,
        opacity: Vec<Keyframe>,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        font_size: f64,
        fill: String,
        #[serde(default)]
        units: Option<TextUnits>,
        /// Byte offsets where a new line starts (auto-fit wrapping); absent = one line.
        #[serde(default)]
        line_breaks: Option<Vec<usize>>,
        x: Vec<Keyframe>,
        y: Vec<Keyframe>,
        scale: Vec<Keyframe>,
        rotation: Vec<Keyframe>,
        opacity: Vec<Keyframe>,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        /// Index into `images`.
        image: usize,
        width: f64,
        height: f64,
        x: Vec<Keyframe>,
        y: Vec<Keyframe>,
        scale: Vec<Keyframe>,
        rotation: Vec<Keyframe>,
        opacity: Vec<Keyframe>,
    },
}

/// The five keyframed properties every layer has.
pub struct LayerTracks<'a> {
    pub x: &'a [Keyframe],
    pub y: &'a [Keyframe],
    pub scale: &'a [Keyframe],
    pub rotation: &'a [Keyframe],
    pub opacity: &'a [Keyframe],
}

impl Layer {
    pub fn tracks(&self) -> LayerTracks<'_> {
        let (Self::Rect {
            x,
            y,
            scale,
            rotation,
            opacity,
            ..
        }
        | Self::Text {
            x,
            y,
            scale,
            rotation,
            opacity,
            ..
        }
        | Self::Image {
            x,
            y,
            scale,
            rotation,
            opacity,
            ..
        }) = self;
        LayerTracks {
            x,
            y,
            scale,
            rotation,
            opacity,
        }
    }

    /// Width and height used for the scale/rotation pivot (text: the estimated box of the
    /// longest line, one font size tall plus one line height per extra line).
    pub fn bounds(&self) -> (f64, f64) {
        match self {
            Self::Rect { width, height, .. } | Self::Image { width, height, .. } => {
                (*width, *height)
            }
            Self::Text {
                text,
                font_size,
                line_breaks,
                ..
            } => {
                let lines = text_lines(text, line_breaks.as_deref().unwrap_or_default());
                let longest = lines
                    .iter()
                    .map(|line| text[line.clone()].chars().count())
                    .max()
                    .unwrap_or(0);
                (
                    (longest as f64 * TEXT_ADVANCE_EM * font_size).max(1.0),
                    font_size + (lines.len() - 1) as f64 * TEXT_LINE_HEIGHT_EM * font_size,
                )
            }
        }
    }
}

/// Byte ranges of each line of `text` split at validated `line_breaks` (always at least one).
pub fn text_lines(text: &str, line_breaks: &[usize]) -> Vec<std::ops::Range<usize>> {
    let mut start = 0;
    line_breaks
        .iter()
        .copied()
        .chain([text.len()])
        .map(|end| {
            let line = start..end;
            start = end;
            line
        })
        .collect()
}

/// Words are maximal runs of non-space characters; letters are non-space characters. Matches
/// `splitGraphicsText` in `packages/video-contracts`.
pub fn split_text(text: &str, split: TextSplit) -> Vec<&str> {
    match split {
        TextSplit::Word => text.split(' ').filter(|word| !word.is_empty()).collect(),
        TextSplit::Letter => text
            .char_indices()
            .filter(|(_, character)| *character != ' ')
            .map(|(index, character)| &text[index..index + character.len_utf8()])
            .collect(),
    }
}

/// A keyframe at a (possibly fractional) frame of the description rate.
#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Keyframe {
    pub frame: f64,
    pub value: f64,
    /// Easing of the segment from this keyframe to the next; absent = linear.
    #[serde(default)]
    pub easing: Option<Easing>,
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
    Image {
        index: usize,
        reason: &'static str,
    },
    ImageReference {
        layer: usize,
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
                "layer {layer}: text must be 1..={MAX_TEXT_CHARS} characters without control characters, with matching unit tracks"
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
            Self::Image { index, reason } => write!(f, "image {index}: {reason}"),
            Self::ImageReference { layer } => {
                write!(f, "layer {layer}: image index does not exist")
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
        let mut description: Self = serde_json::from_slice(bytes)
            .map_err(|error| DescriptionError::Malformed(error.to_string()))?;
        description.validate()?;
        description.image_bytes = decode_images(&description.images)?;
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
        if self.images.len() > MAX_IMAGES {
            return Err(DescriptionError::Image {
                index: MAX_IMAGES,
                reason: "too many images",
            });
        }
        validate_font(&self.font)?;
        let limits = Limits {
            images: self.images.len(),
        };
        for (index, layer) in self.layers.iter().enumerate() {
            validate_layer(index, layer, &limits)?;
        }
        Ok(())
    }
}

struct Limits {
    images: usize,
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
    let size_ok = |value: f64| value.is_finite() && value > 0.0 && value <= MAX_LAYER_SIDE;
    let position_range = -MAX_POSITION..=MAX_POSITION;
    match layer {
        Layer::Rect {
            width,
            height,
            corner_radius,
            fill,
            ..
        } => {
            if !size_ok(*width)
                || !size_ok(*height)
                || !corner_radius.is_finite()
                || *corner_radius < 0.0
                || *corner_radius > width.min(*height) / 2.0
            {
                return Err(DescriptionError::Size { layer: index });
            }
            if parse_hex_color(fill).is_none() {
                return Err(DescriptionError::Color { layer: index });
            }
        }
        Layer::Text {
            text,
            font_size,
            fill,
            units,
            line_breaks,
            ..
        } => {
            let chars = text.chars().count();
            if !(1..=MAX_TEXT_CHARS).contains(&chars)
                || text.chars().any(char::is_control)
                || text.trim().is_empty()
            {
                return Err(DescriptionError::Text { layer: index });
            }
            if !font_size.is_finite() || *font_size < 1.0 || *font_size > MAX_FONT_SIZE {
                return Err(DescriptionError::Size { layer: index });
            }
            if parse_hex_color(fill).is_none() {
                return Err(DescriptionError::Color { layer: index });
            }
            if line_breaks
                .as_deref()
                .is_some_and(|breaks| !valid_line_breaks(text, breaks))
            {
                return Err(DescriptionError::Text { layer: index });
            }
            if let Some(units) = units {
                let count = split_text(text, units.split).len();
                if units.opacity.len() != count || units.offset_y.len() != count {
                    return Err(DescriptionError::Text { layer: index });
                }
                for track in &units.opacity {
                    validate_track(
                        index,
                        "unit opacity",
                        track,
                        &(0.0..=1.0),
                        MAX_UNIT_KEYFRAMES,
                    )?;
                }
                for track in &units.offset_y {
                    validate_track(
                        index,
                        "unit offsetY",
                        track,
                        &position_range,
                        MAX_UNIT_KEYFRAMES,
                    )?;
                }
            }
        }
        Layer::Image {
            image,
            width,
            height,
            ..
        } => {
            if !size_ok(*width) || !size_ok(*height) {
                return Err(DescriptionError::Size { layer: index });
            }
            if *image >= limits.images {
                return Err(DescriptionError::ImageReference { layer: index });
            }
        }
    }
    let tracks = layer.tracks();
    validate_track(index, "x", tracks.x, &position_range, MAX_KEYFRAMES)?;
    validate_track(index, "y", tracks.y, &position_range, MAX_KEYFRAMES)?;
    validate_track(
        index,
        "scale",
        tracks.scale,
        &(0.0..=MAX_SCALE),
        MAX_KEYFRAMES,
    )?;
    validate_track(
        index,
        "rotation",
        tracks.rotation,
        &(-MAX_ROTATION_DEGREES..=MAX_ROTATION_DEGREES),
        MAX_KEYFRAMES,
    )?;
    validate_track(
        index,
        "opacity",
        tracks.opacity,
        &(0.0..=1.0),
        MAX_KEYFRAMES,
    )
}

/// Line breaks are strictly ascending byte offsets strictly inside `text`, on char boundaries,
/// at most one per character.
fn valid_line_breaks(text: &str, breaks: &[usize]) -> bool {
    !breaks.is_empty()
        && breaks.len() < MAX_TEXT_CHARS
        && breaks.windows(2).all(|pair| pair[0] < pair[1])
        && breaks
            .iter()
            .all(|offset| *offset > 0 && *offset < text.len() && text.is_char_boundary(*offset))
}

fn validate_track(
    layer: usize,
    property: &'static str,
    track: &[Keyframe],
    range: &std::ops::RangeInclusive<f64>,
    max_keyframes: usize,
) -> Result<(), DescriptionError> {
    let error = |reason| {
        Err(DescriptionError::Track {
            layer,
            property,
            reason,
        })
    };
    if track.is_empty() {
        return error("needs at least one keyframe");
    }
    if track.len() > max_keyframes {
        return error("has too many keyframes");
    }
    let mut previous: Option<f64> = None;
    for keyframe in track {
        if !keyframe.frame.is_finite() || !(0.0..=MAX_KEYFRAME_FRAME).contains(&keyframe.frame) {
            return error("has a keyframe outside 0..=864000 frames");
        }
        if previous.is_some_and(|frame| keyframe.frame <= frame) {
            return error("keyframes must have strictly increasing frames");
        }
        if !keyframe.value.is_finite() || !range.contains(&keyframe.value) {
            return error("has a value out of range");
        }
        if keyframe.easing.is_some_and(|easing| !easing.is_valid()) {
            return error("has an easing out of range");
        }
        previous = Some(keyframe.frame);
    }
    Ok(())
}

/// Decodes each `data:` URI to container bytes and checks the PNG/JPEG signature and limits.
/// Pixel decoding (and the 4096 px bound) happens in the renderer with the decoder's own limits.
fn decode_images(images: &[EmbeddedImage]) -> Result<Vec<Vec<u8>>, DescriptionError> {
    let mut total = 0_usize;
    images
        .iter()
        .enumerate()
        .map(|(index, image)| {
            let error = |reason| DescriptionError::Image { index, reason };
            let (mime, payload) = image
                .data
                .strip_prefix("data:image/png;base64,")
                .map(|payload| ("png", payload))
                .or_else(|| {
                    image
                        .data
                        .strip_prefix("data:image/jpeg;base64,")
                        .map(|payload| ("jpeg", payload))
                })
                .ok_or_else(|| error("must be a data:image/png or data:image/jpeg base64 URI"))?;
            if payload.len() / 4 * 3 > MAX_IMAGE_BYTES {
                return Err(error("is larger than 32 MB"));
            }
            let bytes = decode_base64(payload).ok_or_else(|| error("is not valid base64"))?;
            total = total.saturating_add(bytes.len());
            if bytes.len() > MAX_IMAGE_BYTES || total > MAX_TOTAL_IMAGE_BYTES {
                return Err(error("is larger than the image byte limit"));
            }
            let signature_ok = match mime {
                "png" => bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]),
                _ => bytes.starts_with(&[0xFF, 0xD8, 0xFF]),
            };
            if !signature_ok {
                return Err(error("bytes do not match the declared image type"));
            }
            Ok(bytes)
        })
        .collect()
}

/// Strict standard base64 (RFC 4648 §4) with `=` padding; no whitespace.
pub fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let bytes = input.as_bytes();
    if bytes.is_empty() || !bytes.len().is_multiple_of(4) {
        return None;
    }
    let value = |byte: u8| -> Option<u32> {
        Some(u32::from(match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return None,
        }))
    };
    let mut output = Vec::with_capacity(bytes.len() / 4 * 3);
    let chunks = bytes.len() / 4;
    for (index, chunk) in bytes.chunks_exact(4).enumerate() {
        let last = index + 1 == chunks;
        let padding = match (chunk[2], chunk[3]) {
            (b'=', b'=') if last => 2,
            (_, b'=') if last => 1,
            _ => 0,
        };
        let mut word = 0_u32;
        for &byte in &chunk[..4 - padding] {
            word = (word << 6) | value(byte)?;
        }
        word <<= 6 * padding as u32;
        let decoded = word.to_be_bytes();
        output.extend_from_slice(&decoded[1..4 - padding]);
        // Non-canonical trailing bits are rejected so each input has exactly one meaning.
        if padding > 0 && decoded[4 - padding] != 0 {
            return None;
        }
    }
    Some(output)
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

    fn hold(value: f64) -> Value {
        json!([{ "frame": 0, "value": value }])
    }

    /// A PNG signature followed by filler: enough for description validation (pixels are decoded
    /// by the renderer).
    const PNG_URI: &str = "data:image/png;base64,iVBORw0KGgoAAAA=";

    fn valid() -> Value {
        json!({
            "schemaVersion": 2,
            "canvas": { "width": 1080, "height": 1920 },
            "frameRate": { "numerator": 30, "denominator": 1 },
            "durationFrames": 60,
            "font": { "file": font_file(), "family": "Arial" },
            "images": [{ "data": PNG_URI }],
            "layers": [
                {
                    "kind": "rect", "width": 400.0, "height": 200.0, "cornerRadius": 24.0,
                    "fill": "#FF3355",
                    "x": [
                        { "frame": 0, "value": 100.0, "easing": { "kind": "preset", "name": "easeInOut" } },
                        { "frame": 59.5, "value": 580.0 }
                    ],
                    "y": hold(300.0),
                    "scale": [
                        { "frame": 0, "value": 0.5, "easing": { "kind": "spring", "bounce": 0.4, "durationMs": 500 } },
                        { "frame": 20, "value": 1.0 }
                    ],
                    "rotation": [
                        { "frame": 0, "value": -20.0, "easing": { "kind": "steps", "count": 4 } },
                        { "frame": 12, "value": 0.0 }
                    ],
                    "opacity": hold(1.0)
                },
                {
                    "kind": "text", "text": "Hello big world", "fontSize": 96.0, "fill": "#ffffff",
                    "units": {
                        "split": "word",
                        "opacity": [hold(1.0), [{ "frame": 0, "value": 0.0 }, { "frame": 10, "value": 1.0 }], hold(1.0)],
                        "offsetY": [hold(0.0), hold(0.0), [{ "frame": 0, "value": 40.0 }, { "frame": 10, "value": 0.0 }]]
                    },
                    "x": hold(120.0),
                    "y": hold(900.0),
                    "scale": hold(1.0),
                    "rotation": hold(0.0),
                    "opacity": [
                        { "frame": 0, "value": 0.0, "easing": { "kind": "cubicBezier", "x1": 0.34, "y1": 1.56, "x2": 0.64, "y2": 1.0 } },
                        { "frame": 15, "value": 1.0 }
                    ]
                },
                {
                    "kind": "image", "image": 0, "width": 256.0, "height": 128.0,
                    "x": hold(10.0), "y": hold(10.0), "scale": hold(1.0), "rotation": hold(45.0),
                    "opacity": hold(0.5)
                }
            ]
        })
    }

    fn track(error: &DescriptionError, layer: usize, property: &str) -> bool {
        matches!(error, DescriptionError::Track { layer: l, property: p, .. } if *l == layer && *p == property)
    }

    fn parse(value: &Value) -> Result<GraphicsDescription, DescriptionError> {
        GraphicsDescription::parse(&serde_json::to_vec(value).unwrap())
    }

    fn with(mut value: Value, pointer: &str, replacement: Value) -> Value {
        *value.pointer_mut(pointer).unwrap() = replacement;
        value
    }

    fn with_line_breaks(mut value: Value, breaks: Value) -> Value {
        value["layers"][1]["lineBreaks"] = breaks;
        value
    }

    #[cfg(windows)]
    #[test]
    fn accepts_line_breaks_and_widens_the_pivot_box() {
        // "Hello big world": lines "Hello " / "big " / "world".
        let description = parse(&with_line_breaks(valid(), json!([6, 10]))).unwrap();
        let layer = &description.layers[1];
        assert!(matches!(layer, Layer::Text { line_breaks: Some(b), .. } if b == &[6, 10]));
        let (width, height) = layer.bounds();
        assert!((width - 6.0 * TEXT_ADVANCE_EM * 96.0).abs() < 1e-9);
        assert!((height - (96.0 + 2.0 * TEXT_LINE_HEIGHT_EM * 96.0)).abs() < 1e-9);
        // Without breaks the pivot is the single-line box, as before.
        let single = parse(&valid()).unwrap();
        assert_eq!(
            single.layers[1].bounds(),
            (15.0 * TEXT_ADVANCE_EM * 96.0, 96.0)
        );
    }

    #[cfg(windows)]
    #[test]
    fn rejects_invalid_line_breaks() {
        let plain_cafe = with(
            with(valid(), "/layers/1/units", Value::Null),
            "/layers/1/text",
            json!("café au lait"),
        );
        let cases = [
            ("empty", with_line_breaks(valid(), json!([]))),
            ("at start", with_line_breaks(valid(), json!([0]))),
            ("at end", with_line_breaks(valid(), json!([15]))),
            ("past end", with_line_breaks(valid(), json!([99]))),
            ("descending", with_line_breaks(valid(), json!([10, 6]))),
            ("repeated", with_line_breaks(valid(), json!([6, 6]))),
            ("inside a char", with_line_breaks(plain_cafe, json!([4]))),
        ];
        for (name, value) in cases {
            assert!(
                matches!(parse(&value), Err(DescriptionError::Text { layer: 1 })),
                "{name}"
            );
        }
        assert!(matches!(
            parse(&with_line_breaks(valid(), json!([-1]))),
            Err(DescriptionError::Malformed(_))
        ));
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
        assert_eq!(description.layers.len(), 3);
        assert!(
            matches!(&description.layers[1], Layer::Text { text, units: Some(_), .. } if text == "Hello big world")
        );
        assert_eq!(description.image_bytes.len(), 1);
        assert!(description.image_bytes[0].starts_with(b"\x89PNG"));
    }

    #[cfg(windows)]
    #[test]
    fn rejects_each_invalid_field() {
        let text = "x".repeat(MAX_TEXT_CHARS + 1);
        let too_many_layers = Value::Array(vec![valid()["layers"][0].clone(); MAX_LAYERS + 1]);
        type Case = (&'static str, Value, fn(&DescriptionError) -> bool);
        let cases: Vec<Case> = vec![
            ("schema 1", with(valid(), "/schemaVersion", json!(1)), |e| {
                matches!(e, DescriptionError::UnsupportedSchemaVersion(1))
            }),
            ("schema 3", with(valid(), "/schemaVersion", json!(3)), |e| {
                matches!(e, DescriptionError::UnsupportedSchemaVersion(3))
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
                with(
                    with(valid(), "/layers/1/units", Value::Null),
                    "/layers/1/text",
                    json!(text),
                ),
                |e| matches!(e, DescriptionError::Text { layer: 1 }),
            ),
            (
                "text control",
                with(
                    with(valid(), "/layers/1/units", Value::Null),
                    "/layers/1/text",
                    json!("a\u{0007}b"),
                ),
                |e| matches!(e, DescriptionError::Text { layer: 1 }),
            ),
            (
                "unit count",
                with(valid(), "/layers/1/text", json!("Hello world")),
                |e| matches!(e, DescriptionError::Text { layer: 1 }),
            ),
            (
                "unit opacity",
                with(valid(), "/layers/1/units/opacity/1/1/value", json!(2.0)),
                |e| {
                    matches!(
                        e,
                        DescriptionError::Track {
                            layer: 1,
                            property: "unit opacity",
                            ..
                        }
                    )
                },
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
                "image size",
                with(valid(), "/layers/2/width", json!(0.0)),
                |e| matches!(e, DescriptionError::Size { layer: 2 }),
            ),
            (
                "image reference",
                with(valid(), "/layers/2/image", json!(1)),
                |e| matches!(e, DescriptionError::ImageReference { layer: 2 }),
            ),
            (
                "no keyframes",
                with(valid(), "/layers/0/y", json!([])),
                |e| track(e, 0, "y"),
            ),
            (
                "order",
                with(valid(), "/layers/0/x/1/frame", json!(0)),
                |e| track(e, 0, "x"),
            ),
            (
                "negative frame",
                with(valid(), "/layers/0/x/0/frame", json!(-1)),
                |e| track(e, 0, "x"),
            ),
            (
                "opacity",
                with(valid(), "/layers/1/opacity/1/value", json!(1.5)),
                |e| track(e, 1, "opacity"),
            ),
            (
                "negative scale",
                with(valid(), "/layers/0/scale/1/value", json!(-1.0)),
                |e| track(e, 0, "scale"),
            ),
            (
                "rotation",
                with(valid(), "/layers/0/rotation/0/value", json!(1.0e6)),
                |e| track(e, 0, "rotation"),
            ),
            (
                "far away",
                with(valid(), "/layers/0/x/0/value", json!(1.0e9)),
                |e| track(e, 0, "x"),
            ),
            (
                "spring bounce",
                with(valid(), "/layers/0/scale/0/easing/bounce", json!(2.0)),
                |e| track(e, 0, "scale"),
            ),
            (
                "zero steps",
                with(valid(), "/layers/0/rotation/0/easing/count", json!(0)),
                |e| track(e, 0, "rotation"),
            ),
            (
                "string easing",
                with(valid(), "/layers/0/x/0/easing", json!("easeIn")),
                |e| matches!(e, DescriptionError::Malformed(_)),
            ),
            (
                "kind",
                with(valid(), "/layers/0/kind", json!("video")),
                |e| matches!(e, DescriptionError::Malformed(_)),
            ),
            (
                "image url",
                with(
                    valid(),
                    "/images/0/data",
                    json!("https://example.com/a.png"),
                ),
                |e| matches!(e, DescriptionError::Image { index: 0, .. }),
            ),
            (
                "image svg",
                with(
                    valid(),
                    "/images/0/data",
                    json!("data:image/svg+xml;base64,PHN2Zy8+"),
                ),
                |e| matches!(e, DescriptionError::Image { index: 0, .. }),
            ),
            (
                "image bad base64",
                with(
                    valid(),
                    "/images/0/data",
                    json!("data:image/png;base64,iVBOR w0K"),
                ),
                |e| matches!(e, DescriptionError::Image { index: 0, .. }),
            ),
            (
                "image disguised",
                with(
                    valid(),
                    "/images/0/data",
                    json!("data:image/jpeg;base64,iVBORw0KGgoAAAA="),
                ),
                |e| matches!(e, DescriptionError::Image { index: 0, .. }),
            ),
            (
                "too many images",
                with(
                    valid(),
                    "/images",
                    Value::Array(vec![json!({ "data": PNG_URI }); MAX_IMAGES + 1]),
                ),
                |e| matches!(e, DescriptionError::Image { .. }),
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

    #[test]
    fn decodes_base64_strictly() {
        let cases: [(&str, Option<&[u8]>); 9] = [
            ("TWFu", Some(b"Man")),
            ("TWE=", Some(b"Ma")),
            ("TQ==", Some(b"M")),
            ("/+8=", Some(&[0xFF, 0xEF])),
            ("", None),
            ("TWF", None),
            ("TW=u", None),
            ("TR==", None), // non-zero trailing bits
            ("TWFu\n", None),
        ];
        for (input, expected) in cases {
            assert_eq!(decode_base64(input).as_deref(), expected, "{input:?}");
        }
    }

    #[test]
    fn splits_words_and_letters_like_the_project_model() {
        assert_eq!(
            split_text(" Hello  big world ", TextSplit::Word),
            ["Hello", "big", "world"]
        );
        assert_eq!(split_text("Hé yo", TextSplit::Letter), ["H", "é", "y", "o"]);
    }
}
