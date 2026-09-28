use std::{
    ffi::OsString,
    fs::{self, File, Metadata},
    io::{BufWriter, Read, Seek, SeekFrom, Write},
    ops::Range,
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
/// Per-process limit for the whole-file speaker pass (measured 174 s for 50 min).
const NEMO_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
/// Per-process limit for one transcription piece of at most `MAX_PIECE_US`
/// (measured 13–17 s each), so a stuck run is caught within 30 minutes.
const NEMO_PIECE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const FFMPEG_STDOUT_LIMIT: usize = 64 * 1024;
const FFMPEG_STDERR_TAIL_LIMIT: usize = 256 * 1024;
const NEMO_STDOUT_LIMIT: usize = 128 * 1024 * 1024;
const NEMO_STDERR_TAIL_LIMIT: usize = 512 * 1024;
const HASH_BUFFER_BYTES: usize = 1024 * 1024;
const OWNER_LABEL: &str = "nemo-transcription";
/// The pinned Sortformer diarizer tracks at most four speakers. The runtime
/// numbers them from 1 and omits `speaker` for untagged words.
const MAX_DIARIZED_SPEAKERS: u64 = 4;
/// Longest audio one transcription run sees. Up to this length the runtime
/// stays in its full-quality (offline) mode and GPU memory stays bounded; past
/// about 6.5 minutes it silently switches to chunked mode and quality drops.
pub(crate) const MAX_PIECE_US: u64 = 240_000_000;
/// A cut is searched for in this last fraction of each piece.
const CUT_SEARCH_FRACTION: f64 = 0.2;
/// Energy is compared over windows of this length.
const CUT_WINDOW_US: u64 = 250_000;
/// A window quieter than this RMS (about −35 dBFS, the probe's silence
/// threshold) is a valid cut; if none is, the cut lands at the limit.
const QUIET_WINDOW_RMS: u64 = 583;
const PCM_SAMPLE_RATE: u32 = 16_000;
const PCM_HEADER_BYTES: u64 = 44;
/// The diarizer's JSON for a 50-minute file is about 20 KB.
const DIARIZE_OUTPUT_LIMIT: u64 = 16 * 1024 * 1024;
const MAX_DIARIZED_SEGMENTS: usize = 1_000_000;
/// A word outside every speaker segment takes the nearest one within this gap.
const SPEAKER_FALLBACK_US: i64 = 500_000;
/// How far past its audio the runtime may place a word or speaker end. Times
/// sit on an 80 ms frame grid and the final partial frame is rounded up; the
/// 50-minute run measured up to 105 ms, so two frames are allowed.
const RUNTIME_END_TOLERANCE_US: i64 = 160_000;
/// The runtime's word-timing grid (one encoder frame).
const RUNTIME_FRAME_US: i64 = 80_000;
/// `segmentation` provider setting: bounded full-quality pieces cut at quiet
/// moments by [`plan_transcription_pieces`].
pub(crate) const SEGMENTATION_SETTING: &str = "segmentation";
pub(crate) const SEGMENTATION_VALUE: &str = "silence-cut-v1";
/// `diarization_pass` provider setting: one whole-file streaming speaker pass.
pub(crate) const DIARIZATION_PASS_SETTING: &str = "diarization_pass";
pub(crate) const DIARIZATION_PASS_VALUE: &str = "whole-file-streaming-v1";

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
    let layout = validate_pcm_wav(&wav_path)?;
    let pcm = read_pcm_samples(
        &wav_path,
        layout,
        samples_for_duration(input.source_duration_us),
    )?;
    let pieces = place_pieces(&pcm, input.source_duration_us)?;

    let mut chunks = Vec::with_capacity(pieces.len());
    for piece in &pieces {
        if cancellation.is_cancelled() {
            return Err(VideoCommandError::process_cancelled(OPERATION, "nemo"));
        }
        let piece_path = temporary
            .path()
            .join(format!("piece-{:04}.wav", piece.index));
        write_piece_wav(&pcm[piece.samples.clone()], &piece_path)?;
        validate_pcm_wav(&piece_path)?;
        nemo.verify_again()?;
        let output = run_nemo_piece(&nemo, &piece_path, cancellation.clone()).await?;
        if !proves_cuda_device_zero(&output.stderr_tail) {
            // Not retryable: rerunning on the same machine cannot produce GPU proof.
            return Err(cuda_not_proven());
        }
        chunks.push(parse_nemo_chunk(&output.stdout, piece)?);
        fs::remove_file(&piece_path)
            .map_err(|_| VideoCommandError::project_io(OPERATION, "temporary_audio"))?;
    }
    drop(pcm);
    if chunks.iter().all(|chunk| chunk.words.is_empty()) {
        // The whole file has no speech: today's no-speech result.
        return Err(transcript_invalid());
    }

    if diarization != Diarization::Off {
        if cancellation.is_cancelled() {
            return Err(VideoCommandError::process_cancelled(OPERATION, "nemo"));
        }
        nemo.verify_again()?;
        let segments_path = temporary.path().join("speakers.json");
        let output = run_nemo_diarize(&nemo, &wav_path, &segments_path, cancellation).await?;
        if !proves_cuda_device_zero(&output.stderr_tail) {
            return Err(cuda_not_proven());
        }
        let segments = read_diarized_segments(&segments_path, input.source_duration_us)?;
        label_chunk_speakers(&mut chunks, &segments);
        if diarization == Diarization::Required
            && chunks
                .iter()
                .flat_map(|chunk| &chunk.words)
                .all(|word| word.speaker_label.is_none())
        {
            return Err(speaker_labels_missing());
        }
    }

    let artifact = create_transcript_artifact_v1(
        input.source_identity.clone(),
        input.source_fingerprint.clone(),
        input.source_duration_us,
        input.configuration.clone(),
        &chunks,
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

/// Transcribes one piece in full-quality mode. The speaker model is never
/// passed here: it would push the run into chunked mode on long input and
/// label speakers per piece; speakers come from [`run_nemo_diarize`].
async fn run_nemo_piece(
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
            timeout: NEMO_PIECE_TIMEOUT,
            stdout_limit: NEMO_STDOUT_LIMIT,
            stderr_tail_limit: NEMO_STDERR_TAIL_LIMIT,
        },
        cancellation,
        "nemo",
    )
    .await
    .map_err(|failure| map_process_failure(failure, "nemo"))
}

/// One streaming speaker pass over the whole file. Streaming Sortformer keeps
/// a speaker memory across its internal chunks, so labels stay consistent for
/// the whole recording while GPU memory stays flat. The JSON goes to a fresh
/// file in the private temporary directory.
async fn run_nemo_diarize(
    nemo: &VerifiedNemoRuntime,
    wav_path: &Path,
    output_path: &Path,
    cancellation: ProcessCancellation,
) -> Result<super::process::SupervisedOutput, VideoCommandError> {
    // validate_configuration only returns a non-Off mode with a diarizer.
    let diarizer = nemo
        .diarizer
        .as_ref()
        .ok_or_else(speaker_diarizer_missing)?;
    let args = vec![
        OsString::from("diarize"),
        wav_path.as_os_str().to_owned(),
        OsString::from("--model"),
        diarizer.path.as_os_str().to_owned(),
        OsString::from("--device"),
        OsString::from("cuda:0"),
        OsString::from("--preset"),
        OsString::from("streaming"),
        OsString::from("--format"),
        OsString::from("json"),
        OsString::from("-o"),
        output_path.as_os_str().to_owned(),
    ];
    run_transcription_process(
        ProcessSpec {
            program: nemo.executable.path.as_os_str().to_owned(),
            args,
            current_dir: Some(nemo.dll_directory.clone()),
            operation: OPERATION,
            timeout: NEMO_TIMEOUT,
            stdout_limit: FFMPEG_STDOUT_LIMIT,
            stderr_tail_limit: NEMO_STDERR_TAIL_LIMIT,
        },
        cancellation,
        "diarize",
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

/// How speaker labels are produced for the job, after validation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Diarization {
    /// No speaker pass.
    Off,
    /// Labels from the speaker pass; words outside every segment stay unlabelled.
    Optional,
    /// Like `Optional`, but a job with no labelled word fails.
    Required,
}

/// One planned transcription piece: its sample range in the extracted PCM
/// and its `[start, end)` span on the source timeline in microseconds.
#[derive(Debug, Clone, PartialEq, Eq)]
struct PlannedPiece {
    index: u64,
    samples: Range<usize>,
    source_start_us: i64,
    source_end_us: i64,
}

/// Splits PCM into contiguous, non-overlapping sample ranges that cover it,
/// each at most `max_piece_us` long. Audio of `max_piece_us` or less stays one
/// piece. Otherwise each cut lands in the middle of the quietest
/// `CUT_WINDOW_US` window in the last `CUT_SEARCH_FRACTION` before the limit,
/// or exactly at the limit when every window there is loud.
fn plan_transcription_pieces(
    pcm: &[i16],
    sample_rate: u32,
    max_piece_us: u64,
) -> Vec<Range<usize>> {
    let per_us = |us: u64| (u128::from(us) * u128::from(sample_rate) / 1_000_000) as usize;
    let max_samples = per_us(max_piece_us).max(1);
    let window = per_us(CUT_WINDOW_US).clamp(1, max_samples);
    let search = ((max_samples as f64 * CUT_SEARCH_FRACTION) as usize).clamp(window, max_samples);
    let quiet_sum = (QUIET_WINDOW_RMS * QUIET_WINDOW_RMS) as u128 * window as u128;

    let mut pieces = Vec::new();
    let mut start = 0_usize;
    while pcm.len() - start > max_samples {
        let limit = start + max_samples;
        let region = limit - search..limit;
        let energy = |sample: &i16| {
            let value = i64::from(*sample);
            (value * value) as u128
        };
        // Sliding window sum of squares; the latest quietest window wins ties.
        let mut sum: u128 = pcm[region.start..region.start + window]
            .iter()
            .map(energy)
            .sum();
        let mut best = (sum, region.start);
        for window_start in region.start + 1..=limit - window {
            sum = sum + energy(&pcm[window_start + window - 1]) - energy(&pcm[window_start - 1]);
            if sum <= best.0 {
                best = (sum, window_start);
            }
        }
        let cut = if best.0 <= quiet_sum {
            best.1 + window / 2
        } else {
            limit
        };
        pieces.push(start..cut);
        start = cut;
    }
    if start < pcm.len() || pieces.is_empty() {
        pieces.push(start..pcm.len());
    }
    pieces
}

/// Samples covering `duration_us` at 16 kHz, rounded up.
fn samples_for_duration(duration_us: u64) -> u64 {
    (u128::from(duration_us) * u128::from(PCM_SAMPLE_RATE)).div_ceil(1_000_000) as u64
}

fn sample_to_us(sample: usize) -> i64 {
    (sample as u128 * 1_000_000 / u128::from(PCM_SAMPLE_RATE)) as i64
}

/// Places the planned sample ranges on the source timeline. The last piece
/// ends exactly at the source duration, and adjacent pieces share bounds.
fn place_pieces(
    pcm: &[i16],
    source_duration_us: u64,
) -> Result<Vec<PlannedPiece>, VideoCommandError> {
    let ranges = plan_transcription_pieces(pcm, PCM_SAMPLE_RATE, MAX_PIECE_US);
    let source_end = i64::try_from(source_duration_us).map_err(|_| transcript_invalid())?;
    let count = ranges.len();
    ranges
        .into_iter()
        .enumerate()
        .map(|(index, samples)| {
            let source_start_us = sample_to_us(samples.start);
            let source_end_us = if index + 1 == count {
                source_end
            } else {
                sample_to_us(samples.end)
            };
            if samples.is_empty() || source_end_us <= source_start_us {
                return Err(transcript_invalid());
            }
            Ok(PlannedPiece {
                index: index as u64,
                samples,
                source_start_us,
                source_end_us,
            })
        })
        .collect()
}

/// Parses one piece's runtime output into its chunk. Word times are relative
/// to the piece. The runtime's exact no-speech shape (exit 0, `text` `""`,
/// `words` `[]`, confirmed on silence and music) becomes a zero-word chunk;
/// every other output keeps the full checks.
fn parse_nemo_chunk(
    bytes: &[u8],
    piece: &PlannedPiece,
) -> Result<TranscriptChunkInputV1, VideoCommandError> {
    let parsed: NemoJsonOutput = serde_json::from_slice(bytes).map_err(|_| transcript_invalid())?;
    let _ = (
        &parsed.file,
        &parsed.confidence,
        parsed.duration,
        &parsed.languages,
    );
    let chunk = |words| TranscriptChunkInputV1 {
        schema_version: 1,
        chunk_id: format!("chunk-{:04}", piece.index),
        chunk_index: piece.index,
        source_start_us: piece.source_start_us,
        source_end_us: piece.source_end_us,
        words,
    };
    if parsed.text.is_empty() && parsed.words.is_empty() {
        return Ok(chunk(Vec::new()));
    }
    if parsed.text.trim().is_empty() || parsed.words.is_empty() {
        return Err(transcript_invalid());
    }
    if normalized_text(&parsed.text).is_empty() {
        return Err(transcript_invalid());
    }

    let mut words: Vec<TranscriptChunkWordInputV1> = Vec::with_capacity(parsed.words.len());
    for raw in parsed.words {
        // Pieces run without the speaker model, so a speaker field is invalid.
        if raw.word.trim().is_empty() || raw.speaker.is_some() {
            return Err(transcript_invalid());
        }
        let mut start_us = seconds_to_microseconds(raw.start)?;
        let mut end_us = seconds_to_microseconds(raw.end)?;
        let piece_len = piece.source_end_us - piece.source_start_us;
        // A piece's last word can end slightly past its audio (seen: 140.56 s
        // on 140.516 s); normalization clamps it to the chunk end and marks it
        // `clamped`. Anything further out than the tolerance is invalid.
        if end_us <= start_us || end_us > piece_len + RUNTIME_END_TOLERANCE_US {
            return Err(transcript_invalid());
        }
        // It can even *start* just past the audio (seen: "so" at 212.16 s on
        // 212.14 s; the next piece does not hear it). Keep the word: place it
        // in the piece's last runtime frame and mark its timing `clamped`.
        let mut timing_provenance = TimingProvenanceV1::Aligned;
        if start_us >= piece_len {
            start_us = (piece_len - RUNTIME_FRAME_US).max(0);
            end_us = piece_len;
            timing_provenance = TimingProvenanceV1::Clamped;
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
            // Filled in from the whole-file speaker pass.
            speaker_label: None,
            // The runtime emits no per-word speaker confidence; none is invented.
            speaker_confidence: None,
            timing_provenance,
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
    Ok(chunk(words))
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiarizeJsonOutput {
    file: String,
    segments: Vec<DiarizeJsonSegment>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DiarizeJsonSegment {
    start: f64,
    end: f64,
    speaker: u64,
}

/// One speaker segment on the source timeline, in microseconds.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct SpeakerSegment {
    start_us: i64,
    end_us: i64,
    speaker: u64,
}

/// Parses the speaker pass output strictly: speakers 1–4, finite times with
/// `start < end <= source`, starts in non-decreasing order.
fn parse_diarized_segments(
    bytes: &[u8],
    source_duration_us: u64,
) -> Result<Vec<SpeakerSegment>, VideoCommandError> {
    let parsed: DiarizeJsonOutput =
        serde_json::from_slice(bytes).map_err(|_| transcript_invalid())?;
    let _ = &parsed.file;
    if parsed.segments.len() > MAX_DIARIZED_SEGMENTS {
        return Err(transcript_invalid());
    }
    let source_end = i64::try_from(source_duration_us).map_err(|_| transcript_invalid())?;
    let mut segments: Vec<SpeakerSegment> = Vec::with_capacity(parsed.segments.len());
    for raw in parsed.segments {
        let start_us = seconds_to_microseconds(raw.start)?;
        let end_us = seconds_to_microseconds(raw.end)?;
        // Same tolerance as words: a last segment may end slightly past the
        // audio and is clamped to it.
        if !(1..=MAX_DIARIZED_SPEAKERS).contains(&raw.speaker)
            || end_us <= start_us
            || start_us >= source_end
            || end_us > source_end + RUNTIME_END_TOLERANCE_US
            || segments.last().is_some_and(|last| start_us < last.start_us)
        {
            return Err(transcript_invalid());
        }
        segments.push(SpeakerSegment {
            start_us,
            end_us: end_us.min(source_end),
            speaker: raw.speaker,
        });
    }
    Ok(segments)
}

fn read_diarized_segments(
    path: &Path,
    source_duration_us: u64,
) -> Result<Vec<SpeakerSegment>, VideoCommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| transcript_invalid())?;
    if !metadata.is_file()
        || is_reparse_or_symlink(&metadata)
        || metadata.len() > DIARIZE_OUTPUT_LIMIT
    {
        return Err(transcript_invalid());
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    File::open(path)
        .map_err(|_| transcript_invalid())?
        .take(DIARIZE_OUTPUT_LIMIT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| transcript_invalid())?;
    if bytes.len() as u64 > DIARIZE_OUTPUT_LIMIT {
        return Err(transcript_invalid());
    }
    parse_diarized_segments(&bytes, source_duration_us)
}

/// Gives each `[start, end)` word span the speaker whose segment overlaps it
/// most. A word overlapping no segment takes the nearest segment within
/// `SPEAKER_FALLBACK_US`, else stays unlabelled. Ties go to the earliest
/// segment in input order, so the result is deterministic.
fn assign_speakers(words: &[Range<i64>], segments: &[SpeakerSegment]) -> Vec<Option<u64>> {
    words
        .iter()
        .map(|word| {
            let mut overlap_best: Option<(i64, u64)> = None;
            let mut nearest_best: Option<(i64, u64)> = None;
            for segment in segments {
                let overlap = word.end.min(segment.end_us) - word.start.max(segment.start_us);
                if overlap > 0 {
                    if overlap_best.is_none_or(|(best, _)| overlap > best) {
                        overlap_best = Some((overlap, segment.speaker));
                    }
                } else {
                    let gap = -overlap;
                    if gap <= SPEAKER_FALLBACK_US && nearest_best.is_none_or(|(best, _)| gap < best)
                    {
                        nearest_best = Some((gap, segment.speaker));
                    }
                }
            }
            overlap_best.or(nearest_best).map(|(_, speaker)| speaker)
        })
        .collect()
}

/// Labels every word of every chunk from the whole-file speaker segments.
fn label_chunk_speakers(chunks: &mut [TranscriptChunkInputV1], segments: &[SpeakerSegment]) {
    for chunk in chunks {
        let spans: Vec<Range<i64>> = chunk
            .words
            .iter()
            .map(|word| {
                chunk.source_start_us + word.relative_start_us
                    ..chunk.source_start_us + word.relative_end_us
            })
            .collect();
        for (word, speaker) in chunk
            .words
            .iter_mut()
            .zip(assign_speakers(&spans, segments))
        {
            word.speaker_label = speaker.map(|index| format!("speaker_{index}"));
        }
    }
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
        || configuration.chunk_duration_us != source_duration_us.min(MAX_PIECE_US)
        || configuration.chunk_overlap_us != 0
    {
        return Err(transcript_invalid());
    }
    // The piece plan and the speaker pass are part of the transcript identity.
    let string_setting = |key: &str| {
        configuration
            .provider_settings
            .iter()
            .find(|setting| setting.key == key)
            .map(|setting| &setting.value)
    };
    let is = |value: Option<&AsrProviderSettingValueV1>, expected: &str| matches!(value, Some(AsrProviderSettingValueV1::String(actual)) if actual == expected);
    if !is(string_setting(SEGMENTATION_SETTING), SEGMENTATION_VALUE) {
        return Err(transcript_invalid());
    }
    let pass = string_setting(DIARIZATION_PASS_SETTING);
    let pass_valid = if diarization == Diarization::Off {
        pass.is_none()
    } else {
        is(pass, DIARIZATION_PASS_VALUE)
    };
    if !pass_valid {
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
        if matches!(
            setting.key.as_str(),
            "diarizer_sha256" | SEGMENTATION_SETTING | DIARIZATION_PASS_SETTING
        ) {
            // Already matched above.
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

/// Where the sample data of a validated 16 kHz mono s16 PCM WAV lives.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct PcmLayout {
    data_offset: u64,
    data_len: u64,
}

/// Reads at most `max_samples` samples. Audio past the probed source duration
/// is not transcribed, as today (words past it were rejected).
fn read_pcm_samples(
    path: &Path,
    layout: PcmLayout,
    max_samples: u64,
) -> Result<Vec<i16>, VideoCommandError> {
    let invalid = || VideoCommandError::invalid_media(OPERATION, "extracted_audio");
    let count = (layout.data_len / 2).min(max_samples);
    let mut file = File::open(path).map_err(|_| invalid())?;
    file.seek(SeekFrom::Start(layout.data_offset))
        .map_err(|_| invalid())?;
    let mut bytes = Vec::new();
    bytes
        .try_reserve_exact((count * 2) as usize)
        .map_err(|_| invalid())?;
    file.take(count * 2)
        .read_to_end(&mut bytes)
        .map_err(|_| invalid())?;
    if bytes.len() as u64 != count * 2 || count == 0 {
        return Err(invalid());
    }
    Ok(bytes
        .chunks_exact(2)
        .map(|pair| i16::from_le_bytes([pair[0], pair[1]]))
        .collect())
}

/// Writes a canonical 44-byte-header 16 kHz mono s16 WAV holding `samples`.
fn write_piece_wav(samples: &[i16], path: &Path) -> Result<(), VideoCommandError> {
    let io_error = || VideoCommandError::project_io(OPERATION, "temporary_audio");
    let data_len = u32::try_from(samples.len() * 2).map_err(|_| io_error())?;
    let riff_len = data_len
        .checked_add(PCM_HEADER_BYTES as u32 - 8)
        .ok_or_else(io_error)?;
    let file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| io_error())?;
    let mut writer = BufWriter::new(file);
    let mut header = Vec::with_capacity(PCM_HEADER_BYTES as usize);
    header.extend_from_slice(b"RIFF");
    header.extend_from_slice(&riff_len.to_le_bytes());
    header.extend_from_slice(b"WAVEfmt ");
    header.extend_from_slice(&16_u32.to_le_bytes());
    header.extend_from_slice(&1_u16.to_le_bytes()); // PCM
    header.extend_from_slice(&1_u16.to_le_bytes()); // mono
    header.extend_from_slice(&PCM_SAMPLE_RATE.to_le_bytes());
    header.extend_from_slice(&(PCM_SAMPLE_RATE * 2).to_le_bytes()); // byte rate
    header.extend_from_slice(&2_u16.to_le_bytes()); // block align
    header.extend_from_slice(&16_u16.to_le_bytes()); // bits per sample
    header.extend_from_slice(b"data");
    header.extend_from_slice(&data_len.to_le_bytes());
    writer.write_all(&header).map_err(|_| io_error())?;
    for sample in samples {
        writer
            .write_all(&sample.to_le_bytes())
            .map_err(|_| io_error())?;
    }
    writer
        .into_inner()
        .map_err(|_| io_error())?
        .sync_all()
        .map_err(|_| io_error())
}

fn validate_pcm_wav(path: &Path) -> Result<PcmLayout, VideoCommandError> {
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
    let mut data: Option<PcmLayout> = None;
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
            if data.is_some() {
                return Err(invalid());
            }
            data = Some(PcmLayout {
                data_offset: data_start,
                data_len: size,
            });
        }
        let next = data_end.checked_add(size % 2).ok_or_else(invalid)?;
        if next > metadata.len() {
            return Err(invalid());
        }
        file.seek(SeekFrom::Start(next)).map_err(|_| invalid())?;
    }
    match data {
        Some(layout) if valid_format && layout.data_len >= 2 => Ok(layout),
        _ => Err(invalid()),
    }
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
mod piece_tests {
    use super::*;

    const RATE: u32 = 1_000;
    const LOUD: i16 = 10_000;

    fn assert_covers(pieces: &[Range<usize>], len: usize, max: usize) {
        assert_eq!(pieces.first().map(|piece| piece.start), Some(0));
        assert_eq!(pieces.last().map(|piece| piece.end), Some(len));
        for pair in pieces.windows(2) {
            assert_eq!(pair[0].end, pair[1].start, "pieces are contiguous");
        }
        for piece in pieces {
            assert!(!piece.is_empty() && piece.len() <= max, "{piece:?}");
        }
    }

    #[test]
    fn audio_up_to_the_limit_stays_one_piece() {
        for len in [1, 5_000, 10_000] {
            let pcm = vec![LOUD; len];
            assert_eq!(
                plan_transcription_pieces(&pcm, RATE, 10_000_000),
                vec![0..len]
            );
        }
    }

    #[test]
    fn long_audio_is_cut_in_the_quietest_window_near_each_limit() {
        // 10 s pieces at 1 kHz; the cut search covers the last 2 s (8–10 s).
        let mut pcm = vec![LOUD; 25_000];
        // A quiet stretch at 8.6–8.9 s, and a quieter-but-too-early one at 5 s.
        pcm[8_600..8_900].fill(0);
        pcm[5_000..5_300].fill(0);
        // Moderately quiet (still below the threshold) at 9.5–9.75 s.
        pcm[9_500..9_750].fill(300);
        let pieces = plan_transcription_pieces(&pcm, RATE, 10_000_000);

        assert_covers(&pieces, pcm.len(), 10_000);
        // The latest fully silent 250 ms window starts at 8.65 s; the cut is
        // its middle.
        assert_eq!(pieces[0], 0..8_775);
        assert_eq!(pieces.len(), 3);
    }

    #[test]
    fn loud_audio_is_cut_exactly_at_the_limit() {
        let pcm: Vec<i16> = (0..25_000)
            .map(|index| if index % 2 == 0 { LOUD } else { -LOUD })
            .collect();
        let pieces = plan_transcription_pieces(&pcm, RATE, 10_000_000);
        assert_eq!(pieces, vec![0..10_000, 10_000..20_000, 20_000..25_000]);
    }

    #[test]
    fn every_plan_is_bounded_contiguous_and_complete() {
        for (len, quiet_every) in [(10_001, 3_001), (31_234, 7_000), (99_999, 1_234)] {
            let pcm: Vec<i16> = (0..len)
                .map(|index| if index % quiet_every < 400 { 0 } else { LOUD })
                .collect();
            let pieces = plan_transcription_pieces(&pcm, RATE, 10_000_000);
            assert_covers(&pieces, len, 10_000);
            assert_eq!(pieces, plan_transcription_pieces(&pcm, RATE, 10_000_000));
        }
    }

    #[test]
    fn pieces_are_placed_on_the_source_timeline() {
        // 600 s at 16 kHz, fully loud: cuts at 240 s and 480 s.
        let pcm = vec![LOUD; 600 * 16_000];
        let pieces = place_pieces(&pcm, 600_000_000).unwrap();
        let bounds: Vec<_> = pieces
            .iter()
            .map(|piece| (piece.index, piece.source_start_us, piece.source_end_us))
            .collect();
        assert_eq!(
            bounds,
            [
                (0, 0, 240_000_000),
                (1, 240_000_000, 480_000_000),
                (2, 480_000_000, 600_000_000)
            ]
        );
        assert_eq!(samples_for_duration(600_000_000), 600 * 16_000);
        assert_eq!(samples_for_duration(1), 1);
    }

    #[test]
    fn a_piece_wav_round_trips_through_validation() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("piece-0000.wav");
        let samples = [0_i16, 1, -1, i16::MAX, i16::MIN];
        write_piece_wav(&samples, &path).unwrap();
        let layout = validate_pcm_wav(&path).unwrap();
        assert_eq!(
            layout,
            PcmLayout {
                data_offset: 44,
                data_len: 10
            }
        );
        assert_eq!(read_pcm_samples(&path, layout, 100).unwrap(), samples);
        assert_eq!(read_pcm_samples(&path, layout, 2).unwrap(), [0, 1]);
        // A fresh name is required: existing files are never overwritten.
        assert!(write_piece_wav(&samples, &path).is_err());
    }
}

#[cfg(test)]
mod speaker_assignment_tests {
    use super::*;

    fn segment(start_us: i64, end_us: i64, speaker: u64) -> SpeakerSegment {
        SpeakerSegment {
            start_us,
            end_us,
            speaker,
        }
    }

    #[test]
    fn the_largest_overlap_wins() {
        let segments = [segment(0, 1_000, 1), segment(1_000, 3_000, 2)];
        assert_eq!(
            assign_speakers(&[500..1_200, 800..2_000, 0..400], &segments),
            [Some(1), Some(2), Some(1)]
        );
    }

    #[test]
    fn a_word_outside_segments_takes_the_nearest_within_half_a_second() {
        let segments = [segment(0, 1_000_000, 1), segment(3_000_000, 4_000_000, 2)];
        assert_eq!(
            assign_speakers(
                &[
                    1_400_000..1_500_000, // 0.4 s after speaker 1
                    2_600_000..2_700_000, // 0.3 s before speaker 2
                    1_600_000..2_400_000, // 0.6 s from both
                    1_500_000..1_600_000, // exactly 0.5 s after speaker 1
                ],
                &segments
            ),
            [Some(1), Some(2), None, Some(1)]
        );
    }

    #[test]
    fn no_segments_leave_every_word_unlabelled() {
        assert_eq!(assign_speakers(&[0..10, 20..30], &[]), [None, None]);
    }

    #[test]
    fn ties_go_to_the_earliest_segment_every_time() {
        // Equal overlap with two overlapping segments, and equal gaps.
        let segments = [segment(0, 1_000, 3), segment(500, 2_000, 1)];
        let words = [500..1_000, 2_200..2_300];
        let first = assign_speakers(&words, &segments);
        assert_eq!(first, [Some(3), Some(1)]);
        let tied_gap = [segment(0, 1_000, 2), segment(2_000, 3_000, 4)];
        let midway = Range {
            start: 1_400,
            end: 1_600,
        };
        assert_eq!(
            assign_speakers(std::slice::from_ref(&midway), &tied_gap),
            [Some(2)]
        );
        assert_eq!(first, assign_speakers(&words, &segments));
    }

    #[test]
    fn chunk_words_are_labelled_on_the_source_timeline() {
        let word = |start: i64, end: i64| TranscriptChunkWordInputV1 {
            text: "w".to_owned(),
            relative_start_us: start,
            relative_end_us: end,
            recognition_confidence: None,
            speaker_label: None,
            speaker_confidence: None,
            timing_provenance: TimingProvenanceV1::Aligned,
        };
        let mut chunks = vec![TranscriptChunkInputV1 {
            schema_version: 1,
            chunk_id: "chunk-0001".to_owned(),
            chunk_index: 1,
            source_start_us: 10_000_000,
            source_end_us: 20_000_000,
            words: vec![word(0, 100_000), word(5_000_000, 5_100_000)],
        }];
        let segments = [
            segment(9_000_000, 10_200_000, 2),
            segment(14_000_000, 16_000_000, 3),
        ];
        label_chunk_speakers(&mut chunks, &segments);
        let labels: Vec<_> = chunks[0]
            .words
            .iter()
            .map(|word| word.speaker_label.as_deref())
            .collect();
        assert_eq!(labels, [Some("speaker_2"), Some("speaker_3")]);
    }
}

#[cfg(test)]
mod diarize_output_tests {
    use super::*;

    fn parse(value: serde_json::Value) -> Result<Vec<SpeakerSegment>, VideoCommandError> {
        parse_diarized_segments(&serde_json::to_vec(&value).unwrap(), 10_000_000)
    }

    #[test]
    fn real_runtime_shapes_parse() {
        let segments = parse(serde_json::json!({
            "file": "a.wav",
            "segments": [
                {"start": 0.0, "end": 2.719, "speaker": 1},
                {"start": 2.0, "end": 3.5, "speaker": 4},
                {"start": 2.0, "end": 10.0, "speaker": 2}
            ]
        }))
        .unwrap();
        assert_eq!(
            segments,
            [
                SpeakerSegment {
                    start_us: 0,
                    end_us: 2_719_000,
                    speaker: 1
                },
                SpeakerSegment {
                    start_us: 2_000_000,
                    end_us: 3_500_000,
                    speaker: 4
                },
                SpeakerSegment {
                    start_us: 2_000_000,
                    end_us: 10_000_000,
                    speaker: 2
                },
            ]
        );
        // Slightly past the audio is clamped to it.
        assert_eq!(
            parse(serde_json::json!({"file": "a", "segments": [
                {"start": 9.0, "end": 10.08, "speaker": 3}
            ]}))
            .unwrap(),
            [SpeakerSegment {
                start_us: 9_000_000,
                end_us: 10_000_000,
                speaker: 3
            }]
        );
        // The runtime's no-speech output.
        assert_eq!(
            parse(serde_json::json!({"file": "a.wav", "segments": []})).unwrap(),
            []
        );
    }

    #[test]
    fn malformed_output_is_rejected() {
        let seg = |start: serde_json::Value, end: serde_json::Value, speaker: serde_json::Value| {
            serde_json::json!({"file": "a.wav", "segments": [
                {"start": start, "end": end, "speaker": speaker}
            ]})
        };
        use serde_json::json;
        for (label, value) in [
            ("speaker 0", seg(json!(0.0), json!(1.0), json!(0))),
            ("speaker 5", seg(json!(0.0), json!(1.0), json!(5))),
            ("speaker text", seg(json!(0.0), json!(1.0), json!("1"))),
            ("speaker fraction", seg(json!(0.0), json!(1.0), json!(1.5))),
            ("negative start", seg(json!(-0.1), json!(1.0), json!(1))),
            ("empty span", seg(json!(1.0), json!(1.0), json!(1))),
            ("reversed span", seg(json!(2.0), json!(1.0), json!(1))),
            ("past the source", seg(json!(9.0), json!(10.161), json!(1))),
            (
                "starting at the end",
                seg(json!(10.0), json!(10.04), json!(1)),
            ),
            ("text time", seg(json!("0"), json!(1.0), json!(1))),
            (
                "unknown field",
                json!({"file": "a", "segments": [], "extra": 1}),
            ),
            ("missing segments", json!({"file": "a"})),
            (
                "unknown segment field",
                json!({"file": "a", "segments": [
                    {"start": 0.0, "end": 1.0, "speaker": 1, "confidence": 0.5}
                ]}),
            ),
            (
                "starts out of order",
                json!({"file": "a", "segments": [
                    {"start": 2.0, "end": 3.0, "speaker": 1},
                    {"start": 1.0, "end": 4.0, "speaker": 2}
                ]}),
            ),
        ] {
            assert!(parse(value).is_err(), "{label} must be rejected");
        }
        assert!(parse_diarized_segments(b"not json", 10_000_000).is_err());
    }

    #[test]
    fn oversized_or_linked_output_files_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("speakers.json");
        fs::write(&path, br#"{"file":"a","segments":[]}"#).unwrap();
        assert_eq!(read_diarized_segments(&path, 1_000_000).unwrap(), []);
        let file = File::create(&path).unwrap();
        file.set_len(DIARIZE_OUTPUT_LIMIT + 1).unwrap();
        assert!(read_diarized_segments(&path, 1_000_000).is_err());
        assert!(read_diarized_segments(&root.path().join("missing.json"), 1_000_000).is_err());
    }
}

#[cfg(test)]
mod piece_output_tests {
    use super::*;

    fn piece(index: u64, start_us: i64, end_us: i64) -> PlannedPiece {
        PlannedPiece {
            index,
            samples: 0..1,
            source_start_us: start_us,
            source_end_us: end_us,
        }
    }

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

    /// The exact output the pinned runtime printed for 240 s of silence and
    /// for a music-only excerpt (step 1 of the long-file plan).
    const SILENT_OUTPUT: &str = r#"{
  "file": "E:\\piece-0001.wav",
  "text": "",
  "confidence": 1,
  "duration": 240,
  "languages": [],
  "words": []
}"#;

    #[test]
    fn silent_output_becomes_a_zero_word_chunk_with_the_piece_bounds() {
        let chunk = parse_nemo_chunk(
            SILENT_OUTPUT.as_bytes(),
            &piece(1, 240_000_000, 480_000_000),
        )
        .unwrap();
        assert_eq!(
            chunk,
            TranscriptChunkInputV1 {
                schema_version: 1,
                chunk_id: "chunk-0001".to_owned(),
                chunk_index: 1,
                source_start_us: 240_000_000,
                source_end_us: 480_000_000,
                words: Vec::new(),
            }
        );
    }

    #[test]
    fn silent_looking_but_malformed_output_is_rejected() {
        for body in [
            // Whitespace text with no words is not the runtime's silence shape.
            r#"{"file":"a","text":" ","duration":1,"words":[]}"#,
            r#"{"file":"a","text":"hello","duration":1,"words":[]}"#,
            r#"{"file":"a","text":"","duration":1}"#,
            r#"{"file":"a","duration":1,"words":[]}"#,
            r#"{"file":"a","text":null,"duration":1,"words":[]}"#,
            r#"{"file":"a","text":"","duration":1,"words":[],"extra":1}"#,
            r#"{"file":"a","text":"","duration":1,"words":[{"word":"hi","start":0,"end":0.1}]}"#,
            "",
        ] {
            assert!(
                parse_nemo_chunk(body.as_bytes(), &piece(0, 0, 1_000_000)).is_err(),
                "{body} must be rejected"
            );
        }
    }

    #[test]
    fn word_times_stay_relative_and_the_chunk_carries_the_offset() {
        let chunk = parse_nemo_chunk(
            &timed(&[("Hello", 0.08, 0.4), ("there.", 0.48, 0.8)]),
            &piece(2, 480_000_000, 600_000_000),
        )
        .unwrap();
        assert_eq!(
            (chunk.chunk_id.as_str(), chunk.chunk_index),
            ("chunk-0002", 2)
        );
        assert_eq!(chunk.source_start_us, 480_000_000);
        assert_eq!(
            ranges(&chunk),
            [
                (80_000, 400_000, TimingProvenanceV1::Aligned),
                (480_000, 800_000, TimingProvenanceV1::Aligned)
            ]
        );
        assert!(chunk.words.iter().all(|word| word.speaker_label.is_none()));
    }

    #[test]
    fn text_that_does_not_match_its_words_is_rejected() {
        let body = serde_json::json!({
            "file": "a",
            "text": "Hello there",
            "duration": 1.0,
            "words": [{"word": "Hello", "start": 0.0, "end": 0.2}]
        });
        assert!(
            parse_nemo_chunk(&serde_json::to_vec(&body).unwrap(), &piece(0, 0, 1_000_000)).is_err()
        );
    }

    #[test]
    fn words_past_the_piece_are_rejected() {
        let piece = piece(3, 2_000_000, 3_000_000);
        // More than the allowed tolerance past the end.
        assert!(parse_nemo_chunk(&timed(&[("late", 0.9, 1.17)]), &piece).is_err());
        assert!(parse_nemo_chunk(&timed(&[("late", 0.9, 1.16)]), &piece).is_ok());
        // Starting past the end and ending past the tolerance.
        assert!(parse_nemo_chunk(&timed(&[("after", 1.1, 1.2)]), &piece).is_err());
    }

    #[test]
    fn a_last_word_starting_just_past_the_audio_is_kept_in_the_last_frame() {
        use TimingProvenanceV1::{Aligned, Clamped};
        // The real 2-hour run: piece 0's audio ends at 212.14 s and the
        // runtime reported "so" at 212.16–212.24 s; piece 1 does not hear it.
        let piece = piece(0, 0, 212_140_000);
        let bytes = timed(&[("thing", 211.44, 211.52), ("so", 212.16, 212.24)]);
        let chunk = parse_nemo_chunk(&bytes, &piece).unwrap();
        assert_eq!(
            ranges(&chunk),
            [
                (211_440_000, 211_520_000, Aligned),
                (212_060_000, 212_140_000, Clamped)
            ]
        );
        // Starting exactly at the end is the same case.
        let at_end = parse_nemo_chunk(&timed(&[("so", 212.14, 212.2)]), &piece).unwrap();
        assert_eq!(ranges(&at_end), [(212_060_000, 212_140_000, Clamped)]);
    }

    #[test]
    fn a_last_word_one_frame_past_the_audio_is_kept_and_clamped() {
        // The real 50-minute run: the last piece's audio ends at 140.516 s and
        // the runtime reported "podcast." at 132.08–140.56 s (80 ms grid).
        let piece = piece(13, 2_859_655_187, 3_000_171_000);
        let bytes = timed(&[("NASA", 131.84, 132.0), ("podcast.", 132.08, 140.56)]);
        let chunk = parse_nemo_chunk(&bytes, &piece).unwrap();
        assert_eq!(chunk.words[1].relative_end_us, 140_560_000);

        let normalized =
            crate::video::transcript::normalize_transcript_chunks(&[chunk], 3_000_171_000).unwrap();
        let last = normalized.words.last().unwrap();
        assert_eq!(last.source_end_us, 3_000_171_000);
        assert_eq!(last.timing_provenance, TimingProvenanceV1::Clamped);
    }

    #[test]
    fn a_speaker_field_in_piece_output_is_rejected() {
        let body = serde_json::json!({
            "file": "a",
            "text": "Hi",
            "duration": 1.0,
            "words": [{"word": "Hi", "start": 0.0, "end": 0.2, "speaker": 1}]
        });
        assert!(
            parse_nemo_chunk(&serde_json::to_vec(&body).unwrap(), &piece(0, 0, 1_000_000)).is_err()
        );
    }

    #[test]
    fn overlapping_runtime_word_times_are_repaired_and_marked() {
        use TimingProvenanceV1::{Aligned, Clamped, Estimated};
        // Word shapes from a real 5-minute NeMo run (HWHAP episode 436):
        // "today." runs past the start of "So"; "much" and "for" share a frame.
        let bytes = timed(&[
            ("today.", 11.68, 13.2),
            ("So", 13.12, 13.2),
            ("much", 14.12, 14.2),
            ("for", 14.12, 14.2),
            ("being", 14.2, 14.36),
        ]);
        let chunk = parse_nemo_chunk(&bytes, &piece(0, 0, 20_000_000)).unwrap();
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
    }

    #[test]
    fn three_words_sharing_a_frame_stay_ordered_and_non_empty() {
        let bytes = timed(&[("a", 1.12, 1.2), ("b", 1.12, 1.2), ("c", 1.12, 1.2)]);
        let chunk = parse_nemo_chunk(&bytes, &piece(0, 0, 2_000_000)).unwrap();
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
    }

    #[test]
    fn out_of_order_runtime_words_are_still_rejected() {
        let bytes = timed(&[("late", 2.0, 2.4), ("early", 1.0, 1.2)]);
        assert!(parse_nemo_chunk(&bytes, &piece(0, 0, 3_000_000)).is_err());
    }
}
