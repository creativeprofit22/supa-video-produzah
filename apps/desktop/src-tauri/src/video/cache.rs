use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use fs4::{FileExt, TryLockError};
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use uuid::Uuid;

use super::{
    jobs::{
        model::{MediaCachePressure, MediaCacheStatus, MEDIA_JOB_SCHEMA_VERSION},
        store::{MediaJobStore, MediaStateStore, MediaStateStoreError},
    },
    media_store::{
        artifact_key_from_temporary_name, try_lock_artifact_nonblocking, ArtifactStoreKind,
        MEDIA_STORE_NAMESPACE,
    },
};

const LEGACY_CACHE_NAMESPACE: &str = "video-phase1";
const ACTIVE_RENDER_PREVIEW_DIRECTORY: &str = "render-preview";
const EVICTION_LOCK_TIMEOUT: Duration = Duration::from_secs(2);
const EVICTION_LOCK_RETRY: Duration = Duration::from_millis(25);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CacheArtifactKind {
    SourceObject,
    Proxy,
    ThumbnailTile,
    Transcript,
}

impl CacheArtifactKind {
    fn database_value(self) -> &'static str {
        match self {
            Self::SourceObject => "source_object",
            Self::Proxy => "proxy",
            Self::ThumbnailTile => "thumbnail_tile",
            Self::Transcript => "transcript",
        }
    }

    fn relative_path(self, key: &str) -> Result<PathBuf, MediaStateStoreError> {
        validate_cache_key(key)?;
        let prefix = &key[..2];
        Ok(match self {
            Self::SourceObject => PathBuf::from("objects")
                .join("sha256")
                .join(prefix)
                .join(format!("{key}.blob")),
            Self::Proxy => PathBuf::from("derived")
                .join("proxy")
                .join(prefix)
                .join(format!("{key}.mp4")),
            Self::ThumbnailTile => PathBuf::from("derived")
                .join("thumbnail_tile")
                .join(prefix)
                .join(format!("{key}.jpg")),
            Self::Transcript => PathBuf::from("derived")
                .join("transcript")
                .join(prefix)
                .join(format!("{key}.json")),
        })
    }

    fn lock_relative_path(self, key: &str) -> Result<PathBuf, MediaStateStoreError> {
        validate_cache_key(key)?;
        let prefix = &key[..2];
        Ok(match self {
            Self::SourceObject => PathBuf::from("locks")
                .join("object")
                .join(prefix)
                .join(format!("{key}.lock")),
            Self::Proxy => PathBuf::from("locks")
                .join("proxy")
                .join(prefix)
                .join(format!("{key}.lock")),
            Self::ThumbnailTile => PathBuf::from("locks")
                .join("thumbnail_tile")
                .join(prefix)
                .join(format!("{key}.lock")),
            Self::Transcript => PathBuf::from("locks")
                .join("transcript")
                .join(prefix)
                .join(format!("{key}.lock")),
        })
    }
}

#[derive(Clone, Debug)]
pub(crate) struct CacheArtifactRegistration {
    pub(crate) key: String,
    pub(crate) content_digest: String,
    pub(crate) kind: CacheArtifactKind,
    pub(crate) path: PathBuf,
    pub(crate) profile_id: Option<String>,
    pub(crate) toolchain_id: Option<String>,
    pub(crate) recipe_id: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct CacheEvictionReport {
    pub(crate) evicted_bytes: u64,
    pub(crate) evicted_artifacts: u64,
    pub(crate) remaining_bytes: u64,
    pub(crate) pinned_pressure: bool,
}

impl CacheEvictionReport {
    fn validate(&self, budget_bytes: u64) -> Result<(), MediaStateStoreError> {
        let eviction_counts_match = (self.evicted_bytes == 0) == (self.evicted_artifacts == 0);
        let pressure_matches = self.pinned_pressure == (self.remaining_bytes > budget_bytes);
        if eviction_counts_match && pressure_matches {
            Ok(())
        } else {
            Err(MediaStateStoreError::CorruptRecord)
        }
    }
}

#[derive(Clone, Debug)]
pub(crate) struct LegacyClearReport {
    pub(crate) cleared_bytes: u64,
    pub(crate) cleared_entries: u64,
    pub(crate) skipped_unsafe_entries: u64,
}

#[derive(Clone)]
pub(crate) struct MediaCacheService {
    state: MediaStateStore,
    app_cache_root: PathBuf,
    session_id: String,
    failed_evictions: Arc<Mutex<Vec<EvictionCandidate>>>,
    #[cfg(test)]
    race_hooks: CacheRaceHooks,
}

// Instance-local scheduling around the shared visibility/lifetime gate.
#[cfg(test)]
#[derive(Clone, Default)]
struct CacheRaceHooks {
    eviction_contention: Option<Arc<EvictionContentionProbe>>,
    write_attempt: Option<std::sync::mpsc::SyncSender<()>>,
    after_register: Option<std::sync::Arc<CacheRaceGate>>,
    before_unlink: Option<std::sync::Arc<CacheRaceGate>>,
    after_status_inventory: Option<std::sync::Arc<CacheRaceGate>>,
    before_eviction_lock: Option<std::sync::Arc<CacheRaceGate>>,
    lock_attempt: Option<std::sync::mpsc::SyncSender<()>>,
    publication: std::sync::Arc<std::sync::Mutex<Option<PublicationRace>>>,
}

// Opt-in for one fixture and its clones: real SQLite contention, without busy sleeps.
#[cfg(test)]
#[derive(Default)]
struct EvictionContentionProbe {
    errors: Mutex<Vec<(&'static str, rusqlite::ErrorCode)>>,
}

#[cfg(test)]
struct PublicationRace {
    kind: CacheArtifactKind,
    gate: std::sync::Arc<CacheRaceGate>,
}

#[cfg(test)]
struct CacheRaceGate {
    reached: std::sync::mpsc::SyncSender<()>,
    resume: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
}

#[cfg(test)]
impl CacheRaceGate {
    fn pause(&self) -> Result<(), MediaStateStoreError> {
        self.reached
            .try_send(())
            .map_err(|_| MediaStateStoreError::WorkerStopped)?;
        self.resume
            .lock()
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| MediaStateStoreError::WorkerStopped)
    }
}

impl MediaCacheService {
    pub(crate) fn new(store: &MediaJobStore, app_cache_root: PathBuf, session_id: String) -> Self {
        Self {
            state: store.state().clone(),
            app_cache_root,
            session_id,
            failed_evictions: Arc::default(),
            #[cfg(test)]
            race_hooks: CacheRaceHooks::default(),
        }
    }

    pub(super) fn app_cache_root(&self) -> &Path {
        &self.app_cache_root
    }

    #[cfg(test)]
    pub(crate) async fn register(
        &self,
        registration: CacheArtifactRegistration,
    ) -> Result<(), MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.register_sync(&registration))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    #[cfg(test)]
    pub(crate) async fn lease(
        &self,
        owner_label: String,
        project_id: Option<String>,
        artifact_key: String,
    ) -> Result<String, MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            service.lease_sync(&owner_label, project_id.as_deref(), &artifact_key)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    /// Retain the caller's artifact guard until commit; never acquires another file lock.
    pub(crate) async fn register_and_lease(
        &self,
        registration: CacheArtifactRegistration,
        owner_label: String,
        project_id: Option<String>,
    ) -> Result<String, MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            service.register_and_lease_sync(&registration, &owner_label, project_id.as_deref())
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    fn register_and_lease_sync(
        &self,
        registration: &CacheArtifactRegistration,
        owner_label: &str,
        project_id: Option<&str>,
    ) -> Result<String, MediaStateStoreError> {
        let mut connection = self.state.open_connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.register_on(&transaction, registration)?;
        let lease =
            self.insert_lease_on(&transaction, owner_label, project_id, &registration.key)?;
        transaction.commit()?;
        Ok(lease)
    }

    /// Transfer protected attempt pins without an eviction gap or changing existing owner IDs.
    pub(crate) async fn transfer_attempt_leases(
        &self,
        attempt: String,
        owner: String,
        project_id: String,
    ) -> Result<(), MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let mut connection = service.state.open_connection()?;
            let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let keys = {
                let mut statement = transaction.prepare(
                    "SELECT artifact_key FROM cache_leases WHERE session_id = ?1 AND owner_label = ?2",
                )?;
                let rows = statement.query_map(params![service.session_id, attempt], |row| row.get::<_, String>(0))?;
                rows.collect::<Result<Vec<_>, _>>()?
            };
            for key in keys {
                service.lease_on(&transaction, &owner, Some(&project_id), &key)?;
            }
            transaction.execute(
                "DELETE FROM cache_leases WHERE session_id = ?1 AND owner_label = ?2",
                params![service.session_id, attempt],
            )?;
            transaction.commit()?;
            Ok(())
        }).await.map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    fn lease_on(
        &self,
        connection: &Connection,
        owner_label: &str,
        project_id: Option<&str>,
        artifact_key: &str,
    ) -> Result<String, MediaStateStoreError> {
        let (candidate, availability) = Self::catalog_candidate(connection, artifact_key)?
            .ok_or(MediaStateStoreError::CorruptRecord)?;
        if availability != "available" && availability != "reserved" {
            return Err(MediaStateStoreError::CorruptRecord);
        }
        self.validate_candidate(&candidate)?;
        Self::mark_candidate_on(connection, artifact_key, "available")?;
        self.insert_lease_on(connection, owner_label, project_id, artifact_key)
    }

    #[cfg(test)]
    fn lease_sync(
        &self,
        owner_label: &str,
        project_id: Option<&str>,
        artifact_key: &str,
    ) -> Result<String, MediaStateStoreError> {
        validate_owner_label(owner_label)?;
        validate_cache_key(artifact_key)?;
        let mut connection = self.state.open_connection()?;
        #[cfg(test)]
        if let Some(attempt) = &self.race_hooks.write_attempt {
            let _ = attempt.try_send(());
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let (candidate, availability) = Self::catalog_candidate(&transaction, artifact_key)?
            .ok_or(MediaStateStoreError::CorruptRecord)?;
        if availability != "available" && availability != "reserved" {
            return Err(MediaStateStoreError::CorruptRecord);
        }
        if let Err(error) = self.validate_candidate(&candidate) {
            Self::mark_candidate_on(&transaction, artifact_key, "missing")?;
            transaction.commit()?;
            return Err(error);
        }
        Self::mark_candidate_on(&transaction, artifact_key, "available")?;
        let lease = self.insert_lease_on(&transaction, owner_label, project_id, artifact_key)?;
        transaction.commit()?;
        Ok(lease)
    }

    fn insert_lease_on(
        &self,
        connection: &Connection,
        owner_label: &str,
        project_id: Option<&str>,
        artifact_key: &str,
    ) -> Result<String, MediaStateStoreError> {
        validate_owner_label(owner_label)?;
        validate_cache_key(artifact_key)?;
        let lease_id = Uuid::new_v4().to_string();
        let inserted = connection.execute(
            "INSERT INTO cache_leases (
                    lease_id, session_id, owner_label, project_id, artifact_key, acquired_at_ms
                 ) SELECT ?1, ?2, ?3, ?4, ?5, ?6
                   WHERE NOT EXISTS (
                       SELECT 1 FROM cache_leases
                       WHERE session_id = ?2 AND owner_label = ?3
                         AND project_id IS ?4 AND artifact_key = ?5
                   )",
            params![
                &lease_id,
                &self.session_id,
                &owner_label,
                project_id,
                &artifact_key,
                now_millis(),
            ],
        )?;
        if inserted == 1 {
            return Ok(lease_id);
        }
        connection
            .query_row(
                "SELECT lease_id FROM cache_leases
                     WHERE session_id = ?1 AND owner_label = ?2
                       AND project_id IS ?3 AND artifact_key = ?4
                     ORDER BY acquired_at_ms, lease_id LIMIT 1",
                params![self.session_id, owner_label, project_id, artifact_key],
                |row| row.get(0),
            )
            .map_err(MediaStateStoreError::from)
    }

    pub(crate) async fn release_owner(
        &self,
        owner_label: String,
    ) -> Result<u64, MediaStateStoreError> {
        self.release_where("owner_label = ?2", owner_label).await
    }

    pub(crate) async fn release_project(
        &self,
        project_id: String,
    ) -> Result<u64, MediaStateStoreError> {
        self.release_where("project_id = ?2", project_id).await
    }

    async fn release_where(
        &self,
        predicate: &'static str,
        value: String,
    ) -> Result<u64, MediaStateStoreError> {
        let state = self.state.clone();
        let session_id = self.session_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let connection = state.open_connection()?;
            let deleted = connection.execute(
                &format!("DELETE FROM cache_leases WHERE session_id = ?1 AND {predicate}"),
                params![session_id, value],
            )?;
            u64::try_from(deleted).map_err(|_| MediaStateStoreError::CorruptRecord)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn release_all_session(&self) -> Result<u64, MediaStateStoreError> {
        let state = self.state.clone();
        let session_id = self.session_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            let connection = state.open_connection()?;
            let deleted = connection.execute(
                "DELETE FROM cache_leases WHERE session_id = ?1",
                [session_id],
            )?;
            u64::try_from(deleted).map_err(|_| MediaStateStoreError::CorruptRecord)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn status(&self) -> Result<MediaCacheStatus, MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.status_sync())
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn rebuild_owned_inventory(&self) -> Result<u64, MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.rebuild_owned_inventory_sync())
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn cleanup_stale_builds(
        &self,
        minimum_age: Duration,
    ) -> Result<u64, MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.cleanup_stale_builds_sync(minimum_age))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn enforce_budget(&self) -> Result<CacheEvictionReport, MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.enforce_budget_sync(None))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    #[cfg(test)]
    pub(crate) async fn enforce_test_budget(
        &self,
        budget: u64,
    ) -> Result<CacheEvictionReport, MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.enforce_budget_sync(Some(budget)))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn clear_legacy(&self) -> Result<LegacyClearReport, MediaStateStoreError> {
        let root = self.app_cache_root.clone();
        tauri::async_runtime::spawn_blocking(move || clear_legacy_sync(&root))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    fn rebuild_owned_inventory_sync(&self) -> Result<u64, MediaStateStoreError> {
        let Some(root) = existing_managed_root(&self.app_cache_root)? else {
            return Ok(0);
        };
        let mut registrations = Vec::new();
        collect_owned_artifacts(
            &root.join("objects").join("sha256"),
            CacheArtifactKind::SourceObject,
            "blob",
            &mut registrations,
        )?;
        collect_owned_artifacts(
            &root.join("derived").join("proxy"),
            CacheArtifactKind::Proxy,
            "mp4",
            &mut registrations,
        )?;
        collect_owned_artifacts(
            &root.join("derived").join("thumbnail_tile"),
            CacheArtifactKind::ThumbnailTile,
            "jpg",
            &mut registrations,
        )?;
        collect_owned_artifacts(
            &root.join("derived").join("transcript"),
            CacheArtifactKind::Transcript,
            "json",
            &mut registrations,
        )?;
        let mut registered = 0_u64;
        for (kind, key, path) in registrations {
            self.register_sync(&CacheArtifactRegistration {
                content_digest: key.clone(),
                key,
                kind,
                path,
                profile_id: None,
                toolchain_id: None,
                recipe_id: None,
            })?;
            registered += 1;
        }
        Ok(registered)
    }

    fn cleanup_stale_builds_sync(
        &self,
        minimum_age: Duration,
    ) -> Result<u64, MediaStateStoreError> {
        let Some(root) = existing_managed_root(&self.app_cache_root)? else {
            return Ok(0);
        };
        let mut removed = 0_u64;
        for (kind, store_kind, extension) in [
            (CacheArtifactKind::Proxy, ArtifactStoreKind::Proxy, "mp4"),
            (
                CacheArtifactKind::ThumbnailTile,
                ArtifactStoreKind::ThumbnailTile,
                "jpg",
            ),
            (
                CacheArtifactKind::Transcript,
                ArtifactStoreKind::Transcript,
                "json",
            ),
        ] {
            let kind_root = root.join("derived").join(kind.database_value());
            if !kind_root.exists() {
                continue;
            }
            ensure_safe_directory(&kind_root, false)?;
            for prefix_entry in fs::read_dir(kind_root)? {
                let prefix_entry = prefix_entry?;
                let prefix_path = prefix_entry.path();
                let prefix_metadata = fs::symlink_metadata(&prefix_path)?;
                let prefix = prefix_entry.file_name().to_string_lossy().into_owned();
                if !prefix_metadata.is_dir()
                    || is_reparse_or_symlink(&prefix_metadata)
                    || !is_hex_prefix(&prefix)
                {
                    continue;
                }
                for entry in fs::read_dir(prefix_path)? {
                    let entry = entry?;
                    let path = entry.path();
                    let metadata = fs::symlink_metadata(&path)?;
                    let name = entry.file_name().to_string_lossy().into_owned();
                    if !metadata.is_file()
                        || is_reparse_or_symlink(&metadata)
                        || !metadata
                            .modified()
                            .ok()
                            .and_then(|modified| modified.elapsed().ok())
                            .is_some_and(|age| age >= minimum_age)
                    {
                        continue;
                    }
                    let Some(key) = artifact_key_from_temporary_name(&name, extension) else {
                        continue;
                    };
                    if key[..2] != prefix {
                        continue;
                    }
                    let Some(_lock) =
                        try_lock_artifact_nonblocking(&self.app_cache_root, store_kind, key)
                            .map_err(|_| MediaStateStoreError::UnsafeDirectory)?
                    else {
                        continue;
                    };
                    fs::remove_file(path)?;
                    removed += 1;
                }
            }
        }
        Ok(removed)
    }
    fn register_sync(
        &self,
        registration: &CacheArtifactRegistration,
    ) -> Result<(), MediaStateStoreError> {
        let mut connection = self.state.open_connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        self.register_on(&transaction, registration)?;
        transaction.commit()?;
        Ok(())
    }

    fn register_on(
        &self,
        connection: &Connection,
        registration: &CacheArtifactRegistration,
    ) -> Result<(), MediaStateStoreError> {
        validate_cache_key(&registration.key)?;
        validate_cache_key(&registration.content_digest)?;
        let relative = registration.kind.relative_path(&registration.key)?;
        let expected = self.managed_root()?.join(&relative);
        validate_exact_regular_file(&expected, &registration.path)?;
        let byte_length = fs::symlink_metadata(&expected)?.len();
        if byte_length == 0 {
            return Err(MediaStateStoreError::CorruptRecord);
        }
        let relative_path = relative_path_string(&relative)?;
        let now = now_millis();
        connection.execute(
            "INSERT INTO cache_artifacts (
                artifact_key, content_digest, kind, relative_path, byte_length,
                profile_id, toolchain_id, recipe_id, availability,
                last_verified_at_ms, last_accessed_at_ms, created_at_ms, updated_at_ms
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'available', ?9, ?9, ?9, ?9)
             ON CONFLICT(artifact_key) DO UPDATE SET
                content_digest = excluded.content_digest,
                kind = excluded.kind,
                relative_path = excluded.relative_path,
                byte_length = excluded.byte_length,
                profile_id = excluded.profile_id,
                toolchain_id = excluded.toolchain_id,
                recipe_id = excluded.recipe_id,
                availability = 'available',
                last_verified_at_ms = excluded.last_verified_at_ms,
                last_accessed_at_ms = excluded.last_accessed_at_ms,
                updated_at_ms = excluded.updated_at_ms",
            params![
                registration.key,
                registration.content_digest,
                registration.kind.database_value(),
                relative_path,
                i64::try_from(byte_length).map_err(|_| MediaStateStoreError::CorruptRecord)?,
                registration.profile_id,
                registration.toolchain_id,
                registration.recipe_id,
                now,
            ],
        )?;
        #[cfg(test)]
        if let Some(gate) = &self.race_hooks.after_register {
            gate.pause()?;
        }
        #[cfg(test)]
        {
            let gate = {
                let mut publication = self.race_hooks.publication.lock().unwrap();
                if publication
                    .as_ref()
                    .is_some_and(|hook| hook.kind == registration.kind)
                {
                    publication.take().map(|hook| hook.gate)
                } else {
                    None
                }
            };
            if let Some(gate) = gate {
                gate.pause()?;
            }
        }
        Ok(())
    }

    fn managed_root(&self) -> Result<PathBuf, MediaStateStoreError> {
        ensure_safe_directory(&self.app_cache_root, true)?;
        let app_cache_root = self.app_cache_root.canonicalize()?;
        let managed = app_cache_root.join(MEDIA_STORE_NAMESPACE);
        ensure_safe_directory(&managed, false)?;
        let canonical = managed.canonicalize()?;
        if canonical.parent() != Some(app_cache_root.as_path()) {
            return Err(MediaStateStoreError::UnsafeDirectory);
        }
        Ok(canonical)
    }

    fn status_sync(&self) -> Result<MediaCacheStatus, MediaStateStoreError> {
        self.reconcile_failed_evictions()?;
        let mut connection = self.state.open_connection()?;
        let managed_root = self.managed_root().ok();
        let budget: i64 = connection.query_row(
            "SELECT integer_value FROM media_settings WHERE key = 'managed_cache_budget_bytes_v1'",
            [],
            |row| row.get(0),
        )?;
        let mut managed_bytes = 0_u64;
        let mut artifact_count = 0_u64;
        let mut leased_lengths = Vec::new();
        // Capture lease membership with the inventory, not from a later catalogue view.
        let mut statement = connection.prepare(
            "SELECT artifact_key, relative_path, byte_length,
                    EXISTS(SELECT 1 FROM cache_leases l WHERE l.artifact_key = a.artifact_key)
             FROM cache_artifacts a
             WHERE availability = 'available' ORDER BY artifact_key",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, bool>(3)?,
            ))
        })?;
        let mut missing = Vec::new();
        for row in rows {
            let (key, relative, expected_length, leased) = row?;
            let valid = managed_root
                .as_ref()
                .and_then(|root| safe_catalog_path(root, &relative).ok())
                .and_then(|path| fs::symlink_metadata(path).ok())
                .is_some_and(|metadata| {
                    metadata.is_file()
                        && !is_reparse_or_symlink(&metadata)
                        && i64::try_from(metadata.len()).ok() == Some(expected_length)
                });
            if valid {
                let byte_length = u64::try_from(expected_length)
                    .map_err(|_| MediaStateStoreError::CorruptRecord)?;
                managed_bytes = managed_bytes
                    .checked_add(byte_length)
                    .ok_or(MediaStateStoreError::CorruptRecord)?;
                artifact_count += 1;
                if leased {
                    leased_lengths.push(byte_length);
                }
            } else {
                missing.push(key);
            }
        }
        drop(statement);
        #[cfg(test)]
        if let Some(gate) = &self.race_hooks.after_status_inventory {
            gate.pause()?;
        }
        for key in missing {
            // Re-read under the writer gate: an earlier missing observation must
            // never overwrite a publisher's newly committed availability.
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            if let Some((candidate, availability)) = Self::catalog_candidate(&transaction, &key)? {
                if availability == "available" && self.validate_candidate(&candidate).is_err() {
                    Self::mark_candidate_on(&transaction, &key, "missing")?;
                }
                // Repairs affect the next status; do not mix them into this inventory.
            }
            transaction.commit()?;
        }
        let leased_artifact_count =
            u64::try_from(leased_lengths.len()).map_err(|_| MediaStateStoreError::CorruptRecord)?;
        let leased_bytes = leased_lengths
            .into_iter()
            .try_fold(0_u64, |total, length| {
                total
                    .checked_add(length)
                    .ok_or(MediaStateStoreError::CorruptRecord)
            })?;
        let reclaimable_bytes = managed_bytes
            .checked_sub(leased_bytes)
            .ok_or(MediaStateStoreError::CorruptRecord)?;
        let budget_bytes =
            u64::try_from(budget).map_err(|_| MediaStateStoreError::CorruptRecord)?;
        let pressure = if managed_bytes <= budget_bytes {
            MediaCachePressure::Normal
        } else if reclaimable_bytes == 0 {
            MediaCachePressure::Pinned
        } else {
            MediaCachePressure::OverBudget
        };
        let legacy = inventory_legacy(&self.app_cache_root)?;
        Ok(MediaCacheStatus {
            schema_version: MEDIA_JOB_SCHEMA_VERSION,
            budget_bytes,
            managed_bytes,
            leased_bytes,
            reclaimable_bytes,
            artifact_count,
            leased_artifact_count,
            pressure,
            legacy_bytes: legacy.bytes,
            legacy_entry_count: legacy.entries,
            legacy_unsafe_entry_count: legacy.unsafe_entries,
            legacy_clear_available: legacy.entries > 0,
            recovery_warning: None,
            refreshed_at: timestamp_string(now_millis())?,
        })
    }

    fn enforce_budget_sync(
        &self,
        budget_override: Option<u64>,
    ) -> Result<CacheEvictionReport, MediaStateStoreError> {
        let connection = self.state.open_connection()?;
        let budget = match budget_override {
            Some(value) => value,
            None => u64::try_from(connection.query_row::<i64, _, _>(
                "SELECT integer_value FROM media_settings WHERE key = 'managed_cache_budget_bytes_v1'",
                [],
                |row| row.get(0),
            )?)
            .map_err(|_| MediaStateStoreError::CorruptRecord)?,
        };
        drop(connection);
        let mut evicted_bytes = 0_u64;
        let mut evicted_artifacts = 0_u64;
        loop {
            let status = self.status_sync()?;
            if status.managed_bytes <= budget {
                let report = CacheEvictionReport {
                    evicted_bytes,
                    evicted_artifacts,
                    remaining_bytes: status.managed_bytes,
                    pinned_pressure: false,
                };
                report.validate(budget)?;
                return Ok(report);
            }
            let Some(candidate) = self.reserve_lru_candidate()? else {
                let report = CacheEvictionReport {
                    evicted_bytes,
                    evicted_artifacts,
                    remaining_bytes: status.managed_bytes,
                    pinned_pressure: true,
                };
                report.validate(budget)?;
                return Ok(report);
            };
            if self.evict_reserved_candidate(&candidate)? {
                evicted_bytes = evicted_bytes.saturating_add(candidate.byte_length);
                evicted_artifacts += 1;
            }
        }
    }

    fn reserve_lru_candidate(&self) -> Result<Option<EvictionCandidate>, MediaStateStoreError> {
        let mut connection = self.state.open_connection()?;
        #[cfg(test)]
        if let Some(attempt) = &self.race_hooks.write_attempt {
            let _ = attempt.try_send(());
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let candidate = transaction
            .query_row(
                "SELECT artifact_key, kind, relative_path, byte_length FROM cache_artifacts
                 WHERE availability = 'available'
                   AND artifact_key NOT IN (SELECT artifact_key FROM cache_leases)
                 ORDER BY last_accessed_at_ms ASC, artifact_key ASC LIMIT 1",
                [],
                |row| {
                    Ok(EvictionCandidate {
                        key: row.get(0)?,
                        kind: parse_kind(&row.get::<_, String>(1)?)?,
                        relative_path: row.get(2)?,
                        byte_length: u64::try_from(row.get::<_, i64>(3)?).map_err(|_| {
                            rusqlite::Error::IntegralValueOutOfRange(3, row.get(3).unwrap_or(-1))
                        })?,
                    })
                },
            )
            .optional()?;
        if let Some(candidate) = &candidate {
            transaction.execute(
                "UPDATE cache_artifacts SET availability = 'reserved', updated_at_ms = ?2
                 WHERE artifact_key = ?1 AND availability = 'available'",
                params![candidate.key, now_millis()],
            )?;
        }
        transaction.commit()?;
        Ok(candidate)
    }

    #[cfg(test)]
    fn record_eviction_database_error(
        &self,
        stage: &'static str,
        error: Option<&MediaStateStoreError>,
    ) {
        if let (
            Some(probe),
            Some(MediaStateStoreError::Sqlite(rusqlite::Error::SqliteFailure(error, _))),
        ) = (&self.race_hooks.eviction_contention, error)
        {
            probe.errors.lock().unwrap().push((stage, error.code));
        }
    }

    fn evict_reserved_candidate(
        &self,
        candidate: &EvictionCandidate,
    ) -> Result<bool, MediaStateStoreError> {
        let result = self.evict_reserved_candidate_inner(candidate);
        #[cfg(test)]
        self.record_eviction_database_error("eviction", result.as_ref().err());
        if result.is_err() {
            // The inner call has released all file/database guards before taking this mutex.
            self.failed_evictions
                .lock()
                .map_err(|_| MediaStateStoreError::WorkerStopped)?
                .push(candidate.clone());
            let repair = self.reconcile_failed_evictions();
            #[cfg(test)]
            self.record_eviction_database_error("repair", repair.as_ref().err());
            repair?;
        }
        result
    }

    fn reconcile_failed_evictions(&self) -> Result<(), MediaStateStoreError> {
        // Serialize repair through commit/removal so a stale repair cannot rescue a later
        // reservation. Never acquire this mutex while holding a file or database guard.
        let mut pending = self
            .failed_evictions
            .lock()
            .map_err(|_| MediaStateStoreError::WorkerStopped)?;
        if pending.is_empty() {
            return Ok(());
        }
        let mut connection = self.state.open_connection()?;
        #[cfg(test)]
        if self.race_hooks.eviction_contention.is_some() {
            connection.busy_timeout(Duration::ZERO)?;
        }
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        for candidate in pending.iter() {
            let Some((current, availability)) =
                Self::catalog_candidate(&transaction, &candidate.key)?
            else {
                continue;
            };
            if availability != "reserved"
                || current.kind != candidate.kind
                || current.relative_path != candidate.relative_path
                || current.byte_length != candidate.byte_length
            {
                continue;
            }
            // Recheck leases under the writer gate; repair never deletes bytes or leases.
            let leased: bool = transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM cache_leases WHERE artifact_key = ?1)",
                [&candidate.key],
                |row| row.get(0),
            )?;
            let valid = self.validate_candidate(&current).is_ok();
            let availability = if valid { "available" } else { "missing" };
            transaction.execute(
                "UPDATE cache_artifacts SET availability = ?2, updated_at_ms = ?3
                 WHERE artifact_key = ?1 AND availability = 'reserved'
                   AND EXISTS(SELECT 1 FROM cache_leases WHERE artifact_key = ?1) = ?4",
                params![candidate.key, availability, now_millis(), leased],
            )?;
        }
        transaction.commit()?;
        // Any error above retains every obligation for the next status/enforcement call.
        pending.clear();
        Ok(())
    }

    fn evict_reserved_candidate_inner(
        &self,
        candidate: &EvictionCandidate,
    ) -> Result<bool, MediaStateStoreError> {
        let root = self.managed_root()?;
        // Preserve fail-closed catalog containment errors before touching the lock path.
        safe_catalog_path(&root, &candidate.relative_path)?;
        let lock_path = root.join(candidate.kind.lock_relative_path(&candidate.key)?);
        #[cfg(test)]
        if let Some(attempt) = &self.race_hooks.lock_attempt {
            let _ = attempt.try_send(());
        }
        #[cfg(test)]
        if let Some(gate) = &self.race_hooks.before_eviction_lock {
            gate.pause()?;
        }
        let _lock = CacheFileLock::acquire(&lock_path)?;
        let mut connection = self.state.open_connection()?;
        #[cfg(test)]
        if self.race_hooks.eviction_contention.is_some() {
            connection.busy_timeout(Duration::ZERO)?;
        }
        // simplification: SQLite serializes short unlink sections across keys.
        // Upgrade to a per-key deletion-state protocol only if measured contention warrants it.
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some((current, availability)) = Self::catalog_candidate(&transaction, &candidate.key)?
        else {
            return Ok(false);
        };
        let leases: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM cache_leases WHERE artifact_key = ?1",
            [&candidate.key],
            |row| row.get(0),
        )?;
        if availability != "reserved" {
            return Ok(false);
        }
        if current.kind != candidate.kind
            || current.relative_path != candidate.relative_path
            || current.byte_length != candidate.byte_length
            || leases != 0
        {
            Self::mark_candidate_on(&transaction, &candidate.key, "available")?;
            transaction.commit()?;
            return Ok(false);
        }
        let path = match self.validate_candidate(&current) {
            Ok(path) => path,
            Err(_) => {
                Self::mark_candidate_on(&transaction, &candidate.key, "invalid")?;
                transaction.commit()?;
                return Ok(false);
            }
        };
        #[cfg(test)]
        if let Some(gate) = &self.race_hooks.before_unlink {
            gate.pause()?;
        }
        fs::remove_file(path)?;
        transaction.execute(
            "DELETE FROM cache_artifacts WHERE artifact_key = ?1 AND availability = 'reserved'",
            [&candidate.key],
        )?;
        transaction.commit()?;
        Ok(true)
    }

    fn validate_candidate(
        &self,
        candidate: &EvictionCandidate,
    ) -> Result<PathBuf, MediaStateStoreError> {
        let root = self.managed_root()?;
        let expected = candidate.kind.relative_path(&candidate.key)?;
        if relative_path_string(&expected)? != candidate.relative_path {
            return Err(MediaStateStoreError::UnsafeDirectory);
        }
        let path = safe_catalog_path(&root, &candidate.relative_path)?;
        validate_exact_regular_file(&root.join(expected), &path)?;
        if candidate.byte_length == 0 || fs::symlink_metadata(&path)?.len() != candidate.byte_length
        {
            return Err(MediaStateStoreError::CorruptRecord);
        }
        Ok(path)
    }

    fn catalog_candidate(
        connection: &Connection,
        key: &str,
    ) -> Result<Option<(EvictionCandidate, String)>, MediaStateStoreError> {
        Ok(connection.query_row(
            "SELECT kind, relative_path, byte_length, availability FROM cache_artifacts WHERE artifact_key = ?1",
            [key], |row| Ok((EvictionCandidate {
                key: key.to_owned(), kind: parse_kind(&row.get::<_, String>(0)?)?,
                relative_path: row.get(1)?, byte_length: u64::try_from(row.get::<_, i64>(2)?).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(2, -1))?,
            }, row.get(3)?))).optional()?)
    }

    fn mark_candidate_on(
        connection: &Connection,
        key: &str,
        availability: &str,
    ) -> Result<(), MediaStateStoreError> {
        connection.execute(
            "UPDATE cache_artifacts SET availability = ?2, updated_at_ms = ?3
             WHERE artifact_key = ?1 AND availability IN ('available', 'reserved')
               AND (?2 != 'available' OR availability = 'reserved')",
            params![key, availability, now_millis()],
        )?;
        Ok(())
    }
}

#[derive(Clone, Debug)]
struct EvictionCandidate {
    key: String,
    kind: CacheArtifactKind,
    relative_path: String,
    byte_length: u64,
}

struct CacheFileLock {
    file: File,
}

impl CacheFileLock {
    fn acquire(path: &Path) -> Result<Self, MediaStateStoreError> {
        let metadata =
            fs::symlink_metadata(path.parent().ok_or(MediaStateStoreError::UnsafeDirectory)?)?;
        if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
            return Err(MediaStateStoreError::UnsafeDirectory);
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)?;
        let started = std::time::Instant::now();
        loop {
            match <File as FileExt>::try_lock(&file) {
                Ok(()) => return Ok(Self { file }),
                Err(TryLockError::WouldBlock) if started.elapsed() < EVICTION_LOCK_TIMEOUT => {
                    std::thread::sleep(EVICTION_LOCK_RETRY);
                }
                Err(_) => return Err(MediaStateStoreError::WorkerStopped),
            }
        }
    }
}

impl Drop for CacheFileLock {
    fn drop(&mut self) {
        let _ = <File as FileExt>::unlock(&self.file);
    }
}

#[derive(Default)]
struct LegacyInventory {
    bytes: u64,
    entries: u64,
    unsafe_entries: u64,
}

fn inventory_legacy(app_cache_root: &Path) -> Result<LegacyInventory, MediaStateStoreError> {
    let root = app_cache_root.join(LEGACY_CACHE_NAMESPACE);
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LegacyInventory::default())
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Ok(LegacyInventory {
            entries: 1,
            unsafe_entries: 1,
            ..LegacyInventory::default()
        });
    }
    inventory_directory(&root, true)
}

fn inventory_directory(
    path: &Path,
    preserve_render_previews: bool,
) -> Result<LegacyInventory, MediaStateStoreError> {
    let mut inventory = LegacyInventory::default();
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if preserve_render_previews
            && entry.file_name().to_str() == Some(ACTIVE_RENDER_PREVIEW_DIRECTORY)
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())?;
        inventory.entries += 1;
        if is_reparse_or_symlink(&metadata) {
            inventory.unsafe_entries += 1;
        } else if metadata.is_file() {
            inventory.bytes = inventory.bytes.saturating_add(metadata.len());
        } else if metadata.is_dir() {
            let child = inventory_directory(&entry.path(), false)?;
            inventory.bytes = inventory.bytes.saturating_add(child.bytes);
            inventory.entries = inventory.entries.saturating_add(child.entries);
            inventory.unsafe_entries = inventory
                .unsafe_entries
                .saturating_add(child.unsafe_entries);
        } else {
            inventory.unsafe_entries += 1;
        }
    }
    Ok(inventory)
}

fn clear_legacy_sync(app_cache_root: &Path) -> Result<LegacyClearReport, MediaStateStoreError> {
    ensure_safe_directory(app_cache_root, true)?;
    let app_cache_root = app_cache_root.canonicalize()?;
    let root = app_cache_root.join(LEGACY_CACHE_NAMESPACE);
    let metadata = match fs::symlink_metadata(&root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(LegacyClearReport {
                cleared_bytes: 0,
                cleared_entries: 0,
                skipped_unsafe_entries: 0,
            })
        }
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Ok(LegacyClearReport {
            cleared_bytes: 0,
            cleared_entries: 0,
            skipped_unsafe_entries: 1,
        });
    }
    clear_legacy_directory(&root, true)
}

fn clear_legacy_directory(
    path: &Path,
    keep_root: bool,
) -> Result<LegacyClearReport, MediaStateStoreError> {
    let mut report = LegacyClearReport {
        cleared_bytes: 0,
        cleared_entries: 0,
        skipped_unsafe_entries: 0,
    };
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if keep_root && entry.file_name().to_str() == Some(ACTIVE_RENDER_PREVIEW_DIRECTORY) {
            continue;
        }
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path)?;
        if is_reparse_or_symlink(&metadata) {
            report.skipped_unsafe_entries += 1;
        } else if metadata.is_file() {
            fs::remove_file(&entry_path)?;
            report.cleared_bytes = report.cleared_bytes.saturating_add(metadata.len());
            report.cleared_entries += 1;
        } else if metadata.is_dir() {
            let child = clear_legacy_directory(&entry_path, false)?;
            report.cleared_bytes = report.cleared_bytes.saturating_add(child.cleared_bytes);
            report.cleared_entries = report.cleared_entries.saturating_add(child.cleared_entries);
            report.skipped_unsafe_entries = report
                .skipped_unsafe_entries
                .saturating_add(child.skipped_unsafe_entries);
        } else {
            report.skipped_unsafe_entries += 1;
        }
    }
    if !keep_root && report.skipped_unsafe_entries == 0 {
        fs::remove_dir(path)?;
        report.cleared_entries += 1;
    }
    Ok(report)
}

fn existing_managed_root(app_cache_root: &Path) -> Result<Option<PathBuf>, MediaStateStoreError> {
    let managed = app_cache_root.join(MEDIA_STORE_NAMESPACE);
    let metadata = match fs::symlink_metadata(&managed) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(MediaStateStoreError::UnsafeDirectory);
    }
    Ok(Some(managed.canonicalize()?))
}

fn collect_owned_artifacts(
    kind_root: &Path,
    kind: CacheArtifactKind,
    extension: &str,
    output: &mut Vec<(CacheArtifactKind, String, PathBuf)>,
) -> Result<(), MediaStateStoreError> {
    if !kind_root.exists() {
        return Ok(());
    }
    ensure_safe_directory(kind_root, false)?;
    for prefix_entry in fs::read_dir(kind_root)? {
        let prefix_entry = prefix_entry?;
        let prefix_path = prefix_entry.path();
        let prefix_metadata = fs::symlink_metadata(&prefix_path)?;
        let prefix = prefix_entry.file_name().to_string_lossy().into_owned();
        if !prefix_metadata.is_dir()
            || is_reparse_or_symlink(&prefix_metadata)
            || !is_hex_prefix(&prefix)
        {
            continue;
        }
        for entry in fs::read_dir(prefix_path)? {
            let entry = entry?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path)?;
            if !metadata.is_file() || is_reparse_or_symlink(&metadata) || metadata.len() == 0 {
                continue;
            }
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(key) = name.strip_suffix(&format!(".{extension}")) else {
                continue;
            };
            if validate_cache_key(key).is_ok() && key[..2] == prefix {
                output.push((kind, key.to_owned(), path));
            }
        }
    }
    Ok(())
}

fn is_hex_prefix(value: &str) -> bool {
    value.len() == 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn ensure_safe_directory(path: &Path, create: bool) -> Result<(), MediaStateStoreError> {
    if create {
        fs::create_dir_all(path)?;
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(MediaStateStoreError::UnsafeDirectory);
    }
    Ok(())
}

fn validate_exact_regular_file(expected: &Path, actual: &Path) -> Result<(), MediaStateStoreError> {
    let expected_parent = expected
        .parent()
        .ok_or(MediaStateStoreError::UnsafeDirectory)?;
    let canonical_parent = expected_parent.canonicalize()?;
    let canonical_actual = actual.canonicalize()?;
    if canonical_actual.parent() != Some(canonical_parent.as_path())
        || canonical_actual.file_name() != expected.file_name()
    {
        return Err(MediaStateStoreError::UnsafeDirectory);
    }
    let metadata = fs::symlink_metadata(&canonical_actual)?;
    if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
        return Err(MediaStateStoreError::UnsafeDirectory);
    }
    Ok(())
}

fn safe_catalog_path(root: &Path, relative: &str) -> Result<PathBuf, MediaStateStoreError> {
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(MediaStateStoreError::UnsafeDirectory);
    }
    Ok(root.join(relative_path))
}

fn relative_path_string(path: &Path) -> Result<String, MediaStateStoreError> {
    let value = path.to_string_lossy().replace('\\', "/");
    if value.is_empty() || value.contains("..") || value.starts_with('/') {
        return Err(MediaStateStoreError::UnsafeDirectory);
    }
    Ok(value)
}

fn validate_cache_key(key: &str) -> Result<(), MediaStateStoreError> {
    if key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(MediaStateStoreError::CorruptRecord)
    }
}

fn validate_owner_label(owner: &str) -> Result<(), MediaStateStoreError> {
    if !owner.trim().is_empty() && owner.len() <= 128 {
        Ok(())
    } else {
        Err(MediaStateStoreError::CorruptRecord)
    }
}

fn parse_kind(value: &str) -> rusqlite::Result<CacheArtifactKind> {
    match value {
        "source_object" => Ok(CacheArtifactKind::SourceObject),
        "proxy" => Ok(CacheArtifactKind::Proxy),
        "thumbnail_tile" => Ok(CacheArtifactKind::ThumbnailTile),
        "transcript" => Ok(CacheArtifactKind::Transcript),
        _ => Err(rusqlite::Error::InvalidQuery),
    }
}

fn is_reparse_or_symlink(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn now_millis() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|duration| i64::try_from(duration.as_millis()).ok())
        .unwrap_or(0)
}

fn timestamp_string(timestamp_ms: i64) -> Result<String, MediaStateStoreError> {
    use chrono::{SecondsFormat, TimeZone, Utc};
    Utc.timestamp_millis_opt(timestamp_ms)
        .single()
        .map(|timestamp| timestamp.to_rfc3339_opts(SecondsFormat::Millis, true))
        .ok_or(MediaStateStoreError::CorruptRecord)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::video::{jobs::store::MediaJobStore, media_store::acquire_artifact};

    async fn service(root: &Path) -> (MediaJobStore, MediaCacheService) {
        let local = root.join("local");
        let cache = root.join("cache");
        fs::create_dir_all(cache.join(MEDIA_STORE_NAMESPACE)).unwrap();
        let store = MediaJobStore::initialize(local).await.unwrap();
        let service = MediaCacheService::new(&store, cache, "session-test".to_owned());
        (store, service)
    }

    #[cfg(unix)]
    fn create_directory_redirect(target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    #[cfg(windows)]
    fn create_directory_redirect(target: &Path, link: &Path) -> io::Result<()> {
        let output = std::process::Command::new("cmd.exe")
            .args(["/D", "/C", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output()?;
        if output.status.success() {
            Ok(())
        } else {
            Err(io::Error::other(format!(
                "mklink /J failed with status {}: {}",
                output.status,
                String::from_utf8_lossy(&output.stderr).trim()
            )))
        }
    }

    fn create_artifact(root: &Path, kind: CacheArtifactKind, key: &str, bytes: usize) -> PathBuf {
        let managed = root.join("cache").join(MEDIA_STORE_NAMESPACE);
        let relative = kind.relative_path(key).unwrap();
        let path = managed.join(relative);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![b'x'; bytes]).unwrap();
        let lock = managed.join(kind.lock_relative_path(key).unwrap());
        fs::create_dir_all(lock.parent().unwrap()).unwrap();
        fs::write(lock, b"").unwrap();
        path
    }

    fn registration(
        path: PathBuf,
        kind: CacheArtifactKind,
        key: &str,
    ) -> CacheArtifactRegistration {
        CacheArtifactRegistration {
            key: key.to_owned(),
            content_digest: "a".repeat(64),
            kind,
            path,
            profile_id: None,
            toolchain_id: None,
            recipe_id: None,
        }
    }

    // Release-before-join is also used on unwinding. The hook has its own bounded
    // watchdog, so a missing controller acknowledgement cannot strand a worker.
    struct RaceWorker<T> {
        resume: std::sync::mpsc::SyncSender<()>,
        worker: Option<std::thread::JoinHandle<T>>,
    }

    impl<T> RaceWorker<T> {
        fn finish(mut self) -> std::thread::Result<T> {
            let _ = self.resume.try_send(());
            self.worker.take().unwrap().join()
        }
    }

    impl<T> Drop for RaceWorker<T> {
        fn drop(&mut self) {
            let _ = self.resume.try_send(());
            if let Some(worker) = self.worker.take() {
                let _ = worker.join();
            }
        }
    }

    fn race_gate() -> (
        std::sync::Arc<CacheRaceGate>,
        std::sync::mpsc::Receiver<()>,
        std::sync::mpsc::SyncSender<()>,
    ) {
        let (reached, acknowledgement) = std::sync::mpsc::sync_channel(1);
        let (resume, receiver) = std::sync::mpsc::sync_channel(1);
        (
            std::sync::Arc::new(CacheRaceGate {
                reached,
                resume: std::sync::Mutex::new(receiver),
            }),
            acknowledgement,
            resume,
        )
    }

    fn catalog_and_lease_counts(cache: &MediaCacheService, key: &str) -> (i64, i64) {
        let connection = cache.state.open_connection().unwrap();
        connection
            .query_row(
                "SELECT (SELECT COUNT(*) FROM cache_artifacts WHERE artifact_key = ?1),
                        (SELECT COUNT(*) FROM cache_leases WHERE artifact_key = ?1)",
                [key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap()
    }

    /// Runs an actual publisher on its own runtime, retaining failure-safe worker cleanup.
    pub(crate) fn publication_race<T, F, Fut>(
        cache: &MediaCacheService,
        reserved: bool,
        publish: F,
    ) -> T
    where
        T: Send + 'static,
        F: FnOnce(MediaCacheService) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = T>,
    {
        publication_race_for_kind(cache, reserved, None, publish, || {})
    }

    pub(crate) fn lease_snapshot(cache: &MediaCacheService) -> Vec<(String, String, String)> {
        let connection = cache.state.open_connection().unwrap();
        let mut statement = connection
            .prepare(
                "SELECT lease_id, owner_label, artifact_key FROM cache_leases ORDER BY lease_id",
            )
            .unwrap();
        statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    pub(crate) fn publication_race_for_kind<T, F, Fut>(
        cache: &MediaCacheService,
        reserved: bool,
        kind: Option<CacheArtifactKind>,
        publish: F,
        at_gate: impl FnOnce(),
    ) -> T
    where
        T: Send + 'static,
        F: FnOnce(MediaCacheService) -> Fut + Send + 'static,
        Fut: std::future::Future<Output = T>,
    {
        let candidate = if reserved {
            Some(cache.reserve_lru_candidate().unwrap().unwrap())
        } else {
            None
        };
        let (gate, reached, resume) = race_gate();
        let mut publisher = cache.clone();
        if let Some(kind) = kind {
            *cache.race_hooks.publication.lock().unwrap() = Some(PublicationRace { kind, gate });
        } else {
            publisher.race_hooks.after_register = Some(gate);
        }
        let worker = RaceWorker {
            resume,
            worker: Some(std::thread::spawn(move || {
                tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                    .unwrap()
                    .block_on(publish(publisher))
            })),
        };
        let acknowledged = reached.recv_timeout(Duration::from_secs(10));
        let (attempt, attempted) = std::sync::mpsc::sync_channel(1);
        let mut evictor = cache.clone();
        if reserved {
            evictor.race_hooks.lock_attempt = Some(attempt);
        } else {
            evictor.race_hooks.write_attempt = Some(attempt);
        }
        let eviction = RaceWorker {
            resume: worker.resume.clone(),
            worker: Some(std::thread::spawn(move || {
                if let Some(candidate) = candidate {
                    assert!(!evictor.evict_reserved_candidate(&candidate).unwrap());
                } else {
                    assert!(evictor.reserve_lru_candidate().unwrap().is_none());
                }
                assert_eq!(
                    evictor
                        .enforce_budget_sync(Some(0))
                        .unwrap()
                        .evicted_artifacts,
                    0
                );
            })),
        };
        let attempted = attempted.recv_timeout(Duration::from_secs(10));
        if acknowledged.is_ok() && attempted.is_ok() {
            at_gate();
        }
        let result = worker.finish();
        let eviction = eviction.finish();
        *cache.race_hooks.publication.lock().unwrap() = None;
        assert!(acknowledged.is_ok(), "publisher did not acknowledge upsert");
        assert!(
            attempted.is_ok(),
            "evictor did not acknowledge coordination attempt"
        );
        eviction.unwrap();
        result.unwrap()
    }

    pub(crate) fn unpin_kind_for_reuse(cache: &MediaCacheService, kind: CacheArtifactKind) {
        let changed = cache.state.open_connection().unwrap().execute(
            "DELETE FROM cache_leases WHERE artifact_key IN (SELECT artifact_key FROM cache_artifacts WHERE kind = ?1)",
            [kind.database_value()],
        ).unwrap();
        assert_eq!(changed, 1);
    }

    pub(crate) async fn assert_published_lease(
        cache: &MediaCacheService,
        key: &str,
        path: &Path,
        bytes: &[u8],
        owner: &str,
    ) {
        assert_eq!(catalog_and_lease_counts(cache, key), (1, 1));
        assert_eq!(fs::read(path).unwrap(), bytes);
        cache.release_owner(owner.into()).await.unwrap();
        assert_eq!(
            cache
                .enforce_budget_sync(Some(0))
                .unwrap()
                .evicted_artifacts,
            1
        );
        assert!(!path.exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_race_publication_returns_coherent_public_dto() {
        let root = tempfile::tempdir().unwrap();
        let (store, mut reader) = service(root.path()).await;
        let publisher = MediaCacheService::new(
            &store,
            reader.app_cache_root.clone(),
            "status-publisher".to_owned(),
        );
        let (gate, reached, resume) = race_gate();
        reader.race_hooks.after_status_inventory = Some(gate);
        let worker = RaceWorker {
            resume,
            worker: Some(std::thread::spawn(move || reader.status_sync())),
        };
        reached.recv_timeout(Duration::from_secs(5)).unwrap();
        let key = "a".repeat(64);
        let kind = CacheArtifactKind::SourceObject;
        let path = create_artifact(root.path(), kind, &key, 17);
        let guard = CacheFileLock::acquire(
            &publisher
                .managed_root()
                .unwrap()
                .join(kind.lock_relative_path(&key).unwrap()),
        )
        .unwrap();
        publisher
            .register_and_lease_sync(&registration(path, kind, &key), "owner", None)
            .unwrap();
        drop(guard);
        let status = worker.finish().unwrap().unwrap();
        status.validate().unwrap();
        let counts = (
            status.managed_bytes,
            status.artifact_count,
            status.leased_bytes,
            status.leased_artifact_count,
        );
        assert!(
            counts == (0, 0, 0, 0) || counts == (17, 1, 17, 1),
            "{counts:?}"
        );
        let after = publisher.status_sync().unwrap();
        after.validate().unwrap();
        assert_eq!((after.managed_bytes, after.leased_bytes), (17, 17));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_race_release_and_eviction_return_coherent_public_dto() {
        for evict in [false, true] {
            let root = tempfile::tempdir().unwrap();
            let (store, mut reader) = service(root.path()).await;
            let writer = MediaCacheService::new(
                &store,
                reader.app_cache_root.clone(),
                "status-writer".to_owned(),
            );
            let key = "a".repeat(64);
            let kind = CacheArtifactKind::SourceObject;
            let path = create_artifact(root.path(), kind, &key, 17);
            writer
                .register_and_lease_sync(
                    &registration(path.clone(), kind, &key),
                    "first-owner",
                    None,
                )
                .unwrap();
            writer.lease_sync("second-owner", None, &key).unwrap();
            let (gate, reached, resume) = race_gate();
            reader.race_hooks.after_status_inventory = Some(gate);
            let worker = RaceWorker {
                resume,
                worker: Some(std::thread::spawn(move || reader.status_sync())),
            };
            reached.recv_timeout(Duration::from_secs(5)).unwrap();
            assert_eq!(writer.release_all_session().await.unwrap(), 2);
            if evict {
                let report = writer.enforce_budget_sync(Some(0)).unwrap();
                assert_eq!((report.evicted_bytes, report.evicted_artifacts), (17, 1));
                assert!(!path.exists());
            }
            let status = worker.finish().unwrap().unwrap();
            status.validate().unwrap();
            let counts = (
                status.managed_bytes,
                status.artifact_count,
                status.leased_bytes,
                status.leased_artifact_count,
            );
            let after_counts = if evict { (0, 0, 0, 0) } else { (17, 1, 0, 0) };
            assert!(
                counts == (17, 1, 17, 1) || counts == after_counts,
                "{counts:?}"
            );
            let after = writer.status_sync().unwrap();
            after.validate().unwrap();
            assert_eq!(
                (
                    after.managed_bytes,
                    after.artifact_count,
                    after.leased_bytes,
                    after.leased_artifact_count,
                ),
                after_counts
            );
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn status_race_missing_recheck_preserves_republished_availability() {
        let root = tempfile::tempdir().unwrap();
        let (store, mut reader) = service(root.path()).await;
        let publisher = MediaCacheService::new(
            &store,
            reader.app_cache_root.clone(),
            "status-publisher".to_owned(),
        );
        let key = "a".repeat(64);
        let kind = CacheArtifactKind::SourceObject;
        let path = create_artifact(root.path(), kind, &key, 17);
        publisher
            .register_and_lease_sync(&registration(path.clone(), kind, &key), "owner", None)
            .unwrap();
        fs::remove_file(&path).unwrap();
        let (gate, reached, resume) = race_gate();
        reader.race_hooks.after_status_inventory = Some(gate);
        let worker = RaceWorker {
            resume,
            worker: Some(std::thread::spawn(move || reader.status_sync())),
        };
        reached.recv_timeout(Duration::from_secs(5)).unwrap();
        let guard = CacheFileLock::acquire(
            &publisher
                .managed_root()
                .unwrap()
                .join(kind.lock_relative_path(&key).unwrap()),
        )
        .unwrap();
        fs::write(&path, [b'x'; 17]).unwrap();
        publisher
            .register_and_lease_sync(&registration(path.clone(), kind, &key), "owner", None)
            .unwrap();
        drop(guard);
        let status = worker.finish().unwrap().unwrap();
        status.validate().unwrap();
        let counts = (
            status.managed_bytes,
            status.artifact_count,
            status.leased_bytes,
            status.leased_artifact_count,
        );
        assert!(
            counts == (0, 0, 0, 0) || counts == (17, 1, 17, 1),
            "{counts:?}"
        );
        let connection = publisher.state.open_connection().unwrap();
        let (_, availability) = MediaCacheService::catalog_candidate(&connection, &key)
            .unwrap()
            .unwrap();
        assert_eq!(availability, "available");
        assert_eq!(fs::read(&path).unwrap(), [b'x'; 17]);
        let after = publisher.status_sync().unwrap();
        after.validate().unwrap();
        assert_eq!((after.managed_bytes, after.leased_bytes), (17, 17));
    }

    // Test-only negative controls: deliberately omit the lifetime gate, never a production switch.
    #[tokio::test(flavor = "current_thread")]
    async fn race_unsafe_baselines_expose_split_handoff_and_stale_selection() {
        for kind in [
            CacheArtifactKind::Transcript,
            CacheArtifactKind::SourceObject,
            CacheArtifactKind::Proxy,
            CacheArtifactKind::ThumbnailTile,
        ] {
            for stale_selection in [false, true] {
                let root = tempfile::tempdir().unwrap();
                let (_store, cache) = service(root.path()).await;
                let key = "a".repeat(64);
                let path = create_artifact(root.path(), kind, &key, 8);
                cache
                    .register(registration(path.clone(), kind, &key))
                    .await
                    .unwrap();
                let (gate, reached, resume) = race_gate();
                let actor = cache.clone();
                let actor_key = key.clone();
                let actor_path = path.clone();
                let worker = RaceWorker {
                    resume,
                    worker: Some(std::thread::spawn(move || {
                        if stale_selection {
                            let _candidate = actor.reserve_lru_candidate().unwrap().unwrap();
                            gate.pause().unwrap();
                            // Deliberately unsafe stale unlink: no lock or final lease recheck.
                            fs::remove_file(actor_path).unwrap();
                            None
                        } else {
                            // Deliberately split registration from lease acquisition.
                            gate.pause().unwrap();
                            Some(actor.lease_sync("baseline-reader", None, &actor_key))
                        }
                    })),
                };
                let acknowledged = reached.recv_timeout(Duration::from_secs(10));
                let lease = if stale_selection {
                    Some(cache.lease_sync("baseline-reader", None, &key).unwrap())
                } else {
                    assert_eq!(
                        cache
                            .enforce_budget_sync(Some(0))
                            .unwrap()
                            .evicted_artifacts,
                        1
                    );
                    None
                };
                let result = worker.finish().unwrap();
                assert!(acknowledged.is_ok());
                assert!(!path.exists());
                if stale_selection {
                    assert!(lease.is_some());
                    assert_eq!(catalog_and_lease_counts(&cache, &key), (1, 1));
                } else {
                    assert!(
                        result.unwrap().is_err(),
                        "split handoff loses publication before lease"
                    );
                    assert_eq!(catalog_and_lease_counts(&cache, &key), (0, 0));
                }
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn race_publication_handoff_preserves_returned_lease_and_bytes() {
        let mut failures = Vec::new();
        for kind in [
            CacheArtifactKind::Transcript,
            CacheArtifactKind::SourceObject,
            CacheArtifactKind::Proxy,
            CacheArtifactKind::ThumbnailTile,
        ] {
            let root = tempfile::tempdir().unwrap();
            let (_store, cache) = service(root.path()).await;
            let key = "1".repeat(64);
            let path = create_artifact(root.path(), kind, &key, 8);
            let (gate, reached, resume) = race_gate();
            let mut publisher = cache.clone();
            publisher.race_hooks.after_register = Some(gate);
            let registration = registration(path.clone(), kind, &key);
            let worker = RaceWorker {
                resume,
                worker: Some(std::thread::spawn(move || {
                    let root = publisher.managed_root()?;
                    let _guard = CacheFileLock::acquire(
                        &root.join(registration.kind.lock_relative_path(&registration.key)?),
                    )?;
                    publisher.register_and_lease_sync(&registration, "race-reader", None)
                })),
            };
            let acknowledged = reached.recv_timeout(Duration::from_secs(10));
            let (attempt, attempted) = std::sync::mpsc::sync_channel(1);
            let mut evictor = cache.clone();
            evictor.race_hooks.write_attempt = Some(attempt);
            let eviction_worker = RaceWorker {
                resume: worker.resume.clone(),
                worker: Some(std::thread::spawn(move || {
                    assert!(evictor.reserve_lru_candidate()?.is_none());
                    evictor.enforce_budget_sync(Some(0))
                })),
            };
            let attempted = attempted.recv_timeout(Duration::from_secs(10));
            let published = worker.finish();
            let eviction = eviction_worker.finish().unwrap().unwrap();
            assert!(acknowledged.is_ok(), "publisher did not reach upsert gate");
            assert!(attempted.is_ok(), "eviction did not attempt coordination");
            let lease = published.unwrap();
            let counts = catalog_and_lease_counts(&cache, &key);
            let bytes = fs::read(&path).ok();
            if lease.is_err() || counts != (1, 1) || bytes.as_deref() != Some(&b"xxxxxxxx"[..]) {
                failures.push(format!(
                    "{kind:?}: desired successful handoff with catalog/lease (1, 1) and exact bytes; lease={lease:?}, counts={counts:?}, bytes={bytes:?}, evicted={}",
                    eviction.evicted_artifacts
                ));
            } else {
                cache.release_owner("race-reader".into()).await.unwrap();
                assert_eq!(
                    cache
                        .enforce_budget_sync(Some(0))
                        .unwrap()
                        .evicted_artifacts,
                    1
                );
                assert!(!path.exists());
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn race_final_eligibility_check_must_not_return_a_dangling_lease() {
        let mut failures = Vec::new();
        for kind in [
            CacheArtifactKind::Transcript,
            CacheArtifactKind::SourceObject,
            CacheArtifactKind::Proxy,
            CacheArtifactKind::ThumbnailTile,
        ] {
            let root = tempfile::tempdir().unwrap();
            let (_store, cache) = service(root.path()).await;
            let key = "2".repeat(64);
            let path = create_artifact(root.path(), kind, &key, 8);
            cache
                .register(registration(path.clone(), kind, &key))
                .await
                .unwrap();
            let (gate, reached, resume) = race_gate();
            let mut evictor = cache.clone();
            evictor.race_hooks.before_unlink = Some(gate);
            let worker = RaceWorker {
                resume,
                worker: Some(std::thread::spawn(move || {
                    evictor.enforce_budget_sync(Some(0))
                })),
            };
            let acknowledged = reached.recv_timeout(Duration::from_secs(10));
            let (attempt, attempted) = std::sync::mpsc::sync_channel(1);
            let mut reader = cache.clone();
            reader.race_hooks.write_attempt = Some(attempt);
            let reader_key = key.clone();
            let reader_worker = RaceWorker {
                resume: worker.resume.clone(),
                worker: Some(std::thread::spawn(move || {
                    reader.lease_sync("race-reader", None, &reader_key)
                })),
            };
            let attempted = attempted.recv_timeout(Duration::from_secs(10));
            let before = catalog_and_lease_counts(&cache, &key);
            let eviction = worker.finish();
            let lease = reader_worker.finish().unwrap();
            assert!(attempted.is_ok(), "lease did not attempt writer gate");
            assert!(
                acknowledged.is_ok(),
                "eviction did not reach final-check gate"
            );
            assert_eq!(eviction.unwrap().unwrap().evicted_artifacts, 1);
            let counts = catalog_and_lease_counts(&cache, &key);
            assert_eq!(counts, (0, 0));
            assert!(!path.exists());
            if lease.is_ok() {
                failures.push(format!(
                    "{kind:?}: lease must not succeed for deleted bytes; lease={lease:?}, before unlink={before:?}, after unlink={counts:?}, file_exists={}",
                    path.exists()
                ));
            }
        }
        assert!(failures.is_empty(), "{}", failures.join("\n"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn reserved_lease_wins_and_invalid_content_never_leases() {
        for kind in [
            CacheArtifactKind::Transcript,
            CacheArtifactKind::SourceObject,
            CacheArtifactKind::Proxy,
            CacheArtifactKind::ThumbnailTile,
        ] {
            let root = tempfile::tempdir().unwrap();
            let (_store, cache) = service(root.path()).await;
            let key = "a".repeat(64);
            let path = create_artifact(root.path(), kind, &key, 8);
            cache
                .register(registration(path.clone(), kind, &key))
                .await
                .unwrap();
            let (gate, reached, resume) = race_gate();
            let evictor = cache.clone();
            let worker = RaceWorker {
                resume,
                worker: Some(std::thread::spawn(move || {
                    let candidate = evictor.reserve_lru_candidate()?.unwrap();
                    gate.pause()?;
                    evictor.evict_reserved_candidate(&candidate)
                })),
            };
            let acknowledged = reached.recv_timeout(Duration::from_secs(10));
            let (attempt, attempted) = std::sync::mpsc::sync_channel(1);
            let mut reader = cache.clone();
            reader.race_hooks.write_attempt = Some(attempt);
            let reader_key = key.clone();
            let reader_worker = RaceWorker {
                resume: worker.resume.clone(),
                worker: Some(std::thread::spawn(move || {
                    reader.lease_sync("reader", None, &reader_key)
                })),
            };
            let attempted = attempted.recv_timeout(Duration::from_secs(10));
            // Join the reader without releasing eviction: its commit wins this schedule.
            let mut reader_worker = reader_worker;
            let lease = reader_worker.worker.take().unwrap().join();
            let evicted = worker.finish();
            assert!(acknowledged.is_ok());
            assert!(attempted.is_ok());
            assert!(!evicted.unwrap().unwrap());
            let lease = lease.unwrap().unwrap();
            assert_eq!(
                cache
                    .lease("reader".into(), None, key.clone())
                    .await
                    .unwrap(),
                lease
            );
            assert_eq!(fs::read(&path).unwrap(), b"xxxxxxxx");
            assert_eq!(catalog_and_lease_counts(&cache, &key), (1, 1));
            cache.release_owner("reader".into()).await.unwrap();
            fs::write(&path, b"bad length").unwrap();
            assert!(cache
                .lease("reader".into(), None, key.clone())
                .await
                .is_err());
            assert_eq!(catalog_and_lease_counts(&cache, &key), (1, 0));
            fs::remove_file(path).unwrap();
            assert!(cache.lease("reader".into(), None, key).await.is_err());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn registration_and_lease_failure_roll_back_together() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "b".repeat(64);
        let kind = CacheArtifactKind::Proxy;
        let path = create_artifact(root.path(), kind, &key, 8);
        cache.state.open_connection().unwrap().execute_batch(
            "CREATE TRIGGER fail_lease BEFORE INSERT ON cache_leases BEGIN SELECT RAISE(ABORT, 'injected lease failure'); END;"
        ).unwrap();
        assert!(cache
            .register_and_lease(
                registration(path.clone(), kind, &key),
                "reader".into(),
                None
            )
            .await
            .is_err());
        assert_eq!(catalog_and_lease_counts(&cache, &key), (0, 0));
        assert_eq!(fs::read(&path).unwrap(), b"xxxxxxxx");
        cache
            .state
            .open_connection()
            .unwrap()
            .execute_batch("DROP TRIGGER fail_lease")
            .unwrap();
        let existing_lease = cache
            .register_and_lease(
                registration(path.clone(), kind, &key),
                "existing".into(),
                None,
            )
            .await
            .unwrap();
        assert!(cache
            .register_and_lease(registration(path.clone(), kind, &key), "".into(), None)
            .await
            .is_err());
        let connection = cache.state.open_connection().unwrap();
        connection.execute_batch(
            "CREATE TRIGGER fail_lease BEFORE INSERT ON cache_leases BEGIN SELECT RAISE(ABORT, 'injected lease failure'); END;"
        ).unwrap();
        let mut changed_registration = registration(path.clone(), kind, &key);
        changed_registration.recipe_id = Some("must-roll-back".into());
        assert!(cache
            .register_and_lease(changed_registration, "new-owner".into(), None)
            .await
            .is_err());
        let recipe: Option<String> = connection
            .query_row(
                "SELECT recipe_id FROM cache_artifacts WHERE artifact_key = ?1",
                [&key],
                |row| row.get(0),
            )
            .unwrap();
        assert!(recipe.is_none());
        connection.execute_batch("DROP TRIGGER fail_lease").unwrap();
        assert_eq!(
            cache
                .lease("existing".into(), None, key.clone())
                .await
                .unwrap(),
            existing_lease
        );
        assert_eq!(catalog_and_lease_counts(&cache, &key), (1, 1));
        assert_eq!(fs::read(path).unwrap(), b"xxxxxxxx");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn database_contention_is_bounded_and_does_not_reserve_a_candidate() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "c".repeat(64);
        let path = create_artifact(root.path(), CacheArtifactKind::Proxy, &key, 8);
        cache
            .register(registration(path.clone(), CacheArtifactKind::Proxy, &key))
            .await
            .unwrap();
        let mut connection = cache.state.open_connection().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let (attempt, attempted) = std::sync::mpsc::sync_channel(1);
        let (done, completed) = std::sync::mpsc::sync_channel(1);
        let mut contender = cache.clone();
        contender.race_hooks.write_attempt = Some(attempt);
        let worker = std::thread::spawn(move || {
            let result = contender.reserve_lru_candidate();
            let _ = done.send(result.is_err());
        });
        let acknowledged = attempted.recv_timeout(Duration::from_secs(10));
        let bounded_error = completed.recv_timeout(Duration::from_secs(10));
        // Release the writer even on timeout before joining the blocked connection.
        drop(transaction);
        worker.join().unwrap();
        assert!(acknowledged.is_ok());
        assert!(bounded_error.unwrap());
        let (_, availability) = MediaCacheService::catalog_candidate(&connection, &key)
            .unwrap()
            .unwrap();
        assert_eq!(availability, "available");
        assert_eq!(catalog_and_lease_counts(&cache, &key), (1, 0));
        assert_eq!(fs::read(&path).unwrap(), b"xxxxxxxx");
        assert_eq!(
            cache
                .enforce_budget_sync(Some(0))
                .unwrap()
                .evicted_artifacts,
            1
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_eviction_reconciles_after_both_database_waits() {
        let root = tempfile::tempdir().unwrap();
        let (_store, mut cache) = service(root.path()).await;
        let contention = Arc::new(EvictionContentionProbe::default());
        cache.race_hooks.eviction_contention = Some(contention.clone());
        let kind = CacheArtifactKind::Proxy;
        let key = "3".repeat(64);
        let path = create_artifact(root.path(), kind, &key, 8);
        cache
            .register(registration(path.clone(), kind, &key))
            .await
            .unwrap();
        let candidate = cache.reserve_lru_candidate().unwrap().unwrap();
        let active_key = "4".repeat(64);
        let active_path = create_artifact(root.path(), kind, &active_key, 8);
        cache
            .register(registration(active_path.clone(), kind, &active_key))
            .await
            .unwrap();
        let active = cache.reserve_lru_candidate().unwrap().unwrap();
        let mut connection = cache.state.open_connection().unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let (done, completed) = std::sync::mpsc::sync_channel(1);
        let evictor = cache.clone();
        let worker = std::thread::spawn(move || {
            let _ = done.send(evictor.evict_reserved_candidate(&candidate));
        });
        let result = completed.recv_timeout(Duration::from_secs(10));
        // Keep the writer across BOTH waits; always release it and join before asserting.
        drop(transaction);
        let joined = worker.join();
        joined.unwrap();
        assert!(matches!(
            result.unwrap(),
            Err(MediaStateStoreError::Sqlite(rusqlite::Error::SqliteFailure(error, _)))
                if error.code == rusqlite::ErrorCode::DatabaseBusy
        ));
        assert_eq!(
            *contention.errors.lock().unwrap(),
            vec![
                ("eviction", rusqlite::ErrorCode::DatabaseBusy),
                ("repair", rusqlite::ErrorCode::DatabaseBusy),
            ]
        );
        assert_eq!(cache.failed_evictions.lock().unwrap().len(), 1);
        assert_eq!(fs::read(&path).unwrap(), b"xxxxxxxx");
        assert_eq!(
            MediaCacheService::catalog_candidate(&connection, &key)
                .unwrap()
                .unwrap()
                .1,
            "reserved"
        );
        let (gate, reached, resume) = race_gate();
        let mut active_evictor = cache.clone();
        active_evictor.race_hooks.before_eviction_lock = Some(gate);
        let active_worker =
            std::thread::spawn(move || active_evictor.evict_reserved_candidate(&active));
        let checks = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            reached.recv_timeout(Duration::from_secs(10)).unwrap();
            // A second failed repair must retain the obligation, not drain it on error.
            let mut writer = cache.state.open_connection().unwrap();
            let held = writer
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            let repair_error = cache.status_sync();
            drop(held);
            assert!(matches!(
                repair_error,
                Err(MediaStateStoreError::Sqlite(rusqlite::Error::SqliteFailure(error, _)))
                    if error.code == rusqlite::ErrorCode::DatabaseBusy
            ));
            assert_eq!(cache.failed_evictions.lock().unwrap().len(), 1);
            assert_eq!(cache.status_sync().unwrap().managed_bytes, 8);
            assert!(cache.failed_evictions.lock().unwrap().is_empty());
            assert_eq!(
                MediaCacheService::catalog_candidate(&connection, &active_key)
                    .unwrap()
                    .unwrap()
                    .1,
                "reserved"
            );
            assert_eq!(
                cache
                    .enforce_budget_sync(Some(0))
                    .unwrap()
                    .evicted_artifacts,
                1
            );
            assert!(!path.exists());
            assert_eq!(fs::read(&active_path).unwrap(), b"xxxxxxxx");
        }));
        let _ = resume.send(());
        let active_result = active_worker.join();
        checks.unwrap();
        assert!(active_result.unwrap().unwrap());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn failed_eviction_repair_revalidates_files_identity_and_leases() {
        for mutation in ["missing", "invalid", "replaced", "leased"] {
            let root = tempfile::tempdir().unwrap();
            let (_store, cache) = service(root.path()).await;
            let kind = CacheArtifactKind::Proxy;
            let key = "5".repeat(64);
            let path = create_artifact(root.path(), kind, &key, 8);
            cache
                .register(registration(path.clone(), kind, &key))
                .await
                .unwrap();
            let candidate = cache.reserve_lru_candidate().unwrap().unwrap();
            cache.failed_evictions.lock().unwrap().push(candidate);
            let connection = cache.state.open_connection().unwrap();
            match mutation {
                "missing" => fs::remove_file(&path).unwrap(),
                "invalid" => fs::write(&path, b"short").unwrap(),
                "replaced" => {
                    fs::write(&path, b"replacement").unwrap();
                    connection
                        .execute(
                            "UPDATE cache_artifacts SET byte_length = 11 WHERE artifact_key = ?1",
                            [&key],
                        )
                        .unwrap();
                }
                "leased" => {
                    cache
                        .lease("owner".into(), None, key.clone())
                        .await
                        .unwrap();
                }
                _ => unreachable!(),
            }
            let status = cache.status_sync().unwrap();
            let availability = MediaCacheService::catalog_candidate(&connection, &key)
                .unwrap()
                .unwrap()
                .1;
            match mutation {
                "missing" | "invalid" => {
                    assert_eq!(availability, "missing");
                    assert_eq!(status.managed_bytes, 0);
                }
                "replaced" => {
                    assert_eq!(availability, "reserved");
                    assert_eq!(fs::read(&path).unwrap(), b"replacement");
                }
                "leased" => {
                    assert_eq!(availability, "available");
                    assert_eq!(status.leased_bytes, 8);
                    assert_eq!(
                        cache
                            .enforce_budget_sync(Some(0))
                            .unwrap()
                            .evicted_artifacts,
                        0
                    );
                    assert_eq!(fs::read(&path).unwrap(), b"xxxxxxxx");
                }
                _ => unreachable!(),
            }
            assert!(cache.failed_evictions.lock().unwrap().is_empty());
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn lease_idempotence_preserves_lru_timestamp_and_key_tie_order() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let keys = ["1".repeat(64), "2".repeat(64)];
        for key in keys.iter().rev() {
            let path = create_artifact(root.path(), CacheArtifactKind::Proxy, key, 8);
            cache
                .register(registration(path, CacheArtifactKind::Proxy, key))
                .await
                .unwrap();
        }
        let connection = cache.state.open_connection().unwrap();
        connection
            .execute("UPDATE cache_artifacts SET last_accessed_at_ms = 123", [])
            .unwrap();
        let first = cache
            .lease("owner".into(), Some("project".into()), keys[0].clone())
            .await
            .unwrap();
        assert_eq!(
            cache
                .lease("owner".into(), Some("project".into()), keys[0].clone())
                .await
                .unwrap(),
            first
        );
        let other = cache
            .lease(
                "owner".into(),
                Some("other-project".into()),
                keys[0].clone(),
            )
            .await
            .unwrap();
        assert_ne!(first, other);
        assert_eq!(catalog_and_lease_counts(&cache, &keys[0]), (1, 2));
        let timestamp: i64 = connection
            .query_row(
                "SELECT last_accessed_at_ms FROM cache_artifacts WHERE artifact_key = ?1",
                [&keys[0]],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(timestamp, 123);
        cache.release_owner("owner".into()).await.unwrap();
        let candidate = cache.reserve_lru_candidate().unwrap().unwrap();
        assert_eq!(candidate.key, keys[0]);
        assert!(cache.evict_reserved_candidate(&candidate).unwrap());
        assert_eq!(cache.reserve_lru_candidate().unwrap().unwrap().key, keys[1]);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn eviction_lock_timeout_restores_only_valid_reservation() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "c".repeat(64);
        let kind = CacheArtifactKind::Proxy;
        let path = create_artifact(root.path(), kind, &key, 8);
        cache
            .register(registration(path.clone(), kind, &key))
            .await
            .unwrap();
        let candidate = cache.reserve_lru_candidate().unwrap().unwrap();
        let guard = CacheFileLock::acquire(
            &cache
                .managed_root()
                .unwrap()
                .join(kind.lock_relative_path(&key).unwrap()),
        )
        .unwrap();
        let evictor = cache.clone();
        assert!(
            std::thread::spawn(move || evictor.evict_reserved_candidate(&candidate))
                .join()
                .unwrap()
                .is_err()
        );
        drop(guard);
        assert_eq!(fs::read(path).unwrap(), b"xxxxxxxx");
        assert_eq!(
            cache
                .enforce_budget_sync(Some(0))
                .unwrap()
                .evicted_artifacts,
            1
        );
    }

    #[cfg_attr(not(windows), allow(dead_code))]
    pub(crate) async fn assert_packaged_cache_lease_lru_and_legacy_policy() {
        let root = tempfile::tempdir().unwrap();
        let (store, cache) = service(root.path()).await;
        let first_key = format!("00{}", "1".repeat(62));
        let second_key = format!("00{}", "2".repeat(62));
        let first = create_artifact(root.path(), CacheArtifactKind::Proxy, &first_key, 8);
        let second = create_artifact(root.path(), CacheArtifactKind::Proxy, &second_key, 8);
        cache
            .register(registration(
                first.clone(),
                CacheArtifactKind::Proxy,
                &first_key,
            ))
            .await
            .unwrap();
        cache
            .register(registration(
                second.clone(),
                CacheArtifactKind::Proxy,
                &second_key,
            ))
            .await
            .unwrap();
        cache
            .lease(
                "packaged-cache-owner".to_owned(),
                Some(Uuid::new_v4().to_string()),
                first_key.clone(),
            )
            .await
            .unwrap();

        let report = cache.enforce_test_budget(8).await.unwrap();
        assert_eq!(report.evicted_artifacts, 1);
        assert!(
            first.exists(),
            "an active lease must protect playback media"
        );
        assert!(
            !second.exists(),
            "the deterministic unleased LRU entry must evict"
        );
        let pinned = cache.enforce_test_budget(0).await.unwrap();
        assert!(pinned.pinned_pressure);
        assert_eq!(pinned.remaining_bytes, 8);
        cache
            .release_owner("packaged-cache-owner".to_owned())
            .await
            .unwrap();
        let released = cache.enforce_test_budget(0).await.unwrap();
        assert!(!released.pinned_pressure);
        assert!(!first.exists());
        drop(cache);
        drop(store);

        let legacy = root.path().join("cache").join(LEGACY_CACHE_NAMESPACE);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("preview.bin"), b"legacy").unwrap();
        let active_preview = legacy
            .join(ACTIVE_RENDER_PREVIEW_DIRECTORY)
            .join("render-job")
            .join("preview.mp4");
        fs::create_dir_all(active_preview.parent().unwrap()).unwrap();
        fs::write(&active_preview, b"active-preview").unwrap();

        let (_reopened_store, reopened_cache) = service(root.path()).await;
        let before = reopened_cache.status().await.unwrap();
        assert_eq!(before.legacy_bytes, 6);
        assert!(before.legacy_clear_available);
        assert!(legacy.join("preview.bin").exists());
        let report = reopened_cache.clear_legacy().await.unwrap();
        assert_eq!(report.cleared_bytes, 6);
        assert!(!legacy.join("preview.bin").exists());
        assert!(active_preview.exists());
        assert_eq!(reopened_cache.status().await.unwrap().legacy_bytes, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn catalog_leases_and_deterministic_lru_enforce_budget() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let first_key = format!("00{}", "1".repeat(62));
        let second_key = format!("00{}", "2".repeat(62));
        let first = create_artifact(root.path(), CacheArtifactKind::Proxy, &first_key, 8);
        let second = create_artifact(root.path(), CacheArtifactKind::Proxy, &second_key, 8);
        cache
            .register(registration(
                first.clone(),
                CacheArtifactKind::Proxy,
                &first_key,
            ))
            .await
            .unwrap();
        cache
            .register(registration(
                second.clone(),
                CacheArtifactKind::Proxy,
                &second_key,
            ))
            .await
            .unwrap();
        cache
            .lease(
                "main".to_owned(),
                Some(Uuid::new_v4().to_string()),
                first_key.clone(),
            )
            .await
            .unwrap();

        let report = cache.enforce_test_budget(8).await.unwrap();
        assert_eq!(report.evicted_artifacts, 1);
        assert!(first.exists());
        assert!(!second.exists());
        assert!(!report.pinned_pressure);
        let pinned = cache.enforce_test_budget(0).await.unwrap();
        assert!(pinned.pinned_pressure);
        assert_eq!(pinned.remaining_bytes, 8);
        cache.release_owner("main".to_owned()).await.unwrap();
        let released = cache.enforce_test_budget(0).await.unwrap();
        assert!(!released.pinned_pressure);
        assert!(!first.exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn missing_catalog_files_become_cache_misses_without_identity_changes() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "b".repeat(64);
        let artifact = create_artifact(root.path(), CacheArtifactKind::ThumbnailTile, &key, 12);
        cache
            .register(registration(
                artifact.clone(),
                CacheArtifactKind::ThumbnailTile,
                &key,
            ))
            .await
            .unwrap();
        fs::remove_file(artifact).unwrap();
        let status = cache.status().await.unwrap();
        assert_eq!(status.managed_bytes, 0);
        assert_eq!(status.artifact_count, 0);
        let connection = cache.state.open_connection().unwrap();
        let availability: String = connection
            .query_row(
                "SELECT availability FROM cache_artifacts WHERE artifact_key = ?1",
                [&key],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(availability, "missing");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn legacy_inventory_and_clear_skip_links_and_never_run_automatically() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let legacy = root.path().join("cache").join(LEGACY_CACHE_NAMESPACE);
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("preview.bin"), b"legacy").unwrap();
        let active_preview = legacy
            .join(ACTIVE_RENDER_PREVIEW_DIRECTORY)
            .join("render-job")
            .join("preview.mp4");
        fs::create_dir_all(active_preview.parent().unwrap()).unwrap();
        fs::write(&active_preview, b"active-preview").unwrap();
        let before = cache.status().await.unwrap();
        assert_eq!(before.legacy_bytes, 6);
        assert!(legacy.join("preview.bin").exists());
        let report = cache.clear_legacy().await.unwrap();
        assert_eq!(report.cleared_bytes, 6);
        assert!(!legacy.join("preview.bin").exists());
        assert!(active_preview.exists());
        assert_eq!(cache.status().await.unwrap().legacy_bytes, 0);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn safe_inventory_rebuilds_catalog_and_stale_partials_are_removed() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "ab".repeat(32);
        let artifact = create_artifact(root.path(), CacheArtifactKind::Proxy, &key, 14);
        let partial = artifact
            .parent()
            .unwrap()
            .join(format!(".derive-{key}-ABC123.part.mp4"));
        fs::write(&partial, b"partial").unwrap();

        assert_eq!(cache.rebuild_owned_inventory().await.unwrap(), 1);
        assert_eq!(cache.status().await.unwrap().managed_bytes, 14);
        assert_eq!(cache.cleanup_stale_builds(Duration::ZERO).await.unwrap(), 1);
        assert!(!partial.exists());
        assert!(artifact.exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_cleanup_skips_held_artifact_lock_then_removes_after_release() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "ab".repeat(32);
        let cache_root = root.path().join("cache");
        let guard = acquire_artifact(&cache_root, ArtifactStoreKind::Proxy, &key)
            .await
            .unwrap();
        let partial = guard
            .path()
            .parent()
            .unwrap()
            .join(format!(".derive-{key}-ABC123.part.mp4"));
        fs::write(&partial, b"active-build").unwrap();
        OpenOptions::new()
            .write(true)
            .open(&partial)
            .unwrap()
            .set_modified(UNIX_EPOCH)
            .unwrap();

        let removed_while_locked = tokio::time::timeout(
            Duration::from_secs(1),
            cache.cleanup_stale_builds(Duration::from_secs(60)),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(removed_while_locked, 0);
        assert!(partial.exists());

        drop(guard);
        assert_eq!(
            cache
                .cleanup_stale_builds(Duration::from_secs(60))
                .await
                .unwrap(),
            1
        );
        assert!(!partial.exists());
    }

    #[cfg(any(unix, windows))]
    #[tokio::test(flavor = "current_thread")]
    async fn stale_cleanup_rejects_redirected_lock_prefix_without_touching_outside() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "ab".to_owned() + &"1".repeat(62);
        let artifact = create_artifact(root.path(), CacheArtifactKind::Proxy, &key, 1);
        let partial = artifact
            .parent()
            .unwrap()
            .join(format!(".derive-{key}-ABC123.part.mp4"));
        fs::write(&partial, b"stale-build").unwrap();

        let managed = root.path().join("cache").join(MEDIA_STORE_NAMESPACE);
        let lock_prefix = managed.join("locks").join("proxy").join(&key[..2]);
        fs::remove_file(lock_prefix.join(format!("{key}.lock"))).unwrap();
        fs::remove_dir(&lock_prefix).unwrap();

        let outside = root.path().join("outside-lock-target");
        fs::create_dir(&outside).unwrap();
        let sentinel = outside.join("sentinel.bin");
        fs::write(&sentinel, b"outside-must-stay-unchanged").unwrap();

        create_directory_redirect(&outside, &lock_prefix)
            .expect("redirected lock-prefix setup must succeed");
        let redirect_metadata = fs::symlink_metadata(&lock_prefix).unwrap();
        assert!(
            is_reparse_or_symlink(&redirect_metadata),
            "lock-prefix redirect must be a symlink or reparse point"
        );

        let outside_entries_before = fs::read_dir(&outside)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        let error = cache
            .cleanup_stale_builds(Duration::ZERO)
            .await
            .expect_err("a redirected lock-prefix directory must fail closed");

        assert!(matches!(error, MediaStateStoreError::UnsafeDirectory));
        assert!(partial.exists(), "cleanup must preserve the stale build");
        assert_eq!(fs::read(&sentinel).unwrap(), b"outside-must-stay-unchanged");
        let outside_entries_after = fs::read_dir(&outside)
            .unwrap()
            .map(|entry| entry.unwrap().file_name())
            .collect::<Vec<_>>();
        assert_eq!(outside_entries_after, outside_entries_before);
        assert!(!outside.join(format!("{key}.lock")).exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn stale_cleanup_leaves_malformed_and_unrelated_files_untouched() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = "ab".repeat(32);
        let other_key = "cd".repeat(32);
        let artifact = create_artifact(root.path(), CacheArtifactKind::Proxy, &key, 1);
        let directory = artifact.parent().unwrap();
        let malformed_key = directory.join(".derive-short-ABC123.part.mp4");
        let malformed_random = directory.join(format!(".derive-{key}-short.part.mp4"));
        let wrong_prefix = directory.join(format!(".derive-{other_key}-ABC123.part.mp4"));
        let unrelated = directory.join("notes.part.mp4");
        for path in [&malformed_key, &malformed_random, &wrong_prefix, &unrelated] {
            fs::write(path, b"keep").unwrap();
        }

        assert_eq!(cache.cleanup_stale_builds(Duration::ZERO).await.unwrap(), 0);
        assert!(malformed_key.exists());
        assert!(malformed_random.exists());
        assert!(wrong_prefix.exists());
        assert!(unrelated.exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn malicious_registration_path_fails_closed() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let unrelated = root.path().join("unrelated.bin");
        fs::write(&unrelated, b"keep").unwrap();
        let key = "c".repeat(64);
        assert!(cache
            .register(registration(
                unrelated.clone(),
                CacheArtifactKind::Proxy,
                &key
            ))
            .await
            .is_err());
        assert_eq!(fs::read(unrelated).unwrap(), b"keep");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn transcript_paths_inventory_cleanup_and_eviction_are_supported() {
        let root = tempfile::tempdir().unwrap();
        let (_store, cache) = service(root.path()).await;
        let key = format!("ef{}", "1".repeat(62));
        assert_eq!(
            CacheArtifactKind::Transcript.relative_path(&key).unwrap(),
            PathBuf::from("derived")
                .join("transcript")
                .join("ef")
                .join(format!("{key}.json"))
        );
        assert_eq!(
            CacheArtifactKind::Transcript
                .lock_relative_path(&key)
                .unwrap(),
            PathBuf::from("locks")
                .join("transcript")
                .join("ef")
                .join(format!("{key}.lock"))
        );
        assert_eq!(
            parse_kind("transcript").unwrap(),
            CacheArtifactKind::Transcript
        );

        let cache_root = root.path().join("cache");
        let guard = acquire_artifact(&cache_root, ArtifactStoreKind::Transcript, &key)
            .await
            .unwrap();
        let destination = guard.path().to_owned();
        let temporary = guard.temporary().unwrap();
        fs::write(temporary.path(), br#"{"segments":[]}"#).unwrap();
        guard.promote(temporary).unwrap();
        drop(guard);
        assert!(destination.ends_with(format!("{key}.json")));

        let partial = destination
            .parent()
            .unwrap()
            .join(format!(".derive-{key}-ABC123.part.json"));
        fs::write(&partial, b"partial").unwrap();
        assert_eq!(cache.cleanup_stale_builds(Duration::ZERO).await.unwrap(), 1);
        assert!(!partial.exists());
        assert_eq!(cache.rebuild_owned_inventory().await.unwrap(), 1);
        assert_eq!(cache.status().await.unwrap().artifact_count, 1);

        let report = cache.enforce_test_budget(0).await.unwrap();
        assert_eq!(report.evicted_artifacts, 1);
        assert!(!destination.exists());

        let transcript_error =
            acquire_artifact(&cache_root, ArtifactStoreKind::Transcript, "invalid")
                .await
                .unwrap_err();
        assert_eq!(transcript_error.details["operation"], "transcribe_asset");
        let proxy_error = acquire_artifact(&cache_root, ArtifactStoreKind::Proxy, "invalid")
            .await
            .unwrap_err();
        assert_eq!(proxy_error.details["operation"], "prepare_asset");
    }
}
