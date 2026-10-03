//! Parity of the Rust sidecar with the Python Beat This! reference
//! (`File2Beats(final0, dbn=False)`).
//!
//! - `committed_fixture_matches_python_on_cpu` runs in the normal suite; the Python goldens are
//!   committed, so no Python is needed.
//! - The `#[ignore]` tests need the GPU pack and/or live Python. They read
//!   `SUPA_VIDEO_BEAT_REFERENCE_PYTHON` + `SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT` (and
//!   `SUPA_VIDEO_BEAT_PARITY_DIR` for real music) and fail, never skip, when one is missing.
//!
//! Pass criteria per track, for beats and downbeats: equal counts, F-measure 1.0 at ±70 ms,
//! ≥ 99.5 % of matched times within 1 ms, maximum deviation ≤ 20 ms. CUDA vs CPU uses the same.

mod common;

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::{cuda_dir, fixtures_dir, models_dir, scratch_dir, sidecar};
use serde::Deserialize;
use supa_beat_detect::parity::{Comparison, F_MEASURE_WINDOW_S, compare};

const REFERENCE_PYTHON_ENV: &str = "SUPA_VIDEO_BEAT_REFERENCE_PYTHON";
const REFERENCE_CHECKPOINT_ENV: &str = "SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT";
const PARITY_DIR_ENV: &str = "SUPA_VIDEO_BEAT_PARITY_DIR";
const SETUP_HINT: &str = "Create the reference environment with \
    `uv sync --project apps/desktop/src-tauri/beat-detector/reference`, then set \
    SUPA_VIDEO_BEAT_REFERENCE_PYTHON to reference/.venv/Scripts/python.exe and \
    SUPA_VIDEO_BEAT_REFERENCE_CHECKPOINT to a local final0.ckpt.";

#[derive(Debug, Deserialize)]
struct Golden {
    #[serde(rename = "fixtureSha256")]
    fixture_sha256: String,
    beats: Vec<f64>,
    downbeats: Vec<f64>,
}

#[derive(Debug, Deserialize)]
struct Beats {
    beats: Vec<f64>,
    downbeats: Vec<f64>,
    device: String,
}

/// One track's comparison, for the report and the assertion.
struct Report {
    track: String,
    label: &'static str,
    beats: Comparison,
    downbeats: Comparison,
}

impl Report {
    fn new(track: &str, label: &'static str, reference: &Beats, candidate: &Beats) -> Self {
        Self {
            track: track.to_owned(),
            label,
            beats: compare(&reference.beats, &candidate.beats, F_MEASURE_WINDOW_S),
            downbeats: compare(
                &reference.downbeats,
                &candidate.downbeats,
                F_MEASURE_WINDOW_S,
            ),
        }
    }

    fn line(&self) -> String {
        format!(
            "| {} | {} | {} / {} | {:.4} | {:.2} % | {:.3} ms | {} / {} | {:.4} | {:.2} % | {:.3} ms | {} |",
            self.track,
            self.label,
            self.beats.candidate_count,
            self.beats.reference_count,
            self.beats.f_measure,
            self.beats.close_fraction * 100.0,
            self.beats.max_deviation_s * 1000.0,
            self.downbeats.candidate_count,
            self.downbeats.reference_count,
            self.downbeats.f_measure,
            self.downbeats.close_fraction * 100.0,
            self.downbeats.max_deviation_s * 1000.0,
            if self.passes() { "pass" } else { "FAIL" },
        )
    }

    fn passes(&self) -> bool {
        self.beats.passes() && self.downbeats.passes()
    }

    fn failures(&self) -> String {
        format!(
            "{} ({}): beats {:?}; downbeats {:?}",
            self.track,
            self.label,
            self.beats.failures(),
            self.downbeats.failures()
        )
    }
}

fn assert_all_pass(reports: &[Report]) {
    println!(
        "| Track | Comparison | Beats | Beat F | Beats ≤ 1 ms | Beat max dev | Downbeats | Downbeat F | Downbeats ≤ 1 ms | Downbeat max dev | Result |"
    );
    println!("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
    for report in reports {
        println!("{}", report.line());
    }
    let failures: Vec<String> = reports
        .iter()
        .filter(|report| !report.passes())
        .map(Report::failures)
        .collect();
    assert!(
        failures.is_empty(),
        "parity failed:\n{}",
        failures.join("\n")
    );
}

fn required_env(name: &str) -> PathBuf {
    match std::env::var_os(name) {
        Some(value) if !value.is_empty() => PathBuf::from(value),
        _ => panic!("{name} is not set. {SETUP_HINT}"),
    }
}

/// Runs the sidecar on `wav` with a strict device.
fn rust_detect(wav: &Path, device: &str) -> Beats {
    let models = models_dir();
    let mut args: Vec<&OsStr> = vec![
        OsStr::new("detect"),
        OsStr::new("--models"),
        models.as_os_str(),
        OsStr::new("--device"),
        OsStr::new(device),
    ];
    let cuda = (device == "cuda").then(cuda_dir);
    if let Some(cuda) = &cuda {
        args.extend([OsStr::new("--cuda"), cuda.as_os_str()]);
    }
    args.push(wav.as_os_str());
    let output = sidecar(&args);
    assert_eq!(
        output.status.code(),
        Some(0),
        "sidecar failed on {}: {}",
        wav.display(),
        String::from_utf8_lossy(&output.stderr)
    );
    let beats: Beats = serde_json::from_slice(&output.stdout).expect("sidecar JSON");
    assert_eq!(
        beats.device, device,
        "sidecar did not run on the requested device"
    );
    beats
}

/// Runs the Python reference script on `wav`.
fn python_detect(wav: &Path, device: &str) -> Beats {
    let python = required_env(REFERENCE_PYTHON_ENV);
    let checkpoint = required_env(REFERENCE_CHECKPOINT_ENV);
    let script = Path::new(env!("CARGO_MANIFEST_DIR")).join("reference/beat_this_reference.py");
    let output = Command::new(&python)
        .arg(&script)
        .arg("--checkpoint")
        .arg(&checkpoint)
        .args(["--device", device])
        .arg(wav)
        .output()
        .unwrap_or_else(|error| {
            panic!(
                "could not start {REFERENCE_PYTHON_ENV}={}: {error}. {SETUP_HINT}",
                python.display()
            )
        });
    let stderr = String::from_utf8_lossy(&output.stderr);
    match output.status.code() {
        Some(0) => {}
        Some(4) => panic!("reference pin check failed: {stderr}. {SETUP_HINT}"),
        code => panic!(
            "reference script exited {code:?} on {}: {stderr}",
            wav.display()
        ),
    }
    let beats: Beats = serde_json::from_slice(&output.stdout).expect("reference JSON");
    assert_eq!(beats.device, device);
    beats
}

fn committed_fixture() -> (PathBuf, Beats) {
    let wav = fixtures_dir().join("tempo-changes.wav");
    let golden: Golden = serde_json::from_slice(
        &std::fs::read(fixtures_dir().join("tempo-changes.golden.json")).expect("golden file"),
    )
    .expect("golden JSON");
    let bytes = std::fs::read(&wav).expect("fixture WAV");
    assert_eq!(
        sha256_hex(&bytes),
        golden.fixture_sha256,
        "fixture WAV does not match its golden; regenerate both with scripts/generate-beat-parity-fixture.py"
    );
    (
        wav,
        Beats {
            beats: golden.beats,
            downbeats: golden.downbeats,
            device: "python".to_owned(),
        },
    )
}

#[test]
fn committed_fixture_matches_python_on_cpu() {
    let (wav, golden) = committed_fixture();

    let rust = rust_detect(&wav, "cpu");

    assert_all_pass(&[Report::new(
        "tempo-changes",
        "Python vs Rust CPU",
        &golden,
        &rust,
    )]);
}

#[test]
#[ignore = "needs the GPU pack and an NVIDIA GPU; run with --ignored"]
fn committed_fixture_matches_python_on_cuda() {
    let (wav, golden) = committed_fixture();

    let cuda = rust_detect(&wav, "cuda");
    let cpu = rust_detect(&wav, "cpu");

    assert_all_pass(&[
        Report::new("tempo-changes", "Python vs Rust CUDA", &golden, &cuda),
        Report::new("tempo-changes", "Rust CPU vs Rust CUDA", &cpu, &cuda),
    ]);
}

#[test]
#[ignore = "needs live Python (SUPA_VIDEO_BEAT_REFERENCE_*); run with --ignored"]
fn committed_fixture_goldens_still_match_live_python() {
    let (wav, golden) = committed_fixture();

    let live = python_detect(&wav, "cuda");

    assert_all_pass(&[Report::new(
        "tempo-changes",
        "golden vs live Python CUDA",
        &golden,
        &live,
    )]);
}

#[test]
#[ignore = "needs live Python, the GPU pack and SUPA_VIDEO_BEAT_PARITY_DIR; run with --ignored"]
fn real_music_matches_python_on_cuda_and_cpu() {
    let music = required_env(PARITY_DIR_ENV);
    let tracks = audio_files(&music);
    assert!(
        !tracks.is_empty(),
        "{PARITY_DIR_ENV}={} contains no audio files",
        music.display()
    );
    let scratch = scratch_dir("parity-music");
    let mut reports = Vec::new();
    for (index, track) in tracks.iter().enumerate() {
        let name = track
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let wav = scratch.join(format!("track-{index}.wav"));
        extract_analysis_wav(track, &wav);

        let python = python_detect(&wav, "cuda");
        let cuda = rust_detect(&wav, "cuda");
        let cpu = rust_detect(&wav, "cpu");

        reports.push(Report::new(
            &name,
            "Python CUDA vs Rust CUDA",
            &python,
            &cuda,
        ));
        reports.push(Report::new(&name, "Python CUDA vs Rust CPU", &python, &cpu));
        reports.push(Report::new(&name, "Rust CPU vs Rust CUDA", &cpu, &cuda));
    }
    assert_all_pass(&reports);
}

fn audio_files(folder: &Path) -> Vec<PathBuf> {
    const EXTENSIONS: &[&str] = &["wav", "mp3", "flac", "m4a", "aac", "ogg", "opus"];
    let mut files: Vec<PathBuf> = std::fs::read_dir(folder)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", folder.display()))
        .filter_map(|entry| entry.ok().map(|entry| entry.path()))
        .filter(|path| {
            path.is_file()
                && path
                    .extension()
                    .and_then(OsStr::to_str)
                    .is_some_and(|extension| {
                        EXTENSIONS.contains(&extension.to_ascii_lowercase().as_str())
                    })
        })
        .collect();
    files.sort();
    files
}

/// Same conversion as the app (first audio stream, mono, 22.05 kHz, 16-bit PCM, ≤ 1 hour).
fn extract_analysis_wav(source: &Path, wav: &Path) {
    let output = Command::new(ffmpeg())
        .args(["-nostdin", "-hide_banner", "-loglevel", "error", "-i"])
        .arg(source)
        .args([
            "-map",
            "0:a:0",
            "-vn",
            "-t",
            "3600",
            "-ac",
            "1",
            "-ar",
            "22050",
            "-c:a",
            "pcm_s16le",
            "-f",
            "wav",
            "-y",
        ])
        .arg(wav)
        .output()
        .expect("ffmpeg runs");
    assert!(
        output.status.success(),
        "ffmpeg failed on {}: {}",
        source.display(),
        String::from_utf8_lossy(&output.stderr)
    );
}

/// The app's bundled ffmpeg when present, else `ffmpeg` from PATH.
fn ffmpeg() -> PathBuf {
    let bundled = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe");
    if bundled.is_file() {
        bundled
    } else {
        PathBuf::from("ffmpeg")
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    sha2::Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}
