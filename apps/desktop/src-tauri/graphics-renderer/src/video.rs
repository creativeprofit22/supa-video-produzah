//! The fframes `Video` built from a validated graphics description.
//!
//! fframes fixes `FPS`, `WIDTH` and `HEIGHT` at compile time. Keyframes are addressed by frame
//! index, so animation runs on a fixed internal time base (`ANIMATION_FPS`) and is exact for any
//! output frame rate; the real frame rate only matters to the encoder. The canvas size comes
//! from the description: the SVG root uses it as its viewBox and frames are rendered at that size.

use fframes::{
    AudioMap, Color, FFramesContext, Frame, Svgr, Video,
    animation::{Easing as FfEasing, KeyFrame, KeyFramesAnimation},
};

use crate::description::{Easing, GraphicsDescription, Layer, Track, parse_hex_color};

/// Internal animation time base; one animation "second" is this many frames.
pub const ANIMATION_FPS: usize = 30;

pub struct GraphicsVideo {
    width: u32,
    height: u32,
    duration_frames: u32,
    font_family: String,
    layers: Vec<AnimatedLayer>,
}

struct AnimatedLayer {
    shape: Shape,
    fill: String,
    x: Value,
    y: Value,
    opacity: Value,
}

enum Shape {
    Rect {
        width: f32,
        height: f32,
        corner_radius: f32,
    },
    Text {
        text: String,
        font_size: f32,
    },
}

enum Value {
    Constant(f32),
    Animated(KeyFramesAnimation<f32>),
}

impl Value {
    fn from_track(track: &Track) -> Self {
        let keyframes = &track.keyframes;
        if keyframes.len() == 1 {
            return Self::Constant(keyframes[0].value as f32);
        }
        let seconds = |frame: u32| frame as f32 / ANIMATION_FPS as f32;
        // Every segment gets an explicit end: fframes drops a final tween without one.
        let tweens = keyframes
            .windows(2)
            .map(|pair| KeyFrame {
                start: seconds(pair[0].frame),
                end: Some(seconds(pair[1].frame)),
                from: pair[0].value as f32,
                to: pair[1].value as f32,
                easing: easing(pair[0].easing),
            })
            .collect();
        Self::Animated(KeyFramesAnimation::new(tweens))
    }

    fn at(&self, frame: &Frame) -> f32 {
        match self {
            Self::Constant(value) => *value,
            Self::Animated(animation) => frame.animate(animation),
        }
    }
}

fn easing(easing: Easing) -> &'static FfEasing {
    match easing {
        Easing::Linear => &FfEasing::Linear,
        Easing::EaseIn => &FfEasing::EaseIn,
        Easing::EaseOut => &FfEasing::EaseOut,
        Easing::EaseInOut => &FfEasing::EaseInOut,
    }
}

impl GraphicsVideo {
    pub fn new(description: &GraphicsDescription) -> Self {
        let layers = description
            .layers
            .iter()
            .map(|layer| match layer {
                Layer::Rect {
                    width,
                    height,
                    corner_radius,
                    fill,
                    x,
                    y,
                    opacity,
                } => AnimatedLayer {
                    shape: Shape::Rect {
                        width: *width as f32,
                        height: *height as f32,
                        corner_radius: *corner_radius as f32,
                    },
                    fill: normalized_fill(fill),
                    x: Value::from_track(x),
                    y: Value::from_track(y),
                    opacity: Value::from_track(opacity),
                },
                Layer::Text {
                    text,
                    font_size,
                    fill,
                    x,
                    y,
                    opacity,
                } => AnimatedLayer {
                    shape: Shape::Text {
                        text: text.clone(),
                        font_size: *font_size as f32,
                    },
                    fill: normalized_fill(fill),
                    x: Value::from_track(x),
                    y: Value::from_track(y),
                    opacity: Value::from_track(opacity),
                },
            })
            .collect();
        Self {
            width: description.canvas.width,
            height: description.canvas.height,
            duration_frames: description.duration_frames,
            font_family: description.font.family.clone(),
            layers,
        }
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

impl Video for GraphicsVideo {
    const FPS: usize = ANIMATION_FPS;
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
        let layers: Vec<Svgr<'a>> = self
            .layers
            .iter()
            .map(|layer| self.render_layer(layer, &frame))
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
    fn render_layer<'a>(&'a self, layer: &'a AnimatedLayer, frame: &Frame) -> Svgr<'a> {
        let x = layer.x.at(frame);
        let y = layer.y.at(frame);
        let opacity = layer.opacity.at(frame).clamp(0.0, 1.0);
        let fill = layer.fill.as_str();
        match &layer.shape {
            Shape::Rect {
                width,
                height,
                corner_radius,
            } => fframes::svgr!(
                <rect x={x} y={y} width={*width} height={*height} rx={*corner_radius}
                    fill={fill} opacity={opacity} />
            ),
            Shape::Text { text, font_size } => {
                let family = self.font_family.as_str();
                let text = text.as_str();
                fframes::svgr!(
                    <text x={x} y={y} font-family={family} font-size={*font_size}
                        fill={fill} opacity={opacity}>
                        {text}
                    </text>
                )
            }
        }
    }
}
