//! Graphics clips: versioned, keyframed motion graphics on graphics tracks.
//! Mirrors `packages/video-contracts/src/project-graphics.ts`; see docs/adr/0003-graphics-clips.md.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};

use super::integrity::{is_canonical_uuid, trim_contract_text};
use crate::video::{
    error::{VideoCommandError, VideoErrorCode},
    types::{deserialize_optional_non_null, RationalTime},
};

pub const GRAPHICS_CLIP_VERSION: u32 = 1;
pub const MAX_GRAPHICS_LAYERS: usize = 64;
pub const MAX_GRAPHICS_KEYFRAMES: usize = 256;
pub const MAX_GRAPHICS_UNIT_KEYFRAMES: usize = 16;
pub const MAX_GRAPHICS_TEXT_CHARS: usize = 500;
pub const MAX_GRAPHICS_DURATION_FRAMES: u64 = 36_000;
pub const MAX_GRAPHICS_CLIPS_PER_TRACK: usize = 10_000;
pub const MAX_GRAPHICS_KEYFRAME_MICROSECONDS: u64 = 3_600_000_000;
pub const MAX_GRAPHICS_LAYER_SIDE: f64 = 16_384.0;
pub const MAX_GRAPHICS_POSITION: f64 = 32_768.0;
pub const MAX_GRAPHICS_SCALE: f64 = 100.0;
pub const MAX_GRAPHICS_ROTATION_DEGREES: f64 = 36_000.0;
pub const MAX_GRAPHICS_FONT_SIZE: f64 = 1_000.0;
pub const MAX_BEZIER_Y: f64 = 10.0;
pub const MAX_EASING_STEPS: u32 = 1_000;

/// A finite JSON number. Integral values serialize as integers so Rust and TypeScript write
/// identical JSON (and identical canonical hashes) for the same project.
#[derive(Debug, Clone, Copy, PartialEq, PartialOrd)]
pub struct GraphicsNumber(pub f64);

// Every stored value is finite (serde_json cannot produce NaN and validation rejects
// non-finite values), so equality is total.
impl Eq for GraphicsNumber {}

impl GraphicsNumber {
    pub fn get(self) -> f64 {
        self.0
    }
}

impl Serialize for GraphicsNumber {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        const MAX_EXACT: f64 = 9_007_199_254_740_991.0;
        let value = self.0;
        if value.fract() == 0.0 && value.abs() <= MAX_EXACT {
            serializer.serialize_i64(value as i64)
        } else {
            serializer.serialize_f64(value)
        }
    }
}

impl<'de> Deserialize<'de> for GraphicsNumber {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = f64::deserialize(deserializer)?;
        if value.is_finite() {
            Ok(Self(value))
        } else {
            Err(serde::de::Error::custom("graphics numbers must be finite"))
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphicsEasingPreset {
    EaseIn,
    EaseOut,
    EaseInOut,
    Gentle,
    Snappy,
    Bouncy,
    Strong,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GraphicsEasing {
    // Struct variant so `deny_unknown_fields` applies.
    Linear {},
    Preset {
        name: GraphicsEasingPreset,
    },
    CubicBezier {
        x1: GraphicsNumber,
        y1: GraphicsNumber,
        x2: GraphicsNumber,
        y2: GraphicsNumber,
    },
    #[serde(rename_all = "camelCase")]
    Spring {
        bounce: GraphicsNumber,
        duration_ms: u32,
    },
    #[serde(rename_all = "camelCase")]
    Steps {
        count: u32,
        #[serde(
            default,
            deserialize_with = "deserialize_optional_non_null",
            skip_serializing_if = "Option::is_none"
        )]
        from_start: Option<bool>,
    },
}

impl GraphicsEasing {
    pub fn is_valid(&self) -> bool {
        let unit = |value: GraphicsNumber| (0.0..=1.0).contains(&value.get());
        let bezier_y = |value: GraphicsNumber| value.get().abs() <= MAX_BEZIER_Y;
        match *self {
            Self::Linear {} | Self::Preset { .. } => true,
            Self::CubicBezier { x1, y1, x2, y2 } => {
                unit(x1) && unit(x2) && bezier_y(y1) && bezier_y(y2)
            }
            Self::Spring {
                bounce,
                duration_ms,
            } => (-1.0..=1.0).contains(&bounce.get()) && (10..=10_000).contains(&duration_ms),
            Self::Steps { count, .. } => (1..=MAX_EASING_STEPS).contains(&count),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphicsKeyframe {
    pub time_microseconds: u64,
    pub value: GraphicsNumber,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_non_null",
        skip_serializing_if = "Option::is_none"
    )]
    pub easing: Option<GraphicsEasing>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum GraphicsTextSplit {
    Word,
    Letter,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphicsTextUnits {
    pub split: GraphicsTextSplit,
    pub opacity: Vec<Vec<GraphicsKeyframe>>,
    pub offset_y: Vec<Vec<GraphicsKeyframe>>,
}

/// Words are maximal runs of non-space characters; letters are non-space characters.
pub fn split_graphics_text(text: &str, split: GraphicsTextSplit) -> Vec<String> {
    match split {
        GraphicsTextSplit::Word => text
            .split(' ')
            .filter(|word| !word.is_empty())
            .map(str::to_owned)
            .collect(),
        GraphicsTextSplit::Letter => text
            .chars()
            .filter(|character| *character != ' ')
            .map(String::from)
            .collect(),
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GraphicsLayer {
    #[serde(rename_all = "camelCase")]
    Rect {
        width: GraphicsNumber,
        height: GraphicsNumber,
        corner_radius: GraphicsNumber,
        fill: String,
        x: Vec<GraphicsKeyframe>,
        y: Vec<GraphicsKeyframe>,
        scale: Vec<GraphicsKeyframe>,
        rotation: Vec<GraphicsKeyframe>,
        opacity: Vec<GraphicsKeyframe>,
    },
    #[serde(rename_all = "camelCase")]
    Text {
        text: String,
        font_size: GraphicsNumber,
        fill: String,
        #[serde(
            default,
            deserialize_with = "deserialize_optional_non_null",
            skip_serializing_if = "Option::is_none"
        )]
        units: Option<GraphicsTextUnits>,
        x: Vec<GraphicsKeyframe>,
        y: Vec<GraphicsKeyframe>,
        scale: Vec<GraphicsKeyframe>,
        rotation: Vec<GraphicsKeyframe>,
        opacity: Vec<GraphicsKeyframe>,
    },
    #[serde(rename_all = "camelCase")]
    Image {
        asset_id: String,
        width: GraphicsNumber,
        height: GraphicsNumber,
        x: Vec<GraphicsKeyframe>,
        y: Vec<GraphicsKeyframe>,
        scale: Vec<GraphicsKeyframe>,
        rotation: Vec<GraphicsKeyframe>,
        opacity: Vec<GraphicsKeyframe>,
    },
}

/// The five keyframed properties every layer has, in a fixed order.
pub struct LayerTracks<'a> {
    pub x: &'a [GraphicsKeyframe],
    pub y: &'a [GraphicsKeyframe],
    pub scale: &'a [GraphicsKeyframe],
    pub rotation: &'a [GraphicsKeyframe],
    pub opacity: &'a [GraphicsKeyframe],
}

impl GraphicsLayer {
    pub fn tracks(&self) -> LayerTracks<'_> {
        match self {
            Self::Rect {
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
            } => LayerTracks {
                x,
                y,
                scale,
                rotation,
                opacity,
            },
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GraphicsClip {
    pub graphics_version: u32,
    pub id: String,
    pub timeline_start: RationalTime,
    pub duration: RationalTime,
    pub font_key: String,
    pub layers: Vec<GraphicsLayer>,
}

impl GraphicsClip {
    pub fn timeline_end(&self) -> Option<u64> {
        self.timeline_start.value.checked_add(self.duration.value)
    }
}

fn valid_track(keys: &[GraphicsKeyframe], low: f64, high: f64, max_keys: usize) -> bool {
    !keys.is_empty()
        && keys.len() <= max_keys
        && keys
            .windows(2)
            .all(|pair| pair[1].time_microseconds > pair[0].time_microseconds)
        && keys.iter().all(|key| {
            key.time_microseconds <= MAX_GRAPHICS_KEYFRAME_MICROSECONDS
                && (low..=high).contains(&key.value.get())
                && key.easing.as_ref().is_none_or(GraphicsEasing::is_valid)
        })
}

fn valid_tracks(tracks: &LayerTracks<'_>) -> bool {
    let full = MAX_GRAPHICS_KEYFRAMES;
    valid_track(
        tracks.x,
        -MAX_GRAPHICS_POSITION,
        MAX_GRAPHICS_POSITION,
        full,
    ) && valid_track(
        tracks.y,
        -MAX_GRAPHICS_POSITION,
        MAX_GRAPHICS_POSITION,
        full,
    ) && valid_track(tracks.scale, 0.0, MAX_GRAPHICS_SCALE, full)
        && valid_track(
            tracks.rotation,
            -MAX_GRAPHICS_ROTATION_DEGREES,
            MAX_GRAPHICS_ROTATION_DEGREES,
            full,
        )
        && valid_track(tracks.opacity, 0.0, 1.0, full)
}

fn valid_side(value: GraphicsNumber) -> bool {
    value.get() > 0.0 && value.get() <= MAX_GRAPHICS_LAYER_SIDE
}

pub(crate) fn valid_fill(fill: &str) -> bool {
    fill.len() == 7
        && fill.starts_with('#')
        && fill[1..].bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_text(text: &str) -> bool {
    let characters = text.chars().count();
    (1..=MAX_GRAPHICS_TEXT_CHARS).contains(&characters)
        && !text.chars().any(char::is_control)
        && !trim_contract_text(text).is_empty()
}

fn valid_units(text: &str, units: &GraphicsTextUnits) -> bool {
    let count = split_graphics_text(text, units.split).len();
    let unit_track = |keys: &Vec<GraphicsKeyframe>, low, high| {
        valid_track(keys, low, high, MAX_GRAPHICS_UNIT_KEYFRAMES)
    };
    units.opacity.len() == count
        && units.offset_y.len() == count
        && units.opacity.iter().all(|keys| unit_track(keys, 0.0, 1.0))
        && units
            .offset_y
            .iter()
            .all(|keys| unit_track(keys, -MAX_GRAPHICS_POSITION, MAX_GRAPHICS_POSITION))
}

/// Shape rules of one layer (not cross-entity references).
pub fn valid_graphics_layer(layer: &GraphicsLayer) -> bool {
    let shape = match layer {
        GraphicsLayer::Rect {
            width,
            height,
            corner_radius,
            fill,
            ..
        } => {
            valid_side(*width)
                && valid_side(*height)
                && corner_radius.get() >= 0.0
                && corner_radius.get() <= width.get().min(height.get()) / 2.0
                && valid_fill(fill)
        }
        GraphicsLayer::Text {
            text,
            font_size,
            fill,
            units,
            ..
        } => {
            valid_text(text)
                && (1.0..=MAX_GRAPHICS_FONT_SIZE).contains(&font_size.get())
                && valid_fill(fill)
                && units.as_ref().is_none_or(|units| valid_units(text, units))
        }
        GraphicsLayer::Image {
            asset_id,
            width,
            height,
            ..
        } => is_canonical_uuid(asset_id) && valid_side(*width) && valid_side(*height),
    };
    shape && valid_tracks(&layer.tracks())
}

/// Shape rules of a graphics clip (version, ids, times, font, layers).
pub fn valid_graphics_clip_shape(clip: &GraphicsClip) -> bool {
    clip.graphics_version == GRAPHICS_CLIP_VERSION
        && is_canonical_uuid(&clip.id)
        && super::integrity::valid_time_shape(&clip.timeline_start)
        && super::integrity::valid_time_shape(&clip.duration)
        && clip.timeline_start.rate_numerator == clip.duration.rate_numerator
        && clip.timeline_start.rate_denominator == clip.duration.rate_denominator
        && (1..=MAX_GRAPHICS_DURATION_FRAMES).contains(&clip.duration.value)
        && crate::video::caption_render::caption_font_file(&clip.font_key).is_some()
        && clip.layers.len() <= MAX_GRAPHICS_LAYERS
        && clip.layers.iter().all(valid_graphics_layer)
}

fn unsupported_graphics_version(version: &Value) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::UnsupportedSchema,
        "Graphics clip version is not supported by this version",
        json!({ "operation": "migrate_graphics_clip", "graphicsVersion": version }),
    )
}

fn invalid_graphics_clip(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        VideoErrorCode::InvalidProject,
        "Graphics clip failed validation",
        "migrate_graphics_clip",
        category,
    )
}

fn future_version(value: &Value) -> bool {
    value
        .as_u64()
        .is_some_and(|version| version > u64::from(GRAPHICS_CLIP_VERSION))
}

/// Brings a stored graphics clip to the current entity version. Version 1 is current; any other
/// positive integer version fails with `unsupported_schema`.
pub fn migrate_graphics_clip(value: &Value) -> Result<GraphicsClip, VideoCommandError> {
    let version = value.get("graphicsVersion").unwrap_or(&Value::Null);
    if future_version(version) {
        return Err(unsupported_graphics_version(version));
    }
    if version.as_u64() != Some(u64::from(GRAPHICS_CLIP_VERSION)) {
        return Err(invalid_graphics_clip("graphics_version"));
    }
    let clip: GraphicsClip =
        serde_json::from_value(value.clone()).map_err(|_| invalid_graphics_clip("schema"))?;
    if !valid_graphics_clip_shape(&clip) {
        return Err(invalid_graphics_clip("shape"));
    }
    Ok(clip)
}

/// Rejects a raw V2 snapshot that holds a graphics clip from a newer build, before strict
/// parsing reports it as a malformed project. Each clip goes through `migrate_graphics_clip`;
/// only its `unsupported_schema` failures are returned here, so malformed clips still surface
/// as `invalid_project` from the strict snapshot parse.
pub fn reject_future_graphics_versions(snapshot: &Value) -> Result<(), VideoCommandError> {
    let sequences = snapshot
        .pointer("/state/sequences")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    for sequence in sequences {
        let tracks = sequence
            .get("tracks")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice);
        for track in tracks {
            if track.get("kind").and_then(Value::as_str) != Some("graphics") {
                continue;
            }
            let clips = track
                .get("graphicsClips")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            for clip in clips {
                if let Err(error) = migrate_graphics_clip(clip) {
                    if error.code == VideoErrorCode::UnsupportedSchema {
                        return Err(error);
                    }
                }
            }
        }
    }
    Ok(())
}
