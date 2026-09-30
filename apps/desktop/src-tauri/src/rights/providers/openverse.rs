//! Openverse API v1 (images and audio; Openverse has no video).

use serde_json::Value;

use super::{
    split_kind, text_at, u64_at, url_at, AdapterError, ItemParse, ProviderItem, RawLicense,
};
use crate::rights::types::{MediaKind, ProviderId};

type Target = (String, Vec<(&'static str, String)>);

fn is_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}

fn segment(kind: &str) -> Result<(&'static str, MediaKind), AdapterError> {
    match kind {
        "image" => Ok(("images", MediaKind::Image)),
        "audio" => Ok(("audio", MediaKind::Audio)),
        _ => Err(AdapterError::InvalidItemId),
    }
}

pub(super) fn item_target(item_id: &str) -> Result<Target, AdapterError> {
    let (kind, id) = split_kind(item_id)?;
    let (segment, _) = segment(kind)?;
    if !is_uuid(id) {
        return Err(AdapterError::InvalidItemId);
    }
    Ok((format!("/v1/{segment}/{id}/"), Vec::new()))
}

pub(super) fn search_target(text: &str, kind: MediaKind) -> Result<Target, AdapterError> {
    let segment = match kind {
        MediaKind::Image => "images",
        MediaKind::Audio => "audio",
        MediaKind::Video => return Err(AdapterError::UnsupportedMedia),
    };
    Ok((
        format!("/v1/{segment}/"),
        vec![("q", text.into()), ("page_size", "20".into())],
    ))
}

fn record_to_item(record: &Value, kind: MediaKind) -> Option<ProviderItem> {
    let id = record.get("id")?.as_str()?;
    if !is_uuid(id) {
        return None;
    }
    let prefix = if kind == MediaKind::Audio {
        "audio"
    } else {
        "image"
    };
    Some(ProviderItem {
        provider_id: ProviderId::Openverse,
        provider_item_id: format!("{prefix}:{id}"),
        media_kind: kind,
        title: text_at(record, "/title"),
        creator: text_at(record, "/creator"),
        creator_url: url_at(record, "/creator_url"),
        landing_url: url_at(record, "/foreign_landing_url"),
        download_url: url_at(record, "/url")?,
        thumbnail_url: url_at(record, "/thumbnail"),
        expected_media_type: None,
        item_license: RawLicense {
            url: record
                .get("license_url")
                .and_then(Value::as_str)
                .map(str::to_owned),
            name: record
                .get("license")
                .and_then(Value::as_str)
                .map(str::to_owned),
            version: record
                .get("license_version")
                .and_then(Value::as_str)
                .map(str::to_owned),
        },
        collection_license: None,
        duration_ms: u64_at(record, "/duration"),
        width: u64_at(record, "/width"),
        height: u64_at(record, "/height"),
    })
}

pub(super) fn parse_item(item_id: &str, value: &Value) -> Result<ItemParse, AdapterError> {
    let (kind, _) = split_kind(item_id)?;
    let (_, media_kind) = segment(kind)?;
    if value.get("id").is_none() && value.get("detail").is_some() {
        return Ok(ItemParse::Withdrawn);
    }
    let item = record_to_item(value, media_kind).ok_or(AdapterError::Malformed("record"))?;
    if item.provider_item_id != item_id {
        return Err(AdapterError::Malformed("id mismatch"));
    }
    Ok(ItemParse::Found(Box::new(item)))
}

pub(super) fn parse_search(value: &Value, kind: MediaKind) -> Vec<ProviderItem> {
    value
        .get("results")
        .and_then(Value::as_array)
        .map(|rows| {
            rows.iter()
                .filter_map(|row| record_to_item(row, kind))
                .collect()
        })
        .unwrap_or_default()
}
