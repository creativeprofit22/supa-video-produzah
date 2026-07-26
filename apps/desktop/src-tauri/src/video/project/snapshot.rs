use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

use tempfile::NamedTempFile;

use super::{integrity::validate_snapshot, journal::sidecar_path, types::VideoProjectSnapshotV2};
use crate::video::error::{VideoCommandError, VideoErrorCode};

pub const MAX_SNAPSHOT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CheckpointFailpoint {
    None,
    BeforeTempSync,
    AfterTempSyncBeforeReplace,
    AfterReplace,
}

fn error(category: &'static str) -> VideoCommandError {
    VideoCommandError::project_error(
        VideoErrorCode::ProjectIo,
        "Project snapshot operation failed",
        "project_snapshot",
        category,
    )
}

pub fn previous_snapshot_path(project_path: &Path) -> Result<PathBuf, VideoCommandError> {
    Ok(sidecar_path(project_path)?.join("snapshot.previous.svpvideo"))
}

pub fn read_snapshot(path: &Path) -> Result<VideoProjectSnapshotV2, VideoCommandError> {
    let metadata = fs::metadata(path).map_err(|_| error("metadata"))?;
    if !metadata.is_file() {
        return Err(error("not_file"));
    }
    if metadata.len() > MAX_SNAPSHOT_BYTES {
        return Err(VideoCommandError::project_error(
            VideoErrorCode::StorageLimit,
            "Project snapshot exceeds 16 MiB",
            "project_snapshot",
            "snapshot_bytes",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .and_then(|file| file.take(MAX_SNAPSHOT_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|_| error("read"))?;
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(error("snapshot_bytes"));
    }
    let snapshot: VideoProjectSnapshotV2 = serde_json::from_slice(&bytes).map_err(|_| {
        VideoCommandError::project_error(
            VideoErrorCode::InvalidProject,
            "Project snapshot failed strict V2 parsing",
            "project_snapshot",
            "schema",
        )
    })?;
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn snapshot_bytes(snapshot: &VideoProjectSnapshotV2) -> Result<Vec<u8>, VideoCommandError> {
    validate_snapshot(snapshot)?;
    let mut bytes = serde_json::to_vec_pretty(snapshot).map_err(|_| error("serialize"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_SNAPSHOT_BYTES {
        return Err(error("snapshot_bytes"));
    }
    Ok(bytes)
}

fn synced_temp(
    directory: &Path,
    bytes: &[u8],
    failpoint: CheckpointFailpoint,
) -> Result<NamedTempFile, VideoCommandError> {
    let mut temporary = NamedTempFile::new_in(directory).map_err(|_| error("create_temp"))?;
    temporary
        .write_all(bytes)
        .and_then(|()| temporary.flush())
        .map_err(|_| error("write_temp"))?;
    if failpoint == CheckpointFailpoint::BeforeTempSync {
        return Err(error("failpoint_before_temp_sync"));
    }
    temporary
        .as_file()
        .sync_all()
        .map_err(|_| error("sync_temp"))?;
    Ok(temporary)
}

pub fn checkpoint(
    project_path: &Path,
    snapshot: &VideoProjectSnapshotV2,
) -> Result<(), VideoCommandError> {
    checkpoint_with_failpoint(project_path, snapshot, CheckpointFailpoint::None)
}

pub fn checkpoint_with_failpoint(
    project_path: &Path,
    snapshot: &VideoProjectSnapshotV2,
    failpoint: CheckpointFailpoint,
) -> Result<(), VideoCommandError> {
    let bytes = snapshot_bytes(snapshot)?;
    let directory = project_path
        .parent()
        .ok_or_else(|| error("project_parent"))?;
    fs::create_dir_all(sidecar_path(project_path)?).map_err(|_| error("create_sidecar"))?;
    let temporary = synced_temp(directory, &bytes, failpoint)?;
    if failpoint == CheckpointFailpoint::AfterTempSyncBeforeReplace {
        return Err(error("failpoint_after_temp_sync"));
    }

    if project_path.exists() {
        let previous_path = previous_snapshot_path(project_path)?;
        let previous_bytes = fs::read(project_path).map_err(|_| error("read_previous"))?;
        let previous_temp = synced_temp(
            previous_path.parent().unwrap(),
            &previous_bytes,
            CheckpointFailpoint::None,
        )?;
        previous_temp
            .persist(&previous_path)
            .map_err(|_| error("promote_previous"))?;
    }
    temporary
        .persist(project_path)
        .map_err(|_| error("promote_main"))?;
    sync_parent(directory)?;
    if failpoint == CheckpointFailpoint::AfterReplace {
        return Err(error("failpoint_after_replace"));
    }
    Ok(())
}

pub(crate) fn restore_file_bytes(
    path: &Path,
    original_bytes: Option<&[u8]>,
) -> Result<(), VideoCommandError> {
    match original_bytes {
        Some(bytes) => {
            if fs::read(path).ok().as_deref() == Some(bytes) {
                return Ok(());
            }
            let directory = path.parent().ok_or_else(|| error("restore_parent"))?;
            let temporary = synced_temp(directory, bytes, CheckpointFailpoint::None)?;
            temporary
                .persist(path)
                .map_err(|_| error("restore_promote"))?;
            sync_parent(directory)
        }
        None => match fs::remove_file(path) {
            Ok(()) => {
                let directory = path.parent().ok_or_else(|| error("restore_parent"))?;
                sync_parent(directory)
            }
            Err(source) if source.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(error("restore_remove")),
        },
    }
}

#[cfg(unix)]
fn sync_parent(directory: &Path) -> Result<(), VideoCommandError> {
    File::open(directory)
        .and_then(|file| file.sync_all())
        .map_err(|_| error("sync_parent"))
}

#[cfg(not(unix))]
fn sync_parent(_directory: &Path) -> Result<(), VideoCommandError> {
    Ok(())
}
