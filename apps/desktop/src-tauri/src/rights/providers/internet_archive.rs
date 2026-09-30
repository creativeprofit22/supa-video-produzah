//! Internet Archive (Metadata API for items, Advanced Search for discovery).
//! No key needed. Item ids are archive identifiers. The item license comes from
//! the uploader-declared `licenseurl`; items without one normalize to `unknown`
//! and are therefore blocked for public use. Written from the public API
//! documentation; the AGPL `internetarchive` client was a pattern reference only.

use serde_json::Value;
use url::Url;

use super::{clean_text, AdapterError, ItemParse, ProviderItem, RawLicense};
use crate::rights::types::{MediaKind, ProviderId};

type Target = (String, Vec<(&'static str, String)>);

const ORIGIN: &str = "https://archive.org";
const SEARCH_FIELDS: [&str; 5] = ["identifier", "title", "creator", "licenseurl", "mediatype"];

/// Archive identifiers: letters, digits, `.`, `_`, `-`; no leading punctuation.
fn is_identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 100
        && id.chars().next().is_some_and(|c| c.is_ascii_alphanumeric())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

pub(super) fn item_target(item_id: &str) -> Result<Target, AdapterError> {
    if !is_identifier(item_id) {
        return Err(AdapterError::InvalidItemId);
    }
    Ok((format!("/metadata/{item_id}"), Vec::new()))
}

/// Advanced Search is Lucene-backed: user text is reduced to plain terms so it
/// cannot change the media-type or license filters.
pub(super) fn search_target(text: &str, kind: MediaKind) -> Result<Target, AdapterError> {
    let terms: String = text
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '\'' {
                c
            } else {
                ' '
            }
        })
        .collect::<String>()
        .split_whitespace()
        .filter(|word| !matches!(*word, "AND" | "OR" | "NOT" | "TO"))
        .collect::<Vec<_>>()
        .join(" ");
    if terms.is_empty() {
        return Err(AdapterError::InvalidQuery);
    }
    let mediatype = match kind {
        MediaKind::Video => "movies",
        MediaKind::Audio => "audio",
        MediaKind::Image => "image",
    };
    let mut query = vec![
        // Only items that declare a license are useful for rights-checked use.
        (
            "q",
            format!("({terms}) AND mediatype:{mediatype} AND licenseurl:*"),
        ),
        ("rows", "20".to_owned()),
        ("page", "1".to_owned()),
        ("output", "json".to_owned()),
    ];
    query.extend(
        SEARCH_FIELDS
            .iter()
            .map(|field| ("fl[]", (*field).to_owned())),
    );
    Ok(("/advancedsearch.php".into(), query))
}

fn media_kind(mediatype: &str) -> Option<MediaKind> {
    match mediatype {
        "movies" => Some(MediaKind::Video),
        "audio" | "etree" => Some(MediaKind::Audio),
        "image" => Some(MediaKind::Image),
        _ => None,
    }
}

/// Metadata fields may be a string or an array of strings; the first entry wins.
fn first_text(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(text) => clean_text(text),
        Value::Array(items) => items
            .iter()
            .find_map(|item| item.as_str().and_then(clean_text)),
        _ => None,
    }
}

fn first_raw(value: &Value, key: &str) -> Option<String> {
    match value.get(key)? {
        Value::String(text) => Some(text.trim().to_owned()),
        Value::Array(items) => items
            .iter()
            .find_map(|item| item.as_str().map(|s| s.trim().to_owned())),
        _ => None,
    }
}

fn extension_type(name: &str, kind: MediaKind) -> Option<&'static str> {
    let lower = name.to_ascii_lowercase();
    let ext = lower.rsplit_once('.')?.1;
    match (kind, ext) {
        (MediaKind::Video, "mp4") => Some("video/mp4"),
        (MediaKind::Video, "webm") => Some("video/webm"),
        (MediaKind::Video, "ogv") => Some("application/ogg"),
        (MediaKind::Audio, "mp3") => Some("audio/mpeg"),
        (MediaKind::Audio, "ogg") => Some("application/ogg"),
        (MediaKind::Audio, "wav") => Some("audio/wav"),
        (MediaKind::Image, "jpg" | "jpeg") => Some("image/jpeg"),
        (MediaKind::Image, "png") => Some("image/png"),
        _ => None,
    }
}

fn number(value: &Value, key: &str) -> Option<f64> {
    let raw = value.get(key)?;
    raw.as_f64()
        .or_else(|| raw.as_str().and_then(|s| s.trim().parse::<f64>().ok()))
        .filter(|n| n.is_finite() && *n >= 0.0)
}

/// Chooses the file to download: supported type for the kind, top-level only,
/// originals before derivatives, then larger files, then name (deterministic).
fn choose_file(files: &[Value], kind: MediaKind) -> Option<(&Value, &str, &'static str)> {
    let mut candidates: Vec<(&Value, &str, &'static str)> = files
        .iter()
        .filter_map(|file| {
            let name = file.get("name")?.as_str()?;
            if name.contains('/')
                || name.contains('\\')
                || name.starts_with('.')
                || name.starts_with("__ia")
            {
                return None;
            }
            extension_type(name, kind).map(|media_type| (file, name, media_type))
        })
        .collect();
    candidates.sort_by(|a, b| {
        let original =
            |file: &Value| file.get("source").and_then(Value::as_str) == Some("original");
        original(b.0)
            .cmp(&original(a.0))
            .then_with(|| {
                number(b.0, "size")
                    .unwrap_or(0.0)
                    .total_cmp(&number(a.0, "size").unwrap_or(0.0))
            })
            .then_with(|| a.1.cmp(b.1))
    });
    candidates.into_iter().next()
}

fn download_url(identifier: &str, name: &str) -> Option<String> {
    let mut url = Url::parse(ORIGIN).ok()?;
    url.path_segments_mut()
        .ok()?
        .extend(["download", identifier, name]);
    Some(url.to_string())
}

pub(super) fn parse_item(item_id: &str, value: &Value) -> Result<ItemParse, AdapterError> {
    // The Metadata API answers `{}` for unknown identifiers; dark items are withdrawn.
    let Some(metadata) = value.get("metadata").filter(|m| m.is_object()) else {
        return Ok(ItemParse::Withdrawn);
    };
    if value.get("is_dark").and_then(Value::as_bool) == Some(true) {
        return Ok(ItemParse::Withdrawn);
    }
    if metadata.get("identifier").and_then(Value::as_str) != Some(item_id) {
        return Err(AdapterError::Malformed("identifier mismatch"));
    }
    let kind = metadata
        .get("mediatype")
        .and_then(Value::as_str)
        .and_then(media_kind)
        .ok_or(AdapterError::UnsupportedMedia)?;
    let files = value
        .get("files")
        .and_then(Value::as_array)
        .ok_or(AdapterError::Malformed("files"))?;
    let (file, name, media_type) =
        choose_file(files, kind).ok_or(AdapterError::UnsupportedMedia)?;
    Ok(ItemParse::Found(Box::new(ProviderItem {
        provider_id: ProviderId::InternetArchive,
        provider_item_id: item_id.to_owned(),
        media_kind: kind,
        title: first_text(metadata, "title"),
        creator: first_text(metadata, "creator"),
        creator_url: None,
        landing_url: Some(format!("{ORIGIN}/details/{item_id}")),
        download_url: download_url(item_id, name).ok_or(AdapterError::Malformed("file name"))?,
        thumbnail_url: Some(format!("{ORIGIN}/services/img/{item_id}")),
        expected_media_type: Some(media_type.to_owned()),
        item_license: RawLicense {
            url: first_raw(metadata, "licenseurl"),
            name: None,
            version: None,
        },
        collection_license: None,
        duration_ms: number(file, "length").map(|seconds| (seconds * 1000.0).round() as u64),
        width: number(file, "width").map(|n| n.round() as u64),
        height: number(file, "height").map(|n| n.round() as u64),
    })))
}

/// Search hits carry no file list: the download URL points at the details page
/// and is never fetched, because acquisition always re-reads the item record.
pub(super) fn parse_search(value: &Value, kind: MediaKind) -> Vec<ProviderItem> {
    let Some(docs) = value.pointer("/response/docs").and_then(Value::as_array) else {
        return Vec::new();
    };
    docs.iter()
        .filter_map(|doc| {
            let id = doc.get("identifier")?.as_str()?;
            if !is_identifier(id) {
                return None;
            }
            let doc_kind = doc
                .get("mediatype")
                .and_then(Value::as_str)
                .and_then(media_kind)?;
            if doc_kind != kind {
                return None;
            }
            let details = format!("{ORIGIN}/details/{id}");
            Some(ProviderItem {
                provider_id: ProviderId::InternetArchive,
                provider_item_id: id.to_owned(),
                media_kind: kind,
                title: first_text(doc, "title"),
                creator: first_text(doc, "creator"),
                creator_url: None,
                landing_url: Some(details.clone()),
                download_url: details,
                thumbnail_url: Some(format!("{ORIGIN}/services/img/{id}")),
                expected_media_type: None,
                item_license: RawLicense {
                    url: first_raw(doc, "licenseurl"),
                    name: None,
                    version: None,
                },
                collection_license: None,
                duration_ms: None,
                width: None,
                height: None,
            })
        })
        .collect()
}
