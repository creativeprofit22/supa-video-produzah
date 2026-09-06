use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

use fs4::{FileExt, TryLockError};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::{Builder as TempFileBuilder, NamedTempFile};

use super::{
    error::VideoCommandError,
    grants::{GrantCategory, VideoPathGrants},
    types::{MediaContentAlgorithm, MediaContentIdentityV1},
};

pub(crate) const MEDIA_STORE_NAMESPACE: &str = "supa-video-media-v1";
pub(crate) const ARTIFACT_TEMPORARY_RANDOM_BYTES: usize = 6;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const OBJECT_LOCK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OBJECT_LOCK_RETRY: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFingerprintV1 {
    pub schema_version: u64,
    pub algorithm: MediaContentAlgorithm,
    pub digest: String,
    pub byte_length: u64,
    pub modified_unix_seconds: u64,
    pub modified_nanoseconds: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct IngestedSource {
    pub(crate) object_path: PathBuf,
    pub(crate) identity: MediaContentIdentityV1,
    pub(crate) fingerprint: SourceFingerprintV1,
}

/// Internal publication handoff; retain this value until registration and leasing commit.
/// The source uses the existing object StoreLock, not a derived ArtifactBuildGuard.
#[derive(Debug)]
pub(crate) struct GuardedIngestedSource {
    pub(crate) source: IngestedSource,
    _lock: StoreLock,
}

impl GuardedIngestedSource {
    /// Release publication protection only after a committed lease, or for unleased callers.
    pub(crate) fn into_source(self) -> IngestedSource {
        self.source
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SourceFacts {
    byte_length: u64,
    modified_unix_seconds: u64,
    modified_nanoseconds: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum PublicationFailpoint {
    None,
    BeforeRename,
    AfterRename,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub(crate) enum IngestFailpoint {
    None,
    Read,
    ChangedDuringRead,
    Write,
    Flush,
    Sync,
    Promotion,
    PostPromotion,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PublicationError {
    TemporaryContainment,
    DestinationContainment,
    TemporarySync,
    Promotion,
    DirectorySync,
}

#[derive(Debug)]
pub(crate) struct StoreLock {
    file: File,
}

impl Drop for StoreLock {
    fn drop(&mut self) {
        let _ = <File as FileExt>::unlock(&self.file);
    }
}

fn invalid_for(operation: &'static str, category: &'static str) -> VideoCommandError {
    VideoCommandError::invalid_media(operation, category)
}

fn invalid(category: &'static str) -> VideoCommandError {
    invalid_for("ingest_source", category)
}

fn direct_component(component: &str) -> bool {
    !component.is_empty()
        && component != "."
        && component != ".."
        && Path::new(component).components().count() == 1
        && matches!(
            Path::new(component).components().next(),
            Some(Component::Normal(_))
        )
        && !component.contains(['/', '\\', '\0'])
}

fn is_reparse_or_symlink(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn canonical_owned_root(
    app_cache_root: &Path,
    operation: &'static str,
) -> Result<PathBuf, VideoCommandError> {
    fs::create_dir_all(app_cache_root).map_err(|_| invalid_for(operation, "cache_root"))?;
    let metadata =
        fs::symlink_metadata(app_cache_root).map_err(|_| invalid_for(operation, "cache_root"))?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(invalid_for(operation, "cache_root"));
    }
    app_cache_root
        .canonicalize()
        .map_err(|_| invalid_for(operation, "cache_root"))
}

fn ensure_direct_directory(
    parent: &Path,
    component: &str,
    operation: &'static str,
) -> Result<PathBuf, VideoCommandError> {
    if !direct_component(component) {
        return Err(invalid_for(operation, "store_component"));
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| invalid_for(operation, "store_containment"))?;
    let child = canonical_parent.join(component);
    match fs::symlink_metadata(&child) {
        Ok(metadata) => {
            if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
                return Err(invalid_for(operation, "store_component"));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&child).map_err(|_| invalid_for(operation, "store_component"))?;
        }
        Err(_) => return Err(invalid_for(operation, "store_component")),
    }
    let canonical_child = child
        .canonicalize()
        .map_err(|_| invalid_for(operation, "store_containment"))?;
    if canonical_child.parent() != Some(canonical_parent.as_path()) {
        return Err(invalid_for(operation, "store_containment"));
    }
    let metadata = fs::symlink_metadata(&canonical_child)
        .map_err(|_| invalid_for(operation, "store_component"))?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(invalid_for(operation, "store_component"));
    }
    Ok(canonical_child)
}

fn source_facts(metadata: &Metadata) -> Result<SourceFacts, VideoCommandError> {
    if !metadata.is_file() || metadata.len() == 0 {
        return Err(invalid("source_file"));
    }
    let modified = metadata
        .modified()
        .map_err(|_| invalid("source_metadata"))?;
    let modified = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|_| invalid("source_metadata"))?;
    Ok(SourceFacts {
        byte_length: metadata.len(),
        modified_unix_seconds: modified.as_secs(),
        modified_nanoseconds: modified.subsec_nanos(),
    })
}

fn capture_source_facts(path: &Path) -> Result<SourceFacts, VideoCommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid("source_metadata"))?;
    if is_reparse_or_symlink(&metadata) {
        return Err(invalid("source_file"));
    }
    source_facts(&metadata)
}

fn encode_length_delimited(encoder: &mut Vec<u8>, bytes: &[u8]) -> Result<(), VideoCommandError> {
    let length = u32::try_from(bytes.len()).map_err(|_| invalid("fingerprint"))?;
    encoder.extend_from_slice(&length.to_le_bytes());
    encoder.extend_from_slice(bytes);
    Ok(())
}

fn canonical_path_bytes(path: &Path) -> Vec<u8> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    }
    #[cfg(windows)]
    {
        path.as_os_str().to_string_lossy().as_bytes().to_vec()
    }
    #[cfg(not(any(unix, windows)))]
    {
        path.as_os_str().to_string_lossy().as_bytes().to_vec()
    }
}

fn source_fingerprint_from_path_bytes(
    canonical_path_bytes: &[u8],
    facts: SourceFacts,
) -> Result<SourceFingerprintV1, VideoCommandError> {
    let mut encoded = Vec::new();
    encode_length_delimited(&mut encoded, b"supa-video/source-fingerprint/v1")?;
    encode_length_delimited(&mut encoded, canonical_path_bytes)?;
    encoded.extend_from_slice(&facts.byte_length.to_le_bytes());
    encoded.extend_from_slice(&facts.modified_unix_seconds.to_le_bytes());
    encoded.extend_from_slice(&u64::from(facts.modified_nanoseconds).to_le_bytes());
    Ok(SourceFingerprintV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest: hex_digest(Sha256::digest(encoded).as_slice()),
        byte_length: facts.byte_length,
        modified_unix_seconds: facts.modified_unix_seconds,
        modified_nanoseconds: facts.modified_nanoseconds,
    })
}

fn source_fingerprint(
    canonical_path: &Path,
    facts: SourceFacts,
) -> Result<SourceFingerprintV1, VideoCommandError> {
    source_fingerprint_from_path_bytes(&canonical_path_bytes(canonical_path), facts)
}

fn hex_digest(bytes: &[u8]) -> String {
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        use std::fmt::Write as _;
        let _ = write!(output, "{byte:02x}");
    }
    output
}

fn hash_reader(reader: &mut File) -> Result<(String, u64), VideoCommandError> {
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|_| invalid("source_read"))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        copied = copied
            .checked_add(read as u64)
            .ok_or_else(|| invalid("source_length"))?;
    }
    Ok((hex_digest(hasher.finalize().as_slice()), copied))
}

fn validate_object(path: &Path, expected_digest: &str, expected_length: u64) -> bool {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return false;
    };
    if !metadata.is_file()
        || is_reparse_or_symlink(&metadata)
        || metadata.len() == 0
        || metadata.len() != expected_length
    {
        return false;
    }
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    hash_reader(&mut file)
        .map(|(digest, length)| digest == expected_digest && length == expected_length)
        .unwrap_or(false)
}

fn open_lock_file(path: &Path, operation: &'static str) -> Result<File, VideoCommandError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
            return Err(invalid_for(operation, "lock_file"));
        }
    }
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| invalid_for(operation, "lock_file"))
}

fn try_lock_file_nonblocking(
    path: &Path,
    operation: &'static str,
) -> Result<Option<StoreLock>, VideoCommandError> {
    let file = open_lock_file(path, operation)?;
    match <File as FileExt>::try_lock(&file) {
        Ok(()) => Ok(Some(StoreLock { file })),
        Err(TryLockError::WouldBlock) => Ok(None),
        Err(TryLockError::Error(_)) => Err(invalid_for(operation, "lock_file")),
    }
}

fn lock_file(
    path: &Path,
    timeout: Duration,
    operation: &'static str,
) -> Result<StoreLock, VideoCommandError> {
    let file = open_lock_file(path, operation)?;
    let started = Instant::now();
    loop {
        match <File as FileExt>::try_lock(&file) {
            Ok(()) => return Ok(StoreLock { file }),
            Err(TryLockError::WouldBlock) if started.elapsed() < timeout => {
                thread::sleep(OBJECT_LOCK_RETRY);
            }
            Err(TryLockError::WouldBlock) => return Err(invalid_for(operation, "lock_timeout")),
            Err(TryLockError::Error(_)) => return Err(invalid_for(operation, "lock_file")),
        }
    }
}

fn copy_source_to_temporary(
    source: &mut File,
    destination_directory: &Path,
    expected_digest: &str,
    expected_length: u64,
    failpoint: IngestFailpoint,
) -> Result<tempfile::NamedTempFile, VideoCommandError> {
    source
        .seek(SeekFrom::Start(0))
        .map_err(|_| invalid("source_read"))?;
    let mut temporary = TempFileBuilder::new()
        .prefix(".ingest-")
        .suffix(".part")
        .tempfile_in(destination_directory)
        .map_err(|_| invalid("temporary_file"))?;
    let mut hasher = Sha256::new();
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    loop {
        let read = source
            .read(&mut buffer)
            .map_err(|_| invalid("source_read"))?;
        if read == 0 {
            break;
        }
        if failpoint == IngestFailpoint::Write {
            return Err(invalid("temporary_write"));
        }
        temporary
            .write_all(&buffer[..read])
            .map_err(|_| invalid("temporary_write"))?;
        hasher.update(&buffer[..read]);
        copied = copied
            .checked_add(read as u64)
            .ok_or_else(|| invalid("source_length"))?;
    }
    if failpoint == IngestFailpoint::Flush {
        return Err(invalid("temporary_flush"));
    }
    temporary.flush().map_err(|_| invalid("temporary_flush"))?;
    if failpoint == IngestFailpoint::Sync {
        return Err(invalid("temporary_sync"));
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| invalid("temporary_sync"))?;
    let copied_digest = hex_digest(hasher.finalize().as_slice());
    if copied != expected_length || copied_digest != expected_digest {
        return Err(invalid("source_changed"));
    }
    Ok(temporary)
}

fn sync_publication_directory(directory: &Path) -> Result<(), PublicationError> {
    #[cfg(unix)]
    {
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|_| PublicationError::DirectorySync)
    }
    #[cfg(any(windows, not(any(unix, windows))))]
    {
        let _ = directory;
        Ok(())
    }
}

#[cfg(windows)]
fn publish_atomic(temporary: &NamedTempFile, destination: &Path) -> io::Result<()> {
    use std::{iter, os::windows::ffi::OsStrExt};

    use windows::{
        core::PCWSTR,
        Win32::Storage::FileSystem::{
            MoveFileExW, SetFileAttributesW, FILE_ATTRIBUTE_NORMAL, MOVEFILE_REPLACE_EXISTING,
            MOVEFILE_WRITE_THROUGH,
        },
    };

    let temporary_path: Vec<u16> = temporary
        .path()
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    let destination_path: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(iter::once(0))
        .collect();
    unsafe {
        // NamedTempFile marks the path temporary. Normalize it before publication so the
        // destination has ordinary file semantics even after the temporary handle closes.
        SetFileAttributesW(PCWSTR(temporary_path.as_ptr()), FILE_ATTRIBUTE_NORMAL)
            .map_err(|error| io::Error::from_raw_os_error(error.code().0))?;
        // Windows does not document directory-handle FlushFileBuffers as a namespace barrier.
        // MOVEFILE_WRITE_THROUGH is the documented durable-move barrier, so parent sync is a no-op.
        MoveFileExW(
            PCWSTR(temporary_path.as_ptr()),
            PCWSTR(destination_path.as_ptr()),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
        .map_err(|error| io::Error::from_raw_os_error(error.code().0))
    }
}

#[cfg(not(windows))]
fn publish_atomic(temporary: &NamedTempFile, destination: &Path) -> io::Result<()> {
    fs::rename(temporary.path(), destination)
}

fn remove_failed_publication(destination: &Path, directory: &Path) {
    if fs::symlink_metadata(destination).is_ok() {
        let _ = fs::remove_file(destination);
        let _ = sync_publication_directory(directory);
    }
}

fn durable_publish(
    temporary: NamedTempFile,
    directory: &Path,
    destination: &Path,
    failpoint: PublicationFailpoint,
) -> Result<(), PublicationError> {
    if temporary.path().parent() != Some(directory) {
        return Err(PublicationError::TemporaryContainment);
    }
    if destination.parent() != Some(directory) {
        return Err(PublicationError::DestinationContainment);
    }
    let directory_metadata =
        fs::symlink_metadata(directory).map_err(|_| PublicationError::DestinationContainment)?;
    if !directory_metadata.is_dir() || is_reparse_or_symlink(&directory_metadata) {
        return Err(PublicationError::DestinationContainment);
    }
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.is_file() && !is_reparse_or_symlink(&metadata) => {}
        Ok(_) => return Err(PublicationError::DestinationContainment),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(_) => return Err(PublicationError::DestinationContainment),
    }

    temporary
        .as_file()
        .sync_all()
        .map_err(|_| PublicationError::TemporarySync)?;
    if failpoint == PublicationFailpoint::BeforeRename {
        return Err(PublicationError::Promotion);
    }
    publish_atomic(&temporary, destination).map_err(|_| PublicationError::Promotion)?;
    if failpoint == PublicationFailpoint::AfterRename {
        remove_failed_publication(destination, directory);
        return Err(PublicationError::DirectorySync);
    }
    if let Err(error) = sync_publication_directory(directory) {
        remove_failed_publication(destination, directory);
        return Err(error);
    }
    Ok(())
}

fn ingest_publication_error(error: PublicationError) -> VideoCommandError {
    invalid(match error {
        PublicationError::TemporaryContainment => "temporary_containment",
        PublicationError::DestinationContainment => "object_repair",
        PublicationError::TemporarySync => "temporary_sync",
        PublicationError::Promotion => "object_promotion",
        PublicationError::DirectorySync => "object_directory_sync",
    })
}

fn artifact_publication_error(
    kind: ArtifactStoreKind,
    error: PublicationError,
) -> VideoCommandError {
    artifact_invalid(
        kind,
        match error {
            PublicationError::TemporaryContainment => "temporary_containment",
            PublicationError::DestinationContainment => "artifact_repair",
            PublicationError::TemporarySync => "artifact_sync",
            PublicationError::Promotion => "artifact_promotion",
            PublicationError::DirectorySync => "artifact_directory_sync",
        },
    )
}

fn ingest_guarded_blocking_with_failpoint(
    canonical_source: PathBuf,
    app_cache_root: PathBuf,
    failpoint: IngestFailpoint,
) -> Result<GuardedIngestedSource, VideoCommandError> {
    let pre_read = capture_source_facts(&canonical_source)?;
    let fingerprint = source_fingerprint(&canonical_source, pre_read)?;
    if failpoint == IngestFailpoint::Read {
        return Err(invalid("source_read"));
    }
    let mut source = File::open(&canonical_source).map_err(|_| invalid("source_read"))?;
    let (digest, hashed_length) = hash_reader(&mut source)?;
    if failpoint == IngestFailpoint::ChangedDuringRead {
        let mut changed = OpenOptions::new()
            .append(true)
            .open(&canonical_source)
            .map_err(|_| invalid("source_changed"))?;
        changed
            .write_all(b"changed-during-read")
            .map_err(|_| invalid("source_changed"))?;
        changed.sync_all().map_err(|_| invalid("source_changed"))?;
    }
    if hashed_length != pre_read.byte_length || capture_source_facts(&canonical_source)? != pre_read
    {
        return Err(invalid("source_changed"));
    }

    let cache_root = canonical_owned_root(&app_cache_root, "ingest_source")?;
    let store_root = ensure_direct_directory(&cache_root, MEDIA_STORE_NAMESPACE, "ingest_source")?;
    let objects = ensure_direct_directory(&store_root, "objects", "ingest_source")?;
    let sha256 = ensure_direct_directory(&objects, "sha256", "ingest_source")?;
    let prefix = digest.get(..2).ok_or_else(|| invalid("digest"))?;
    let object_directory = ensure_direct_directory(&sha256, prefix, "ingest_source")?;
    let object_path = object_directory.join(format!("{digest}.blob"));
    let lock = acquire_source_lock_blocking(&cache_root, &digest)?;

    if !validate_object(&object_path, &digest, pre_read.byte_length) {
        let temporary = copy_source_to_temporary(
            &mut source,
            &object_directory,
            &digest,
            pre_read.byte_length,
            failpoint,
        )?;
        if capture_source_facts(&canonical_source)? != pre_read {
            return Err(invalid("source_changed"));
        }
        let publication_failpoint = match failpoint {
            IngestFailpoint::Promotion => PublicationFailpoint::BeforeRename,
            IngestFailpoint::PostPromotion => PublicationFailpoint::AfterRename,
            _ => PublicationFailpoint::None,
        };
        durable_publish(
            temporary,
            &object_directory,
            &object_path,
            publication_failpoint,
        )
        .map_err(ingest_publication_error)?;
        if !validate_object(&object_path, &digest, pre_read.byte_length) {
            remove_failed_publication(&object_path, &object_directory);
            return Err(invalid("object_validation"));
        }
    }
    // This also gates reuse of a valid orphan left by an interrupted pre-gate publisher.
    sync_publication_directory(&object_directory).map_err(ingest_publication_error)?;

    // Keep byte visibility and lifetime protection together through the caller's lease commit.
    Ok(GuardedIngestedSource {
        source: IngestedSource {
            object_path,
            identity: MediaContentIdentityV1 {
                schema_version: 1,
                algorithm: MediaContentAlgorithm::Sha256,
                digest,
                byte_length: pre_read.byte_length,
            },
            fingerprint,
        },
        _lock: lock,
    })
}

#[cfg(test)]
fn ingest_blocking(
    canonical_source: PathBuf,
    app_cache_root: PathBuf,
) -> Result<IngestedSource, VideoCommandError> {
    ingest_guarded_blocking_with_failpoint(canonical_source, app_cache_root, IngestFailpoint::None)
        .map(GuardedIngestedSource::into_source)
}

pub(crate) async fn ingest_source(
    owner_label: &str,
    grants: &VideoPathGrants,
    requested_source: &Path,
    app_cache_root: &Path,
) -> Result<IngestedSource, VideoCommandError> {
    ingest_source_guarded(owner_label, grants, requested_source, app_cache_root)
        .await
        .map(GuardedIngestedSource::into_source)
}

fn acquire_source_lock_blocking(
    cache_root: &Path,
    digest: &str,
) -> Result<StoreLock, VideoCommandError> {
    if digest.len() != 64
        || !digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid("digest"));
    }
    let cache_root = canonical_owned_root(cache_root, "ingest_source")?;
    let store_root = ensure_direct_directory(&cache_root, MEDIA_STORE_NAMESPACE, "ingest_source")?;
    let locks = ensure_direct_directory(&store_root, "locks", "ingest_source")?;
    let object_locks = ensure_direct_directory(&locks, "object", "ingest_source")?;
    let directory = ensure_direct_directory(&object_locks, &digest[..2], "ingest_source")?;
    lock_file(
        &directory.join(format!("{digest}.lock")),
        OBJECT_LOCK_TIMEOUT,
        "ingest_source",
    )
}

/// Retains the same object lock used by ingestion, without opening the source bytes.
pub(crate) async fn acquire_source_lock(
    cache_root: &Path,
    digest: &str,
) -> Result<StoreLock, VideoCommandError> {
    let cache_root = cache_root.to_owned();
    let digest = digest.to_owned();
    tauri::async_runtime::spawn_blocking(move || acquire_source_lock_blocking(&cache_root, &digest))
        .await
        .map_err(|_| invalid("worker"))?
}

/// Validate durable source bytes while retaining ingestion/eviction's object lock.
pub(crate) async fn acquire_source_object(
    cache_root: &Path,
    object_path: &Path,
    identity: &MediaContentIdentityV1,
) -> Result<StoreLock, VideoCommandError> {
    let cache_root = cache_root.to_owned();
    let object_path = object_path.to_owned();
    let identity = identity.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let lock = acquire_source_lock_blocking(&cache_root, &identity.digest)?;
        let root = canonical_owned_root(&cache_root, "ingest_source")?;
        let store = ensure_direct_directory(&root, MEDIA_STORE_NAMESPACE, "ingest_source")?;
        let objects = ensure_direct_directory(&store, "objects", "ingest_source")?;
        let sha256 = ensure_direct_directory(&objects, "sha256", "ingest_source")?;
        let directory = ensure_direct_directory(&sha256, &identity.digest[..2], "ingest_source")?;
        if object_path != directory.join(format!("{}.blob", identity.digest))
            || !validate_object(&object_path, &identity.digest, identity.byte_length)
        {
            return Err(invalid("source_object"));
        }
        Ok(lock)
    })
    .await
    .map_err(|_| invalid("worker"))?
}

pub(crate) async fn ingest_source_guarded(
    owner_label: &str,
    grants: &VideoPathGrants,
    requested_source: &Path,
    app_cache_root: &Path,
) -> Result<GuardedIngestedSource, VideoCommandError> {
    // Authorization deliberately precedes metadata, store creation, hashing, or process work.
    let canonical_source =
        grants.authorize(owner_label, GrantCategory::Source, requested_source)?;
    let app_cache_root = app_cache_root.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        ingest_guarded_blocking_with_failpoint(
            canonical_source,
            app_cache_root,
            IngestFailpoint::None,
        )
    })
    .await
    .map_err(|_| invalid("worker"))?
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArtifactStoreKind {
    Proxy,
    ThumbnailTile,
    Transcript,
}

impl ArtifactStoreKind {
    fn component(self) -> &'static str {
        match self {
            Self::Proxy => "proxy",
            Self::ThumbnailTile => "thumbnail_tile",
            Self::Transcript => "transcript",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Proxy => "mp4",
            Self::ThumbnailTile => "jpg",
            Self::Transcript => "json",
        }
    }

    fn operation(self) -> &'static str {
        match self {
            Self::Proxy | Self::ThumbnailTile => "prepare_asset",
            Self::Transcript => "transcribe_asset",
        }
    }
}

#[derive(Debug)]
pub(crate) struct ArtifactBuildGuard {
    destination: PathBuf,
    directory: PathBuf,
    kind: ArtifactStoreKind,
    _lock: StoreLock,
}

impl ArtifactBuildGuard {
    pub(crate) fn path(&self) -> &Path {
        &self.destination
    }

    pub(crate) fn temporary(&self) -> Result<NamedTempFile, VideoCommandError> {
        let key = self
            .destination
            .file_stem()
            .and_then(|value| value.to_str())
            .filter(|value| valid_key(value))
            .ok_or_else(|| artifact_invalid(self.kind, "artifact_key"))?;
        let prefix = format!(".derive-{key}-");
        let suffix = format!(".part.{}", self.kind.extension());
        for entry in fs::read_dir(&self.directory)
            .map_err(|_| artifact_invalid(self.kind, "temporary_file"))?
        {
            let entry = entry.map_err(|_| artifact_invalid(self.kind, "temporary_file"))?;
            let name = entry.file_name();
            let name = name
                .to_str()
                .ok_or_else(|| artifact_invalid(self.kind, "temporary_file"))?;
            if !name.starts_with(&prefix) || !name.ends_with(&suffix) {
                continue;
            }
            let metadata = fs::symlink_metadata(entry.path())
                .map_err(|_| artifact_invalid(self.kind, "temporary_file"))?;
            if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
                return Err(artifact_invalid(self.kind, "temporary_file"));
            }
            fs::remove_file(entry.path())
                .map_err(|_| artifact_invalid(self.kind, "temporary_file"))?;
        }
        TempFileBuilder::new()
            .prefix(&prefix)
            .suffix(&suffix)
            .rand_bytes(ARTIFACT_TEMPORARY_RANDOM_BYTES)
            .tempfile_in(&self.directory)
            .map_err(|_| artifact_invalid(self.kind, "temporary_file"))
    }

    pub(crate) fn promote(&self, temporary: NamedTempFile) -> Result<(), VideoCommandError> {
        self.promote_with_failpoint(temporary, PublicationFailpoint::None)
    }

    fn promote_with_failpoint(
        &self,
        temporary: NamedTempFile,
        failpoint: PublicationFailpoint,
    ) -> Result<(), VideoCommandError> {
        durable_publish(temporary, &self.directory, &self.destination, failpoint)
            .map_err(|error| artifact_publication_error(self.kind, error))
    }

    #[cfg(test)]
    pub(crate) fn promote_with_failpoint_for_test(
        &self,
        temporary: NamedTempFile,
        failpoint: PublicationFailpoint,
    ) -> Result<(), VideoCommandError> {
        self.promote_with_failpoint(temporary, failpoint)
    }

    pub(crate) fn confirm_durable(&self) -> Result<(), VideoCommandError> {
        sync_publication_directory(&self.directory)
            .map_err(|error| artifact_publication_error(self.kind, error))
    }

    pub(crate) fn remove_exact(&self) -> Result<(), VideoCommandError> {
        match fs::symlink_metadata(&self.destination) {
            Ok(metadata) if metadata.is_file() && !is_reparse_or_symlink(&metadata) => {
                fs::remove_file(&self.destination)
                    .map_err(|_| artifact_invalid(self.kind, "artifact_repair"))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            _ => Err(artifact_invalid(self.kind, "artifact_repair")),
        }
    }
}

fn artifact_invalid(kind: ArtifactStoreKind, category: &'static str) -> VideoCommandError {
    invalid_for(kind.operation(), category)
}

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn artifact_key_from_temporary_name<'a>(
    name: &'a str,
    extension: &str,
) -> Option<&'a str> {
    let suffix = format!(".part.{extension}");
    let body = name.strip_prefix(".derive-")?.strip_suffix(&suffix)?;
    let (key, random) = body.split_once('-')?;
    (valid_key(key)
        && random.len() == ARTIFACT_TEMPORARY_RANDOM_BYTES
        && random.bytes().all(|byte| byte.is_ascii_alphanumeric()))
    .then_some(key)
}

fn artifact_directories(
    app_cache_root: &Path,
    kind: ArtifactStoreKind,
    key: &str,
) -> Result<(PathBuf, PathBuf), VideoCommandError> {
    let operation = kind.operation();
    if !valid_key(key) {
        return Err(artifact_invalid(kind, "artifact_key"));
    }
    let cache_root = canonical_owned_root(app_cache_root, operation)?;
    let store_root = ensure_direct_directory(&cache_root, MEDIA_STORE_NAMESPACE, operation)?;
    let derived = ensure_direct_directory(&store_root, "derived", operation)?;
    let artifact_kind = ensure_direct_directory(&derived, kind.component(), operation)?;
    let locks = ensure_direct_directory(&store_root, "locks", operation)?;
    let lock_kind = ensure_direct_directory(&locks, kind.component(), operation)?;
    let prefix = key
        .get(..2)
        .ok_or_else(|| artifact_invalid(kind, "artifact_key"))?;
    let directory = ensure_direct_directory(&artifact_kind, prefix, operation)?;
    let lock_directory = ensure_direct_directory(&lock_kind, prefix, operation)?;
    Ok((directory, lock_directory))
}

pub(crate) fn try_lock_artifact_nonblocking(
    app_cache_root: &Path,
    kind: ArtifactStoreKind,
    key: &str,
) -> Result<Option<StoreLock>, VideoCommandError> {
    let (_, lock_directory) = artifact_directories(app_cache_root, kind, key)?;
    let lock_path = lock_directory.join(format!("{key}.lock"));
    try_lock_file_nonblocking(&lock_path, kind.operation())
}

fn acquire_artifact_blocking(
    app_cache_root: PathBuf,
    kind: ArtifactStoreKind,
    key: String,
) -> Result<ArtifactBuildGuard, VideoCommandError> {
    let (directory, lock_directory) = artifact_directories(&app_cache_root, kind, &key)?;
    let destination = directory.join(format!("{key}.{}", kind.extension()));
    let lock_path = lock_directory.join(format!("{key}.lock"));
    let lock = lock_file(&lock_path, OBJECT_LOCK_TIMEOUT, kind.operation())?;
    Ok(ArtifactBuildGuard {
        destination,
        directory,
        kind,
        _lock: lock,
    })
}

pub(crate) async fn acquire_artifact(
    app_cache_root: &Path,
    kind: ArtifactStoreKind,
    key: &str,
) -> Result<ArtifactBuildGuard, VideoCommandError> {
    let app_cache_root = app_cache_root.to_owned();
    let key = key.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        acquire_artifact_blocking(app_cache_root, kind, key)
    })
    .await
    .map_err(|_| artifact_invalid(kind, "worker"))?
}

#[cfg(test)]
pub(crate) fn ingest_blocking_for_test(
    canonical_source: PathBuf,
    app_cache_root: PathBuf,
) -> Result<IngestedSource, VideoCommandError> {
    ingest_blocking(canonical_source, app_cache_root)
}

#[cfg(test)]
pub(crate) fn ingest_with_failpoint_for_test(
    canonical_source: PathBuf,
    app_cache_root: PathBuf,
    failpoint: IngestFailpoint,
) -> Result<IngestedSource, VideoCommandError> {
    ingest_guarded_blocking_with_failpoint(canonical_source, app_cache_root, failpoint)
        .map(GuardedIngestedSource::into_source)
}

#[cfg(test)]
pub(crate) fn source_fingerprint_for_test(
    path: &Path,
    byte_length: u64,
    modified_unix_seconds: u64,
    modified_nanoseconds: u32,
) -> Result<SourceFingerprintV1, VideoCommandError> {
    source_fingerprint(
        path,
        SourceFacts {
            byte_length,
            modified_unix_seconds,
            modified_nanoseconds,
        },
    )
}

#[cfg(test)]
pub(crate) fn source_fingerprint_bytes_for_test(
    path_bytes: &[u8],
    byte_length: u64,
    modified_unix_seconds: u64,
    modified_nanoseconds: u32,
) -> Result<SourceFingerprintV1, VideoCommandError> {
    source_fingerprint_from_path_bytes(
        path_bytes,
        SourceFacts {
            byte_length,
            modified_unix_seconds,
            modified_nanoseconds,
        },
    )
}

#[cfg(test)]
pub(crate) fn lock_file_for_test(
    path: &Path,
    timeout: Duration,
) -> Result<StoreLock, VideoCommandError> {
    lock_file(path, timeout, "ingest_source")
}

#[cfg(test)]
pub(crate) fn ensure_direct_directory_for_test(
    parent: &Path,
    component: &str,
) -> Result<PathBuf, VideoCommandError> {
    ensure_direct_directory(parent, component, "ingest_source")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn guarded_ingest_retains_object_lock_for_fresh_and_reused_content() {
        let root = tempfile::tempdir().unwrap();
        let source_path = root.path().join("source.bin");
        let cache_root = root.path().join("cache");
        fs::write(&source_path, b"guarded source").unwrap();
        for _ in 0..2 {
            let guarded = ingest_guarded_blocking_with_failpoint(
                source_path.clone(),
                cache_root.clone(),
                IngestFailpoint::None,
            )
            .unwrap();
            let digest = &guarded.source.identity.digest;
            let lock_path = cache_root
                .join(MEDIA_STORE_NAMESPACE)
                .join("locks/object")
                .join(&digest[..2])
                .join(format!("{digest}.lock"));
            assert!(try_lock_file_nonblocking(&lock_path, "ingest_source")
                .unwrap()
                .is_none());
            assert_eq!(
                fs::read(&guarded.source.object_path).unwrap(),
                b"guarded source"
            );
            let source = guarded.into_source();
            assert!(try_lock_file_nonblocking(&lock_path, "ingest_source")
                .unwrap()
                .is_some());
            assert_eq!(fs::read(source.object_path).unwrap(), b"guarded source");
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn artifact_guard_removes_only_same_key_crash_partials_before_rebuild() {
        let root = tempfile::tempdir().unwrap();
        let key = "ab".repeat(32);
        let other_key = "ab".to_owned() + &"c".repeat(62);
        let guard = acquire_artifact(root.path(), ArtifactStoreKind::Proxy, &key)
            .await
            .unwrap();
        let stale = guard
            .directory
            .join(format!(".derive-{key}-stale.part.mp4"));
        let unrelated = guard
            .directory
            .join(format!(".derive-{other_key}-active.part.mp4"));
        fs::write(&stale, b"stale").unwrap();
        fs::write(&unrelated, b"active").unwrap();

        let temporary = guard.temporary().unwrap();
        assert!(!stale.exists());
        assert!(unrelated.exists());
        assert!(temporary
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with(&format!(".derive-{key}-")));
    }
}
