//! Pixabay API (videos and images). Always `custom` license with snapshotted terms.

use serde_json::Value;

use super::{
    split_kind, text_at, u64_at, url_at, AdapterError, ItemParse, ProviderItem, RawLicense,
};
use crate::rights::types::{MediaKind, ProviderId};

type Target = (String, Vec<(&'static str, String)>);

pub(super) fn item_target(item_id: &str) -> Result<Target, AdapterError> {
    let (kind, id) = split_kind(item_id)?;
    if id.is_empty() || id.len() > 20 || !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AdapterError::InvalidItemId);
    }
    let path = match kind {
        "video" => "/api/videos/",
        "image" => "/api/",
        _ => return Err(AdapterError::InvalidItemId),
    };
    Ok((path.into(), vec![("id", id.into())]))
}

pub(super) fn search_target(text: &str, kind: MediaKind) -> Result<Target, AdapterError> {
    let path = match kind {
        MediaKind::Video => "/api/videos/",
        MediaKind::Image => "/api/",
        MediaKind::Audio => return Err(AdapterError::UnsupportedMedia),
    };
    Ok((
        path.into(),
        vec![
            ("q", text.into()),
            ("per_page", "20".into()),
            ("safesearch", "true".into()),
        ],
    ))
}

fn creator_url(hit: &Value) -> Option<String> {
    let user = hit.get("user")?.as_str()?;
    let user_id = u64_at(hit, "/user_id")?;
    if !user
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
    {
        return None;
    }
    Some(format!("https://pixabay.com/users/{user}-{user_id}/"))
}

fn hit_to_item(hit: &Value, kind: MediaKind) -> Option<ProviderItem> {
    let id = u64_at(hit, "/id")?;
    let (prefix, download_url, thumb, width, height, duration_ms, media_type) = match kind {
        MediaKind::Video => {
            let rendition = ["large", "medium", "small"].iter().find_map(|size| {
                hit.pointer(&format!("/videos/{size}"))
                    .filter(|r| url_at(r, "/url").is_some())
            })?;
            (
                "video",
                url_at(rendition, "/url")?,
                url_at(rendition, "/thumbnail"),
                u64_at(rendition, "/width"),
                u64_at(rendition, "/height"),
                u64_at(hit, "/duration").map(|s| s.saturating_mul(1000)),
                Some("video/mp4".to_owned()),
            )
        }
        _ => (
            "image",
            url_at(hit, "/largeImageURL")?,
            url_at(hit, "/previewURL"),
            u64_at(hit, "/imageWidth"),
            u64_at(hit, "/imageHeight"),
            None,
            None,
        ),
    };
    Some(ProviderItem {
        provider_id: ProviderId::Pixabay,
        provider_item_id: format!("{prefix}:{id}"),
        media_kind: kind,
        title: text_at(hit, "/tags"),
        creator: text_at(hit, "/user"),
        creator_url: creator_url(hit),
        landing_url: url_at(hit, "/pageURL"),
        download_url,
        thumbnail_url: thumb,
        expected_media_type: media_type,
        item_license: RawLicense::default(),
        collection_license: None,
        duration_ms,
        width,
        height,
    })
}

pub(super) fn parse_item(item_id: &str, value: &Value) -> Result<ItemParse, AdapterError> {
    let (kind, _) = split_kind(item_id)?;
    let kind = match kind {
        "video" => MediaKind::Video,
        "image" => MediaKind::Image,
        _ => return Err(AdapterError::InvalidItemId),
    };
    let hits = value
        .get("hits")
        .and_then(Value::as_array)
        .ok_or(AdapterError::Malformed("hits"))?;
    let Some(hit) = hits.first() else {
        return Ok(ItemParse::Withdrawn);
    };
    let item = hit_to_item(hit, kind).ok_or(AdapterError::UnsupportedMedia)?;
    if item.provider_item_id != item_id {
        return Err(AdapterError::Malformed("id mismatch"));
    }
    Ok(ItemParse::Found(Box::new(item)))
}

pub(super) fn parse_search(value: &Value, kind: MediaKind) -> Vec<ProviderItem> {
    value
        .get("hits")
        .and_then(Value::as_array)
        .map(|hits| {
            hits.iter()
                .filter_map(|hit| hit_to_item(hit, kind))
                .collect()
        })
        .unwrap_or_default()
}
