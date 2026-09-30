//! Freesound APIv2 (token auth; high-quality MP3 previews).

use serde_json::Value;

use super::{text_at, u64_at, url_at, AdapterError, ItemParse, ProviderItem, RawLicense};
use crate::rights::types::{MediaKind, ProviderId};

type Target = (String, Vec<(&'static str, String)>);

const FIELDS: &str = "id,name,username,url,license,previews,duration";

pub(super) fn item_target(item_id: &str) -> Result<Target, AdapterError> {
    if item_id.is_empty() || item_id.len() > 20 || !item_id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AdapterError::InvalidItemId);
    }
    Ok((
        format!("/apiv2/sounds/{item_id}/"),
        vec![("fields", FIELDS.into())],
    ))
}

pub(super) fn search_target(text: &str, kind: MediaKind) -> Result<Target, AdapterError> {
    if kind != MediaKind::Audio {
        return Err(AdapterError::UnsupportedMedia);
    }
    Ok((
        "/apiv2/search/text/".into(),
        vec![
            ("query", text.into()),
            ("page_size", "20".into()),
            ("fields", FIELDS.into()),
        ],
    ))
}

fn record_to_item(record: &Value) -> Option<ProviderItem> {
    let id = u64_at(record, "/id")?;
    let license = record
        .get("license")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let (license_url, license_name) = match license {
        Some(value) if value.starts_with("http") => (Some(value), None),
        other => (None, other),
    };
    let username = record.get("username").and_then(Value::as_str);
    let creator_url = username
        .filter(|u| {
            u.chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.'))
        })
        .map(|u| format!("https://freesound.org/people/{u}/"));
    Some(ProviderItem {
        provider_id: ProviderId::Freesound,
        provider_item_id: id.to_string(),
        media_kind: MediaKind::Audio,
        title: text_at(record, "/name"),
        creator: text_at(record, "/username"),
        creator_url,
        landing_url: url_at(record, "/url"),
        download_url: url_at(record, "/previews/preview-hq-mp3")?,
        thumbnail_url: None,
        expected_media_type: Some("audio/mpeg".into()),
        item_license: RawLicense {
            url: license_url,
            name: license_name,
            version: None,
        },
        collection_license: None,
        duration_ms: record
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(|d| (d * 1000.0).round() as u64),
        width: None,
        height: None,
    })
}

pub(super) fn parse_item(item_id: &str, value: &Value) -> Result<ItemParse, AdapterError> {
    if value.get("id").is_none() {
        return Ok(ItemParse::Withdrawn);
    }
    let item = record_to_item(value).ok_or(AdapterError::UnsupportedMedia)?;
    if item.provider_item_id != item_id {
        return Err(AdapterError::Malformed("id mismatch"));
    }
    Ok(ItemParse::Found(Box::new(item)))
}

pub(super) fn parse_search(value: &Value) -> Vec<ProviderItem> {
    value
        .get("results")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(record_to_item).collect())
        .unwrap_or_default()
}
