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
    before_job_id: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct MediaJobListResponse {
    schema_version: u8,
    jobs: Vec<MediaJobRecord>,
    unsettled_parent_count: u64,
    next_before_updated_at: Option<String>,
    next_before_job_id: Option<String>,
    latest_event_id: u64,
    recovery: Option<MediaJobRecoveryReport>,
}

fn cursor_pair_is_complete<T, U>(timestamp: &Option<T>, job_id: &Option<U>) -> bool {
    timestamp.is_some() == job_id.is_some()
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
    if !cursor_pair_is_complete(&request.before_updated_at, &request.before_job_id) {
        return Err(job_error("cursor_pair"));
    }
    let cursor = match (request.before_updated_at, request.before_job_id) {
        (None, None) => None,
        (Some(timestamp), Some(job_id)) => {
            let timestamp = parse_timestamp(&timestamp)?;
            let job_id = uuid::Uuid::parse_str(&job_id)
                .map_err(|_| job_error("cursor_job_id"))?
                .to_string();
            Some((timestamp, job_id))
        }
        _ => unreachable!("the composite cursor was validated above"),
    };
    let page = jobs
        .store()
        .list(limit, request.include_settled, request.project_id, cursor)
        .await
        .map_err(map_store_error)?;
    let (next_before_updated_at, next_before_job_id) = if page.has_more {
        let last = page.jobs.last().ok_or_else(|| job_error("cursor_empty"))?;
        (Some(last.updated_at.clone()), Some(last.id.clone()))
    } else {
        (None, None)
    };
    let latest_event_id = jobs
        .store()
        .events(None, 0, 1)
        .await
        .map_err(map_store_error)?
        .latest_event_id;
    let response = MediaJobListResponse {
        schema_version: 1,
        jobs: page.jobs,
        unsettled_parent_count: page.unsettled_parent_count,
        next_before_updated_at,
        next_before_job_id,
        latest_event_id,
        recovery: Some(jobs.recovery()),
    };
    debug_assert!(cursor_pair_is_complete(
        &response.next_before_updated_at,
        &response.next_before_job_id
    ));
    Ok(response)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_list_fixture_has_strict_ipc_dto_parity_and_rejects_half_cursors() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../packages/video-media/fixtures/media-state-v1/public-contracts.json");
        let fixture: serde_json::Value =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let envelopes = fixture["listEnvelopes"].as_array().unwrap();
        assert_eq!(envelopes.len(), 2);

        for envelope in envelopes {
            let request: ListMediaJobsRequest =
                serde_json::from_value(envelope["listRequest"].clone()).unwrap();
            assert!(cursor_pair_is_complete(
                &request.before_updated_at,
                &request.before_job_id
            ));

            let response: MediaJobListResponse =
                serde_json::from_value(envelope["listResponse"].clone()).unwrap();
            assert!(cursor_pair_is_complete(
                &response.next_before_updated_at,
                &response.next_before_job_id
            ));
            assert_eq!(
                serde_json::to_value(response).unwrap(),
                envelope["listResponse"]
            );
        }

        for missing_field in ["beforeUpdatedAt", "beforeJobId"] {
            let mut half_request = envelopes[1]["listRequest"].clone();
            half_request[missing_field] = serde_json::Value::Null;
            let request: ListMediaJobsRequest = serde_json::from_value(half_request).unwrap();
            assert!(!cursor_pair_is_complete(
                &request.before_updated_at,
                &request.before_job_id
            ));
        }

        for missing_field in ["nextBeforeUpdatedAt", "nextBeforeJobId"] {
            let mut half_response = envelopes[0]["listResponse"].clone();
            half_response[missing_field] = serde_json::Value::Null;
            let response: MediaJobListResponse = serde_json::from_value(half_response).unwrap();
            assert!(!cursor_pair_is_complete(
                &response.next_before_updated_at,
                &response.next_before_job_id
            ));
        }

        let mut unknown_response = envelopes[0]["listResponse"].clone();
        unknown_response["next_before_job_id"] = serde_json::json!(null);
        assert!(serde_json::from_value::<MediaJobListResponse>(unknown_response).is_err());
    }
}
