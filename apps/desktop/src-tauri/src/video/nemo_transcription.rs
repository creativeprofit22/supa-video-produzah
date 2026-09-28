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
/// The pinned Sortformer diarizer tracks at most four speakers. The runtime
/// numbers them from 1 and omits `speaker` for untagged words.
const MAX_DIARIZED_SPEAKERS: u64 = 4;

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
    diarizer: Option<VerifiedNemoFile>,
}

impl VerifiedNemoRuntime {
    pub(crate) fn directory(&self) -> &Path {
        &self.dll_directory
    }

    /// Whether a hash-verified speaker diarizer is available.
    pub(crate) fn has_diarizer(&self) -> bool {
        self.diarizer.is_some()
    }

    pub(crate) fn new(
        executable: VerifiedNemoFile,
        dll_directory: PathBuf,
        required_dlls: Vec<VerifiedNemoFile>,
        model: VerifiedNemoFile,
        diarizer: Option<VerifiedNemoFile>,
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
            diarizer: diarizer.map(verify_runtime_file).transpose()?,
        })
    }

    fn verify_again(&self) -> Result<(), VideoCommandError> {
        let directory = verify_runtime_directory(&self.dll_directory)?;
        if directory != self.dll_directory {
            return Err(nemo_unavailable());
        }
        verify_runtime_file(self.executable.clone())?;
        verify_runtime_file(self.model.clone())?;
        if let Some(diarizer) = &self.diarizer {
            verify_runtime_file(diarizer.clone())?;
        }
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
    let diarization = validate_configuration(input.configuration, input.source_duration_us, &nemo)?;
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
    let output = run_nemo(&nemo, &wav_path, diarization, cancellation).await?;
    if !proves_cuda_device_zero(&output.stderr_tail) {
        // Not retryable: rerunning on the same machine cannot produce GPU proof.
        return Err(cuda_not_proven());
    }
    let chunk = parse_nemo_chunk(&output.stdout, input.source_duration_us, diarization)?;
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
    diarization: Diarization,
    cancellation: ProcessCancellation,
) -> Result<super::process::SupervisedOutput, VideoCommandError> {
    let mut args = vec![
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
    if diarization != Diarization::Off {
        // validate_configuration only returns a non-Off mode with a diarizer.
        let diarizer = nemo
            .diarizer
            .as_ref()
            .ok_or_else(speaker_diarizer_missing)?;
        args.extend([
            OsString::from("--diar-model"),
            diarizer.path.as_os_str().to_owned(),
            OsString::from("--max-speaker-count"),
            OsString::from(MAX_DIARIZED_SPEAKERS.to_string()),
        ]);
    }
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
pub(crate) const REAL_ASR_PROOF_ENV: &str = "SUPA_VIDEO_REAL_ASR_PROOF";

#[cfg(test)]
async fn run_transcription_process(
    spec: ProcessSpec,
    cancellation: ProcessCancellation,
    helper_kind: &'static str,
) -> Result<super::process::SupervisedOutput, ProcessFailure> {
    use super::process::run_supervised_with_test_environment;

    // The ignored real-GPU proof opts back into the production process path.
    if std::env::var_os(REAL_ASR_PROOF_ENV).is_some_and(|value| value == "1") {
        return super::process::run_supervised(spec, cancellation).await;
    }
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

/// How speaker labels are produced for one run, after validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Diarization {
    /// No diarizer argument; any `speaker` field in the output is invalid.
    Off,
    /// Labels when the diarizer tags a word; untagged words stay unlabelled.
    Optional,
    /// Like `Optional`, but a run with no labelled word fails.
    Required,
}

/// Maps the runtime's 1-based speaker index to a stable identifier.
fn speaker_label(
    value: Option<&serde_json::Value>,
    diarization: Diarization,
) -> Result<Option<String>, VideoCommandError> {
    let Some(value) = value else {
        return Ok(None);
    };
    if diarization == Diarization::Off {
        return Err(transcript_invalid());
    }
    match value.as_u64() {
        Some(index @ 1..=MAX_DIARIZED_SPEAKERS) => Ok(Some(format!("speaker_{index}"))),
        _ => Err(transcript_invalid()),
    }
}

fn parse_nemo_chunk(
    bytes: &[u8],
    source_duration_us: u64,
    diarization: Diarization,
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

    let mut words: Vec<TranscriptChunkWordInputV1> = Vec::with_capacity(parsed.words.len());
    for raw in parsed.words {
        if raw.word.trim().is_empty() {
            return Err(transcript_invalid());
        }
        let speaker_label = speaker_label(raw.speaker.as_ref(), diarization)?;
        let start_us = seconds_to_microseconds(raw.start)?;
        let end_us = seconds_to_microseconds(raw.end)?;
        if end_us <= start_us || end_us as u64 > source_duration_us {
            return Err(transcript_invalid());
        }
        if raw
            .confidence
            .is_some_and(|value| !value.is_finite() || !(0.0..=1.0).contains(&value))
        {
            return Err(transcript_invalid());
        }
        let mut word = TranscriptChunkWordInputV1 {
            text: raw.word,
            relative_start_us: start_us,
            relative_end_us: end_us,
            recognition_confidence: raw.confidence,
            speaker_label,
            // The runtime emits no per-word speaker confidence; none is invented.
            speaker_confidence: None,
            timing_provenance: TimingProvenanceV1::Aligned,
        };
        if let Some(previous) = words.last_mut() {
            repair_word_overlap(previous, &mut word)?;
        }
        words.push(word);
    }

    let words_text = words
        .iter()
        .map(|word| word.text.as_str())
        .collect::<Vec<_>>()
        .join(" ");
    if normalized_text(&parsed.text) != normalized_text(&words_text) {
        return Err(transcript_invalid());
    }
    if diarization == Diarization::Required && words.iter().all(|word| word.speaker_label.is_none())
    {
        return Err(speaker_labels_missing());
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

/// The streaming ASR emits word times on an 80 ms frame grid, and on real
/// speech it sometimes lets a word's end run past the next word's start, or
/// gives two words the same frame. Such output is in order but overlapping.
/// It is repaired instead of discarding the whole transcript, and the repair
/// is recorded in the word's timing provenance (so the artifact counts it):
///
/// - the next word starts inside the previous one: the previous word's end is
///   pulled back to that start (`Clamped`);
/// - both start together (or the word starts inside an earlier repaired
///   split of the same frame): their combined span is split evenly
///   (`Estimated`).
///
/// A word that ends before the previous word starts is out of order and
/// still rejects the transcript.
fn repair_word_overlap(
    previous: &mut TranscriptChunkWordInputV1,
    word: &mut TranscriptChunkWordInputV1,
) -> Result<(), VideoCommandError> {
    if word.relative_start_us >= previous.relative_end_us {
        return Ok(());
    }
    if word.relative_end_us <= previous.relative_start_us {
        return Err(transcript_invalid());
    }
    if word.relative_start_us > previous.relative_start_us {
        previous.relative_end_us = word.relative_start_us;
        if previous.timing_provenance == TimingProvenanceV1::Aligned {
            previous.timing_provenance = TimingProvenanceV1::Clamped;
        }
        return Ok(());
    }
    let start = previous.relative_start_us;
    let end = previous.relative_end_us.max(word.relative_end_us);
    let middle = start + (end - start) / 2;
    if middle <= start || end <= middle {
        return Err(transcript_invalid());
    }
    previous.relative_end_us = middle;
    previous.timing_provenance = TimingProvenanceV1::Estimated;
    word.relative_start_us = middle;
    word.relative_end_us = end;
    word.timing_provenance = TimingProvenanceV1::Estimated;
    Ok(())
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

/// Validates the configuration against the verified runtime and returns how
/// speaker labels are produced. A `diarizer_sha256` setting is required for
/// `optional`/`required` and forbidden for `off`, so the diarizer is always
/// part of the transcript identity when it is used.
fn validate_configuration(
    configuration: &AsrConfigurationV1,
    source_duration_us: u64,
    nemo: &VerifiedNemoRuntime,
) -> Result<Diarization, VideoCommandError> {
    derive_asr_configuration_identity(configuration).map_err(|_| transcript_invalid())?;
    let diarization = match configuration.speaker_diarization_mode {
        SpeakerDiarizationModeV1::Off => Diarization::Off,
        SpeakerDiarizationModeV1::Optional => Diarization::Optional,
        SpeakerDiarizationModeV1::Required => Diarization::Required,
    };
    let diarizer_setting = configuration
        .provider_settings
        .iter()
        .find(|setting| setting.key == "diarizer_sha256");
    if diarization != Diarization::Off {
        let Some(diarizer) = &nemo.diarizer else {
            return Err(speaker_diarizer_missing());
        };
        let matches = matches!(
            diarizer_setting.map(|setting| &setting.value),
            Some(AsrProviderSettingValueV1::String(value)) if *value == diarizer.sha256
        );
        if !matches {
            return Err(transcript_invalid());
        }
    } else if diarizer_setting.is_some() {
        return Err(transcript_invalid());
    }
    if configuration.engine_id != "nemo-speech.cpp"
        || configuration.requested_language.as_deref() != Some("en")
        || configuration.task != AsrTaskV1::Transcribe
        || !configuration.word_timing_required
        || configuration.chunk_duration_us != source_duration_us
        || configuration.chunk_overlap_us != 0
    {
        return Err(transcript_invalid());
    }

    // Keys are already strictly sorted by the identity validation above.
    // `runtime_manifest_sha256` is optional so the pinned DLL set can be part
    // of the transcript identity without forcing it on every caller.
    let required = [
        ("device", "cuda:0"),
        ("gguf_sha256", nemo.model.sha256.as_str()),
        ("quantization", "q8_0"),
        ("runtime_sha256", nemo.executable.sha256.as_str()),
    ];
    let mut matched = 0;
    for setting in &configuration.provider_settings {
        let AsrProviderSettingValueV1::String(value) = &setting.value else {
            return Err(transcript_invalid());
        };
        if setting.key == "runtime_manifest_sha256" {
            if !is_sha256(value) {
                return Err(transcript_invalid());
            }
            continue;
        }
        if setting.key == "diarizer_sha256" {
            // Already matched against the verified diarizer above.
            continue;
        }
        let Some((_, expected)) = required.iter().find(|(key, _)| *key == setting.key) else {
            return Err(transcript_invalid());
        };
        if value != expected {
            return Err(transcript_invalid());
        }
        matched += 1;
    }
    if matched != required.len() {
        return Err(transcript_invalid());
    }
    Ok(diarization)
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

/// NeMo-Speech.cpp at the pinned commit logs `Using GPU backend: CUDA0` only
/// after it actually selected the CUDA device; `device=0` alone is printed
/// before backend selection and does not prove GPU execution.
fn proves_cuda_device_zero(stderr: &[u8]) -> bool {
    String::from_utf8_lossy(stderr)
        .to_ascii_lowercase()
        .contains("using gpu backend: cuda0")
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

pub(crate) fn cuda_not_proven() -> VideoCommandError {
    VideoCommandError::new(
        super::error::VideoErrorCode::ToolUnavailable,
        "The speech-recognition runtime did not prove it ran on CUDA device 0",
        serde_json::json!({
            "operation": OPERATION,
            "executable": "nemo",
            "category": "cuda_not_proven",
        }),
    )
}

/// `required` speaker labels were requested but no verified diarizer exists.
pub(crate) fn speaker_diarizer_missing() -> VideoCommandError {
    VideoCommandError::new(
        super::error::VideoErrorCode::ToolUnavailable,
        "Speaker labels need the speaker-detection model in the speech-recognition runtime folder",
        serde_json::json!({
            "operation": OPERATION,
            "executable": "nemo",
            "category": "speaker_diarizer_missing",
        }),
    )
}

/// `required` speaker labels were requested but the diarizer labelled no word.
fn speaker_labels_missing() -> VideoCommandError {
    VideoCommandError::invalid_media(OPERATION, "speaker_labels_missing")
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

pub(crate) fn is_reparse_or_symlink(metadata: &Metadata) -> bool {
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

#[cfg(test)]
mod speaker_mapping_tests {
    use super::*;

    const SOURCE_US: u64 = 4_000_000;

    fn output(speakers: &[serde_json::Value]) -> Vec<u8> {
        let texts = ["Hi", "there", "hello", "back"];
        let words: Vec<serde_json::Value> = speakers
            .iter()
            .enumerate()
            .map(|(index, speaker)| {
                let mut word = serde_json::json!({
                    "word": texts[index],
                    "start": index as f64 * 0.5,
                    "end": index as f64 * 0.5 + 0.25,
                    "confidence": 0.9,
                });
                if !speaker.is_null() {
                    word["speaker"] = speaker.clone();
                }
                word
            })
            .collect();
        let text = texts[..speakers.len()].join(" ");
        serde_json::to_vec(&serde_json::json!({
            "file": "input.wav",
            "text": text,
            "duration": 2.0,
            "words": words,
        }))
        .unwrap()
    }

    fn labels(chunk: &TranscriptChunkInputV1) -> Vec<Option<&str>> {
        chunk
            .words
            .iter()
            .map(|word| word.speaker_label.as_deref())
            .collect()
    }

    #[test]
    fn mixed_and_missing_speakers_map_to_stable_labels() {
        let bytes = output(&[
            serde_json::json!(1),
            serde_json::json!(1),
            serde_json::json!(2),
            serde_json::Value::Null,
        ]);
        for mode in [Diarization::Optional, Diarization::Required] {
            let chunk = parse_nemo_chunk(&bytes, SOURCE_US, mode).unwrap();
            assert_eq!(
                labels(&chunk),
                [
                    Some("speaker_1"),
                    Some("speaker_1"),
                    Some("speaker_2"),
                    None
                ]
            );
            assert!(chunk
                .words
                .iter()
                .all(|word| word.speaker_confidence.is_none()));
        }
    }

    #[test]
    fn out_of_range_or_non_integer_speakers_are_rejected() {
        for speaker in [
            serde_json::json!(0),
            serde_json::json!(5),
            serde_json::json!(-1),
            serde_json::json!(1.5),
            serde_json::json!("1"),
            serde_json::json!(true),
        ] {
            let bytes = output(std::slice::from_ref(&speaker));
            assert!(
                parse_nemo_chunk(&bytes, SOURCE_US, Diarization::Optional).is_err(),
                "speaker {speaker} must be rejected"
            );
        }
    }

    /// Word shapes taken from a real 5-minute NeMo run (HWHAP episode 436).
    fn timed(words: &[(&str, f64, f64)]) -> Vec<u8> {
        let text = words
            .iter()
            .map(|(word, _, _)| *word)
            .collect::<Vec<_>>()
            .join(" ");
        let words: Vec<_> = words
            .iter()
            .map(|(word, start, end)| serde_json::json!({"word": word, "start": start, "end": end}))
            .collect();
        serde_json::to_vec(&serde_json::json!({
            "file": "a.wav",
            "text": text,
            "duration": 1.0,
            "words": words
        }))
        .unwrap()
    }

    fn ranges(chunk: &TranscriptChunkInputV1) -> Vec<(i64, i64, TimingProvenanceV1)> {
        chunk
            .words
            .iter()
            .map(|word| {
                (
                    word.relative_start_us,
                    word.relative_end_us,
                    word.timing_provenance,
                )
            })
            .collect()
    }

    #[test]
    fn overlapping_runtime_word_times_are_repaired_and_marked() {
        use TimingProvenanceV1::{Aligned, Clamped, Estimated};
        // "today." runs past the start of "So"; "much" and "for" share a frame.
        let bytes = timed(&[
            ("today.", 11.68, 13.2),
            ("So", 13.12, 13.2),
            ("much", 14.12, 14.2),
            ("for", 14.12, 14.2),
            ("being", 14.2, 14.36),
        ]);
        let chunk = parse_nemo_chunk(&bytes, 20_000_000, Diarization::Off).unwrap();
        assert_eq!(
            ranges(&chunk),
            [
                (11_680_000, 13_120_000, Clamped),
                (13_120_000, 13_200_000, Aligned),
                (14_120_000, 14_160_000, Estimated),
                (14_160_000, 14_200_000, Estimated),
                (14_200_000, 14_360_000, Aligned),
            ]
        );
        for pair in chunk.words.windows(2) {
            assert!(pair[0].relative_end_us <= pair[1].relative_start_us);
        }
    }

    #[test]
    fn three_words_sharing_a_frame_stay_ordered_and_non_empty() {
        let bytes = timed(&[("a", 1.12, 1.2), ("b", 1.12, 1.2), ("c", 1.12, 1.2)]);
        let chunk = parse_nemo_chunk(&bytes, 2_000_000, Diarization::Off);
        let chunk = chunk.unwrap();
        assert_eq!(
            ranges(&chunk)
                .into_iter()
                .map(|(start, end, _)| (start, end))
                .collect::<Vec<_>>(),
            [
                (1_120_000, 1_160_000),
                (1_160_000, 1_180_000),
                (1_180_000, 1_200_000)
            ]
        );
        assert!(chunk
            .words
            .iter()
            .all(|word| word.timing_provenance == TimingProvenanceV1::Estimated));
    }

    #[test]
    fn out_of_order_runtime_words_are_still_rejected() {
        let bytes = timed(&[("late", 2.0, 2.4), ("early", 1.0, 1.2)]);
        assert!(parse_nemo_chunk(&bytes, 3_000_000, Diarization::Off).is_err());
    }

    #[test]
    fn speaker_without_diarization_is_rejected() {
        let bytes = output(&[serde_json::json!(1)]);
        assert!(parse_nemo_chunk(&bytes, SOURCE_US, Diarization::Off).is_err());
    }

    #[test]
    fn required_labels_fail_bounded_when_no_word_is_labelled() {
        let bytes = output(&[serde_json::Value::Null, serde_json::Value::Null]);
        assert!(parse_nemo_chunk(&bytes, SOURCE_US, Diarization::Optional).is_ok());
        let error = parse_nemo_chunk(&bytes, SOURCE_US, Diarization::Required).unwrap_err();
        assert_eq!(error.code, speaker_labels_missing().code);
        assert_eq!(error.details, speaker_labels_missing().details);
    }
}
