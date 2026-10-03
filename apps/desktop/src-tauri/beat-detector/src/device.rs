//! Which device runs the model, and the detection call itself.
//!
//! The policy only sees closures and the `beat_this::Runtime` trait, so it can be tested with
//! a runtime that fails on purpose. `auto` tries CUDA first; any CUDA error before results exist
//! reruns on the CPU and reports the CUDA error. `cuda` and `cpu` are strict.

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::Result;
use beat_this::{BeatThis, Runtime};

use crate::wav::SAMPLE_RATE;

/// Model frame rate (frames per second) of Beat This!.
const FPS: f64 = 50.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DevicePreference {
    Auto,
    Cuda,
    Cpu,
}

impl DevicePreference {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "auto" => Some(Self::Auto),
            "cuda" => Some(Self::Cuda),
            "cpu" => Some(Self::Cpu),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Device {
    Cuda,
    Cpu,
}

impl Device {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Cuda => "cuda",
            Self::Cpu => "cpu",
        }
    }
}

/// A result together with the device that produced it.
#[derive(Debug)]
pub struct Outcome<T> {
    pub value: T,
    pub device: Device,
    /// Why CUDA was not used, when it was wanted (`auto`) but failed or was unavailable.
    pub cuda_error: Option<String>,
}

/// Why no device produced a result.
#[derive(Debug)]
pub enum PolicyError {
    /// `--device cuda` and CUDA failed or was unavailable.
    Cuda(String),
    /// The CPU path failed (after CUDA, for `auto`, when CUDA was tried).
    Cpu {
        error: String,
        cuda_error: Option<String>,
    },
}

impl std::fmt::Display for PolicyError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cuda(error) => write!(f, "CUDA failed: {error}"),
            Self::Cpu {
                error,
                cuda_error: Some(cuda),
            } => write!(f, "CPU failed: {error} (CUDA failed first: {cuda})"),
            Self::Cpu { error, .. } => write!(f, "CPU failed: {error}"),
        }
    }
}

/// Runs `cuda` and/or `cpu` according to `preference`.
///
/// `cuda` is `Err(reason)` when no usable GPU pack was given; it is called at most once.
pub fn run_with_policy<T, Cuda, Cpu>(
    preference: DevicePreference,
    cuda: Result<Cuda, String>,
    cpu: Cpu,
) -> Result<Outcome<T>, PolicyError>
where
    Cuda: FnOnce() -> Result<T>,
    Cpu: FnOnce() -> Result<T>,
{
    let cuda_error = match preference {
        DevicePreference::Cpu => None,
        DevicePreference::Cuda | DevicePreference::Auto => {
            let attempt = cuda.and_then(|run| run().map_err(|error| format!("{error:#}")));
            match (attempt, preference) {
                (Ok(value), _) => {
                    return Ok(Outcome {
                        value,
                        device: Device::Cuda,
                        cuda_error: None,
                    });
                }
                (Err(error), DevicePreference::Cuda) => return Err(PolicyError::Cuda(error)),
                (Err(error), _) => Some(error),
            }
        }
    };
    match cpu() {
        Ok(value) => Ok(Outcome {
            value,
            device: Device::Cpu,
            cuda_error,
        }),
        Err(error) => Err(PolicyError::Cpu {
            error: format!("{error:#}"),
            cuda_error,
        }),
    }
}

/// The two model files, as laid out in the runtime folder's `models/` directory.
#[derive(Debug, Clone)]
pub struct ModelPaths {
    pub mel: PathBuf,
    pub beat: PathBuf,
}

impl ModelPaths {
    pub fn in_folder(folder: &Path) -> Self {
        Self {
            mel: folder.join("mel_spectrogram.onnx"),
            beat: folder.join("beat_this.onnx"),
        }
    }
}

/// Beats and downbeats in seconds, plus stage timings.
#[derive(Debug, Clone, PartialEq)]
pub struct Detection {
    pub beats: Vec<f64>,
    pub downbeats: Vec<f64>,
    pub load_ms: u64,
    pub mel_ms: u64,
    pub inference_ms: u64,
}

/// Loads both models on `runtime` and analyses 22.05 kHz mono samples.
pub fn detect<R: Runtime>(runtime: &R, models: &ModelPaths, samples: &[f32]) -> Result<Detection> {
    let started = Instant::now();
    let mut analyzer = BeatThis::new(runtime, &models.mel, &models.beat)?;
    let load_ms = elapsed_ms(started);
    let timed = analyzer.analyze_audio_timed(samples, SAMPLE_RATE)?;
    Ok(Detection {
        beats: to_reference_times(&timed.analysis.beats),
        downbeats: to_reference_times(&timed.analysis.downbeats),
        load_ms,
        mel_ms: duration_ms(timed.timing.mel),
        inference_ms: duration_ms(timed.timing.predict),
    })
}

/// Restores the exact `f64` times the Python reference reports.
///
/// Peak positions are frame indices or the mean of a run of adjacent frame indices, so every
/// time is a multiple of half a frame (10 ms at 50 fps). The crate rounds `frame / fps` to `f32`,
/// which loses up to 0.12 ms near the one-hour limit; snapping to the half-frame grid recovers
/// the value Python computes as `frame / fps` in `f64`.
pub fn to_reference_times(times: &[f32]) -> Vec<f64> {
    let half_frames_per_second = FPS * 2.0;
    times
        .iter()
        .map(|&time| (f64::from(time) * half_frames_per_second).round() / half_frames_per_second)
        .collect()
}

fn duration_ms(duration: std::time::Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

fn elapsed_ms(started: Instant) -> u64 {
    duration_ms(started.elapsed())
}

#[cfg(test)]
mod tests {
    use std::cell::Cell;
    use std::collections::HashMap;

    use anyhow::anyhow;
    use beat_this::{Model, Tensor};

    use super::*;

    fn ok(value: u32) -> impl FnOnce() -> Result<u32> {
        move || Ok(value)
    }

    fn fail(message: &'static str) -> impl FnOnce() -> Result<u32> {
        move || Err(anyhow!(message))
    }

    #[test]
    fn auto_uses_cuda_when_it_works() {
        let outcome = run_with_policy(DevicePreference::Auto, Ok(ok(1)), ok(2)).unwrap();

        assert_eq!(
            (outcome.value, outcome.device, outcome.cuda_error),
            (1, Device::Cuda, None)
        );
    }

    #[test]
    fn auto_reruns_on_cpu_after_a_cuda_failure_and_reports_it() {
        let outcome =
            run_with_policy(DevicePreference::Auto, Ok(fail("driver too old")), ok(2)).unwrap();

        assert_eq!(outcome.value, 2);
        assert_eq!(outcome.device, Device::Cpu);
        assert_eq!(outcome.cuda_error.as_deref(), Some("driver too old"));
    }

    #[test]
    fn auto_uses_cpu_when_no_gpu_pack_was_given() {
        let cuda: Result<fn() -> Result<u32>, String> = Err("no GPU pack".to_owned());

        let outcome = run_with_policy(DevicePreference::Auto, cuda, ok(2)).unwrap();

        assert_eq!(outcome.device, Device::Cpu);
        assert_eq!(outcome.cuda_error.as_deref(), Some("no GPU pack"));
    }

    #[test]
    fn strict_cuda_never_falls_back() {
        let cpu_ran = Cell::new(false);

        let result = run_with_policy(DevicePreference::Cuda, Ok(fail("boom")), || {
            cpu_ran.set(true);
            Ok(2)
        });

        assert!(matches!(result, Err(PolicyError::Cuda(message)) if message == "boom"));
        assert!(!cpu_ran.get());
    }

    #[test]
    fn strict_cpu_never_touches_cuda() {
        let cuda_ran = Cell::new(false);

        let outcome = run_with_policy(
            DevicePreference::Cpu,
            Ok(|| {
                cuda_ran.set(true);
                Ok(1)
            }),
            ok(2),
        )
        .unwrap();

        assert_eq!(
            (outcome.value, outcome.device, outcome.cuda_error),
            (2, Device::Cpu, None)
        );
        assert!(!cuda_ran.get());
    }

    #[test]
    fn cpu_failure_after_cuda_failure_keeps_both_errors() {
        let result = run_with_policy(
            DevicePreference::Auto,
            Ok(fail("cuda broke")),
            fail("cpu broke"),
        );

        match result {
            Err(PolicyError::Cpu { error, cuda_error }) => {
                assert_eq!(error, "cpu broke");
                assert_eq!(cuda_error.as_deref(), Some("cuda broke"));
            }
            other => panic!("unexpected {other:?}"),
        }
    }

    /// A runtime whose session creation always fails, like a CUDA provider that cannot start.
    struct FailingRuntime;
    struct NeverModel;

    impl Model for NeverModel {
        fn run(&mut self, _inputs: &[(&str, &Tensor)]) -> Result<HashMap<String, Tensor>> {
            unreachable!("FailingRuntime never creates a model")
        }
    }

    impl Runtime for FailingRuntime {
        type Model = NeverModel;
        fn load_model(&self, _path: &Path) -> Result<NeverModel> {
            Err(anyhow!("CUDA execution provider could not be created"))
        }
    }

    #[test]
    fn a_failing_cuda_runtime_falls_back_to_cpu_under_auto() {
        let models = ModelPaths::in_folder(Path::new("unused"));

        let outcome = run_with_policy(
            DevicePreference::Auto,
            Ok(|| detect(&FailingRuntime, &models, &[0.0; 16])),
            || {
                Ok(Detection {
                    beats: vec![0.5],
                    downbeats: vec![0.5],
                    load_ms: 0,
                    mel_ms: 0,
                    inference_ms: 0,
                })
            },
        )
        .unwrap();

        assert_eq!(outcome.device, Device::Cpu);
        assert!(outcome.cuda_error.unwrap().contains("could not be created"));
        assert_eq!(outcome.value.beats, vec![0.5]);
    }

    #[test]
    fn reference_times_snap_to_the_half_frame_grid() {
        // 179 999.5 frames / 50 fps, as f32, is off by about 0.1 ms.
        let late = (179_999.5_f64 / 50.0) as f32;

        let times = to_reference_times(&[0.0, 0.02, 0.47, late]);

        assert_eq!(times, vec![0.0, 0.02, 0.47, 179_999.5 / 50.0]);
    }

    #[test]
    fn parses_device_names_strictly() {
        assert_eq!(
            DevicePreference::parse("auto"),
            Some(DevicePreference::Auto)
        );
        assert_eq!(
            DevicePreference::parse("cuda"),
            Some(DevicePreference::Cuda)
        );
        assert_eq!(DevicePreference::parse("cpu"), Some(DevicePreference::Cpu));
        assert_eq!(DevicePreference::parse("CUDA"), None);
        assert_eq!(DevicePreference::parse("gpu"), None);
    }
}
