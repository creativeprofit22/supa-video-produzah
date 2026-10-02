//! The fframes `Video` built from a validated graphics description.
//!
//! Keyframes are in frames of the description rate and every output frame is one description
//! frame, so tracks are sampled at `frame.index` with our own easing (`easing.rs`, the same math
//! as the TypeScript editor). fframes only turns the SVG into pixels; its `FPS` constant is
//! nominal. The canvas size comes from the description: the SVG root uses it as its viewBox and
//! frames are rendered at that size.

use std::sync::Arc;

use fframes::{AudioMap, Color, FFramesContext, Frame, Svgr, Video, usvgr::PreloadedImageData};

use crate::{
    description::{
        GraphicsDescription, Keyframe, Layer, MAX_IMAGE_SIDE, TextUnits, parse_hex_color,
        split_text,
    },
    easing::{CompiledTrack, SampleKey},
};

/// Nominal fframes frame rate; animation is sampled by frame index, not by this rate.
pub const NOMINAL_FPS: usize = 30;

pub struct GraphicsVideo {
    width: u32,
    height: u32,
    duration_frames: u32,
    font_family: String,
    layers: Vec<AnimatedLayer>,
}

struct AnimatedLayer {
    shape: Shape,
    width: f64,
    height: f64,
    x: CompiledTrack,
    y: CompiledTrack,
    scale: CompiledTrack,
    rotation: CompiledTrack,
    opacity: CompiledTrack,
}

enum Shape {
    Rect {
        corner_radius: f32,
        fill: String,
    },
    Text {
        font_size: f32,
        fill: String,
        content: TextContent,
    },
    Image(Arc<PreloadedImageData>),
}

enum TextContent {
    Plain(String),
    /// One span per reveal unit; each holds the unit and the spaces that follow it.
    Units(Vec<TextUnit>),
}

struct TextUnit {
    text: String,
    opacity: CompiledTrack,
    offset_y: CompiledTrack,
}

fn track(keys: &[Keyframe]) -> CompiledTrack {
    let keys: Vec<SampleKey> = keys
        .iter()
        .map(|key| SampleKey {
            time: key.frame,
            value: key.value,
            easing: key.easing.unwrap_or_default(),
        })
        .collect();
    CompiledTrack::new(&keys)
}

/// Spans covering the whole text: each unit plus the spaces after it (leading spaces join the
/// first unit), so the rendered line matches the plain text.
fn text_units(text: &str, units: &TextUnits) -> Vec<TextUnit> {
    let parts = split_text(text, units.split);
    let mut spans: Vec<String> = Vec::with_capacity(parts.len());
    let mut rest = text;
    for (index, part) in parts.iter().enumerate() {
        let start = rest.find(part).unwrap_or(0);
        let (before, after) = rest.split_at(start);
        let mut span = if index == 0 {
            before.to_owned()
        } else {
            String::new()
        };
        span.push_str(part);
        rest = &after[part.len()..];
        let spaces = rest.len() - rest.trim_start_matches(' ').len();
        span.push_str(&rest[..spaces]);
        rest = &rest[spaces..];
        spans.push(span);
    }
    spans
        .into_iter()
        .zip(units.opacity.iter().zip(&units.offset_y))
        .map(|(text, (opacity, offset_y))| TextUnit {
            text,
            opacity: track(opacity),
            offset_y: track(offset_y),
        })
        .collect()
}

impl GraphicsVideo {
    /// Builds the scene and decodes embedded images; errors are invalid input.
    pub fn new(description: &GraphicsDescription) -> Result<Self, String> {
        let images = description
            .image_bytes
            .iter()
            .enumerate()
            .map(|(index, bytes)| {
                let image = fframes::media::decode_image(&format!("image-{index}"), bytes)
                    .map_err(|error| format!("image {index} cannot be decoded: {error:?}"))?;
                if image.width == 0
                    || image.height == 0
                    || image.width > MAX_IMAGE_SIDE
                    || image.height > MAX_IMAGE_SIDE
                {
                    return Err(format!(
                        "image {index} is {}x{}; each side must be 1..={MAX_IMAGE_SIDE}",
                        image.width, image.height
                    ));
                }
                Ok(Arc::new(image))
            })
            .collect::<Result<Vec<_>, _>>()?;
        let layers = description
            .layers
            .iter()
            .map(|layer| {
                let (width, height) = layer.bounds();
                let shape = match layer {
                    Layer::Rect {
                        corner_radius,
                        fill,
                        ..
                    } => Shape::Rect {
                        corner_radius: *corner_radius as f32,
                        fill: normalized_fill(fill),
                    },
                    Layer::Text {
                        text,
                        font_size,
                        fill,
                        units,
                        ..
                    } => Shape::Text {
                        font_size: *font_size as f32,
                        fill: normalized_fill(fill),
                        content: match units {
                            Some(units) => TextContent::Units(text_units(text, units)),
                            None => TextContent::Plain(text.clone()),
                        },
                    },
                    Layer::Image { image, .. } => Shape::Image(Arc::clone(&images[*image])),
                };
                let tracks = layer.tracks();
                AnimatedLayer {
                    shape,
                    width,
                    height,
                    x: track(tracks.x),
                    y: track(tracks.y),
                    scale: track(tracks.scale),
                    rotation: track(tracks.rotation),
                    opacity: track(tracks.opacity),
                }
            })
            .collect();
        Ok(Self {
            width: description.canvas.width,
            height: description.canvas.height,
            duration_frames: description.duration_frames,
            font_family: description.font.family.clone(),
            layers,
        })
    }

    pub fn size(&self) -> (u32, u32) {
        (self.width, self.height)
    }

    pub fn duration_frames(&self) -> u32 {
        self.duration_frames
    }
}

/// Validated `#RRGGBB` re-emitted in one canonical form.
fn normalized_fill(fill: &str) -> String {
    let (r, g, b) = parse_hex_color(fill).expect("fill is validated by the description");
    format!("#{r:02x}{g:02x}{b:02x}")
}

/// `matrix(…)` placing a `width`×`height` box with its top-left at (x, y), scaled and rotated
/// (degrees, clockwise) around its center.
pub fn layer_matrix(x: f64, y: f64, width: f64, height: f64, scale: f64, rotation: f64) -> String {
    let (sin, cos) = rotation.to_radians().sin_cos();
    let (a, b, c, d) = (scale * cos, scale * sin, -scale * sin, scale * cos);
    let (half_width, half_height) = (width / 2.0, height / 2.0);
    let e = x + half_width - (a * half_width + c * half_height);
    let f = y + half_height - (b * half_width + d * half_height);
    let clean = |value: f64| {
        let rounded = (value * 1e6).round() / 1e6;
        if rounded == 0.0 { 0.0 } else { rounded }
    };
    format!(
        "matrix({} {} {} {} {} {})",
        clean(a),
        clean(b),
        clean(c),
        clean(d),
        clean(e),
        clean(f)
    )
}

impl Video for GraphicsVideo {
    const FPS: usize = NOMINAL_FPS;
    // Nominal only: frames are rendered at the description's canvas size.
    const WIDTH: usize = 1080;
    const HEIGHT: usize = 1920;
    const BACKGROUND_COLOR: Color = Color::TRANSPARENT;

    fn duration(&self) -> fframes::Duration<'_> {
        fframes::Duration::Frames(self.duration_frames as usize)
    }

    fn audio(&self) -> AudioMap<'_> {
        AudioMap::none()
    }

    fn render_frame<'a>(&'a self, frame: Frame, _ctx: &FFramesContext<'a, '_>) -> Svgr<'a> {
        let time = frame.index as f64;
        let layers: Vec<Svgr<'a>> = self
            .layers
            .iter()
            .map(|layer| self.render_layer(layer, time))
            .collect();
        let view_box = format!("0 0 {} {}", self.width, self.height);
        fframes::svgr!(
            <svg xmlns="http://www.w3.org/2000/svg" viewBox={view_box} width={self.width} height={self.height}>
                {layers}
            </svg>
        )
    }
}

impl GraphicsVideo {
    fn render_layer<'a>(&'a self, layer: &'a AnimatedLayer, time: f64) -> Svgr<'a> {
        let transform = layer_matrix(
            layer.x.sample(time),
            layer.y.sample(time),
            layer.width,
            layer.height,
            layer.scale.sample(time).max(0.0),
            layer.rotation.sample(time),
        );
        let opacity = layer.opacity.sample(time).clamp(0.0, 1.0) as f32;
        let (width, height) = (layer.width as f32, layer.height as f32);
        let body: Svgr<'a> = match &layer.shape {
            Shape::Rect {
                corner_radius,
                fill,
            } => {
                let fill = fill.as_str();
                fframes::svgr!(
                    <rect x={0.0} y={0.0} width={width} height={height} rx={*corner_radius}
                        fill={fill} />
                )
            }
            Shape::Text {
                font_size,
                fill,
                content,
            } => {
                let family = self.font_family.as_str();
                let fill = fill.as_str();
                match content {
                    TextContent::Plain(text) => {
                        let text = text.as_str();
                        fframes::svgr!(
                            <text x={0.0} y={0.0} dominant-baseline="text-before-edge"
                                font-family={family} font-size={*font_size} fill={fill}>
                                {text}
                            </text>
                        )
                    }
                    TextContent::Units(units) => {
                        let mut previous_offset = 0.0;
                        let spans: Vec<Svgr<'a>> = units
                            .iter()
                            .map(|unit| {
                                let offset = unit.offset_y.sample(time);
                                // `dy` is relative to the previous glyph, so emit the change.
                                let dy = (offset - previous_offset) as f32;
                                previous_offset = offset;
                                let unit_opacity = unit.opacity.sample(time).clamp(0.0, 1.0) as f32;
                                let text = unit.text.as_str();
                                fframes::svgr!(
                                    <tspan dy={dy} fill-opacity={unit_opacity}>{text}</tspan>
                                )
                            })
                            .collect();
                        fframes::svgr!(
                            <text x={0.0} y={0.0} dominant-baseline="text-before-edge"
                                font-family={family} font-size={*font_size} fill={fill}>
                                {spans}
                            </text>
                        )
                    }
                }
            }
            Shape::Image(image) => {
                let image = Arc::clone(image);
                fframes::svgr!(
                    <image href={image} x={0.0} y={0.0} width={width} height={height}
                        preserveAspectRatio="none" />
                )
            }
        };
        fframes::svgr!(
            <g transform={transform} opacity={opacity}>
                {body}
            </g>
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::description::TextSplit;

    #[test]
    fn layer_matrix_scales_and_rotates_around_the_center() {
        let cases = [
            // identity: plain translation
            ((10.0, 20.0, 100.0, 50.0, 1.0, 0.0), "matrix(1 0 0 1 10 20)"),
            // half scale keeps the center at (60, 45)
            (
                (10.0, 20.0, 100.0, 50.0, 0.5, 0.0),
                "matrix(0.5 0 0 0.5 35 32.5)",
            ),
            // 90° clockwise around (50, 25)
            (
                (0.0, 0.0, 100.0, 50.0, 1.0, 90.0),
                "matrix(0 1 -1 0 75 -25)",
            ),
        ];
        for ((x, y, w, h, s, r), expected) in cases {
            assert_eq!(layer_matrix(x, y, w, h, s, r), expected);
        }
    }

    #[test]
    fn text_units_cover_the_whole_text() {
        let hold = vec![Keyframe {
            frame: 0.0,
            value: 1.0,
            easing: None,
        }];
        for (text, split, expected) in [
            (
                " Hello  big world ",
                TextSplit::Word,
                vec![" Hello  ", "big ", "world "],
            ),
            ("Hi yo", TextSplit::Letter, vec!["H", "i ", "y", "o"]),
        ] {
            let count = expected.len();
            let units = TextUnits {
                split,
                opacity: vec![hold.clone(); count],
                offset_y: vec![hold.clone(); count],
            };
            let spans: Vec<String> = text_units(text, &units)
                .into_iter()
                .map(|unit| unit.text)
                .collect();
            assert_eq!(spans, expected, "{text:?}");
            assert_eq!(spans.concat(), text);
        }
    }
}
