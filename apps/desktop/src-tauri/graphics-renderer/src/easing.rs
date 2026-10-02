//! Keyframe easing curves, identical to `packages/video-contracts/src/easing.ts`.
//!
//! `cubic_bezier`, `spring` and `steps` are exact ports of animejs 4.5.0 (via diffusion-studio-2
//! `lib/motion.ts`). Both implementations are checked against
//! `packages/video-contracts/fixtures/easing-samples.json` (see docs/adr/0003-graphics-clips.md).

use serde::Deserialize;

pub const MAX_BEZIER_Y: f64 = 10.0;
pub const MIN_SPRING_DURATION_MS: u32 = 10;
pub const MAX_SPRING_DURATION_MS: u32 = 10_000;
pub const MAX_EASING_STEPS: u32 = 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PresetName {
    EaseIn,
    EaseOut,
    EaseInOut,
    Gentle,
    Snappy,
    Bouncy,
    Strong,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum Easing {
    // A struct variant so `deny_unknown_fields` applies (serde ignores it on unit variants).
    Linear {},
    Preset {
        name: PresetName,
    },
    CubicBezier {
        x1: f64,
        y1: f64,
        x2: f64,
        y2: f64,
    },
    #[serde(rename_all = "camelCase")]
    Spring {
        bounce: f64,
        duration_ms: u32,
    },
    #[serde(rename_all = "camelCase")]
    Steps {
        count: u32,
        #[serde(default)]
        from_start: bool,
    },
}

impl Default for Easing {
    fn default() -> Self {
        Self::Linear {}
    }
}

impl Easing {
    /// True when every parameter is inside the bounds the TS schema enforces.
    pub fn is_valid(&self) -> bool {
        let unit = |value: f64| value.is_finite() && (0.0..=1.0).contains(&value);
        let bezier_y = |value: f64| value.is_finite() && value.abs() <= MAX_BEZIER_Y;
        match *self {
            Self::Linear {} | Self::Preset { .. } => true,
            Self::CubicBezier { x1, y1, x2, y2 } => {
                unit(x1) && unit(x2) && bezier_y(y1) && bezier_y(y2)
            }
            Self::Spring {
                bounce,
                duration_ms,
            } => {
                bounce.is_finite()
                    && (-1.0..=1.0).contains(&bounce)
                    && (MIN_SPRING_DURATION_MS..=MAX_SPRING_DURATION_MS).contains(&duration_ms)
            }
            Self::Steps { count, .. } => (1..=MAX_EASING_STEPS).contains(&count),
        }
    }

    /// A preset expanded to the curve it stands for; other easings unchanged.
    pub fn resolve(self) -> Self {
        let Self::Preset { name } = self else {
            return self;
        };
        let bezier = |x1, y1, x2, y2| Self::CubicBezier { x1, y1, x2, y2 };
        let spring = |bounce, duration_ms| Self::Spring {
            bounce,
            duration_ms,
        };
        match name {
            PresetName::EaseIn => bezier(0.42, 0.0, 1.0, 1.0),
            PresetName::EaseOut => bezier(0.0, 0.0, 0.58, 1.0),
            PresetName::EaseInOut => bezier(0.42, 0.0, 0.58, 1.0),
            PresetName::Gentle => spring(0.5, 628),
            PresetName::Snappy => spring(0.15, 300),
            PresetName::Bouncy => spring(0.4, 500),
            PresetName::Strong => spring(0.65, 400),
        }
    }

    pub fn function(self) -> EaseFunction {
        match self.resolve() {
            Self::Linear {} | Self::Preset { .. } => EaseFunction::Linear,
            Self::CubicBezier { x1, y1, x2, y2 } => {
                if x1 == y1 && x2 == y2 {
                    EaseFunction::Linear
                } else {
                    EaseFunction::CubicBezier { x1, y1, x2, y2 }
                }
            }
            Self::Spring {
                bounce,
                duration_ms,
            } => {
                let solver = SpringSolver::new(bounce, f64::from(duration_ms));
                EaseFunction::Spring(solver)
            }
            Self::Steps { count, from_start } => EaseFunction::Steps {
                count: f64::from(count),
                from_start,
            },
        }
    }
}

/// A compiled easing curve: progress 0..1 of a keyframe segment → eased progress.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum EaseFunction {
    Linear,
    CubicBezier { x1: f64, y1: f64, x2: f64, y2: f64 },
    Spring(SpringSolver),
    Steps { count: f64, from_start: bool },
}

impl EaseFunction {
    pub fn apply(&self, t: f64) -> f64 {
        match *self {
            Self::Linear => t,
            Self::CubicBezier { x1, y1, x2, y2 } => {
                if t == 0.0 || t == 1.0 {
                    t
                } else {
                    calc_bezier(binary_subdivide(t, x1, x2), y1, y2)
                }
            }
            Self::Spring(solver) => {
                if t == 0.0 || t == 1.0 {
                    t
                } else {
                    solver.solve(t * solver.settling_seconds)
                }
            }
            Self::Steps { count, from_start } => {
                let scaled = t.clamp(0.0, 1.0) * count;
                let stepped = if from_start {
                    scaled.ceil()
                } else {
                    scaled.floor()
                };
                stepped * (1.0 / count)
            }
        }
    }
}

fn calc_bezier(t: f64, a1: f64, a2: f64) -> f64 {
    ((1.0 - 3.0 * a2 + 3.0 * a1) * t + (3.0 * a2 - 6.0 * a1)) * t * t + 3.0 * a1 * t
}

fn binary_subdivide(x: f64, x1: f64, x2: f64) -> f64 {
    let mut low = 0.0;
    let mut high = 1.0;
    let mut iteration = 0;
    loop {
        let current_t = low + (high - low) / 2.0;
        let current_x = calc_bezier(current_t, x1, x2) - x;
        if current_x > 0.0 {
            high = current_t;
        } else {
            low = current_t;
        }
        iteration += 1;
        if current_x.abs() <= 0.000_000_1 || iteration >= 100 {
            return current_t;
        }
    }
}

/// animejs 4 damped-spring solver with its perceived-duration mapping and settling time.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SpringSolver {
    zeta: f64,
    w0: f64,
    wd: f64,
    b: f64,
    pub settling_seconds: f64,
}

impl SpringSolver {
    pub fn new(bounce: f64, duration_ms: f64) -> Self {
        const SCALE: f64 = 1e3;
        const MIN_VALUE: f64 = 1e-11;
        const MAX_PARAM: f64 = SCALE * 10.0;
        const TIME_STEP: f64 = 0.02;
        const REST_THRESHOLD: f64 = 0.0005;
        let max_rest_steps = 200.0 / TIME_STEP / SCALE;
        let max_iterations = 60000.0 / TIME_STEP / SCALE;
        // JS Math.round: round half up; the inputs here are positive.
        let round3 = |value: f64| (value * 1000.0 + 0.5).floor() / 1000.0;

        let bounce = bounce.clamp(-1.0, 1.0);
        let perceived = duration_ms.clamp(10.0, MAX_PARAM) / SCALE;
        let mass = 1.0;
        let velocity = 0.0;
        let root = (2.0 * std::f64::consts::PI) / perceived;
        let stiffness = round3((root * root).clamp(MIN_VALUE, MAX_PARAM));
        let raw_damping = if bounce >= 0.0 {
            ((1.0 - bounce) * 4.0 * std::f64::consts::PI) / perceived
        } else {
            (4.0 * std::f64::consts::PI) / (perceived * (1.0 + bounce))
        };
        let damping = round3(raw_damping.clamp(MIN_VALUE, 300.0));

        let w0 = (stiffness / mass).sqrt().clamp(MIN_VALUE, SCALE);
        let zeta = damping / (2.0 * (stiffness * mass).sqrt());
        let wd = if zeta < 1.0 {
            w0 * (1.0 - zeta * zeta).sqrt()
        } else if zeta == 1.0 {
            0.0
        } else {
            w0 * (zeta * zeta - 1.0).sqrt()
        };
        let b = if zeta == 1.0 {
            -velocity + w0
        } else {
            (zeta * w0 + -velocity) / wd
        };
        let mut solver = Self {
            zeta,
            w0,
            wd,
            b,
            settling_seconds: 0.0,
        };

        let mut solver_time = 0.0;
        let mut rest_steps = 0.0;
        let mut iterations = 0.0;
        let mut settling = 0.0;
        while rest_steps <= max_rest_steps && iterations <= max_iterations {
            rest_steps = if (1.0 - solver.solve(solver_time)).abs() < REST_THRESHOLD {
                rest_steps + 1.0
            } else {
                0.0
            };
            settling = solver_time;
            solver_time += TIME_STEP;
            iterations += 1.0;
        }
        solver.settling_seconds = settling;
        solver
    }

    fn solve(&self, time: f64) -> f64 {
        let Self {
            zeta, w0, wd, b, ..
        } = *self;
        let x = if zeta < 1.0 {
            (-time * zeta * w0).exp() * ((wd * time).cos() + b * (wd * time).sin())
        } else if zeta == 1.0 {
            (1.0 + b * time) * (-time * w0).exp()
        } else {
            ((1.0 + b) * ((-zeta * w0 + wd) * time).exp()
                + (1.0 - b) * ((-zeta * w0 - wd) * time).exp())
                / 2.0
        };
        1.0 - x
    }
}

/// One key of a sampled track; `easing` shapes the segment to the next key.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct SampleKey {
    pub time: f64,
    pub value: f64,
    pub easing: Easing,
}

/// Keys with strictly increasing times compiled into a function of time (same unit as the keys).
/// Before the first key the first value holds; after the last key the last value holds.
#[derive(Debug, Clone, PartialEq)]
pub struct CompiledTrack {
    keys: Vec<(f64, f64)>,
    eases: Vec<EaseFunction>,
}

impl CompiledTrack {
    /// `keys` must be non-empty with strictly increasing times (validated by the caller).
    pub fn new(keys: &[SampleKey]) -> Self {
        Self {
            keys: keys.iter().map(|key| (key.time, key.value)).collect(),
            eases: keys
                .iter()
                .take(keys.len().saturating_sub(1))
                .map(|key| key.easing.function())
                .collect(),
        }
    }

    pub fn sample(&self, time: f64) -> f64 {
        let Some(&(first_time, first_value)) = self.keys.first() else {
            return 0.0;
        };
        let &(last_time, last_value) = self.keys.last().unwrap_or(&(first_time, first_value));
        if self.keys.len() == 1 || time <= first_time {
            return first_value;
        }
        if time >= last_time {
            return last_value;
        }
        for (index, pair) in self.keys.windows(2).enumerate() {
            let ((from_time, from_value), (to_time, to_value)) = (pair[0], pair[1]);
            if time < from_time || time > to_time {
                continue;
            }
            let span = to_time - from_time;
            if span <= 0.0 {
                continue;
            }
            let progress = self.eases[index].apply(((time - from_time) / span).clamp(0.0, 1.0));
            return from_value + (to_value - from_value) * progress;
        }
        last_value
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    const CROSS_LANGUAGE_TOLERANCE: f64 = 1e-6;
    const ANIMEJS_TOLERANCE: f64 = 1e-3;

    fn samples() -> Value {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../../packages/video-contracts/fixtures/easing-samples.json");
        serde_json::from_slice(&std::fs::read(path).expect("easing fixture")).expect("fixture JSON")
    }

    fn easing(value: &Value) -> Easing {
        serde_json::from_value(value.clone()).expect("fixture easing")
    }

    #[test]
    fn curves_match_the_shared_fixture() {
        let samples = samples();
        let cases = samples["cases"].as_array().expect("cases");
        assert_eq!(cases.len(), 30);
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let easing = easing(&case["easing"]);
            assert!(easing.is_valid(), "{name}");
            let ease = easing.function();
            for point in case["points"].as_array().unwrap() {
                let t = point["t"].as_f64().unwrap();
                let actual = ease.apply(t);
                let expected = point["expected"].as_f64().unwrap();
                let animejs = point["animejs"].as_f64().unwrap();
                assert!(
                    (actual - expected).abs() <= CROSS_LANGUAGE_TOLERANCE,
                    "{name} at {t}: {actual} vs TS {expected}"
                );
                assert!(
                    (actual - animejs).abs() <= ANIMEJS_TOLERANCE,
                    "{name} at {t}: {actual} vs animejs {animejs}"
                );
            }
        }
    }

    #[test]
    fn spring_settling_times_match_the_fixture() {
        for case in samples()["springSettling"].as_array().unwrap() {
            let bounce = case["bounce"].as_f64().unwrap();
            let duration = case["durationMs"].as_f64().unwrap();
            let expected = case["settlingSeconds"].as_f64().unwrap();
            let actual = SpringSolver::new(bounce, duration).settling_seconds;
            assert!(
                (actual - expected).abs() < 1e-9,
                "spring({bounce}, {duration}): {actual} vs {expected}"
            );
        }
    }

    #[test]
    fn tracks_sample_like_typescript() {
        for track in samples()["tracks"].as_array().unwrap() {
            let keys: Vec<SampleKey> = track["keys"]
                .as_array()
                .unwrap()
                .iter()
                .map(|key| SampleKey {
                    time: key["time"].as_f64().unwrap(),
                    value: key["value"].as_f64().unwrap(),
                    easing: key.get("easing").map(easing).unwrap_or_default(),
                })
                .collect();
            let compiled = CompiledTrack::new(&keys);
            for sample in track["samples"].as_array().unwrap() {
                let time = sample["time"].as_f64().unwrap();
                let expected = sample["value"].as_f64().unwrap();
                let actual = compiled.sample(time);
                assert!(
                    (actual - expected).abs() <= CROSS_LANGUAGE_TOLERANCE,
                    "at {time}: {actual} vs {expected}"
                );
            }
        }
    }

    #[test]
    fn endpoints_are_exact() {
        let curves = [
            Easing::Linear {},
            Easing::Preset {
                name: PresetName::EaseInOut,
            },
            Easing::CubicBezier {
                x1: 0.34,
                y1: 1.56,
                x2: 0.64,
                y2: 1.0,
            },
            Easing::Spring {
                bounce: 0.9,
                duration_ms: 2000,
            },
            Easing::Steps {
                count: 4,
                from_start: true,
            },
        ];
        for easing in curves {
            let ease = easing.function();
            assert_eq!(ease.apply(0.0), 0.0, "{easing:?}");
            assert_eq!(ease.apply(1.0), 1.0, "{easing:?}");
        }
    }

    #[test]
    fn rejects_out_of_bounds_parameters() {
        let invalid = [
            Easing::CubicBezier {
                x1: 1.5,
                y1: 0.0,
                x2: 0.5,
                y2: 1.0,
            },
            Easing::CubicBezier {
                x1: 0.5,
                y1: f64::NAN,
                x2: 0.5,
                y2: 1.0,
            },
            Easing::Spring {
                bounce: 2.0,
                duration_ms: 300,
            },
            Easing::Spring {
                bounce: 0.2,
                duration_ms: 5,
            },
            Easing::Steps {
                count: 0,
                from_start: false,
            },
        ];
        for easing in invalid {
            assert!(!easing.is_valid(), "{easing:?}");
        }
        assert!(serde_json::from_str::<Easing>(r#"{"kind":"linear","extra":1}"#).is_err());
        assert!(serde_json::from_str::<Easing>(r#"{"kind":"preset","name":"wobbly"}"#).is_err());
    }
}
