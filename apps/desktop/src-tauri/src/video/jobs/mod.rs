pub(crate) mod ipc;
pub(crate) mod model;
pub(crate) mod scheduler;
pub(crate) mod store;

use std::{
    collections::{HashSet, VecDeque},
    sync::{Arc, Mutex},
};

use super::{
    cache::MediaCacheService,
    derived::{preparation_worker_from_durable_job, MediaPrograms},
};
use model::{
    MediaJobErrorCategory, MediaJobEventType, MediaJobKind, MediaJobProgress, MediaJobRecord,
    MediaJobRecoveryAction, MediaJobRecoveryReport, MediaJobState,
};
use scheduler::{
    default_blocked_error, MediaJobScheduler, MediaJobWorker, MediaSchedulerConfig,
    SchedulerCancellation, SchedulerResource, SystemSchedulerClock,
};
use store::{MediaJobStore, MediaJobTransition, MediaStateStoreError, StoredPrivateJob};
use uuid::Uuid;

pub struct MediaJobService {
    store: MediaJobStore,
    scheduler: Arc<MediaJobScheduler>,
    scheduler_task: Mutex<Option<tokio::task::JoinHandle<()>>>,
    cache: MediaCacheService,
    recovery: Mutex<MediaJobRecoveryReport>,
    retry_gate: tokio::sync::Mutex<()>,
}

impl MediaJobService {
    pub(crate) async fn initialize(
        local_data_dir: std::path::PathBuf,
        app_cache_root: std::path::PathBuf,
    ) -> Result<Self, MediaStateStoreError> {
        let store = MediaJobStore::initialize(local_data_dir).await?;
        let session_id = Uuid::new_v4().to_string();
        let recovery = store
            .recover(session_id.clone(), current_timestamp_millis())
            .await?;
        let scheduler = MediaJobScheduler::new(
            store.clone(),
            MediaSchedulerConfig::default(),
            Arc::new(SystemSchedulerClock),
        )?;
        let cache = MediaCacheService::new(&store, app_cache_root, session_id);
        let cache_io_permit = scheduler
            .acquire_resource_permit(SchedulerResource::BlockingIo)
            .await?;
        cache.rebuild_owned_inventory().await?;
        cache
            .cleanup_stale_builds(std::time::Duration::from_secs(24 * 60 * 60))
            .await?;
        drop(cache_io_permit);
        let scheduler_task = scheduler.start();
        Ok(Self {
            store,
            scheduler,
            scheduler_task: Mutex::new(Some(scheduler_task)),
            cache,
            recovery: Mutex::new(recovery),
            retry_gate: tokio::sync::Mutex::new(()),
        })
    }

    pub(crate) fn store(&self) -> &MediaJobStore {
        &self.store
    }

    pub(crate) fn scheduler(&self) -> &Arc<MediaJobScheduler> {
        &self.scheduler
    }

    pub(crate) fn cache(&self) -> &MediaCacheService {
        &self.cache
    }

    pub(crate) fn recovery(&self) -> MediaJobRecoveryReport {
        self.recovery
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    #[cfg(not(test))]
    pub(crate) fn record_recovery_warning(&self, warning: &'static str) {
        self.recovery
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .warning = Some(warning.to_owned());
    }

    pub(crate) async fn retry_job(
        &self,
        job_id: &str,
        owner_label: &str,
        programs: MediaPrograms,
    ) -> Result<MediaJobRecord, MediaStateStoreError> {
        let cache = self.cache.clone();
        self.retry_job_with_factory(job_id, owner_label, move |stored| {
            preparation_worker_from_durable_job(stored, owner_label, programs, cache)
                .map_err(|_| MediaStateStoreError::InvalidTransition)
        })
        .await
    }

    async fn retry_job_with_factory<WorkerFactory>(
        &self,
        job_id: &str,
        owner_label: &str,
        worker_factory: WorkerFactory,
    ) -> Result<MediaJobRecord, MediaStateStoreError>
    where
        WorkerFactory:
            FnOnce(&StoredPrivateJob) -> Result<Arc<dyn MediaJobWorker>, MediaStateStoreError>,
    {
        let _retry_guard = self.retry_gate.lock().await;
        let stored = self.store.get_private(job_id.to_owned()).await?;
        if stored
            .private_payload
            .get("ownerLabel")
            .and_then(serde_json::Value::as_str)
            != Some(owner_label)
        {
            return Err(MediaStateStoreError::NotFound);
        }

        if stored.public.kind == MediaJobKind::FinalRender {
            return self.require_fresh_output_authorization(stored).await;
        }
        if !matches!(
            stored.public.state,
            MediaJobState::Failed | MediaJobState::Blocked
        ) || !matches!(
            stored.public.kind,
            MediaJobKind::Proxy | MediaJobKind::ThumbnailTile
        ) || stored.payload_version != 1
            || stored
                .private_payload
                .get("canonicalObjectAvailable")
                .and_then(serde_json::Value::as_bool)
                != Some(true)
        {
            return Err(MediaStateStoreError::InvalidTransition);
        }

        let worker = worker_factory(&stored)?;
        self.scheduler
            .retry_with_worker(&stored.public.id, SchedulerResource::Ffmpeg, worker)
            .await
    }

    async fn require_fresh_output_authorization(
        &self,
        stored: StoredPrivateJob,
    ) -> Result<MediaJobRecord, MediaStateStoreError> {
        if stored.public.state == MediaJobState::Blocked
            && stored.public.error.as_ref().is_some_and(|error| {
                error.category == MediaJobErrorCategory::OutputAuthorizationRequired
                    && error.action == Some(MediaJobRecoveryAction::ReauthorizeOutput)
            })
        {
            return Ok(stored.public);
        }
        if !matches!(
            stored.public.state,
            MediaJobState::Failed | MediaJobState::Blocked
        ) {
            return Err(MediaStateStoreError::InvalidTransition);
        }
        let error = default_blocked_error(MediaJobErrorCategory::OutputAuthorizationRequired);
        self.store
            .transition(
                stored.public.id,
                MediaJobTransition {
                    state: MediaJobState::Blocked,
                    stage: "authorization".to_owned(),
                    progress: stored.public.progress,
                    attempt: Some(0),
                    error: Some(error.clone()),
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some(error.message),
                    occurred_at_ms: current_timestamp_millis(),
                },
            )
            .await
    }

    pub(crate) async fn cancel_job(
        &self,
        job_id: &str,
        owner_label: &str,
    ) -> Result<MediaJobRecord, MediaStateStoreError> {
        let target = self.store.get_private(job_id.to_owned()).await?;
        if target
            .private_payload
            .get("ownerLabel")
            .and_then(serde_json::Value::as_str)
            != Some(owner_label)
        {
            return Err(MediaStateStoreError::NotFound);
        }
        if target.public.state.is_terminal() {
            return Ok(target.public);
        }

        let descendants = self.descendants(job_id).await?;
        for descendant in &descendants {
            let stored = self.store.get_private(descendant.id.clone()).await?;
            if stored
                .private_payload
                .get("ownerLabel")
                .and_then(serde_json::Value::as_str)
                != Some(owner_label)
            {
                return Err(MediaStateStoreError::NotFound);
            }
        }
        let requested_at = current_timestamp_millis();
        self.store
            .request_cancellation(job_id.to_owned(), requested_at)
            .await?;
        for descendant in &descendants {
            self.store
                .request_cancellation(descendant.id.clone(), requested_at)
                .await?;
        }

        let mut running_cancellations = HashSet::new();
        for descendant in &descendants {
            if descendant.state.is_terminal() {
                continue;
            }
            if self.scheduler.signal_cancellation(&descendant.id).await
                == Some(SchedulerCancellation::Running)
            {
                running_cancellations.insert(descendant.id.clone());
            }
        }

        for descendant in &descendants {
            if running_cancellations.contains(&descendant.id) {
                self.wait_for_settlement(&descendant.id).await?;
            }
        }
        for descendant in descendants.iter().rev() {
            if !running_cancellations.contains(&descendant.id) {
                self.settle_cancelled_once(&descendant.id).await?;
            }
        }

        if descendants.is_empty() {
            match self.scheduler.signal_cancellation(job_id).await {
                Some(SchedulerCancellation::Running) => self.wait_for_settlement(job_id).await?,
                Some(SchedulerCancellation::Queued) | None => {
                    self.settle_cancelled_once(job_id).await?;
                }
            }
        } else {
            self.settle_cancelled_once(job_id).await?;
        }

        Ok(self.store.get_private(job_id.to_owned()).await?.public)
    }

    async fn descendants(&self, job_id: &str) -> Result<Vec<MediaJobRecord>, MediaStateStoreError> {
        let mut pending = VecDeque::from([job_id.to_owned()]);
        let mut visited = HashSet::from([job_id.to_owned()]);
        let mut descendants = Vec::new();
        while let Some(parent_id) = pending.pop_front() {
            for child in self.store.child_jobs(parent_id).await? {
                if visited.insert(child.id.clone()) {
                    pending.push_back(child.id.clone());
                    descendants.push(child);
                }
            }
        }
        Ok(descendants)
    }

    async fn wait_for_settlement(&self, job_id: &str) -> Result<(), MediaStateStoreError> {
        loop {
            if self
                .store
                .get_private(job_id.to_owned())
                .await?
                .public
                .state
                .is_terminal()
            {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }

    async fn settle_cancelled_once(&self, job_id: &str) -> Result<(), MediaStateStoreError> {
        let current = self.store.get_private(job_id.to_owned()).await?.public;
        if current.state.is_terminal() {
            return Ok(());
        }
        let transition = MediaJobTransition {
            state: MediaJobState::Cancelled,
            stage: "cancelled".to_owned(),
            progress: MediaJobProgress {
                completed: current.progress.completed,
                total: current.progress.total,
                unit: current.progress.unit,
            },
            attempt: None,
            error: None,
            retry_at_ms: None,
            result: None,
            cancellation_requested: true,
            event_type: MediaJobEventType::StateChanged,
            message: Some("Media job cancelled.".to_owned()),
            occurred_at_ms: current_timestamp_millis(),
        };
        match self.store.transition(job_id.to_owned(), transition).await {
            Ok(_) => Ok(()),
            Err(MediaStateStoreError::InvalidTransition) => {
                let current = self.store.get_private(job_id.to_owned()).await?.public;
                if current.state.is_terminal() {
                    Ok(())
                } else {
                    Err(MediaStateStoreError::InvalidTransition)
                }
            }
            Err(error) => Err(error),
        }
    }

    pub(crate) async fn cancel_owner(&self, owner_label: &str) -> Result<(), MediaStateStoreError> {
        let jobs = self.store.recovery_jobs().await?;
        let mut owned_ids = HashSet::new();
        for job in &jobs {
            let stored = self.store.get_private(job.id.clone()).await?;
            let belongs_to_owner = stored
                .private_payload
                .get("ownerLabel")
                .and_then(serde_json::Value::as_str)
                .is_some_and(|owner| owner == owner_label);
            if belongs_to_owner {
                owned_ids.insert(job.id.clone());
            }
        }
        for job in jobs.iter().filter(|job| {
            owned_ids.contains(&job.id)
                && job
                    .parent_id
                    .as_ref()
                    .is_none_or(|parent_id| !owned_ids.contains(parent_id))
        }) {
            self.cancel_job(&job.id, owner_label).await?;
        }
        self.cache.release_owner(owner_label.to_owned()).await?;
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> Result<(), MediaStateStoreError> {
        self.scheduler.shutdown().await;
        let task = self
            .scheduler_task
            .lock()
            .map_err(|_| MediaStateStoreError::LockPoisoned)?
            .take();
        if let Some(task) = task {
            task.await
                .map_err(|_| MediaStateStoreError::WorkerStopped)?;
        }
        self.cache.release_all_session().await?;
        self.store.passive_checkpoint().await
    }
}

pub(crate) fn current_timestamp_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        path::PathBuf,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc,
        },
        time::Duration,
    };

    use super::{
        ipc::cancel_media_job_for_owner,
        model::{
            MediaJobError, MediaJobErrorCategory, MediaJobKind, MediaJobPriority,
            MediaJobProgressUnit, MediaJobRecoveryAction,
        },
        scheduler::{MediaJobWorker, MediaWorkerFuture, MediaWorkerOutcome, SchedulerResource},
        store::NewMediaJob,
        *,
    };
    use crate::video::process::ProcessCancellation;

    struct CancellableFfmpegWorker {
        partial_path: PathBuf,
        started: Arc<AtomicBool>,
        cancellation_signalled: Arc<AtomicBool>,
        cleanup_count: Arc<AtomicUsize>,
    }

    impl MediaJobWorker for CancellableFfmpegWorker {
        fn run(&self, _job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
            let partial_path = self.partial_path.clone();
            let started = self.started.clone();
            let cancellation_signalled = self.cancellation_signalled.clone();
            let cleanup_count = self.cleanup_count.clone();
            Box::pin(async move {
                fs::write(&partial_path, b"partial ffmpeg output")
                    .expect("running FFmpeg worker partial must be writable");
                started.store(true, Ordering::Release);
                while !cancellation.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                cancellation_signalled.store(true, Ordering::Release);
                fs::remove_file(&partial_path)
                    .expect("cancelled FFmpeg worker must remove its partial");
                cleanup_count.fetch_add(1, Ordering::AcqRel);
                MediaWorkerOutcome::Cancelled {
                    progress: MediaJobProgress {
                        completed: 0,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                }
            })
        }
    }

    struct QueuedWorker {
        calls: Arc<AtomicUsize>,
    }

    impl MediaJobWorker for QueuedWorker {
        fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
            let calls = self.calls.clone();
            Box::pin(async move {
                calls.fetch_add(1, Ordering::AcqRel);
                MediaWorkerOutcome::Complete {
                    result: serde_json::json!({"unexpected": true}),
                    progress: MediaJobProgress {
                        completed: 1,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                }
            })
        }
    }

    async fn enqueue_job(
        jobs: &MediaJobService,
        kind: MediaJobKind,
        parent_id: Option<String>,
        dedupe_key: &str,
        owner_label: &str,
    ) -> MediaJobRecord {
        let is_parent = kind == MediaJobKind::AssetPreparation;
        jobs.store()
            .enqueue(NewMediaJob {
                kind,
                parent_id,
                dedupe_key: dedupe_key.to_owned(),
                project_id: None,
                asset_id: None,
                revision_id: None,
                priority: MediaJobPriority::Interactive,
                priority_value: 0,
                stage: "queued".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: if is_parent { 2 } else { 1 },
                    unit: if is_parent {
                        MediaJobProgressUnit::Stages
                    } else {
                        MediaJobProgressUnit::Items
                    },
                },
                max_attempts: 3,
                summary: format!("Test {dedupe_key}"),
                private_payload: serde_json::json!({
                    "canonicalObjectAvailable": true,
                    "ownerLabel": owner_label,
                }),
                created_at_ms: current_timestamp_millis(),
            })
            .await
            .expect("hierarchical cancellation fixture must enqueue")
            .job
    }

    async fn cancelled_event_count(jobs: &MediaJobService, job_id: &str) -> usize {
        jobs.store()
            .events(Some(job_id.to_owned()), 0, 100)
            .await
            .expect("cancelled job events must load")
            .events
            .iter()
            .filter(|event| event.state == MediaJobState::Cancelled)
            .count()
    }

    async fn persist_failed_retry_job(
        local_data_dir: PathBuf,
        kind: MediaJobKind,
        dedupe_key: &str,
        owner_label: &str,
    ) -> MediaJobRecord {
        const PROJECT_ID: &str = "10000000-0000-4000-8000-000000000001";
        let store = MediaJobStore::initialize(local_data_dir)
            .await
            .expect("retry fixture store must initialize");
        let created_at_ms = current_timestamp_millis().saturating_sub(10);
        let job = store
            .enqueue(NewMediaJob {
                kind,
                parent_id: None,
                dedupe_key: dedupe_key.to_owned(),
                project_id: (kind != MediaJobKind::FinalRender).then(|| PROJECT_ID.to_owned()),
                asset_id: None,
                revision_id: (kind == MediaJobKind::FinalRender)
                    .then(|| "retry-revision".to_owned()),
                priority: if kind == MediaJobKind::FinalRender {
                    MediaJobPriority::Export
                } else {
                    MediaJobPriority::Interactive
                },
                priority_value: 0,
                stage: "queued".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 1,
                    unit: MediaJobProgressUnit::Items,
                },
                max_attempts: 3,
                summary: format!("Retry {dedupe_key}"),
                private_payload: if kind == MediaJobKind::FinalRender {
                    serde_json::json!({
                        "ownerLabel": owner_label,
                        "plan": { "schemaVersion": 1 },
                        "overwrite": false,
                        "outputAuthorizationPresent": true,
                    })
                } else {
                    serde_json::json!({
                        "canonicalObjectAvailable": true,
                        "ownerLabel": owner_label,
                        "projectId": PROJECT_ID,
                        "plan": {},
                    })
                },
                created_at_ms,
            })
            .await
            .expect("retry fixture must enqueue")
            .job;
        store
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
                    message: Some("Retry fixture started.".to_owned()),
                    occurred_at_ms: created_at_ms.saturating_add(1),
                },
            )
            .await
            .expect("retry fixture must start");
        store
            .transition(
                job.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Failed,
                    stage: "failed".to_owned(),
                    progress: job.progress.clone(),
                    attempt: Some(1),
                    error: Some(MediaJobError {
                        code: "process_failed".to_owned(),
                        category: MediaJobErrorCategory::ProcessFailed,
                        message: "The media process failed.".to_owned(),
                        retryable: true,
                        action: Some(MediaJobRecoveryAction::Retry),
                    }),
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("The media process failed.".to_owned()),
                    occurred_at_ms: created_at_ms.saturating_add(2),
                },
            )
            .await
            .expect("retry fixture must fail");
        job
    }

    #[tokio::test(flavor = "current_thread")]
    async fn parent_cancellation_signals_running_child_cancels_queue_and_waits_for_cleanup() {
        const OWNER: &str = "hierarchical-cancellation-owner";
        let workspace = tempfile::tempdir().expect("cancellation workspace must be created");
        let jobs = MediaJobService::initialize(
            workspace.path().join("local-data"),
            workspace.path().join("app-cache"),
        )
        .await
        .expect("media job service must initialize");
        let parent = enqueue_job(
            &jobs,
            MediaJobKind::AssetPreparation,
            None,
            "cancel-parent",
            OWNER,
        )
        .await;
        jobs.store()
            .transition(
                parent.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Running,
                    stage: "derived_media".to_owned(),
                    progress: parent.progress.clone(),
                    attempt: Some(1),
                    error: None,
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("Preparing preview media.".to_owned()),
                    occurred_at_ms: current_timestamp_millis(),
                },
            )
            .await
            .expect("preparation parent must enter running state");

        let running_child = enqueue_job(
            &jobs,
            MediaJobKind::Proxy,
            Some(parent.id.clone()),
            "cancel-running-child",
            OWNER,
        )
        .await;
        let partial_path = workspace.path().join("running-child.part.mp4");
        let started = Arc::new(AtomicBool::new(false));
        let cancellation_signalled = Arc::new(AtomicBool::new(false));
        let cleanup_count = Arc::new(AtomicUsize::new(0));
        jobs.scheduler()
            .submit(
                running_child.id.clone(),
                running_child.priority,
                running_child.attempt,
                running_child.max_attempts,
                SchedulerResource::Ffmpeg,
                Arc::new(CancellableFfmpegWorker {
                    partial_path: partial_path.clone(),
                    started: started.clone(),
                    cancellation_signalled: cancellation_signalled.clone(),
                    cleanup_count: cleanup_count.clone(),
                }),
            )
            .await
            .expect("running child must submit");
        tokio::time::timeout(Duration::from_secs(1), async {
            while !started.load(Ordering::Acquire) {
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .expect("FFmpeg worker must start");

        let queued_child = enqueue_job(
            &jobs,
            MediaJobKind::ThumbnailTile,
            Some(parent.id.clone()),
            "cancel-queued-child",
            OWNER,
        )
        .await;
        let queued_calls = Arc::new(AtomicUsize::new(0));
        jobs.scheduler()
            .submit(
                queued_child.id.clone(),
                queued_child.priority,
                queued_child.attempt,
                queued_child.max_attempts,
                SchedulerResource::Ffmpeg,
                Arc::new(QueuedWorker {
                    calls: queued_calls.clone(),
                }),
            )
            .await
            .expect("queued child must submit");

        assert!(
            cancel_media_job_for_owner(&jobs, "another-owner", parent.id.clone())
                .await
                .is_err(),
            "another owner must not cancel the hierarchy"
        );
        assert!(!cancellation_signalled.load(Ordering::Acquire));
        assert_eq!(
            jobs.store()
                .get_private(queued_child.id.clone())
                .await
                .expect("queued child must load")
                .public
                .state,
            MediaJobState::Queued
        );

        let returned_parent = cancel_media_job_for_owner(&jobs, OWNER, parent.id.clone())
            .await
            .expect("Job Center cancellation must return the parent");
        assert_eq!(returned_parent.id, parent.id);
        assert_eq!(returned_parent.state, MediaJobState::Cancelled);
        assert!(cancellation_signalled.load(Ordering::Acquire));
        assert_eq!(cleanup_count.load(Ordering::Acquire), 1);
        assert_eq!(queued_calls.load(Ordering::Acquire), 0);
        assert!(
            !partial_path.exists(),
            "parent cancellation must await partial cleanup"
        );

        for job_id in [&running_child.id, &queued_child.id, &parent.id] {
            let settled = jobs
                .store()
                .get_private(job_id.to_string())
                .await
                .expect("cancelled hierarchy member must load")
                .public;
            assert_eq!(settled.state, MediaJobState::Cancelled);
            assert!(settled.cancellation_requested);
            assert_eq!(cancelled_event_count(&jobs, job_id).await, 1);
        }

        let repeated = cancel_media_job_for_owner(&jobs, OWNER, parent.id.clone())
            .await
            .expect("terminal parent cancellation must be idempotent");
        assert_eq!(repeated.state, MediaJobState::Cancelled);
        for job_id in [&running_child.id, &queued_child.id, &parent.id] {
            assert_eq!(cancelled_event_count(&jobs, job_id).await, 1);
        }

        jobs.shutdown()
            .await
            .expect("media job service must shut down cleanly");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_proxy_retry_reconstructs_work_after_service_reopen_and_rejects_duplicates() {
        const OWNER: &str = "durable-proxy-owner";
        let workspace = tempfile::tempdir().expect("durable retry workspace must be created");
        let local_data_dir = workspace.path().join("local-data");
        let failed = persist_failed_retry_job(
            local_data_dir.clone(),
            MediaJobKind::Proxy,
            "durable-failed-proxy",
            OWNER,
        )
        .await;

        let jobs = MediaJobService::initialize(local_data_dir, workspace.path().join("app-cache"))
            .await
            .expect("media job service must reopen the failed proxy");
        assert!(matches!(
            jobs.retry_job_with_factory(&failed.id, "another-owner", |_| {
                Ok(Arc::new(QueuedWorker {
                    calls: Arc::new(AtomicUsize::new(0)),
                }))
            })
            .await,
            Err(MediaStateStoreError::NotFound)
        ));

        let calls = Arc::new(AtomicUsize::new(0));
        let retried = jobs
            .retry_job_with_factory(&failed.id, OWNER, |_| {
                Ok(Arc::new(QueuedWorker {
                    calls: calls.clone(),
                }))
            })
            .await
            .expect("reopened proxy must reconstruct executable work");
        assert_eq!(retried.state, MediaJobState::Queued);
        assert!(jobs
            .retry_job_with_factory(&failed.id, OWNER, |_| {
                Ok(Arc::new(QueuedWorker {
                    calls: calls.clone(),
                }))
            })
            .await
            .is_err());

        jobs.scheduler().wait_idle().await;
        let completed = jobs
            .store()
            .get_private(failed.id.clone())
            .await
            .expect("retried proxy must remain durable")
            .public;
        assert_eq!(completed.state, MediaJobState::Complete);
        assert_eq!(calls.load(Ordering::Acquire), 1);
        assert!(jobs
            .retry_job_with_factory(&failed.id, OWNER, |_| {
                Ok(Arc::new(QueuedWorker {
                    calls: calls.clone(),
                }))
            })
            .await
            .is_err());
        jobs.shutdown()
            .await
            .expect("reopened proxy service must shut down");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_final_render_retry_requires_fresh_output_authorization_and_stays_immutable_when_complete(
    ) {
        const OWNER: &str = "durable-render-owner";
        let workspace = tempfile::tempdir().expect("durable render retry workspace must exist");
        let local_data_dir = workspace.path().join("local-data");
        let failed = persist_failed_retry_job(
            local_data_dir.clone(),
            MediaJobKind::FinalRender,
            "durable-failed-render",
            OWNER,
        )
        .await;
        let jobs = MediaJobService::initialize(local_data_dir, workspace.path().join("app-cache"))
            .await
            .expect("media job service must reopen the failed render");

        let blocked = jobs
            .retry_job_with_factory(&failed.id, OWNER, |_| {
                panic!("final render retry must not construct a stale worker")
            })
            .await
            .expect("failed render retry must return output reauthorization");
        assert_eq!(blocked.state, MediaJobState::Blocked);
        let blocked_error = blocked
            .error
            .as_ref()
            .expect("blocked render needs an error");
        assert_eq!(
            blocked_error.category,
            MediaJobErrorCategory::OutputAuthorizationRequired
        );
        assert_eq!(
            blocked_error.action,
            Some(MediaJobRecoveryAction::ReauthorizeOutput)
        );
        let repeated = jobs
            .retry_job_with_factory(&failed.id, OWNER, |_| {
                panic!("blocked final render must not construct a stale worker")
            })
            .await
            .expect("repeated render retry must remain deterministically actionable");
        assert_eq!(repeated, blocked);

        let now = current_timestamp_millis();
        jobs.store()
            .transition(
                failed.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Queued,
                    stage: "queued".to_owned(),
                    progress: failed.progress.clone(),
                    attempt: None,
                    error: None,
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("Final render reauthorized.".to_owned()),
                    occurred_at_ms: now,
                },
            )
            .await
            .expect("fresh authorization must reactivate the render");
        jobs.store()
            .transition(
                failed.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Running,
                    stage: "running".to_owned(),
                    progress: failed.progress.clone(),
                    attempt: Some(2),
                    error: None,
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("Final render restarted.".to_owned()),
                    occurred_at_ms: now,
                },
            )
            .await
            .expect("reauthorized render must start");
        jobs.store()
            .transition(
                failed.id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Complete,
                    stage: "complete".to_owned(),
                    progress: MediaJobProgress {
                        completed: 1,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                    attempt: None,
                    error: None,
                    retry_at_ms: None,
                    result: Some(serde_json::json!({ "outputPath": "complete.mp4" })),
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("Final render complete.".to_owned()),
                    occurred_at_ms: now,
                },
            )
            .await
            .expect("reauthorized render must complete");
        assert!(jobs
            .retry_job_with_factory(&failed.id, OWNER, |_| {
                panic!("completed final render must remain immutable")
            })
            .await
            .is_err());
        assert_eq!(
            jobs.store()
                .get_private(failed.id)
                .await
                .expect("completed render must remain durable")
                .public
                .state,
            MediaJobState::Complete
        );
        jobs.shutdown()
            .await
            .expect("reopened render service must shut down");
    }
}
