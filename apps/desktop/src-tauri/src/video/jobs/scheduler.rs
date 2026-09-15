use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;
use tokio::sync::{Mutex, Notify, OwnedSemaphorePermit, Semaphore};

use crate::video::process::ProcessCancellation;

use super::{
    model::{
        automatic_retry_delay, MediaJobError, MediaJobEventType, MediaJobPriority,
        MediaJobProgress, MediaJobRecoveryAction, MediaJobState, RetryClassification,
    },
    store::{MediaJobStore, MediaJobTransition, MediaStateStoreError},
};

const DEFAULT_AGING_INTERVAL: Duration = Duration::from_secs(60);

pub(crate) type MediaWorkerFuture =
    Pin<Box<dyn Future<Output = MediaWorkerOutcome> + Send + 'static>>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum MediaJobFinalOutcome {
    Complete,
    Cancelled,
    Failed,
}

pub(crate) trait MediaJobWorker: Send + Sync + 'static {
    fn run(&self, job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture;

    fn on_terminal(&self, _outcome: MediaJobFinalOutcome) {}
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SchedulerResource {
    Ffmpeg,
    BlockingIo,
}

#[derive(Clone, Debug)]
pub(crate) enum MediaWorkerOutcome {
    Complete {
        result: Value,
        progress: MediaJobProgress,
    },
    Cancelled {
        progress: MediaJobProgress,
    },
    Failed {
        error: MediaJobError,
        progress: MediaJobProgress,
    },
}

pub(crate) trait SchedulerClock: Send + Sync + 'static {
    fn now_millis(&self) -> i64;
    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>>;
}

#[derive(Debug, Default)]
pub(crate) struct SystemSchedulerClock;

impl SchedulerClock for SystemSchedulerClock {
    fn now_millis(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .ok()
            .and_then(|duration| i64::try_from(duration.as_millis()).ok())
            .unwrap_or(0)
    }

    fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
        Box::pin(tokio::time::sleep(duration))
    }
}

#[derive(Clone, Copy, Debug)]
pub(crate) struct MediaSchedulerConfig {
    pub(crate) ffmpeg_permits: usize,
    pub(crate) blocking_io_permits: usize,
    pub(crate) aging_interval: Duration,
}

impl Default for MediaSchedulerConfig {
    fn default() -> Self {
        Self {
            ffmpeg_permits: 1,
            blocking_io_permits: 2,
            aging_interval: DEFAULT_AGING_INTERVAL,
        }
    }
}

#[derive(Clone)]
struct QueuedWork {
    job_id: String,
    priority: MediaJobPriority,
    enqueued_at_ms: i64,
    sequence: u64,
    attempt: u8,
    max_attempts: u8,
    resource: SchedulerResource,
    worker: Arc<dyn MediaJobWorker>,
}

#[derive(Clone)]
struct RunningWork {
    cancellation: ProcessCancellation,
    user_cancellation_requested: Arc<AtomicBool>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum SchedulerCancellation {
    Queued,
    Running,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartWorkDisposition {
    Started,
    Requeue,
    Discard,
}

pub(crate) struct MediaJobScheduler {
    store: MediaJobStore,
    clock: Arc<dyn SchedulerClock>,
    config: MediaSchedulerConfig,
    queue: Mutex<Vec<QueuedWork>>,
    running: Mutex<HashMap<String, RunningWork>>,
    ffmpeg_permits: Arc<Semaphore>,
    blocking_io_permits: Arc<Semaphore>,
    // Shared by dispatch and idle observers: state changes must wake every waiter.
    notify: Notify,
    sequence: AtomicU64,
    active_count: AtomicUsize,
    shutting_down: AtomicBool,
    #[cfg(test)]
    wait_barriers: std::sync::Mutex<Option<(Arc<tokio::sync::Barrier>, Arc<tokio::sync::Barrier>)>>,
}

impl MediaJobScheduler {
    pub(crate) fn new(
        store: MediaJobStore,
        config: MediaSchedulerConfig,
        clock: Arc<dyn SchedulerClock>,
    ) -> Result<Arc<Self>, MediaStateStoreError> {
        if config.ffmpeg_permits == 0
            || config.blocking_io_permits == 0
            || config.aging_interval.is_zero()
        {
            return Err(MediaStateStoreError::InvalidTransition);
        }
        Ok(Arc::new(Self {
            store,
            clock,
            config,
            queue: Mutex::new(Vec::new()),
            running: Mutex::new(HashMap::new()),
            ffmpeg_permits: Arc::new(Semaphore::new(config.ffmpeg_permits)),
            blocking_io_permits: Arc::new(Semaphore::new(config.blocking_io_permits)),
            notify: Notify::new(),
            sequence: AtomicU64::new(0),
            active_count: AtomicUsize::new(0),
            shutting_down: AtomicBool::new(false),
            #[cfg(test)]
            wait_barriers: std::sync::Mutex::new(None),
        }))
    }

    pub(crate) fn start(self: &Arc<Self>) -> tokio::task::JoinHandle<()> {
        let scheduler = self.clone();
        tokio::spawn(async move { scheduler.run_loop().await })
    }

    pub(crate) async fn acquire_resource_permit(
        &self,
        resource: SchedulerResource,
    ) -> Result<OwnedSemaphorePermit, MediaStateStoreError> {
        let semaphore = match resource {
            SchedulerResource::Ffmpeg => self.ffmpeg_permits.clone(),
            SchedulerResource::BlockingIo => self.blocking_io_permits.clone(),
        };
        semaphore
            .acquire_owned()
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)
    }

    pub(crate) async fn submit(
        &self,
        job_id: String,
        priority: MediaJobPriority,
        attempt: u8,
        max_attempts: u8,
        resource: SchedulerResource,
        worker: Arc<dyn MediaJobWorker>,
    ) -> Result<(), MediaStateStoreError> {
        if self.shutting_down.load(Ordering::Acquire) || attempt > max_attempts || max_attempts == 0
        {
            return Err(MediaStateStoreError::InvalidTransition);
        }
        let mut queue = self.queue.lock().await;
        let running = self.running.lock().await;
        if queue.iter().any(|queued| queued.job_id == job_id) || running.contains_key(&job_id) {
            return Ok(());
        }
        let queued = QueuedWork {
            job_id,
            priority,
            enqueued_at_ms: self.clock.now_millis(),
            sequence: self.sequence.fetch_add(1, Ordering::AcqRel),
            attempt,
            max_attempts,
            resource,
            worker,
        };
        queue.push(queued);
        drop(running);
        drop(queue);
        self.notify.notify_waiters();
        Ok(())
    }

    pub(crate) async fn reconcile_cancellation(
        &self,
        job_id: &str,
    ) -> Result<(), MediaStateStoreError> {
        let queue = self.queue.lock().await;
        let running = self.running.lock().await;
        // Neither a live worker nor its ancestors can settle yet. Avoid a write
        // transaction that would hold scheduler locks without changing anything.
        if running.contains_key(job_id) || queue.iter().any(|work| work.job_id == job_id) {
            return Ok(());
        }
        let owned_ids = running
            .keys()
            .cloned()
            .chain(queue.iter().map(|work| work.job_id.clone()))
            .collect();
        self.store
            .reconcile_cancellation(job_id.to_owned(), owned_ids, self.clock.now_millis())
            .await
    }

    pub(crate) async fn is_running(&self, job_id: &str) -> bool {
        self.running.lock().await.contains_key(job_id)
    }

    pub(crate) async fn signal_cancellation(&self, job_id: &str) -> Option<SchedulerCancellation> {
        let (queued, running_work) = {
            let mut queue = self.queue.lock().await;
            let running = self.running.lock().await;
            let queued = queue
                .iter()
                .position(|entry| entry.job_id == job_id)
                .map(|index| queue.remove(index));
            let running_work = running.get(job_id).cloned();
            if let Some(work) = &queued {
                work.worker.on_terminal(MediaJobFinalOutcome::Cancelled);
            }
            (queued.is_some(), running_work)
        };
        if queued {
            return Some(SchedulerCancellation::Queued);
        }
        running_work.map(|running_work| {
            running_work
                .user_cancellation_requested
                .store(true, Ordering::Release);
            running_work.cancellation.cancel();
            SchedulerCancellation::Running
        })
    }

    pub(crate) async fn cancel(&self, job_id: &str) -> Result<(), MediaStateStoreError> {
        let now = self.clock.now_millis();
        let mut queue = self.queue.lock().await;
        let running = self.running.lock().await;
        if let Some(index) = queue.iter().position(|entry| entry.job_id == job_id) {
            let entry = queue.remove(index);
            self.store
                .request_cancellation(job_id.to_owned(), now)
                .await?;
            entry.worker.on_terminal(MediaJobFinalOutcome::Cancelled);
            drop(running);
            drop(queue);
            return self.reconcile_cancellation(job_id).await;
        }

        if let Some(running_work) = running.get(job_id).cloned() {
            self.store
                .request_cancellation(job_id.to_owned(), now)
                .await?;
            running_work
                .user_cancellation_requested
                .store(true, Ordering::Release);
            running_work.cancellation.cancel();
            return Ok(());
        }
        Err(MediaStateStoreError::NotFound)
    }

    pub(crate) async fn retry_with_worker(
        &self,
        job_id: &str,
        resource: SchedulerResource,
        worker: Arc<dyn MediaJobWorker>,
    ) -> Result<super::model::MediaJobRecord, MediaStateStoreError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(MediaStateStoreError::InvalidTransition);
        }
        let mut queue = self.queue.lock().await;
        let running = self.running.lock().await;
        if queue.iter().any(|queued| queued.job_id == job_id) || running.contains_key(job_id) {
            return Err(MediaStateStoreError::InvalidTransition);
        }
        let stored = self.store.get_private(job_id.to_owned()).await?;
        if !matches!(
            stored.public.state,
            MediaJobState::Failed | MediaJobState::Blocked
        ) {
            return Err(MediaStateStoreError::InvalidTransition);
        }
        let now = self.clock.now_millis();
        let retried = self
            .store
            .transition(
                job_id.to_owned(),
                MediaJobTransition {
                    state: MediaJobState::Queued,
                    stage: "queued".to_owned(),
                    progress: MediaJobProgress {
                        completed: 0,
                        total: stored.public.progress.total,
                        unit: stored.public.progress.unit,
                    },
                    attempt: Some(0),
                    error: None,
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("Media job queued for retry.".to_owned()),
                    occurred_at_ms: now,
                },
            )
            .await?;
        queue.push(QueuedWork {
            job_id: job_id.to_owned(),
            priority: stored.public.priority,
            enqueued_at_ms: now,
            sequence: self.sequence.fetch_add(1, Ordering::AcqRel),
            attempt: 0,
            max_attempts: stored.public.max_attempts,
            resource,
            worker,
        });
        drop(running);
        drop(queue);
        self.notify.notify_waiters();
        Ok(retried)
    }

    pub(crate) async fn shutdown(&self) {
        self.shutting_down.store(true, Ordering::Release);
        let mut queue = self.queue.lock().await;
        let running = self.running.lock().await;
        queue.clear();
        for work in running.values() {
            work.cancellation.cancel();
        }
        drop(running);
        drop(queue);
        self.notify.notify_waiters();
    }

    pub(crate) async fn wait_idle(&self) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.queue.lock().await.is_empty() && self.active_count.load(Ordering::Acquire) == 0
            {
                return;
            }
            notified.await;
        }
    }

    async fn run_loop(self: Arc<Self>) {
        loop {
            let notified = self.notify.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if self.shutting_down.load(Ordering::Acquire)
                && self.active_count.load(Ordering::Acquire) == 0
            {
                return;
            }
            if let Some((work, permit, running_work)) = self.take_dispatchable().await {
                let scheduler = self.clone();
                tokio::spawn(async move {
                    scheduler.execute(work, permit, running_work).await;
                    scheduler.active_count.fetch_sub(1, Ordering::AcqRel);
                    scheduler.notify.notify_waiters();
                });
                continue;
            }
            #[cfg(test)]
            self.pause_before_wait().await;
            notified.await;
        }
    }

    #[cfg(test)]
    async fn pause_before_wait(&self) {
        let barriers = self.wait_barriers.lock().unwrap().take();
        if let Some((reached, resume)) = barriers {
            reached.wait().await;
            resume.wait().await;
        }
    }

    async fn take_dispatchable(&self) -> Option<(QueuedWork, OwnedSemaphorePermit, RunningWork)> {
        let now = self.clock.now_millis();
        let mut queue = self.queue.lock().await;
        let mut running = self.running.lock().await;
        let mut indexes = (0..queue.len()).collect::<Vec<_>>();
        indexes
            .sort_by_key(|index| queue_sort_key(&queue[*index], now, self.config.aging_interval));
        for index in indexes {
            if running.contains_key(&queue[index].job_id) {
                continue;
            }
            let semaphore = match queue[index].resource {
                SchedulerResource::Ffmpeg => self.ffmpeg_permits.clone(),
                SchedulerResource::BlockingIo => self.blocking_io_permits.clone(),
            };
            if let Ok(permit) = semaphore.try_acquire_owned() {
                let work = queue.remove(index);
                let running_work = RunningWork {
                    cancellation: ProcessCancellation::new(),
                    user_cancellation_requested: Arc::new(AtomicBool::new(false)),
                };
                running.insert(work.job_id.clone(), running_work.clone());
                self.active_count.fetch_add(1, Ordering::AcqRel);
                return Some((work, permit, running_work));
            }
        }
        None
    }

    async fn execute(
        self: &Arc<Self>,
        work: QueuedWork,
        _permit: OwnedSemaphorePermit,
        running_work: RunningWork,
    ) {
        let attempt = work.attempt.saturating_add(1);
        match self.start_work(&work, attempt).await {
            StartWorkDisposition::Started => {}
            StartWorkDisposition::Requeue => {
                self.requeue_after_start_failure(work, &running_work).await;
                return;
            }
            StartWorkDisposition::Discard => {
                work.worker.on_terminal(MediaJobFinalOutcome::Cancelled);
                self.running.lock().await.remove(&work.job_id);
                if self.reconcile_cancellation(&work.job_id).await.is_err() {
                    eprintln!("Media cancellation settlement failed; recovery may be required.");
                }
                return;
            }
        }

        let job_id = work.job_id.clone();
        let outcome = work
            .worker
            .run(job_id.clone(), running_work.cancellation.clone())
            .await;

        if self
            .finish(work, attempt, running_work, outcome)
            .await
            .is_err()
        {
            eprintln!("Media worker settlement failed; recovery may be required.");
        }

        self.running.lock().await.remove(&job_id);
        if self.reconcile_cancellation(&job_id).await.is_err() {
            eprintln!("Media cancellation settlement failed; recovery may be required.");
        }
    }

    async fn start_work(&self, work: &QueuedWork, attempt: u8) -> StartWorkDisposition {
        const START_RETRY_DELAYS: [Duration; 3] = [
            Duration::from_millis(10),
            Duration::from_millis(50),
            Duration::from_millis(100),
        ];
        for retry_delay in START_RETRY_DELAYS {
            let current = match self.store.get_private(work.job_id.clone()).await {
                Ok(stored) => stored.public,
                Err(_) => return StartWorkDisposition::Requeue,
            };
            if current.state == MediaJobState::Running {
                return StartWorkDisposition::Discard;
            }
            if current.state != MediaJobState::Queued || current.cancellation_requested {
                return StartWorkDisposition::Discard;
            }
            let started = self
                .store
                .transition(
                    work.job_id.clone(),
                    MediaJobTransition {
                        state: MediaJobState::Running,
                        stage: "running".to_owned(),
                        progress: current.progress,
                        attempt: Some(attempt),
                        error: None,
                        retry_at_ms: None,
                        result: None,
                        cancellation_requested: false,
                        event_type: MediaJobEventType::StateChanged,
                        message: Some("Media job started.".to_owned()),
                        occurred_at_ms: self.clock.now_millis(),
                    },
                )
                .await;
            if started.is_ok() {
                return StartWorkDisposition::Started;
            }
            self.clock.sleep(retry_delay).await;
        }
        StartWorkDisposition::Requeue
    }

    async fn requeue_after_start_failure(&self, work: QueuedWork, running_work: &RunningWork) {
        let job_id = work.job_id.clone();
        let mut queue = self.queue.lock().await;
        let mut running = self.running.lock().await;
        let should_requeue = !self.shutting_down.load(Ordering::Acquire)
            && !running_work.cancellation.is_cancelled()
            && running.contains_key(&job_id)
            && !queue.iter().any(|queued| queued.job_id == job_id);
        if should_requeue {
            queue.push(work);
        }
        running.remove(&job_id);
        drop(running);
        drop(queue);
        if should_requeue {
            self.notify.notify_waiters();
        }
    }

    async fn record_cancelled_cleanup(
        &self,
        job_id: String,
        progress: MediaJobProgress,
    ) -> Result<(), MediaStateStoreError> {
        let current = self
            .store
            .request_cancellation(job_id.clone(), self.clock.now_millis())
            .await?;

        if current.state.is_terminal() {
            return Ok(());
        }
        self.store
            .transition(
                job_id,
                MediaJobTransition {
                    state: current.state,
                    stage: current.stage,
                    progress,
                    attempt: None,
                    error: current.error,
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: true,
                    event_type: MediaJobEventType::Progress,
                    message: None,
                    occurred_at_ms: self.clock.now_millis(),
                },
            )
            .await?;
        Ok(())
    }

    async fn finish(
        self: &Arc<Self>,
        work: QueuedWork,
        attempt: u8,
        running_work: RunningWork,
        outcome: MediaWorkerOutcome,
    ) -> Result<(), MediaStateStoreError> {
        let now = self.clock.now_millis();
        if running_work.cancellation.is_cancelled() {
            if !running_work
                .user_cancellation_requested
                .load(Ordering::Acquire)
            {
                return Ok(());
            }
            let progress = match outcome {
                MediaWorkerOutcome::Complete { progress, .. }
                | MediaWorkerOutcome::Cancelled { progress }
                | MediaWorkerOutcome::Failed { progress, .. } => progress,
            };
            self.record_cancelled_cleanup(work.job_id, progress).await?;
            work.worker.on_terminal(MediaJobFinalOutcome::Cancelled);
            return Ok(());
        }

        match outcome {
            MediaWorkerOutcome::Complete { result, progress } => {
                self.store
                    .transition(
                        work.job_id,
                        terminal_transition(TerminalTransitionRequest {
                            state: MediaJobState::Complete,
                            stage: "complete",
                            progress,
                            error: None,
                            result: Some(result),
                            cancellation_requested: false,
                            message: "Media job complete.",
                            occurred_at_ms: now,
                        }),
                    )
                    .await?;
                work.worker.on_terminal(MediaJobFinalOutcome::Complete);
            }
            MediaWorkerOutcome::Cancelled { progress } => {
                self.record_cancelled_cleanup(work.job_id, progress).await?;
                work.worker.on_terminal(MediaJobFinalOutcome::Cancelled);
            }
            MediaWorkerOutcome::Failed { error, progress } => {
                let classification = RetryClassification::from_category(error.category);
                if classification == RetryClassification::Transient && attempt < work.max_attempts {
                    let retry_number = attempt.saturating_sub(1);
                    let delay = automatic_retry_delay(retry_number)
                        .ok_or(MediaStateStoreError::InvalidTransition)?;
                    let retry_at =
                        now.saturating_add(i64::try_from(delay.as_millis()).unwrap_or(i64::MAX));
                    self.store
                        .transition(
                            work.job_id.clone(),
                            MediaJobTransition {
                                state: MediaJobState::Retrying,
                                stage: "retrying".to_owned(),
                                progress: progress.clone(),
                                attempt: Some(attempt),
                                error: Some(error),
                                retry_at_ms: Some(retry_at),
                                result: None,
                                cancellation_requested: false,
                                event_type: MediaJobEventType::RetryScheduled,
                                message: Some("Media job will retry automatically.".to_owned()),
                                occurred_at_ms: now,
                            },
                        )
                        .await?;
                    let retry_cancelled = tokio::select! {
                        biased;
                        () = running_work.cancellation.wait() => true,
                        () = self.clock.sleep(delay) => false,
                    };
                    if retry_cancelled || running_work.cancellation.is_cancelled() {
                        if running_work
                            .user_cancellation_requested
                            .load(Ordering::Acquire)
                        {
                            let cancelled_at = self.clock.now_millis();
                            self.store
                                .request_cancellation(work.job_id, cancelled_at)
                                .await?;
                            work.worker.on_terminal(MediaJobFinalOutcome::Cancelled);
                        }
                        return Ok(());
                    }

                    let mut queue = self.queue.lock().await;
                    let running = self.running.lock().await;
                    if running_work.cancellation.is_cancelled() {
                        drop(running);
                        drop(queue);
                        if running_work
                            .user_cancellation_requested
                            .load(Ordering::Acquire)
                        {
                            let cancelled_at = self.clock.now_millis();
                            self.store
                                .request_cancellation(work.job_id, cancelled_at)
                                .await?;
                            work.worker.on_terminal(MediaJobFinalOutcome::Cancelled);
                        }
                        return Ok(());
                    }
                    if self.shutting_down.load(Ordering::Acquire) {
                        return Ok(());
                    }

                    let requeue_at = self.clock.now_millis().max(retry_at);
                    self.store
                        .transition(
                            work.job_id.clone(),
                            MediaJobTransition {
                                state: MediaJobState::Queued,
                                stage: "queued".to_owned(),
                                progress: MediaJobProgress {
                                    completed: 0,
                                    total: 0,
                                    unit: super::model::MediaJobProgressUnit::Items,
                                },
                                attempt: Some(attempt),
                                error: None,
                                retry_at_ms: None,
                                result: None,
                                cancellation_requested: false,
                                event_type: MediaJobEventType::StateChanged,
                                message: Some("Media job retry queued.".to_owned()),
                                occurred_at_ms: requeue_at,
                            },
                        )
                        .await?;
                    let mut retry = work;
                    retry.attempt = attempt;
                    retry.enqueued_at_ms = requeue_at;
                    retry.sequence = self.sequence.fetch_add(1, Ordering::AcqRel);
                    queue.push(retry);
                    drop(running);
                    drop(queue);
                    self.notify.notify_waiters();
                } else {
                    let state = if classification == RetryClassification::Actionable {
                        MediaJobState::Blocked
                    } else {
                        MediaJobState::Failed
                    };
                    let message = error.message.clone();
                    self.store
                        .transition(
                            work.job_id,
                            terminal_transition(TerminalTransitionRequest {
                                state,
                                stage: if state == MediaJobState::Blocked {
                                    "blocked"
                                } else {
                                    "failed"
                                },
                                progress,
                                error: Some(error),
                                result: None,
                                cancellation_requested: false,
                                message: &message,
                                occurred_at_ms: now,
                            }),
                        )
                        .await?;
                    work.worker.on_terminal(MediaJobFinalOutcome::Failed);
                }
            }
        }
        Ok(())
    }
}

struct TerminalTransitionRequest<'a> {
    state: MediaJobState,
    stage: &'a str,
    progress: MediaJobProgress,
    error: Option<MediaJobError>,
    result: Option<Value>,
    cancellation_requested: bool,
    message: &'a str,
    occurred_at_ms: i64,
}

fn terminal_transition(request: TerminalTransitionRequest<'_>) -> MediaJobTransition {
    MediaJobTransition {
        state: request.state,
        stage: request.stage.to_owned(),
        progress: request.progress,
        attempt: None,
        error: request.error,
        retry_at_ms: None,
        result: request.result,
        cancellation_requested: request.cancellation_requested,
        event_type: MediaJobEventType::StateChanged,
        message: Some(request.message.to_owned()),
        occurred_at_ms: request.occurred_at_ms,
    }
}

fn queue_sort_key(work: &QueuedWork, now_ms: i64, aging_interval: Duration) -> (u8, u64) {
    let waited_ms = now_ms.saturating_sub(work.enqueued_at_ms).max(0) as u64;
    let interval_ms = u64::try_from(aging_interval.as_millis())
        .unwrap_or(u64::MAX)
        .max(1);
    let promotions = u8::try_from(waited_ms / interval_ms).unwrap_or(u8::MAX);
    (
        work.priority.rank().saturating_sub(promotions),
        work.sequence,
    )
}

pub(crate) fn default_blocked_error(
    category: super::model::MediaJobErrorCategory,
) -> MediaJobError {
    let (code, message, action) = match category {
        super::model::MediaJobErrorCategory::AuthorizationRequired => (
            "source_authorization_required",
            "Choose the source again to continue.",
            Some(MediaJobRecoveryAction::ReauthorizeSource),
        ),
        super::model::MediaJobErrorCategory::OutputAuthorizationRequired => (
            "output_authorization_required",
            "Choose the export destination again to continue.",
            Some(MediaJobRecoveryAction::ReauthorizeOutput),
        ),
        super::model::MediaJobErrorCategory::ToolchainUnavailable => (
            "toolchain_unavailable",
            "The verified media tools are unavailable.",
            Some(MediaJobRecoveryAction::VerifyToolchain),
        ),
        super::model::MediaJobErrorCategory::CachePressure => (
            "cache_pressure",
            "Cache space is pinned by active media.",
            Some(MediaJobRecoveryAction::FreeCache),
        ),
        _ => (
            "blocked",
            "The media job needs attention.",
            Some(MediaJobRecoveryAction::Retry),
        ),
    };
    MediaJobError {
        code: code.to_owned(),
        category,
        message: message.to_owned(),
        retryable: false,
        action,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Mutex as StdMutex,
    };

    use super::*;
    use crate::video::jobs::{
        model::{MediaJobErrorCategory, MediaJobKind, MediaJobProgressUnit},
        store::NewMediaJob,
    };

    #[derive(Default)]
    struct TestClock {
        now: AtomicU64,
        sleeps: StdMutex<Vec<Duration>>,
    }

    impl TestClock {
        fn at(now: u64) -> Arc<Self> {
            Arc::new(Self {
                now: AtomicU64::new(now),
                sleeps: StdMutex::new(Vec::new()),
            })
        }
    }

    impl SchedulerClock for TestClock {
        fn now_millis(&self) -> i64 {
            i64::try_from(self.now.load(Ordering::Acquire)).unwrap()
        }

        fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
            self.sleeps.lock().unwrap().push(duration);
            self.now.fetch_add(
                u64::try_from(duration.as_millis()).unwrap(),
                Ordering::AcqRel,
            );
            Box::pin(async {})
        }
    }

    struct PausedTestClock {
        now: AtomicU64,
        sleeps: StdMutex<Vec<Duration>>,
    }

    impl PausedTestClock {
        fn at(now: u64) -> Arc<Self> {
            Arc::new(Self {
                now: AtomicU64::new(now),
                sleeps: StdMutex::new(Vec::new()),
            })
        }
    }

    impl SchedulerClock for PausedTestClock {
        fn now_millis(&self) -> i64 {
            i64::try_from(self.now.load(Ordering::Acquire)).unwrap()
        }

        fn sleep(&self, duration: Duration) -> Pin<Box<dyn Future<Output = ()> + Send + 'static>> {
            self.sleeps.lock().unwrap().push(duration);
            Box::pin(std::future::pending())
        }
    }

    struct RecordingWorker {
        name: &'static str,
        order: Arc<StdMutex<Vec<&'static str>>>,
        active: Arc<AtomicUsize>,
        peak: Arc<AtomicUsize>,
        delay: Duration,
    }

    impl MediaJobWorker for RecordingWorker {
        fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
            let name = self.name;
            let order = self.order.clone();
            let active = self.active.clone();
            let peak = self.peak.clone();
            let delay = self.delay;
            Box::pin(async move {
                order.lock().unwrap().push(name);
                let current = active.fetch_add(1, Ordering::AcqRel) + 1;
                peak.fetch_max(current, Ordering::AcqRel);
                tokio::time::sleep(delay).await;
                active.fetch_sub(1, Ordering::AcqRel);
                MediaWorkerOutcome::Complete {
                    result: serde_json::json!({"ok": true}),
                    progress: MediaJobProgress {
                        completed: 1,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                }
            })
        }
    }

    struct BarrierWorker {
        name: &'static str,
        order: Arc<StdMutex<Vec<&'static str>>>,
        release: Arc<tokio::sync::Barrier>,
    }

    impl MediaJobWorker for BarrierWorker {
        fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
            let name = self.name;
            let order = self.order.clone();
            let release = self.release.clone();
            Box::pin(async move {
                order.lock().unwrap().push(name);
                release.wait().await;
                completed_worker_outcome()
            })
        }
    }

    struct RetryWorker {
        calls: AtomicUsize,
    }

    struct CancellationWorker;

    impl MediaJobWorker for CancellationWorker {
        fn run(&self, _job_id: String, cancellation: ProcessCancellation) -> MediaWorkerFuture {
            Box::pin(async move {
                while !cancellation.is_cancelled() {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
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

    impl MediaJobWorker for RetryWorker {
        fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            Box::pin(async move {
                if call == 0 {
                    transient_worker_failure()
                } else {
                    completed_worker_outcome()
                }
            })
        }
    }

    struct CompatibilityRetryWorker {
        calls: AtomicUsize,
        terminal_outcomes: Arc<StdMutex<Vec<MediaJobFinalOutcome>>>,
    }

    impl MediaJobWorker for CompatibilityRetryWorker {
        fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
            let call = self.calls.fetch_add(1, Ordering::AcqRel);
            Box::pin(async move {
                if call == 0 {
                    transient_worker_failure()
                } else {
                    completed_worker_outcome()
                }
            })
        }

        fn on_terminal(&self, outcome: MediaJobFinalOutcome) {
            self.terminal_outcomes.lock().unwrap().push(outcome);
        }
    }

    fn transient_worker_failure() -> MediaWorkerOutcome {
        MediaWorkerOutcome::Failed {
            error: MediaJobError {
                code: "temporary_io".to_owned(),
                category: MediaJobErrorCategory::TransientIo,
                message: "Temporary media I/O failure.".to_owned(),
                retryable: true,
                action: Some(MediaJobRecoveryAction::Retry),
            },
            progress: MediaJobProgress {
                completed: 0,
                total: 1,
                unit: MediaJobProgressUnit::Items,
            },
        }
    }

    fn completed_worker_outcome() -> MediaWorkerOutcome {
        MediaWorkerOutcome::Complete {
            result: serde_json::json!({"ok": true}),
            progress: MediaJobProgress {
                completed: 1,
                total: 1,
                unit: MediaJobProgressUnit::Items,
            },
        }
    }

    fn new_job(dedupe: &str, priority: MediaJobPriority, now: i64) -> NewMediaJob {
        NewMediaJob {
            kind: MediaJobKind::Proxy,
            parent_id: None,
            dedupe_key: dedupe.to_owned(),
            project_id: None,
            asset_id: None,
            revision_id: None,
            priority,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 1,
                unit: MediaJobProgressUnit::Items,
            },
            max_attempts: 3,
            summary: format!("Run {dedupe}"),
            private_payload: serde_json::json!({"canonicalObjectAvailable": true}),
            created_at_ms: now,
        }
    }

    async fn queued_job(
        store: &MediaJobStore,
        dedupe: &str,
        priority: MediaJobPriority,
        now: i64,
    ) -> String {
        store
            .enqueue(new_job(dedupe, priority, now))
            .await
            .unwrap()
            .job
            .id
    }

    async fn wait_for_retry_delay(
        store: &MediaJobStore,
        clock: &PausedTestClock,
        job_id: &str,
        expected_delay: Duration,
    ) {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let retrying = store
                    .get_private(job_id.to_owned())
                    .await
                    .unwrap()
                    .public
                    .state
                    == MediaJobState::Retrying;
                let sleeping = clock
                    .sleeps
                    .lock()
                    .unwrap()
                    .last()
                    .is_some_and(|delay| *delay == expected_delay);
                if retrying && sleeping {
                    return;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
    }

    fn running_transition_for_manual_retry(now: i64) -> MediaJobTransition {
        MediaJobTransition {
            state: MediaJobState::Running,
            stage: "running".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 1,
                unit: MediaJobProgressUnit::Items,
            },
            attempt: Some(1),
            error: None,
            retry_at_ms: None,
            result: None,
            cancellation_requested: false,
            event_type: MediaJobEventType::StateChanged,
            message: Some("Media job started.".to_owned()),
            occurred_at_ms: now,
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn priority_fifo_aging_and_bounded_ffmpeg_concurrency_are_deterministic() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let clock = TestClock::at(10_000);
        let scheduler = MediaJobScheduler::new(
            store.clone(),
            MediaSchedulerConfig {
                ffmpeg_permits: 1,
                blocking_io_permits: 2,
                aging_interval: Duration::from_millis(100),
            },
            clock.clone(),
        )
        .unwrap();
        let order = Arc::new(StdMutex::new(Vec::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        for (name, priority) in [
            ("background", MediaJobPriority::Background),
            ("export", MediaJobPriority::Export),
            ("interactive", MediaJobPriority::Interactive),
        ] {
            let id = queued_job(&store, name, priority, 10_000).await;
            scheduler
                .submit(
                    id,
                    priority,
                    0,
                    3,
                    SchedulerResource::Ffmpeg,
                    Arc::new(RecordingWorker {
                        name,
                        order: order.clone(),
                        active: active.clone(),
                        peak: peak.clone(),
                        delay: Duration::from_millis(5),
                    }),
                )
                .await
                .unwrap();
        }
        let loop_handle = scheduler.start();
        tokio::time::timeout(Duration::from_secs(2), scheduler.wait_idle())
            .await
            .unwrap();
        scheduler.shutdown().await;
        loop_handle.await.unwrap();
        assert_eq!(
            *order.lock().unwrap(),
            vec!["interactive", "export", "background"]
        );
        assert_eq!(peak.load(Ordering::Acquire), 1);

        let old_background = QueuedWork {
            job_id: "old".to_owned(),
            priority: MediaJobPriority::Background,
            enqueued_at_ms: 0,
            sequence: 0,
            attempt: 0,
            max_attempts: 3,
            resource: SchedulerResource::Ffmpeg,
            worker: Arc::new(RetryWorker {
                calls: AtomicUsize::new(0),
            }),
        };
        assert_eq!(
            queue_sort_key(&old_background, 250, Duration::from_millis(100)).0,
            0
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn permit_release_between_failed_acquisition_and_wait_is_not_lost() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let scheduler = MediaJobScheduler::new(
            store.clone(),
            MediaSchedulerConfig {
                ffmpeg_permits: 1,
                ..MediaSchedulerConfig::default()
            },
            TestClock::at(12_000),
        )
        .unwrap();
        let failed_acquisition = Arc::new(tokio::sync::Barrier::new(2));
        let resume_wait = Arc::new(tokio::sync::Barrier::new(2));
        *scheduler.wait_barriers.lock().unwrap() =
            Some((failed_acquisition.clone(), resume_wait.clone()));
        let release_first = Arc::new(tokio::sync::Barrier::new(2));
        let order = Arc::new(StdMutex::new(Vec::new()));
        let first_id = queued_job(
            &store,
            "lost-wakeup-first",
            MediaJobPriority::Interactive,
            12_000,
        )
        .await;
        scheduler
            .submit(
                first_id.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::Ffmpeg,
                Arc::new(BarrierWorker {
                    name: "first",
                    order: order.clone(),
                    release: release_first.clone(),
                }),
            )
            .await
            .unwrap();
        let second_id = queued_job(
            &store,
            "lost-wakeup-second",
            MediaJobPriority::Interactive,
            12_000,
        )
        .await;
        scheduler
            .submit(
                second_id.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::Ffmpeg,
                Arc::new(RecordingWorker {
                    name: "second",
                    order: order.clone(),
                    active: Arc::new(AtomicUsize::new(0)),
                    peak: Arc::new(AtomicUsize::new(0)),
                    delay: Duration::ZERO,
                }),
            )
            .await
            .unwrap();
        // Earlier submission broadcasts have no saved permit; worker completion is
        // the only notification capable of waking queued work after failed acquisition.
        let loop_handle = scheduler.start();
        failed_acquisition.wait().await;
        release_first.wait().await;
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                if scheduler.active_count.load(Ordering::Acquire) == 0
                    && scheduler.ffmpeg_permits.available_permits() == 1
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        resume_wait.wait().await;

        tokio::time::timeout(Duration::from_secs(2), scheduler.wait_idle())
            .await
            .unwrap();
        scheduler.shutdown().await;
        loop_handle.await.unwrap();
        assert_eq!(*order.lock().unwrap(), vec!["first", "second"]);
        assert_eq!(
            store.get_private(first_id).await.unwrap().public.state,
            MediaJobState::Complete
        );
        assert_eq!(
            store.get_private(second_id).await.unwrap().public.state,
            MediaJobState::Complete
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn idle_observer_does_not_steal_submission_wakeup() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let scheduler = MediaJobScheduler::new(
            store.clone(),
            MediaSchedulerConfig::default(),
            TestClock::at(12_000),
        )
        .unwrap();
        let held_permit = scheduler
            .acquire_resource_permit(SchedulerResource::Ffmpeg)
            .await
            .unwrap();
        let order = Arc::new(StdMutex::new(Vec::new()));
        let worker = Arc::new(RecordingWorker {
            name: "work",
            order: order.clone(),
            active: Arc::new(AtomicUsize::new(0)),
            peak: Arc::new(AtomicUsize::new(0)),
            delay: Duration::ZERO,
        });
        let blocked = queued_job(&store, "blocked", MediaJobPriority::Interactive, 12_000).await;
        scheduler
            .submit(
                blocked,
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::Ffmpeg,
                worker.clone(),
            )
            .await
            .unwrap();

        // Register a real idle observer before the dispatcher. Its queue is nonempty,
        // but the FFmpeg permit prevents that queued work from completing.
        let idle = scheduler.wait_idle();
        tokio::pin!(idle);
        std::future::poll_fn(|cx| {
            assert!(idle.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        let reached = Arc::new(tokio::sync::Barrier::new(2));
        let resume = Arc::new(tokio::sync::Barrier::new(2));
        *scheduler.wait_barriers.lock().unwrap() = Some((reached.clone(), resume.clone()));
        let loop_handle = scheduler.start();
        reached.wait().await;

        // This job has an available permit and must run even while idle is observed.
        let runnable = queued_job(&store, "runnable", MediaJobPriority::Interactive, 12_000).await;
        scheduler
            .submit(
                runnable.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::BlockingIo,
                worker,
            )
            .await
            .unwrap();
        resume.wait().await;
        let completed = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                std::future::poll_fn(|cx| {
                    assert!(idle.as_mut().poll(cx).is_pending());
                    std::task::Poll::Ready(())
                })
                .await;
                if store
                    .get_private(runnable.clone())
                    .await
                    .unwrap()
                    .public
                    .state
                    == MediaJobState::Complete
                {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await;

        // Clean up before asserting, including on the regression's failure path.
        scheduler.shutdown().await;
        drop(held_permit);
        tokio::time::timeout(Duration::from_secs(2), loop_handle)
            .await
            .unwrap()
            .unwrap();
        assert!(
            completed.is_ok(),
            "idle observer consumed the runnable job's dispatch wakeup"
        );
        assert_eq!(*order.lock().unwrap(), vec!["work"]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn transient_start_transition_failures_requeue_and_complete_once() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let clock = TestClock::at(15_000);
        let scheduler = MediaJobScheduler::new(
            store.clone(),
            MediaSchedulerConfig::default(),
            clock.clone(),
        )
        .unwrap();
        let id = queued_job(
            &store,
            "transient-start-transition",
            MediaJobPriority::Interactive,
            15_000,
        )
        .await;
        let order = Arc::new(StdMutex::new(Vec::new()));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        scheduler
            .submit(
                id.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::Ffmpeg,
                Arc::new(RecordingWorker {
                    name: "start-transition",
                    order: order.clone(),
                    active,
                    peak,
                    delay: Duration::ZERO,
                }),
            )
            .await
            .unwrap();

        let release_start = store.fail_next_three_start_transitions();
        let loop_handle = scheduler.start();
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                if clock.sleeps.lock().unwrap().len() >= 3 {
                    break;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        assert_eq!(
            store.get_private(id.clone()).await.unwrap().public.state,
            MediaJobState::Queued
        );

        assert_eq!(
            *clock.sleeps.lock().unwrap(),
            vec![
                Duration::from_millis(10),
                Duration::from_millis(50),
                Duration::from_millis(100),
            ]
        );
        assert!(order.lock().unwrap().is_empty());
        release_start.notify_one();
        tokio::time::timeout(Duration::from_secs(5), scheduler.wait_idle())
            .await
            .unwrap();
        scheduler.shutdown().await;
        loop_handle.await.unwrap();

        let job = store.get_private(id.clone()).await.unwrap().public;
        assert_eq!(job.state, MediaJobState::Complete);
        assert_eq!(job.attempt, 1);
        assert_eq!(*order.lock().unwrap(), vec!["start-transition"]);
        let events = store.events(Some(id), 0, 20).await.unwrap().events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.state == MediaJobState::Running)
                .count(),
            1
        );
        assert_eq!(
            events
                .iter()
                .filter(|event| event.state == MediaJobState::Complete)
                .count(),
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn transient_failure_retries_at_injected_delay_and_completes_once() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let clock = TestClock::at(20_000);
        let scheduler = MediaJobScheduler::new(
            store.clone(),
            MediaSchedulerConfig::default(),
            clock.clone(),
        )
        .unwrap();
        let id = queued_job(&store, "retry", MediaJobPriority::Interactive, 20_000).await;
        let terminal_outcomes = Arc::new(StdMutex::new(Vec::new()));
        let worker = Arc::new(CompatibilityRetryWorker {
            calls: AtomicUsize::new(0),
            terminal_outcomes: terminal_outcomes.clone(),
        });
        scheduler
            .submit(
                id.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::Ffmpeg,
                worker.clone(),
            )
            .await
            .unwrap();
        let loop_handle = scheduler.start();
        tokio::time::timeout(Duration::from_secs(2), scheduler.wait_idle())
            .await
            .unwrap();
        scheduler.shutdown().await;
        loop_handle.await.unwrap();
        let job = store.get_private(id.clone()).await.unwrap().public;
        assert_eq!(job.state, MediaJobState::Complete);
        assert_eq!(job.attempt, 2);
        assert_eq!(worker.calls.load(Ordering::Acquire), 2);
        assert_eq!(
            *terminal_outcomes.lock().unwrap(),
            vec![MediaJobFinalOutcome::Complete],
            "a retried attempt must not publish a terminal failure",
        );
        assert_eq!(*clock.sleeps.lock().unwrap(), vec![Duration::from_secs(1)]);
        let events = store.events(Some(id), 0, 20).await.unwrap().events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.state == MediaJobState::Complete)
                .count(),
            1
        );
        assert!(events
            .iter()
            .any(|event| event.state == MediaJobState::Retrying));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn cancellation_interrupts_each_automatic_retry_delay_without_requeue() {
        for (retry_number, expected_delay) in [
            (0, Duration::from_secs(1)),
            (1, Duration::from_secs(5)),
            (2, Duration::from_secs(30)),
        ] {
            let directory = tempfile::tempdir().unwrap();
            let store = MediaJobStore::initialize(directory.path().to_path_buf())
                .await
                .unwrap();
            let clock = PausedTestClock::at(25_000);
            let scheduler = MediaJobScheduler::new(
                store.clone(),
                MediaSchedulerConfig::default(),
                clock.clone(),
            )
            .unwrap();
            let id = queued_job(
                &store,
                &format!("cancel-retry-{retry_number}"),
                MediaJobPriority::Interactive,
                25_000,
            )
            .await;
            let worker = Arc::new(RetryWorker {
                calls: AtomicUsize::new(0),
            });
            scheduler
                .submit(
                    id.clone(),
                    MediaJobPriority::Interactive,
                    retry_number,
                    4,
                    SchedulerResource::Ffmpeg,
                    worker.clone(),
                )
                .await
                .unwrap();

            let loop_handle = scheduler.start();
            wait_for_retry_delay(&store, &clock, &id, expected_delay).await;
            scheduler.cancel(&id).await.unwrap();
            tokio::time::timeout(Duration::from_secs(1), scheduler.wait_idle())
                .await
                .unwrap();
            scheduler.shutdown().await;
            loop_handle.await.unwrap();

            let job = store.get_private(id.clone()).await.unwrap().public;
            assert_eq!(job.state, MediaJobState::Cancelled);
            assert!(job.cancellation_requested);
            assert_eq!(worker.calls.load(Ordering::Acquire), 1);
            assert_eq!(*clock.sleeps.lock().unwrap(), vec![expected_delay]);
            assert!(scheduler.queue.lock().await.is_empty());
            let events = store.events(Some(id), 0, 20).await.unwrap().events;
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.state == MediaJobState::Cancelled)
                    .count(),
                1
            );
            assert_eq!(
                events
                    .iter()
                    .filter(|event| event.state == MediaJobState::Queued)
                    .count(),
                1
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_interrupts_retry_delay_and_leaves_one_recoverable_retry() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let clock = PausedTestClock::at(60_000);
        let scheduler = MediaJobScheduler::new(
            store.clone(),
            MediaSchedulerConfig::default(),
            clock.clone(),
        )
        .unwrap();
        let id = queued_job(
            &store,
            "shutdown-retry",
            MediaJobPriority::Interactive,
            60_000,
        )
        .await;
        let worker = Arc::new(RetryWorker {
            calls: AtomicUsize::new(0),
        });
        scheduler
            .submit(
                id.clone(),
                MediaJobPriority::Interactive,
                2,
                4,
                SchedulerResource::Ffmpeg,
                worker.clone(),
            )
            .await
            .unwrap();

        let loop_handle = scheduler.start();
        wait_for_retry_delay(&store, &clock, &id, Duration::from_secs(30)).await;
        tokio::time::timeout(Duration::from_secs(1), scheduler.shutdown())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), scheduler.wait_idle())
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), loop_handle)
            .await
            .unwrap()
            .unwrap();

        let retrying = store.get_private(id.clone()).await.unwrap().public;
        assert_eq!(retrying.state, MediaJobState::Retrying);
        assert!(!retrying.cancellation_requested);
        assert_eq!(worker.calls.load(Ordering::Acquire), 1);
        assert_eq!(*clock.sleeps.lock().unwrap(), vec![Duration::from_secs(30)]);
        assert!(scheduler.queue.lock().await.is_empty());
        let pre_recovery_events = store.events(Some(id.clone()), 0, 20).await.unwrap().events;
        assert_eq!(
            pre_recovery_events
                .iter()
                .filter(|event| event.state == MediaJobState::Cancelled)
                .count(),
            0
        );
        assert_eq!(
            pre_recovery_events
                .iter()
                .filter(|event| event.state == MediaJobState::Queued)
                .count(),
            1
        );

        let report = store.recover("restart".to_owned(), 90_001).await.unwrap();
        assert_eq!(report.requeued_count, 1);
        assert_eq!(
            store.get_private(id.clone()).await.unwrap().public.state,
            MediaJobState::Queued
        );
        let second_report = store.recover("restart".to_owned(), 90_002).await.unwrap();
        assert_eq!(second_report.requeued_count, 0);
        let events = store.events(Some(id), 0, 20).await.unwrap().events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.state == MediaJobState::Queued)
                .count(),
            2
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn queued_and_running_cancellation_settle_once() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let clock = TestClock::at(30_000);
        let scheduler =
            MediaJobScheduler::new(store.clone(), MediaSchedulerConfig::default(), clock).unwrap();

        let queued_id = queued_job(
            &store,
            "cancel-queued",
            MediaJobPriority::Interactive,
            30_000,
        )
        .await;
        scheduler
            .submit(
                queued_id.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::BlockingIo,
                Arc::new(CancellationWorker),
            )
            .await
            .unwrap();
        scheduler.cancel(&queued_id).await.unwrap();
        assert_eq!(
            store.get_private(queued_id).await.unwrap().public.state,
            MediaJobState::Cancelled
        );

        let running_id = queued_job(
            &store,
            "cancel-running",
            MediaJobPriority::Interactive,
            30_000,
        )
        .await;
        scheduler
            .submit(
                running_id.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::Ffmpeg,
                Arc::new(CancellationWorker),
            )
            .await
            .unwrap();
        let loop_handle = scheduler.start();
        tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if store
                    .get_private(running_id.clone())
                    .await
                    .unwrap()
                    .public
                    .state
                    == MediaJobState::Running
                {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        scheduler.cancel(&running_id).await.unwrap();
        tokio::time::timeout(Duration::from_secs(1), scheduler.wait_idle())
            .await
            .unwrap();
        scheduler.shutdown().await;
        loop_handle.await.unwrap();
        assert_eq!(
            store
                .get_private(running_id.clone())
                .await
                .unwrap()
                .public
                .state,
            MediaJobState::Cancelled
        );
        let events = store.events(Some(running_id), 0, 20).await.unwrap().events;
        assert_eq!(
            events
                .iter()
                .filter(|event| event.state == MediaJobState::Cancelled)
                .count(),
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn manual_retry_requeues_once_and_rejects_duplicates() {
        let directory = tempfile::tempdir().unwrap();
        let store = MediaJobStore::initialize(directory.path().to_path_buf())
            .await
            .unwrap();
        let clock = TestClock::at(40_010);
        let scheduler =
            MediaJobScheduler::new(store.clone(), MediaSchedulerConfig::default(), clock).unwrap();
        let id = queued_job(
            &store,
            "manual-retry",
            MediaJobPriority::Interactive,
            40_000,
        )
        .await;
        scheduler
            .submit(
                id.clone(),
                MediaJobPriority::Interactive,
                0,
                3,
                SchedulerResource::Ffmpeg,
                Arc::new(RetryWorker {
                    calls: AtomicUsize::new(0),
                }),
            )
            .await
            .unwrap();
        scheduler.queue.lock().await.clear();
        store
            .transition(id.clone(), running_transition_for_manual_retry(40_001))
            .await
            .unwrap();
        store
            .transition(
                id.clone(),
                MediaJobTransition {
                    state: MediaJobState::Failed,
                    stage: "failed".to_owned(),
                    progress: MediaJobProgress {
                        completed: 0,
                        total: 1,
                        unit: MediaJobProgressUnit::Items,
                    },
                    attempt: Some(1),
                    error: Some(MediaJobError {
                        code: "invalid_media".to_owned(),
                        category: MediaJobErrorCategory::InvalidMedia,
                        message: "The media is invalid.".to_owned(),
                        retryable: false,
                        action: None,
                    }),
                    retry_at_ms: None,
                    result: None,
                    cancellation_requested: false,
                    event_type: MediaJobEventType::StateChanged,
                    message: Some("The media is invalid.".to_owned()),
                    occurred_at_ms: 40_002,
                },
            )
            .await
            .unwrap();
        scheduler
            .retry_with_worker(
                &id,
                SchedulerResource::Ffmpeg,
                Arc::new(RetryWorker {
                    calls: AtomicUsize::new(0),
                }),
            )
            .await
            .unwrap();
        assert!(scheduler
            .retry_with_worker(
                &id,
                SchedulerResource::Ffmpeg,
                Arc::new(RetryWorker {
                    calls: AtomicUsize::new(0),
                }),
            )
            .await
            .is_err());
        assert_eq!(scheduler.queue.lock().await.len(), 1);
        assert_eq!(
            store.get_private(id).await.unwrap().public.state,
            MediaJobState::Queued
        );
    }
}
