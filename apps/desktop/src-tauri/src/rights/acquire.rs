//! Acquisition state machine:
//! fetch metadata -> snapshot -> policy -> download to quarantine (streamed
//! hash, size cap) -> MIME/probe -> re-verify record -> promote -> commit receipt.
//!
//! One `CancelToken` spans every stage. Quarantine files are `NamedTempFile`s,
//! so any early return deletes them. The receipt row and its snapshot blobs
//! commit in one SQLite transaction only after promotion succeeds; if that
//! commit fails, a newly published object is removed again.

use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

use serde::Serialize;
use sha2::{Digest, Sha256};
use tempfile::{Builder as TempFileBuilder, NamedTempFile};
use url::Url;

use super::{
    attribution::missing_attribution_fields,
    license::provider_terms_url,
    net::{
        build_client, fetch_bytes, fetch_to_writer, CancelToken, Credential, FetchLimits,
        FetchMeta, FetchRequest, NetError, NetPolicy, ProviderKeyStore,
    },
    policy::evaluate_policy,
    providers::{self, AdapterError, ItemParse, NormalizedRights, ProviderEndpoints, ProviderItem},
    store::{ReceiptStore, ReceiptStoreError, SnapshotBlob},
    types::{
        is_valid_provider_item_id, AcquireRequest, AcquisitionReceipt, MediaKind, PolicyDecision,
        PolicyOutcome, RefreshStatus, SnapshotKind,
    },
};
use crate::video::media_store::{
    promote_quarantined_blocking, quarantine_directory_blocking, remove_promoted_source,
    MediaContentAlgorithm, MediaContentIdentityV1,
};

pub const QUARANTINE_PREFIX: &str = ".acq-";
pub const QUARANTINE_MAX_AGE: Duration = Duration::from_secs(60 * 60);
const SNIFF_BYTES: usize = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum AcquireStage {
    FetchMetadata,
    Snapshot,
    Policy,
    Download,
    Validate,
    Reverify,
    Promote,
    Commit,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AcquireError {
    InvalidRequest,
    Adapter(AdapterError),
    Net {
        stage: AcquireStage,
        error: NetError,
    },
    Withdrawn,
    PolicyBlocked(PolicyDecision),
    AttributionIncomplete(Vec<&'static str>),
    MimeMismatch,
    ProbeFailed(&'static str),
    UpstreamChanged,
    Cancelled,
    Store(&'static str),
    Media(&'static str),
}

impl AcquireError {
    pub fn code(&self) -> &'static str {
        match self {
            AcquireError::InvalidRequest => "invalid_request",
            AcquireError::Adapter(AdapterError::KeyMissing) => "provider_key_missing",
            AcquireError::Adapter(_) => "provider_record_invalid",
            AcquireError::Net { .. } => "network_failed",
            AcquireError::Withdrawn => "upstream_withdrawn",
            AcquireError::PolicyBlocked(_) => "policy_blocked",
            AcquireError::AttributionIncomplete(_) => "attribution_incomplete",
            AcquireError::MimeMismatch => "mime_mismatch",
            AcquireError::ProbeFailed(_) => "probe_failed",
            AcquireError::UpstreamChanged => "upstream_changed",
            AcquireError::Cancelled => "cancelled",
            AcquireError::Store(_) => "store_failed",
            AcquireError::Media(_) => "media_store_failed",
        }
    }

    pub fn message(&self) -> String {
        match self {
            AcquireError::InvalidRequest => "The acquisition request is invalid.".into(),
            AcquireError::Adapter(error) => {
                format!("The provider record could not be used: {error}.")
            }
            AcquireError::Net { error, .. } => format!("Download failed: {error}."),
            AcquireError::Withdrawn => "The provider no longer lists this item.".into(),
            AcquireError::PolicyBlocked(_) => {
                "This license does not allow the intended use.".into()
            }
            AcquireError::AttributionIncomplete(fields) => {
                format!(
                    "Required credit information is missing: {}.",
                    fields.join(", ")
                )
            }
            AcquireError::MimeMismatch => {
                "The downloaded file is not the expected media type.".into()
            }
            AcquireError::ProbeFailed(_) => "The downloaded file is not readable media.".into(),
            AcquireError::UpstreamChanged => "The provider record changed during download.".into(),
            AcquireError::Cancelled => "Acquisition was cancelled.".into(),
            AcquireError::Store(_) => "The rights receipt could not be saved.".into(),
            AcquireError::Media(_) => "The media file could not be stored.".into(),
        }
    }

    fn net(stage: AcquireStage, error: NetError) -> Self {
        if error == NetError::Cancelled {
            AcquireError::Cancelled
        } else {
            AcquireError::Net { stage, error }
        }
    }
}

impl From<ReceiptStoreError> for AcquireError {
    fn from(error: ReceiptStoreError) -> Self {
        AcquireError::Store(match error {
            ReceiptStoreError::Sqlite(_) => "sqlite",
            ReceiptStoreError::Io(_) => "io",
            _ => "receipt",
        })
    }
}

/// Final media verification after MIME sniffing (ffprobe in production).
pub trait MediaVerifier: Send + Sync {
    fn verify(
        &self,
        path: &Path,
        kind: MediaKind,
        cancel: &CancelToken,
    ) -> Result<(), &'static str>;
}

pub struct AcquireContext<'a> {
    pub endpoints: &'a ProviderEndpoints,
    pub keys: &'a dyn ProviderKeyStore,
    pub store: &'a ReceiptStore,
    pub app_cache_root: &'a Path,
    pub net_policy: &'a dyn Fn(super::types::ProviderId) -> NetPolicy,
    pub verifier: &'a dyn MediaVerifier,
    pub now_ms: &'a dyn Fn() -> u64,
    pub media_limits: FetchLimits,
    pub cancel: CancelToken,
    /// Called on entry to every stage (progress reporting; tests cancel here).
    pub on_stage: &'a dyn Fn(AcquireStage),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcquireOutcome {
    pub receipt: AcquisitionReceipt,
    #[serde(skip)]
    pub object_path: PathBuf,
}

/// Fetched and parsed authoritative record.
pub(crate) struct FetchedRecord {
    pub(crate) meta: FetchMeta,
    pub(crate) bytes: Vec<u8>,
    pub(crate) parsed: ItemParse,
}

pub(crate) fn fetch_record(
    ctx_endpoints: &ProviderEndpoints,
    keys: &dyn ProviderKeyStore,
    policy: &NetPolicy,
    provider_id: super::types::ProviderId,
    item_id: &str,
    cancel: &CancelToken,
) -> Result<FetchedRecord, AcquireError> {
    let key = providers::requires_key(provider_id)
        .then(|| keys.key(provider_id))
        .flatten();
    let request = providers::item_request(ctx_endpoints, provider_id, item_id, key)
        .map_err(AcquireError::Adapter)?;
    let client = build_client(request.limits)
        .map_err(|e| AcquireError::net(AcquireStage::FetchMetadata, e))?;
    match fetch_bytes(&client, policy, &request, cancel) {
        Ok((meta, bytes)) => {
            let parsed = providers::parse_item(provider_id, item_id, &bytes)
                .map_err(AcquireError::Adapter)?;
            Ok(FetchedRecord {
                meta,
                bytes,
                parsed,
            })
        }
        // A definitive "gone" from the provider is withdrawal, not a transport failure.
        Err(NetError::Status(404 | 410)) => Ok(FetchedRecord {
            meta: FetchMeta {
                final_url: super::net::redact_url(&request.url),
                status: 404,
                content_type: None,
                etag: None,
                byte_length: 0,
                elapsed_ms: 0,
            },
            bytes: Vec::new(),
            parsed: ItemParse::Withdrawn,
        }),
        Err(error) => Err(AcquireError::net(AcquireStage::FetchMetadata, error)),
    }
}

fn fetch_snapshot(
    policy: &NetPolicy,
    kind: SnapshotKind,
    raw_url: &str,
    fetched_at_ms: u64,
    cancel: &CancelToken,
) -> Result<SnapshotBlob, AcquireError> {
    let url = Url::parse(raw_url)
        .map_err(|_| AcquireError::net(AcquireStage::Snapshot, NetError::InvalidUrl))?;
    let request = FetchRequest {
        url,
        credential: Credential::None,
        limits: FetchLimits::METADATA,
    };
    let client =
        build_client(request.limits).map_err(|e| AcquireError::net(AcquireStage::Snapshot, e))?;
    let (meta, bytes) = fetch_bytes(&client, policy, &request, cancel)
        .map_err(|e| AcquireError::net(AcquireStage::Snapshot, e))?;
    Ok(SnapshotBlob::new(
        kind,
        meta.final_url,
        media_type_of(meta.content_type.as_deref()),
        fetched_at_ms,
        bytes,
    ))
}

fn media_type_of(content_type: Option<&str>) -> String {
    content_type
        .and_then(|value| value.split(';').next())
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty() && value.len() <= 128)
        .unwrap_or_else(|| "application/octet-stream".into())
}

/// Builds the evidence set: API record (required), license deed or provider
/// terms (required when the license names one), landing page (when allowlisted).
pub(crate) fn collect_snapshots(
    policy: &NetPolicy,
    item: &ProviderItem,
    rights: &NormalizedRights,
    record: &FetchedRecord,
    now_ms: u64,
    cancel: &CancelToken,
) -> Result<Vec<SnapshotBlob>, AcquireError> {
    let mut blobs = vec![SnapshotBlob::new(
        SnapshotKind::ApiRecord,
        record.meta.final_url.clone(),
        media_type_of(record.meta.content_type.as_deref()),
        now_ms,
        record.bytes.clone(),
    )];
    if let Some(landing) = item.landing_url.as_deref() {
        let allowed = Url::parse(landing)
            .map(|u| policy.check(&u).is_ok())
            .unwrap_or(false);
        if allowed {
            blobs.push(fetch_snapshot(
                policy,
                SnapshotKind::LandingPage,
                landing,
                now_ms,
                cancel,
            )?);
        }
    }
    if let Some(terms) = provider_terms_url(item.provider_id) {
        blobs.push(fetch_snapshot(
            policy,
            SnapshotKind::ProviderTerms,
            terms,
            now_ms,
            cancel,
        )?);
    } else if let Some(license_url) = rights.license.url.as_deref() {
        blobs.push(fetch_snapshot(
            policy,
            SnapshotKind::LicensePage,
            license_url,
            now_ms,
            cancel,
        )?);
    }
    // Deterministic order for hashing and comparisons.
    blobs.sort_by(|a, b| {
        a.meta
            .kind
            .cmp(&b.meta.kind)
            .then_with(|| a.meta.digest.cmp(&b.meta.digest))
    });
    blobs.dedup_by(|a, b| a.meta.kind == b.meta.kind && a.meta.digest == b.meta.digest);
    Ok(blobs)
}

struct HashingWriter<'a> {
    file: &'a mut NamedTempFile,
    hasher: Sha256,
    head: Vec<u8>,
    written: u64,
}

impl Write for HashingWriter<'_> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let written = self.file.write(buf)?;
        self.hasher.update(&buf[..written]);
        if self.head.len() < SNIFF_BYTES {
            let take = (SNIFF_BYTES - self.head.len()).min(written);
            self.head.extend_from_slice(&buf[..take]);
        }
        self.written += written as u64;
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

/// Magic-byte sniffing. Returns the detected MIME type.
pub fn sniff_media_type(head: &[u8]) -> Option<&'static str> {
    let starts = |prefix: &[u8]| head.starts_with(prefix);
    let at = |offset: usize, needle: &[u8]| head.get(offset..offset + needle.len()) == Some(needle);
    if starts(&[0x1A, 0x45, 0xDF, 0xA3]) {
        return Some("video/webm");
    }
    if at(4, b"ftyp") {
        if at(8, b"M4A ") || at(8, b"M4B ") {
            return Some("audio/mp4");
        }
        if at(8, b"qt  ") {
            return Some("video/quicktime");
        }
        return Some("video/mp4");
    }
    if starts(b"OggS") {
        return Some("application/ogg");
    }
    if starts(b"RIFF") {
        if at(8, b"AVI ") {
            return Some("video/x-msvideo");
        }
        if at(8, b"WAVE") {
            return Some("audio/wav");
        }
        if at(8, b"WEBP") {
            return Some("image/webp");
        }
    }
    if starts(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if starts(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return Some("image/png");
    }
    if starts(b"GIF87a") || starts(b"GIF89a") {
        return Some("image/gif");
    }
    if starts(b"II*\0") || starts(b"MM\0*") {
        return Some("image/tiff");
    }
    if starts(b"fLaC") {
        return Some("audio/flac");
    }
    if starts(b"ID3") || (head.len() >= 2 && head[0] == 0xFF && (head[1] & 0xE0) == 0xE0) {
        return Some("audio/mpeg");
    }
    None
}

fn family(media_type: &str) -> &str {
    media_type.split('/').next().unwrap_or_default()
}

fn kind_matches(sniffed: &str, kind: MediaKind) -> bool {
    if sniffed == "application/ogg" {
        return matches!(kind, MediaKind::Video | MediaKind::Audio);
    }
    // MP4 containers are frequently audio-only (m4a without brand hints).
    if sniffed == "video/mp4" && kind == MediaKind::Audio {
        return true;
    }
    family(sniffed)
        == match kind {
            MediaKind::Video => "video",
            MediaKind::Image => "image",
            MediaKind::Audio => "audio",
        }
}

pub(crate) fn check_mime(
    head: &[u8],
    kind: MediaKind,
    response_type: Option<&str>,
    expected: Option<&str>,
) -> Result<&'static str, AcquireError> {
    let sniffed = sniff_media_type(head).ok_or(AcquireError::MimeMismatch)?;
    if !kind_matches(sniffed, kind) {
        return Err(AcquireError::MimeMismatch);
    }
    let compatible = |declared: &str| {
        let declared = media_type_of(Some(declared));
        declared == "application/octet-stream"
            || declared == "binary/octet-stream"
            || declared == "application/ogg"
            || family(&declared) == family(sniffed)
            || (sniffed == "application/ogg" && matches!(family(&declared), "video" | "audio"))
            || (sniffed == "video/mp4" && family(&declared) == "audio")
    };
    if response_type.is_some_and(|t| !compatible(t)) || expected.is_some_and(|t| !compatible(t)) {
        return Err(AcquireError::MimeMismatch);
    }
    Ok(sniffed)
}

fn download_to_quarantine(
    ctx: &AcquireContext<'_>,
    policy: &NetPolicy,
    item: &ProviderItem,
) -> Result<(NamedTempFile, MediaContentIdentityV1, &'static str), AcquireError> {
    let directory = quarantine_directory_blocking(ctx.app_cache_root)
        .map_err(|_| AcquireError::Media("quarantine"))?;
    let mut quarantine = TempFileBuilder::new()
        .prefix(QUARANTINE_PREFIX)
        .suffix(".part")
        .tempfile_in(directory)
        .map_err(|_| AcquireError::Media("quarantine"))?;
    let url = Url::parse(&item.download_url)
        .map_err(|_| AcquireError::net(AcquireStage::Download, NetError::InvalidUrl))?;
    let request = FetchRequest {
        url,
        credential: Credential::None,
        limits: ctx.media_limits,
    };
    let client =
        build_client(request.limits).map_err(|e| AcquireError::net(AcquireStage::Download, e))?;
    let (meta, digest, head) = {
        let mut writer = HashingWriter {
            file: &mut quarantine,
            hasher: Sha256::new(),
            head: Vec::with_capacity(SNIFF_BYTES),
            written: 0,
        };
        let meta = fetch_to_writer(&client, policy, &request, &ctx.cancel, &mut writer)
            .map_err(|e| AcquireError::net(AcquireStage::Download, e))?;
        if meta.byte_length != writer.written {
            return Err(AcquireError::net(
                AcquireStage::Download,
                NetError::Transport("length"),
            ));
        }
        let digest: String = writer
            .hasher
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect();
        (meta, digest, writer.head)
    };
    quarantine
        .as_file()
        .sync_all()
        .map_err(|_| AcquireError::Media("quarantine_sync"))?;
    if meta.byte_length == 0 {
        return Err(AcquireError::MimeMismatch);
    }
    (ctx.on_stage)(AcquireStage::Validate);
    ctx.cancel.check().map_err(|_| AcquireError::Cancelled)?;
    let sniffed = check_mime(
        &head,
        item.media_kind,
        meta.content_type.as_deref(),
        item.expected_media_type.as_deref(),
    )?;
    let identity = MediaContentIdentityV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest,
        byte_length: meta.byte_length,
    };
    Ok((quarantine, identity, sniffed))
}

fn stage(ctx: &AcquireContext<'_>, stage: AcquireStage) -> Result<(), AcquireError> {
    (ctx.on_stage)(stage);
    ctx.cancel.check().map_err(|_| AcquireError::Cancelled)
}

fn found(parsed: ItemParse) -> Result<ProviderItem, AcquireError> {
    match parsed {
        ItemParse::Found(item) => Ok(*item),
        ItemParse::Withdrawn => Err(AcquireError::Withdrawn),
    }
}

pub fn acquire(
    ctx: &AcquireContext<'_>,
    request: &AcquireRequest,
) -> Result<AcquireOutcome, AcquireError> {
    if !is_valid_provider_item_id(&request.provider_item_id) {
        return Err(AcquireError::InvalidRequest);
    }
    let policy = (ctx.net_policy)(request.provider_id);
    let started_ms = (ctx.now_ms)();

    stage(ctx, AcquireStage::FetchMetadata)?;
    let record = fetch_record(
        ctx.endpoints,
        ctx.keys,
        &policy,
        request.provider_id,
        &request.provider_item_id,
        &ctx.cancel,
    )?;
    let item = found(record.parsed.clone())?;
    let rights = providers::normalize_item(&item);

    stage(ctx, AcquireStage::Snapshot)?;
    let blobs = collect_snapshots(&policy, &item, &rights, &record, started_ms, &ctx.cancel)?;

    stage(ctx, AcquireStage::Policy)?;
    let decision = evaluate_policy(rights.license.code, request.intended_use, rights.conflict);
    if decision.outcome == PolicyOutcome::Block {
        return Err(AcquireError::PolicyBlocked(decision));
    }
    let missing = missing_attribution_fields(rights.license.code, &rights.attribution);
    if !missing.is_empty() {
        return Err(AcquireError::AttributionIncomplete(missing));
    }

    stage(ctx, AcquireStage::Download)?;
    let (quarantine, identity, sniffed) = download_to_quarantine(ctx, &policy, &item)?;
    ctx.verifier
        .verify(quarantine.path(), item.media_kind, &ctx.cancel)
        .map_err(|reason| {
            if ctx.cancel.is_cancelled() {
                AcquireError::Cancelled
            } else {
                AcquireError::ProbeFailed(reason)
            }
        })?;

    // TOCTOU guard: the record must be unchanged after the (possibly long) download.
    stage(ctx, AcquireStage::Reverify)?;
    let again = fetch_record(
        ctx.endpoints,
        ctx.keys,
        &policy,
        request.provider_id,
        &request.provider_item_id,
        &ctx.cancel,
    )?;
    let etag_changed =
        matches!((&record.meta.etag, &again.meta.etag), (Some(a), Some(b)) if a != b);
    let again_item = found(again.parsed)?;
    if etag_changed
        || providers::normalize_item(&again_item) != rights
        || again_item.download_url != item.download_url
    {
        return Err(AcquireError::UpstreamChanged);
    }

    stage(ctx, AcquireStage::Promote)?;
    let promoted = promote_quarantined_blocking(quarantine, ctx.app_cache_root, &identity)
        .map_err(|_| AcquireError::Media("promote"))?;

    let now_ms = (ctx.now_ms)();
    let receipt = AcquisitionReceipt {
        schema_version: 1,
        receipt_id: uuid::Uuid::new_v4(),
        provider_id: request.provider_id,
        provider_item_id: request.provider_item_id.clone(),
        project_id: request.project_id,
        intended_use: request.intended_use,
        media_kind: item.media_kind,
        media_type: sniffed.to_owned(),
        content: identity,
        license: rights.license.clone(),
        item_license: rights.item_license.clone(),
        collection_license: rights.collection_license.clone(),
        policy: decision,
        attribution: rights.attribution.clone(),
        snapshots: blobs.iter().map(|b| b.meta.clone()).collect(),
        etag: record.meta.etag.clone(),
        acquired_at_ms: now_ms,
        last_refresh_at_ms: now_ms,
        last_refresh_status: RefreshStatus::Unchanged,
    };
    let commit = (|| {
        stage(ctx, AcquireStage::Commit)?;
        ctx.store
            .commit_receipt(&receipt, &blobs)
            .map_err(AcquireError::from)
    })();
    if let Err(error) = commit {
        // Roll back: remove the object only if this acquisition published it.
        let _ = remove_promoted_source(promoted);
        return Err(error);
    }
    let object_path = promoted.guarded.into_source().object_path;
    Ok(AcquireOutcome {
        receipt,
        object_path,
    })
}

/// Startup sweep: removes quarantine files older than `max_age` and snapshot
/// blobs no receipt references. Returns (quarantine files removed, blobs removed).
pub fn startup_sweep(
    app_cache_root: &Path,
    store: &ReceiptStore,
    now: SystemTime,
    max_age: Duration,
) -> Result<(usize, usize), AcquireError> {
    let mut removed = 0;
    if let Ok(directory) = quarantine_directory_blocking(app_cache_root) {
        if let Ok(entries) = fs::read_dir(&directory) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let Some(name) = name.to_str() else { continue };
                if !name.starts_with(QUARANTINE_PREFIX) {
                    continue;
                }
                let Ok(metadata) = entry.metadata() else {
                    continue;
                };
                if !metadata.is_file() {
                    continue;
                }
                let old = metadata
                    .modified()
                    .ok()
                    .and_then(|modified| now.duration_since(modified).ok())
                    .is_some_and(|age| age >= max_age);
                if old && fs::remove_file(entry.path()).is_ok() {
                    removed += 1;
                }
            }
        }
    }
    let blobs = store.sweep_unreferenced_snapshots()?;
    Ok((removed, blobs))
}

#[cfg(test)]
#[path = "acquire_tests.rs"]
mod tests;
