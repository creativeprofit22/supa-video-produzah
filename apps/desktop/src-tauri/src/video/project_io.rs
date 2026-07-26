use std::{
    fs::{self, File},
    io::{self, Read, Write},
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{Runtime, State, WebviewWindow};
use tauri_plugin_dialog::{DialogExt, FilePath};
use tempfile::NamedTempFile;

use super::{
    error::{ProjectIoError, VideoCommandError},
    grants::{normalize_existing_file, GrantCategory, VideoPathGrants},
    types::{
        is_recognizable_absolute_path, is_safe_relative_path, parse_project_json,
        parse_project_value, AssetLocator, ProjectUuid, VideoProjectFileV1,
    },
};

pub const MAX_PROJECT_BYTES: u64 = 2 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VideoSourceStatus {
    Resolved,
    Missing,
    RelinkRequired,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VideoSourceRecord {
    pub asset_id: ProjectUuid,
    pub status: VideoSourceStatus,
    pub resolved_path: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedVideoProject {
    pub path: String,
    pub document: VideoProjectFileV1,
    pub sources: Vec<VideoSourceRecord>,
}

#[derive(Debug)]
struct SourceResolution {
    record: VideoSourceRecord,
    relative_source_grant: Option<PathBuf>,
}

#[derive(Debug)]
struct SourceRegrantTarget {
    asset_id: ProjectUuid,
    expected_source_path: PathBuf,
}

pub(crate) fn open_project_from_path(
    owner_label: &str,
    selected_path: &Path,
    grants: &VideoPathGrants,
) -> Result<OpenedVideoProject, VideoCommandError> {
    let project_path =
        normalize_existing_file(selected_path, "open_project", GrantCategory::Project)?;
    require_extension(&project_path, "svpvideo", "open_project", "project")?;
    let bytes = read_project_bounded(&project_path)?;
    let document = parse_project_json(&bytes)?;
    let source_resolution = resolve_current_source(owner_label, &project_path, &document, grants)?;
    let relative_source_grant = source_resolution
        .as_ref()
        .and_then(|resolution| resolution.relative_source_grant.clone());
    grants.grant_opened_project(owner_label, project_path.clone(), relative_source_grant)?;

    Ok(OpenedVideoProject {
        path: path_to_string(&project_path, "open_project", "project")?,
        document,
        sources: source_resolution
            .map(|resolution| vec![resolution.record])
            .unwrap_or_default(),
    })
}

pub(crate) fn read_project_bounded(path: &Path) -> Result<Vec<u8>, VideoCommandError> {
    let metadata = fs::metadata(path)
        .map_err(|_| VideoCommandError::project_io("open_project", "metadata"))?;
    if !metadata.is_file() {
        return Err(VideoCommandError::invalid_path("open_project", "project"));
    }
    if metadata.len() > MAX_PROJECT_BYTES {
        return Err(VideoCommandError::phase1_limit(
            "open_project",
            "project_bytes",
        ));
    }

    let file =
        File::open(path).map_err(|_| VideoCommandError::project_io("open_project", "read"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize + 1);
    file.take(MAX_PROJECT_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| VideoCommandError::project_io("open_project", "read"))?;
    if bytes.len() as u64 > MAX_PROJECT_BYTES {
        return Err(VideoCommandError::phase1_limit(
            "open_project",
            "project_bytes",
        ));
    }
    Ok(bytes)
}

pub(crate) fn resolve_project_asset_sources(
    owner_label: &str,
    project_path: &Path,
    assets: &[super::types::VideoAsset],
    grants: &VideoPathGrants,
) -> Result<(Vec<VideoSourceRecord>, Vec<PathBuf>), VideoCommandError> {
    let mut records = Vec::with_capacity(assets.len());
    let mut relative_grants = Vec::new();
    for asset in assets {
        let resolution = resolve_source_locator(
            owner_label,
            project_path,
            asset.id.clone(),
            &asset.locator,
            grants,
        )?;
        records.push(resolution.record);
        if let Some(path) = resolution.relative_source_grant {
            relative_grants.push(path);
        }
    }
    Ok((records, relative_grants))
}

fn resolve_current_source(
    owner_label: &str,
    project_path: &Path,
    document: &VideoProjectFileV1,
    grants: &VideoPathGrants,
) -> Result<Option<SourceResolution>, VideoCommandError> {
    let current_revision = document
        .revisions
        .iter()
        .find(|revision| revision.id == document.current_revision_id)
        .ok_or_else(|| VideoCommandError::invalid_project(["current revision is missing"]))?;
    let Some(asset) = &current_revision.state.asset else {
        return Ok(None);
    };
    resolve_source_locator(
        owner_label,
        project_path,
        asset.id.clone(),
        &asset.locator,
        grants,
    )
    .map(Some)
}

pub(crate) fn ensure_canonical_source_containment(
    canonical_project_directory: &Path,
    canonical_source: &Path,
) -> Result<(), VideoCommandError> {
    if canonical_source.starts_with(canonical_project_directory) {
        Ok(())
    } else {
        Err(VideoCommandError::invalid_path(
            "resolve_source",
            "containment",
        ))
    }
}

fn resolve_source_locator(
    owner_label: &str,
    project_path: &Path,
    asset_id: ProjectUuid,
    locator: &AssetLocator,
    grants: &VideoPathGrants,
) -> Result<SourceResolution, VideoCommandError> {
    if let Some(relative_path) = &locator.relative_path {
        if !is_safe_relative_path(relative_path) {
            return Err(VideoCommandError::invalid_path(
                "resolve_source",
                "relative_locator",
            ));
        }
        let project_directory = project_path
            .parent()
            .ok_or_else(|| VideoCommandError::invalid_path("resolve_source", "project"))?;
        let joined = relative_path
            .split(['/', '\\'])
            .fold(project_directory.to_path_buf(), |path, segment| {
                path.join(segment)
            });
        match fs::metadata(&joined) {
            Ok(metadata) => {
                if !metadata.is_file() {
                    return Err(VideoCommandError::invalid_path(
                        "resolve_source",
                        "relative_locator",
                    ));
                }
                let canonical_source = fs::canonicalize(&joined)
                    .map_err(|_| VideoCommandError::project_io("resolve_source", "canonicalize"))?;
                ensure_canonical_source_containment(project_directory, &canonical_source)?;
                return Ok(SourceResolution {
                    record: VideoSourceRecord {
                        asset_id,
                        status: VideoSourceStatus::Resolved,
                        resolved_path: Some(path_to_string(
                            &canonical_source,
                            "resolve_source",
                            "source",
                        )?),
                    },
                    relative_source_grant: Some(canonical_source),
                });
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(_) => {
                return Err(VideoCommandError::project_io("resolve_source", "metadata"));
            }
        }
    }

    resolve_absolute_fallback(owner_label, asset_id, locator, grants)
}

fn resolve_absolute_fallback(
    owner_label: &str,
    asset_id: ProjectUuid,
    locator: &AssetLocator,
    grants: &VideoPathGrants,
) -> Result<SourceResolution, VideoCommandError> {
    let Some(absolute_path) = &locator.absolute_path else {
        return Ok(SourceResolution {
            record: VideoSourceRecord {
                asset_id,
                status: VideoSourceStatus::Missing,
                resolved_path: None,
            },
            relative_source_grant: None,
        });
    };
    if !is_recognizable_absolute_path(absolute_path) {
        return Err(VideoCommandError::invalid_path(
            "resolve_source",
            "absolute_locator",
        ));
    }
    let absolute_path = Path::new(absolute_path);
    let normalized =
        match normalize_existing_file(absolute_path, "resolve_source", GrantCategory::Source) {
            Ok(path) => path,
            Err(_) => {
                return Ok(SourceResolution {
                    record: VideoSourceRecord {
                        asset_id,
                        status: VideoSourceStatus::Missing,
                        resolved_path: None,
                    },
                    relative_source_grant: None,
                });
            }
        };
    if grants.is_granted_normalized(owner_label, GrantCategory::Source, &normalized)? {
        Ok(SourceResolution {
            record: VideoSourceRecord {
                asset_id,
                status: VideoSourceStatus::Resolved,
                resolved_path: Some(path_to_string(&normalized, "resolve_source", "source")?),
            },
            relative_source_grant: None,
        })
    } else {
        Ok(SourceResolution {
            record: VideoSourceRecord {
                asset_id,
                status: VideoSourceStatus::RelinkRequired,
                resolved_path: None,
            },
            relative_source_grant: None,
        })
    }
}

fn source_regrant_target(
    owner_label: &str,
    requested_project_path: &Path,
    requested_asset_id: &ProjectUuid,
    grants: &VideoPathGrants,
) -> Result<SourceRegrantTarget, VideoCommandError> {
    let project_path =
        grants.authorize(owner_label, GrantCategory::Project, requested_project_path)?;
    require_extension(
        &project_path,
        "svpvideo",
        "regrant_project_source",
        "project",
    )?;
    let document = parse_project_json(&read_project_bounded(&project_path)?)?;
    let current_revision = document
        .revisions
        .iter()
        .find(|revision| revision.id == document.current_revision_id)
        .ok_or_else(|| VideoCommandError::invalid_project(["current revision is missing"]))?;
    let asset = current_revision
        .state
        .asset
        .as_ref()
        .filter(|asset| &asset.id == requested_asset_id)
        .ok_or_else(|| VideoCommandError::invalid_path("regrant_project_source", "asset"))?;
    let absolute_path = asset
        .locator
        .absolute_path
        .as_deref()
        .filter(|path| is_recognizable_absolute_path(path))
        .ok_or_else(|| {
            VideoCommandError::invalid_path("regrant_project_source", "absolute_locator")
        })?;
    let expected_source_path = normalize_existing_file(
        Path::new(absolute_path),
        "regrant_project_source",
        GrantCategory::Source,
    )?;
    if !has_source_extension(&expected_source_path) {
        return Err(VideoCommandError::invalid_path(
            "regrant_project_source",
            "source",
        ));
    }
    Ok(SourceRegrantTarget {
        asset_id: asset.id.clone(),
        expected_source_path,
    })
}

fn grant_regrant_selection(
    owner_label: &str,
    target: SourceRegrantTarget,
    selected_source_path: &Path,
    grants: &VideoPathGrants,
) -> Result<VideoSourceRecord, VideoCommandError> {
    let selected_source_path = normalize_existing_file(
        selected_source_path,
        "regrant_project_source",
        GrantCategory::Source,
    )?;
    if selected_source_path != target.expected_source_path {
        return Err(VideoCommandError::invalid_path(
            "regrant_project_source",
            "source_mismatch",
        ));
    }
    let resolved_path =
        grants.grant_existing_file(owner_label, GrantCategory::Source, &selected_source_path)?;
    Ok(VideoSourceRecord {
        asset_id: target.asset_id,
        status: VideoSourceStatus::Resolved,
        resolved_path: Some(path_to_string(
            &resolved_path,
            "regrant_project_source",
            "source",
        )?),
    })
}

#[cfg(test)]
pub(crate) fn regrant_project_source_from_path(
    owner_label: &str,
    requested_project_path: &Path,
    requested_asset_id: &ProjectUuid,
    selected_source_path: &Path,
    grants: &VideoPathGrants,
) -> Result<VideoSourceRecord, VideoCommandError> {
    let target = source_regrant_target(
        owner_label,
        requested_project_path,
        requested_asset_id,
        grants,
    )?;
    grant_regrant_selection(owner_label, target, selected_source_path, grants)
}
pub(crate) fn require_extension(
    path: &Path,
    extension: &str,
    operation: &'static str,
    category: &'static str,
) -> Result<(), VideoCommandError> {
    let matches = path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension));
    if matches {
        Ok(())
    } else {
        Err(VideoCommandError::invalid_path(operation, category))
    }
}

fn path_to_string(
    path: &Path,
    operation: &'static str,
    category: &'static str,
) -> Result<String, VideoCommandError> {
    path.to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| VideoCommandError::invalid_path(operation, category))
}

#[tauri::command]
pub async fn video_pick_new_project_path<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    default_name: String,
) -> Result<Option<String>, VideoCommandError> {
    let default_name = sanitize_default_name(&default_name, "svpvideo", "Untitled.svpvideo")?;
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Create video project")
        .add_filter("Supa Video Project", &["svpvideo"])
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(path) = dialog_path(selection, "pick_new_project", "project")? else {
        return Ok(None);
    };
    let path = enforce_extension(path, "svpvideo")?;
    let normalized = grants.grant_destination(window.label(), GrantCategory::Project, &path)?;
    path_to_string(&normalized, "pick_new_project", "project").map(Some)
}

#[tauri::command]
pub async fn video_pick_source<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
) -> Result<Option<String>, VideoCommandError> {
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Choose source video")
        .add_filter(
            "Video",
            &["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg"],
        )
        .blocking_pick_file();
    let Some(path) = dialog_path(selection, "pick_source", "source")? else {
        return Ok(None);
    };
    if !has_source_extension(&path) {
        return Err(VideoCommandError::invalid_path("pick_source", "source"));
    }
    let normalized = grants.grant_existing_file(window.label(), GrantCategory::Source, &path)?;
    path_to_string(&normalized, "pick_source", "source").map(Some)
}

pub async fn video_open_project<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
) -> Result<Option<OpenedVideoProject>, VideoCommandError> {
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Open video project")
        .add_filter("Supa Video Project", &["svpvideo"])
        .blocking_pick_file();
    let Some(path) = dialog_path(selection, "open_project", "project")? else {
        return Ok(None);
    };
    open_project_from_path(window.label(), &path, &grants).map(Some)
}

#[tauri::command]
pub async fn video_regrant_project_source<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    project_path: String,
    asset_id: ProjectUuid,
) -> Result<Option<VideoSourceRecord>, VideoCommandError> {
    let target =
        source_regrant_target(window.label(), Path::new(&project_path), &asset_id, &grants)?;
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Restore source access")
        .add_filter(
            "Video",
            &["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg"],
        )
        .blocking_pick_file();
    let Some(path) = dialog_path(selection, "regrant_project_source", "source")? else {
        return Ok(None);
    };
    grant_regrant_selection(window.label(), target, &path, &grants).map(Some)
}

#[tauri::command]
pub async fn video_pick_export_path<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    default_name: String,
) -> Result<Option<String>, VideoCommandError> {
    let default_name = sanitize_default_name(&default_name, "mp4", "export.mp4")?;
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Export video")
        .add_filter("MPEG-4 Video", &["mp4"])
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(path) = dialog_path(selection, "pick_export", "output")? else {
        return Ok(None);
    };
    let path = enforce_extension(path, "mp4")?;
    let normalized = grants.grant_destination(window.label(), GrantCategory::Output, &path)?;
    path_to_string(&normalized, "pick_export", "output").map(Some)
}

#[tauri::command]
pub async fn video_save_project<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    path: String,
    document: Value,
) -> Result<(), VideoCommandError> {
    let document = parse_project_value(document)?;
    save_project_to_path(window.label(), Path::new(&path), &document, &grants)
}

pub(crate) fn save_project_to_path(
    owner_label: &str,
    requested_path: &Path,
    document: &VideoProjectFileV1,
    grants: &VideoPathGrants,
) -> Result<(), VideoCommandError> {
    document
        .validate()
        .map_err(VideoCommandError::invalid_project)?;
    require_extension(requested_path, "svpvideo", "save_project", "project")?;
    let destination = grants.authorize(owner_label, GrantCategory::Project, requested_path)?;
    let mut bytes = serde_json::to_vec_pretty(document)
        .map_err(ProjectIoError::from)
        .map_err(|error| error.into_command("save_project", "serialize"))?;
    bytes.push(b'\n');
    if bytes.len() as u64 > MAX_PROJECT_BYTES {
        return Err(VideoCommandError::phase1_limit(
            "save_project",
            "project_bytes",
        ));
    }
    atomic_save_with(&destination, &bytes, promote_temp_file)
}

pub(crate) fn atomic_save_with<F>(
    destination: &Path,
    bytes: &[u8],
    promote: F,
) -> Result<(), VideoCommandError>
where
    F: FnOnce(NamedTempFile, &Path) -> Result<(), VideoCommandError>,
{
    let directory = destination
        .parent()
        .ok_or_else(|| VideoCommandError::invalid_path("save_project", "project"))?;
    let mut temporary = NamedTempFile::new_in(directory)
        .map_err(ProjectIoError::from)
        .map_err(|error| error.into_command("save_project", "create_temp"))?;
    temporary
        .write_all(bytes)
        .map_err(ProjectIoError::from)
        .map_err(|error| error.into_command("save_project", "write"))?;
    temporary
        .flush()
        .map_err(ProjectIoError::from)
        .map_err(|error| error.into_command("save_project", "flush"))?;
    temporary
        .as_file()
        .sync_all()
        .map_err(ProjectIoError::from)
        .map_err(|error| error.into_command("save_project", "sync"))?;
    promote(temporary, destination)
}

fn promote_temp_file(
    temporary: NamedTempFile,
    destination: &Path,
) -> Result<(), VideoCommandError> {
    temporary
        .persist(destination)
        .map(|_| ())
        .map_err(|_| VideoCommandError::project_io("save_project", "promote"))
}

pub(crate) fn sanitize_default_name(
    default_name: &str,
    extension: &str,
    fallback: &str,
) -> Result<String, VideoCommandError> {
    let trimmed = default_name.trim();
    let candidate = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    if candidate.len() > 200
        || candidate.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'
                )
        })
        || matches!(candidate, "." | "..")
    {
        return Err(VideoCommandError::invalid_path(
            "validate_default_name",
            "file_name",
        ));
    }
    let mut path = PathBuf::from(candidate.trim_end_matches([' ', '.']));
    if path.as_os_str().is_empty() {
        path = PathBuf::from(fallback);
    }
    path.set_extension(extension);
    path_to_string(&path, "validate_default_name", "file_name")
}

fn enforce_extension(mut path: PathBuf, extension: &str) -> Result<PathBuf, VideoCommandError> {
    let file_name = path
        .file_name()
        .filter(|name| !name.is_empty())
        .ok_or_else(|| VideoCommandError::invalid_path("enforce_extension", "file_name"))?;
    if file_name
        .to_string_lossy()
        .trim_end_matches([' ', '.'])
        .is_empty()
    {
        return Err(VideoCommandError::invalid_path(
            "enforce_extension",
            "file_name",
        ));
    }
    path.set_extension(extension);
    Ok(path)
}

fn has_source_extension(path: &Path) -> bool {
    const EXTENSIONS: [&str; 8] = ["mp4", "mov", "mkv", "webm", "avi", "m4v", "mpeg", "mpg"];
    path.extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            EXTENSIONS
                .iter()
                .any(|candidate| extension.eq_ignore_ascii_case(candidate))
        })
}

pub(crate) fn dialog_path(
    selection: Option<FilePath>,
    operation: &'static str,
    category: &'static str,
) -> Result<Option<PathBuf>, VideoCommandError> {
    selection
        .map(|path| {
            path.into_path()
                .map_err(|_| VideoCommandError::invalid_path(operation, category))
        })
        .transpose()
}
