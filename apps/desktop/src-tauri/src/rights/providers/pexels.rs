//! Pexels API (videos and photos). Always `custom` license with snapshotted terms.

use serde_json::Value;

use super::{
    split_kind, text_at, u64_at, url_at, AdapterError, ItemParse, ProviderItem, RawLicense,
};
use crate::rights::types::{MediaKind, ProviderId};

type Target = (String, Vec<(&'static str, String)>);

fn numeric(id: &str) -> Result<&str, AdapterError> {
    if !id.is_empty() && id.len() <= 20 && id.chars().all(|c| c.is_ascii_digit()) {
        Ok(id)
    } else {
        Err(AdapterError::InvalidItemId)
    }
}

pub(super) fn item_target(item_id: &str) -> Result<Target, AdapterError> {
    let (kind, id) = split_kind(item_id)?;
    let id = numeric(id)?;
    match kind {
        "video" => Ok((format!("/videos/videos/{id}"), Vec::new())),
        "photo" => Ok((format!("/v1/photos/{id}"), Vec::new())),
        _ => Err(AdapterError::InvalidItemId),
    }
}

pub(super) fn search_target(text: &str, kind: MediaKind) -> Result<Target, AdapterError> {
    let path = match kind {
        MediaKind::Video => "/videos/search",
        MediaKind::Image => "/v1/search",
        MediaKind::Audio => return Err(AdapterError::UnsupportedMedia),
    };
    Ok((
        path.into(),
        vec![("query", text.into()), ("per_page", "20".into())],
    ))
}

fn custom_license() -> RawLicense {
    RawLicense::default()
}

/// Picks the largest MP4 rendition that is at most 1920 wide (deterministic tie-break on link).
fn best_video_file(record: &Value) -> Option<(String, Option<u64>, Option<u64>)> {
    let files = record.get("video_files")?.as_array()?;
    let mut candidates: Vec<(u64, String, Option<u64>, Option<u64>)> = files
        .iter()
        .filter(|f| f.get("file_type").and_then(Value::as_str) == Some("video/mp4"))
        .filter_map(|f| {
            let width = u64_at(f, "/width");
            let link = url_at(f, "/link")?;
            Some((width.unwrap_or(0), link, width, u64_at(f, "/height")))
        })
        .filter(|(w, ..)| *w <= 1920)
        .collect();
    candidates.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    candidates
        .into_iter()
        .next()
        .map(|(_, link, w, h)| (link, w, h))
}

fn video_to_item(record: &Value) -> Option<ProviderItem> {
    let id = u64_at(record, "/id")?;
    let (download_url, width, height) = best_video_file(record)?;
    Some(ProviderItem {
        provider_id: ProviderId::Pexels,
        provider_item_id: format!("video:{id}"),
        media_kind: MediaKind::Video,
        title: None,
        creator: text_at(record, "/user/name"),
        creator_url: url_at(record, "/user/url"),
        landing_url: url_at(record, "/url"),
        download_url,
        thumbnail_url: url_at(record, "/image"),
        expected_media_type: Some("video/mp4".into()),
        item_license: custom_license(),
        collection_license: None,
        duration_ms: u64_at(record, "/duration").map(|s| s.saturating_mul(1000)),
        width: width.or_else(|| u64_at(record, "/width")),
        height: height.or_else(|| u64_at(record, "/height")),
    })
}

fn photo_to_item(record: &Value) -> Option<ProviderItem> {
    let id = u64_at(record, "/id")?;
    Some(ProviderItem {
        provider_id: ProviderId::Pexels,
        provider_item_id: format!("photo:{id}"),
        media_kind: MediaKind::Image,
        title: text_at(record, "/alt"),
        creator: text_at(record, "/photographer"),
        creator_url: url_at(record, "/photographer_url"),
        landing_url: url_at(record, "/url"),
        download_url: url_at(record, "/src/original")?,
        thumbnail_url: url_at(record, "/src/medium"),
        expected_media_type: None,
        item_license: custom_license(),
        collection_license: None,
        duration_ms: None,
        width: u64_at(record, "/width"),
        height: u64_at(record, "/height"),
    })
}

pub(super) fn parse_item(item_id: &str, value: &Value) -> Result<ItemParse, AdapterError> {
    let (kind, _) = split_kind(item_id)?;
    if value.get("id").is_none() {
        return Ok(ItemParse::Withdrawn);
    }
    let item = match kind {
        "video" => video_to_item(value),
        "photo" => photo_to_item(value),
        _ => return Err(AdapterError::InvalidItemId),
    }
    .ok_or(AdapterError::UnsupportedMedia)?;
    if item.provider_item_id != item_id {
        return Err(AdapterError::Malformed("id mismatch"));
    }
    Ok(ItemParse::Found(Box::new(item)))
}

pub(super) fn parse_search(value: &Value, kind: MediaKind) -> Vec<ProviderItem> {
    let (key, convert): (&str, fn(&Value) -> Option<ProviderItem>) = match kind {
        MediaKind::Video => ("videos", video_to_item),
        _ => ("photos", photo_to_item),
    };
    value
        .get(key)
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(convert).collect())
        .unwrap_or_default()
}
