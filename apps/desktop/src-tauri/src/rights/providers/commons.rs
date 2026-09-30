//! Wikimedia Commons (MediaWiki Action API, `prop=imageinfo` + `extmetadata`).

use serde_json::Value;

use super::{
    clean_text, text_at, u64_at, url_at, AdapterError, ItemParse, ProviderItem, RawLicense,
};
use crate::rights::types::{MediaKind, ProviderId};

const IIPROP: &str = "url|mime|size|extmetadata|mediatype";

type Target = (String, Vec<(&'static str, String)>);

pub(super) fn item_target(item_id: &str) -> Result<Target, AdapterError> {
    if !item_id.starts_with("File:") || item_id.len() <= 5 {
        return Err(AdapterError::InvalidItemId);
    }
    Ok((
        "/w/api.php".into(),
        vec![
            ("action", "query".into()),
            ("format", "json".into()),
            ("formatversion", "2".into()),
            ("prop", "imageinfo".into()),
            ("iiprop", IIPROP.into()),
            ("iiurlwidth", "320".into()),
            ("titles", item_id.into()),
        ],
    ))
}

pub(super) fn search_target(text: &str, kind: MediaKind) -> Target {
    let filetype = match kind {
        MediaKind::Video => "video",
        MediaKind::Image => "bitmap",
        MediaKind::Audio => "audio",
    };
    (
        "/w/api.php".into(),
        vec![
            ("action", "query".into()),
            ("format", "json".into()),
            ("formatversion", "2".into()),
            ("generator", "search".into()),
            ("gsrnamespace", "6".into()),
            ("gsrlimit", "20".into()),
            ("gsrsearch", format!("{text} filetype:{filetype}")),
            ("prop", "imageinfo".into()),
            ("iiprop", IIPROP.into()),
            ("iiurlwidth", "320".into()),
        ],
    )
}

fn media_kind(info: &Value) -> Option<MediaKind> {
    match info.get("mediatype")?.as_str()? {
        "VIDEO" => Some(MediaKind::Video),
        "AUDIO" => Some(MediaKind::Audio),
        "BITMAP" | "DRAWING" => Some(MediaKind::Image),
        _ => None,
    }
}

fn page_to_item(page: &Value) -> Result<Option<ProviderItem>, AdapterError> {
    if page.get("missing").and_then(Value::as_bool) == Some(true)
        || page.get("invalid").and_then(Value::as_bool) == Some(true)
    {
        return Ok(None);
    }
    let title = page
        .get("title")
        .and_then(Value::as_str)
        .ok_or(AdapterError::Malformed("page title"))?;
    let info = page
        .pointer("/imageinfo/0")
        .ok_or(AdapterError::Malformed("imageinfo"))?;
    let kind = media_kind(info).ok_or(AdapterError::UnsupportedMedia)?;
    let download_url = url_at(info, "/url").ok_or(AdapterError::Malformed("file url"))?;
    let meta = |key: &str| text_at(info, &format!("/extmetadata/{key}/value"));
    let license_url = info
        .pointer("/extmetadata/LicenseUrl/value")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(Some(ProviderItem {
        provider_id: ProviderId::WikimediaCommons,
        provider_item_id: title.to_owned(),
        media_kind: kind,
        title: meta("ObjectName").or_else(|| clean_text(title.trim_start_matches("File:"))),
        creator: meta("Artist"),
        creator_url: None,
        landing_url: url_at(info, "/descriptionurl"),
        download_url,
        thumbnail_url: url_at(info, "/thumburl"),
        expected_media_type: info.get("mime").and_then(Value::as_str).map(str::to_owned),
        item_license: RawLicense {
            url: license_url,
            name: meta("LicenseShortName"),
            version: None,
        },
        collection_license: None,
        duration_ms: info
            .get("duration")
            .and_then(Value::as_f64)
            .filter(|d| d.is_finite() && *d >= 0.0)
            .map(|d| (d * 1000.0).round() as u64),
        width: u64_at(info, "/width"),
        height: u64_at(info, "/height"),
    }))
}

pub(super) fn parse_item(item_id: &str, value: &Value) -> Result<ItemParse, AdapterError> {
    let page = value
        .pointer("/query/pages/0")
        .ok_or(AdapterError::Malformed("pages"))?;
    match page_to_item(page)? {
        None => Ok(ItemParse::Withdrawn),
        Some(item) if item.provider_item_id != item_id => {
            Err(AdapterError::Malformed("title mismatch"))
        }
        Some(item) => Ok(ItemParse::Found(Box::new(item))),
    }
}

pub(super) fn parse_search(value: &Value) -> Vec<ProviderItem> {
    let Some(pages) = value.pointer("/query/pages").and_then(Value::as_array) else {
        return Vec::new();
    };
    let mut items: Vec<(u64, ProviderItem)> = pages
        .iter()
        .filter_map(|page| {
            let index = page
                .get("index")
                .and_then(Value::as_u64)
                .unwrap_or(u64::MAX);
            page_to_item(page).ok().flatten().map(|item| (index, item))
        })
        .collect();
    items.sort_by_key(|(index, _)| *index);
    items.into_iter().map(|(_, item)| item).collect()
}
