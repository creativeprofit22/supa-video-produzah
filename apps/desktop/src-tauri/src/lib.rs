pub mod video;

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
fn manage_media_toolchain<R: Runtime>(
    app: &tauri::App<R>,
    state: video::toolchain::MediaToolchainState,
) {
    app.manage(state);
}

#[cfg(all(not(test), feature = "desktop-runtime"))]
fn configure_builder<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(video::VideoPathGrants::default())
        .manage(video::VideoRenderJobs::default())
        .manage(video::VideoProjectService::default())
        .setup(|app| {
            manage_media_toolchain(
                app,
                video::toolchain::MediaToolchainState::start_for_app(app.handle()),
            );
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            video::probe::video_ffmpeg_status,
            video::probe::video_probe_media,
            video::project_io::video_pick_source,
            video::derived::video_prepare_asset,
            video::render::video_start_render,
            video::render::video_cancel_render,
            video::project_io::video_pick_new_project_path,
            video::project::ipc::video_create_project,
            video::project::ipc::video_open_project,
            video::project::ipc::video_execute_project_group,
            video::project::ipc::video_undo_project,
            video::project::ipc::video_redo_project,
            video::project::ipc::video_project_inspector,
            video::project::ipc::video_relink_project_asset,
            video::project::ipc::video_close_project,
            video::project_io::video_regrant_project_source,
            video::project_io::video_pick_export_path,
        ])
        .on_window_event(clean_up_video_state_on_destroyed)
}

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
fn clean_up_video_state_on_destroyed<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        let _ = window
            .state::<video::VideoProjectService>()
            .close_owner(window.label());
        let _ = window
            .state::<video::VideoRenderJobs>()
            .cancel_owner(window.label());
        let _ = window
            .state::<video::VideoPathGrants>()
            .revoke_window(window.label());
    }
}

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
fn clean_up_video_state_on_exit<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
        let _ = app.state::<video::VideoProjectService>().close_all();
        let _ = app.state::<video::VideoRenderJobs>().cancel_all();
    }
}

#[cfg(all(not(test), feature = "desktop-runtime"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = configure_builder(tauri::Builder::default())
        .build(tauri::generate_context!())
        .expect("error while building Supa Video Producer");
    app.run(|app, event| clean_up_video_state_on_exit(app, &event));
}

#[cfg(all(test, feature = "tauri-ipc-test"))]
mod tests {
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{mpsc, Arc, Mutex},
        time::{Duration, Instant},
    };

    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
        webview::InvokeRequest,
        Listener, Manager, RunEvent, WebviewWindowBuilder, WindowEvent,
    };

    use super::{
        clean_up_video_state_on_destroyed, clean_up_video_state_on_exit, manage_media_toolchain,
        video,
    };

    fn invoke_request(command: &str, body: Value) -> InvokeRequest {
        InvokeRequest {
            cmd: command.to_owned(),
            callback: CallbackFn(0),
            error: CallbackFn(1),
            url: if cfg!(any(windows, target_os = "android")) {
                "http://tauri.localhost"
            } else {
                "tauri://localhost"
            }
            .parse()
            .expect("test invoke URL must parse"),
            body: InvokeBody::Json(body),
            headers: Default::default(),
            invoke_key: INVOKE_KEY.to_owned(),
        }
    }

    fn mock_video_app() -> tauri::App<tauri::test::MockRuntime> {
        mock_builder()
            .manage(video::VideoPathGrants::default())
            .manage(video::VideoRenderJobs::default())
            .manage(video::VideoProjectService::default())
            .manage(video::toolchain::MediaToolchainState::from_ready(
                video::toolchain::MediaToolchain::from_test_programs(
                    PathBuf::from("ffmpeg"),
                    PathBuf::from("ffprobe"),
                ),
            ))
            .invoke_handler(tauri::generate_handler![
                video::probe::video_ffmpeg_status,
                video::probe::video_probe_media,
                video::derived::video_prepare_asset,
                video::render::video_start_render,
                video::render::video_cancel_render,
                video::project::ipc::video_create_project,
                video::project::ipc::video_execute_project_group,
                video::project::ipc::video_undo_project,
                video::project::ipc::video_redo_project,
                video::project::ipc::video_project_inspector,
                video::project::ipc::video_relink_project_asset,
                video::project::ipc::video_close_project,
                video::project_io::video_regrant_project_source,
                video::project_io::video_save_project,
            ])
            .on_window_event(clean_up_video_state_on_destroyed)
            .build(mock_context(noop_assets()))
            .expect("video IPC smoke app must build")
    }

    fn mock_video_app_with_toolchain(
        toolchain: video::toolchain::MediaToolchain,
    ) -> tauri::App<tauri::test::MockRuntime> {
        mock_builder()
            .manage(video::VideoPathGrants::default())
            .manage(video::VideoRenderJobs::default())
            .manage(video::VideoProjectService::default())
            .manage(video::toolchain::MediaToolchainState::from_ready(toolchain))
            .invoke_handler(tauri::generate_handler![
                video::probe::video_ffmpeg_status,
                video::probe::video_probe_media,
                video::derived::video_prepare_asset,
                video::render::video_start_render,
                video::render::video_cancel_render,
            ])
            .build(mock_context(noop_assets()))
            .expect("media-integrity IPC app must build")
    }

    #[tokio::test(flavor = "current_thread")]
    async fn toolchain_setup_registers_resolving_state_without_waiting_for_blocking_resolution() {
        let (started_sender, started_receiver) = tokio::sync::oneshot::channel();
        let started_sender = Arc::new(Mutex::new(Some(started_sender)));
        let (release_sender, release_receiver) = mpsc::channel();
        let release_receiver = Arc::new(Mutex::new(release_receiver));
        let app = mock_builder()
            .build(mock_context(noop_assets()))
            .expect("toolchain setup app must build");
        manage_media_toolchain(
            &app,
            video::toolchain::MediaToolchainState::start_for_test(
                Duration::from_secs(5),
                move || {
                    if let Some(started_sender) = started_sender
                        .lock()
                        .expect("setup resolver start signal must lock")
                        .take()
                    {
                        started_sender
                            .send(())
                            .expect("setup resolver start must be observable");
                    }
                    release_receiver
                        .lock()
                        .expect("setup resolver latch must lock")
                        .recv()
                        .expect("setup resolver latch must be released");
                    Ok(video::toolchain::MediaToolchain::from_test_programs(
                        PathBuf::from("ffmpeg"),
                        PathBuf::from("ffprobe"),
                    ))
                },
            ),
        );
        tokio::time::timeout(Duration::from_secs(1), started_receiver)
            .await
            .expect("blocking resolver must start before the deadline")
            .expect("blocking resolver must report its start");
        let state = app.state::<video::toolchain::MediaToolchainState>();
        assert_eq!(
            state.phase_for_test(),
            video::toolchain::MediaToolchainProblemOrPhase::Resolving
        );

        release_sender
            .send(())
            .expect("blocking resolver must be releasable");
        tokio::time::timeout(Duration::from_secs(1), async {
            while state.phase_for_test()
                == video::toolchain::MediaToolchainProblemOrPhase::Resolving
            {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .expect("released toolchain resolver must settle");
        assert_eq!(
            state.phase_for_test(),
            video::toolchain::MediaToolchainProblemOrPhase::Ready
        );
    }

    #[test]
    fn video_status_is_reachable_over_ipc_and_unknown_commands_stay_rejected() {
        let app = mock_video_app();
        let webview = WebviewWindowBuilder::new(&app, "main", Default::default())
            .build()
            .expect("test webview must build");

        let status = get_ipc_response(&webview, invoke_request("video_ffmpeg_status", json!({})))
            .expect("registered status command must return")
            .deserialize::<Value>()
            .expect("status response must be JSON");
        assert_eq!(status["source"], "bundled");
        assert_eq!(
            status["toolchainId"],
            "ffmpeg-8.1.2-gyan-essentials-windows-x86_64"
        );
        assert!(status.get("ffmpeg").is_some());
        assert!(status.get("ffprobe").is_some());
        assert!(status.get("ready").is_some());
        let serialized = serde_json::to_string(&status).expect("status must serialize");
        assert!(!serialized.contains("ffmpegProgram"));
        assert!(!serialized.contains("ffprobeProgram"));
        assert!(!serialized.contains("buildconf"));

        let injected = get_ipc_response(
            &webview,
            invoke_request(
                "video_ffmpeg_status",
                json!({
                    "ffmpegProgram": "C:\\attacker\\ffmpeg.exe",
                    "ffprobeProgram": "C:\\attacker\\ffprobe.exe"
                }),
            ),
        )
        .expect("unknown tool-path fields cannot redirect the status command")
        .deserialize::<Value>()
        .expect("injection-shaped status response must be JSON");
        assert_eq!(injected["source"], "bundled");
        assert_eq!(
            injected["toolchainId"],
            "ffmpeg-8.1.2-gyan-essentials-windows-x86_64"
        );
        assert!(!serde_json::to_string(&injected)
            .expect("status must serialize")
            .contains("attacker"));

        let unknown = get_ipc_response(
            &webview,
            invoke_request("video_command_that_does_not_exist", json!({})),
        )
        .expect_err("unknown commands must remain unreachable");
        assert!(
            unknown
                .as_str()
                .is_some_and(|message| message.contains("not found")),
            "unexpected unknown-command response: {unknown}"
        );
    }

    #[test]
    fn video_status_preserves_asymmetric_failures_over_ipc() {
        let cases = [
            (
                "ffmpeg-only-failure",
                Err(video::toolchain::MediaToolchainError::for_test(
                    video::toolchain::MediaToolchainProblem::IncompatibleBuild,
                )),
                Ok("private FFprobe inspection output".to_owned()),
                json!({
                    "source": "bundled",
                    "toolchainId": "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
                    "ffmpeg": { "available": false, "problem": "incompatible_build" },
                    "ffprobe": { "available": true, "version": "8.1.2" },
                    "ready": false
                }),
            ),
            (
                "ffprobe-only-failure",
                Ok("private FFmpeg inspection output".to_owned()),
                Err(video::toolchain::MediaToolchainError::for_test(
                    video::toolchain::MediaToolchainProblem::NotFound,
                )),
                json!({
                    "source": "bundled",
                    "toolchainId": "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
                    "ffmpeg": { "available": true, "version": "8.1.2" },
                    "ffprobe": { "available": false, "problem": "not_found" },
                    "ready": false
                }),
            ),
        ];

        for (window_label, ffmpeg_version, ffprobe_version, expected) in cases {
            let toolchain = video::toolchain::MediaToolchain::from_test_inspection(
                ffmpeg_version,
                ffprobe_version,
            );
            let app = mock_video_app_with_toolchain(toolchain);
            let webview = WebviewWindowBuilder::new(&app, window_label, Default::default())
                .build()
                .expect("asymmetric status webview must build");
            let status =
                get_ipc_response(&webview, invoke_request("video_ffmpeg_status", json!({})))
                    .expect("asymmetric status command must return")
                    .deserialize::<Value>()
                    .expect("asymmetric status response must be JSON");

            assert_eq!(status, expected);
            let serialized = serde_json::to_string(&status).expect("status must serialize");
            assert!(!serialized.contains("private"));
            assert!(!serialized.contains("inspection output"));
        }
    }

    #[test]
    fn post_resolution_replacement_blocks_status_probe_prepare_and_render_before_spawn() {
        const OWNER: &str = "integrity-owner";
        const PLAN_ID: &str = "55555555-5555-4555-8555-555555555555";
        let workspace = tempfile::tempdir().expect("integrity workspace must exist");
        let resource_root = workspace.path().join("resources");
        let media_tools = resource_root.join("media-tools");
        fs::create_dir_all(&media_tools).expect("test media resource directory must exist");
        let ffmpeg_bytes = b"trusted ffmpeg fixture";
        let ffprobe_bytes = b"trusted ffprobe fixture";
        fs::write(media_tools.join("ffmpeg.exe"), ffmpeg_bytes)
            .expect("trusted FFmpeg fixture must be writable");
        let ffprobe_path = media_tools.join("ffprobe.exe");
        fs::write(&ffprobe_path, ffprobe_bytes).expect("trusted FFprobe fixture must be writable");
        let toolchain = video::toolchain::MediaToolchain::resolve_test_bundled_programs(
            &resource_root,
            ffmpeg_bytes,
            ffprobe_bytes,
        )
        .expect("trusted fixtures must resolve before replacement");

        let mut replacement = ffprobe_bytes.to_vec();
        replacement[0] ^= 0xff;
        fs::write(&ffprobe_path, &replacement)
            .expect("exactly one resolved binary must be replaceable");

        let app = mock_video_app_with_toolchain(toolchain);
        let webview = WebviewWindowBuilder::new(&app, OWNER, Default::default())
            .build()
            .expect("integrity test webview must build");
        let status = get_ipc_response(&webview, invoke_request("video_ffmpeg_status", json!({})))
            .expect("status must classify the replaced FFprobe without spawning it")
            .deserialize::<Value>()
            .expect("integrity status must be JSON");
        assert_eq!(status["ready"], false);
        assert_eq!(status["ffmpeg"]["problem"], "failed");
        assert_eq!(status["ffprobe"]["problem"], "integrity_failed");

        let source = workspace.path().join("source.mp4");
        fs::write(&source, b"source bytes never reach FFprobe")
            .expect("integrity source fixture must be writable");
        let grants = app.state::<video::VideoPathGrants>();
        let source = grants
            .grant_existing_file(OWNER, video::GrantCategory::Source, &source)
            .expect("integrity source must be granted");
        let output = grants
            .grant_destination(
                OWNER,
                video::GrantCategory::Output,
                &workspace.path().join("blocked-output.mp4"),
            )
            .expect("integrity output must be granted");
        let assert_integrity_error = |error: &Value, operation: &str| {
            assert_eq!(error["code"], "tool_unavailable");
            assert_eq!(error["details"]["operation"], operation);
            assert_eq!(error["details"]["category"], "integrity_failed");
        };

        let probe_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_probe_media",
                json!({ "path": source.to_string_lossy() }),
            ),
        )
        .expect_err("probe must reject the replaced FFprobe before spawn");
        assert_integrity_error(&probe_error, "probe_media");

        let prepare_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_prepare_asset",
                json!({
                    "projectId": "11111111-1111-4111-8111-111111111111",
                    "assetId": "22222222-2222-4222-8222-222222222222",
                    "path": source.to_string_lossy(),
                    "sequenceRate": { "numerator": 30, "denominator": 1 }
                }),
            ),
        )
        .expect_err("prepare must reject the replaced FFprobe before spawn");
        assert_integrity_error(&prepare_error, "prepare_source_probe");

        let input = source.to_string_lossy().into_owned();
        let destination = output.to_string_lossy().into_owned();
        let filter = "scale=320:180:force_original_aspect_ratio=decrease:flags=lanczos,pad=320:180:(ow-iw)/2:(oh-ih)/2:black,fps=30/1";
        let plan = json!({
            "schemaVersion": 1,
            "planId": PLAN_ID,
            "revisionId": "44444444-4444-4444-8444-444444444444",
            "executable": "ffmpeg",
            "inputPath": input,
            "outputPath": destination,
            "expected": {
                "durationFrames": 60,
                "rate": { "numerator": 30, "denominator": 1 },
                "width": 320,
                "height": 180,
                "audio": true
            },
            "argv": [
                "-hide_banner", "-nostdin", "-loglevel", "warning", "-progress", "pipe:1",
                "-nostats", "-i", input, "-ss", "0.000000", "-t", "2.000000", "-map",
                "0:v:0", "-map", "0:a:0", "-vf", filter, "-c:v", "libx264", "-pix_fmt",
                "yuv420p", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", destination
            ]
        });
        let render_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_start_render",
                json!({ "plan": plan, "overwrite": false }),
            ),
        )
        .expect_err("render must reject the replaced FFprobe before worker spawn");
        assert_integrity_error(&render_error, "start_render");
        assert!(!app.state::<video::VideoRenderJobs>().is_active(PLAN_ID));
        assert!(!output.exists(), "rejected render must not create output");
    }

    #[test]
    fn video_prepare_asset_is_reachable_over_mock_ipc() {
        let app = mock_video_app();
        let webview = WebviewWindowBuilder::new(&app, "prepare-owner", Default::default())
            .build()
            .expect("test webview must build");
        let error = get_ipc_response(
            &webview,
            invoke_request(
                "video_prepare_asset",
                json!({
                    "projectId": "../escape",
                    "assetId": "22222222-2222-4222-8222-222222222222",
                    "path": "ungranted.mp4",
                    "sequenceRate": { "numerator": 30000, "denominator": 1001 }
                }),
            ),
        )
        .expect_err("malformed prepare request must return a typed command error");
        assert_eq!(error["code"], "invalid_path");
        assert_eq!(error["details"]["operation"], "prepare_asset");
        assert_eq!(error["details"]["category"], "project_id");
    }

    #[test]
    fn video_project_commands_are_reachable_over_mock_ipc() {
        let app = mock_video_app();
        let webview = WebviewWindowBuilder::new(&app, "project-owner", Default::default())
            .build()
            .expect("test webview must build");

        let malformed_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_save_project",
                json!({ "path": "ungranted.svpvideo", "document": {} }),
            ),
        )
        .expect_err("malformed project input must return a typed command error");
        assert_eq!(malformed_error["code"], "invalid_project");

        let fixture_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/video-phase1/single-clip.svpvideo");
        let document: Value = serde_json::from_slice(
            &fs::read(fixture_path).expect("canonical project fixture must be readable"),
        )
        .expect("canonical project fixture must parse");
        let ungranted_path = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("ungranted.svpvideo")
            .to_string_lossy()
            .into_owned();
        let ungranted_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_save_project",
                json!({ "path": ungranted_path, "document": document }),
            ),
        )
        .expect_err("ungranted save input must return a typed command error");
        assert_eq!(ungranted_error["code"], "path_not_granted");
        assert_eq!(ungranted_error["details"]["operation"], "authorize_path");

        let regrant_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_regrant_project_source",
                json!({
                    "projectPath": ungranted_path,
                    "assetId": "22222222-2222-4222-8222-222222222222"
                }),
            ),
        )
        .expect_err("registered regrant input must enforce the owner project grant");
        assert_eq!(regrant_error["code"], "path_not_granted");
        assert_eq!(regrant_error["details"]["operation"], "authorize_path");

        let service_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_execute_project_group",
                json!({
                    "request": {
                        "groupId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        "projectId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
                        "baseRevision": 0,
                        "commands": [{
                            "type": "RemoveMarker",
                            "commandId": "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                            "sequenceId": "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                            "markerId": "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
                        }]
                    }
                }),
            ),
        )
        .expect_err("registered canonical engine must reject an unknown owner session");
        assert_eq!(service_error["code"], "invalid_project");
        assert_eq!(service_error["details"]["operation"], "project_service");
    }

    #[test]
    fn project_ipc_worker_preserves_window_owner_isolation() {
        let app = mock_video_app();
        let owner_webview = WebviewWindowBuilder::new(&app, "project-owner-a", Default::default())
            .build()
            .expect("owner test webview must build");
        let other_webview = WebviewWindowBuilder::new(&app, "project-owner-b", Default::default())
            .build()
            .expect("other owner test webview must build");
        let workspace = tempfile::tempdir().expect("owner test workspace must exist");
        let project_path = workspace.path().join("owner-isolation.svpvideo");
        app.state::<video::VideoPathGrants>()
            .grant_destination(
                "project-owner-a",
                video::GrantCategory::Project,
                &project_path,
            )
            .expect("owner project destination must be granted");

        let created = get_ipc_response(
            &owner_webview,
            invoke_request(
                "video_create_project",
                json!({
                    "path": project_path.to_string_lossy(),
                    "name": "Owner isolation"
                }),
            ),
        )
        .expect("owner must create its project")
        .deserialize::<Value>()
        .expect("created project response must be JSON");
        let project_id = created["projectId"]
            .as_str()
            .expect("created project must have an ID");

        let other_owner_error = get_ipc_response(
            &other_webview,
            invoke_request(
                "video_project_inspector",
                json!({ "projectId": project_id }),
            ),
        )
        .expect_err("another window must not inspect the owner's project");
        assert_eq!(other_owner_error["code"], "invalid_project");
        assert_eq!(other_owner_error["details"]["category"], "unknown_session");

        get_ipc_response(
            &owner_webview,
            invoke_request(
                "video_project_inspector",
                json!({ "projectId": project_id }),
            ),
        )
        .expect("the owning window must inspect its project");
        get_ipc_response(
            &owner_webview,
            invoke_request("video_close_project", json!({ "projectId": project_id })),
        )
        .expect("the owning window must close its project");
    }

    #[test]
    fn video_render_commands_are_reachable_over_mock_ipc() {
        let app = mock_video_app();
        let webview = WebviewWindowBuilder::new(&app, "render-owner", Default::default())
            .build()
            .expect("test webview must build");

        let start_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_start_render",
                json!({ "plan": {}, "overwrite": false }),
            ),
        )
        .expect_err("invalid render plan must return a typed command error");
        assert_eq!(start_error["code"], "invalid_render_plan");
        assert_eq!(start_error["details"]["category"], "schema");

        let cancel_error = get_ipc_response(
            &webview,
            invoke_request(
                "video_cancel_render",
                json!({ "jobId": "missing-render-job" }),
            ),
        )
        .expect_err("unknown render job must return a typed command error");
        assert_eq!(cancel_error["code"], "invalid_render_plan");
        assert_eq!(cancel_error["details"]["category"], "unknown_job");
    }

    fn register_lifecycle_test_job(
        app: &tauri::App<tauri::test::MockRuntime>,
        owner_label: &str,
        job_id: &str,
    ) {
        let output_path = PathBuf::from(format!("lifecycle-output-{job_id}.mp4"));
        let plan = serde_json::from_value(serde_json::json!({
            "schemaVersion": 1,
            "planId": job_id,
            "revisionId": "44444444-4444-4444-8444-444444444444",
            "executable": "ffmpeg",
            "inputPath": "lifecycle-input.mp4",
            "outputPath": output_path.to_string_lossy(),
            "expected": {
                "durationFrames": 1,
                "rate": { "numerator": 30, "denominator": 1 },
                "width": 16,
                "height": 16,
                "audio": false
            },
            "argv": []
        }))
        .expect("lifecycle test render plan must deserialize");
        let validated = video::render::ValidatedRenderPlan {
            plan,
            input_path: PathBuf::from("lifecycle-input.mp4"),
            output_path,
            duration_microseconds: 33_333,
        };
        app.state::<video::VideoRenderJobs>()
            .register(owner_label, &validated)
            .expect("lifecycle test job must register");
    }

    #[test]
    fn destroyed_window_cancels_only_its_render_jobs_and_revokes_its_grants() {
        let app = mock_video_app();
        let webview = WebviewWindowBuilder::new(&app, "grant-owner", Default::default())
            .build()
            .expect("test window must build");
        let window = webview.as_ref().window().clone();
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("fixtures/video-phase1/single-clip.mp4");
        let grants = app.state::<video::VideoPathGrants>();
        grants
            .grant_existing_file("grant-owner", video::GrantCategory::Source, &source)
            .expect("source grant must be created");

        let owner_job_id = "77777777-7777-4777-8777-777777777777";
        let other_job_id = "88888888-8888-4888-8888-888888888888";
        register_lifecycle_test_job(&app, "grant-owner", owner_job_id);
        register_lifecycle_test_job(&app, "other-owner", other_job_id);
        let jobs = app.state::<video::VideoRenderJobs>();

        clean_up_video_state_on_destroyed(&window, &WindowEvent::Destroyed);
        clean_up_video_state_on_destroyed(&window, &WindowEvent::Destroyed);

        assert!(jobs.cancellation_requested(owner_job_id));
        assert!(!jobs.cancellation_requested(other_job_id));
        assert!(jobs.is_active(owner_job_id));
        assert!(jobs.is_active(other_job_id));

        let error = grants
            .authorize("grant-owner", video::GrantCategory::Source, &source)
            .expect_err("destroyed-window grant must be revoked");
        assert_eq!(error.code, video::VideoErrorCode::PathNotGranted);
    }

    #[test]
    fn app_exit_cancels_all_render_jobs_idempotently_without_settling_workers() {
        let app = mock_video_app();
        let first_job_id = "99999999-9999-4999-8999-999999999999";
        let second_job_id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
        register_lifecycle_test_job(&app, "first-owner", first_job_id);
        register_lifecycle_test_job(&app, "second-owner", second_job_id);
        let jobs = app.state::<video::VideoRenderJobs>();

        clean_up_video_state_on_exit(app.handle(), &RunEvent::Exit);
        clean_up_video_state_on_exit(app.handle(), &RunEvent::Exit);

        assert!(jobs.cancellation_requested(first_job_id));
        assert!(jobs.cancellation_requested(second_job_id));
        assert!(jobs.is_active(first_job_id));
        assert!(jobs.is_active(second_job_id));
        assert!(jobs
            .settle(first_job_id)
            .expect("worker settlement must work"));
        assert!(jobs
            .settle(second_job_id)
            .expect("worker settlement must work"));
    }

    #[cfg(windows)]
    const PACKAGED_MEDIA_RESOURCE_ROOT_ENV: &str = "SVP_MEDIA_RESOURCE_ROOT";
    #[cfg(windows)]
    const PACKAGED_RENDER_REVISION_ID: &str = "44444444-4444-4444-8444-444444444444";
    #[cfg(windows)]
    const PACKAGED_COMPLETE_PLAN_ID: &str = "55555555-5555-4555-8555-555555555555";
    #[cfg(windows)]
    const PACKAGED_CANCEL_PLAN_ID: &str = "66666666-6666-4666-8666-666666666666";

    #[cfg(windows)]
    struct RemoveDirectoryOnDrop(PathBuf);

    #[cfg(windows)]
    impl Drop for RemoveDirectoryOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[cfg(windows)]
    fn packaged_media_app(cache_suffix: &str) -> tauri::App<tauri::test::MockRuntime> {
        let resource_root = std::env::var_os(PACKAGED_MEDIA_RESOURCE_ROOT_ENV)
            .map(PathBuf::from)
            .expect("SVP_MEDIA_RESOURCE_ROOT must identify the assembled Tauri resource root");
        let toolchain =
            video::toolchain::MediaToolchain::resolve_from_resource_root(&resource_root);
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = format!(
            "com.supavideo.producer.packaged-media-test.{}.{}",
            std::process::id(),
            cache_suffix
        );
        mock_builder()
            .manage(video::VideoPathGrants::default())
            .manage(video::VideoRenderJobs::default())
            .manage(video::VideoProjectService::default())
            .manage(video::toolchain::MediaToolchainState::from_ready(toolchain))
            .invoke_handler(tauri::generate_handler![
                video::probe::video_ffmpeg_status,
                video::probe::video_probe_media,
                video::derived::video_prepare_asset,
                video::render::video_start_render,
                video::render::video_cancel_render,
            ])
            .build(context)
            .expect("packaged media IPC app must build")
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_media_renamed_or_replaced_executable_fails_before_spawn() {
        use std::io::Write as _;

        let packaged_root = std::env::var_os(PACKAGED_MEDIA_RESOURCE_ROOT_ENV)
            .map(PathBuf::from)
            .expect("SVP_MEDIA_RESOURCE_ROOT must identify the assembled Tauri resource root");
        let workspace = tempfile::tempdir().expect("packaged replacement workspace must exist");
        let staged_root = workspace.path().join("staged-resources");
        let staged_media_tools = staged_root.join("media-tools");
        fs::create_dir_all(&staged_media_tools)
            .expect("staged packaged media directory must exist");
        let packaged_media_tools = packaged_root.join("media-tools");
        let ffmpeg_path = staged_media_tools.join("ffmpeg.exe");
        let ffprobe_path = staged_media_tools.join("ffprobe.exe");
        fs::copy(packaged_media_tools.join("ffmpeg.exe"), &ffmpeg_path)
            .expect("packaged FFmpeg must copy into the controlled resource root");
        fs::copy(packaged_media_tools.join("ffprobe.exe"), &ffprobe_path)
            .expect("packaged FFprobe must copy into the controlled resource root");

        let renamed_toolchain =
            video::toolchain::MediaToolchain::resolve_from_resource_root(&staged_root);
        renamed_toolchain
            .programs()
            .expect("unaltered packaged binaries must resolve before rename");
        let renamed_ffprobe_path = staged_media_tools.join("ffprobe.renamed.exe");
        fs::rename(&ffprobe_path, &renamed_ffprobe_path)
            .expect("the staged FFprobe must be renameable after resolution");
        let renamed_app = mock_video_app_with_toolchain(renamed_toolchain);
        let renamed_webview =
            WebviewWindowBuilder::new(&renamed_app, "packaged-renamed", Default::default())
                .build()
                .expect("packaged rename webview must build");
        let renamed_status = get_ipc_response(
            &renamed_webview,
            invoke_request("video_ffmpeg_status", json!({})),
        )
        .expect("packaged rename status must fail closed")
        .deserialize::<Value>()
        .expect("packaged rename status must be JSON");
        assert_eq!(renamed_status["ready"], false);
        assert_eq!(renamed_status["ffmpeg"]["available"], true);
        assert_eq!(renamed_status["ffmpeg"]["version"], "8.1.2");
        assert_eq!(renamed_status["ffprobe"]["problem"], "not_found");

        fs::rename(&renamed_ffprobe_path, &ffprobe_path)
            .expect("the staged FFprobe must be restorable for replacement proof");
        let replaced_toolchain =
            video::toolchain::MediaToolchain::resolve_from_resource_root(&staged_root);
        replaced_toolchain
            .programs()
            .expect("restored packaged binaries must resolve before replacement");
        let mut ffprobe = fs::OpenOptions::new()
            .write(true)
            .open(&ffprobe_path)
            .expect("the staged FFprobe must open for controlled replacement");
        ffprobe
            .write_all(&[0])
            .expect("the staged FFprobe first byte must be replaceable");
        ffprobe
            .sync_all()
            .expect("the staged FFprobe replacement must reach disk");
        drop(ffprobe);

        let replaced_app = mock_video_app_with_toolchain(replaced_toolchain);
        let replaced_webview =
            WebviewWindowBuilder::new(&replaced_app, "packaged-replaced", Default::default())
                .build()
                .expect("packaged replacement webview must build");
        let replaced_status = get_ipc_response(
            &replaced_webview,
            invoke_request("video_ffmpeg_status", json!({})),
        )
        .expect("packaged replacement status must fail closed")
        .deserialize::<Value>()
        .expect("packaged replacement status must be JSON");
        assert_eq!(replaced_status["ready"], false);
        assert_eq!(replaced_status["ffmpeg"]["available"], true);
        assert_eq!(replaced_status["ffmpeg"]["version"], "8.1.2");
        assert_eq!(replaced_status["ffprobe"]["problem"], "integrity_failed");
    }

    #[cfg(windows)]
    fn capture_render_events(
        app: &tauri::App<tauri::test::MockRuntime>,
    ) -> Arc<Mutex<Vec<String>>> {
        let events = Arc::new(Mutex::new(Vec::new()));
        let captured = events.clone();
        app.listen_any(video::VIDEO_RENDER_EVENT, move |event| {
            captured
                .lock()
                .expect("packaged render event capture must lock")
                .push(event.payload().to_owned());
        });
        events
    }

    #[cfg(windows)]
    fn render_events(captured: &Arc<Mutex<Vec<String>>>) -> Vec<Value> {
        captured
            .lock()
            .expect("packaged render event capture must lock")
            .iter()
            .map(|payload| {
                serde_json::from_str(payload).expect("packaged render event payload must be JSON")
            })
            .collect()
    }

    #[cfg(windows)]
    fn wait_for_render_terminal(
        captured: &Arc<Mutex<Vec<String>>>,
        timeout: Duration,
    ) -> Vec<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            let events = render_events(captured);
            if events.last().is_some_and(|event| {
                matches!(
                    event["type"].as_str(),
                    Some("completed" | "failed" | "cancelled")
                )
            }) {
                return events;
            }
            assert!(
                Instant::now() < deadline,
                "packaged render did not emit a terminal event before the deadline: {events:?}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    #[cfg(windows)]
    fn assert_render_event_order(events: &[Value], plan_id: &str, terminal_type: &str) {
        assert_eq!(
            events.first().and_then(|event| event["type"].as_str()),
            Some("started")
        );
        assert_eq!(
            events.last().and_then(|event| event["type"].as_str()),
            Some(terminal_type)
        );
        assert!(
            events[1..events.len() - 1]
                .iter()
                .all(|event| event["type"] == "progress"),
            "only progress events may appear between started and terminal: {events:?}"
        );
        assert!(
            events.iter().all(|event| event["jobId"] == plan_id),
            "every render event must identify the requested job: {events:?}"
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| {
                    matches!(
                        event["type"].as_str(),
                        Some("completed" | "failed" | "cancelled")
                    )
                })
                .count(),
            1,
            "render must emit exactly one terminal event: {events:?}"
        );
    }

    #[cfg(windows)]
    fn packaged_render_plan(
        input: &Path,
        output: &Path,
        plan_id: &str,
        width: u64,
        height: u64,
    ) -> Value {
        let input = input.to_string_lossy().into_owned();
        let output = output.to_string_lossy().into_owned();
        let filter = format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,fps=30/1"
        );
        json!({
            "schemaVersion": 1,
            "planId": plan_id,
            "revisionId": PACKAGED_RENDER_REVISION_ID,
            "executable": "ffmpeg",
            "inputPath": input,
            "outputPath": output,
            "expected": {
                "durationFrames": 60,
                "rate": { "numerator": 30, "denominator": 1 },
                "width": width,
                "height": height,
                "audio": true
            },
            "argv": [
                "-hide_banner", "-nostdin", "-loglevel", "warning", "-progress", "pipe:1",
                "-nostats", "-i", input, "-ss", "0.000000", "-t", "2.000000", "-map",
                "0:v:0", "-map", "0:a:0", "-vf", filter, "-c:v", "libx264", "-pix_fmt",
                "yuv420p", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", output
            ]
        })
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_media_ipc_status_probe_prepare_and_render_complete() {
        let app = packaged_media_app("complete");
        let cache_root = app
            .path()
            .app_cache_dir()
            .expect("packaged test cache root must resolve");
        let _cache_cleanup = RemoveDirectoryOnDrop(cache_root);
        let webview = WebviewWindowBuilder::new(&app, "packaged-complete", Default::default())
            .build()
            .expect("packaged complete test webview must build");
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/video-phase1/single-clip.mp4")
            .canonicalize()
            .expect("canonical packaged media fixture must exist");
        let workspace = tempfile::tempdir().expect("packaged complete workspace must exist");
        let output = workspace.path().join("packaged-complete.mp4");
        let grants = app.state::<video::VideoPathGrants>();
        let source = grants
            .grant_existing_file("packaged-complete", video::GrantCategory::Source, &source)
            .expect("packaged source path must be granted");
        let output = grants
            .grant_destination("packaged-complete", video::GrantCategory::Output, &output)
            .expect("packaged output path must be granted");

        let status = get_ipc_response(&webview, invoke_request("video_ffmpeg_status", json!({})))
            .expect("packaged status IPC must succeed")
            .deserialize::<Value>()
            .expect("packaged status must be JSON");
        assert_eq!(status["source"], "bundled");
        assert_eq!(
            status["toolchainId"],
            "ffmpeg-8.1.2-gyan-essentials-windows-x86_64"
        );
        assert_eq!(status["ffmpeg"]["available"], true);
        assert_eq!(status["ffprobe"]["available"], true);
        assert_eq!(status["ffmpeg"]["version"], "8.1.2");
        assert_eq!(status["ffprobe"]["version"], "8.1.2");
        assert_eq!(status["ready"], true);

        let probe = get_ipc_response(
            &webview,
            invoke_request(
                "video_probe_media",
                json!({ "path": source.to_string_lossy() }),
            ),
        )
        .expect("packaged probe IPC must succeed")
        .deserialize::<Value>()
        .expect("packaged probe must be JSON");
        assert_eq!(probe["durationMicroseconds"], 2_000_000);
        assert_eq!(probe["width"], 320);
        assert_eq!(probe["height"], 180);
        assert_eq!(probe["videoCodecName"], "h264");
        assert_eq!(
            probe["averageFrameRate"],
            json!({ "numerator": 30, "denominator": 1 })
        );
        assert_eq!(probe["audio"]["codecName"], "aac");
        assert_eq!(probe["audio"]["sampleRate"], 48_000);

        let prepared = get_ipc_response(
            &webview,
            invoke_request(
                "video_prepare_asset",
                json!({
                    "projectId": "11111111-1111-4111-8111-111111111111",
                    "assetId": "22222222-2222-4222-8222-222222222222",
                    "path": source.to_string_lossy(),
                    "sequenceRate": { "numerator": 30, "denominator": 1 }
                }),
            ),
        )
        .expect("packaged prepare IPC must succeed")
        .deserialize::<Value>()
        .expect("packaged prepared asset must be JSON");
        let proxy_path = PathBuf::from(
            prepared["proxyPath"]
                .as_str()
                .expect("prepared proxy path must be present"),
        );
        let thumbnail_path = PathBuf::from(
            prepared["thumbnailPath"]
                .as_str()
                .expect("prepared thumbnail path must be present"),
        );
        assert!(proxy_path.is_file(), "packaged proxy must exist");
        assert!(thumbnail_path.is_file(), "packaged thumbnail must exist");
        assert_eq!(prepared["proxyProbe"]["videoCodecName"], "h264");
        assert_eq!(prepared["proxyProbe"]["width"], 320);
        assert_eq!(prepared["proxyProbe"]["height"], 180);

        let captured = capture_render_events(&app);
        let started = get_ipc_response(
            &webview,
            invoke_request(
                "video_start_render",
                json!({
                    "plan": packaged_render_plan(
                        &source,
                        &output,
                        PACKAGED_COMPLETE_PLAN_ID,
                        320,
                        180
                    ),
                    "overwrite": false
                }),
            ),
        )
        .expect("packaged render start IPC must succeed")
        .deserialize::<Value>()
        .expect("packaged render start must be JSON");
        assert_eq!(started["jobId"], PACKAGED_COMPLETE_PLAN_ID);

        let events = wait_for_render_terminal(&captured, Duration::from_secs(120));
        assert!(
            events.len() >= 3,
            "completed render must emit progress: {events:?}"
        );
        assert_render_event_order(&events, PACKAGED_COMPLETE_PLAN_ID, "completed");
        let completed = events.last().expect("completed event must exist");
        assert_eq!(
            completed["output"]["outputPath"],
            output.to_string_lossy().as_ref()
        );
        let preview_path = PathBuf::from(
            completed["output"]["previewPath"]
                .as_str()
                .expect("completed preview path must be present"),
        );
        assert!(output.is_file(), "packaged render output must exist");
        assert!(preview_path.is_file(), "packaged render preview must exist");
        assert_eq!(completed["output"]["probe"]["videoCodecName"], "h264");
        assert_eq!(
            completed["output"]["probe"]["durationMicroseconds"],
            2_000_000
        );
        assert!(
            !workspace
                .path()
                .join(format!(".svp-part-{PACKAGED_COMPLETE_PLAN_ID}.mp4"))
                .exists(),
            "completed packaged render must remove its partial"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_media_ipc_render_cancel_cleans_partial() {
        let app = packaged_media_app("cancel");
        let cache_root = app
            .path()
            .app_cache_dir()
            .expect("packaged cancellation cache root must resolve");
        let _cache_cleanup = RemoveDirectoryOnDrop(cache_root);
        let webview = WebviewWindowBuilder::new(&app, "packaged-cancel", Default::default())
            .build()
            .expect("packaged cancellation test webview must build");
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/video-phase1/single-clip.mp4")
            .canonicalize()
            .expect("canonical packaged cancellation fixture must exist");
        let workspace = tempfile::tempdir().expect("packaged cancellation workspace must exist");
        let output = workspace.path().join("packaged-cancelled.mp4");
        let partial = workspace
            .path()
            .join(format!(".svp-part-{PACKAGED_CANCEL_PLAN_ID}.mp4"));
        let grants = app.state::<video::VideoPathGrants>();
        let source = grants
            .grant_existing_file("packaged-cancel", video::GrantCategory::Source, &source)
            .expect("packaged cancellation source must be granted");
        let output = grants
            .grant_destination("packaged-cancel", video::GrantCategory::Output, &output)
            .expect("packaged cancellation output must be granted");
        let captured = capture_render_events(&app);

        let started = get_ipc_response(
            &webview,
            invoke_request(
                "video_start_render",
                json!({
                    "plan": packaged_render_plan(
                        &source,
                        &output,
                        PACKAGED_CANCEL_PLAN_ID,
                        3840,
                        2160
                    ),
                    "overwrite": false
                }),
            ),
        )
        .expect("packaged cancellation render start IPC must succeed")
        .deserialize::<Value>()
        .expect("packaged cancellation render start must be JSON");
        assert_eq!(started["jobId"], PACKAGED_CANCEL_PLAN_ID);
        get_ipc_response(
            &webview,
            invoke_request(
                "video_cancel_render",
                json!({ "jobId": PACKAGED_CANCEL_PLAN_ID }),
            ),
        )
        .expect("packaged render cancellation IPC must succeed");

        let events = wait_for_render_terminal(&captured, Duration::from_secs(60));
        assert_render_event_order(&events, PACKAGED_CANCEL_PLAN_ID, "cancelled");
        assert!(
            !output.exists(),
            "cancelled packaged render must not commit output"
        );
        assert!(
            !partial.exists(),
            "cancelled packaged render must remove its partial"
        );
        std::thread::sleep(Duration::from_millis(250));
        assert!(
            !partial.exists(),
            "reaped packaged FFmpeg must not recreate the cancelled partial"
        );
        assert_eq!(
            render_events(&captured).len(),
            events.len(),
            "no event may follow the packaged cancelled terminal event"
        );
    }

    #[test]
    #[ignore = "requires system FFmpeg and the canonical media fixture"]
    fn picker_source_grant_reaches_media_probe_over_tauri_ipc() {
        let app = mock_video_app();
        let webview = WebviewWindowBuilder::new(&app, "picker-owner", Default::default())
            .build()
            .expect("test webview must build");
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/video-phase1/single-clip.mp4")
            .canonicalize()
            .expect("canonical media fixture must exist");
        let source_string = source
            .to_str()
            .expect("canonical fixture path must be UTF-8")
            .to_owned();

        app.state::<video::VideoPathGrants>()
            .grant_existing_file("picker-owner", video::GrantCategory::Source, &source)
            .expect("the source grant issued by video_pick_source must succeed");

        let probe = get_ipc_response(
            &webview,
            invoke_request("video_probe_media", json!({ "path": source_string })),
        )
        .expect("picker-granted source must reach video_probe_media")
        .deserialize::<Value>()
        .expect("probe response must be JSON");
        assert_eq!(probe["durationMicroseconds"], 2_000_000);
        assert_eq!(probe["width"], 320);
        assert_eq!(probe["height"], 180);
        assert_eq!(probe["videoCodecName"], "h264");
    }
}
