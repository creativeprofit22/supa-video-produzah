//! Per-provider extraction: raw API snapshot bytes -> `ProviderItem`.
//!
//! Adapters only parse bytes Rust fetched itself. They never see UI input
//! other than the validated provider item id and search text. All text from
//! providers is untrusted: it is stripped of markup/control characters and
//! length-capped before it can reach receipts or credits.

mod commons;
mod freesound;
mod internet_archive;
mod openverse;
mod pexels;
mod pixabay;
mod smithsonian;

use std::collections::BTreeMap;

use serde_json::Value;
use url::Url;

use super::{
    license::{license_display_name, normalize_license, resolve_license_conflict, LicenseInput},
    net::{Credential, FetchLimits, FetchRequest, Secret},
    policy::evaluate_policy,
    types::{
        is_valid_provider_item_id, LicenseId, MediaKind, ProviderId, RightsCandidate,
        StructuredAttribution, UsePolicyProfile,
    },
};

const MAX_TEXT_CHARS: usize = 512;
pub const MAX_SEARCH_QUERY_CHARS: usize = 200;
pub const SEARCH_PAGE_SIZE: u32 = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AdapterError {
    InvalidItemId,
    InvalidQuery,
    KeyMissing,
    Malformed(&'static str),
    UnsupportedMedia,
}

impl std::fmt::Display for AdapterError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AdapterError::InvalidItemId => f.write_str("invalid provider item id"),
            AdapterError::InvalidQuery => f.write_str("invalid search query"),
            AdapterError::KeyMissing => {
                f.write_str("this provider needs an API key in the system keyring")
            }
            AdapterError::Malformed(what) => write!(f, "provider record is malformed ({what})"),
            AdapterError::UnsupportedMedia => {
                f.write_str("provider item has no supported media file")
            }
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct RawLicense {
    pub url: Option<String>,
    pub name: Option<String>,
    pub version: Option<String>,
}

/// Everything Rust needs from one provider record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProviderItem {
    pub provider_id: ProviderId,
    pub provider_item_id: String,
    pub media_kind: MediaKind,
    pub title: Option<String>,
    pub creator: Option<String>,
    pub creator_url: Option<String>,
    pub landing_url: Option<String>,
    pub download_url: String,
    pub thumbnail_url: Option<String>,
    pub expected_media_type: Option<String>,
    pub item_license: RawLicense,
    pub collection_license: Option<RawLicense>,
    pub duration_ms: Option<u64>,
    pub width: Option<u64>,
    pub height: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ItemParse {
    Found(Box<ProviderItem>),
    /// The provider answered but the item no longer exists.
    Withdrawn,
}

/// Normalized rights facts derived from a `ProviderItem`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NormalizedRights {
    pub item_license: LicenseId,
    pub collection_license: Option<LicenseId>,
    pub license: LicenseId,
    pub conflict: bool,
    pub attribution: StructuredAttribution,
}

pub fn normalize_item(item: &ProviderItem) -> NormalizedRights {
    let to_input = |raw: &RawLicense| -> LicenseId {
        normalize_license(&LicenseInput {
            provider_id: item.provider_id,
            url: raw.url.as_deref(),
            name: raw.name.as_deref(),
            version: raw.version.as_deref(),
        })
    };
    let item_license = to_input(&item.item_license);
    let collection_license = item.collection_license.as_ref().map(to_input);
    let resolved = resolve_license_conflict(&item_license, collection_license.as_ref());
    let attribution = StructuredAttribution {
        title: item.title.clone(),
        creator: item.creator.clone(),
        creator_url: https_only(item.creator_url.as_ref()),
        source_url: https_only(item.landing_url.as_ref()),
        provider_name: item.provider_id.display_name().to_owned(),
        license_name: license_display_name(&resolved.license, item.provider_id),
        license_url: resolved.license.url.clone(),
    };
    NormalizedRights {
        item_license,
        collection_license,
        license: resolved.license,
        conflict: resolved.conflict,
        attribution,
    }
}

pub fn candidate_for(item: &ProviderItem, profile: UsePolicyProfile) -> RightsCandidate {
    let rights = normalize_item(item);
    RightsCandidate {
        provider_id: item.provider_id,
        provider_item_id: item.provider_item_id.clone(),
        media_kind: item.media_kind,
        title: item.title.clone(),
        creator: item.creator.clone(),
        landing_url: https_only(item.landing_url.as_ref()),
        thumbnail_url: https_only(item.thumbnail_url.as_ref()),
        advisory_policy: evaluate_policy(rights.license.code, profile, rights.conflict),
        license: rights.license,
        duration_ms: item.duration_ms,
        width: item.width,
        height: item.height,
    }
}

/// API origins. Production values are fixed; tests point every provider at a fixture server.
#[derive(Debug, Clone)]
pub struct ProviderEndpoints {
    bases: BTreeMap<ProviderId, Url>,
}

impl ProviderEndpoints {
    pub fn production() -> Self {
        let bases = ProviderId::ALL
            .into_iter()
            .map(|id| {
                let base = match id {
                    ProviderId::WikimediaCommons => "https://commons.wikimedia.org",
                    ProviderId::Openverse => "https://api.openverse.org",
                    ProviderId::Smithsonian => "https://api.si.edu",
                    ProviderId::Pexels => "https://api.pexels.com",
                    ProviderId::Pixabay => "https://pixabay.com",
                    ProviderId::Freesound => "https://freesound.org",
                    ProviderId::InternetArchive => "https://archive.org",
                };
                (id, Url::parse(base).expect("static provider base"))
            })
            .collect();
        Self { bases }
    }

    #[cfg(test)]
    pub fn all_at(base: &str) -> Self {
        let url = Url::parse(base).expect("fixture base");
        Self {
            bases: ProviderId::ALL
                .into_iter()
                .map(|id| (id, url.clone()))
                .collect(),
        }
    }

    fn url(&self, provider_id: ProviderId, path: &str, query: &[(&str, &str)]) -> Url {
        let mut url = self.bases[&provider_id].clone();
        url.set_path(path);
        if query.is_empty() {
            url.set_query(None);
        } else {
            url.query_pairs_mut().clear().extend_pairs(query);
        }
        url
    }
}

pub fn requires_key(provider_id: ProviderId) -> bool {
    matches!(
        provider_id,
        ProviderId::Smithsonian | ProviderId::Pexels | ProviderId::Pixabay | ProviderId::Freesound
    )
}

fn credential(provider_id: ProviderId, key: Option<Secret>) -> Result<Credential, AdapterError> {
    if !requires_key(provider_id) {
        return Ok(Credential::None);
    }
    let secret = key.ok_or(AdapterError::KeyMissing)?;
    Ok(match provider_id {
        ProviderId::Pexels => Credential::Header {
            name: "authorization",
            secret,
        },
        ProviderId::Smithsonian => Credential::Query {
            name: "api_key",
            secret,
        },
        ProviderId::Pixabay => Credential::Query {
            name: "key",
            secret,
        },
        _ => Credential::Query {
            name: "token",
            secret,
        },
    })
}

/// Request for the authoritative record of one item.
pub fn item_request(
    endpoints: &ProviderEndpoints,
    provider_id: ProviderId,
    item_id: &str,
    key: Option<Secret>,
) -> Result<FetchRequest, AdapterError> {
    if !is_valid_provider_item_id(item_id) {
        return Err(AdapterError::InvalidItemId);
    }
    let credential = credential(provider_id, key)?;
    let (path, query) = match provider_id {
        ProviderId::WikimediaCommons => commons::item_target(item_id)?,
        ProviderId::Openverse => openverse::item_target(item_id)?,
        ProviderId::Smithsonian => smithsonian::item_target(item_id)?,
        ProviderId::Pexels => pexels::item_target(item_id)?,
        ProviderId::Pixabay => pixabay::item_target(item_id)?,
        ProviderId::Freesound => freesound::item_target(item_id)?,
        ProviderId::InternetArchive => internet_archive::item_target(item_id)?,
    };
    let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Ok(FetchRequest {
        url: endpoints.url(provider_id, &path, &query),
        credential,
        limits: FetchLimits::METADATA,
    })
}

pub fn search_request(
    endpoints: &ProviderEndpoints,
    provider_id: ProviderId,
    query_text: &str,
    media_kind: MediaKind,
    key: Option<Secret>,
) -> Result<FetchRequest, AdapterError> {
    let text = query_text.trim();
    if text.is_empty()
        || text.chars().count() > MAX_SEARCH_QUERY_CHARS
        || text.chars().any(char::is_control)
    {
        return Err(AdapterError::InvalidQuery);
    }
    let credential = credential(provider_id, key)?;
    let (path, query) = match provider_id {
        ProviderId::WikimediaCommons => commons::search_target(text, media_kind),
        ProviderId::Openverse => openverse::search_target(text, media_kind)?,
        ProviderId::Smithsonian => smithsonian::search_target(text, media_kind)?,
        ProviderId::Pexels => pexels::search_target(text, media_kind)?,
        ProviderId::Pixabay => pixabay::search_target(text, media_kind)?,
        ProviderId::Freesound => freesound::search_target(text, media_kind)?,
        ProviderId::InternetArchive => internet_archive::search_target(text, media_kind)?,
    };
    let query: Vec<(&str, &str)> = query.iter().map(|(k, v)| (*k, v.as_str())).collect();
    Ok(FetchRequest {
        url: endpoints.url(provider_id, &path, &query),
        credential,
        limits: FetchLimits::METADATA,
    })
}

pub fn parse_item(
    provider_id: ProviderId,
    item_id: &str,
    bytes: &[u8],
) -> Result<ItemParse, AdapterError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| AdapterError::Malformed("json"))?;
    match provider_id {
        ProviderId::WikimediaCommons => commons::parse_item(item_id, &value),
        ProviderId::Openverse => openverse::parse_item(item_id, &value),
        ProviderId::Smithsonian => smithsonian::parse_item(item_id, &value),
        ProviderId::Pexels => pexels::parse_item(item_id, &value),
        ProviderId::Pixabay => pixabay::parse_item(item_id, &value),
        ProviderId::Freesound => freesound::parse_item(item_id, &value),
        ProviderId::InternetArchive => internet_archive::parse_item(item_id, &value),
    }
}

/// Search results are advisory. Malformed individual hits are skipped.
pub fn parse_search(
    provider_id: ProviderId,
    media_kind: MediaKind,
    bytes: &[u8],
) -> Result<Vec<ProviderItem>, AdapterError> {
    let value: Value =
        serde_json::from_slice(bytes).map_err(|_| AdapterError::Malformed("json"))?;
    let items = match provider_id {
        ProviderId::WikimediaCommons => commons::parse_search(&value),
        ProviderId::Openverse => openverse::parse_search(&value, media_kind),
        ProviderId::Smithsonian => smithsonian::parse_search(&value),
        ProviderId::Pexels => pexels::parse_search(&value, media_kind),
        ProviderId::Pixabay => pixabay::parse_search(&value, media_kind),
        ProviderId::Freesound => freesound::parse_search(&value),
        ProviderId::InternetArchive => internet_archive::parse_search(&value, media_kind),
    };
    Ok(items
        .into_iter()
        .filter(|item| is_valid_provider_item_id(&item.provider_item_id))
        .take(SEARCH_PAGE_SIZE as usize)
        .collect())
}

// ---------- shared untrusted-text helpers ----------

/// Strips HTML tags/entities and control characters, collapses whitespace, caps length.
pub(crate) fn clean_text(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut in_tag = false;
    for c in raw.chars() {
        match c {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                out.push(' ');
            }
            _ if in_tag => {}
            c if c.is_control() => out.push(' '),
            c => out.push(c),
        }
    }
    let decoded = out
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'")
        .replace("&nbsp;", " ");
    let collapsed = decoded.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed.chars().take(MAX_TEXT_CHARS).collect();
    (!capped.is_empty()).then_some(capped)
}

pub(crate) fn text_at(value: &Value, pointer: &str) -> Option<String> {
    match value.pointer(pointer)? {
        Value::String(s) => clean_text(s),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// Accepts absolute http(s) URLs only (the network policy decides what may be fetched).
pub(crate) fn url_at(value: &Value, pointer: &str) -> Option<String> {
    let raw = value.pointer(pointer)?.as_str()?.trim();
    let raw = if raw.starts_with("//") {
        format!("https:{raw}")
    } else {
        raw.to_owned()
    };
    let parsed = Url::parse(&raw).ok()?;
    if !matches!(parsed.scheme(), "https" | "http") || parsed.host_str().is_none() {
        return None;
    }
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return None;
    }
    (parsed.as_str().len() <= 2048).then(|| parsed.to_string())
}

pub(crate) fn u64_at(value: &Value, pointer: &str) -> Option<u64> {
    let v = value.pointer(pointer)?;
    v.as_u64()
        .or_else(|| {
            v.as_f64()
                .filter(|f| f.is_finite() && *f >= 0.0)
                .map(|f| f.round() as u64)
        })
        .or_else(|| {
            v.as_str()
                .and_then(|s| s.trim().parse::<f64>().ok())
                .map(|f| f.max(0.0).round() as u64)
        })
}

/// Receipts, credits and the UI accept HTTPS links only; anything else is dropped.
pub(crate) fn https_only(value: Option<&String>) -> Option<String> {
    value.filter(|url| url.starts_with("https://")).cloned()
}

pub(crate) fn split_kind(item_id: &str) -> Result<(&str, &str), AdapterError> {
    item_id.split_once(':').ok_or(AdapterError::InvalidItemId)
}

#[cfg(test)]
mod tests;
