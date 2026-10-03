//! Shared helpers for the sidecar's integration tests.
#![allow(dead_code)]

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

/// Runtime folder (with `models/` and optionally `cuda/`) built by
/// `scripts/bootstrap-beat-runtime-windows.ps1`. `SUPA_VIDEO_BEAT_RUNTIME_DIR` overrides the
/// default `<repo>/.cache/beat-runtime`.
pub fn runtime_dir() -> PathBuf {
    std::env::var_os("SUPA_VIDEO_BEAT_RUNTIME_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| repo_root().join(".cache/beat-runtime"))
}

/// The `models/` folder; fails the test (never skips) when the models are missing.
pub fn models_dir() -> PathBuf {
    let models = runtime_dir().join("models");
    for file in ["mel_spectrogram.onnx", "beat_this.onnx"] {
        assert!(
            models.join(file).is_file(),
            "{} is missing. Build the runtime folder with \
             `powershell -File scripts/bootstrap-beat-runtime-windows.ps1 -RuntimeFolder .cache/beat-runtime -SkipGpuPack` \
             (or set SUPA_VIDEO_BEAT_RUNTIME_DIR to an existing runtime folder).",
            models.join(file).display()
        );
    }
    models
}

/// The `cuda/` GPU pack folder; fails the test when it is missing.
pub fn cuda_dir() -> PathBuf {
    let cuda = runtime_dir().join("cuda");
    assert!(
        cuda.join("onnxruntime.dll").is_file(),
        "{} has no GPU pack. Run scripts/bootstrap-beat-runtime-windows.ps1 without -SkipGpuPack \
         (or set SUPA_VIDEO_BEAT_RUNTIME_DIR).",
        cuda.display()
    );
    cuda
}

pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../..")
}

pub fn fixtures_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

pub fn sidecar(args: &[&std::ffi::OsStr]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_supa-beat-detect"))
        .args(args)
        .output()
        .expect("sidecar runs")
}

pub fn scratch_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("supa-beat-detect-{name}-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

pub fn write_wav(path: &Path, samples: &[i16]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 22_050,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(path, spec).unwrap();
    for &sample in samples {
        writer.write_sample(sample).unwrap();
    }
    writer.finalize().unwrap();
}

/// 120 BPM clicks over light deterministic noise.
pub fn click_track(seconds: usize) -> Vec<i16> {
    let rate = 22_050;
    let mut state = 1_u32;
    (0..rate * seconds)
        .map(|index| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = ((state >> 8) as f32 / (1_u32 << 24) as f32 - 0.5) * 0.05;
            let phase = index % (rate / 2);
            let click = if phase < 400 {
                (1.0 - phase as f32 / 400.0) * (index as f32 * 0.3).sin()
            } else {
                0.0
            };
            ((noise + 0.6 * click) * 32_767.0) as i16
        })
        .collect()
}
