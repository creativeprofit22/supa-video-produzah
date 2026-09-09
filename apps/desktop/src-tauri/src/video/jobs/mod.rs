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
#[cfg(test)]
use model::MediaJobProgress;
use model::{
    MediaJobErrorCategory, MediaJobEventType, MediaJobKind, MediaJobRecord, MediaJobRecoveryAction,
    MediaJobRecoveryReport, MediaJobState,
};
use scheduler::{
    default_blocked_error, MediaJobScheduler, MediaJobWorker, MediaSchedulerConfig,
    SchedulerResource, SystemSchedulerClock,
};
use store::{MediaJobStore, MediaJobTransition, MediaStateStoreError, StoredPrivateJob};
use uuid::Uuid;

pub struct MediaJobService {
    store: MediaJobStore,
    scheduler: Arc<MediaJobScheduler>,
    scheduler_task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
    cache: MediaCacheService,
    recovery: Mutex<MediaJobRecoveryReport>,
    retry_gate: tokio::sync::Mutex<()>,
    acknowledgement_timeout: std::time::Duration,
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
            .cleanup_stale_builds(std::time::Duration::from_secs(60))
            .await?;
        drop(cache_io_permit);
        let scheduler_task = scheduler.start();
        Ok(Self {
            store,
            scheduler,
            scheduler_task: tokio::sync::Mutex::new(Some(scheduler_task)),
            cache,
            recovery: Mutex::new(recovery),
            retry_gate: tokio::sync::Mutex::new(()),
            acknowledgement_timeout: std::time::Duration::from_secs(5),
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
        self.cancel_job_until(job_id, owner_label, None).await
    }

    async fn cancel_job_until(
        &self,
        job_id: &str,
        owner_label: &str,
        deadline: Option<tokio::time::Instant>,
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
        let deadline =
            deadline.unwrap_or_else(|| tokio::time::Instant::now() + self.acknowledgement_timeout);
        let requested_at = current_timestamp_millis();
        self.store
            .request_cancellations(
                std::iter::once(job_id.to_owned())
                    .chain(descendants.iter().map(|job| job.id.clone()))
                    .collect(),
                requested_at,
            )
            .await?;

        for id in std::iter::once(job_id).chain(descendants.iter().map(|job| job.id.as_str())) {
            self.scheduler.signal_cancellation(id).await;
        }
        for descendant in descendants.iter().rev() {
            self.scheduler
                .reconcile_cancellation(&descendant.id)
                .await?;
        }
        self.scheduler.reconcile_cancellation(job_id).await?;
        self.wait_for_settlement(job_id, deadline).await?;

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

    async fn wait_for_settlement(
        &self,
        job_id: &str,
        deadline: tokio::time::Instant,
    ) -> Result<(), MediaStateStoreError> {
        loop {
            let current = self.store.get_private(job_id.to_owned()).await?.public;
            if current.state.is_terminal() && !self.scheduler.is_running(job_id).await {
                return Ok(());
            }
            if tokio::time::Instant::now() >= deadline {
                return Err(MediaStateStoreError::CancellationPending);
            }
            tokio::time::sleep_until(
                deadline.min(tokio::time::Instant::now() + std::time::Duration::from_millis(10)),
            )
            .await;
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
        let deadline = tokio::time::Instant::now() + self.acknowledgement_timeout;
        let mut first_error = None;
        for job in jobs.iter().filter(|job| {
            owned_ids.contains(&job.id)
                && job
                    .parent_id
                    .as_ref()
                    .is_none_or(|parent_id| !owned_ids.contains(parent_id))
        }) {
            if let Err(error) = self
                .cancel_job_until(&job.id, owner_label, Some(deadline))
                .await
            {
                first_error.get_or_insert(error);
            }
        }
        if let Some(error) = first_error {
            return Err(error);
        }
        self.cache.release_owner(owner_label.to_owned()).await?;
        Ok(())
    }

    pub(crate) async fn shutdown(&self) -> Result<(), MediaStateStoreError> {
        let deadline = tokio::time::Instant::now() + self.acknowledgement_timeout;
        self.scheduler.shutdown().await;
        let mut task = tokio::time::timeout_at(deadline, self.scheduler_task.lock())
            .await
            .map_err(|_| MediaStateStoreError::CancellationPending)?;
        if let Some(handle) = task.as_mut() {
            // Borrow the handle: expiry must not detach or abort live cleanup.
            let result = tokio::time::timeout_at(deadline, handle)
                .await
                .map_err(|_| MediaStateStoreError::CancellationPending)?;
            task.take();
            result.map_err(|_| MediaStateStoreError::WorkerStopped)?;
        }
        tokio::time::timeout_at(deadline, self.scheduler.wait_idle())
            .await
            .map_err(|_| MediaStateStoreError::CancellationPending)?;
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

    struct GatedCancellationWorker {
        partial: PathBuf,
        started: Arc<tokio::sync::Notify>,
        signalled: Arc<tokio::sync::Notify>,
        release: Arc<tokio::sync::Notify>,
        cleaned: Arc<AtomicUsize>,
    }

    impl MediaJobWorker for GatedCancellationWorker {
        fn run(&self, _id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
            let partial = self.partial.clone();
            let started = self.started.clone();
            let signalled = self.signalled.clone();
            let release = self.release.clone();
            let cleaned = self.cleaned.clone();
            Box::pin(async move {
                fs::write(&partial, b"owned partial").unwrap();
                started.notify_one();
                while !cancellation.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
                signalled.notify_one();
                release.notified().await;
                fs::remove_file(partial).unwrap();
                cleaned.fetch_add(1, Ordering::SeqCst);
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

    #[tokio::test]
    async fn nonsettling_worker_bounds_acknowledgement_without_terminal_cancellation() {
        let root = tempfile::tempdir().unwrap();
        let mut jobs =
            MediaJobService::initialize(root.path().join("data"), root.path().join("cache"))
                .await
                .unwrap();
        jobs.acknowledgement_timeout = Duration::from_millis(40);
        let job = enqueue_job(&jobs, MediaJobKind::Proxy, None, "gated", "owner").await;
        let started = Arc::new(tokio::sync::Notify::new());
        let signalled = Arc::new(tokio::sync::Notify::new());
        let release = Arc::new(tokio::sync::Notify::new());
        let cleaned = Arc::new(AtomicUsize::new(0));
        let partial = root.path().join("owned.part");
        jobs.scheduler
            .submit(
                job.id.clone(),
                job.priority,
                job.attempt,
                job.max_attempts,
                SchedulerResource::Ffmpeg,
                Arc::new(GatedCancellationWorker {
                    partial: partial.clone(),
                    started: started.clone(),
                    signalled: signalled.clone(),
                    release: release.clone(),
                    cleaned: cleaned.clone(),
                }),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), started.notified())
            .await
            .unwrap();
        let result = tokio::time::timeout(
            Duration::from_millis(500),
            jobs.cancel_job(&job.id, "owner"),
        )
        .await;
        let state = jobs.store.get_private(job.id.clone()).await.unwrap().public;
        let events_before = cancelled_event_count(&jobs, &job.id).await;
        let partial_before = partial.exists();
        let cleaned_before = cleaned.load(Ordering::SeqCst);
        // Always release the real worker before assertions, including on the red path.
        release.notify_one();
        tokio::time::timeout(Duration::from_secs(2), jobs.scheduler.wait_idle())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), jobs.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(
            result.is_ok(),
            "cancellation acknowledgement exceeded its deadline"
        );
        assert!(result.unwrap().is_err(), "pending cleanup must be reported");
        assert!(state.cancellation_requested);
        assert!(!state.state.is_terminal());
        assert_eq!(events_before, 0);
        assert!(partial_before);
        assert_eq!(cleaned_before, 0);
        assert_eq!(cleaned.load(Ordering::SeqCst), 1);
        assert_eq!(cancelled_event_count(&jobs, &job.id).await, 1);
    }

    #[tokio::test]
    async fn timed_out_family_reconciles_after_cleanup_without_second_action() {
        for running_root in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let mut jobs =
                MediaJobService::initialize(root.path().join("data"), root.path().join("cache"))
                    .await
                    .unwrap();
            jobs.acknowledgement_timeout = Duration::from_millis(40);
            let parent = enqueue_job(
                &jobs,
                MediaJobKind::AssetPreparation,
                None,
                "family",
                "owner",
            )
            .await;
            let child_a = enqueue_job(
                &jobs,
                MediaJobKind::Proxy,
                Some(parent.id.clone()),
                "a",
                "owner",
            )
            .await;
            let child_b = enqueue_job(
                &jobs,
                MediaJobKind::ThumbnailTile,
                Some(parent.id.clone()),
                "b",
                "owner",
            )
            .await;
            let mut workers = Vec::new();
            for job in [&child_a, &child_b]
                .into_iter()
                .chain(running_root.then_some(&parent))
            {
                let worker = Arc::new(GatedCancellationWorker {
                    partial: root.path().join(format!("{}.part", job.id)),
                    started: Arc::new(tokio::sync::Notify::new()),
                    signalled: Arc::new(tokio::sync::Notify::new()),
                    release: Arc::new(tokio::sync::Notify::new()),
                    cleaned: Arc::new(AtomicUsize::new(0)),
                });
                let resource = if job.id == parent.id {
                    SchedulerResource::Ffmpeg
                } else {
                    SchedulerResource::BlockingIo
                };
                jobs.scheduler
                    .submit(
                        job.id.clone(),
                        job.priority,
                        job.attempt,
                        job.max_attempts,
                        resource,
                        worker.clone(),
                    )
                    .await
                    .unwrap();
                tokio::time::timeout(Duration::from_secs(2), worker.started.notified())
                    .await
                    .unwrap();
                workers.push(worker);
            }
            let first = tokio::time::timeout(
                Duration::from_millis(500),
                jobs.cancel_job(&parent.id, "owner"),
            )
            .await;
            let second = tokio::time::timeout(
                Duration::from_millis(500),
                jobs.cancel_job(&parent.id, "owner"),
            )
            .await;
            let mut before = Vec::new();
            for job in [&parent, &child_a, &child_b] {
                before.push((
                    jobs.store.get_private(job.id.clone()).await.unwrap().public,
                    cancelled_event_count(&jobs, &job.id).await,
                ));
            }
            let all_owned = workers.iter().all(|worker| {
                worker.partial.exists() && worker.cleaned.load(Ordering::SeqCst) == 0
            });
            let all_signalled = futures_signalled(&workers).await;

            // Release the running root first: children must still prevent parent settlement.
            let root_settled = if running_root {
                workers.last().unwrap().release.notify_one();
                tokio::time::timeout(Duration::from_secs(2), async {
                    while jobs.scheduler.is_running(&parent.id).await {
                        tokio::task::yield_now().await;
                    }
                })
                .await
                .is_ok()
            } else {
                true
            };
            let parent_before_children = jobs
                .store
                .get_private(parent.id.clone())
                .await
                .unwrap()
                .public;
            for worker in &workers {
                worker.release.notify_one();
            }
            if !all_signalled {
                jobs.scheduler.shutdown().await;
            }
            let idle =
                tokio::time::timeout(Duration::from_secs(2), jobs.scheduler.wait_idle()).await;

            idle.unwrap();
            assert!(matches!(
                first,
                Ok(Err(MediaStateStoreError::CancellationPending))
            ));
            assert!(matches!(
                second,
                Ok(Err(MediaStateStoreError::CancellationPending))
            ));
            assert!(
                root_settled,
                "released running root failed to acknowledge cleanup"
            );
            assert!(all_owned && all_signalled);
            assert!(!parent_before_children.state.is_terminal());
            for (state, count) in before {
                assert!(state.cancellation_requested && !state.state.is_terminal());
                assert_eq!(count, 0);
            }
            for job in [&parent, &child_a, &child_b] {
                assert_eq!(
                    jobs.store
                        .get_private(job.id.clone())
                        .await
                        .unwrap()
                        .public
                        .state,
                    MediaJobState::Cancelled
                );
                assert_eq!(cancelled_event_count(&jobs, &job.id).await, 1);
            }
            assert!(workers.iter().all(
                |worker| !worker.partial.exists() && worker.cleaned.load(Ordering::SeqCst) == 1
            ));
            jobs.shutdown().await.unwrap();
        }
    }

    #[tokio::test]
    async fn owner_and_shutdown_timeouts_retain_leases_and_join_handle_for_retry() {
        use crate::video::{
            cache::{CacheArtifactKind, CacheArtifactRegistration},
            media_store::MEDIA_STORE_NAMESPACE,
        };
        let root = tempfile::tempdir().unwrap();
        let mut jobs =
            MediaJobService::initialize(root.path().join("data"), root.path().join("cache"))
                .await
                .unwrap();
        jobs.acknowledgement_timeout = Duration::from_millis(40);
        let key = "a".repeat(64);
        let path = root
            .path()
            .join("cache")
            .join(MEDIA_STORE_NAMESPACE)
            .join("derived/proxy/aa")
            .join(format!("{key}.mp4"));
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"leased input").unwrap();
        jobs.cache
            .register_and_lease(
                CacheArtifactRegistration {
                    key: key.clone(),
                    content_digest: key,
                    kind: CacheArtifactKind::Proxy,
                    path,
                    profile_id: None,
                    toolchain_id: None,
                    recipe_id: None,
                },
                "owner".to_owned(),
                None,
            )
            .await
            .unwrap();
        let leases_before = crate::video::cache::tests::lease_snapshot(&jobs.cache);
        assert_eq!(leases_before.len(), 1);
        let mut workers = Vec::new();
        for index in 0..2 {
            let job = enqueue_job(
                &jobs,
                MediaJobKind::Proxy,
                None,
                &format!("owned-{index}"),
                "owner",
            )
            .await;
            let worker = Arc::new(GatedCancellationWorker {
                partial: root.path().join(format!("owned-{index}.part")),
                started: Arc::new(tokio::sync::Notify::new()),
                signalled: Arc::new(tokio::sync::Notify::new()),
                release: Arc::new(tokio::sync::Notify::new()),
                cleaned: Arc::new(AtomicUsize::new(0)),
            });
            jobs.scheduler
                .submit(
                    job.id.clone(),
                    job.priority,
                    job.attempt,
                    job.max_attempts,
                    SchedulerResource::BlockingIo,
                    worker.clone(),
                )
                .await
                .unwrap();
            tokio::time::timeout(Duration::from_secs(2), worker.started.notified())
                .await
                .unwrap();
            workers.push(worker);
        }
        let owner_result =
            tokio::time::timeout(Duration::from_millis(500), jobs.cancel_owner("owner")).await;
        let all_signalled = futures_signalled(&workers).await;
        let shutdown_result =
            tokio::time::timeout(Duration::from_millis(500), jobs.shutdown()).await;
        let handle_retained = jobs.scheduler_task.lock().await.is_some();
        let still_owned = workers
            .iter()
            .all(|worker| worker.partial.exists() && worker.cleaned.load(Ordering::SeqCst) == 0);
        let leases_after = crate::video::cache::tests::lease_snapshot(&jobs.cache);
        for worker in &workers {
            worker.release.notify_one();
        }
        jobs.acknowledgement_timeout = Duration::from_secs(2);
        tokio::time::timeout(Duration::from_secs(3), jobs.shutdown())
            .await
            .unwrap()
            .unwrap();
        assert!(matches!(
            owner_result,
            Ok(Err(MediaStateStoreError::CancellationPending))
        ));
        assert!(matches!(
            shutdown_result,
            Ok(Err(MediaStateStoreError::CancellationPending))
        ));
        assert!(handle_retained && still_owned && all_signalled);
        assert_eq!(leases_before, leases_after);
        assert!(jobs.scheduler_task.lock().await.is_none());
        assert!(crate::video::cache::tests::lease_snapshot(&jobs.cache).is_empty());
        assert!(workers
            .iter()
            .all(|worker| !worker.partial.exists() && worker.cleaned.load(Ordering::SeqCst) == 1));
        jobs.cancel_owner("owner").await.unwrap();
    }

    async fn futures_signalled(workers: &[Arc<GatedCancellationWorker>]) -> bool {
        for worker in workers {
            if tokio::time::timeout(Duration::from_millis(100), worker.signalled.notified())
                .await
                .is_err()
            {
                return false;
            }
        }
        true
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
