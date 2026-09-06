use std::{
    ffi::OsString,
    fs::{self, File, Metadata},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    time::Duration,
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tempfile::Builder as TempDirBuilder;

use super::{
    cache::MediaCacheService,
    error::VideoCommandError,
    media_store::{acquire_artifact, ArtifactStoreKind, SourceFingerprintV1},
    process::{ProcessCancellation, ProcessFailure, ProcessSpec},
    transcript::{
        create_transcript_artifact_v1, derive_asr_configuration_identity,
        derive_transcript_artifact_identity, load_transcript_artifact_for_identity,
        publish_transcript_artifact, AsrConfigurationV1, AsrProviderSettingValueV1, AsrTaskV1,
        PublishedTranscriptArtifact, SpeakerDiarizationModeV1, TimingProvenanceV1,
        TranscriptChunkInputV1, TranscriptChunkWordInputV1,
    },
    types::{MediaContentIdentityV1, MAX_SAFE_INTEGER},
};

const OPERATION: &str = "transcribe_asset";
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(15 * 60);
const NEMO_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
const FFMPEG_STDOUT_LIMIT: usize = 64 * 1024;
const FFMPEG_STDERR_TAIL_LIMIT: usize = 256 * 1024;
const NEMO_STDOUT_LIMIT: usize = 128 * 1024 * 1024;
const NEMO_STDERR_TAIL_LIMIT: usize = 512 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const OWNER_LABEL: &str = "nemo-transcription";

#[derive(Debug, Clone)]
pub(crate) struct NemoTranscriptionInput<'a> {
    pub(crate) source_path: &'a Path,
    pub(crate) source_identity: &'a MediaContentIdentityV1,
    pub(crate) source_fingerprint: &'a SourceFingerprintV1,
    pub(crate) source_duration_us: u64,
    pub(crate) configuration: &'a AsrConfigurationV1,
    pub(crate) app_cache_root: &'a Path,
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedNemoFile {
    pub(crate) path: PathBuf,
    pub(crate) byte_length: u64,
    pub(crate) sha256: String,
}

#[derive(Debug, Clone)]
pub(crate) struct VerifiedNemoRuntime {
    executable: VerifiedNemoFile,
    dll_directory: PathBuf,
    required_dlls: Vec<VerifiedNemoFile>,
    model: VerifiedNemoFile,
}

impl VerifiedNemoRuntime {
    pub(crate) fn new(
        executable: VerifiedNemoFile,
        dll_directory: PathBuf,
        required_dlls: Vec<VerifiedNemoFile>,
        model: VerifiedNemoFile,
    ) -> Result<Self, VideoCommandError> {
        let canonical_dll_directory = verify_runtime_directory(&dll_directory)?;
        let executable = verify_runtime_file(executable)?;
        if executable.path.parent() != Some(canonical_dll_directory.as_path()) {
            return Err(nemo_unavailable());
        }

        let mut verified_dlls = Vec::with_capacity(required_dlls.len());
        for dll in required_dlls {
            let dll = verify_runtime_file(dll)?;
            if dll.path.parent() != Some(canonical_dll_directory.as_path()) {
                return Err(nemo_unavailable());
            }
            verified_dlls.push(dll);
        }

        Ok(Self {
            executable,
            dll_directory: canonical_dll_directory,
            required_dlls: verified_dlls,
            model: verify_runtime_file(model)?,
        })
    }

    fn verify_again(&self) -> Result<(), VideoCommandError> {
        let directory = verify_runtime_directory(&self.dll_directory)?;
        if directory != self.dll_directory {
            return Err(nemo_unavailable());
        }
        verify_runtime_file(self.executable.clone())?;
        verify_runtime_file(self.model.clone())?;
        for dll in &self.required_dlls {
            verify_runtime_file(dll.clone())?;
        }
        Ok(())
    }
}

pub(crate) async fn transcribe_nemo_cuda(
    input: NemoTranscriptionInput<'_>,
    ffmpeg_program: PathBuf,
    nemo: VerifiedNemoRuntime,
    cancellation: ProcessCancellation,
    cache: &MediaCacheService,
) -> Result<PublishedTranscriptArtifact, VideoCommandError> {
    validate_configuration(input.configuration, input.source_duration_us, &nemo)?;
    validate_source_path(input.source_path)?;

    let configuration_identity =
        derive_asr_configuration_identity(input.configuration).map_err(|_| transcript_invalid())?;
    let artifact_identity = derive_transcript_artifact_identity(
        input.source_identity,
        input.source_fingerprint,
        &configuration_identity,
    )
    .map_err(|_| transcript_invalid())?;

    let existing_guard = acquire_artifact(
        input.app_cache_root,
        ArtifactStoreKind::Transcript,
        &artifact_identity.key,
    )
    .await?;
    if existing_guard.path().exists() {
        let artifact =
            load_transcript_artifact_for_identity(existing_guard.path(), &artifact_identity)
                .map_err(|_| transcript_invalid())?;
        existing_guard.confirm_durable()?;
        drop(existing_guard);
        return publish_transcript_artifact(
            input.app_cache_root,
            cache,
            OWNER_LABEL,
            None,
            &artifact,
        )
        .await;
    }
    drop(existing_guard);

    nemo.verify_again()?;
    let temporary = TempDirBuilder::new()
        .prefix(".nemo-transcribe-")
        .tempdir_in(input.app_cache_root)
        .map_err(|_| VideoCommandError::project_io(OPERATION, "temporary_audio"))?;
    let wav_path = temporary.path().join("input.wav");

    extract_pcm_wav(
        &ffmpeg_program,
        input.source_path,
        &wav_path,
        cancellation.clone(),
    )
    .await?;
    validate_pcm_wav(&wav_path)?;

    nemo.verify_again()?;
    let output = run_nemo(&nemo, &wav_path, cancellation).await?;
    if !proves_cuda_device_zero(&output.stderr_tail) {
        return Err(VideoCommandError::process_failed(OPERATION, "nemo", None));
    }
    let chunk = parse_nemo_chunk(&output.stdout, input.source_duration_us)?;
    let artifact = create_transcript_artifact_v1(
        input.source_identity.clone(),
        input.source_fingerprint.clone(),
        input.source_duration_us,
        input.configuration.clone(),
        &[chunk],
    )
    .map_err(|_| transcript_invalid())?;

    publish_transcript_artifact(input.app_cache_root, cache, OWNER_LABEL, None, &artifact).await
}

async fn extract_pcm_wav(
    ffmpeg_program: &Path,
    source_path: &Path,
    wav_path: &Path,
    cancellation: ProcessCancellation,
) -> Result<(), VideoCommandError> {
    let args = [
        OsString::from("-nostdin"),
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-i"),
        source_path.as_os_str().to_owned(),
        OsString::from("-map"),
        OsString::from("0:a:0"),
        OsString::from("-vn"),
        OsString::from("-ac"),
        OsString::from("1"),
        OsString::from("-ar"),
        OsString::from("16000"),
        OsString::from("-c:a"),
        OsString::from("pcm_s16le"),
        OsString::from("-f"),
        OsString::from("wav"),
        OsString::from("-y"),
        wav_path.as_os_str().to_owned(),
    ];
    run_transcription_process(
        ProcessSpec {
            program: ffmpeg_program.as_os_str().to_owned(),
            args: args.into(),
            current_dir: None,
            operation: OPERATION,
            timeout: FFMPEG_TIMEOUT,
            stdout_limit: FFMPEG_STDOUT_LIMIT,
            stderr_tail_limit: FFMPEG_STDERR_TAIL_LIMIT,
        },
        cancellation,
        "ffmpeg",
    )
    .await
    .map(|_| ())
    .map_err(|failure| map_process_failure(failure, "ffmpeg"))
}

async fn run_nemo(
    nemo: &VerifiedNemoRuntime,
    wav_path: &Path,
    cancellation: ProcessCancellation,
) -> Result<super::process::SupervisedOutput, VideoCommandError> {
    let args = vec![
        OsString::from("--json"),
        OsString::from("--verbose"),
        OsString::from("transcribe"),
        wav_path.as_os_str().to_owned(),
        OsString::from("--model"),
        nemo.model.path.as_os_str().to_owned(),
        OsString::from("--device"),
        OsString::from("cuda:0"),
        OsString::from("--format"),
        OsString::from("json"),
    ];
    run_transcription_process(
        ProcessSpec {
            program: nemo.executable.path.as_os_str().to_owned(),
            args,
            current_dir: Some(nemo.dll_directory.clone()),
            operation: OPERATION,
            timeout: NEMO_TIMEOUT,
            stdout_limit: NEMO_STDOUT_LIMIT,
            stderr_tail_limit: NEMO_STDERR_TAIL_LIMIT,
        },
        cancellation,
        "nemo",
    )
    .await
    .map_err(|failure| map_process_failure(failure, "nemo"))
}

#[cfg(not(test))]
async fn run_transcription_process(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    _helper_kind: &'static str,
) -> Result<super::process::SupervisedOutput, ProcessFailure> {
    super::process::run_supervised(spec, cancellation).await
}

#[cfg(test)]
async fn run_transcription_process(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    helper_kind: &'static str,
) -> Result<super::process::SupervisedOutput, ProcessFailure> {
    use super::process::run_supervised_with_test_environment;

    let current_executable = std::env::current_exe().map_err(|_| ProcessFailure::Io {
        operation: OPERATION,
    })?;
    let original_arguments: Vec<String> = spec
        .args
        .iter()
        .map(|argument| argument.to_string_lossy().into_owned())
        .collect();
    let mut helper_spec = spec;
    helper_spec.program = current_executable.into_os_string();
    helper_spec.args = [
        "--exact",
        "video::tests::supervised_process_helper",
        "--nocapture",
        "--test-threads=1",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    let mut output = run_supervised_with_test_environment(
        helper_spec,
        cancellation,
        vec![
            (
                OsString::from("SUPA_VIDEO_PROCESS_HELPER_MODE"),
                Some(OsString::from(format!("nemo_runner_{helper_kind}"))),
            ),
            (
                OsString::from("SUPA_VIDEO_NEMO_HELPER_ARGUMENTS"),
                Some(OsString::from(
                    serde_json::to_string(&original_arguments).unwrap_or_default(),
                )),
            ),
        ],
    )
    .await?;
    if helper_kind == "nemo" {
        let start = output.stdout.iter().position(|byte| *byte == b'{');
        let end = output.stdout.iter().rposition(|byte| *byte == b'}');
        let (Some(start), Some(end)) = (start, end) else {
            return Err(ProcessFailure::Io {
                operation: OPERATION,
            });
        };
        output.stdout = output.stdout[start..=end].to_vec();
    }
    Ok(output)
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NemoJsonOutput {
    file: String,
    text: String,
    #[serde(default)]
    confidence: Option<f64>,
    duration: f64,
    #[serde(default)]
    languages: Vec<String>,
    words: Vec<NemoJsonWord>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct NemoJsonWord {
    word: String,
    start: f64,
    end: f64,
    #[serde(default)]
    confidence: Option<f64>,
    #[serde(default)]
    speaker: Option<serde_json::Value>,
}

fn parse_nemo_chunk(
    bytes: &[u8],
    source_duration_us: u64,
) -> Result<TranscriptChunkInputV1, VideoCommandError> {
    let parsed: NemoJsonOutput = serde_json::from_slice(bytes).map_err(|_| transcript_invalid())?;
    let _ = (
        &parsed.file,
        &parsed.confidence,
        parsed.duration,
        &parsed.languages,
    );
    if parsed.text.trim().is_empty() || parsed.words.is_empty() {
        return Err(transcript_invalid());
    }
    if normalized_text(&parsed.text).is_empty() {
        return Err(transcript_invalid());
    }

    let mut words = Vec::with_capacity(parsed.words.len());
    let mut previous_end_us = 0_i64;
    for raw in parsed.words {
        if raw.word.trim().is_empty() || raw.speaker.is_some() {
            return Err(transcript_invalid());
        }
        let start_us = seconds_to_microseconds(raw.start)?;
        let end_us = seconds_to_microseconds(raw.end)?;
        if start_us < previous_end_us || end_us <= start_us || end_us as u64 > source_duration_us {
            return Err(transcript_invalid());
        }
        if raw
            .confidence
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            return Err(transcript_invalid());
        }
        previous_end_us = end_us;
        words.push(TranscriptChunkWordInputV1 {
            text: raw.word,
            relative_start_us: start_us,
            relative_end_us: end_us,
            recognition_confidence: raw.confidence,
            speaker_label: None,
            speaker_confidence: None,
            timing_provenance: TimingProvenanceV1::Aligned,
        });
    }

    let words_text = words
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if normalized_text(&parsed.text) != normalized_text(&words_text) {
        return Err(transcript_invalid());
    }

    let source_end_us = i64::try_from(source_duration_us).map_err(|_| transcript_invalid())?;
    Ok(TranscriptChunkInputV1 {
        schema_version: 1,
        chunk_id: "chunk-0000".to_owned(),
        chunk_index: 0,
        source_start_us: 0,
        source_end_us,
        words,
    })
}

fn seconds_to_microseconds(seconds: f64) -> Result<i64, VideoCommandError> {
    if !seconds.is_finite() || seconds < 0.0 {
        return Err(transcript_invalid());
    }
    let microseconds = seconds * 1_000_000.0;
    if !microseconds.is_finite() || microseconds > MAX_SAFE_INTEGER as f64 {
        return Err(transcript_invalid());
    }
    let rounded = microseconds.round();
    if (microseconds - rounded).abs() > 0.001 {
        return Err(transcript_invalid());
    }
    Ok(rounded as i64)
}

fn normalized_text(text: &str) -> String {
    text.chars()
        .filter(|character| character.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn validate_configuration(
    configuration: &AsrConfigurationV1,
    source_duration_us: u64,
    nemo: &VerifiedNemoRuntime,
) -> Result<(), VideoCommandError> {
    derive_asr_configuration_identity(configuration).map_err(|_| transcript_invalid())?;
    if configuration.engine_id != "nemo-speech.cpp"
        || configuration.requested_language.as_deref() != Some("en")
        || configuration.task != AsrTaskV1::Transcribe
        || !configuration.word_timing_required
        || configuration.speaker_diarization_mode != SpeakerDiarizationModeV1::Off
        || configuration.chunk_duration_us != source_duration_us
        || configuration.chunk_overlap_us != 0
    {
        return Err(transcript_invalid());
    }

    let expected = [
        ("device", "cuda:0"),
        ("gguf_sha256", nemo.model.sha256.as_str()),
        ("quantization", "q8_0"),
        ("runtime_sha256", nemo.executable.sha256.as_str()),
    ];
    if configuration.provider_settings.len() != expected.len() {
        return Err(transcript_invalid());
    }
    for (setting, (key, value)) in configuration.provider_settings.iter().zip(expected) {
        if setting.key != key
            || setting.value != AsrProviderSettingValueV1::String(value.to_owned())
        {
            return Err(transcript_invalid());
        }
    }
    Ok(())
}

fn validate_source_path(source_path: &Path) -> Result<(), VideoCommandError> {
    let metadata = fs::symlink_metadata(source_path)
        .map_err(|_| VideoCommandError::invalid_media(OPERATION, "source_object"))?;
    if !metadata.is_file() || is_reparse_or_symlink(&metadata) {
        return Err(VideoCommandError::invalid_media(OPERATION, "source_object"));
    }
    let canonical = fs::canonicalize(source_path)
        .map_err(|_| VideoCommandError::invalid_media(OPERATION, "source_object"))?;
    if canonical != source_path {
        return Err(VideoCommandError::invalid_media(OPERATION, "source_object"));
    }
    Ok(())
}

fn verify_runtime_directory(path: &Path) -> Result<PathBuf, VideoCommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| nemo_unavailable())?;
    if !metadata.is_dir() || is_reparse_or_symlink(&metadata) {
        return Err(nemo_unavailable());
    }
    fs::canonicalize(path).map_err(|_| nemo_unavailable())
}

fn verify_runtime_file(mut file: VerifiedNemoFile) -> Result<VerifiedNemoFile, VideoCommandError> {
    if file.byte_length == 0 || !is_sha256(&file.sha256) {
        return Err(nemo_unavailable());
    }
    let metadata = fs::symlink_metadata(&file.path).map_err(|_| nemo_unavailable())?;
    if !metadata.is_file() || is_reparse_or_symlink(&metadata) || metadata.len() != file.byte_length
    {
        return Err(nemo_unavailable());
    }
    reject_linked_ancestors(&file.path)?;
    let canonical = fs::canonicalize(&file.path).map_err(|_| nemo_unavailable())?;
    if hash_file_exact(&canonical, file.byte_length)? != file.sha256 {
        return Err(nemo_unavailable());
    }
    file.path = canonical;
    Ok(file)
}

fn reject_linked_ancestors(path: &Path) -> Result<(), VideoCommandError> {
    let mut current = path.parent();
    while let Some(parent) = current {
        let metadata = fs::symlink_metadata(parent).map_err(|_| nemo_unavailable())?;
        if is_reparse_or_symlink(&metadata) {
            return Err(nemo_unavailable());
        }
        current = parent.parent();
    }
    Ok(())
}

fn hash_file_exact(path: &Path, expected_len: u64) -> Result<String, VideoCommandError> {
    let file = File::open(path).map_err(|_| nemo_unavailable())?;
    let mut reader = file.take(expected_len.saturating_add(1));
    let mut hasher = Sha256::new();
    let mut buffer = vec![0_u8; HASH_BUFFER_BYTES];
    let mut total = 0_u64;
    loop {
        let read = reader.read(&mut buffer).map_err(|_| nemo_unavailable())?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > expected_len {
            return Err(nemo_unavailable());
        }
        hasher.update(&buffer[..read]);
    }
    if total != expected_len {
        return Err(nemo_unavailable());
    }
    Ok(format!("{:x}", hasher.finalize()))
}

fn validate_pcm_wav(path: &Path) -> Result<(), VideoCommandError> {
    let invalid = || VideoCommandError::invalid_media(OPERATION, "extracted_audio");
    let metadata = fs::symlink_metadata(path).map_err(|_| invalid())?;
    if !metadata.is_file() || is_reparse_or_symlink(&metadata) || metadata.len() < 44 {
        return Err(invalid());
    }
    let mut file = File::open(path).map_err(|_| invalid())?;
    let mut riff = [0_u8; 12];
    file.read_exact(&mut riff).map_err(|_| invalid())?;
    if &riff[0..4] != b"RIFF" || &riff[8..12] != b"WAVE" {
        return Err(invalid());
    }

    let mut valid_format = false;
    let mut has_audio = false;
    while file.stream_position().map_err(|_| invalid())? + 8 <= metadata.len() {
        let mut chunk_header = [0_u8; 8];
        file.read_exact(&mut chunk_header).map_err(|_| invalid())?;
        let size = u32::from_le_bytes(chunk_header[4..8].try_into().map_err(|_| invalid())?) as u64;
        let data_start = file.stream_position().map_err(|_| invalid())?;
        let data_end = data_start.checked_add(size).ok_or_else(invalid)?;
        if data_end > metadata.len() {
            return Err(invalid());
        }
        if &chunk_header[0..4] == b"fmt " {
            if size < 16 {
                return Err(invalid());
            }
            let mut format = [0_u8; 16];
            file.read_exact(&mut format).map_err(|_| invalid())?;
            valid_format = u16::from_le_bytes([format[0], format[1]]) == 1
                && u16::from_le_bytes([format[2], format[3]]) == 1
                && u32::from_le_bytes([format[4], format[5], format[6], format[7]]) == 16_000
                && u16::from_le_bytes([format[14], format[15]]) == 16;
        } else if &chunk_header[0..4] == b"data" {
            has_audio = size > 0;
        }
        let next = data_end.checked_add(size % 2).ok_or_else(invalid)?;
        if next > metadata.len() {
            return Err(invalid());
        }
        file.seek(SeekFrom::Start(next)).map_err(|_| invalid())?;
    }
    if !valid_format || !has_audio {
        return Err(invalid());
    }
    Ok(())
}

fn proves_cuda_device_zero(stderr: &[u8]) -> bool {
    let diagnostics = String::from_utf8_lossy(stderr).to_ascii_lowercase();
    diagnostics.contains("cuda")
        && (diagnostics.contains("cuda:0")
            || diagnostics.contains("cuda device 0")
            || diagnostics.contains("device=0"))
}

fn map_process_failure(failure: ProcessFailure, executable: &'static str) -> VideoCommandError {
    match failure {
        ProcessFailure::Spawn {
            kind: std::io::ErrorKind::NotFound,
            ..
        } => VideoCommandError::tool_unavailable(OPERATION, executable),
        ProcessFailure::Timeout { .. } => VideoCommandError::process_timeout(OPERATION, executable),
        ProcessFailure::Cancelled { .. } => {
            VideoCommandError::process_cancelled(OPERATION, executable)
        }
        ProcessFailure::StdoutLimit { limit, .. } => {
            VideoCommandError::process_output_limit(OPERATION, executable, limit)
        }
        ProcessFailure::NonZero { exit_code, .. } => {
            VideoCommandError::process_failed(OPERATION, executable, exit_code)
        }
        ProcessFailure::Spawn { .. } | ProcessFailure::Io { .. } => {
            VideoCommandError::process_failed(OPERATION, executable, None)
        }
    }
}

fn nemo_unavailable() -> VideoCommandError {
    VideoCommandError::tool_unavailable(OPERATION, "nemo")
}

fn transcript_invalid() -> VideoCommandError {
    VideoCommandError::invalid_media(OPERATION, "transcript_artifact_invalid")
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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
