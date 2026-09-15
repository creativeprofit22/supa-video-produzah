use super::*;

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
    // Ignored MP4 artifacts deliberately survive for the existing Vite browser-tests route.
    let artifacts = root.join("../browser-tests");
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
        for (sn, sd) in [(1, 2), (1, 1), (3, 2), (2, 1)] {
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
                    .arg(artifacts.join("compile-speed-export.mjs"))
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
            // Repeated runs retain artifacts but the real renderer does not overwrite existing output.
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
