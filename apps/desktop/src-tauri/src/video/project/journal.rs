use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use fs4::{FileExt, TryLockError};
use serde::Serialize;

use super::{
    hash::{canonical_bytes, canonical_hash},
    types::{JournalHeader, JournalRecord},
};
use crate::video::error::{VideoCommandError, VideoErrorCode};

pub const MAX_JOURNAL_BYTES: u64 = 64 * 1024 * 1024;
pub const MAX_JOURNAL_LINE_BYTES: usize = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailClassification {
    Clean,
    Torn,
    Corrupt,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AppendFailpoint {
    None,
    BeforeAppend,
    AfterPartialAppend,
    AfterAppendBeforeSync,
    AfterSync,
}

#[derive(Debug)]
pub struct JournalScan {
    pub header: JournalHeader,
    pub records: Vec<JournalRecord>,
    pub valid_prefix_len: usize,
    pub discarded_tail_bytes: usize,
    pub tail: TailClassification,
}

fn error(code: VideoErrorCode, category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        code,
        "Project journal operation failed",
        "project_journal",
        category,
    )
}

pub fn sidecar_path(project_path: &Path) -> Result<PathBuf, VideoCommandError> {
    let file_name = project_path
        .file_name()
        .ok_or_else(|| error(VideoErrorCode::InvalidPath, "project_name"))?;
    let mut name = file_name.to_os_string();
    name.push(".data");
    Ok(project_path.with_file_name(name))
}

pub fn journal_path(project_path: &Path) -> Result<PathBuf, VideoCommandError> {
    Ok(sidecar_path(project_path)?.join("journal.ndjson"))
}

pub fn acquire_project_lock(project_path: &Path) -> Result<File, VideoCommandError> {
    let sidecar = sidecar_path(project_path)?;
    fs::create_dir_all(&sidecar).map_err(|_| error(VideoErrorCode::ProjectIo, "create_sidecar"))?;
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(sidecar.join("project.lock"))
        .map_err(|_| error(VideoErrorCode::ProjectIo, "open_lock"))?;
    match FileExt::try_lock(&file) {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(error(VideoErrorCode::ProjectInUse, "lock_contended")),
        Err(TryLockError::Error(_)) => Err(error(VideoErrorCode::ProjectIo, "lock")),
    }
}

fn with_header_hash(header: &JournalHeader) -> Result<JournalHeader, VideoCommandError> {
    let mut candidate = header.clone();
    candidate.header_hash.clear();
    candidate.header_hash = canonical_hash(&candidate)?;
    Ok(candidate)
}

pub fn with_record_hash(record: &JournalRecord) -> Result<JournalRecord, VideoCommandError> {
    let mut candidate = record.clone();
    candidate.record_hash.clear();
    candidate.record_hash = canonical_hash(&candidate)?;
    Ok(candidate)
}

fn line_bytes<T: Serialize>(value: &T) -> Result<Vec<u8>, VideoCommandError> {
    let mut bytes = canonical_bytes(value)?;
    if bytes.len() > MAX_JOURNAL_LINE_BYTES {
        return Err(error(VideoErrorCode::StorageLimit, "line_bytes"));
    }
    bytes.push(b'\n');
    Ok(bytes)
}

pub fn initialize_journal(
    path: &Path,
    header: &JournalHeader,
) -> Result<JournalHeader, VideoCommandError> {
    let header = with_header_hash(header)?;
    let bytes = line_bytes(&header)?;
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|_| error(VideoErrorCode::ProjectIo, "create_journal"))?;
    file.write_all(&bytes)
        .map_err(|_| error(VideoErrorCode::ProjectIo, "write_header"))?;
    file.flush()
        .map_err(|_| error(VideoErrorCode::ProjectIo, "flush_header"))?;
    file.sync_all()
        .map_err(|_| error(VideoErrorCode::ProjectIo, "sync_header"))?;
    Ok(header)
}

pub fn append_and_sync(
    path: &Path,
    record: &JournalRecord,
) -> Result<JournalRecord, VideoCommandError> {
    append_with_failpoint(path, record, AppendFailpoint::None)
}

pub fn append_with_failpoint(
    path: &Path,
    record: &JournalRecord,
    failpoint: AppendFailpoint,
) -> Result<JournalRecord, VideoCommandError> {
    let record = with_record_hash(record)?;
    let bytes = line_bytes(&record)?;
    let current = fs::metadata(path)
        .map_err(|_| error(VideoErrorCode::ProjectIo, "journal_metadata"))?
        .len();
    if current.saturating_add(bytes.len() as u64) > MAX_JOURNAL_BYTES {
        return Err(error(VideoErrorCode::StorageLimit, "journal_bytes"));
    }
    if failpoint == AppendFailpoint::BeforeAppend {
        return Err(error(VideoErrorCode::ProjectIo, "failpoint_before_append"));
    }
    let mut file = OpenOptions::new()
        .append(true)
        .open(path)
        .map_err(|_| error(VideoErrorCode::ProjectIo, "open_append"))?;
    if failpoint == AppendFailpoint::AfterPartialAppend {
        file.write_all(&bytes[..bytes.len() / 2])
            .and_then(|()| file.flush())
            .map_err(|_| error(VideoErrorCode::ProjectIo, "partial_append"))?;
        return Err(error(VideoErrorCode::ProjectIo, "failpoint_partial_append"));
    }
    file.write_all(&bytes)
        .map_err(|_| error(VideoErrorCode::ProjectIo, "append"))?;
    file.flush()
        .map_err(|_| error(VideoErrorCode::ProjectIo, "flush"))?;
    if failpoint == AppendFailpoint::AfterAppendBeforeSync {
        return Err(error(VideoErrorCode::ProjectIo, "failpoint_before_sync"));
    }
    file.sync_all()
        .map_err(|_| error(VideoErrorCode::ProjectIo, "sync"))?;
    if failpoint == AppendFailpoint::AfterSync {
        return Err(error(VideoErrorCode::ProjectIo, "failpoint_after_sync"));
    }
    Ok(record)
}

pub fn scan(path: &Path) -> Result<JournalScan, VideoCommandError> {
    let metadata =
        fs::metadata(path).map_err(|_| error(VideoErrorCode::ProjectIo, "journal_metadata"))?;
    if metadata.len() > MAX_JOURNAL_BYTES {
        return Err(error(VideoErrorCode::StorageLimit, "journal_bytes"));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(MAX_JOURNAL_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| error(VideoErrorCode::ProjectIo, "read_journal"))?;
    let has_torn_tail = !bytes.ends_with(b"\n");
    let complete_len = bytes
        .iter()
        .rposition(|byte| *byte == b'\n')
        .map_or(0, |index| index + 1);
    let complete = &bytes[..complete_len];
    let mut offsets = Vec::new();
    let mut start = 0;
    for (index, byte) in complete.iter().enumerate() {
        if *byte == b'\n' {
            offsets.push((start, index));
            start = index + 1;
        }
    }
    let Some((header_start, header_end)) = offsets.first().copied() else {
        return Err(error(VideoErrorCode::InvalidProject, "missing_header"));
    };
    let header_line = complete[header_start..header_end]
        .strip_suffix(b"\r")
        .unwrap_or(&complete[header_start..header_end]);
    if header_line.len() > MAX_JOURNAL_LINE_BYTES {
        return Err(error(VideoErrorCode::StorageLimit, "line_bytes"));
    }
    let header: JournalHeader = serde_json::from_slice(header_line)
        .map_err(|_| error(VideoErrorCode::InvalidProject, "header_schema"))?;
    if header.journal_version != 1 || with_header_hash(&header)?.header_hash != header.header_hash {
        return Err(error(VideoErrorCode::InvalidProject, "header_hash"));
    }
    let mut records = Vec::new();
    let mut valid_prefix_len = header_end + 1;
    let mut previous_hash = header.header_hash.clone();
    let mut corrupt = false;
    for (expected_index, (line_start, line_end)) in offsets.iter().copied().skip(1).enumerate() {
        let line = complete[line_start..line_end]
            .strip_suffix(b"\r")
            .unwrap_or(&complete[line_start..line_end]);
        if line.len() > MAX_JOURNAL_LINE_BYTES {
            corrupt = true;
            break;
        }
        let Ok(record) = serde_json::from_slice::<JournalRecord>(line) else {
            corrupt = true;
            break;
        };
        let valid = record.record_number == expected_index as u64 + 1
            && record.previous_record_hash == previous_hash
            && with_record_hash(&record)
                .is_ok_and(|candidate| candidate.record_hash == record.record_hash);
        if !valid {
            corrupt = true;
            break;
        }
        previous_hash = record.record_hash.clone();
        valid_prefix_len = line_end + 1;
        records.push(record);
    }
    let discarded_tail_bytes = bytes.len().saturating_sub(valid_prefix_len);
    let tail = if corrupt {
        TailClassification::Corrupt
    } else if has_torn_tail {
        TailClassification::Torn
    } else {
        TailClassification::Clean
    };
    Ok(JournalScan {
        header,
        records,
        valid_prefix_len,
        discarded_tail_bytes,
        tail,
    })
}

pub fn repair_to_prefix(path: &Path, valid_prefix_len: usize) -> Result<(), VideoCommandError> {
    let bytes = fs::read(path).map_err(|_| error(VideoErrorCode::ProjectIo, "read_repair"))?;
    let prefix = bytes
        .get(..valid_prefix_len)
        .ok_or_else(|| error(VideoErrorCode::InvalidProject, "repair_prefix"))?;
    let temporary = path.with_extension("ndjson.repair");
    let mut file =
        File::create(&temporary).map_err(|_| error(VideoErrorCode::ProjectIo, "create_repair"))?;
    file.write_all(prefix)
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|_| error(VideoErrorCode::ProjectIo, "sync_repair"))?;
    fs::rename(&temporary, path).map_err(|_| error(VideoErrorCode::ProjectIo, "promote_repair"))
}
