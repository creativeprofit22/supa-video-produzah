use std::path::{Path, PathBuf};

use tauri::{AppHandle, Manager, Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{
    service::VideoProjectService,
    types::{
        CommandGroupRequest, CommandResult, OpenedProjectV2, ProjectCommand, ProjectInspector,
        ProjectProjection,
    },
};
use crate::video::{
    error::VideoCommandError,
    grants::{GrantCategory, VideoPathGrants},
    media_store::{ingest_source, IngestedSource},
    probe::probe_trusted_media_with_program,
    process::ProcessCancellation,
    project_io::{dialog_path, require_extension},
    toolchain::MediaToolchainState,
    types::{AssetLocator, MediaContentIdentityV1, MediaProbe},
};

async fn run_project_worker<T, F>(operation: &'static str, task: F) -> Result<T, VideoCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, VideoCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| VideoCommandError::project_io(operation, "worker"))?
}

#[tauri::command]
pub async fn video_create_project<R: Runtime>(
    window: WebviewWindow<R>,
    path: String,
    name: String,
) -> Result<ProjectProjection, VideoCommandError> {
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    run_project_worker("create_project", move || {
        let service = app.state::<VideoProjectService>();
        let grants = app.state::<VideoPathGrants>();
        service.create(&owner, Path::new(&path), &name, &grants)
    })
    .await
}

#[tauri::command]
pub async fn video_open_project<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Option<OpenedProjectV2>, VideoCommandError> {
    let dialog_window = window.clone();
    let selection = run_project_worker("open_project_v2", move || {
        Ok(dialog_window
            .dialog()
            .file()
            .set_parent(&dialog_window)
            .set_title("Open video project")
            .add_filter("Supa Video Project", &["svpvideo"])
            .blocking_pick_file())
    })
    .await?;
    let Some(path) = dialog_path(selection, "open_project_v2", "project")? else {
        return Ok(None);
    };
    require_extension(&path, "svpvideo", "open_project_v2", "project")?;

    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    run_project_worker("open_project_v2", move || {
        let service = app.state::<VideoProjectService>();
        let grants = app.state::<VideoPathGrants>();
        service.open(&owner, &path, &grants).map(Some)
    })
    .await
}

#[derive(Debug)]
struct NativeImport {
    canonical_path: PathBuf,
    probe: MediaProbe,
    content_identity: MediaContentIdentityV1,
}

fn collect_import_targets(
    owner: &str,
    request: &CommandGroupRequest,
    grants: &VideoPathGrants,
) -> Result<Vec<PathBuf>, VideoCommandError> {
    request
        .commands
        .iter()
        .filter_map(|command| match command {
            ProjectCommand::ImportAsset { asset, .. } => Some(&asset.locator),
            _ => None,
        })
        .map(|locator| {
            if locator.relative_path.is_some() {
                return Err(VideoCommandError::invalid_path(
                    "import_project_asset",
                    "relative_locator",
                ));
            }
            let absolute_path = locator.absolute_path.as_deref().ok_or_else(|| {
                VideoCommandError::invalid_path("import_project_asset", "absolute_locator")
            })?;
            grants.authorize(owner, GrantCategory::Source, Path::new(absolute_path))
        })
        .collect()
}

fn execute_project_group_with_native_imports(
    service: &VideoProjectService,
    owner: &str,
    mut request: CommandGroupRequest,
    grants: &VideoPathGrants,
    native_imports: Vec<NativeImport>,
) -> Result<CommandResult, VideoCommandError> {
    if let Some(existing) = service.existing_group_result(owner, &request)? {
        return Ok(existing);
    }
    let mut native_imports = native_imports.into_iter();
    for command in &mut request.commands {
        let ProjectCommand::ImportAsset { asset, .. } = command else {
            continue;
        };
        let native_import = native_imports.next().ok_or_else(|| {
            VideoCommandError::invalid_media("import_project_asset", "missing_native_probe")
        })?;
        if asset.probe != native_import.probe {
            return Err(VideoCommandError::invalid_media(
                "import_project_asset",
                "probe_mismatch",
            ));
        }
        if asset.content_identity.as_ref() != Some(&native_import.content_identity) {
            return Err(VideoCommandError::invalid_media(
                "import_project_asset",
                "content_identity_mismatch",
            ));
        }
        let absolute_path = native_import
            .canonical_path
            .to_str()
            .ok_or_else(|| VideoCommandError::invalid_path("import_project_asset", "source"))?
            .to_owned();
        asset.locator = AssetLocator {
            relative_path: None,
            absolute_path: Some(absolute_path),
        };
        asset.probe = native_import.probe;
        asset.content_identity = Some(native_import.content_identity);
    }
    if native_imports.next().is_some() {
        return Err(VideoCommandError::invalid_media(
            "import_project_asset",
            "unexpected_native_probe",
        ));
    }
    service.execute(owner, request, grants)
}

#[tauri::command]
pub async fn video_execute_project_group<R: Runtime>(
    window: WebviewWindow<R>,
    toolchain: State<'_, MediaToolchainState>,
    request: CommandGroupRequest,
) -> Result<CommandResult, VideoCommandError> {
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    let preflight_app = app.clone();
    let preflight_owner = owner.clone();
    let preflight_request = request.clone();
    if let Some(existing) = run_project_worker("execute_project_group", move || {
        preflight_app
            .state::<VideoProjectService>()
            .existing_group_result(&preflight_owner, &preflight_request)
    })
    .await?
    {
        return Ok(existing);
    }
    let import_targets = {
        let grants = app.state::<VideoPathGrants>();
        collect_import_targets(&owner, &request, &grants)?
    };
    let mut ingested_sources: Vec<(PathBuf, IngestedSource)> =
        Vec::with_capacity(import_targets.len());
    if !import_targets.is_empty() {
        let cache_root = app
            .path()
            .app_cache_dir()
            .map_err(|_| VideoCommandError::project_io("import_project_asset", "app_cache"))?;
        for canonical_path in import_targets {
            let ingested = {
                let grants = app.state::<VideoPathGrants>();
                ingest_source(&owner, &grants, &canonical_path, &cache_root).await?
            };
            ingested_sources.push((canonical_path, ingested));
        }
    }
    let ffprobe = if ingested_sources.is_empty() {
        None
    } else {
        Some(
            toolchain
                .verified_ffprobe()
                .await
                .map_err(|error| error.into_command_error("import_project_asset"))?
                .into_os_string(),
        )
    };
    let mut native_imports = Vec::with_capacity(ingested_sources.len());
    for (canonical_path, ingested) in ingested_sources {
        let probe = probe_trusted_media_with_program(
            &ingested.object_path,
            ffprobe
                .as_ref()
                .expect("non-empty imports must resolve managed FFprobe")
                .clone(),
            ProcessCancellation::new(),
            "import_project_asset",
        )
        .await?
        .probe;
        native_imports.push(NativeImport {
            canonical_path,
            probe,
            content_identity: ingested.identity,
        });
    }
    run_project_worker("execute_project_group", move || {
        let service = app.state::<VideoProjectService>();
        let grants = app.state::<VideoPathGrants>();
        execute_project_group_with_native_imports(
            &service,
            &owner,
            request,
            &grants,
            native_imports,
        )
    })
    .await
}

#[tauri::command]
pub async fn video_undo_project<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
    base_revision: u64,
    operation_id: String,
) -> Result<CommandResult, VideoCommandError> {
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    run_project_worker("undo_project", move || {
        let service = app.state::<VideoProjectService>();
        let grants = app.state::<VideoPathGrants>();
        service.undo(&owner, &project_id, base_revision, &operation_id, &grants)
    })
    .await
}

#[tauri::command]
pub async fn video_redo_project<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
    base_revision: u64,
    operation_id: String,
) -> Result<CommandResult, VideoCommandError> {
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    run_project_worker("redo_project", move || {
        let service = app.state::<VideoProjectService>();
        let grants = app.state::<VideoPathGrants>();
        service.redo(&owner, &project_id, base_revision, &operation_id, &grants)
    })
    .await
}

pub(crate) async fn relink_project_asset_from_path<R: Runtime>(
    app: AppHandle<R>,
    owner: String,
    toolchain: MediaToolchainState,
    project_id: String,
    asset_id: String,
    path: PathBuf,
) -> Result<CommandResult, VideoCommandError> {
    let grant_app = app.clone();
    let grant_owner = owner.clone();
    let normalized = run_project_worker("relink_project_asset", move || {
        grant_app.state::<VideoPathGrants>().grant_existing_file(
            &grant_owner,
            GrantCategory::Source,
            &path,
        )
    })
    .await?;
    let cache_root = app
        .path()
        .app_cache_dir()
        .map_err(|_| VideoCommandError::project_io("relink_project_asset", "app_cache"))?;
    let ingested = {
        let grants = app.state::<VideoPathGrants>();
        ingest_source(&owner, &grants, &normalized, &cache_root).await?
    };
    let ffprobe = toolchain
        .verified_ffprobe()
        .await
        .map_err(|error| error.into_command_error("relink_project_asset"))?
        .into_os_string();
    let probe = probe_trusted_media_with_program(
        &ingested.object_path,
        ffprobe,
        ProcessCancellation::new(),
        "relink_project_asset",
    )
    .await?
    .probe;
    let absolute_path = normalized
        .to_str()
        .ok_or_else(|| VideoCommandError::invalid_path("relink_project_asset", "source"))?
        .to_owned();

    run_project_worker("relink_project_asset", move || {
        let service = app.state::<VideoProjectService>();
        let grants = app.state::<VideoPathGrants>();
        service.relink(
            &owner,
            &project_id,
            &asset_id,
            AssetLocator {
                relative_path: None,
                absolute_path: Some(absolute_path),
            },
            probe,
            Some(ingested.identity),
            &grants,
        )
    })
    .await
}

#[tauri::command]
pub async fn video_relink_project_asset<R: Runtime>(
    window: WebviewWindow<R>,
    toolchain: State<'_, MediaToolchainState>,
    project_id: String,
    asset_id: String,
) -> Result<Option<CommandResult>, VideoCommandError> {
    let dialog_window = window.clone();
    let selection = run_project_worker("relink_project_asset", move || {
        Ok(dialog_window
            .dialog()
            .file()
            .set_parent(&dialog_window)
            .set_title("Relink source video")
            .add_filter(
                "Video",
                &["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg"],
            )
            .blocking_pick_file())
    })
    .await?;
    let Some(path) = dialog_path(selection, "relink_project_asset", "source")? else {
        return Ok(None);
    };
    relink_project_asset_from_path(
        window.app_handle().clone(),
        window.label().to_owned(),
        toolchain.inner().clone(),
        project_id,
        asset_id,
        path,
    )
    .await
    .map(Some)
}

#[tauri::command]
pub async fn video_project_inspector<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
) -> Result<ProjectInspector, VideoCommandError> {
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    run_project_worker("project_inspector", move || {
        app.state::<VideoProjectService>()
            .inspector(&owner, &project_id)
    })
    .await
}

#[tauri::command]
pub async fn video_close_project<R: Runtime>(
    window: WebviewWindow<R>,
    project_id: String,
) -> Result<(), VideoCommandError> {
    let app = window.app_handle().clone();
    let owner = window.label().to_owned();
    run_project_worker("close_project", move || {
        app.state::<VideoProjectService>()
            .close(&owner, &project_id)
    })
    .await
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{
            atomic::{AtomicBool, Ordering},
            mpsc::sync_channel,
            Arc,
        },
        thread,
        time::Duration,
    };

    use serde_json::json;

    use super::{
        collect_import_targets, execute_project_group_with_native_imports, run_project_worker,
        NativeImport,
    };
    use crate::video::{
        project::{
            journal::journal_path, service::VideoProjectService, types::CommandGroupRequest,
        },
        types::{MediaContentAlgorithm, MediaContentIdentityV1, MediaProbe, RationalRate},
        GrantCategory, VideoErrorCode, VideoPathGrants,
    };

    #[tokio::test(flavor = "current_thread")]
    async fn project_ipc_worker_boundary_keeps_async_executor_responsive() {
        let heartbeat_seen = Arc::new(AtomicBool::new(false));
        let (release_tx, release_rx) = sync_channel(0);
        let worker = tokio::spawn(run_project_worker("ipc_responsiveness_test", move || {
            release_rx
                .recv()
                .expect("responsiveness test must release the blocking worker");
            Ok(())
        }));

        let heartbeat_seen_by_task = Arc::clone(&heartbeat_seen);
        let heartbeat = tokio::spawn(async move {
            tokio::task::yield_now().await;
            heartbeat_seen_by_task.store(true, Ordering::SeqCst);
        });
        let heartbeat_seen_by_observer = Arc::clone(&heartbeat_seen);
        let observer = thread::spawn(move || {
            thread::sleep(Duration::from_millis(200));
            let responsive = heartbeat_seen_by_observer.load(Ordering::SeqCst);
            release_tx
                .send(())
                .expect("blocking worker must still be waiting for release");
            responsive
        });

        worker
            .await
            .expect("blocking task must join")
            .expect("blocking task must succeed");
        heartbeat.await.expect("heartbeat task must join");
        assert!(
            observer.join().expect("observer thread must join"),
            "the async executor must run the heartbeat while project work is blocked"
        );
    }

    #[tokio::test]
    async fn project_ipc_worker_failure_remains_a_typed_error() {
        let error = run_project_worker::<(), _>("ipc_worker_test", || {
            panic!("intentional blocking worker panic")
        })
        .await
        .expect_err("a panicked blocking worker must fail");

        assert_eq!(error.code, VideoErrorCode::ProjectIo);
        assert_eq!(error.details["operation"], "ipc_worker_test");
        assert_eq!(error.details["category"], "worker");
    }

    fn import_probe() -> MediaProbe {
        MediaProbe {
            duration_microseconds: 4_000_000,
            average_frame_rate: RationalRate {
                numerator: 25,
                denominator: 1,
            },
            real_frame_rate: RationalRate {
                numerator: 25,
                denominator: 1,
            },
            variable_frame_rate: false,
            width: 720,
            height: 576,
            video_codec_name: "h264".to_owned(),
            audio: None,
            file_size_bytes: 12_000_000,
        }
    }

    fn import_identity() -> MediaContentIdentityV1 {
        MediaContentIdentityV1 {
            schema_version: 1,
            algorithm: MediaContentAlgorithm::Sha256,
            digest: "ab".repeat(32),
            byte_length: 10,
        }
    }

    fn import_group(
        project_id: &str,
        source_path: &str,
        probe: &MediaProbe,
    ) -> CommandGroupRequest {
        let content_identity = import_identity();
        serde_json::from_value(json!({
            "groupId": "81000000-0000-4000-8000-000000000001",
            "projectId": project_id,
            "baseRevision": 0,
            "commands": [
                {
                    "type": "ImportAsset",
                    "commandId": "81000000-0000-4000-8000-000000000002",
                    "asset": {
                        "id": "81000000-0000-4000-8000-000000000003",
                        "displayName": "source.mp4",
                        "locator": { "absolutePath": source_path },
                        "probe": probe,
                        "contentIdentity": content_identity
                    }
                },
                {
                    "type": "CreateSequence",
                    "commandId": "81000000-0000-4000-8000-000000000004",
                    "sequence": {
                        "id": "81000000-0000-4000-8000-000000000005",
                        "name": "Sequence 1",
                        "rate": { "numerator": 25, "denominator": 1 },
                        "width": 720,
                        "height": 576,
                        "audioSampleRate": 48000,
                        "tracks": [{
                            "id": "81000000-0000-4000-8000-000000000006",
                            "name": "Video 1",
                            "kind": "video",
                            "clips": []
                        }],
                        "markers": []
                    }
                },
                {
                    "type": "InsertClip",
                    "commandId": "81000000-0000-4000-8000-000000000007",
                    "sequenceId": "81000000-0000-4000-8000-000000000005",
                    "trackId": "81000000-0000-4000-8000-000000000006",
                    "clip": {
                        "id": "81000000-0000-4000-8000-000000000008",
                        "source": {
                            "kind": "asset",
                            "assetId": "81000000-0000-4000-8000-000000000003"
                        },
                        "timelineStart": {
                            "value": 0,
                            "rateNumerator": 25,
                            "rateDenominator": 1
                        },
                        "sourceIn": {
                            "value": 0,
                            "rateNumerator": 25,
                            "rateDenominator": 1
                        },
                        "sourceOut": {
                            "value": 100,
                            "rateNumerator": 25,
                            "rateDenominator": 1
                        },
                        "transform": {
                            "positionXPermille": 0,
                            "positionYPermille": 0,
                            "scaleXPermille": 1000,
                            "scaleYPermille": 1000,
                            "rotationMilliDegrees": 0,
                            "opacityPermille": 1000
                        },
                        "gainMilliDecibels": 0
                    }
                }
            ]
        }))
        .expect("canonical import group must deserialize")
    }

    #[test]
    fn native_import_gateway_rejects_tampered_probe_without_mutation_then_commits_group() {
        let workspace = tempfile::tempdir().expect("import gateway workspace must exist");
        let project_path = workspace.path().join("import-gateway.svpvideo");
        let source_path = workspace.path().join("source.mp4");
        fs::write(&source_path, b"mock media").expect("mock media must be writable");

        let owner = "import-gateway-owner";
        let grants = VideoPathGrants::default();
        grants
            .grant_destination(owner, GrantCategory::Project, &project_path)
            .expect("project destination must be granted");
        let canonical_source = grants
            .grant_existing_file(owner, GrantCategory::Source, &source_path)
            .expect("source must be picker-granted");
        let service = VideoProjectService::default();
        let created = service
            .create(owner, &project_path, "Import gateway", &grants)
            .expect("project must be created");
        let probe = import_probe();
        let canonical_request = import_group(
            &created.project_id,
            canonical_source
                .to_str()
                .expect("test source path must be UTF-8"),
            &probe,
        );

        let native_imports = collect_import_targets(owner, &canonical_request, &grants)
            .expect("picker-granted import target must be accepted")
            .into_iter()
            .map(|canonical_path| NativeImport {
                canonical_path,
                probe: probe.clone(),
                content_identity: import_identity(),
            })
            .collect();
        let mut tampered_request = canonical_request.clone();
        let crate::video::project::types::ProjectCommand::ImportAsset { asset, .. } =
            &mut tampered_request.commands[0]
        else {
            unreachable!("first command must import the asset");
        };
        asset.probe.duration_microseconds += 1;
        let journal = journal_path(&project_path).expect("journal path must resolve");
        let journal_before = fs::read(&journal).expect("journal must exist");

        let error = execute_project_group_with_native_imports(
            &service,
            owner,
            tampered_request,
            &grants,
            native_imports,
        )
        .expect_err("caller probe tampering must be rejected");
        assert_eq!(error.code, VideoErrorCode::InvalidMedia);
        assert_eq!(error.details["operation"], "import_project_asset");
        assert_eq!(error.details["category"], "probe_mismatch");
        assert_eq!(
            service
                .inspector(owner, &created.project_id)
                .expect("project must remain inspectable")
                .revision
                .number,
            0
        );
        assert_eq!(
            fs::read(&journal).expect("journal must remain readable"),
            journal_before,
            "a rejected import must not append a journal record"
        );

        let mut identity_tampered_request = canonical_request.clone();
        let crate::video::project::types::ProjectCommand::ImportAsset { asset, .. } =
            &mut identity_tampered_request.commands[0]
        else {
            unreachable!("first command must import the asset");
        };
        asset
            .content_identity
            .as_mut()
            .expect("import identity must be present")
            .digest = "cd".repeat(32);
        let identity_error = execute_project_group_with_native_imports(
            &service,
            owner,
            identity_tampered_request,
            &grants,
            vec![NativeImport {
                canonical_path: canonical_source.clone(),
                probe: probe.clone(),
                content_identity: import_identity(),
            }],
        )
        .expect_err("caller content identity tampering must be rejected");
        assert_eq!(identity_error.code, VideoErrorCode::InvalidMedia);
        assert_eq!(
            identity_error.details["category"],
            "content_identity_mismatch"
        );
        assert_eq!(
            fs::read(&journal).expect("journal must remain readable"),
            journal_before,
            "identity rejection must not append a journal record"
        );

        let native_imports = collect_import_targets(owner, &canonical_request, &grants)
            .expect("canonical import target must remain accepted")
            .into_iter()
            .map(|canonical_path| NativeImport {
                canonical_path,
                probe: probe.clone(),
                content_identity: import_identity(),
            })
            .collect();
        let result = execute_project_group_with_native_imports(
            &service,
            owner,
            canonical_request.clone(),
            &grants,
            native_imports,
        )
        .expect("native-bound grouped import must commit");

        assert_eq!(result.prior_revision.number, 0);
        assert_eq!(result.new_revision.number, 1);
        assert_eq!(result.projection.state.assets.len(), 1);
        assert_eq!(result.projection.state.sequences.len(), 1);
        assert_eq!(result.projection.state.assets[0].probe, probe);
        assert_eq!(
            result.projection.state.assets[0].content_identity,
            Some(import_identity())
        );
        assert_eq!(
            result.projection.state.assets[0]
                .locator
                .absolute_path
                .as_deref(),
            canonical_source.to_str()
        );
        assert_eq!(
            result.projection.state.sequences[0].tracks[0]
                .clips()
                .expect("video track must contain clips")
                .len(),
            1
        );
        fs::remove_file(&source_path).expect("the imported source must be removable");
        grants
            .revoke_window(owner)
            .expect("retry must not depend on retained grants");
        let duplicate = execute_project_group_with_native_imports(
            &service,
            owner,
            canonical_request,
            &grants,
            vec![],
        )
        .expect("an idempotent retry must return before source revalidation");
        assert_eq!(duplicate, result);
    }
}
