use super::*;

#[path = "slow_audio_onset.rs"]
mod slow_audio_onset;

fn run_media(command: &mut Command) -> Vec<u8> {
    let result = command.output().unwrap();
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    result.stdout
}

fn frame_ids(ffmpeg: &Path, path: &Path) -> Vec<u32> {
    let bytes = run_media(
        Command::new(ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(path)
            .args([
                "-map",
                "0:v:0",
                "-vf",
                "format=gray",
                "-f",
                "rawvideo",
                "pipe:1",
            ]),
    );
    assert_eq!(bytes.len() % (320 * 180), 0);
    bytes
        .chunks_exact(320 * 180)
        .map(|frame| {
            (0..8).fold(0, |id, bit| {
                id | (u32::from(frame[90 * 320 + bit * 40 + 20] > 128) << bit)
            })
        })
        .collect()
}

fn audio_measurement(ffmpeg: &Path, path: &Path) -> (f64, f64) {
    let bytes = run_media(
        Command::new(ffmpeg)
            .args(["-v", "error", "-i"])
            .arg(path)
            .args([
                "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
            ]),
    );
    let pcm: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect();
    // 2 ms RMS windows locate the high-amplitude 1000 Hz transient independently of timestamps.
    let onset = pcm
        .chunks_exact(96)
        .position(|w| w.iter().map(|v| v * v).sum::<f32>() / 96.0 > 0.04)
        .expect("missing audio transient") as f64
        * 0.002;
    let middle = &pcm[12000..pcm.len() - 12000];
    let crossings = middle
        .windows(2)
        .filter(|p| p[0] <= 0.0 && p[1] > 0.0)
        .count();
    (
        onset,
        crossings as f64 * 48000.0 / (middle.len() - 1) as f64,
    )
}

fn cadence_error(ids: &[u32], speed: f64) -> f64 {
    ids.iter()
        .enumerate()
        .map(|(i, id)| ((*id as f64 - 30.0) / speed - i as f64).abs())
        .fold(0.0, f64::max)
}

#[tokio::test]
async fn render_speed_production_compiler_actual_parity() {
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
    let ffmpeg = programs.verified_ffmpeg("speed_parity").await.unwrap();
    let ffprobe = programs.verified_ffprobe("speed_parity").await.unwrap();
    // Retain each run without overwriting browser fixtures or earlier failed artifacts.
    let artifacts = tempdir().unwrap().keep();
    println!("EXPORT_PARITY artifacts={}", artifacts.display());
    let workspace = tempdir().unwrap();
    for (rn, rd) in [(30, 1), (30000, 1001)] {
        let frame_seconds = rd as f64 / rn as f64;
        let source = artifacts.join(format!("speed-parity-{rn}-{rd}.mp4"));
        let burst = 42.0 * frame_seconds;
        run_media(Command::new(&ffmpeg).args(["-y", "-v", "error", "-f", "lavfi", "-i"])
            .arg(format!("nullsrc=s=320x180:r={rn}/{rd}:d=6,geq=lum='16+219*mod(floor(N/pow(2,floor(X/40))),2)':cb=128:cr=128"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("aevalsrc='(0.08+0.72*between(t,{burst:.9},{:.9}))*sin(2*PI*1000*t)':s=48000:d=6", burst+0.08))
            .args(["-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac"]).arg(&source));
        let source_ids = frame_ids(Path::new(&ffmpeg), &source);
        assert!(source_ids.iter().enumerate().all(|(i, id)| i as u32 == *id));
        let (source_onset, source_hz) = audio_measurement(Path::new(&ffmpeg), &source);
        assert!((source_onset - burst).abs() <= frame_seconds);
        assert!((source_hz / 1000.0 - 1.0).abs() <= 0.01);
        let grants = VideoPathGrants::default();
        let source = grants
            .grant_existing_file("owner", GrantCategory::Source, &source)
            .unwrap();
        for (sn, sd) in [(1, 2), (3, 4), (1, 1), (3, 2), (2, 1)] {
            let speed = sn as f64 / sd as f64;
            let output = grants
                .grant_destination(
                    "owner",
                    GrantCategory::Output,
                    &artifacts.join(format!("speed-parity-{rn}-{rd}-{sn}-{sd}.mp4")),
                )
                .unwrap();
            // Only fixture revision construction is JS test code: all plan metadata and argv are production output.
            let json = run_media(
                Command::new("node")
                    .arg(root.join("../browser-tests/compile-speed-export.mjs"))
                    .arg(&source)
                    .arg(&output)
                    .args([
                        rn.to_string(),
                        rd.to_string(),
                        sn.to_string(),
                        sd.to_string(),
                    ]),
            );
            let plan: Value = serde_json::from_slice(&json).unwrap();
            let validated = parse_and_validate_render_plan(plan, "owner", &grants).unwrap();
            let (request, captured) = registered_render_worker(
                validated,
                false,
                workspace.path().join(format!("cache-{rn}-{rd}-{sn}-{sd}")),
                programs.clone(),
            );
            run_render_worker(request).await;
            let events = captured_render_events(&captured);
            assert_worker_event_order(&events);
            assert!(
                matches!(events.last(), Some(VideoRenderEvent::Completed { .. })),
                "{events:?}"
            );
            let probe: Value = serde_json::from_slice(&run_media(
                Command::new(&ffprobe)
                    .args([
                        "-v",
                        "error",
                        "-show_entries",
                        "stream=codec_type,duration,avg_frame_rate",
                        "-of",
                        "json",
                    ])
                    .arg(&output),
            ))
            .unwrap();
            let streams = probe["streams"].as_array().unwrap();
            let video = streams.iter().find(|s| s["codec_type"] == "video").unwrap();
            assert_eq!(video["avg_frame_rate"], format!("{rn}/{rd}"));
            let audio = streams.iter().find(|s| s["codec_type"] == "audio").unwrap();
            let duration: f64 = audio["duration"].as_str().unwrap().parse().unwrap();
            let ids = frame_ids(Path::new(&ffmpeg), &output);
            assert_eq!(ids.len(), 60);
            let cadence = cadence_error(&ids, speed);
            let (onset, hz) = audio_measurement(Path::new(&ffmpeg), &output);
            let visual_onset = ids.iter().position(|id| *id >= 42).unwrap() as f64 * frame_seconds;
            println!("EXPORT_PARITY rate={rn}/{rd} speed={sn}/{sd} cadence_frames={cadence:.3} transient={onset:.6} visual={visual_onset:.6} hz={hz:.6} audio_duration={duration:.6} artifact={}", output.display());
            assert!(cadence <= 1.0, "wrong decoded frame identity/cadence");
            assert!(
                (onset - 12.0 * frame_seconds / speed).abs() <= frame_seconds,
                "transient timing"
            );
            assert!(
                (onset - visual_onset).abs() <= frame_seconds,
                "A/V transient offset"
            );
            assert!((hz / 1000.0 - 1.0).abs() <= 0.01, "pitch");
            assert!(
                (duration - 60.0 * frame_seconds).abs() <= frame_seconds,
                "audio duration"
            );
            // Actual correctly-rendered 2x media MUST fail a detector expecting 1x.
            if sn == 2 {
                assert!(cadence_error(&ids, 1.0) > 1.0);
            }
        }
        // Measurement-only negative control, never accepted as a native plan: intentional sample-rate pitch shift.
        let control = workspace.path().join(format!("pitch-control-{rn}.mp4"));
        run_media(
            Command::new(&ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(&source)
                .args([
                    "-vn",
                    "-af",
                    "asetrate=52800,aresample=48000",
                    "-c:a",
                    "aac",
                ])
                .arg(&control),
        );
        let (_, wrong_hz) = audio_measurement(Path::new(&ffmpeg), &control);
        println!("EXPORT_PARITY negative_pitch_hz={wrong_hz:.6}");
        assert!(
            (wrong_hz / 1000.0 - 1.0).abs() > 0.01,
            "pitch detector accepted shifted media"
        );
    }
}

#[tokio::test]
async fn render_multilayer_production_compiler_independent_hidden_and_muted() {
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
    let ffmpeg = programs.verified_ffmpeg("multilayer_parity").await.unwrap();
    let ffprobe = programs
        .verified_ffprobe("multilayer_parity")
        .await
        .unwrap();
    let artifacts = root.join("../browser-tests");
    let workspace = tempdir().unwrap();
    let grants = VideoPathGrants::default();
    let mut sources = Vec::new();
    for (color, hz) in [("red", 700), ("blue", 1300)] {
        let path = artifacts.join(format!("completion-layer-{color}.mp4"));
        run_media(
            Command::new(&ffmpeg)
                .args(["-y", "-v", "error", "-f", "lavfi", "-i"])
                .arg(format!("color=c={color}:s=320x180:r=30:d=6"))
                .args(["-f", "lavfi", "-i"])
                .arg(format!("sine=frequency={hz}:sample_rate=48000:duration=6"))
                .args([
                    "-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac",
                ])
                .arg(&path),
        );
        sources.push(
            grants
                .grant_existing_file("owner", GrantCategory::Source, &path)
                .unwrap(),
        );
    }
    for mode in ["normal", "muted", "hidden", "both"] {
        let output = grants
            .grant_destination(
                "owner",
                GrantCategory::Output,
                &artifacts.join(format!("completion-layer-{mode}.mp4")),
            )
            .unwrap();
        let plan: Value = serde_json::from_slice(&run_media(
            Command::new("node")
                .arg(artifacts.join("compile-multilayer-export.mjs"))
                .args([&sources[0], &sources[1], &output])
                .arg(mode),
        ))
        .unwrap();
        let validated = parse_and_validate_render_plan(plan, "owner", &grants).unwrap();
        let (request, captured) = registered_render_worker(
            validated,
            false,
            workspace.path().join(mode),
            programs.clone(),
        );
        if output.exists() {
            fs::remove_file(&output).unwrap();
        }
        run_render_worker(request).await;
        let events = captured_render_events(&captured);
        assert_worker_event_order(&events);
        assert!(
            matches!(events.last(), Some(VideoRenderEvent::Completed { .. })),
            "{events:?}"
        );
        let probe: Value = serde_json::from_slice(&run_media(
            Command::new(&ffprobe)
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=codec_type,avg_frame_rate,duration",
                    "-of",
                    "json",
                ])
                .arg(&output),
        ))
        .unwrap();
        let streams = probe["streams"].as_array().unwrap();
        let video = streams
            .iter()
            .find(|stream| stream["codec_type"] == "video")
            .unwrap();
        assert_eq!(video["avg_frame_rate"], "30/1");
        let audio = streams
            .iter()
            .find(|stream| stream["codec_type"] == "audio")
            .unwrap();
        let duration: f64 = audio["duration"].as_str().unwrap().parse().unwrap();
        assert!((duration - 2.0).abs() <= 1.0 / 30.0);
        let pixels = run_media(
            Command::new(&ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(&output)
                .args([
                    "-map", "0:v:0", "-pix_fmt", "rgb24", "-f", "rawvideo", "pipe:1",
                ]),
        );
        assert_eq!(pixels.len(), 60 * 320 * 180 * 3);
        for frame in pixels.chunks_exact(320 * 180 * 3) {
            let pixel = &frame[(90 * 320 + 160) * 3..][..3];
            let hidden = matches!(mode, "hidden" | "both");
            assert!(
                if hidden {
                    pixel[2] > 200 && pixel[0] < 30
                } else {
                    pixel[0] > 200 && pixel[2] < 30
                },
                "{mode}: {pixel:?}"
            );
        }
        let bytes = run_media(
            Command::new(&ffmpeg)
                .args(["-v", "error", "-i"])
                .arg(&output)
                .args([
                    "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
                ]),
        );
        let pcm: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
            .collect();
        // Interior window excludes AAC priming and atempo edge transients. Projection
        // at each known frequency distinguishes the two simultaneous sources.
        let samples = &pcm[24000..72000];
        let amplitude = |hz: f64| {
            let (sin, cos) = samples
                .iter()
                .enumerate()
                .fold((0.0, 0.0), |(s, c), (i, sample)| {
                    let phase = 2.0 * std::f64::consts::PI * hz * i as f64 / 48000.0;
                    (
                        s + f64::from(*sample) * phase.sin(),
                        c + f64::from(*sample) * phase.cos(),
                    )
                });
            2.0 * sin.hypot(cos) / samples.len() as f64
        };
        let red = amplitude(700.0);
        let blue = amplitude(1300.0);
        assert!(blue > 0.08, "{mode}: missing bottom-layer tone {blue}");
        if matches!(mode, "muted" | "both") {
            assert!(red < 0.005, "{mode}: mute leaked {red}");
        } else {
            assert!(red > 0.08, "{mode}: hidden suppressed audio {red}");
        }
        println!("MULTILAYER_PARITY mode={mode} frames=60 rate=30/1 red700={red:.6} blue1300={blue:.6} artifact={}", output.display());
    }
    let unsupported: Value = serde_json::from_slice(&run_media(
        Command::new("node")
            .arg(artifacts.join("compile-multilayer-export.mjs"))
            .args([&sources[0], &sources[1], &workspace.path().join("gap.mp4")])
            .arg("gap"),
    ))
    .unwrap();
    assert_eq!(unsupported["eligible"], false);
    assert!(unsupported["reason"]
        .as_str()
        .unwrap()
        .contains("timeline zero"));
}
