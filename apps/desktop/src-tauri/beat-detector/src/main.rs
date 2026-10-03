use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::ExitCode;
use std::time::Instant;

use anyhow::bail;
use beat_this::RtenRuntime;
use serde::Serialize;
use supa_beat_detect::cli::{
    self, BEAT_THIS_VERSION, Command, DetectOutput, EXIT_BAD_INPUT, EXIT_RUNTIME_FAILURE,
    ProbeOutput,
};
use supa_beat_detect::cuda::{self, OrtCudaRuntime};
use supa_beat_detect::device::{self, DevicePreference, ModelPaths, Outcome, run_with_policy};
use supa_beat_detect::wav::{self, SAMPLE_RATE};

fn main() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().skip(1).collect();
    let command = match cli::parse(&args) {
        Ok(command) => command,
        Err(error) => {
            eprintln!("supa-beat-detect: {error}\n{}", cli::usage());
            return exit(EXIT_BAD_INPUT);
        }
    };
    let started = Instant::now();
    match command {
        Command::Probe { models, cuda } => probe(&models, cuda.as_deref(), started),
        Command::Detect {
            models,
            cuda,
            device,
            wav,
        } => detect(&models, cuda.as_deref(), device, &wav, started),
    }
}

fn probe(models: &Path, cuda_dir: Option<&Path>, started: Instant) -> ExitCode {
    let silence = vec![0.0_f32; SAMPLE_RATE as usize];
    let outcome = run(models, cuda_dir, DevicePreference::Auto, &silence);
    match outcome {
        Ok(outcome) => {
            log("probe", "ok", Some(&outcome), silence.len(), started);
            print_json(&ProbeOutput {
                version: BEAT_THIS_VERSION,
                device: outcome.device.as_str(),
                cuda_error: outcome.cuda_error,
            })
        }
        Err(error) => {
            log("probe", "failed", None, silence.len(), started);
            eprintln!("supa-beat-detect: {error}");
            exit(EXIT_RUNTIME_FAILURE)
        }
    }
}

fn detect(
    models: &Path,
    cuda_dir: Option<&Path>,
    preference: DevicePreference,
    wav_path: &Path,
    started: Instant,
) -> ExitCode {
    let samples = match wav::read_analysis_wav(wav_path) {
        Ok(samples) => samples,
        Err(error) => {
            eprintln!("supa-beat-detect: {error}");
            return exit(EXIT_BAD_INPUT);
        }
    };
    match run(models, cuda_dir, preference, &samples) {
        Ok(outcome) => {
            log("detect", "ok", Some(&outcome), samples.len(), started);
            print_json(&DetectOutput::from(outcome))
        }
        Err(error) => {
            log("detect", "failed", None, samples.len(), started);
            eprintln!("supa-beat-detect: {error}");
            exit(EXIT_RUNTIME_FAILURE)
        }
    }
}

fn run(
    models: &Path,
    cuda_dir: Option<&Path>,
    preference: DevicePreference,
    samples: &[f32],
) -> Result<Outcome<device::Detection>, device::PolicyError> {
    let models = ModelPaths::in_folder(models);
    // Without a GPU pack CUDA was not asked for, so `auto` is simply the CPU (no error to report).
    let (preference, cuda_attempt) = match cuda_dir {
        Some(dir) => (
            preference,
            Ok(|| {
                cuda::load_gpu_pack(dir)?;
                if !cuda::cuda_provider_available()? {
                    bail!("this ONNX Runtime build has no CUDA execution provider");
                }
                device::detect(&OrtCudaRuntime::new(), &models, samples)
            }),
        ),
        None => (DevicePreference::Cpu, Err("no GPU pack".to_owned())),
    };
    run_with_policy(preference, cuda_attempt, || {
        device::detect(&RtenRuntime, &models, samples)
    })
}

/// One structured line per run on stderr: inputs, outcome and elapsed time.
fn log(
    operation: &str,
    outcome: &str,
    result: Option<&Outcome<device::Detection>>,
    samples: usize,
    started: Instant,
) {
    let elapsed_ms = started.elapsed().as_millis();
    match result {
        Some(result) => eprintln!(
            "supa_beat_detect.{operation} outcome={outcome} device={} samples={samples} load_ms={} mel_ms={} inference_ms={} elapsed_ms={elapsed_ms} cuda_error={:?}",
            result.device.as_str(),
            result.value.load_ms,
            result.value.mel_ms,
            result.value.inference_ms,
            result.cuda_error.as_deref().unwrap_or(""),
        ),
        None => eprintln!(
            "supa_beat_detect.{operation} outcome={outcome} samples={samples} elapsed_ms={elapsed_ms}"
        ),
    }
}

fn print_json<T: Serialize>(value: &T) -> ExitCode {
    let mut stdout = std::io::stdout().lock();
    let written = serde_json::to_writer(&mut stdout, value)
        .map_err(std::io::Error::other)
        .and_then(|()| stdout.write_all(b"\n"))
        .and_then(|()| stdout.flush());
    match written {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("supa-beat-detect: could not write the result: {error}");
            exit(EXIT_RUNTIME_FAILURE)
        }
    }
}

fn exit(code: i32) -> ExitCode {
    ExitCode::from(u8::try_from(code).unwrap_or(1))
}
