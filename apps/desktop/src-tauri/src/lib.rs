pub mod video;

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
use tauri::{AppHandle, Manager, RunEvent, Runtime, Window, WindowEvent};

#[cfg(all(not(test), feature = "desktop-runtime"))]
fn configure_builder<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(video::VideoPathGrants::default())
        .manage(video::VideoRenderJobs::default())
        .invoke_handler(tauri::generate_handler![
            video::probe::video_ffmpeg_status,
            video::probe::video_probe_media,
            video::project_io::video_pick_source,
            video::derived::video_prepare_asset,
            video::render::video_start_render,
            video::render::video_cancel_render,
            video::project_io::video_pick_new_project_path,
            video::project_io::video_open_project,
            video::project_io::video_regrant_project_source,
            video::project_io::video_pick_export_path,
            video::project_io::video_save_project,
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
    };

    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
        webview::InvokeRequest,
        Manager, RunEvent, WebviewWindowBuilder, WindowEvent,
    };

    use super::{clean_up_video_state_on_destroyed, clean_up_video_state_on_exit, video};

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
            .invoke_handler(tauri::generate_handler![
                video::probe::video_ffmpeg_status,
                video::probe::video_probe_media,
                video::derived::video_prepare_asset,
                video::render::video_start_render,
                video::render::video_cancel_render,
                video::project_io::video_regrant_project_source,
                video::project_io::video_save_project,
            ])
            .on_window_event(clean_up_video_state_on_destroyed)
            .build(mock_context(noop_assets()))
            .expect("video IPC smoke app must build")
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
        assert!(status.get("ffmpeg").is_some());
        assert!(status.get("ffprobe").is_some());
        assert!(status.get("ready").is_some());

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
