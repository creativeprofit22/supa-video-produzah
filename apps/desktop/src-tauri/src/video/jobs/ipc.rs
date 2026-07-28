use serde::{Deserialize, Serialize};
use tauri::{Runtime, State, WebviewWindow};

use crate::video::{
    derived::MediaPrograms, error::VideoCommandError, toolchain::MediaToolchainState,
};

use super::{
    model::{MediaCacheStatus, MediaJobEvent, MediaJobRecord, MediaJobRecoveryReport},
    store::MediaStateStoreError,
    MediaJobService,
};

pub(crate) const VIDEO_MEDIA_JOB_EVENT: &str = "video:media-job-event";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ListMediaJobsRequest {
    limit: u32,
    include_settled: bool,
    project_id: Option<String>,
    before_updated_at: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaJobListResponse {
    schema_version: u8,
    jobs: Vec<MediaJobRecord>,
    next_before_updated_at: Option<String>,
    latest_event_id: u64,
    recovery: Option<MediaJobRecoveryReport>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct GetMediaJobEventsRequest {
    job_id: Option<String>,
    after_event_id: u64,
    limit: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaJobEventListResponse {
    schema_version: u8,
    events: Vec<MediaJobEvent>,
    latest_event_id: u64,
    has_more: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaJobActionRequest {
    job_id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MediaJobActionResponse {
    schema_version: u8,
    job: MediaJobRecord,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ClearLegacyMediaCacheRequest {
    confirmed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearLegacyMediaCacheResponse {
    schema_version: u8,
    cleared_bytes: u64,
    cleared_entry_count: u64,
    skipped_unsafe_entry_count: u64,
    status: MediaCacheStatus,
}

#[tauri::command]
pub(crate) async fn video_list_media_jobs(
    jobs: State<'_, MediaJobService>,
    request: ListMediaJobsRequest,
) -> Result<MediaJobListResponse, VideoCommandError> {
    let limit = usize::try_from(request.limit).map_err(|_| job_error("list_limit"))?;
    let before = request
        .before_updated_at
        .as_deref()
        .map(parse_timestamp)
        .transpose()?;
    let records = jobs
        .store()
        .list(limit, request.include_settled, request.project_id, before)
        .await
        .map_err(map_store_error)?;
    let next_before_updated_at = (records.len() == limit)
        .then(|| records.last().map(|record| record.updated_at.clone()))
        .flatten();
    let latest_event_id = jobs
        .store()
        .events(None, 0, 1)
        .await
        .map_err(map_store_error)?
        .latest_event_id;
    Ok(MediaJobListResponse {
        schema_version: 1,
        jobs: records,
        next_before_updated_at,
        latest_event_id,
        recovery: Some(jobs.recovery()),
    })
}

#[tauri::command]
pub(crate) async fn video_get_media_job_events(
    jobs: State<'_, MediaJobService>,
    request: GetMediaJobEventsRequest,
) -> Result<MediaJobEventListResponse, VideoCommandError> {
    let page = jobs
        .store()
        .events(
            request.job_id,
            request.after_event_id,
            usize::try_from(request.limit).map_err(|_| job_error("event_limit"))?,
        )
        .await
        .map_err(map_store_error)?;
    Ok(MediaJobEventListResponse {
        schema_version: 1,
        events: page.events,
        latest_event_id: page.latest_event_id,
        has_more: page.has_more,
    })
}

#[tauri::command]
pub(crate) async fn video_cancel_media_job<R: Runtime>(
    window: WebviewWindow<R>,
    jobs: State<'_, MediaJobService>,
    request: MediaJobActionRequest,
) -> Result<MediaJobActionResponse, VideoCommandError> {
    let job = cancel_media_job_for_owner(&jobs, window.label(), request.job_id).await?;
    Ok(MediaJobActionResponse {
        schema_version: 1,
        job,
    })
}

pub(super) async fn cancel_media_job_for_owner(
    jobs: &MediaJobService,
    owner_label: &str,
    job_id: String,
) -> Result<MediaJobRecord, VideoCommandError> {
    jobs.cancel_job(&job_id, owner_label)
        .await
        .map_err(map_store_error)
}

#[tauri::command]
pub(crate) async fn video_retry_media_job<R: Runtime>(
    window: WebviewWindow<R>,
    jobs: State<'_, MediaJobService>,
    toolchain: State<'_, MediaToolchainState>,
    request: MediaJobActionRequest,
) -> Result<MediaJobActionResponse, VideoCommandError> {
    let job = jobs
        .retry_job(
            &request.job_id,
            window.label(),
            MediaPrograms::bundled(toolchain.inner().clone()),
        )
        .await
        .map_err(map_store_error)?;
    Ok(MediaJobActionResponse {
        schema_version: 1,
        job,
    })
}

#[tauri::command]
pub(crate) async fn video_get_media_cache_status(
    jobs: State<'_, MediaJobService>,
) -> Result<MediaCacheStatus, VideoCommandError> {
    let mut status = jobs.cache().status().await.map_err(map_store_error)?;
    status.recovery_warning = jobs.recovery().warning;
    status
        .validate()
        .map_err(MediaStateStoreError::from)
        .map_err(map_store_error)?;
    Ok(status)
}

#[tauri::command]
pub(crate) async fn video_clear_legacy_media_cache(
    jobs: State<'_, MediaJobService>,
    request: ClearLegacyMediaCacheRequest,
) -> Result<ClearLegacyMediaCacheResponse, VideoCommandError> {
    if !request.confirmed {
        return Err(job_error("confirmation_required"));
    }
    let cleared = jobs.cache().clear_legacy().await.map_err(map_store_error)?;
    let mut status = jobs.cache().status().await.map_err(map_store_error)?;
    status.recovery_warning = jobs.recovery().warning;
    status
        .validate()
        .map_err(MediaStateStoreError::from)
        .map_err(map_store_error)?;
    Ok(ClearLegacyMediaCacheResponse {
        schema_version: 1,
        cleared_bytes: cleared.cleared_bytes,
        cleared_entry_count: cleared.cleared_entries,
        skipped_unsafe_entry_count: cleared.skipped_unsafe_entries,
        status,
    })
}

fn parse_timestamp(value: &str) -> Result<i64, VideoCommandError> {
    chrono::DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.timestamp_millis())
        .map_err(|_| job_error("timestamp"))
}

fn map_store_error(_error: MediaStateStoreError) -> VideoCommandError {
    #[cfg(test)]
    eprintln!("media job IPC store error: {_error:?}");
    job_error("media_state")
}

fn job_error(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_io("media_jobs", category)
}
