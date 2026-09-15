use super::*;

fn ffmpeg(binary: &Path, arguments: &[&str]) -> Vec<u8> {
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
fn rms(samples: &[f32], start: f64, end: f64) -> f64 {
    let lo = (start * 48_000.0) as usize;
    let hi = (end * 48_000.0) as usize;
    assert!(hi <= samples.len() && lo < hi);
    (samples[lo..hi]
        .iter()
        .map(|v| f64::from(*v).powi(2))
        .sum::<f64>()
        / (hi - lo) as f64)
        .sqrt()
}

#[cfg(windows)]
#[tokio::test]
async fn render_audio_gain_and_fades_actual_compiler_output() {
    let resources = tempdir().unwrap();
    let destination = resources.path().join("media-tools");
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
            super::super::toolchain::MediaToolchain::resolve_from_resource_root(resources.path()),
        ));
    let binary = programs.verified_ffmpeg("audio_parity").await.unwrap();
    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let directory = tempdir().unwrap();
    let input = directory.path().join("quiet-tone.mp4");
    ffmpeg(
        Path::new(&binary),
        &[
            "-f",
            "lavfi",
            "-i",
            "color=c=black:s=320x180:r=30:d=6",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=1000:sample_rate=48000:duration=6",
            "-af",
            "volume=0.1",
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
            "6",
            "-n",
            input.to_str().unwrap(),
        ],
    );
    let grants = VideoPathGrants::default();
    let input = grants
        .grant_existing_file("audio", GrantCategory::Source, &input)
        .unwrap();
    let mut reference = None;
    for (index, (gain, fade, numerator, denominator)) in [
        (0, false, 1, 1),
        (-6000, false, 1, 1),
        (24000, false, 1, 1),
        (0, true, 1, 1),
        (6000, true, 2, 1),
    ]
    .into_iter()
    .enumerate()
    {
        let output_path = grants
            .grant_destination(
                "audio",
                GrantCategory::Output,
                &directory.path().join(format!("audio-{index}.mp4")),
            )
            .unwrap();
        let compiled = std::process::Command::new("node")
            .arg(repo.join("apps/desktop/browser-tests/compile-speed-export.mjs"))
            .args([
                input.to_str().unwrap(),
                output_path.to_str().unwrap(),
                "30",
                "1",
                &numerator.to_string(),
                &denominator.to_string(),
                &gain.to_string(),
                if fade { "15" } else { "0" },
                if fade { "15" } else { "0" },
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
            "audio",
            &grants,
        )
        .unwrap();
        let (request, captured) = registered_render_worker(
            plan,
            false,
            directory.path().join(format!("cache-{index}")),
            programs.clone(),
        );
        run_render_worker(request).await;
        let events = captured_render_events(&captured);
        assert_worker_event_order(&events);
        assert!(
            matches!(events.last(), Some(VideoRenderEvent::Completed { .. })),
            "{events:?}"
        );
        let pcm = ffmpeg(
            Path::new(&binary),
            &[
                "-i",
                output_path.to_str().unwrap(),
                "-vn",
                "-ac",
                "1",
                "-ar",
                "48000",
                "-f",
                "f32le",
                "pipe:1",
            ],
        );
        let samples: Vec<f32> = pcm
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        let plateau = rms(&samples, 0.8, 1.2);
        let baseline = *reference.get_or_insert(plateau);
        let expected = 10_f64.powf(f64::from(gain) / 20_000.0);
        assert!(
            (plateau / baseline / expected - 1.0).abs() < 0.02,
            "gain {gain}: actual {}, expected {expected}",
            plateau / baseline
        );
        if fade {
            // Windows span is 0.1s around 0.2s; RMS of the linear ramp is
            // sqrt(mean((t/0.5)^2)), about0.404, rather than its mean amplitude.
            let target =
                ((0.25_f64.powi(3) - 0.15_f64.powi(3)) / (3.0 * 0.1 * 0.5_f64.powi(2))).sqrt();
            for measured in [rms(&samples, 0.15, 0.25), rms(&samples, 1.75, 1.85)] {
                assert!(
                    (measured / plateau - target).abs() < 0.04,
                    "fade envelope ratio {} expected {target}",
                    measured / plateau
                );
            }
            assert!(rms(&samples, 0.0, 0.04) / plateau < 0.12);
        }
        println!("AUDIO_EXPORT gainMilliDb={gain} fades={fade} speed={numerator}/{denominator} gainRatio={}", plateau / baseline);
    }
}
