use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};

use fs4::{FileExt, TryLockError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::{Builder as TempFileBuilder, NamedTempFile};

use super::{
    error::VideoCommandError,
    grants::{GrantCategory, VideoPathGrants},
    types::{MediaContentAlgorithm, MediaContentIdentityV1},
};

pub(crate) const MEDIA_STORE_NAMESPACE: &str = "supa-video-media-v1";
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const OBJECT_LOCK_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const OBJECT_LOCK_RETRY: Duration = Duration::from_millis(50);

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SourceFacts {
    byte_length: u64,
    modified_unix_seconds: u64,
    modified_nanoseconds: u32,
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

fn invalid(category: &'static str) -> VideoCommandError {
    VideoCommandError::invalid_media("ingest_source", category)
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

fn canonical_owned_root(app_cache_root: &Path) -> Result<PathBuf, VideoCommandError> {
    fs::create_dir_all(app_cache_root).map_err(|_| invalid("cache_root"))?;
    let metadata = fs::symlink_metadata(app_cache_root).map_err(|_| invalid("cache_root"))?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(invalid("cache_root"));
    }
    app_cache_root
        .canonicalize()
        .map_err(|_| invalid("cache_root"))
}

fn ensure_direct_directory(parent: &Path, component: &str) -> Result<PathBuf, VideoCommandError> {
    if !direct_component(component) {
        return Err(invalid("store_component"));
    }
    let canonical_parent = parent
        .canonicalize()
        .map_err(|_| invalid("store_containment"))?;
    let child = canonical_parent.join(component);
    match fs::symlink_metadata(&child) {
        Ok(metadata) => {
            if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
                return Err(invalid("store_component"));
            }
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            fs::create_dir(&child).map_err(|_| invalid("store_component"))?;
        }
        Err(_) => return Err(invalid("store_component")),
    }
    let canonical_child = child
        .canonicalize()
        .map_err(|_| invalid("store_containment"))?;
    if canonical_child.parent() != Some(canonical_parent.as_path()) {
        return Err(invalid("store_containment"));
    }
    let metadata =
        fs::symlink_metadata(&canonical_child).map_err(|_| invalid("store_component"))?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(invalid("store_component"));
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

fn lock_file(path: &Path, timeout: Duration) -> Result<StoreLock, VideoCommandError> {
    if let Ok(metadata) = fs::symlink_metadata(path) {
        if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
            return Err(invalid("lock_file"));
        }
    }
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|_| invalid("lock_file"))?;
    let started = Instant::now();
    loop {
        match <File as FileExt>::try_lock(&file) {
            Ok(()) => return Ok(StoreLock { file }),
            Err(TryLockError::WouldBlock) if started.elapsed() < timeout => {
                thread::sleep(OBJECT_LOCK_RETRY);
            }
            Err(TryLockError::WouldBlock) => return Err(invalid("lock_timeout")),
            Err(TryLockError::Error(_)) => return Err(invalid("lock_file")),
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

fn ingest_blocking_with_failpoint(
    canonical_source: PathBuf,
    app_cache_root: PathBuf,
    failpoint: IngestFailpoint,
) -> Result<IngestedSource, VideoCommandError> {
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

    let cache_root = canonical_owned_root(&app_cache_root)?;
    let store_root = ensure_direct_directory(&cache_root, MEDIA_STORE_NAMESPACE)?;
    let objects = ensure_direct_directory(&store_root, "objects")?;
    let sha256 = ensure_direct_directory(&objects, "sha256")?;
    let locks = ensure_direct_directory(&store_root, "locks")?;
    let object_locks = ensure_direct_directory(&locks, "object")?;
    let prefix = digest.get(..2).ok_or_else(|| invalid("digest"))?;
    let object_directory = ensure_direct_directory(&sha256, prefix)?;
    let lock_directory = ensure_direct_directory(&object_locks, prefix)?;
    let object_path = object_directory.join(format!("{digest}.blob"));
    let lock_path = lock_directory.join(format!("{digest}.lock"));
    let _lock = lock_file(&lock_path, OBJECT_LOCK_TIMEOUT)?;

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
        if object_path.exists() {
            let metadata =
                fs::symlink_metadata(&object_path).map_err(|_| invalid("object_repair"))?;
            if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
                return Err(invalid("object_repair"));
            }
            fs::remove_file(&object_path).map_err(|_| invalid("object_repair"))?;
        }
        if failpoint == IngestFailpoint::Promotion {
            return Err(invalid("object_promotion"));
        }
        temporary
            .persist(&object_path)
            .map_err(|_| invalid("object_promotion"))?;
        if !validate_object(&object_path, &digest, pre_read.byte_length) {
            let _ = fs::remove_file(&object_path);
            return Err(invalid("object_validation"));
        }
    }

    Ok(IngestedSource {
        object_path,
        identity: MediaContentIdentityV1 {
            schema_version: 1,
            algorithm: MediaContentAlgorithm::Sha256,
            digest,
            byte_length: pre_read.byte_length,
        },
        fingerprint,
    })
}

fn ingest_blocking(
    canonical_source: PathBuf,
    app_cache_root: PathBuf,
) -> Result<IngestedSource, VideoCommandError> {
    ingest_blocking_with_failpoint(canonical_source, app_cache_root, IngestFailpoint::None)
}

pub(crate) async fn ingest_source(
    owner_label: &str,
    grants: &VideoPathGrants,
    requested_source: &Path,
    app_cache_root: &Path,
) -> Result<IngestedSource, VideoCommandError> {
    // Authorization deliberately precedes metadata, store creation, hashing, or process work.
    let canonical_source =
        grants.authorize(owner_label, GrantCategory::Source, requested_source)?;
    let app_cache_root = app_cache_root.to_owned();
    tauri::async_runtime::spawn_blocking(move || ingest_blocking(canonical_source, app_cache_root))
        .await
        .map_err(|_| invalid("worker"))?
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArtifactStoreKind {
    Proxy,
    ThumbnailTile,
}

impl ArtifactStoreKind {
    fn component(self) -> &'static str {
        match self {
            Self::Proxy => "proxy",
            Self::ThumbnailTile => "thumbnail_tile",
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Proxy => "mp4",
            Self::ThumbnailTile => "jpg",
        }
    }
}

#[derive(Debug)]
pub(crate) struct ArtifactLease {
    destination: PathBuf,
    directory: PathBuf,
    kind: ArtifactStoreKind,
    _lock: StoreLock,
}

impl ArtifactLease {
    pub(crate) fn path(&self) -> &Path {
        &self.destination
    }

    pub(crate) fn temporary(&self) -> Result<NamedTempFile, VideoCommandError> {
        TempFileBuilder::new()
            .prefix(".derive-")
            .suffix(&format!(".part.{}", self.kind.extension()))
            .tempfile_in(&self.directory)
            .map_err(|_| artifact_invalid("temporary_file"))
    }

    pub(crate) fn promote(&self, temporary: NamedTempFile) -> Result<(), VideoCommandError> {
        let temporary_path = temporary.path();
        if temporary_path.parent() != Some(self.directory.as_path()) {
            return Err(artifact_invalid("temporary_containment"));
        }
        if self.destination.exists() {
            let metadata = fs::symlink_metadata(&self.destination)
                .map_err(|_| artifact_invalid("artifact_repair"))?;
            if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
                return Err(artifact_invalid("artifact_repair"));
            }
            fs::remove_file(&self.destination).map_err(|_| artifact_invalid("artifact_repair"))?;
        }
        temporary
            .persist(&self.destination)
            .map_err(|_| artifact_invalid("artifact_promotion"))?;
        Ok(())
    }

    pub(crate) fn remove_exact(&self) -> Result<(), VideoCommandError> {
        match fs::symlink_metadata(&self.destination) {
            Ok(metadata) if metadata.is_file() && !is_reparse_or_symlink(&metadata) => {
                fs::remove_file(&self.destination).map_err(|_| artifact_invalid("artifact_repair"))
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
            _ => Err(artifact_invalid("artifact_repair")),
        }
    }
}

fn artifact_invalid(category: &'static str) -> VideoCommandError {
    VideoCommandError::invalid_media("prepare_asset", category)
}

fn valid_key(key: &str) -> bool {
    key.len() == 64
        && key
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn acquire_artifact_blocking(
    app_cache_root: PathBuf,
    kind: ArtifactStoreKind,
    key: String,
) -> Result<ArtifactLease, VideoCommandError> {
    if !valid_key(&key) {
        return Err(artifact_invalid("artifact_key"));
    }
    let cache_root = canonical_owned_root(&app_cache_root)?;
    let store_root = ensure_direct_directory(&cache_root, MEDIA_STORE_NAMESPACE)?;
    let derived = ensure_direct_directory(&store_root, "derived")?;
    let artifact_kind = ensure_direct_directory(&derived, kind.component())?;
    let locks = ensure_direct_directory(&store_root, "locks")?;
    let lock_kind = ensure_direct_directory(&locks, kind.component())?;
    let prefix = key
        .get(..2)
        .ok_or_else(|| artifact_invalid("artifact_key"))?;
    let directory = ensure_direct_directory(&artifact_kind, prefix)?;
    let lock_directory = ensure_direct_directory(&lock_kind, prefix)?;
    let destination = directory.join(format!("{key}.{}", kind.extension()));
    let lock_path = lock_directory.join(format!("{key}.lock"));
    let lock = lock_file(&lock_path, OBJECT_LOCK_TIMEOUT)?;
    Ok(ArtifactLease {
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
) -> Result<ArtifactLease, VideoCommandError> {
    let app_cache_root = app_cache_root.to_owned();
    let key = key.to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        acquire_artifact_blocking(app_cache_root, kind, key)
    })
    .await
    .map_err(|_| artifact_invalid("worker"))?
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
    ingest_blocking_with_failpoint(canonical_source, app_cache_root, failpoint)
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
    lock_file(path, timeout)
}

#[cfg(test)]
pub(crate) fn ensure_direct_directory_for_test(
    parent: &Path,
    component: &str,
) -> Result<PathBuf, VideoCommandError> {
    ensure_direct_directory(parent, component)
}
