//! Real exports of the role-based mix through the production path: TS
//! compiler (node) → native plan validation → render worker (two-pass
//! loudnorm + ebur128 verification) → bundled FFmpeg.

use super::*;

fn run_ffmpeg(binary: &Path, arguments: &[&str]) -> Vec<u8> {
    let output = std::process::Command::new(binary)
        .args(["-hide_banner", "-nostdin", "-v", "error"])
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    output.stdout
}

fn window_rms_db(samples: &[f32], start: f64, end: f64) -> f64 {
    let lo = (start * 48_000.0) as usize;
    let hi = ((end * 48_000.0) as usize).min(samples.len());
    let power = samples[lo..hi]
        .iter()
        .map(|value| f64::from(*value).powi(2))
        .sum::<f64>()
        / (hi - lo) as f64;
    10.0 * power.max(1e-12).log10()
}

struct Fixture {
    directory: PathBuf,
    binary: PathBuf,
    programs: MediaPrograms,
    grants: VideoPathGrants,
    speech: PathBuf,
    music: PathBuf,
}

async fn fixture() -> Fixture {
    let resources = tempdir().unwrap().keep();
    let destination = resources.join("media-tools");
    fs::create_dir(&destination).unwrap();
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    for name in ["ffmpeg.exe", "ffprobe.exe"] {
        fs::copy(
            root.join("media-toolchain/bin/x86_64-pc-windows-msvc")
                .join(name),
            destination.join(name),
        )
        .unwrap();
    }
    let programs =
        MediaPrograms::bundled(super::super::toolchain::MediaToolchainState::from_ready(
            super::super::toolchain::MediaToolchain::resolve_from_resource_root(&resources),
        ));
    let binary = PathBuf::from(programs.verified_ffmpeg("audio_mix").await.unwrap());
    let directory = tempdir().unwrap().keep();
    println!("AUDIO_MIX artifacts={}", directory.display());
    // Speech: 1 s silence, 3 s of 300 Hz voice-band tone at a typical dialogue
    // level (about -17 dBFS RMS), then silence (the
    // "last word" ends at 4 s). Music: steady 110 Hz bed for all 8 s.
    let speech = directory.join("speech.mp4");
    run_ffmpeg(
        &binary,
        &[
            "-f", "lavfi", "-i", "color=c=black:s=320x180:r=30:d=8",
            "-f", "lavfi", "-i",
            "sine=frequency=300:sample_rate=48000:duration=8,volume='if(between(t,1,4),1.6,0)':eval=frame",
            "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-b:a", "192k", "-t", "8", "-n",
            speech.to_str().unwrap(),
        ],
    );
    let music = directory.join("music.mp4");
    run_ffmpeg(
        &binary,
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:r=30:d=8",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=110:sample_rate=48000:duration=8,volume=0.25",
            "-c:v",
            "libx264",
            "-preset",
            "ultrafast",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-t",
            "8",
            "-n",
            music.to_str().unwrap(),
        ],
    );
    let grants = VideoPathGrants::default();
    let speech = grants
        .grant_existing_file("mix", GrantCategory::Source, &speech)
        .unwrap();
    let music = grants
        .grant_existing_file("mix", GrantCategory::Source, &music)
        .unwrap();
    Fixture {
        directory,
        binary,
        programs,
        grants,
        speech,
        music,
    }
}

async fn export(
    fixture: &Fixture,
    name: &str,
    lufs: &str,
    ducking: bool,
    cleanup: bool,
) -> (Vec<VideoRenderEvent>, PathBuf) {
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let output = fixture
        .grants
        .grant_destination(
            "mix",
            GrantCategory::Output,
            &fixture.directory.join(format!("{name}.mp4")),
        )
        .unwrap();
    let compiled = std::process::Command::new("node")
        .arg(repo.join("apps/desktop/browser-tests/compile-audio-mix-export.mjs"))
        .args([
            fixture.speech.to_str().unwrap(),
            fixture.music.to_str().unwrap(),
            output.to_str().unwrap(),
            lufs,
            if ducking { "1" } else { "0" },
            if cleanup { "1" } else { "0" },
            "8",
        ])
        .current_dir(&repo)
        .output()
        .unwrap();
    assert!(
        compiled.status.success(),
        "{}",
        String::from_utf8_lossy(&compiled.stderr)
    );
    let plan = parse_and_validate_render_plan(
        serde_json::from_slice(&compiled.stdout).unwrap(),
        "mix",
        &fixture.grants,
    )
    .unwrap();
    let (request, captured) = registered_render_worker(
        plan,
        false,
        fixture.directory.join(format!("cache-{name}")),
        fixture.programs.clone(),
    );
    let started = std::time::Instant::now();
    run_render_worker(request).await;
    println!(
        "AUDIO_MIX {name} export_ms={}",
        started.elapsed().as_millis()
    );
    (captured_render_events(&captured), output)
}

fn decoded(fixture: &Fixture, path: &Path) -> Vec<f32> {
    run_ffmpeg(
        &fixture.binary,
        &[
            "-i",
            path.to_str().unwrap(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "48000",
            "-f",
            "f32le",
            "pipe:1",
        ],
    )
    .as_chunks::<4>()
    .0
    .iter()
    .map(|bytes| f32::from_le_bytes(*bytes))
    .collect()
}

#[cfg(windows)]
#[tokio::test]
async fn render_role_mix_ducks_music_and_meets_each_loudness_target() {
    let fixture = fixture().await;

    // Baseline: roles without a target keep the legacy mix (no ducking).
    let (events, legacy) = export(&fixture, "legacy", "none", false, false).await;
    assert!(
        matches!(events.last(), Some(VideoRenderEvent::Completed { .. })),
        "{events:?}"
    );
    let legacy_pcm = decoded(&fixture, &legacy);

    for lufs in ["-14", "-16", "-23"] {
        let (events, output) = export(&fixture, &format!("mix{lufs}"), lufs, true, true).await;
        let Some(VideoRenderEvent::Completed { output: result, .. }) = events.last() else {
            panic!("export {lufs} did not complete: {events:?}");
        };
        let report = result
            .loudness_report
            .as_ref()
            .expect("normalized exports carry a loudness report");
        println!(
            "AUDIO_MIX report {lufs} {}",
            serde_json::to_string(report).unwrap()
        );
        assert!(report.passed, "{report:?}");
        let target: f64 = lufs.parse().unwrap();
        assert!((report.output_integrated_lufs.unwrap() - target).abs() <= 1.0);
        assert!(report.output_true_peak_dbtp.unwrap() <= -1.0);

        // After the last word (speech ends at 4 s, release 600 ms) only music
        // remains; with a padded key it plays at the same normalized gain as
        // before speech began, i.e. nothing cut it off or left it ducked.
        let pcm = decoded(&fixture, &output);
        let gain = window_rms_db(&pcm, 0.2, 0.8) - window_rms_db(&legacy_pcm, 0.2, 0.8);
        let after = window_rms_db(&pcm, 6.0, 7.5) - window_rms_db(&legacy_pcm, 6.0, 7.5);
        println!(
            "AUDIO_MIX {lufs} mode={:?} gain_before_speech_db={gain:.2} gain_after_speech_db={after:.2} music_after_speech_dbfs={:.2}",
            report.normalization_mode,
            window_rms_db(&pcm, 6.0, 7.5)
        );
        assert!(
            window_rms_db(&pcm, 6.0, 7.5) > -60.0,
            "music must continue after the last word (padded key)"
        );
        if report.normalization_mode == super::super::audio_mix::NormalizationMode::Measured {
            assert!(
                (after - gain).abs() < 1.0,
                "linear normalization: music after speech keeps the pre-speech gain"
            );
        }
    }
}

#[cfg(windows)]
#[tokio::test]
async fn render_ducking_music_is_attenuated_while_dialogue_plays() {
    let fixture = fixture().await;
    // Separate the effect of ducking from normalization: identical targets with
    // and without ducking; compare the music band under speech.
    let (_, ducked) = export(&fixture, "ducked", "-16", true, false).await;
    let (_, plain) = export(&fixture, "plain", "-16", false, false).await;
    let bandpass = |path: &Path| -> Vec<f32> {
        run_ffmpeg(
            &fixture.binary,
            &[
                "-i",
                path.to_str().unwrap(),
                "-vn",
                "-af",
                "lowpass=f=150,lowpass=f=150",
                "-ac",
                "1",
                "-ar",
                "48000",
                "-f",
                "f32le",
                "pipe:1",
            ],
        )
        .as_chunks::<4>()
        .0
        .iter()
        .map(|bytes| f32::from_le_bytes(*bytes))
        .collect()
    };
    let (ducked, plain) = (bandpass(&ducked), bandpass(&plain));
    let under_speech = window_rms_db(&ducked, 2.0, 3.5) - window_rms_db(&plain, 2.0, 3.5);
    let after_speech = window_rms_db(&ducked, 6.0, 7.5) - window_rms_db(&plain, 6.0, 7.5);
    println!(
        "AUDIO_MIX ducking music_under_speech_delta_db={under_speech:.2} music_after_speech_delta_db={after_speech:.2}"
    );
    assert!(
        under_speech - after_speech < -6.0,
        "music must duck at least 6 dB more under speech than after it"
    );
}
