//! Tauri commands for rights: search (advisory), acquire, cancel, refresh,
//! inspect and list. The acquire command takes only provider/item ids, the
//! intended use and the project id — never license, attribution or URL data.

use std::{path::Path, time::Instant};

use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{Manager, Runtime, State, WebviewWindow};

use super::{
    acquire::{acquire, AcquireContext, AcquireError, AcquireStage, MediaVerifier},
    net::{build_client, fetch_bytes, CancelToken, FetchLimits, NetError},
    providers::{self, candidate_for, requires_key},
    refresh::{refresh_receipt, RefreshContext},
    service::{now_ms, RightsService},
    store::SnapshotCheck,
    types::{
        is_valid_provider_item_id, AcquireRequest, AcquisitionReceipt, LicenseSnapshot, MediaKind,
        ProviderId, RightsCandidate, UsePolicyProfile,
    },
};
use crate::video::{
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
    media_store::MediaContentIdentityV1,
    probe::{probe_stream_types_with_program, probe_trusted_media_with_program},
    process::ProcessCancellation,
    toolchain::MediaToolchainState,
    types::MediaProbe,
};

fn rights_error(code: &'static str, message: String) -> VideoCommandError {
    VideoCommandError::new(
        VideoErrorCode::InvalidCommand,
        message,
        json!({ "operation": "rights", "category": code }),
    )
}

fn service<'a, R: Runtime>(
    window: &'a WebviewWindow<R>,
) -> Result<State<'a, RightsService>, VideoCommandError> {
    window.try_state::<RightsService>().ok_or_else(|| {
        rights_error(
            "rights_unavailable",
            "Rights services are not available.".into(),
        )
    })
}

async fn run_blocking<T, F>(task: F) -> Result<T, VideoCommandError>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, VideoCommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(task)
        .await
        .map_err(|_| rights_error("worker", "The rights worker stopped unexpectedly.".into()))?
}

// ---------------------------------------------------------------- search

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RightsSearchRequest {
    pub provider_id: ProviderId,
    pub query: String,
    pub media_kind: MediaKind,
    pub intended_use: UsePolicyProfile,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RightsSearchResponse {
    pub provider_id: ProviderId,
    pub candidates: Vec<RightsCandidate>,
}

/// Advisory search. Results are display-only; acquisition always re-fetches.
#[tauri::command]
pub async fn rights_search<R: Runtime>(
    window: WebviewWindow<R>,
    request: RightsSearchRequest,
) -> Result<RightsSearchResponse, VideoCommandError> {
    let app = window.app_handle().clone();
    service(&window)?;
    run_blocking(move || {
        let service = app.state::<RightsService>();
        let started = Instant::now();
        let key = requires_key(request.provider_id)
            .then(|| service.keys().key(request.provider_id))
            .flatten();
        let fetch = providers::search_request(
            service.endpoints(),
            request.provider_id,
            &request.query,
            request.media_kind,
            key,
        )
        .map_err(|error| {
            rights_error(
                "search_invalid",
                format!("Search is not possible: {error}."),
            )
        })?;
        let policy = service.net_policy(request.provider_id);
        let client = build_client(fetch.limits)
            .map_err(|error| rights_error("network_failed", format!("Search failed: {error}.")))?;
        let result = fetch_bytes(&client, &policy, &fetch, &CancelToken::new());
        eprintln!(
            "rights.search provider={} outcome={} elapsed_ms={}",
            request.provider_id.as_str(),
            if result.is_ok() { "ok" } else { "error" },
            started.elapsed().as_millis()
        );
        let (_, bytes) = result.map_err(|error: NetError| {
            rights_error("network_failed", format!("Search failed: {error}."))
        })?;
        let items = providers::parse_search(request.provider_id, request.media_kind, &bytes)
            .map_err(|error| {
                rights_error(
                    "provider_record_invalid",
                    format!("Search results were unusable: {error}."),
                )
            })?;
        Ok(RightsSearchResponse {
            provider_id: request.provider_id,
            candidates: items
                .iter()
                .map(|item| candidate_for(item, request.intended_use))
                .collect(),
        })
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    pub provider_id: ProviderId,
    pub display_name: &'static str,
    pub requires_key: bool,
    pub key_configured: bool,
}

#[tauri::command]
pub async fn rights_provider_status<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<Vec<ProviderStatus>, VideoCommandError> {
    let app = window.app_handle().clone();
    service(&window)?;
    run_blocking(move || {
        let service = app.state::<RightsService>();
        Ok(ProviderId::ALL
            .into_iter()
            .map(|id| ProviderStatus {
                provider_id: id,
                display_name: id.display_name(),
                requires_key: requires_key(id),
                key_configured: !requires_key(id) || service.keys().key(id).is_some(),
            })
            .collect())
    })
    .await
}

// ---------------------------------------------------------------- acquire

/// Production media verification through the bundled ffprobe.
pub(crate) struct FfprobeVerifier {
    pub(crate) ffprobe: std::ffi::OsString,
}

impl FfprobeVerifier {
    fn probe_video(&self, path: &Path, cancel: &CancelToken) -> Result<MediaProbe, &'static str> {
        let cancellation = ProcessCancellation::new();
        let watcher = cancel.clone();
        let process_cancel = cancellation.clone();
        let result = tauri::async_runtime::block_on(async move {
            let probe = probe_trusted_media_with_program(
                path,
                self.ffprobe.clone(),
                cancellation,
                "acquire_media",
            );
            tokio::pin!(probe);
            loop {
                tokio::select! {
                    result = &mut probe => return result,
                    _ = tokio::time::sleep(std::time::Duration::from_millis(100)) => {
                        if watcher.is_cancelled() {
                            process_cancel.cancel();
                        }
                    }
                }
            }
        });
        result
            .map(|inspected| inspected.probe)
            .map_err(|_| "ffprobe_rejected")
    }
}

impl MediaVerifier for FfprobeVerifier {
    fn verify(
        &self,
        path: &Path,
        kind: MediaKind,
        cancel: &CancelToken,
    ) -> Result<(), &'static str> {
        match kind {
            MediaKind::Video => self.probe_video(path, cancel).map(|_| ()),
            MediaKind::Image | MediaKind::Audio => {
                let streams = tauri::async_runtime::block_on(probe_stream_types_with_program(
                    path,
                    self.ffprobe.clone(),
                    ProcessCancellation::new(),
                    "acquire_media",
                ))
                .map_err(|_| "ffprobe_rejected")?;
                let wanted = if kind == MediaKind::Audio {
                    "audio"
                } else {
                    "video"
                };
                if streams.iter().any(|s| s == wanted) {
                    Ok(())
                } else {
                    Err("unexpected_streams")
                }
            }
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquiredImportSource {
    /// Store object path, granted as a source for this window so it can be imported.
    pub absolute_path: String,
    pub content_identity: MediaContentIdentityV1,
    /// Present for video; images/audio are receipted but cannot go on a video track yet.
    pub probe: Option<MediaProbe>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RightsAcquireResponse {
    pub receipt: AcquisitionReceipt,
    pub import_source: AcquiredImportSource,
}

fn acquire_error(error: &AcquireError) -> VideoCommandError {
    let mut details = json!({ "operation": "rights_acquire", "category": error.code() });
    if let AcquireError::PolicyBlocked(decision) = error {
        details["policy"] = serde_json::to_value(decision).unwrap_or_default();
    }
    if let AcquireError::Net { stage, .. } = error {
        details["stage"] = serde_json::to_value(stage).unwrap_or_default();
    }
    VideoCommandError::new(VideoErrorCode::InvalidCommand, error.message(), details)
}

#[tauri::command]
pub async fn rights_acquire<R: Runtime>(
    window: WebviewWindow<R>,
    toolchain: State<'_, MediaToolchainState>,
    request: AcquireRequest,
) -> Result<RightsAcquireResponse, VideoCommandError> {
    if !is_valid_provider_item_id(&request.provider_item_id) {
        return Err(acquire_error(&AcquireError::InvalidRequest));
    }
    let owner = window.label().to_owned();
    let app = window.app_handle().clone();
    let cancel = service(&window)?.begin(&owner).map_err(|_| {
        rights_error(
            "acquisition_in_progress",
            "Another acquisition is already running in this window.".into(),
        )
    })?;
    let ffprobe = match toolchain.verified_ffprobe().await {
        Ok(path) => path.into_os_string(),
        Err(error) => {
            service(&window)?.finish(&owner);
            return Err(error.into_command_error("rights_acquire"));
        }
    };
    let worker_app = app.clone();
    let worker_owner = owner.clone();
    let result = run_blocking(move || {
        let service = worker_app.state::<RightsService>();
        let verifier = FfprobeVerifier { ffprobe };
        let started = Instant::now();
        let policy_factory = |id: ProviderId| service.net_policy(id);
        let clock = now_ms;
        let on_stage = |stage: AcquireStage| {
            eprintln!(
                "rights.acquire stage={} elapsed_ms={}",
                serde_json::to_value(stage)
                    .ok()
                    .and_then(|v| v.as_str().map(str::to_owned))
                    .unwrap_or_default(),
                started.elapsed().as_millis()
            );
        };
        let ctx = AcquireContext {
            endpoints: service.endpoints(),
            keys: service.keys(),
            store: service.store(),
            app_cache_root: service.app_cache_root(),
            net_policy: &policy_factory,
            verifier: &verifier,
            now_ms: &clock,
            media_limits: FetchLimits::MEDIA,
            cancel,
            on_stage: &on_stage,
        };
        let outcome = acquire(&ctx, &request);
        eprintln!(
            "rights.acquire provider={} outcome={} elapsed_ms={}",
            request.provider_id.as_str(),
            match &outcome {
                Ok(_) => "ok",
                Err(error) => error.code(),
            },
            started.elapsed().as_millis()
        );
        let outcome = outcome.map_err(|error| acquire_error(&error))?;
        let probe = if outcome.receipt.media_kind == MediaKind::Video {
            verifier
                .probe_video(&outcome.object_path, &CancelToken::new())
                .ok()
        } else {
            None
        };
        let grants = worker_app.state::<VideoPathGrants>();
        let granted = grants.grant_existing_file(
            &worker_owner,
            GrantCategory::Source,
            &outcome.object_path,
        )?;
        let absolute_path = granted
            .to_str()
            .ok_or_else(|| VideoCommandError::invalid_path("rights_acquire", "object_path"))?
            .to_owned();
        Ok(RightsAcquireResponse {
            import_source: AcquiredImportSource {
                absolute_path,
                content_identity: outcome.receipt.content.clone(),
                probe,
            },
            receipt: outcome.receipt,
        })
    })
    .await;
    service(&window)?.finish(&owner);
    result
}

#[tauri::command]
pub async fn rights_cancel_acquire<R: Runtime>(
    window: WebviewWindow<R>,
) -> Result<bool, VideoCommandError> {
    Ok(service(&window)?.cancel(window.label()))
}

// ---------------------------------------------------------------- refresh / inspect

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReceiptIdRequest {
    pub receipt_id: uuid::Uuid,
}

#[tauri::command]
pub async fn rights_refresh_receipt<R: Runtime>(
    window: WebviewWindow<R>,
    request: ReceiptIdRequest,
) -> Result<AcquisitionReceipt, VideoCommandError> {
    let app = window.app_handle().clone();
    service(&window)?;
    run_blocking(move || {
        let service = app.state::<RightsService>();
        let policy_factory = |id: ProviderId| service.net_policy(id);
        let started = Instant::now();
        let ctx = RefreshContext {
            endpoints: service.endpoints(),
            keys: service.keys(),
            store: service.store(),
            net_policy: &policy_factory,
            now_ms: now_ms(),
            cancel: CancelToken::new(),
        };
        let result = refresh_receipt(&ctx, &request.receipt_id);
        eprintln!(
            "rights.refresh outcome={} status={} elapsed_ms={}",
            match &result {
                Ok(_) => "ok",
                Err(error) => error.code(),
            },
            result
                .as_ref()
                .map(|r| r.last_refresh_status.as_str())
                .unwrap_or("-"),
            started.elapsed().as_millis()
        );
        result.map_err(|error| rights_error(error.code(), error.message()))
    })
    .await
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInspection {
    pub snapshot: LicenseSnapshot,
    pub integrity: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshInspection {
    pub at_ms: u64,
    pub status: &'static str,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReceiptInspection {
    pub receipt: AcquisitionReceipt,
    pub snapshots: Vec<SnapshotInspection>,
    pub refreshes: Vec<RefreshInspection>,
    pub freshness_window_ms: u64,
}

pub(crate) fn inspect(
    service: &RightsService,
    receipt_id: &uuid::Uuid,
) -> Result<ReceiptInspection, VideoCommandError> {
    let unreadable = || {
        rights_error(
            "store_failed",
            "The rights receipt could not be read.".into(),
        )
    };
    let receipt = service
        .store()
        .receipt(receipt_id)
        .map_err(|_| unreadable())?
        .ok_or_else(|| {
            rights_error("receipt_not_found", "No rights receipt has that id.".into())
        })?;
    let snapshots = receipt
        .snapshots
        .iter()
        .map(|snapshot| {
            let integrity = match service.store().check_snapshot(snapshot) {
                Ok(SnapshotCheck::Ok) => "ok",
                Ok(SnapshotCheck::Missing) => "missing",
                Ok(SnapshotCheck::Tampered) | Err(_) => "tampered",
            };
            SnapshotInspection {
                snapshot: snapshot.clone(),
                integrity,
            }
        })
        .collect();
    let refreshes = service
        .store()
        .refresh_history(receipt_id)
        .map_err(|_| unreadable())?
        .into_iter()
        .map(|r| RefreshInspection {
            at_ms: r.at_ms,
            status: r.status.as_str(),
        })
        .collect();
    Ok(ReceiptInspection {
        receipt,
        snapshots,
        refreshes,
        freshness_window_ms: service.freshness().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn rights_inspect_receipt<R: Runtime>(
    window: WebviewWindow<R>,
    request: ReceiptIdRequest,
) -> Result<ReceiptInspection, VideoCommandError> {
    let app = window.app_handle().clone();
    service(&window)?;
    run_blocking(move || inspect(&app.state::<RightsService>(), &request.receipt_id)).await
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ListReceiptsRequest {
    pub project_id: Option<uuid::Uuid>,
}

#[tauri::command]
pub async fn rights_list_receipts<R: Runtime>(
    window: WebviewWindow<R>,
    request: ListReceiptsRequest,
) -> Result<Vec<AcquisitionReceipt>, VideoCommandError> {
    let app = window.app_handle().clone();
    service(&window)?;
    run_blocking(move || {
        app.state::<RightsService>()
            .store()
            .list_receipts(request.project_id.as_ref())
            .map_err(|_| rights_error("store_failed", "Rights receipts could not be read.".into()))
    })
    .await
}
