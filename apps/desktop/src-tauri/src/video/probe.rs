use std::{ffi::OsString, fs, io, path::Path, time::Duration};

use serde::Deserialize;
use serde_json::Value;
use tauri::{Runtime, State, WebviewWindow};

use super::{
    error::VideoCommandError,
    grants::{GrantCategory, VideoPathGrants},
    process::{run_supervised, ProcessCancellation, ProcessFailure, ProcessSpec},
    toolchain::{
        MediaToolchain, MediaToolchainInspection, MediaToolchainProblem, MediaToolchainState,
    },
    types::{
        MediaAudioShape, MediaColorMetadata, MediaDisplayShape, MediaProbe, RationalRate,
        VideoToolInfo, VideoToolProblem, VideoToolSource, VideoToolStatus, MAX_SAFE_INTEGER,
    },
};

#[cfg(test)]
const TOOL_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
#[cfg(test)]
const TOOL_STDOUT_LIMIT: usize = 64 * 1024;
#[cfg(test)]
const TOOL_STDERR_TAIL_LIMIT: usize = 64 * 1024;
#[cfg(test)]
const MAX_VERSION_LINE_CHARS: usize = 256;
const MEDIA_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_PROBE_STDOUT_LIMIT: usize = 1024 * 1024;
const MEDIA_PROBE_STDERR_TAIL_LIMIT: usize = 64 * 1024;
const TOOL_STATUS_TIMEOUT: Duration = Duration::from_secs(6 * 60);
const FFPROBE_ENTRIES: &str = "format=duration,size:stream=index,codec_type,codec_name,duration,width,height,pix_fmt,color_range,color_space,color_primaries,color_transfer,avg_frame_rate,r_frame_rate,sample_aspect_ratio,display_aspect_ratio,sample_rate,channels:stream_disposition=attached_pic:stream_tags=rotate:stream_side_data=rotation";
const THUMBNAIL_FFPROBE_ENTRIES: &str = "stream=codec_type,codec_name,width,height,nb_read_frames";

#[cfg(test)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VideoTool {
    Ffmpeg,
    Ffprobe,
}

#[cfg(test)]
impl VideoTool {
    fn version_prefix(self) -> &'static str {
        match self {
            Self::Ffmpeg => "ffmpeg version ",
            Self::Ffprobe => "ffprobe version ",
        }
    }

    fn operation(self) -> &'static str {
        match self {
            Self::Ffmpeg => "check_ffmpeg",
            Self::Ffprobe => "check_ffprobe",
        }
    }
}

#[tauri::command]
pub async fn video_ffmpeg_status(
    toolchain: State<'_, MediaToolchainState>,
) -> Result<VideoToolStatus, VideoCommandError> {
    let inspection = tokio::time::timeout(TOOL_STATUS_TIMEOUT, toolchain.inspect())
        .await
        .unwrap_or_else(|_| failed_status_inspection(MediaToolchainProblem::TimedOut));
    Ok(video_tool_status_from_inspection(&*toolchain, inspection))
}

fn failed_status_inspection(problem: MediaToolchainProblem) -> MediaToolchainInspection {
    let error = super::toolchain::MediaToolchainError::for_status(problem);
    MediaToolchainInspection {
        ffmpeg_version: Err(error.clone()),
        ffprobe_version: Err(error),
    }
}

pub(crate) trait MediaToolchainIdentity {
    fn toolchain_id(&self) -> &str;
    fn short_version(&self) -> &str;
}

impl MediaToolchainIdentity for MediaToolchain {
    fn toolchain_id(&self) -> &str {
        self.toolchain_id()
    }

    fn short_version(&self) -> &str {
        self.short_version()
    }
}

impl MediaToolchainIdentity for MediaToolchainState {
    fn toolchain_id(&self) -> &str {
        self.toolchain_id()
    }

    fn short_version(&self) -> &str {
        self.short_version()
    }
}

pub(crate) fn video_tool_status_from_inspection(
    toolchain: &impl MediaToolchainIdentity,
    inspection: MediaToolchainInspection,
) -> VideoToolStatus {
    let ffmpeg = inspected_tool_info(inspection.ffmpeg_version, toolchain.short_version());
    let ffprobe = inspected_tool_info(inspection.ffprobe_version, toolchain.short_version());
    let ready = ffmpeg.available && ffprobe.available;
    VideoToolStatus {
        source: VideoToolSource::Bundled,
        toolchain_id: toolchain.toolchain_id().to_owned(),
        ffmpeg,
        ffprobe,
        ready,
    }
}

fn inspected_tool_info(
    inspection: Result<String, super::toolchain::MediaToolchainError>,
    version: &str,
) -> VideoToolInfo {
    match inspection {
        Ok(_sanitized_banner) => VideoToolInfo {
            available: true,
            version: Some(version.to_owned()),
            problem: None,
        },
        Err(error) => unavailable_tool(tool_problem_from_toolchain(error.problem())),
    }
}

#[cfg(test)]
pub(crate) async fn video_ffmpeg_status_with_programs(
    ffmpeg_program: OsString,
    ffprobe_program: OsString,
) -> VideoToolStatus {
    let (ffmpeg, ffprobe) = tokio::join!(
        check_tool(VideoTool::Ffmpeg, ffmpeg_program),
        check_tool(VideoTool::Ffprobe, ffprobe_program),
    );
    let ready = ffmpeg.available && ffprobe.available;
    VideoToolStatus {
        source: VideoToolSource::Bundled,
        toolchain_id: "test-explicit-programs".to_owned(),
        ffmpeg,
        ffprobe,
        ready,
    }
}

#[cfg(test)]
async fn check_tool(tool: VideoTool, program: OsString) -> VideoToolInfo {
    let spec = ProcessSpec {
        program,
        args: vec![OsString::from("-version")],
        operation: tool.operation(),
        timeout: TOOL_CHECK_TIMEOUT,
        stdout_limit: TOOL_STDOUT_LIMIT,
        stderr_tail_limit: TOOL_STDERR_TAIL_LIMIT,
    };
    tool_info_from_result(tool, run_supervised(spec, ProcessCancellation::new()).await)
}

#[cfg(test)]
pub(crate) fn tool_info_from_result(
    tool: VideoTool,
    result: Result<super::process::SupervisedOutput, ProcessFailure>,
) -> VideoToolInfo {
    match result {
        Ok(output) => {
            debug_assert!(output.status.success());
            let _ = (&output.stderr_tail, output.stderr_truncated);
            parse_tool_banner(tool, &output.stdout)
        }
        Err(ProcessFailure::Spawn {
            kind: io::ErrorKind::NotFound,
            ..
        }) => unavailable_tool(VideoToolProblem::NotFound),
        Err(ProcessFailure::Timeout { .. }) => unavailable_tool(VideoToolProblem::TimedOut),
        Err(_) => unavailable_tool(VideoToolProblem::Failed),
    }
}

#[cfg(test)]
pub(crate) fn parse_tool_banner(tool: VideoTool, stdout: &[u8]) -> VideoToolInfo {
    let Some(first_line) = std::str::from_utf8(stdout)
        .ok()
        .and_then(|text| text.lines().next())
        .map(str::trim)
        .filter(|line| {
            !line.is_empty()
                && line.chars().count() <= MAX_VERSION_LINE_CHARS
                && line.starts_with(tool.version_prefix())
        })
    else {
        return unavailable_tool(VideoToolProblem::InvalidVersion);
    };

    VideoToolInfo {
        available: true,
        version: Some(first_line.to_owned()),
        problem: None,
    }
}

fn unavailable_tool(problem: VideoToolProblem) -> VideoToolInfo {
    VideoToolInfo {
        available: false,
        version: None,
        problem: Some(problem),
    }
}

fn tool_problem_from_toolchain(problem: MediaToolchainProblem) -> VideoToolProblem {
    match problem {
        MediaToolchainProblem::NotFound => VideoToolProblem::NotFound,
        MediaToolchainProblem::TimedOut => VideoToolProblem::TimedOut,
        MediaToolchainProblem::IntegrityFailed => VideoToolProblem::IntegrityFailed,
        MediaToolchainProblem::IncompatibleBuild => VideoToolProblem::IncompatibleBuild,
        MediaToolchainProblem::Failed => VideoToolProblem::Failed,
    }
}

#[tauri::command]
pub async fn video_probe_media<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    toolchain: State<'_, MediaToolchainState>,
    path: String,
) -> Result<MediaProbe, VideoCommandError> {
    let source = grants.authorize(window.label(), GrantCategory::Source, Path::new(&path))?;
    let ffprobe = toolchain
        .verified_ffprobe()
        .await
        .map_err(|error| error.into_command_error("probe_media"))?
        .into_os_string();
    probe_trusted_media_with_program(&source, ffprobe, ProcessCancellation::new(), "probe_media")
        .await
        .map(|inspected| inspected.probe)
}

#[cfg(test)]
pub(crate) async fn probe_media_with_program(
    owner_label: &str,
    grants: &VideoPathGrants,
    requested_path: &Path,
    ffprobe_program: OsString,
    cancellation: ProcessCancellation,
) -> Result<MediaProbe, VideoCommandError> {
    let source = grants.authorize(owner_label, GrantCategory::Source, requested_path)?;
    probe_trusted_media_with_program(&source, ffprobe_program, cancellation, "probe_media")
        .await
        .map(|inspected| inspected.probe)
}

pub(crate) async fn probe_trusted_media_with_program(
    trusted_path: &Path,
    ffprobe_program: OsString,
    cancellation: ProcessCancellation,
    operation: &'static str,
) -> Result<InspectedMedia, VideoCommandError> {
    let file_size_bytes = fs::metadata(trusted_path)
        .map_err(|_| VideoCommandError::invalid_media(operation, "metadata"))?
        .len();
    let spec = ProcessSpec {
        program: ffprobe_program,
        args: vec![
            OsString::from("-v"),
            OsString::from("error"),
            OsString::from("-output_format"),
            OsString::from("json"),
            OsString::from("-show_entries"),
            OsString::from(FFPROBE_ENTRIES),
            OsString::from("-i"),
            trusted_path.as_os_str().to_owned(),
        ],
        operation,
        timeout: MEDIA_PROBE_TIMEOUT,
        stdout_limit: MEDIA_PROBE_STDOUT_LIMIT,
        stderr_tail_limit: MEDIA_PROBE_STDERR_TAIL_LIMIT,
    };
    let output = run_supervised(spec, cancellation)
        .await
        .map_err(map_probe_process_failure)?;
    parse_ffprobe_json_inspected(&output.stdout, file_size_bytes).map_err(|error| {
        let category = match error {
            ProbeParseError::InvalidJson => "invalid_json",
            ProbeParseError::InvalidMedia => "unsupported_metadata",
        };
        VideoCommandError::invalid_media(operation, category)
    })
}

pub(crate) async fn probe_thumbnail_artifact_with_program(
    trusted_path: &Path,
    ffprobe_program: OsString,
    cancellation: ProcessCancellation,
    operation: &'static str,
) -> Result<ThumbnailArtifactProbe, VideoCommandError> {
    let file_size_bytes = fs::metadata(trusted_path)
        .map_err(|_| VideoCommandError::invalid_media(operation, "metadata"))?
        .len();
    let spec = ProcessSpec {
        program: ffprobe_program,
        args: vec![
            OsString::from("-v"),
            OsString::from("error"),
            OsString::from("-count_frames"),
            OsString::from("-output_format"),
            OsString::from("json"),
            OsString::from("-select_streams"),
            OsString::from("v:0"),
            OsString::from("-show_entries"),
            OsString::from(THUMBNAIL_FFPROBE_ENTRIES),
            OsString::from("-i"),
            trusted_path.as_os_str().to_owned(),
        ],
        operation,
        timeout: MEDIA_PROBE_TIMEOUT,
        stdout_limit: MEDIA_PROBE_STDOUT_LIMIT,
        stderr_tail_limit: MEDIA_PROBE_STDERR_TAIL_LIMIT,
    };
    let output = run_supervised(spec, cancellation)
        .await
        .map_err(map_probe_process_failure)?;
    parse_thumbnail_artifact_json(&output.stdout, file_size_bytes).map_err(|error| {
        let category = match error {
            ProbeParseError::InvalidJson => "invalid_json",
            ProbeParseError::InvalidMedia => "unsupported_metadata",
        };
        VideoCommandError::invalid_media(operation, category)
    })
}

fn map_probe_process_failure(failure: ProcessFailure) -> VideoCommandError {
    let operation = failure.operation();
    match failure {
        ProcessFailure::Spawn {
            kind: io::ErrorKind::NotFound,
            ..
        } => VideoCommandError::tool_unavailable(operation, "ffprobe"),
        ProcessFailure::Timeout { .. } => VideoCommandError::process_timeout(operation, "ffprobe"),
        ProcessFailure::Cancelled { .. } => {
            VideoCommandError::process_cancelled(operation, "ffprobe")
        }
        ProcessFailure::StdoutLimit { limit, .. } => {
            VideoCommandError::process_output_limit(operation, "ffprobe", limit)
        }
        ProcessFailure::NonZero {
            exit_code,
            stderr_tail,
            stderr_truncated,
            ..
        } => {
            let _ = (stderr_tail, stderr_truncated);
            VideoCommandError::process_failed(operation, "ffprobe", exit_code)
        }
        ProcessFailure::Spawn { .. } | ProcessFailure::Io { .. } => {
            VideoCommandError::process_failed(operation, "ffprobe", None)
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct InspectedMedia {
    pub(crate) probe: MediaProbe,
    pub(crate) video_stream_index: u64,
    pub(crate) audio_stream_index: Option<u64>,
    pub(crate) pixel_format: Option<String>,
    pub(crate) color: MediaColorMetadata,
    pub(crate) display_shape: MediaDisplayShape,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ThumbnailArtifactProbe {
    pub(crate) file_size_bytes: u64,
    pub(crate) video_codec_name: String,
    pub(crate) width: u64,
    pub(crate) height: u64,
    pub(crate) decoded_frame_count: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProbeParseError {
    InvalidJson,
    InvalidMedia,
}

#[derive(Debug, Deserialize)]
struct ProbeEnvelope {
    streams: Vec<ProbeStream>,
    format: ProbeFormat,
}

#[derive(Debug, Deserialize)]
struct ProbeFormat {
    duration: Option<String>,
    size: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ThumbnailProbeEnvelope {
    streams: Vec<ThumbnailProbeStream>,
}

#[derive(Debug, Deserialize)]
struct ThumbnailProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    nb_read_frames: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeStream {
    index: Option<u64>,
    codec_type: Option<String>,
    codec_name: Option<String>,
    duration: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    pix_fmt: Option<String>,
    color_range: Option<String>,
    color_space: Option<String>,
    color_primaries: Option<String>,
    color_transfer: Option<String>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    sample_aspect_ratio: Option<String>,
    display_aspect_ratio: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u64>,
    disposition: Option<ProbeDisposition>,
    tags: Option<ProbeTags>,
    side_data_list: Option<Vec<ProbeSideData>>,
}

#[derive(Debug, Deserialize)]
struct ProbeDisposition {
    attached_pic: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct ProbeTags {
    rotate: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ProbeSideData {
    rotation: Option<Value>,
}

struct SelectedVideo<'a> {
    stream: &'a ProbeStream,
    stream_index: u64,
    codec_name: String,
    pixel_format: Option<String>,
    color: MediaColorMetadata,
    width: u64,
    height: u64,
    average_frame_rate: RationalRate,
    real_frame_rate: RationalRate,
    display_shape: MediaDisplayShape,
}

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) fn parse_ffprobe_json(
    bytes: &[u8],
    file_size_bytes: u64,
) -> Result<MediaProbe, ProbeParseError> {
    parse_ffprobe_json_inspected(bytes, file_size_bytes).map(|inspected| inspected.probe)
}

pub(crate) fn parse_ffprobe_json_inspected(
    bytes: &[u8],
    file_size_bytes: u64,
) -> Result<InspectedMedia, ProbeParseError> {
    let envelope: ProbeEnvelope =
        serde_json::from_slice(bytes).map_err(|_| ProbeParseError::InvalidJson)?;
    parse_probe_envelope(envelope, file_size_bytes)
}

pub(crate) fn parse_thumbnail_artifact_json(
    bytes: &[u8],
    file_size_bytes: u64,
) -> Result<ThumbnailArtifactProbe, ProbeParseError> {
    if !(1..=MAX_SAFE_INTEGER).contains(&file_size_bytes) {
        return Err(ProbeParseError::InvalidMedia);
    }
    let envelope: ThumbnailProbeEnvelope =
        serde_json::from_slice(bytes).map_err(|_| ProbeParseError::InvalidJson)?;
    if envelope.streams.len() != 1 {
        return Err(ProbeParseError::InvalidMedia);
    }
    let stream = envelope
        .streams
        .into_iter()
        .next()
        .ok_or(ProbeParseError::InvalidMedia)?;
    if stream.codec_type.as_deref() != Some("video") {
        return Err(ProbeParseError::InvalidMedia);
    }
    let video_codec_name = normalize_codec_name(
        stream
            .codec_name
            .as_deref()
            .ok_or(ProbeParseError::InvalidMedia)?,
    )
    .ok_or(ProbeParseError::InvalidMedia)?;
    let width = stream
        .width
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .ok_or(ProbeParseError::InvalidMedia)?;
    let height = stream
        .height
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))
        .ok_or(ProbeParseError::InvalidMedia)?;
    let decoded_frame_count = parse_positive_integer_text(
        stream
            .nb_read_frames
            .as_deref()
            .ok_or(ProbeParseError::InvalidMedia)?,
    )?;
    Ok(ThumbnailArtifactProbe {
        file_size_bytes,
        video_codec_name,
        width,
        height,
        decoded_frame_count,
    })
}

fn parse_probe_envelope(
    envelope: ProbeEnvelope,
    file_size_bytes: u64,
) -> Result<InspectedMedia, ProbeParseError> {
    let selected = envelope
        .streams
        .iter()
        .enumerate()
        .filter(|(_, stream)| stream.codec_type.as_deref() == Some("video"))
        .find_map(|(position, stream)| select_video_stream(stream, position))
        .ok_or(ProbeParseError::InvalidMedia)?;

    parse_positive_integer_text(
        envelope
            .format
            .size
            .as_deref()
            .ok_or(ProbeParseError::InvalidMedia)?,
    )?;

    let duration_microseconds = envelope
        .format
        .duration
        .as_deref()
        .and_then(parse_duration_microseconds)
        .or_else(|| {
            selected
                .stream
                .duration
                .as_deref()
                .and_then(parse_duration_microseconds)
        })
        .ok_or(ProbeParseError::InvalidMedia)?;

    let (audio, audio_stream_index) = match envelope
        .streams
        .iter()
        .enumerate()
        .find(|(_, stream)| stream.codec_type.as_deref() == Some("audio"))
    {
        Some((position, stream)) => (
            parse_audio_stream(stream)?,
            Some(selected_stream_index(stream, position)?),
        ),
        None => (None, None),
    };

    let variable_frame_rate =
        rates_differ_over_tolerance(&selected.average_frame_rate, &selected.real_frame_rate)
            .ok_or(ProbeParseError::InvalidMedia)?;

    let probe = MediaProbe::checked(
        duration_microseconds,
        selected.average_frame_rate,
        selected.real_frame_rate,
        variable_frame_rate,
        selected.width,
        selected.height,
        selected.codec_name,
        audio,
        file_size_bytes,
    )
    .ok_or(ProbeParseError::InvalidMedia)?;
    Ok(InspectedMedia {
        probe,
        video_stream_index: selected.stream_index,
        audio_stream_index,
        pixel_format: selected.pixel_format,
        color: selected.color,
        display_shape: selected.display_shape,
    })
}

fn select_video_stream(stream: &ProbeStream, position: usize) -> Option<SelectedVideo<'_>> {
    if stream
        .disposition
        .as_ref()?
        .attached_pic
        .is_none_or(|attached| attached != 0)
    {
        return None;
    }
    let stream_index = selected_stream_index(stream, position).ok()?;
    let codec_name = normalize_codec_name(stream.codec_name.as_deref()?)?;
    let width = stream
        .width
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))?;
    let height = stream
        .height
        .filter(|value| (1..=MAX_SAFE_INTEGER).contains(value))?;
    let average = stream
        .avg_frame_rate
        .as_deref()
        .and_then(parse_rational_rate)
        .or_else(|| stream.r_frame_rate.as_deref().and_then(parse_rational_rate))?;
    let real = stream
        .r_frame_rate
        .as_deref()
        .and_then(parse_rational_rate)
        .unwrap_or_else(|| average.clone());
    let sample_aspect_ratio = parse_optional_aspect_ratio(stream.sample_aspect_ratio.as_deref())?
        .unwrap_or(RationalRate {
            numerator: 1,
            denominator: 1,
        });
    let calculated_display_aspect_ratio =
        calculate_display_aspect_ratio(width, height, &sample_aspect_ratio)?;
    let display_aspect_ratio = parse_optional_aspect_ratio(stream.display_aspect_ratio.as_deref())?
        .unwrap_or_else(|| calculated_display_aspect_ratio.clone());
    if display_aspect_ratio != calculated_display_aspect_ratio {
        return None;
    }
    let rotation_degrees = parse_rotation_degrees(stream)?;
    let display_shape =
        MediaDisplayShape::checked(sample_aspect_ratio, display_aspect_ratio, rotation_degrees)?;

    Some(SelectedVideo {
        stream,
        stream_index,
        codec_name,
        pixel_format: stream.pix_fmt.as_deref().and_then(normalize_codec_name),
        color: MediaColorMetadata {
            color_range: normalize_optional_metadata(stream.color_range.as_deref()),
            color_space: normalize_optional_metadata(stream.color_space.as_deref()),
            color_primaries: normalize_optional_metadata(stream.color_primaries.as_deref()),
            color_transfer: normalize_optional_metadata(stream.color_transfer.as_deref()),
        },
        width,
        height,
        average_frame_rate: average,
        real_frame_rate: real,
        display_shape,
    })
}

fn parse_audio_stream(stream: &ProbeStream) -> Result<Option<MediaAudioShape>, ProbeParseError> {
    let codec_name = normalize_codec_name(
        stream
            .codec_name
            .as_deref()
            .ok_or(ProbeParseError::InvalidMedia)?,
    )
    .ok_or(ProbeParseError::InvalidMedia)?;
    let channels = stream.channels.ok_or(ProbeParseError::InvalidMedia)?;
    let sample_rate = parse_positive_integer_text(
        stream
            .sample_rate
            .as_deref()
            .ok_or(ProbeParseError::InvalidMedia)?,
    )?;
    MediaAudioShape::checked(codec_name, channels, sample_rate)
        .map(Some)
        .ok_or(ProbeParseError::InvalidMedia)
}

fn selected_stream_index(
    stream: &ProbeStream,
    fallback_position: usize,
) -> Result<u64, ProbeParseError> {
    stream
        .index
        .or_else(|| u64::try_from(fallback_position).ok())
        .filter(|index| *index <= MAX_SAFE_INTEGER)
        .ok_or(ProbeParseError::InvalidMedia)
}

fn normalize_codec_name(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.encode_utf16().count() <= 512).then(|| value.to_owned())
}

fn normalize_optional_metadata(value: Option<&str>) -> Option<String> {
    value.and_then(normalize_codec_name)
}

fn parse_rational_rate(value: &str) -> Option<RationalRate> {
    parse_rational(value, '/')
}

fn parse_optional_aspect_ratio(value: Option<&str>) -> Option<Option<RationalRate>> {
    match value.map(str::trim) {
        None | Some("") | Some("N/A") | Some("0:1") => Some(None),
        Some(value) => parse_rational(value, ':').map(Some),
    }
}

fn parse_rational(value: &str, separator: char) -> Option<RationalRate> {
    let (numerator, denominator) = value.split_once(separator)?;
    if denominator.contains(separator) {
        return None;
    }
    RationalRate::checked_reduced(
        parse_positive_integer_text(numerator).ok()?,
        parse_positive_integer_text(denominator).ok()?,
    )
}

fn calculate_display_aspect_ratio(
    width: u64,
    height: u64,
    sample_aspect_ratio: &RationalRate,
) -> Option<RationalRate> {
    let numerator = u128::from(width).checked_mul(u128::from(sample_aspect_ratio.numerator))?;
    let denominator =
        u128::from(height).checked_mul(u128::from(sample_aspect_ratio.denominator))?;
    let divisor = greatest_common_divisor_u128(numerator, denominator);
    RationalRate::checked_reduced(
        u64::try_from(numerator / divisor).ok()?,
        u64::try_from(denominator / divisor).ok()?,
    )
}

fn parse_rotation_degrees(stream: &ProbeStream) -> Option<u16> {
    let mut side_data_rotation = None;
    for value in stream
        .side_data_list
        .iter()
        .flatten()
        .filter_map(|side_data| side_data.rotation.as_ref())
    {
        let rotation = normalize_rotation(parse_rotation_value(value)?)?;
        if side_data_rotation.is_some_and(|existing| existing != rotation) {
            return None;
        }
        side_data_rotation = Some(rotation);
    }
    if let Some(rotation) = side_data_rotation {
        return Some(rotation);
    }

    match stream.tags.as_ref().and_then(|tags| tags.rotate.as_deref()) {
        Some(value) => normalize_rotation(value.trim().parse::<i64>().ok()?),
        None => Some(0),
    }
}

fn parse_rotation_value(value: &Value) -> Option<i64> {
    value
        .as_i64()
        .or_else(|| value.as_str()?.trim().parse::<i64>().ok())
}

fn normalize_rotation(degrees: i64) -> Option<u16> {
    let normalized = degrees.rem_euclid(360);
    matches!(normalized, 0 | 90 | 180 | 270).then(|| normalized as u16)
}

fn greatest_common_divisor_u128(mut left: u128, mut right: u128) -> u128 {
    while right != 0 {
        let remainder = left % right;
        left = right;
        right = remainder;
    }
    left
}

fn parse_positive_integer_text(value: &str) -> Result<u64, ProbeParseError> {
    if value.is_empty() || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return Err(ProbeParseError::InvalidMedia);
    }
    value
        .parse::<u64>()
        .ok()
        .filter(|number| (1..=MAX_SAFE_INTEGER).contains(number))
        .ok_or(ProbeParseError::InvalidMedia)
}

fn parse_duration_microseconds(value: &str) -> Option<u64> {
    let (whole, fraction) = match value.split_once('.') {
        Some((whole, fraction)) => {
            if fraction.is_empty() || fraction.contains('.') {
                return None;
            }
            (whole, Some(fraction))
        }
        None => (value, None),
    };
    if whole.is_empty()
        || !whole.bytes().all(|byte| byte.is_ascii_digit())
        || fraction.is_some_and(|digits| !digits.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return None;
    }

    let whole = whole.parse::<u128>().ok()?;
    let mut micros = whole.checked_mul(1_000_000)?;
    if let Some(fraction) = fraction {
        let leading = &fraction[..fraction.len().min(6)];
        let leading_value = leading.parse::<u128>().ok()?;
        let scale = 10_u128.checked_pow(u32::try_from(6 - leading.len()).ok()?)?;
        micros = micros.checked_add(leading_value.checked_mul(scale)?)?;
        if fraction
            .as_bytes()
            .get(6..)
            .is_some_and(|tail| tail.iter().any(|byte| *byte != b'0'))
        {
            micros = micros.checked_add(1)?;
        }
    }

    u64::try_from(micros)
        .ok()
        .filter(|duration| (1..=MAX_SAFE_INTEGER).contains(duration))
}

fn rates_differ_over_tolerance(average: &RationalRate, real: &RationalRate) -> Option<bool> {
    let average_cross = u128::from(average.numerator).checked_mul(u128::from(real.denominator))?;
    let real_cross = u128::from(real.numerator).checked_mul(u128::from(average.denominator))?;
    let difference = average_cross.abs_diff(real_cross);
    let scaled_difference = difference.checked_mul(1_000)?;
    let relative_denominator =
        u128::from(real.denominator).checked_mul(u128::from(average.numerator))?;
    Some(scaled_difference > relative_denominator)
}
