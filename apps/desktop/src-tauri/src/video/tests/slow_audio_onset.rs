use super::*;

// Offline generated media only. Retain every run (including failures), never overwrite fixtures.
#[tokio::test]
async fn render_silent_onset_production_compiler_actual_parity() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let workspace = tempfile::Builder::new()
        .prefix("slow-audio-onset-")
        .tempdir()
        .unwrap()
        .keep();
    println!("SILENT_ONSET artifacts={}", workspace.display());
    let resources = tempdir().unwrap();
    let destination = resources.path().join("media-tools");
    fs::create_dir(&destination).unwrap();
    for name in ["ffmpeg.exe", "ffprobe.exe"] {
        fs::copy(
            root.join("media-toolchain/bin/x86_64-pc-windows-msvc")
                .join(name),
            destination.join(name),
        )
        .unwrap();
    }
    let programs = MediaPrograms::bundled(
        super::super::super::toolchain::MediaToolchainState::from_ready(
            super::super::super::toolchain::MediaToolchain::resolve_from_resource_root(
                resources.path(),
            ),
        ),
    );
    let ffmpeg = programs.verified_ffmpeg("silent_onset").await.unwrap();
    let ffprobe = programs.verified_ffprobe("silent_onset").await.unwrap();
    let grants = VideoPathGrants::default();
    let mut failures = Vec::new();
    for (rn, rd) in [(30, 1), (30000, 1001)] {
        let frame = rd as f64 / rn as f64;
        let source = workspace.join(format!("source-{rn}-{rd}.mp4"));
        run_media(Command::new(&ffmpeg).args(["-v", "error", "-nostdin", "-f", "lavfi", "-i"])
            .arg(format!("nullsrc=s=320x180:r={rn}/{rd}:d=6,geq=lum='16+219*mod(floor(N/pow(2,floor(X/40))),2)':cb=128:cr=128"))
            .args(["-f", "lavfi", "-i"])
            .arg(format!("aevalsrc='if(between(t,{:.9},{:.9}),0.25*sin(2*PI*1000*t),0)':s=48000:d=6", 42.0*frame, 48.0*frame))
            .args(["-c:v", "libx264", "-crf", "0", "-pix_fmt", "yuv420p", "-c:a", "aac"]).arg(&source));
        let source = grants
            .grant_existing_file("owner", GrantCategory::Source, &source)
            .unwrap();
        for (sn, sd) in [(1, 2), (3, 4), (1, 1), (3, 2), (2, 1)] {
            let speed = sn as f64 / sd as f64;
            let label = format!("{rn}-{rd}-{sn}-{sd}");
            let output = grants
                .grant_destination(
                    "owner",
                    GrantCategory::Output,
                    &workspace.join(format!("{label}.mp4")),
                )
                .unwrap();
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
            fs::write(workspace.join(format!("{label}-plan.json")), &json).unwrap();
            let plan: Value = serde_json::from_slice(&json).unwrap();
            let validated = parse_and_validate_render_plan(plan, "owner", &grants).unwrap();
            let (request, captured) = registered_render_worker(
                validated,
                false,
                workspace.join(format!("cache-{label}")),
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
                        "stream=codec_type,avg_frame_rate,duration",
                        "-of",
                        "json",
                    ])
                    .arg(&output),
            ))
            .unwrap();
            let streams = probe["streams"].as_array().unwrap();
            assert_eq!(
                streams.iter().find(|s| s["codec_type"] == "video").unwrap()["avg_frame_rate"],
                format!("{rn}/{rd}")
            );
            let duration: f64 = streams.iter().find(|s| s["codec_type"] == "audio").unwrap()
                ["duration"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap();
            let ids = frame_ids(Path::new(&ffmpeg), &output);
            assert_eq!(ids.len(), 60);
            assert!(cadence_error(&ids, speed) <= 1.0);
            let bytes = run_media(
                Command::new(&ffmpeg)
                    .args(["-v", "error", "-i"])
                    .arg(&output)
                    .args([
                        "-map", "0:a:0", "-ac", "1", "-ar", "48000", "-f", "f32le", "pipe:1",
                    ]),
            );
            fs::write(workspace.join(format!("{label}.f32")), &bytes).unwrap();
            let pcm: Vec<f32> = bytes
                .chunks_exact(4)
                .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
                .collect();
            let first = pcm
                .iter()
                .position(|s| s.abs() > 0.005)
                .expect("missing tone");
            let last = pcm.iter().rposition(|s| s.abs() > 0.005).unwrap();
            let onset = first as f64 / 48000.0;
            let end = last as f64 / 48000.0;
            let interior = &pcm[first + 960..last - 960];
            let crossings: Vec<usize> = interior
                .windows(2)
                .enumerate()
                .filter(|(_, p)| p[0] <= 0.0 && p[1] > 0.0)
                .map(|(i, _)| i)
                .collect();
            let hz = (crossings.len() - 1) as f64 * 48000.0
                / (crossings.last().unwrap() - crossings[0]) as f64;
            let onset_error = onset - 12.0 * frame / speed;
            let end_error = end - 18.0 * frame / speed;
            let row = format!("{label} onset_error={onset_error:.9} end_error={end_error:.9} hz={hz:.6} duration={duration:.6}");
            println!("SILENT_ONSET {row}");
            fs::write(workspace.join(format!("{label}-measurement.txt")), &row).unwrap();
            if onset_error.abs() > frame
                || end_error.abs() > frame
                || (hz / 1000.0 - 1.0).abs() > 0.01
                || (duration - 60.0 * frame).abs() > frame
            {
                failures.push(row);
            }
        }
    }
    assert!(
        failures.is_empty(),
        "silent onset/end/pitch failures: {failures:#?}; artifacts={}",
        workspace.display()
    );
}
