use std::{
    fs::{self, File, OpenOptions},
    io,
    path::{Path, PathBuf},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use fs4::{FileExt, TryLockError};
use rusqlite::{params, OptionalExtension};
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
}

impl MediaCacheService {
    pub(crate) fn new(store: &MediaJobStore, app_cache_root: PathBuf, session_id: String) -> Self {
        Self {
            state: store.state().clone(),
            app_cache_root,
            session_id,
        }
    }

    pub(crate) async fn register(
        &self,
        registration: CacheArtifactRegistration,
    ) -> Result<(), MediaStateStoreError> {
        let service = self.clone();
        tauri::async_runtime::spawn_blocking(move || service.register_sync(&registration))
            .await
            .map_err(|_| MediaStateStoreError::WorkerStopped)?
    }

    pub(crate) async fn lease(
        &self,
        owner_label: String,
        project_id: Option<String>,
        artifact_key: String,
    ) -> Result<String, MediaStateStoreError> {
        let state = self.state.clone();
        let session_id = self.session_id.clone();
        tauri::async_runtime::spawn_blocking(move || {
            validate_owner_label(&owner_label)?;
            validate_cache_key(&artifact_key)?;
            let lease_id = Uuid::new_v4().to_string();
            let connection = state.open_connection()?;
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
                    &session_id,
                    &owner_label,
                    project_id.as_deref(),
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
                    params![session_id, owner_label, project_id, artifact_key],
                    |row| row.get(0),
                )
                .map_err(MediaStateStoreError::from)
        })
        .await
        .map_err(|_| MediaStateStoreError::WorkerStopped)?
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
    async fn enforce_test_budget(
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
        let connection = self.state.open_connection()?;
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
        let managed_root = self.managed_root().ok();
        let connection = self.state.open_connection()?;
        let budget: i64 = connection.query_row(
            "SELECT integer_value FROM media_settings WHERE key = 'managed_cache_budget_bytes_v1'",
            [],
            |row| row.get(0),
        )?;
        let mut managed_bytes = 0_u64;
        let mut artifact_count = 0_u64;
        let mut statement = connection.prepare(
            "SELECT artifact_key, relative_path, byte_length FROM cache_artifacts
             WHERE availability = 'available' ORDER BY artifact_key",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        let mut missing = Vec::new();
        for row in rows {
            let (key, relative, expected_length) = row?;
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
                managed_bytes = managed_bytes
                    .checked_add(
                        u64::try_from(expected_length)
                            .map_err(|_| MediaStateStoreError::CorruptRecord)?,
                    )
                    .ok_or(MediaStateStoreError::CorruptRecord)?;
                artifact_count += 1;
            } else {
                missing.push(key);
            }
        }
        drop(statement);
        for key in missing {
            connection.execute(
                "UPDATE cache_artifacts SET availability = 'missing', updated_at_ms = ?2 WHERE artifact_key = ?1",
                params![key, now_millis()],
            )?;
        }
        let (leased_bytes, leased_artifact_count): (i64, i64) = connection.query_row(
            "SELECT COALESCE(SUM(byte_length), 0), COUNT(*) FROM cache_artifacts
             WHERE artifact_key IN (SELECT DISTINCT artifact_key FROM cache_leases)
               AND availability = 'available'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let leased_bytes =
            u64::try_from(leased_bytes).map_err(|_| MediaStateStoreError::CorruptRecord)?;
        let leased_artifact_count = u64::try_from(leased_artifact_count)
            .map_err(|_| MediaStateStoreError::CorruptRecord)?;
        let reclaimable_bytes = managed_bytes.saturating_sub(leased_bytes);
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
        let transaction = connection.transaction()?;
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

    fn evict_reserved_candidate(
        &self,
        candidate: &EvictionCandidate,
    ) -> Result<bool, MediaStateStoreError> {
        let root = self.managed_root()?;
        let path = safe_catalog_path(&root, &candidate.relative_path)?;
        let expected_relative = candidate.kind.relative_path(&candidate.key)?;
        if relative_path_string(&expected_relative)? != candidate.relative_path {
            self.mark_candidate(&candidate.key, "invalid")?;
            return Ok(false);
        }
        let lock_path = root.join(candidate.kind.lock_relative_path(&candidate.key)?);
        let _lock = CacheFileLock::acquire(&lock_path)?;
        let connection = self.state.open_connection()?;
        let leases: i64 = connection.query_row(
            "SELECT COUNT(*) FROM cache_leases WHERE artifact_key = ?1",
            [&candidate.key],
            |row| row.get(0),
        )?;
        let availability: Option<String> = connection
            .query_row(
                "SELECT availability FROM cache_artifacts WHERE artifact_key = ?1",
                [&candidate.key],
                |row| row.get(0),
            )
            .optional()?;
        if leases != 0 || availability.as_deref() != Some("reserved") {
            self.mark_candidate(&candidate.key, "available")?;
            return Ok(false);
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_file() && !is_reparse_or_symlink(&metadata) => {
                fs::remove_file(&path)?;
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            _ => {
                self.mark_candidate(&candidate.key, "invalid")?;
                return Ok(false);
            }
        }
        connection.execute(
            "DELETE FROM cache_artifacts WHERE artifact_key = ?1 AND availability = 'reserved'",
            [&candidate.key],
        )?;
        Ok(true)
    }

    fn mark_candidate(&self, key: &str, availability: &str) -> Result<(), MediaStateStoreError> {
        let connection = self.state.open_connection()?;
        connection.execute(
            "UPDATE cache_artifacts SET availability = ?2, updated_at_ms = ?3 WHERE artifact_key = ?1",
            params![key, availability, now_millis()],
        )?;
        Ok(())
    }
}

#[derive(Debug)]
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
