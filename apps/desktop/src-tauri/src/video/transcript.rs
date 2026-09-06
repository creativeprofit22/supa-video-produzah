use std::{
    cmp::Ordering,
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata},
    io::Read,
    path::Path,
};

#[cfg(test)]
use std::{io::Write, path::PathBuf};

#[cfg(test)]
use super::cache::{CacheArtifactKind, CacheArtifactRegistration, MediaCacheService};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::{
    error::VideoCommandError,
    media_store::{acquire_artifact, ArtifactStoreKind, SourceFingerprintV1},
    types::{MediaContentAlgorithm, MediaContentIdentityV1, MAX_SAFE_INTEGER},
};

pub(crate) const MAX_TRANSCRIPT_JSON_BYTES: u64 = 128 * 1024 * 1024;
const MAX_IDENTIFIER_UTF16: usize = 512;
const MAX_TEXT_UTF16: usize = 16_384;
const MAX_PROVIDER_VALUE_UTF16: usize = 4_096;
const MAX_PROVIDER_SETTINGS: usize = 128;
const MAX_CHUNKS: usize = 10_000;
const MAX_CHUNK_WORDS: usize = 100_000;
const MAX_WORDS: usize = 1_000_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AsrTaskV1 {
    Transcribe,
    Translate,
}

impl AsrTaskV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Transcribe => "transcribe",
            Self::Translate => "translate",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpeakerDiarizationModeV1 {
    Off,
    Optional,
    Required,
}

impl SpeakerDiarizationModeV1 {
    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Optional => "optional",
            Self::Required => "required",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum AsrProviderSettingValueV1 {
    String(String),
    Number(f64),
    Boolean(bool),
    Null,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsrProviderSettingV1 {
    pub key: String,
    pub value: AsrProviderSettingValueV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsrConfigurationV1 {
    pub schema_version: u64,
    pub engine_id: String,
    pub engine_version: String,
    pub model_id: String,
    pub model_revision: String,
    pub requested_language: Option<String>,
    pub task: AsrTaskV1,
    pub word_timing_required: bool,
    pub speaker_diarization_mode: SpeakerDiarizationModeV1,
    pub chunk_duration_us: u64,
    pub chunk_overlap_us: u64,
    pub provider_settings: Vec<AsrProviderSettingV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AsrConfigurationIdentityV1 {
    pub schema_version: u64,
    pub algorithm: MediaContentAlgorithm,
    pub digest: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TimingProvenanceV1 {
    Aligned,
    Estimated,
    Clamped,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(test)]
pub struct TranscriptChunkWordInputV1 {
    pub text: String,
    pub relative_start_us: i64,
    pub relative_end_us: i64,
    pub recognition_confidence: Option<f64>,
    pub speaker_label: Option<String>,
    pub speaker_confidence: Option<f64>,
    pub timing_provenance: TimingProvenanceV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(test)]
pub struct TranscriptChunkInputV1 {
    pub schema_version: u64,
    pub chunk_id: String,
    pub chunk_index: u64,
    pub source_start_us: i64,
    pub source_end_us: i64,
    pub words: Vec<TranscriptChunkWordInputV1>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptWordV1 {
    pub word_id: String,
    pub chunk_id: String,
    pub chunk_index: u64,
    pub word_index: u64,
    pub text: String,
    pub source_start_us: u64,
    pub source_end_us: u64,
    pub recognition_confidence: Option<f64>,
    pub speaker_label: Option<String>,
    pub speaker_confidence: Option<f64>,
    pub timing_provenance: TimingProvenanceV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NormalizedTranscriptChunkV1 {
    pub schema_version: u64,
    pub chunk_id: String,
    pub chunk_index: u64,
    pub source_start_us: u64,
    pub source_end_us: u64,
    pub words: Vec<TranscriptWordV1>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptUncertaintyCountsV1 {
    pub missing_confidence_word_count: u64,
    pub missing_speaker_word_count: u64,
    pub estimated_timing_word_count: u64,
    pub clamped_timing_word_count: u64,
    pub retained_overlap_word_count: u64,
    pub removed_exact_duplicate_word_count: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(test)]
pub struct NormalizedTranscriptV1 {
    pub schema_version: u64,
    pub chunks: Vec<NormalizedTranscriptChunkV1>,
    pub words: Vec<TranscriptWordV1>,
    pub uncertainty_counts: TranscriptUncertaintyCountsV1,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptArtifactIdentityV1 {
    pub schema_version: u64,
    pub key: String,
    pub source_identity: MediaContentIdentityV1,
    pub source_fingerprint: SourceFingerprintV1,
    pub configuration_identity: AsrConfigurationIdentityV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptArtifactV1 {
    pub schema_version: u64,
    pub identity: TranscriptArtifactIdentityV1,
    pub source_duration_us: u64,
    pub configuration: AsrConfigurationV1,
    pub chunks: Vec<NormalizedTranscriptChunkV1>,
    pub words: Vec<TranscriptWordV1>,
    pub uncertainty_counts: TranscriptUncertaintyCountsV1,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg(test)]
pub struct TranscriptArtifactFixtureV1 {
    pub schema_version: u64,
    pub configuration: AsrConfigurationV1,
    pub configuration_identity: AsrConfigurationIdentityV1,
    pub source_identity: MediaContentIdentityV1,
    pub source_fingerprint: SourceFingerprintV1,
    pub source_duration_us: u64,
    pub chunks: Vec<TranscriptChunkInputV1>,
    pub artifact: TranscriptArtifactV1,
}

#[derive(Debug, Clone)]
#[cfg(test)]
pub(crate) struct PublishedTranscriptArtifact {
    pub(crate) artifact: TranscriptArtifactV1,
    pub(crate) path: PathBuf,
    pub(crate) content_digest: String,
    pub(crate) lease_id: String,
    pub(crate) reused: bool,
}

struct FramedIdentityEncoder {
    bytes: Vec<u8>,
}

impl FramedIdentityEncoder {
    fn new() -> Self {
        Self { bytes: Vec::new() }
    }

    fn bytes(&mut self, value: &[u8]) -> Result<(), VideoCommandError> {
        let length =
            u32::try_from(value.len()).map_err(|_| transcript_error("identity_field_size"))?;
        self.bytes.extend_from_slice(&length.to_le_bytes());
        self.bytes.extend_from_slice(value);
        Ok(())
    }

    fn string(&mut self, value: &str) -> Result<(), VideoCommandError> {
        self.bytes(value.as_bytes())
    }

    fn integer(&mut self, value: u64) -> Result<(), VideoCommandError> {
        require_safe(value, "identity_integer")?;
        self.bytes(&value.to_le_bytes())
    }

    fn signed_integer(&mut self, value: i64) -> Result<(), VideoCommandError> {
        require_signed_safe(value, "identity_signed_integer")?;
        self.bytes(&value.to_le_bytes())
    }

    fn boolean(&mut self, value: bool) -> Result<(), VideoCommandError> {
        self.integer(u64::from(value))
    }

    fn nullable_string(&mut self, value: Option<&str>) -> Result<(), VideoCommandError> {
        self.boolean(value.is_some())?;
        if let Some(value) = value {
            self.string(value)?;
        }
        Ok(())
    }

    fn finish(self) -> Vec<u8> {
        self.bytes
    }
}

fn encode_named_string(
    encoder: &mut FramedIdentityEncoder,
    key: &str,
    value: &str,
) -> Result<(), VideoCommandError> {
    encoder.string(key)?;
    encoder.string(value)
}

fn encode_named_integer(
    encoder: &mut FramedIdentityEncoder,
    key: &str,
    value: u64,
) -> Result<(), VideoCommandError> {
    encoder.string(key)?;
    encoder.integer(value)
}

fn sha256_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn digest_bytes(digest: &str) -> Result<[u8; 32], VideoCommandError> {
    if !is_sha256(digest) {
        return Err(transcript_error("digest"));
    }
    let mut bytes = [0_u8; 32];
    for (index, output) in bytes.iter_mut().enumerate() {
        *output = u8::from_str_radix(&digest[index * 2..index * 2 + 2], 16)
            .map_err(|_| transcript_error("digest"))?;
    }
    Ok(bytes)
}

pub fn derive_asr_configuration_identity(
    configuration: &AsrConfigurationV1,
) -> Result<AsrConfigurationIdentityV1, VideoCommandError> {
    validate_configuration(configuration)?;
    let mut encoder = FramedIdentityEncoder::new();
    encoder.string("supa-video/asr-configuration/v1")?;
    encode_named_string(&mut encoder, "engineId", &configuration.engine_id)?;
    encode_named_string(&mut encoder, "engineVersion", &configuration.engine_version)?;
    encode_named_string(&mut encoder, "modelId", &configuration.model_id)?;
    encode_named_string(&mut encoder, "modelRevision", &configuration.model_revision)?;
    encoder.string("requestedLanguage")?;
    encoder.nullable_string(configuration.requested_language.as_deref())?;
    encode_named_string(&mut encoder, "task", configuration.task.as_str())?;
    encoder.string("wordTimingRequired")?;
    encoder.boolean(configuration.word_timing_required)?;
    encode_named_string(
        &mut encoder,
        "speakerDiarizationMode",
        configuration.speaker_diarization_mode.as_str(),
    )?;
    encode_named_integer(
        &mut encoder,
        "chunkDurationUs",
        configuration.chunk_duration_us,
    )?;
    encode_named_integer(
        &mut encoder,
        "chunkOverlapUs",
        configuration.chunk_overlap_us,
    )?;
    encode_named_integer(
        &mut encoder,
        "providerSettingCount",
        configuration.provider_settings.len() as u64,
    )?;
    for setting in &configuration.provider_settings {
        encoder.string(&setting.key)?;
        match &setting.value {
            AsrProviderSettingValueV1::Null => encoder.string("null")?,
            AsrProviderSettingValueV1::String(value) => {
                encoder.string("string")?;
                encoder.string(value)?;
            }
            AsrProviderSettingValueV1::Boolean(value) => {
                encoder.string("boolean")?;
                encoder.boolean(*value)?;
            }
            AsrProviderSettingValueV1::Number(value) => {
                encoder.string("number")?;
                encoder.signed_integer(*value as i64)?;
            }
        }
    }
    Ok(AsrConfigurationIdentityV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest: sha256_hex(&encoder.finish()),
    })
}

pub fn derive_transcript_artifact_identity(
    source_identity: &MediaContentIdentityV1,
    source_fingerprint: &SourceFingerprintV1,
    configuration_identity: &AsrConfigurationIdentityV1,
) -> Result<TranscriptArtifactIdentityV1, VideoCommandError> {
    validate_source_identity(source_identity)?;
    validate_source_fingerprint(source_fingerprint)?;
    validate_configuration_identity(configuration_identity)?;
    let mut encoder = FramedIdentityEncoder::new();
    encoder.string("supa-video/transcript-artifact/v1")?;
    encoder.string("sourceIdentity.digest")?;
    encoder.bytes(&digest_bytes(&source_identity.digest)?)?;
    encode_named_integer(
        &mut encoder,
        "sourceIdentity.byteLength",
        source_identity.byte_length,
    )?;
    encoder.string("sourceFingerprint.digest")?;
    encoder.bytes(&digest_bytes(&source_fingerprint.digest)?)?;
    encode_named_integer(
        &mut encoder,
        "sourceFingerprint.byteLength",
        source_fingerprint.byte_length,
    )?;
    encode_named_integer(
        &mut encoder,
        "sourceFingerprint.modifiedUnixSeconds",
        source_fingerprint.modified_unix_seconds,
    )?;
    encode_named_integer(
        &mut encoder,
        "sourceFingerprint.modifiedNanoseconds",
        u64::from(source_fingerprint.modified_nanoseconds),
    )?;
    encoder.string("configurationIdentity.digest")?;
    encoder.bytes(&digest_bytes(&configuration_identity.digest)?)?;
    Ok(TranscriptArtifactIdentityV1 {
        schema_version: 1,
        key: sha256_hex(&encoder.finish()),
        source_identity: source_identity.clone(),
        source_fingerprint: source_fingerprint.clone(),
        configuration_identity: configuration_identity.clone(),
    })
}

#[cfg(test)]
pub fn normalize_transcript_chunks(
    chunks: &[TranscriptChunkInputV1],
    source_duration_us: u64,
) -> Result<NormalizedTranscriptV1, VideoCommandError> {
    require_positive_safe(source_duration_us, "source_duration")?;
    if chunks.len() > MAX_CHUNKS {
        return Err(transcript_error("chunk_count"));
    }
    let mut seen_ids = HashSet::new();
    let mut seen_indexes = HashSet::new();
    let mut normalized = Vec::with_capacity(chunks.len());
    let duration =
        i64::try_from(source_duration_us).map_err(|_| transcript_error("source_duration"))?;

    for chunk in chunks {
        validate_input_chunk(chunk)?;
        if !seen_ids.insert(chunk.chunk_id.as_str()) || !seen_indexes.insert(chunk.chunk_index) {
            return Err(transcript_error("chunk_identity"));
        }
        let source_start = chunk.source_start_us.max(0);
        let source_end = chunk.source_end_us.min(duration);
        if source_end <= source_start {
            return Err(transcript_error("chunk_source_intersection"));
        }
        let mut words = Vec::with_capacity(chunk.words.len());
        for (index, raw) in chunk.words.iter().enumerate() {
            validate_input_word(raw)?;
            let raw_start = checked_safe_sum(chunk.source_start_us, raw.relative_start_us)?;
            let raw_end = checked_safe_sum(chunk.source_start_us, raw.relative_end_us)?;
            let start = raw_start.max(source_start);
            let end = raw_end.min(source_end);
            if end <= start {
                return Err(transcript_error("word_source_intersection"));
            }
            let clamped = start != raw_start || end != raw_end;
            words.push(TranscriptWordV1 {
                word_id: format!("{}:{index}", chunk.chunk_id),
                chunk_id: chunk.chunk_id.clone(),
                chunk_index: chunk.chunk_index,
                word_index: index as u64,
                text: raw.text.clone(),
                source_start_us: start as u64,
                source_end_us: end as u64,
                recognition_confidence: raw.recognition_confidence,
                speaker_label: raw.speaker_label.clone(),
                speaker_confidence: raw.speaker_confidence,
                timing_provenance: if clamped {
                    TimingProvenanceV1::Clamped
                } else {
                    raw.timing_provenance
                },
            });
        }
        normalized.push(NormalizedTranscriptChunkV1 {
            schema_version: 1,
            chunk_id: chunk.chunk_id.clone(),
            chunk_index: chunk.chunk_index,
            source_start_us: source_start as u64,
            source_end_us: source_end as u64,
            words,
        });
    }
    normalized.sort_by_key(|chunk| chunk.chunk_index);
    let (words, removed) = merge_normalized_words(&normalized);
    let uncertainty_counts = count_uncertainty(&words, removed);
    let transcript = NormalizedTranscriptV1 {
        schema_version: 1,
        chunks: normalized,
        words,
        uncertainty_counts,
    };
    validate_normalized_content(
        transcript.schema_version,
        &transcript.chunks,
        &transcript.words,
        &transcript.uncertainty_counts,
        None,
    )?;
    Ok(transcript)
}

#[cfg(test)]
pub fn create_transcript_artifact_v1(
    source_identity: MediaContentIdentityV1,
    source_fingerprint: SourceFingerprintV1,
    source_duration_us: u64,
    configuration: AsrConfigurationV1,
    chunks: &[TranscriptChunkInputV1],
) -> Result<TranscriptArtifactV1, VideoCommandError> {
    let configuration_identity = derive_asr_configuration_identity(&configuration)?;
    let identity = derive_transcript_artifact_identity(
        &source_identity,
        &source_fingerprint,
        &configuration_identity,
    )?;
    let normalized = normalize_transcript_chunks(chunks, source_duration_us)?;
    let artifact = TranscriptArtifactV1 {
        schema_version: 1,
        identity,
        source_duration_us,
        configuration,
        chunks: normalized.chunks,
        words: normalized.words,
        uncertainty_counts: normalized.uncertainty_counts,
    };
    validate_transcript_artifact(&artifact)?;
    Ok(artifact)
}

pub fn validate_transcript_artifact(
    artifact: &TranscriptArtifactV1,
) -> Result<(), VideoCommandError> {
    if artifact.schema_version != 1 {
        return Err(transcript_error("schema_version"));
    }
    require_positive_safe(artifact.source_duration_us, "source_duration")?;
    validate_configuration(&artifact.configuration)?;
    validate_artifact_identity(&artifact.identity)?;
    let configuration_identity = derive_asr_configuration_identity(&artifact.configuration)?;
    if artifact.identity.configuration_identity != configuration_identity {
        return Err(transcript_error("configuration_identity_mismatch"));
    }
    let identity = derive_transcript_artifact_identity(
        &artifact.identity.source_identity,
        &artifact.identity.source_fingerprint,
        &configuration_identity,
    )?;
    if artifact.identity != identity {
        return Err(transcript_error("artifact_identity_mismatch"));
    }
    validate_normalized_content(
        artifact.schema_version,
        &artifact.chunks,
        &artifact.words,
        &artifact.uncertainty_counts,
        Some(artifact.source_duration_us),
    )
}

pub fn load_transcript_artifact(path: &Path) -> Result<TranscriptArtifactV1, VideoCommandError> {
    let bytes = read_bounded(path)?;
    parse_transcript_artifact(&bytes)
}

#[cfg(test)]
pub fn load_transcript_artifact_for_identity(
    path: &Path,
    expected: &TranscriptArtifactIdentityV1,
) -> Result<TranscriptArtifactV1, VideoCommandError> {
    let artifact = load_transcript_artifact(path)?;
    if &artifact.identity != expected {
        return Err(transcript_error("load_identity_mismatch"));
    }
    Ok(artifact)
}

pub fn load_transcript_artifact_for_key(
    path: &Path,
    expected_key: &str,
) -> Result<TranscriptArtifactV1, VideoCommandError> {
    if !is_sha256(expected_key) {
        return Err(transcript_error("expected_key"));
    }
    let artifact = load_transcript_artifact(path)?;
    if artifact.identity.key != expected_key {
        return Err(transcript_error("load_identity_mismatch"));
    }
    Ok(artifact)
}

/// Loads only the path derived from the expected content-addressed key.
#[cfg(test)]
pub(crate) async fn load_managed_transcript_artifact(
    app_cache_root: &Path,
    expected: &TranscriptArtifactIdentityV1,
) -> Result<TranscriptArtifactV1, VideoCommandError> {
    validate_artifact_identity(expected)?;
    let guard =
        acquire_artifact(app_cache_root, ArtifactStoreKind::Transcript, &expected.key).await?;
    let artifact = load_transcript_artifact_for_identity(guard.path(), expected)?;
    guard.confirm_durable()?;
    Ok(artifact)
}

pub(super) async fn load_managed_transcript_artifact_for_key(
    app_cache_root: &Path,
    expected_key: &str,
) -> Result<TranscriptArtifactV1, VideoCommandError> {
    if !is_sha256(expected_key) {
        return Err(transcript_error("expected_key"));
    }
    let guard =
        acquire_artifact(app_cache_root, ArtifactStoreKind::Transcript, expected_key).await?;
    let artifact = load_transcript_artifact_for_key(guard.path(), expected_key)?;
    guard.confirm_durable()?;
    Ok(artifact)
}

#[cfg(test)]
pub(crate) async fn publish_transcript_artifact(
    app_cache_root: &Path,
    cache: &MediaCacheService,
    owner_label: &str,
    project_id: Option<&str>,
    artifact: &TranscriptArtifactV1,
) -> Result<PublishedTranscriptArtifact, VideoCommandError> {
    validate_transcript_artifact(artifact)?;
    let bytes = serde_json::to_vec(artifact).map_err(|_| transcript_error("serialize"))?;
    publish_validated_bytes(
        app_cache_root,
        cache,
        owner_label,
        project_id,
        artifact.clone(),
        &bytes,
    )
    .await
}

#[cfg(test)]
pub(crate) async fn publish_transcript_artifact_file(
    app_cache_root: &Path,
    cache: &MediaCacheService,
    owner_label: &str,
    project_id: Option<&str>,
    source_path: &Path,
    expected_identity: &TranscriptArtifactIdentityV1,
) -> Result<PublishedTranscriptArtifact, VideoCommandError> {
    let bytes = read_bounded(source_path)?;
    let artifact = parse_transcript_artifact(&bytes)?;
    if &artifact.identity != expected_identity {
        return Err(transcript_error("load_identity_mismatch"));
    }
    publish_validated_bytes(
        app_cache_root,
        cache,
        owner_label,
        project_id,
        artifact,
        &bytes,
    )
    .await
}

#[cfg(test)]
async fn publish_validated_bytes(
    app_cache_root: &Path,
    cache: &MediaCacheService,
    owner_label: &str,
    project_id: Option<&str>,
    artifact: TranscriptArtifactV1,
    bytes: &[u8],
) -> Result<PublishedTranscriptArtifact, VideoCommandError> {
    if bytes.len() as u64 > MAX_TRANSCRIPT_JSON_BYTES {
        return Err(transcript_error("json_size"));
    }
    let key = artifact.identity.key.clone();
    let guard = acquire_artifact(app_cache_root, ArtifactStoreKind::Transcript, &key).await?;
    let reused = if guard.path().exists() {
        let existing = read_bounded(guard.path())?;
        if existing != bytes {
            return Err(transcript_error("immutable_conflict"));
        }
        let existing_artifact = parse_transcript_artifact(&existing)?;
        if existing_artifact.identity != artifact.identity {
            return Err(transcript_error("load_identity_mismatch"));
        }
        true
    } else {
        let mut temporary = guard.temporary()?;
        temporary
            .as_file_mut()
            .write_all(bytes)
            .map_err(|_| transcript_error("temporary_write"))?;
        temporary
            .as_file_mut()
            .flush()
            .map_err(|_| transcript_error("temporary_flush"))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|_| transcript_error("temporary_sync"))?;
        let reread = read_bounded(temporary.path())?;
        if reread != bytes {
            return Err(transcript_error("temporary_bytes"));
        }
        let reread_artifact = parse_transcript_artifact(&reread)?;
        if reread_artifact.identity != artifact.identity {
            return Err(transcript_error("load_identity_mismatch"));
        }
        guard.promote(temporary)?;
        false
    };
    guard.confirm_durable()?;
    let path = guard.path().to_path_buf();
    let content_digest = sha256_hex(bytes);
    let lease_id = cache
        .register_and_lease(
            CacheArtifactRegistration {
                key: key.clone(),
                content_digest: content_digest.clone(),
                kind: CacheArtifactKind::Transcript,
                path: path.clone(),
                profile_id: None,
                toolchain_id: Some(artifact.configuration.engine_id.clone()),
                recipe_id: Some(artifact.identity.configuration_identity.digest.clone()),
            },
            owner_label.to_owned(),
            project_id.map(str::to_owned),
        )
        .await
        .map_err(|_| transcript_error("cache_register"))?;
    drop(guard);

    Ok(PublishedTranscriptArtifact {
        artifact,
        path,
        content_digest,
        lease_id,
        reused,
    })
}

fn parse_transcript_artifact(bytes: &[u8]) -> Result<TranscriptArtifactV1, VideoCommandError> {
    let artifact: TranscriptArtifactV1 =
        serde_json::from_slice(bytes).map_err(|_| transcript_error("json"))?;
    validate_transcript_artifact(&artifact)?;
    Ok(artifact)
}

fn read_bounded(path: &Path) -> Result<Vec<u8>, VideoCommandError> {
    let metadata = fs::symlink_metadata(path).map_err(|_| transcript_error("json_open"))?;
    if !metadata.file_type().is_file()
        || is_reparse_or_symlink(&metadata)
        || metadata.len() > MAX_TRANSCRIPT_JSON_BYTES
    {
        return Err(transcript_error("json_size"));
    }
    let file = File::open(path).map_err(|_| transcript_error("json_open"))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(MAX_TRANSCRIPT_JSON_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| transcript_error("json_read"))?;
    if bytes.len() as u64 > MAX_TRANSCRIPT_JSON_BYTES {
        return Err(transcript_error("json_size"));
    }
    Ok(bytes)
}

fn validate_configuration(configuration: &AsrConfigurationV1) -> Result<(), VideoCommandError> {
    if configuration.schema_version != 1 {
        return Err(transcript_error("configuration_schema"));
    }
    for value in [
        &configuration.engine_id,
        &configuration.engine_version,
        &configuration.model_id,
        &configuration.model_revision,
    ] {
        require_identifier(value, "configuration_identifier")?;
    }
    if let Some(language) = &configuration.requested_language {
        require_identifier(language, "requested_language")?;
    }
    require_positive_safe(configuration.chunk_duration_us, "chunk_duration")?;
    require_safe(configuration.chunk_overlap_us, "chunk_overlap")?;
    if configuration.chunk_overlap_us >= configuration.chunk_duration_us {
        return Err(transcript_error("chunk_overlap"));
    }
    if configuration.provider_settings.len() > MAX_PROVIDER_SETTINGS {
        return Err(transcript_error("provider_settings"));
    }
    let mut previous: Option<&str> = None;
    for setting in &configuration.provider_settings {
        require_ascii_identifier(&setting.key, 128, "provider_key")?;
        if previous.is_some_and(|key| key >= setting.key.as_str()) {
            return Err(transcript_error("provider_key_order"));
        }
        previous = Some(&setting.key);
        match &setting.value {
            AsrProviderSettingValueV1::String(value) => {
                if utf16_len(value) > MAX_PROVIDER_VALUE_UTF16 {
                    return Err(transcript_error("provider_value"));
                }
            }
            AsrProviderSettingValueV1::Number(value)
                if !value.is_finite()
                    || value.fract() != 0.0
                    || value.abs() > MAX_SAFE_INTEGER as f64 =>
            {
                return Err(transcript_error("provider_value"));
            }
            _ => {}
        }
    }
    Ok(())
}

fn validate_artifact_identity(
    identity: &TranscriptArtifactIdentityV1,
) -> Result<(), VideoCommandError> {
    if identity.schema_version != 1 || !is_sha256(&identity.key) {
        return Err(transcript_error("artifact_identity"));
    }
    validate_source_identity(&identity.source_identity)?;
    validate_source_fingerprint(&identity.source_fingerprint)?;
    validate_configuration_identity(&identity.configuration_identity)
}

fn validate_source_identity(identity: &MediaContentIdentityV1) -> Result<(), VideoCommandError> {
    if identity.schema_version != 1
        || identity.algorithm != MediaContentAlgorithm::Sha256
        || !is_sha256(&identity.digest)
    {
        return Err(transcript_error("source_identity"));
    }
    require_positive_safe(identity.byte_length, "source_byte_length")
}

fn validate_source_fingerprint(fingerprint: &SourceFingerprintV1) -> Result<(), VideoCommandError> {
    if fingerprint.schema_version != 1
        || fingerprint.algorithm != MediaContentAlgorithm::Sha256
        || !is_sha256(&fingerprint.digest)
        || fingerprint.modified_nanoseconds > 999_999_999
    {
        return Err(transcript_error("source_fingerprint"));
    }
    require_positive_safe(fingerprint.byte_length, "fingerprint_byte_length")?;
    require_safe(
        fingerprint.modified_unix_seconds,
        "fingerprint_modified_seconds",
    )
}

fn validate_configuration_identity(
    identity: &AsrConfigurationIdentityV1,
) -> Result<(), VideoCommandError> {
    if identity.schema_version != 1
        || identity.algorithm != MediaContentAlgorithm::Sha256
        || !is_sha256(&identity.digest)
    {
        return Err(transcript_error("configuration_identity"));
    }
    Ok(())
}

#[cfg(test)]
fn validate_input_chunk(chunk: &TranscriptChunkInputV1) -> Result<(), VideoCommandError> {
    if chunk.schema_version != 1 || chunk.source_end_us <= chunk.source_start_us {
        return Err(transcript_error("input_chunk"));
    }
    require_ascii_identifier(&chunk.chunk_id, 128, "chunk_id")?;
    require_safe(chunk.chunk_index, "chunk_index")?;
    require_signed_safe(chunk.source_start_us, "chunk_start")?;
    require_signed_safe(chunk.source_end_us, "chunk_end")?;
    if chunk.words.len() > MAX_CHUNK_WORDS {
        return Err(transcript_error("chunk_words"));
    }
    Ok(())
}

#[cfg(test)]
fn validate_input_word(word: &TranscriptChunkWordInputV1) -> Result<(), VideoCommandError> {
    require_text(&word.text)?;
    require_signed_safe(word.relative_start_us, "relative_start")?;
    require_signed_safe(word.relative_end_us, "relative_end")?;
    require_confidence(word.recognition_confidence)?;
    require_confidence(word.speaker_confidence)?;
    if let Some(label) = &word.speaker_label {
        require_identifier(label, "speaker_label")?;
    }
    Ok(())
}

fn validate_word(word: &TranscriptWordV1) -> Result<(), VideoCommandError> {
    if word.word_id.is_empty()
        || utf16_len(&word.word_id) > 256
        || word.word_id != format!("{}:{}", word.chunk_id, word.word_index)
        || word.source_end_us <= word.source_start_us
    {
        return Err(transcript_error("word_identity_span"));
    }
    require_ascii_identifier(&word.chunk_id, 128, "chunk_id")?;
    require_safe(word.chunk_index, "word_chunk_index")?;
    require_safe(word.word_index, "word_index")?;
    require_safe(word.source_start_us, "word_start")?;
    require_positive_safe(word.source_end_us, "word_end")?;
    require_text(&word.text)?;
    require_confidence(word.recognition_confidence)?;
    require_confidence(word.speaker_confidence)?;
    if let Some(label) = &word.speaker_label {
        require_identifier(label, "speaker_label")?;
    }
    Ok(())
}

fn validate_normalized_content(
    schema_version: u64,
    chunks: &[NormalizedTranscriptChunkV1],
    words: &[TranscriptWordV1],
    uncertainty: &TranscriptUncertaintyCountsV1,
    source_duration: Option<u64>,
) -> Result<(), VideoCommandError> {
    if schema_version != 1 || chunks.len() > MAX_CHUNKS || words.len() > MAX_WORDS {
        return Err(transcript_error("normalized_shape"));
    }
    let mut ids = HashSet::new();
    let mut previous_index = None;
    for chunk in chunks {
        if chunk.schema_version != 1
            || chunk.words.len() > MAX_CHUNK_WORDS
            || chunk.source_end_us <= chunk.source_start_us
            || source_duration.is_some_and(|duration| chunk.source_end_us > duration)
            || !ids.insert(chunk.chunk_id.as_str())
            || previous_index.is_some_and(|index| index >= chunk.chunk_index)
        {
            return Err(transcript_error("normalized_chunk"));
        }
        require_ascii_identifier(&chunk.chunk_id, 128, "chunk_id")?;
        require_safe(chunk.chunk_index, "chunk_index")?;
        require_safe(chunk.source_start_us, "chunk_start")?;
        require_positive_safe(chunk.source_end_us, "chunk_end")?;
        previous_index = Some(chunk.chunk_index);
        for (index, word) in chunk.words.iter().enumerate() {
            validate_word(word)?;
            if word.chunk_id != chunk.chunk_id
                || word.chunk_index != chunk.chunk_index
                || word.word_index != index as u64
                || word.source_start_us < chunk.source_start_us
                || word.source_end_us > chunk.source_end_us
            {
                return Err(transcript_error("chunk_word_reference"));
            }
        }
    }
    let mut duplicates = HashSet::new();
    for (index, word) in words.iter().enumerate() {
        validate_word(word)?;
        if source_duration.is_some_and(|duration| word.source_end_us > duration)
            || index > 0 && compare_words(&words[index - 1], word) != Ordering::Less
            || !duplicates.insert((word.text.as_str(), word.source_start_us, word.source_end_us))
        {
            return Err(transcript_error("word_chronology"));
        }
    }
    let (expected, removed) = merge_normalized_words(chunks);
    if words != expected.as_slice() || uncertainty != &count_uncertainty(&expected, removed) {
        return Err(transcript_error("normalized_merge_uncertainty"));
    }
    for count in [
        uncertainty.missing_confidence_word_count,
        uncertainty.missing_speaker_word_count,
        uncertainty.estimated_timing_word_count,
        uncertainty.clamped_timing_word_count,
        uncertainty.retained_overlap_word_count,
        uncertainty.removed_exact_duplicate_word_count,
    ] {
        require_safe(count, "uncertainty_count")?;
    }
    Ok(())
}

fn merge_normalized_words(chunks: &[NormalizedTranscriptChunkV1]) -> (Vec<TranscriptWordV1>, u64) {
    let mut all = chunks
        .iter()
        .flat_map(|chunk| chunk.words.iter().cloned())
        .collect::<Vec<_>>();
    all.sort_by(compare_words);
    let total = all.len();
    let mut unique: HashMap<(String, u64, u64), TranscriptWordV1> = HashMap::new();
    for word in all {
        let key = (word.text.clone(), word.source_start_us, word.source_end_us);
        match unique.get(&key) {
            Some(existing) if prefer_first_duplicate(existing, &word) => {}
            _ => {
                unique.insert(key, word);
            }
        }
    }
    let mut words = unique.into_values().collect::<Vec<_>>();
    words.sort_by(compare_words);
    let removed = (total - words.len()) as u64;
    (words, removed)
}

fn prefer_first_duplicate(first: &TranscriptWordV1, second: &TranscriptWordV1) -> bool {
    let first_confidence = first.recognition_confidence.unwrap_or(-1.0);
    let second_confidence = second.recognition_confidence.unwrap_or(-1.0);
    first_confidence > second_confidence
        || first_confidence == second_confidence
            && compare_words(first, second) != Ordering::Greater
}

fn compare_words(first: &TranscriptWordV1, second: &TranscriptWordV1) -> Ordering {
    first
        .source_start_us
        .cmp(&second.source_start_us)
        .then(first.source_end_us.cmp(&second.source_end_us))
        .then(first.chunk_index.cmp(&second.chunk_index))
        .then(first.word_index.cmp(&second.word_index))
        .then(first.word_id.cmp(&second.word_id))
}

fn count_uncertainty(words: &[TranscriptWordV1], removed: u64) -> TranscriptUncertaintyCountsV1 {
    let mut counts = TranscriptUncertaintyCountsV1 {
        missing_confidence_word_count: 0,
        missing_speaker_word_count: 0,
        estimated_timing_word_count: 0,
        clamped_timing_word_count: 0,
        retained_overlap_word_count: 0,
        removed_exact_duplicate_word_count: removed,
    };
    let mut furthest_end = None;
    for word in words {
        counts.missing_confidence_word_count += u64::from(word.recognition_confidence.is_none());
        counts.missing_speaker_word_count += u64::from(word.speaker_label.is_none());
        counts.estimated_timing_word_count +=
            u64::from(word.timing_provenance == TimingProvenanceV1::Estimated);
        counts.clamped_timing_word_count +=
            u64::from(word.timing_provenance == TimingProvenanceV1::Clamped);
        counts.retained_overlap_word_count +=
            u64::from(furthest_end.is_some_and(|end| word.source_start_us < end));
        furthest_end = Some(furthest_end.unwrap_or(0).max(word.source_end_us));
    }
    counts
}

#[cfg(test)]
fn checked_safe_sum(first: i64, second: i64) -> Result<i64, VideoCommandError> {
    let value = first
        .checked_add(second)
        .ok_or_else(|| transcript_error("word_time_sum"))?;
    require_signed_safe(value, "word_time_sum")?;
    Ok(value)
}

fn require_safe(value: u64, category: &'static str) -> Result<(), VideoCommandError> {
    if value <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(transcript_error(category))
    }
}

fn require_positive_safe(value: u64, category: &'static str) -> Result<(), VideoCommandError> {
    if value > 0 {
        require_safe(value, category)
    } else {
        Err(transcript_error(category))
    }
}

fn require_signed_safe(value: i64, category: &'static str) -> Result<(), VideoCommandError> {
    if value.unsigned_abs() <= MAX_SAFE_INTEGER {
        Ok(())
    } else {
        Err(transcript_error(category))
    }
}

fn require_confidence(value: Option<f64>) -> Result<(), VideoCommandError> {
    if value.is_none_or(|value| value.is_finite() && (0.0..=1.0).contains(&value)) {
        Ok(())
    } else {
        Err(transcript_error("confidence"))
    }
}

fn require_identifier(value: &str, category: &'static str) -> Result<(), VideoCommandError> {
    if !value.trim().is_empty() && utf16_len(value) <= MAX_IDENTIFIER_UTF16 {
        Ok(())
    } else {
        Err(transcript_error(category))
    }
}

fn require_ascii_identifier(
    value: &str,
    max_len: usize,
    category: &'static str,
) -> Result<(), VideoCommandError> {
    if !value.is_empty()
        && value.len() <= max_len
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
    {
        Ok(())
    } else {
        Err(transcript_error(category))
    }
}

fn require_text(value: &str) -> Result<(), VideoCommandError> {
    if !value.is_empty() && !value.trim().is_empty() && utf16_len(value) <= MAX_TEXT_UTF16 {
        Ok(())
    } else {
        Err(transcript_error("word_text"))
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn is_reparse_or_symlink(metadata: &Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn transcript_error(category: &'static str) -> VideoCommandError {
    VideoCommandError::invalid_media("transcribe_asset", category)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::video::{jobs::store::MediaJobStore, media_store::MEDIA_STORE_NAMESPACE};

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ProviderNumberFixtureV1 {
        schema_version: u64,
        base_configuration: AsrConfigurationV1,
        accepted: Vec<AcceptedProviderNumberVectorV1>,
        rejected: Vec<ProviderNumberVectorV1>,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct AcceptedProviderNumberVectorV1 {
        name: String,
        value: f64,
        expected_digest: String,
    }

    #[derive(Debug, Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct ProviderNumberVectorV1 {
        name: String,
        value: f64,
    }

    fn fixture() -> TranscriptArtifactFixtureV1 {
        serde_json::from_slice(include_bytes!(
            "../../../../../packages/video-media/fixtures/transcript-artifact-v1.json"
        ))
        .expect("final transcript fixture must match the Rust mirror")
    }

    fn provider_number_fixture() -> ProviderNumberFixtureV1 {
        serde_json::from_slice(include_bytes!(
            "../../../../../packages/video-media/fixtures/transcript-provider-number-v1.json"
        ))
        .expect("provider-number fixture must match the Rust mirror")
    }

    fn configuration_with_provider_number(
        base_configuration: &AsrConfigurationV1,
        value: f64,
    ) -> AsrConfigurationV1 {
        let mut configuration = base_configuration.clone();
        configuration.provider_settings = vec![AsrProviderSettingV1 {
            key: "numeric_value".to_owned(),
            value: AsrProviderSettingValueV1::Number(value),
        }];
        configuration
    }

    async fn cache_service(root: &Path) -> (MediaJobStore, MediaCacheService, PathBuf) {
        let cache_root = root.join("cache");
        fs::create_dir_all(cache_root.join(MEDIA_STORE_NAMESPACE)).unwrap();
        let store = MediaJobStore::initialize(root.join("local")).await.unwrap();
        let cache =
            MediaCacheService::new(&store, cache_root.clone(), "transcript-test".to_owned());
        (store, cache, cache_root)
    }

    #[test]
    fn final_fixture_has_hash_and_artifact_parity() {
        let fixture = fixture();
        let configuration_identity =
            derive_asr_configuration_identity(&fixture.configuration).unwrap();
        assert_eq!(configuration_identity, fixture.configuration_identity);
        let artifact_identity = derive_transcript_artifact_identity(
            &fixture.source_identity,
            &fixture.source_fingerprint,
            &configuration_identity,
        )
        .unwrap();
        assert_eq!(artifact_identity, fixture.artifact.identity);
        let artifact = create_transcript_artifact_v1(
            fixture.source_identity,
            fixture.source_fingerprint,
            fixture.source_duration_us,
            fixture.configuration,
            &fixture.chunks,
        )
        .unwrap();
        assert_eq!(artifact, fixture.artifact);
        validate_transcript_artifact(&artifact).unwrap();
    }

    #[test]
    fn provider_numbers_match_shared_identity_and_rejection_vectors() {
        let fixture = provider_number_fixture();
        assert_eq!(fixture.schema_version, 1);

        for vector in &fixture.accepted {
            let configuration =
                configuration_with_provider_number(&fixture.base_configuration, vector.value);
            let identity = derive_asr_configuration_identity(&configuration)
                .unwrap_or_else(|error| panic!("{} was rejected: {error:?}", vector.name));
            assert_eq!(identity.digest, vector.expected_digest, "{}", vector.name);
        }

        for vector in &fixture.rejected {
            let configuration =
                configuration_with_provider_number(&fixture.base_configuration, vector.value);
            let error = derive_asr_configuration_identity(&configuration)
                .expect_err(&format!("{} should be rejected", vector.name));
            assert_eq!(
                error.details["category"], "provider_value",
                "{}",
                vector.name
            );
        }

        let zero = fixture
            .accepted
            .iter()
            .find(|vector| vector.name == "zero")
            .unwrap();
        let negative_zero = fixture
            .accepted
            .iter()
            .find(|vector| vector.name == "negative-zero")
            .unwrap();
        assert!(negative_zero.value.is_sign_negative());
        let zero_identity = derive_asr_configuration_identity(&configuration_with_provider_number(
            &fixture.base_configuration,
            zero.value,
        ))
        .unwrap();
        let negative_zero_identity = derive_asr_configuration_identity(
            &configuration_with_provider_number(&fixture.base_configuration, negative_zero.value),
        )
        .unwrap();
        assert_eq!(zero_identity, negative_zero_identity);
    }

    #[test]
    fn bounded_load_rejects_identity_mismatch() {
        let fixture = fixture();
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("artifact.json");
        fs::write(&source, serde_json::to_vec(&fixture.artifact).unwrap()).unwrap();
        let mut expected = fixture.artifact.identity.clone();
        expected.key = "0".repeat(64);
        let error = load_transcript_artifact_for_identity(&source, &expected).unwrap_err();
        assert_eq!(error.details["category"], "load_identity_mismatch");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn exact_key_loader_rejects_a_malformed_key_before_touching_the_cache() {
        let root = tempfile::tempdir().unwrap();
        let cache_root = root.path().join("cache");

        let error = load_managed_transcript_artifact_for_key(&cache_root, "../artifact.json")
            .await
            .unwrap_err();

        assert_eq!(error.details["category"], "expected_key");
        assert!(!cache_root.exists());
    }

    #[tokio::test(flavor = "current_thread")]
    async fn exact_key_loader_reports_a_missing_managed_artifact() {
        let fixture = fixture();
        let root = tempfile::tempdir().unwrap();
        let cache_root = root.path().join("cache");

        let error =
            load_managed_transcript_artifact_for_key(&cache_root, &fixture.artifact.identity.key)
                .await
                .unwrap_err();

        assert_eq!(error.details["category"], "json_open");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn exact_key_loader_rejects_an_artifact_with_another_identity() {
        let fixture = fixture();
        let root = tempfile::tempdir().unwrap();
        let expected_key = "f".repeat(64);
        let guard = acquire_artifact(root.path(), ArtifactStoreKind::Transcript, &expected_key)
            .await
            .unwrap();
        fs::write(guard.path(), serde_json::to_vec(&fixture.artifact).unwrap()).unwrap();

        guard.confirm_durable().unwrap();
        drop(guard);

        let error = load_managed_transcript_artifact_for_key(root.path(), &expected_key)
            .await
            .unwrap_err();

        assert_eq!(error.details["category"], "load_identity_mismatch");
    }

    #[test]
    fn exact_key_request_cannot_supply_an_arbitrary_path() {
        let fixture = fixture();
        let result = serde_json::from_value::<super::super::LoadManagedTranscriptArtifactRequest>(
            serde_json::json!({
                "artifactKey": fixture.artifact.identity.key,
                "path": "../../outside/artifact.json",
            }),
        );

        assert!(result.is_err());
    }

    #[test]
    fn exact_key_response_serializes_as_the_checked_artifact_contract() {
        let fixture = fixture();
        let serialized = serde_json::to_vec(&fixture.artifact).unwrap();
        let response = serde_json::from_slice::<TranscriptArtifactV1>(&serialized).unwrap();

        assert_eq!(response, fixture.artifact);
        assert!(!String::from_utf8(serialized)
            .unwrap()
            .contains("artifactPath"));
    }

    #[tokio::test(flavor = "current_thread")]
    async fn race_actual_transcript_publication_fresh_and_reserved_reuse() {
        use crate::video::cache::tests::{assert_published_lease, publication_race};
        for reused in [false, true] {
            let artifact = fixture().artifact;
            let bytes = serde_json::to_vec(&artifact).unwrap();
            let root = tempfile::tempdir().unwrap();
            let (_store, cache, cache_root) = cache_service(root.path()).await;
            if reused {
                publish_transcript_artifact(&cache_root, &cache, "reader", None, &artifact)
                    .await
                    .unwrap();
                cache.release_owner("reader".into()).await.unwrap();
            }
            let published = publication_race(&cache, reused, move |publisher| async move {
                publish_transcript_artifact(&cache_root, &publisher, "reader", None, &artifact)
                    .await
                    .unwrap()
            });
            assert_eq!(published.reused, reused);
            assert!(!published.lease_id.is_empty());
            let key = published.path.file_stem().unwrap().to_str().unwrap();
            assert_published_lease(&cache, key, &published.path, &bytes, "reader").await;
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn immutable_publish_reuses_identical_bytes_and_rejects_conflicts() {
        let fixture = fixture();
        let root = tempfile::tempdir().unwrap();
        let (_store, cache, cache_root) = cache_service(root.path()).await;
        let source = root.path().join("source.json");
        let source_bytes = serde_json::to_vec(&fixture.artifact).unwrap();
        fs::write(&source, &source_bytes).unwrap();

        let first = publish_transcript_artifact_file(
            &cache_root,
            &cache,
            "transcript-owner",
            None,
            &source,
            &fixture.artifact.identity,
        )
        .await
        .unwrap();
        assert!(!first.reused);
        assert_eq!(fs::read(&source).unwrap(), source_bytes);
        let managed_root = fs::canonicalize(cache_root.join(MEDIA_STORE_NAMESPACE)).unwrap();
        assert!(first.path.starts_with(&managed_root));

        let second = publish_transcript_artifact_file(
            &cache_root,
            &cache,
            "transcript-owner",
            None,
            &source,
            &fixture.artifact.identity,
        )
        .await
        .unwrap();
        assert!(second.reused);
        assert_eq!(second.path, first.path);
        assert_eq!(second.content_digest, first.content_digest);
        assert!(!first.lease_id.is_empty());

        let conflicting_source = root.path().join("conflicting.json");
        let conflicting_bytes = serde_json::to_vec_pretty(&fixture.artifact).unwrap();
        assert_ne!(conflicting_bytes, source_bytes);
        fs::write(&conflicting_source, &conflicting_bytes).unwrap();
        let before = fs::read(&first.path).unwrap();
        let error = publish_transcript_artifact_file(
            &cache_root,
            &cache,
            "other-owner",
            None,
            &conflicting_source,
            &fixture.artifact.identity,
        )
        .await
        .unwrap_err();
        assert_eq!(error.details["category"], "immutable_conflict");
        assert_eq!(fs::read(&first.path).unwrap(), before);
        assert_eq!(fs::read(&conflicting_source).unwrap(), conflicting_bytes);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn exact_key_loader_returns_a_valid_artifact_from_the_contained_managed_path() {
        let fixture = fixture();
        let root = tempfile::tempdir().unwrap();
        let (_store, cache, cache_root) = cache_service(root.path()).await;
        let published = publish_transcript_artifact(
            &cache_root,
            &cache,
            "managed-loader",
            None,
            &fixture.artifact,
        )
        .await
        .unwrap();
        let loaded =
            load_managed_transcript_artifact_for_key(&cache_root, &fixture.artifact.identity.key)
                .await
                .unwrap();
        assert_eq!(loaded, fixture.artifact);
        let managed_root = fs::canonicalize(cache_root.join(MEDIA_STORE_NAMESPACE)).unwrap();
        assert!(published.path.starts_with(&managed_root));
        assert_eq!(
            published.path.file_name().unwrap().to_string_lossy(),
            format!("{}.json", fixture.artifact.identity.key)
        );
    }
}
