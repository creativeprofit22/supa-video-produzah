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
use tauri::Emitter;

#[cfg(all(not(test), feature = "desktop-runtime"))]
fn initialize_media_jobs<R: Runtime>(
    app: &tauri::App<R>,
) -> Result<(), Box<dyn std::error::Error>> {
    let local_data_dir = app.path().app_local_data_dir()?;
    let app_cache_dir = app.path().app_cache_dir()?;
    let service = tauri::async_runtime::block_on(video::jobs::MediaJobService::initialize(
        local_data_dir,
        app_cache_dir,
    ))?;
    let event_app = app.handle().clone();
    service
        .store()
        .set_event_sink(std::sync::Arc::new(move |event| {
            let _ = event_app.emit(video::jobs::ipc::VIDEO_MEDIA_JOB_EVENT, event);
        }))?;
    app.manage(service);

    let resume_app = app.handle().clone();
    tauri::async_runtime::spawn(async move {
        let toolchain = resume_app
            .state::<video::toolchain::MediaToolchainState>()
            .inner()
            .clone();
        let jobs = resume_app.state::<video::jobs::MediaJobService>();
        if video::derived::resume_durable_preparations(
            &jobs,
            video::derived::MediaPrograms::bundled(toolchain),
        )
        .await
        .is_err()
        {
            jobs.record_recovery_warning(
                "Preview recovery could not finish. Retry the affected media job.",
            );
        }
    });
    Ok(())
}

#[cfg(all(not(test), feature = "desktop-runtime"))]
fn configure_builder<R: Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    builder
        .plugin(tauri_plugin_dialog::init())
        .manage(video::VideoPathGrants::default())
        .manage(video::VideoProjectService::default())
        .setup(|app| {
            manage_media_toolchain(
                app,
                video::toolchain::MediaToolchainState::start_for_app(app.handle()),
            );
            initialize_media_jobs(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            video::probe::video_ffmpeg_status,
            video::probe::video_probe_media,
            video::video_load_managed_transcript_artifact,
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
            video::jobs::ipc::video_list_media_jobs,
            video::jobs::ipc::video_get_media_job_events,
            video::jobs::ipc::video_cancel_media_job,
            video::jobs::ipc::video_retry_media_job,
            video::jobs::ipc::video_reauthorize_media_job_output,
            video::jobs::ipc::video_get_media_cache_status,
            video::jobs::ipc::video_clear_legacy_media_cache,
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
            .state::<video::VideoPathGrants>()
            .revoke_window(window.label());
        let owner_label = window.label().to_owned();
        let app = window.app_handle().clone();
        tauri::async_runtime::spawn(async move {
            let jobs = app.state::<video::jobs::MediaJobService>();
            let _ = jobs.cancel_owner(&owner_label).await;
        });
    }
}

#[cfg(any(
    all(not(test), feature = "desktop-runtime"),
    feature = "tauri-ipc-test"
))]
fn clean_up_video_state_on_exit<R: Runtime>(app: &AppHandle<R>, event: &RunEvent) {
    if matches!(event, RunEvent::ExitRequested { .. } | RunEvent::Exit) {
        let _ = app.state::<video::VideoProjectService>().close_all();
        let jobs = app.state::<video::jobs::MediaJobService>();
        let _ = tauri::async_runtime::block_on(jobs.shutdown());
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
    #[cfg(windows)]
    use std::time::Instant;
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{mpsc, Arc, Mutex},
        time::Duration,
    };

    use serde_json::{json, Value};
    use tauri::{
        ipc::{CallbackFn, InvokeBody},
        test::{get_ipc_response, mock_builder, mock_context, noop_assets, INVOKE_KEY},
        webview::InvokeRequest,
        Emitter, Listener, Manager, RunEvent, WebviewWindowBuilder, WindowEvent,
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

    fn test_media_jobs(label: &str) -> video::jobs::MediaJobService {
        let root = std::env::temp_dir().join(format!(
            "supa-video-media-jobs-{label}-{}",
            uuid::Uuid::new_v4()
        ));
        tauri::async_runtime::block_on(video::jobs::MediaJobService::initialize(
            root.join("local"),
            root.join("cache"),
        ))
        .expect("test media job service must initialize")
    }

    fn persist_failed_final_render(jobs: &video::jobs::MediaJobService, owner: &str) -> String {
        use video::jobs::{
            model::{
                MediaJobError, MediaJobErrorCategory, MediaJobEventType, MediaJobKind,
                MediaJobPriority, MediaJobProgress, MediaJobProgressUnit, MediaJobRecoveryAction,
                MediaJobState,
            },
            store::{MediaJobTransition, NewMediaJob},
        };

        tauri::async_runtime::block_on(async {
            let now = video::jobs::current_timestamp_millis().saturating_sub(2);
            let job = jobs
                .store()
                .enqueue(NewMediaJob {
                    kind: MediaJobKind::FinalRender,
                    parent_id: None,
                    dedupe_key: format!("ipc-final-render:{}", uuid::Uuid::new_v4()),
                    project_id: None,
                    asset_id: None,
                    revision_id: Some("ipc-revision".to_owned()),
                    priority: MediaJobPriority::Export,
                    priority_value: 0,
                    stage: "queued".to_owned(),
                    progress: MediaJobProgress {
                        completed: 0,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                    max_attempts: 3,
                    summary: "IPC final render retry".to_owned(),
                    private_payload: json!({
                        "ownerLabel": owner,
                        "plan": { "schemaVersion": 1 },
                        "overwrite": false,
                        "outputAuthorizationPresent": true,
                    }),
                    created_at_ms: now,
                })
                .await
                .expect("IPC render fixture must enqueue")
                .job;
            jobs.store()
                .transition(
                    job.id.clone(),
                    MediaJobTransition {
                        state: MediaJobState::Running,
                        stage: "running".to_owned(),
                        progress: job.progress.clone(),
                        attempt: Some(1),
                        error: None,
                        retry_at_ms: None,
                        result: None,
                        cancellation_requested: false,
                        event_type: MediaJobEventType::StateChanged,
                        message: Some("IPC render fixture started.".to_owned()),
                        occurred_at_ms: now.saturating_add(1),
                    },
                )
                .await
                .expect("IPC render fixture must start");
            jobs.store()
                .transition(
                    job.id.clone(),
                    MediaJobTransition {
                        state: MediaJobState::Failed,
                        stage: "failed".to_owned(),
                        progress: job.progress,
                        attempt: Some(1),
                        error: Some(MediaJobError {
                            code: "render_process_failed".to_owned(),
                            category: MediaJobErrorCategory::ProcessFailed,
                            message: "The export process failed.".to_owned(),
                            retryable: true,
                            action: Some(MediaJobRecoveryAction::Retry),
                        }),
                        retry_at_ms: None,
                        result: None,
                        cancellation_requested: false,
                        event_type: MediaJobEventType::StateChanged,
                        message: Some("The export process failed.".to_owned()),
                        occurred_at_ms: now.saturating_add(2),
                    },
                )
                .await
                .expect("IPC render fixture must fail");
            job.id
        })
    }

    fn mock_video_app() -> tauri::App<tauri::test::MockRuntime> {
        let app = mock_builder()
            .manage(video::VideoPathGrants::default())
            .manage(test_media_jobs("mock"))
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
                video::video_load_managed_transcript_artifact,
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
                video::jobs::ipc::video_list_media_jobs,
                video::jobs::ipc::video_get_media_job_events,
                video::jobs::ipc::video_cancel_media_job,
                video::jobs::ipc::video_retry_media_job,
                video::jobs::ipc::video_reauthorize_media_job_output,
                video::jobs::ipc::video_get_media_cache_status,
                video::jobs::ipc::video_clear_legacy_media_cache,
            ])
            .on_window_event(clean_up_video_state_on_destroyed)
            .build(mock_context(noop_assets()))
            .expect("video IPC smoke app must build");
        let event_app = app.handle().clone();
        app.state::<video::jobs::MediaJobService>()
            .store()
            .set_event_sink(Arc::new(move |event| {
                let _ = event_app.emit(video::jobs::ipc::VIDEO_MEDIA_JOB_EVENT, event);
            }))
            .expect("mock media job event sink must register");
        app
    }

    fn mock_video_app_with_toolchain(
        toolchain: video::toolchain::MediaToolchain,
    ) -> tauri::App<tauri::test::MockRuntime> {
        mock_builder()
            .manage(video::VideoPathGrants::default())
            .manage(test_media_jobs("mock"))
            .manage(video::VideoProjectService::default())
            .manage(video::toolchain::MediaToolchainState::from_ready(toolchain))
            .invoke_handler(tauri::generate_handler![
                video::probe::video_ffmpeg_status,
                video::probe::video_probe_media,
                video::video_load_managed_transcript_artifact,
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
    fn managed_transcript_exact_key_command_returns_the_checked_artifact() {
        let app = mock_video_app();
        let fixture: Value = serde_json::from_slice(include_bytes!(
            "../../../../packages/video-media/fixtures/transcript-artifact-v1.json"
        ))
        .expect("transcript fixture must be valid JSON");
        let artifact = fixture["artifact"].clone();
        let artifact_key = artifact["identity"]["key"]
            .as_str()
            .expect("transcript fixture must have an artifact key");
        let jobs = app.state::<video::jobs::MediaJobService>();
        let guard = tauri::async_runtime::block_on(video::media_store::acquire_artifact(
            video::managed_cache_root_for_test(jobs.inner()),
            video::media_store::ArtifactStoreKind::Transcript,
            artifact_key,
        ))
        .expect("managed transcript destination must be acquired");
        fs::write(
            guard.path(),
            serde_json::to_vec(&artifact).expect("transcript artifact must serialize"),
        )
        .expect("managed transcript fixture must be written");
        guard
            .confirm_durable()
            .expect("managed transcript fixture must be durable");
        drop(guard);
        let webview = WebviewWindowBuilder::new(&app, "transcript-ipc", Default::default())
            .build()
            .expect("transcript IPC webview must build");

        let response = get_ipc_response(
            &webview,
            invoke_request(
                "video_load_managed_transcript_artifact",
                json!({ "request": { "artifactKey": artifact_key } }),
            ),
        )
        .expect("managed transcript command must load an exact key")
        .deserialize::<Value>()
        .expect("managed transcript command response must be JSON");

        assert_eq!(response["schemaVersion"], 1);
        assert_eq!(response["identity"]["key"], artifact_key);
        assert!(response.get("artifactPath").is_none());
    }

    #[test]
    fn media_retry_ipc_rejects_other_owners_and_returns_output_reauthorization() {
        const OWNER: &str = "retry-ipc-owner";
        let app = mock_video_app();
        let job_id =
            persist_failed_final_render(app.state::<video::jobs::MediaJobService>().inner(), OWNER);
        let owner_webview = WebviewWindowBuilder::new(&app, OWNER, Default::default())
            .build()
            .expect("retry owner webview must build");
        let other_webview = WebviewWindowBuilder::new(&app, "retry-ipc-other", Default::default())
            .build()
            .expect("retry other-owner webview must build");
        let body = json!({ "request": { "jobId": job_id } });

        let other_owner_error = get_ipc_response(
            &other_webview,
            invoke_request("video_retry_media_job", body.clone()),
        )
        .expect_err("another owner must not retry a durable media job");
        assert_eq!(other_owner_error["code"], "project_io");

        let response = get_ipc_response(
            &owner_webview,
            invoke_request("video_retry_media_job", body.clone()),
        )
        .expect("failed final render retry must return an actionable record")
        .deserialize::<Value>()
        .expect("retry response must be JSON");
        assert_eq!(response["job"]["id"], job_id);
        assert_eq!(response["job"]["state"], "blocked");
        assert_eq!(
            response["job"]["error"]["category"],
            "output_authorization_required"
        );
        assert_eq!(response["job"]["error"]["action"], "reauthorize_output");

        let repeated = get_ipc_response(
            &owner_webview,
            invoke_request("video_retry_media_job", body),
        )
        .expect("repeated final-render retry must remain deterministically actionable")
        .deserialize::<Value>()
        .expect("repeated retry response must be JSON");
        assert_eq!(repeated, response);
    }

    #[test]
    fn media_job_list_events_and_cache_ipc_are_strict_and_redacted() {
        const OWNER: &str = "media-state-ipc-owner";
        let app = mock_video_app();
        let emitted_events = Arc::new(Mutex::new(Vec::new()));
        let captured_events = emitted_events.clone();
        app.listen_any(video::jobs::ipc::VIDEO_MEDIA_JOB_EVENT, move |event| {
            captured_events
                .lock()
                .expect("media job event capture must lock")
                .push(event.payload().to_owned());
        });
        let job_id =
            persist_failed_final_render(app.state::<video::jobs::MediaJobService>().inner(), OWNER);
        let emitted_events = emitted_events
            .lock()
            .expect("media job event capture must lock");
        assert!(emitted_events.len() >= 3);
        assert!(emitted_events.iter().all(|event| !event.contains(OWNER)));
        drop(emitted_events);
        let webview = WebviewWindowBuilder::new(&app, OWNER, Default::default())
            .build()
            .expect("media state owner webview must build");

        let list = get_ipc_response(
            &webview,
            invoke_request(
                "video_list_media_jobs",
                json!({
                    "request": {
                        "limit": 100,
                        "includeSettled": true,
                        "projectId": null,
                        "beforeUpdatedAt": null,
                        "beforeJobId": null
                    }
                }),
            ),
        )
        .expect("media jobs must be listable over IPC")
        .deserialize::<Value>()
        .expect("media job list must be JSON");
        assert_eq!(list["schemaVersion"], 1);
        assert_eq!(list["jobs"][0]["id"], job_id);
        assert_eq!(list["unsettledParentCount"], 0);
        assert!(list["latestEventId"].as_u64().unwrap_or_default() >= 3);
        assert_eq!(list["nextBeforeUpdatedAt"], Value::Null);
        assert_eq!(list["nextBeforeJobId"], Value::Null);
        let serialized_list = serde_json::to_string(&list).expect("media job list must serialize");
        assert!(!serialized_list.contains("privatePayload"));
        assert!(!serialized_list.contains("ownerLabel"));
        assert!(!serialized_list.contains(OWNER));
        assert!(!serialized_list.contains("outputAuthorizationPresent"));

        let events = get_ipc_response(
            &webview,
            invoke_request(
                "video_get_media_job_events",
                json!({
                    "request": { "jobId": job_id, "afterEventId": 0, "limit": 500 }
                }),
            ),
        )
        .expect("media job events must be reachable over IPC")
        .deserialize::<Value>()
        .expect("media job events must be JSON");
        assert_eq!(events["schemaVersion"], 1);
        assert_eq!(events["events"][0]["jobId"], job_id);
        let serialized_events =
            serde_json::to_string(&events).expect("media job events must serialize");
        assert!(!serialized_events.contains("privatePayload"));
        assert!(!serialized_events.contains(OWNER));

        let half_cursor = get_ipc_response(
            &webview,
            invoke_request(
                "video_list_media_jobs",
                json!({
                    "request": {
                        "limit": 100,
                        "includeSettled": true,
                        "projectId": null,
                        "beforeUpdatedAt": "2026-07-28T00:00:00.000Z",
                        "beforeJobId": null
                    }
                }),
            ),
        )
        .expect_err("half of a media-job cursor must be rejected");
        assert_eq!(half_cursor["code"], "project_io");

        let reverse_half_cursor = get_ipc_response(
            &webview,
            invoke_request(
                "video_list_media_jobs",
                json!({
                    "request": {
                        "limit": 100,
                        "includeSettled": true,
                        "projectId": null,
                        "beforeUpdatedAt": null,
                        "beforeJobId": "00000000-0000-4000-8000-000000000007"
                    }
                }),
            ),
        )
        .expect_err("the other half of a media-job cursor must also be rejected");
        assert_eq!(reverse_half_cursor["code"], "project_io");

        let malformed = get_ipc_response(
            &webview,
            invoke_request(
                "video_list_media_jobs",
                json!({
                    "request": {
                        "limit": 100,
                        "includeSettled": true,
                        "projectId": null,
                        "beforeUpdatedAt": null,
                        "sourcePath": "C:\\private\\clip.mp4"
                    }
                }),
            ),
        )
        .expect_err("unknown media list request fields must be rejected");
        let malformed_text =
            serde_json::to_string(&malformed).expect("malformed media list error must serialize");
        assert!(!malformed_text.contains("C:\\private\\clip.mp4"));

        let status = get_ipc_response(
            &webview,
            invoke_request("video_get_media_cache_status", json!({})),
        )
        .expect("media cache status must be reachable over IPC")
        .deserialize::<Value>()
        .expect("media cache status must be JSON");
        assert_eq!(status["schemaVersion"], 1);
        assert!(status.get("managedBytes").is_some());
        assert!(status.get("legacyClearAvailable").is_some());

        let unconfirmed = get_ipc_response(
            &webview,
            invoke_request(
                "video_clear_legacy_media_cache",
                json!({ "request": { "confirmed": false } }),
            ),
        )
        .expect_err("legacy cache clearing must require explicit confirmation");
        assert_eq!(unconfirmed["code"], "project_io");

        let cleared = get_ipc_response(
            &webview,
            invoke_request(
                "video_clear_legacy_media_cache",
                json!({ "request": { "confirmed": true } }),
            ),
        )
        .expect("confirmed legacy cache clearing must be reachable over IPC")
        .deserialize::<Value>()
        .expect("legacy cache clear response must be JSON");
        assert_eq!(cleared["schemaVersion"], 1);
        assert!(cleared.get("status").is_some());
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
        let project_path = workspace.path().join("integrity-project.svpvideo");
        grants
            .grant_destination(OWNER, video::GrantCategory::Project, &project_path)
            .expect("integrity project destination must be granted");
        let created = app
            .state::<video::VideoProjectService>()
            .create(OWNER, &project_path, "Integrity project", &grants)
            .expect("integrity project must be created before preparation");
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
                    "projectId": created.project_id,
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

        clean_up_video_state_on_destroyed(&window, &WindowEvent::Destroyed);
        clean_up_video_state_on_destroyed(&window, &WindowEvent::Destroyed);

        let error = grants
            .authorize("grant-owner", video::GrantCategory::Source, &source)
            .expect_err("destroyed-window grant must be revoked");
        assert_eq!(error.code, video::VideoErrorCode::PathNotGranted);
    }

    #[test]
    fn app_exit_shuts_down_durable_media_jobs_idempotently() {
        let app = mock_video_app();
        clean_up_video_state_on_exit(app.handle(), &RunEvent::Exit);
        clean_up_video_state_on_exit(app.handle(), &RunEvent::Exit);
    }

    #[cfg(windows)]
    const PACKAGED_MEDIA_RESOURCE_ROOT_ENV: &str = "SVP_MEDIA_RESOURCE_ROOT";
    #[cfg(windows)]
    const PACKAGED_CACHE_STAGE_DEADLINE: Duration = Duration::from_secs(120);
    #[cfg(windows)]
    const PACKAGED_RENDER_REVISION_ID: &str = "44444444-4444-4444-8444-444444444444";
    #[cfg(windows)]
    const PACKAGED_COMPLETE_PLAN_ID: &str = "55555555-5555-4555-8555-555555555555";
    #[cfg(windows)]
    const PACKAGED_HIDDEN_PLAN_ID: &str = "55555555-5555-4555-8555-555555555556";
    #[cfg(windows)]
    const PACKAGED_CANCEL_PLAN_ID: &str = "66666666-6666-4666-8666-666666666666";

    #[cfg(windows)]
    struct PackagedMediaApp {
        app: Option<tauri::App<tauri::test::MockRuntime>>,
        local_data_root: PathBuf,
        cache_root: PathBuf,
    }

    #[cfg(windows)]
    impl std::ops::Deref for PackagedMediaApp {
        type Target = tauri::App<tauri::test::MockRuntime>;

        fn deref(&self) -> &Self::Target {
            self.app
                .as_ref()
                .expect("packaged media app must remain available until cleanup")
        }
    }

    #[cfg(windows)]
    impl PackagedMediaApp {
        fn cache_root(&self) -> &Path {
            &self.cache_root
        }

        fn cleanup(mut self) {
            self.shutdown_and_clean(true);
        }

        fn shutdown_and_clean(&mut self, fail_on_cleanup_error: bool) {
            if let Some(app) = self.app.take() {
                clean_up_video_state_on_exit(app.handle(), &RunEvent::Exit);
                drop(app);
            }
            for root in [&self.local_data_root, &self.cache_root] {
                if let Err(error) = fs::remove_dir_all(root) {
                    if error.kind() != std::io::ErrorKind::NotFound && fail_on_cleanup_error {
                        panic!(
                            "packaged media test root {} must be removed: {error}",
                            root.display()
                        );
                    }
                }
            }
        }
    }

    #[cfg(windows)]
    impl Drop for PackagedMediaApp {
        fn drop(&mut self) {
            self.shutdown_and_clean(false);
        }
    }

    #[cfg(windows)]
    fn packaged_media_app(cache_suffix: &str) -> PackagedMediaApp {
        let resource_root = std::env::var_os(PACKAGED_MEDIA_RESOURCE_ROOT_ENV)
            .map(PathBuf::from)
            .expect("SVP_MEDIA_RESOURCE_ROOT must identify the assembled Tauri resource root");
        let toolchain =
            video::toolchain::MediaToolchain::resolve_from_resource_root(&resource_root);
        let mut context = mock_context(noop_assets());
        context.config_mut().identifier = format!(
            "com.supavideo.producer.packaged-media-test.{}.{}.{}",
            std::process::id(),
            cache_suffix,
            uuid::Uuid::new_v4()
        );
        let app = mock_builder()
            .manage(video::VideoPathGrants::default())
            .manage(video::VideoProjectService::default())
            .manage(video::toolchain::MediaToolchainState::from_ready(toolchain))
            .invoke_handler(tauri::generate_handler![
                video::probe::video_ffmpeg_status,
                video::probe::video_probe_media,
                video::video_load_managed_transcript_artifact,
                video::derived::video_prepare_asset,
                video::render::video_start_render,
                video::render::video_cancel_render,
                video::jobs::ipc::video_reauthorize_media_job_output,
                video::jobs::ipc::video_get_media_cache_status,
                video::jobs::ipc::video_clear_legacy_media_cache,
                video::project::ipc::video_create_project,
                video::project::ipc::video_execute_project_group,
                video::project::ipc::video_project_inspector,
                video::project::ipc::video_close_project,
            ])
            .build(context)
            .expect("packaged media IPC app must build");
        let local_data_root = app
            .path()
            .app_local_data_dir()
            .expect("packaged media local-data root must resolve");
        let cache_root = app
            .path()
            .app_cache_dir()
            .expect("packaged media cache root must resolve");
        let jobs = tauri::async_runtime::block_on(video::jobs::MediaJobService::initialize(
            local_data_root.clone(),
            cache_root.clone(),
        ))
        .expect("packaged media job service must initialize from the mock app roots");
        assert!(
            jobs.store().database_path().starts_with(&local_data_root),
            "packaged media database must stay under the mock app local-data root"
        );
        app.manage(jobs);

        PackagedMediaApp {
            app: Some(app),
            local_data_root,
            cache_root,
        }
    }

    #[cfg(windows)]
    fn packaged_media_programs() -> video::derived::MediaPrograms {
        let resource_root = std::env::var_os(PACKAGED_MEDIA_RESOURCE_ROOT_ENV)
            .map(PathBuf::from)
            .expect("SVP_MEDIA_RESOURCE_ROOT must identify the assembled Tauri resource root");
        let toolchain =
            video::toolchain::MediaToolchain::resolve_from_resource_root(&resource_root);
        assert_eq!(
            toolchain.toolchain_id(),
            "ffmpeg-8.1.2-gyan-essentials-windows-x86_64"
        );
        toolchain
            .programs()
            .expect("packaged Phase 3B toolchain must verify before media work");
        video::derived::MediaPrograms::bundled(video::toolchain::MediaToolchainState::from_ready(
            toolchain,
        ))
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_phase3b_hierarchical_preparation_and_restart_boundaries() {
        tauri::async_runtime::block_on(async {
            video::tests::assert_durable_preparation_records(packaged_media_programs()).await;
            video::tests::assert_durable_preparation_restart_boundaries(packaged_media_programs())
                .await;
        });
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_phase3b_final_render_reauthorization_retry_and_cancellation() {
        tauri::async_runtime::block_on(async {
            video::tests::assert_final_render_restart_reauthorization(packaged_media_programs())
                .await;
            video::tests::assert_render_worker_exports(packaged_media_programs()).await;
            video::tests::assert_render_worker_collision(packaged_media_programs()).await;
            video::tests::assert_render_worker_cancellation(packaged_media_programs()).await;
        });
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_phase3b_collision_stops_before_preview_preparation() {
        tauri::async_runtime::block_on(video::tests::assert_render_worker_collision(
            packaged_media_programs(),
        ));
    }

    #[cfg(windows)]
    async fn run_packaged_cache_stage<T>(
        label: &str,
        stage: impl std::future::Future<Output = T>,
    ) -> T {
        tokio::time::timeout(PACKAGED_CACHE_STAGE_DEADLINE, stage)
            .await
            .unwrap_or_else(|_| {
                panic!(
                    "packaged cache stage `{label}` timed out after {} seconds",
                    PACKAGED_CACHE_STAGE_DEADLINE.as_secs()
                )
            })
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_phase3b_cache_lease_eviction_regeneration_and_legacy_policy() {
        tauri::async_runtime::block_on(async {
            let resource_root = std::env::var_os(PACKAGED_MEDIA_RESOURCE_ROOT_ENV)
                .map(PathBuf::from)
                .expect("SVP_MEDIA_RESOURCE_ROOT must identify the assembled Tauri resource root");
            let toolchain =
                video::toolchain::MediaToolchain::resolve_from_resource_root(&resource_root);
            let toolchain_id = toolchain.toolchain_id().to_owned();
            assert_eq!(toolchain_id, "ffmpeg-8.1.2-gyan-essentials-windows-x86_64");
            let toolchain = video::toolchain::MediaToolchainState::from_ready(toolchain);
            let verified = run_packaged_cache_stage(
                "bundled-tool integrity verification",
                toolchain.verified_programs(),
            )
            .await
            .expect("packaged cache toolchain must pass explicit integrity verification");
            let programs = video::derived::MediaPrograms::explicit_for_toolchain(
                verified.ffmpeg().as_os_str().to_owned(),
                verified.ffprobe().as_os_str().to_owned(),
                toolchain_id,
            );

            run_packaged_cache_stage(
                "cache lease, eviction, and low-level legacy policy",
                video::cache::tests::assert_packaged_cache_lease_lru_and_legacy_policy(),
            )
            .await;
            run_packaged_cache_stage(
                "derived cache reuse and corruption repair",
                video::tests::assert_derived_media_reuse_repair(programs),
            )
            .await;
        });

        let app = packaged_media_app("legacy-policy");
        let legacy_root = app.cache_root().join("video-phase1");
        fs::create_dir_all(&legacy_root).expect("packaged legacy root must be created");
        fs::write(legacy_root.join("preview.bin"), b"legacy")
            .expect("packaged legacy fixture must be written");
        let webview = WebviewWindowBuilder::new(&*app, "packaged-legacy", Default::default())
            .build()
            .expect("packaged legacy test webview must build");
        let status = get_ipc_response(
            &webview,
            invoke_request("video_get_media_cache_status", json!({})),
        )
        .expect("packaged legacy status must load")
        .deserialize::<Value>()
        .expect("packaged legacy status must be JSON");
        assert_eq!(status["legacyBytes"], 6);
        assert_eq!(status["legacyClearAvailable"], true);
        get_ipc_response(
            &webview,
            invoke_request(
                "video_clear_legacy_media_cache",
                json!({ "request": { "confirmed": false } }),
            ),
        )
        .expect_err("packaged legacy clear must reject missing confirmation");
        assert!(legacy_root.join("preview.bin").exists());
        let cleared = get_ipc_response(
            &webview,
            invoke_request(
                "video_clear_legacy_media_cache",
                json!({ "request": { "confirmed": true } }),
            ),
        )
        .expect("confirmed packaged legacy clear must succeed")
        .deserialize::<Value>()
        .expect("packaged legacy clear result must be JSON");
        assert_eq!(cleared["clearedBytes"], 6);
        assert_eq!(cleared["status"]["legacyClearAvailable"], false);
        assert!(!legacy_root.join("preview.bin").exists());
        drop(webview);
        app.cleanup();
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
    fn assert_render_event_order(
        events: &[Value],
        job_id: &str,
        plan_id: &str,
        terminal_type: &str,
    ) {
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
            events.iter().all(|event| event["jobId"] == job_id),
            "every render event must identify the durable job: {events:?}"
        );
        assert!(
            events.iter().all(|event| event["planId"] == plan_id),
            "every render event must preserve the requested plan identity: {events:?}"
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
    fn packaged_render_plan_with_visibility(
        input: &Path,
        output: &Path,
        plan_id: &str,
        width: u64,
        height: u64,
        video_hidden: bool,
    ) -> Value {
        let input = input.to_string_lossy().into_owned();
        let output = output.to_string_lossy().into_owned();
        let visibility_filter = if video_hidden {
            ",drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill"
        } else {
            ""
        };
        let filter = format!(
            "scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black{visibility_filter},fps=30/1"
        );
        let mut expected = json!({
            "durationFrames": 60,
            "rate": { "numerator": 30, "denominator": 1 },
            "width": width,
            "height": height,
            "audio": true
        });
        if video_hidden {
            expected["videoHidden"] = json!(true);
        }
        json!({
            "schemaVersion": 1,
            "planId": plan_id,
            "revisionId": PACKAGED_RENDER_REVISION_ID,
            "executable": "ffmpeg",
            "inputPath": input,
            "outputPath": output,
            "expected": expected,
            "argv": [
                "-hide_banner", "-nostdin", "-loglevel", "warning", "-progress", "pipe:1",
                "-nostats", "-i", input, "-ss", "0.000000", "-t", "2.000000", "-map",
                "0:v:0", "-map", "0:a:0", "-vf", filter, "-c:v", "libx264", "-pix_fmt",
                "yuv420p", "-c:a", "aac", "-ar", "48000", "-movflags", "+faststart", output
            ]
        })
    }

    #[cfg(windows)]
    fn packaged_render_plan(
        input: &Path,
        output: &Path,
        plan_id: &str,
        width: u64,
        height: u64,
    ) -> Value {
        packaged_render_plan_with_visibility(input, output, plan_id, width, height, false)
    }

    #[cfg(windows)]
    fn assert_packaged_render_frames_are_black(
        ffmpeg: &Path,
        output: &Path,
        expected_frames: u64,
        width: u64,
        height: u64,
    ) {
        let decoded = std::process::Command::new(ffmpeg)
            .args(["-hide_banner", "-nostdin", "-loglevel", "error", "-i"])
            .arg(output)
            .args([
                "-map", "0:v:0", "-an", "-f", "rawvideo", "-pix_fmt", "gray", "-",
            ])
            .output()
            .expect("packaged FFmpeg must decode the hidden render");
        assert!(
            decoded.status.success(),
            "packaged hidden render must decode: {}",
            String::from_utf8_lossy(&decoded.stderr)
        );
        let expected_samples = expected_frames
            .checked_mul(width)
            .and_then(|samples| samples.checked_mul(height))
            .and_then(|samples| usize::try_from(samples).ok())
            .expect("packaged hidden render sample count must fit usize");
        assert_eq!(
            decoded.stdout.len(),
            expected_samples,
            "packaged hidden render must decode the expected number of gray frames"
        );
        assert!(
            decoded.stdout.iter().all(|sample| *sample <= 32),
            "every decoded packaged hidden-render pixel must be black"
        );
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_media_ipc_status_probe_prepare_and_render_complete() {
        let app = packaged_media_app("complete");
        let cache_root = app.cache_root().to_owned();
        let webview = WebviewWindowBuilder::new(&*app, "packaged-complete", Default::default())
            .build()
            .expect("packaged complete test webview must build");
        let source = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/video-phase1/single-clip.mp4")
            .canonicalize()
            .expect("canonical packaged media fixture must exist");
        let workspace = tempfile::tempdir().expect("packaged complete workspace must exist");
        let output = workspace.path().join("packaged-complete.mp4");
        let hidden_output = workspace.path().join("packaged-hidden.mp4");
        let project_path = workspace.path().join("packaged-media.svpvideo");
        let grants = app.state::<video::VideoPathGrants>();
        let source = grants
            .grant_existing_file("packaged-complete", video::GrantCategory::Source, &source)
            .expect("packaged source path must be granted");
        let output = grants
            .grant_destination("packaged-complete", video::GrantCategory::Output, &output)
            .expect("packaged output path must be granted");
        let hidden_output = grants
            .grant_destination(
                "packaged-complete",
                video::GrantCategory::Output,
                &hidden_output,
            )
            .expect("packaged hidden-render output path must be granted");
        grants
            .grant_destination(
                "packaged-complete",
                video::GrantCategory::Project,
                &project_path,
            )
            .expect("packaged project path must be granted");
        let created = get_ipc_response(
            &webview,
            invoke_request(
                "video_create_project",
                json!({
                    "path": project_path.to_string_lossy(),
                    "name": "Packaged media"
                }),
            ),
        )
        .expect("packaged project create IPC must succeed")
        .deserialize::<Value>()
        .expect("packaged project must be JSON");
        let project_id = created["projectId"]
            .as_str()
            .expect("packaged project ID must be present")
            .to_owned();

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
                    "projectId": project_id.clone(),
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
        let managed_cache_root = cache_root
            .join("supa-video-media-v1")
            .canonicalize()
            .expect("packaged managed-cache root must canonicalize");
        assert!(
            proxy_path.starts_with(&managed_cache_root),
            "packaged proxy must stay under the mock app cache root"
        );
        assert!(
            thumbnail_path.starts_with(&managed_cache_root),
            "packaged thumbnail must stay under the mock app cache root"
        );
        assert_eq!(prepared["proxyProbe"]["videoCodecName"], "h264");
        assert_eq!(prepared["proxyProbe"]["width"], 320);
        assert_eq!(prepared["proxyProbe"]["height"], 180);

        let asset_id = "22222222-2222-4222-8222-222222222222";
        let imported = get_ipc_response(
            &webview,
            invoke_request(
                "video_execute_project_group",
                json!({
                    "request": {
                        "groupId": "77777777-7777-4777-8777-777777777701",
                        "projectId": project_id.clone(),
                        "baseRevision": 0,
                        "commands": [{
                            "type": "ImportAsset",
                            "commandId": "77777777-7777-4777-8777-777777777702",
                            "asset": {
                                "id": asset_id,
                                "displayName": "single-clip.mp4",
                                "locator": { "absolutePath": source.to_string_lossy() },
                                "probe": prepared["sourceProbe"].clone(),
                                "contentIdentity": prepared["sourceIdentity"].clone()
                            }
                        }]
                    }
                }),
            ),
        )
        .expect("packaged grouped import IPC must succeed")
        .deserialize::<Value>()
        .expect("packaged grouped import must be JSON");
        assert_eq!(
            imported["projection"]["state"]["assets"][0]["contentIdentity"],
            prepared["sourceIdentity"]
        );

        let duplicate_source = workspace.path().join("same-bytes-another-name.mp4");
        fs::copy(&source, &duplicate_source).expect("duplicate source bytes must copy");
        let relinked =
            tauri::async_runtime::block_on(video::project::ipc::relink_project_asset_from_path(
                app.handle().clone(),
                "packaged-complete".to_owned(),
                app.state::<video::toolchain::MediaToolchainState>()
                    .inner()
                    .clone(),
                project_id.clone(),
                asset_id.to_owned(),
                duplicate_source.clone(),
            ))
            .expect("packaged managed relink path must succeed");
        assert_eq!(
            relinked.projection.state.assets[0].id.as_str(),
            asset_id,
            "relink must preserve the asset UUID"
        );
        assert_eq!(
            serde_json::to_value(&relinked.projection.state.assets[0].content_identity)
                .expect("relinked identity must serialize"),
            prepared["sourceIdentity"]
        );

        let deduplicated = get_ipc_response(
            &webview,
            invoke_request(
                "video_prepare_asset",
                json!({
                    "projectId": project_id.clone(),
                    "assetId": "77777777-7777-4777-8777-777777777703",
                    "path": duplicate_source.to_string_lossy(),
                    "sequenceRate": { "numerator": 30, "denominator": 1 }
                }),
            ),
        )
        .expect("same bytes under another name must prepare")
        .deserialize::<Value>()
        .expect("deduplicated prepare must be JSON");
        assert_eq!(deduplicated["sourceIdentity"], prepared["sourceIdentity"]);
        assert_eq!(deduplicated["proxyPath"], prepared["proxyPath"]);
        assert_eq!(deduplicated["thumbnailPath"], prepared["thumbnailPath"]);

        fs::write(&proxy_path, b"corrupt packaged proxy")
            .expect("packaged proxy corruption must be injectable");
        let repaired = get_ipc_response(
            &webview,
            invoke_request(
                "video_prepare_asset",
                json!({
                    "projectId": project_id.clone(),
                    "assetId": "77777777-7777-4777-8777-777777777703",
                    "path": duplicate_source.to_string_lossy(),
                    "sequenceRate": { "numerator": 30, "denominator": 1 }
                }),
            ),
        )
        .expect("corrupt exact packaged artifact must repair")
        .deserialize::<Value>()
        .expect("repaired prepare must be JSON");
        assert_eq!(repaired["proxyPath"], prepared["proxyPath"]);
        assert!(
            fs::metadata(&proxy_path)
                .expect("repaired proxy must exist")
                .len()
                > b"corrupt packaged proxy".len() as u64
        );

        app.state::<video::VideoProjectService>()
            .close("packaged-complete", &project_id)
            .expect("packaged project must close cleanly");
        let reopened = app
            .state::<video::VideoProjectService>()
            .open("packaged-complete", &project_path, &grants)
            .expect("packaged project must reopen from persisted identity");
        assert_eq!(
            reopened.projection.state.assets[0].content_identity,
            relinked.projection.state.assets[0].content_identity
        );

        let mut mutated_bytes = fs::read(&duplicate_source).expect("duplicate source must read");
        mutated_bytes.push(0);
        fs::write(&duplicate_source, mutated_bytes).expect("source mutation must write");
        let mutated = get_ipc_response(
            &webview,
            invoke_request(
                "video_prepare_asset",
                json!({
                    "projectId": project_id.clone(),
                    "assetId": "77777777-7777-4777-8777-777777777704",
                    "path": duplicate_source.to_string_lossy(),
                    "sequenceRate": { "numerator": 30, "denominator": 1 }
                }),
            ),
        )
        .expect("mutated packaged source must prepare with a new identity")
        .deserialize::<Value>()
        .expect("mutated prepare must be JSON");
        assert_ne!(mutated["sourceIdentity"], prepared["sourceIdentity"]);
        assert_ne!(mutated["proxyPath"], prepared["proxyPath"]);
        assert_ne!(mutated["thumbnailPath"], prepared["thumbnailPath"]);

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
        assert_eq!(started["planId"], PACKAGED_COMPLETE_PLAN_ID);
        let job_id = started["jobId"]
            .as_str()
            .expect("packaged render start must return a durable job ID")
            .to_owned();
        uuid::Uuid::parse_str(&job_id).expect("packaged render job ID must be a UUID");
        assert_ne!(job_id, PACKAGED_COMPLETE_PLAN_ID);

        let events = wait_for_render_terminal(&captured, Duration::from_secs(120));
        assert!(
            events.len() >= 3,
            "completed render must emit progress: {events:?}"
        );
        assert_render_event_order(&events, &job_id, PACKAGED_COMPLETE_PLAN_ID, "completed");
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
        let hidden_captured = capture_render_events(&app);
        let hidden_started = get_ipc_response(
            &webview,
            invoke_request(
                "video_start_render",
                json!({
                    "plan": packaged_render_plan_with_visibility(
                        &source,
                        &hidden_output,
                        PACKAGED_HIDDEN_PLAN_ID,
                        320,
                        180,
                        true
                    ),
                    "overwrite": false
                }),
            ),
        )
        .expect("packaged hidden render start IPC must succeed")
        .deserialize::<Value>()
        .expect("packaged hidden render start must be JSON");
        assert_eq!(hidden_started["planId"], PACKAGED_HIDDEN_PLAN_ID);
        let hidden_job_id = hidden_started["jobId"]
            .as_str()
            .expect("packaged hidden render start must return a durable job ID")
            .to_owned();
        uuid::Uuid::parse_str(&hidden_job_id)
            .expect("packaged hidden render job ID must be a UUID");

        let hidden_events = wait_for_render_terminal(&hidden_captured, Duration::from_secs(120));
        assert!(
            hidden_events.len() >= 3,
            "completed hidden render must emit progress: {hidden_events:?}"
        );
        assert_render_event_order(
            &hidden_events,
            &hidden_job_id,
            PACKAGED_HIDDEN_PLAN_ID,
            "completed",
        );
        let hidden_completed = hidden_events
            .last()
            .expect("completed hidden-render event must exist");
        assert_eq!(
            hidden_completed["output"]["outputPath"],
            hidden_output.to_string_lossy().as_ref()
        );
        assert!(
            hidden_output.is_file(),
            "packaged hidden render output must exist"
        );
        assert_eq!(
            hidden_completed["output"]["probe"]["videoCodecName"],
            "h264"
        );
        assert_eq!(
            hidden_completed["output"]["probe"]["durationMicroseconds"],
            2_000_000
        );
        assert_eq!(
            hidden_completed["output"]["probe"]["audio"]["codecName"], "aac",
            "packaged hidden render must retain its unmuted audio stream"
        );
        assert_eq!(
            hidden_completed["output"]["probe"]["audio"]["sampleRate"],
            48_000
        );
        assert!(
            !workspace
                .path()
                .join(format!(".svp-part-{PACKAGED_HIDDEN_PLAN_ID}.mp4"))
                .exists(),
            "completed packaged hidden render must remove its partial"
        );
        let ffmpeg = tauri::async_runtime::block_on(
            app.state::<video::toolchain::MediaToolchainState>()
                .verified_ffmpeg(),
        )
        .expect("packaged FFmpeg must reverify before hidden-frame decoding");
        assert_packaged_render_frames_are_black(&ffmpeg, &hidden_output, 60, 320, 180);

        drop(webview);
        app.cleanup();
    }

    #[cfg(windows)]
    #[test]
    #[ignore = "requires the assembled Windows Tauri media resource overlay"]
    fn packaged_media_ipc_render_cancel_cleans_partial() {
        let app = packaged_media_app("cancel");
        let webview = WebviewWindowBuilder::new(&*app, "packaged-cancel", Default::default())
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
        assert_eq!(started["planId"], PACKAGED_CANCEL_PLAN_ID);
        let job_id = started["jobId"]
            .as_str()
            .expect("packaged cancellation start must return a durable job ID")
            .to_owned();
        uuid::Uuid::parse_str(&job_id).expect("packaged cancellation job ID must be a UUID");
        assert_ne!(job_id, PACKAGED_CANCEL_PLAN_ID);
        get_ipc_response(
            &webview,
            invoke_request("video_cancel_render", json!({ "jobId": job_id.clone() })),
        )
        .expect("packaged render cancellation IPC must succeed");

        let events = wait_for_render_terminal(&captured, Duration::from_secs(60));
        assert_render_event_order(&events, &job_id, PACKAGED_CANCEL_PLAN_ID, "cancelled");
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
        drop(webview);
        app.cleanup();
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
