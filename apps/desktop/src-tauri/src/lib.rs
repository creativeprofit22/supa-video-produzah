pub mod video;

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
use tauri::{Manager, Runtime, Window, WindowEvent};

#[cfg(all(not(test), feature = "desktop-runtime"))]
fn configure_builder<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(video::VideoPathGrants::default())
        .invoke_handler(tauri::generate_handler![
            video::probe::video_ffmpeg_status,
            video::probe::video_probe_media,
            video::project_io::video_pick_source,
            video::project_io::video_pick_new_project_path,
            video::project_io::video_open_project,
            video::project_io::video_pick_export_path,
            video::project_io::video_save_project,
        ])
        .on_window_event(revoke_video_grants_on_destroyed)
}

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
fn revoke_video_grants_on_destroyed<R: Runtime>(window: &Window<R>, event: &WindowEvent) {
    if matches!(event, WindowEvent::Destroyed) {
        let _ = window
            .state::<video::VideoPathGrants>()
            .revoke_window(window.label());
    }
}

#[cfg(all(not(test), feature = "desktop-runtime"))]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    configure_builder(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("error while running Supa Video Producer");
}

#[cfg(all(test, feature = "tauri-ipc-test"))]
mod tests {
    use std::path::Path;

    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
        webview::InvokeRequest,
        Manager, WebviewWindowBuilder, WindowEvent,
    };

    use super::{revoke_video_grants_on_destroyed, video};

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
            .invoke_handler(tauri::generate_handler![
                video::probe::video_ffmpeg_status,
                video::probe::video_probe_media,
            ])
            .on_window_event(revoke_video_grants_on_destroyed)
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
    fn destroyed_window_revokes_its_video_path_grants() {
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

        revoke_video_grants_on_destroyed(&window, &WindowEvent::Destroyed);

        let error = grants
            .authorize("grant-owner", video::GrantCategory::Source, &source)
            .expect_err("destroyed-window grant must be revoked");
        assert_eq!(error.code, video::VideoErrorCode::PathNotGranted);
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
