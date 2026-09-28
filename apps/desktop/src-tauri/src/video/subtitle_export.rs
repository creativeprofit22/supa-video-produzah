//! Sidecar subtitle files (SRT/VTT/ASS). The frontend generates the text from
//! the active caption artifact; the native side only lets the user choose a
//! destination (the sole place an Output grant is issued) and writes bounded
//! UTF-8 atomically to that granted path.

use std::path::Path;

use serde::Deserialize;
use tauri::{Runtime, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use super::{
    error::VideoCommandError,
    grants::{GrantCategory, VideoPathGrants},
    project_io::{
        atomic_save_with, dialog_path, promote_temp_file, require_extension, sanitize_default_name,
    },
};

/// Generous for hours of captions, small enough to bound a single IPC write.
pub(crate) const MAX_SUBTITLE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SubtitleFormat {
    Srt,
    Vtt,
    Ass,
}

impl SubtitleFormat {
    const fn extension(self) -> &'static str {
        match self {
            Self::Srt => "srt",
            Self::Vtt => "vtt",
            Self::Ass => "ass",
        }
    }

    const fn label(self) -> &'static str {
        match self {
            Self::Srt => "SubRip subtitles",
            Self::Vtt => "WebVTT subtitles",
            Self::Ass => "Advanced SubStation subtitles",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct PickSubtitlePathRequest {
    format: SubtitleFormat,
    default_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct WriteSubtitlesRequest {
    format: SubtitleFormat,
    path: String,
    contents: String,
}

#[tauri::command]
pub(crate) async fn video_pick_subtitle_path<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    request: PickSubtitlePathRequest,
) -> Result<Option<String>, VideoCommandError> {
    let extension = request.format.extension();
    let fallback = format!("captions.{extension}");
    let default_name = sanitize_default_name(&request.default_name, extension, &fallback)?;
    let selection = window
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Export subtitles")
        .add_filter(request.format.label(), &[extension])
        .set_file_name(default_name)
        .blocking_save_file();
    let Some(path) = dialog_path(selection, "pick_subtitles", "output")? else {
        return Ok(None);
    };
    let path = if path
        .extension()
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        path
    } else {
        path.with_extension(extension)
    };
    let normalized = grants.grant_destination(window.label(), GrantCategory::Output, &path)?;
    normalized
        .to_str()
        .map(|value| Some(value.to_owned()))
        .ok_or_else(|| VideoCommandError::invalid_path("pick_subtitles", "output"))
}

#[tauri::command]
pub(crate) async fn video_write_subtitles<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    request: WriteSubtitlesRequest,
) -> Result<(), VideoCommandError> {
    write_subtitles(window.label(), &grants, &request)
}

pub(crate) fn write_subtitles(
    owner_label: &str,
    grants: &VideoPathGrants,
    request: &WriteSubtitlesRequest,
) -> Result<(), VideoCommandError> {
    let path = Path::new(&request.path);
    require_extension(
        path,
        request.format.extension(),
        "write_subtitles",
        "output",
    )?;
    if request.contents.len() > MAX_SUBTITLE_BYTES
        || request.contents.contains('\0')
        || !valid_header(request.format, &request.contents)
    {
        return Err(VideoCommandError::invalid_path(
            "write_subtitles",
            "contents",
        ));
    }
    let destination = grants.authorize(owner_label, GrantCategory::Output, path)?;
    atomic_save_with(&destination, request.contents.as_bytes(), promote_temp_file)
}

/// Cheap structural guard so the command cannot be used as a generic writer.
fn valid_header(format: SubtitleFormat, contents: &str) -> bool {
    match format {
        SubtitleFormat::Vtt => contents.starts_with("WEBVTT\n"),
        SubtitleFormat::Ass => contents.starts_with("[Script Info]\n"),
        SubtitleFormat::Srt => contents.starts_with("1\n") || contents.is_empty(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(format: SubtitleFormat, path: &Path, contents: &str) -> WriteSubtitlesRequest {
        WriteSubtitlesRequest {
            format,
            path: path.to_string_lossy().into_owned(),
            contents: contents.to_owned(),
        }
    }

    #[test]
    fn writes_only_to_a_granted_path_with_matching_extension_and_header() {
        let directory = tempfile::tempdir().unwrap();
        let grants = VideoPathGrants::default();
        let vtt = directory.path().join("captions.vtt");
        let body = "WEBVTT\n\n00:00:00.000 --> 00:00:01.000\nHello\n";

        let error = write_subtitles("main", &grants, &request(SubtitleFormat::Vtt, &vtt, body))
            .unwrap_err();
        assert_eq!(
            error.code,
            super::super::error::VideoErrorCode::PathNotGranted
        );
        assert!(!vtt.exists());

        grants
            .grant_destination("main", GrantCategory::Output, &vtt)
            .unwrap();
        assert!(
            write_subtitles("other", &grants, &request(SubtitleFormat::Vtt, &vtt, body)).is_err(),
            "another window cannot use this grant"
        );
        write_subtitles("main", &grants, &request(SubtitleFormat::Vtt, &vtt, body)).unwrap();
        assert_eq!(std::fs::read_to_string(&vtt).unwrap(), body);

        let srt = directory.path().join("captions.srt");
        grants
            .grant_destination("main", GrantCategory::Output, &srt)
            .unwrap();
        for bad in [
            request(SubtitleFormat::Vtt, &srt, body),
            request(SubtitleFormat::Srt, &srt, "not subtitles"),
            request(SubtitleFormat::Srt, &srt, "1\n\0"),
        ] {
            assert!(write_subtitles("main", &grants, &bad).is_err());
        }
        assert!(!srt.exists());
        let oversized = format!("1\n{}", "a".repeat(MAX_SUBTITLE_BYTES));
        assert!(write_subtitles(
            "main",
            &grants,
            &request(SubtitleFormat::Srt, &srt, &oversized)
        )
        .is_err());
    }
}
