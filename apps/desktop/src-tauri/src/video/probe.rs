use std::{ffi::OsString, fs, io, path::Path, time::Duration};

use serde::Deserialize;
use tauri::{Runtime, State, WebviewWindow};

use super::{
    error::VideoCommandError,
    grants::{GrantCategory, VideoPathGrants},
    process::{run_supervised, ProcessCancellation, ProcessFailure, ProcessSpec, SupervisedOutput},
    types::{
        MediaAudioShape, MediaProbe, RationalRate, VideoToolInfo, VideoToolProblem,
        VideoToolStatus, MAX_SAFE_INTEGER,
    },
};

const TOOL_CHECK_TIMEOUT: Duration = Duration::from_secs(5);
const TOOL_STDOUT_LIMIT: usize = 64 * 1024;
const TOOL_STDERR_TAIL_LIMIT: usize = 64 * 1024;
const MAX_VERSION_LINE_CHARS: usize = 256;
const MEDIA_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const MEDIA_PROBE_STDOUT_LIMIT: usize = 1024 * 1024;
const MEDIA_PROBE_STDERR_TAIL_LIMIT: usize = 64 * 1024;
const FFPROBE_ENTRIES: &str = "format=duration,size:stream=codec_type,codec_name,duration,width,height,avg_frame_rate,r_frame_rate,sample_rate,channels:stream_disposition=attached_pic";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum VideoTool {
    Ffmpeg,
    Ffprobe,
}

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
pub async fn video_ffmpeg_status() -> VideoToolStatus {
    video_ffmpeg_status_with_programs(OsString::from("ffmpeg"), OsString::from("ffprobe")).await
}

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
        ffmpeg,
        ffprobe,
        ready,
    }
}

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

pub(crate) fn tool_info_from_result(
    tool: VideoTool,
    result: Result<SupervisedOutput, ProcessFailure>,
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

#[tauri::command]
pub async fn video_probe_media<R: Runtime>(
    window: WebviewWindow<R>,
    grants: State<'_, VideoPathGrants>,
    path: String,
) -> Result<MediaProbe, VideoCommandError> {
    probe_media_with_program(
        window.label(),
        &grants,
        Path::new(&path),
        OsString::from("ffprobe"),
        ProcessCancellation::new(),
    )
    .await
}

pub(crate) async fn probe_media_with_program(
    owner_label: &str,
    grants: &VideoPathGrants,
    requested_path: &Path,
    ffprobe_program: OsString,
    cancellation: ProcessCancellation,
) -> Result<MediaProbe, VideoCommandError> {
    let source = grants.authorize(owner_label, GrantCategory::Source, requested_path)?;
    let file_size_bytes = fs::metadata(&source)
        .map_err(|_| VideoCommandError::invalid_media("probe_media", "metadata"))?
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
            source.into_os_string(),
        ],
        operation: "probe_media",
        timeout: MEDIA_PROBE_TIMEOUT,
        stdout_limit: MEDIA_PROBE_STDOUT_LIMIT,
        stderr_tail_limit: MEDIA_PROBE_STDERR_TAIL_LIMIT,
    };
    let output = run_supervised(spec, cancellation)
        .await
        .map_err(map_probe_process_failure)?;
    parse_ffprobe_json(&output.stdout, file_size_bytes).map_err(|error| {
        let category = match error {
            ProbeParseError::InvalidJson => "invalid_json",
            ProbeParseError::InvalidMedia => "unsupported_metadata",
        };
        VideoCommandError::invalid_media("probe_media", category)
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
struct ProbeStream {
    codec_type: Option<String>,
    codec_name: Option<String>,
    duration: Option<String>,
    width: Option<u64>,
    height: Option<u64>,
    avg_frame_rate: Option<String>,
    r_frame_rate: Option<String>,
    sample_rate: Option<String>,
    channels: Option<u64>,
    disposition: Option<ProbeDisposition>,
}

#[derive(Debug, Deserialize)]
struct ProbeDisposition {
    attached_pic: Option<u64>,
}

struct SelectedVideo<'a> {
    stream: &'a ProbeStream,
    codec_name: String,
    width: u64,
    height: u64,
    average_frame_rate: RationalRate,
    real_frame_rate: RationalRate,
}

pub(crate) fn parse_ffprobe_json(
    bytes: &[u8],
    file_size_bytes: u64,
) -> Result<MediaProbe, ProbeParseError> {
    let envelope: ProbeEnvelope =
        serde_json::from_slice(bytes).map_err(|_| ProbeParseError::InvalidJson)?;
    parse_probe_envelope(envelope, file_size_bytes)
}

fn parse_probe_envelope(
    envelope: ProbeEnvelope,
    file_size_bytes: u64,
) -> Result<MediaProbe, ProbeParseError> {
    let selected = envelope
        .streams
        .iter()
        .filter(|stream| stream.codec_type.as_deref() == Some("video"))
        .find_map(select_video_stream)
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

    let audio = envelope
        .streams
        .iter()
        .find(|stream| stream.codec_type.as_deref() == Some("audio"))
        .map(parse_audio_stream)
        .transpose()?
        .flatten();

    let variable_frame_rate =
        rates_differ_over_tolerance(&selected.average_frame_rate, &selected.real_frame_rate)
            .ok_or(ProbeParseError::InvalidMedia)?;

    MediaProbe::checked(
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
    .ok_or(ProbeParseError::InvalidMedia)
}

fn select_video_stream(stream: &ProbeStream) -> Option<SelectedVideo<'_>> {
    if stream
        .disposition
        .as_ref()?
        .attached_pic
        .is_none_or(|attached| attached != 0)
    {
        return None;
    }
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

    Some(SelectedVideo {
        stream,
        codec_name,
        width,
        height,
        average_frame_rate: average,
        real_frame_rate: real,
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

fn normalize_codec_name(value: &str) -> Option<String> {
    let value = value.trim();
    (!value.is_empty() && value.encode_utf16().count() <= 512).then(|| value.to_owned())
}

fn parse_rational_rate(value: &str) -> Option<RationalRate> {
    let (numerator, denominator) = value.split_once('/')?;
    if denominator.contains('/') {
        return None;
    }
    RationalRate::checked_reduced(
        parse_positive_integer_text(numerator).ok()?,
        parse_positive_integer_text(denominator).ok()?,
    )
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
