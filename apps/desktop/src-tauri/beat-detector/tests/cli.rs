//! The sidecar's process contract: exit codes, stdout JSON, device fallback.

mod common;

use std::ffi::OsStr;

use common::{click_track, models_dir, scratch_dir, sidecar, write_wav};

fn json(output: &std::process::Output) -> serde_json::Value {
    serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "stdout is not one JSON object ({error}): {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    })
}

#[test]
fn bad_arguments_exit_2_with_empty_stdout() {
    let output = sidecar(&[
        OsStr::new("detect"),
        OsStr::new("--models"),
        OsStr::new("m"),
    ]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
}

#[test]
fn an_unsupported_wav_exits_2() {
    let dir = scratch_dir("cli-bad-wav");
    let wav = dir.join("stereo.wav");
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: 22_050,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(&wav, spec).unwrap();
    writer.write_sample(0_i16).unwrap();
    writer.write_sample(0_i16).unwrap();
    writer.finalize().unwrap();

    let output = sidecar(&[
        OsStr::new("detect"),
        OsStr::new("--models"),
        dir.as_os_str(),
        OsStr::new("--device"),
        OsStr::new("cpu"),
        wav.as_os_str(),
    ]);

    assert_eq!(output.status.code(), Some(2));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("mono"));
}

#[test]
fn missing_models_exit_3() {
    let dir = scratch_dir("cli-no-models");

    let output = sidecar(&[OsStr::new("probe"), OsStr::new("--models"), dir.as_os_str()]);

    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
}

#[test]
fn auto_with_a_broken_gpu_pack_falls_back_to_cpu_and_says_why() {
    let models = models_dir();
    let dir = scratch_dir("cli-broken-pack");
    let empty_pack = dir.join("empty-cuda");
    std::fs::create_dir_all(&empty_pack).unwrap();
    let wav = dir.join("clicks.wav");
    write_wav(&wav, &click_track(8));

    let output = sidecar(&[
        OsStr::new("detect"),
        OsStr::new("--models"),
        models.as_os_str(),
        OsStr::new("--cuda"),
        empty_pack.as_os_str(),
        OsStr::new("--device"),
        OsStr::new("auto"),
        wav.as_os_str(),
    ]);

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result = json(&output);
    assert_eq!(result["device"], "cpu");
    assert!(
        result["cudaError"]
            .as_str()
            .unwrap()
            .contains("cudart64_12.dll")
    );
    let beats = result["beats"].as_array().unwrap();
    assert!(
        beats.len() >= 12,
        "expected 120 BPM beats over 8 s, got {beats:?}"
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("supa_beat_detect.detect outcome=ok device=cpu"),
        "{stderr}"
    );
}

#[test]
fn strict_cuda_with_a_broken_gpu_pack_exits_3() {
    let models = models_dir();
    let dir = scratch_dir("cli-strict-cuda");
    let empty_pack = dir.join("empty-cuda");
    std::fs::create_dir_all(&empty_pack).unwrap();
    let wav = dir.join("clicks.wav");
    write_wav(&wav, &click_track(2));

    let output = sidecar(&[
        OsStr::new("detect"),
        OsStr::new("--models"),
        models.as_os_str(),
        OsStr::new("--cuda"),
        empty_pack.as_os_str(),
        OsStr::new("--device"),
        OsStr::new("cuda"),
        wav.as_os_str(),
    ]);

    assert_eq!(output.status.code(), Some(3));
    assert!(output.stdout.is_empty());
}

#[test]
fn probe_on_cpu_reports_the_pipeline_version() {
    let models = models_dir();

    let output = sidecar(&[
        OsStr::new("probe"),
        OsStr::new("--models"),
        models.as_os_str(),
    ]);

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        json(&output),
        serde_json::json!({"version": "1.1.0", "device": "cpu", "cudaError": null})
    );
}

#[test]
#[ignore = "needs the GPU pack and an NVIDIA GPU; run with --ignored"]
fn probe_with_the_gpu_pack_runs_on_cuda() {
    let models = models_dir();
    let cuda = common::cuda_dir();

    let output = sidecar(&[
        OsStr::new("probe"),
        OsStr::new("--models"),
        models.as_os_str(),
        OsStr::new("--cuda"),
        cuda.as_os_str(),
    ]);

    assert_eq!(
        output.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        json(&output),
        serde_json::json!({"version": "1.1.0", "device": "cuda", "cudaError": null})
    );
}
