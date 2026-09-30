//! Smithsonian Open Access API (EDAN). Only CC0 media is open access; the
//! record-level `metadata_usage` is treated as the collection license and the
//! media-level `usage` as the item license.

use serde_json::Value;

use super::{text_at, u64_at, url_at, AdapterError, ItemParse, ProviderItem, RawLicense};
use crate::rights::types::{MediaKind, ProviderId};

type Target = (String, Vec<(&'static str, String)>);

pub(super) fn item_target(item_id: &str) -> Result<Target, AdapterError> {
    if !item_id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
    {
        return Err(AdapterError::InvalidItemId);
    }
    Ok((
        format!("/openaccess/api/v1.0/content/{item_id}"),
        Vec::new(),
    ))
}

pub(super) fn search_target(text: &str, kind: MediaKind) -> Result<Target, AdapterError> {
    if kind != MediaKind::Image {
        return Err(AdapterError::UnsupportedMedia);
    }
    Ok((
        "/openaccess/api/v1.0/search".into(),
        vec![
            ("q", format!("{text} AND online_media_type:Images")),
            ("rows", "20".into()),
        ],
    ))
}

fn media_kind(kind: &str) -> Option<MediaKind> {
    match kind {
        "Images" => Some(MediaKind::Image),
        "Videos" => Some(MediaKind::Video),
        "Sound" | "Audio" => Some(MediaKind::Audio),
        _ => None,
    }
}

fn row_to_item(row: &Value) -> Option<ProviderItem> {
    let id = row.get("id")?.as_str()?.to_owned();
    let dnr = row.pointer("/content/descriptiveNonRepeating")?;
    let media = dnr
        .pointer("/online_media/media")?
        .as_array()?
        .iter()
        .find(|m| {
            m.get("type")
                .and_then(Value::as_str)
                .and_then(media_kind)
                .is_some()
        })?;
    let kind = media_kind(media.get("type")?.as_str()?)?;
    Some(ProviderItem {
        provider_id: ProviderId::Smithsonian,
        provider_item_id: id,
        media_kind: kind,
        title: text_at(dnr, "/title/content").or_else(|| text_at(row, "/title")),
        creator: text_at(row, "/content/freetext/name/0/content"),
        creator_url: None,
        landing_url: url_at(dnr, "/record_link"),
        download_url: url_at(media, "/content")?,
        thumbnail_url: url_at(media, "/thumbnail"),
        expected_media_type: None,
        item_license: RawLicense {
            url: None,
            name: media
                .pointer("/usage/access")
                .and_then(Value::as_str)
                .map(str::to_owned),
            version: None,
        },
        collection_license: dnr
            .pointer("/metadata_usage/access")
            .and_then(Value::as_str)
            .map(|name| RawLicense {
                url: None,
                name: Some(name.to_owned()),
                version: None,
            }),
        duration_ms: None,
        width: u64_at(media, "/resources/0/width"),
        height: u64_at(media, "/resources/0/height"),
    })
}

pub(super) fn parse_item(item_id: &str, value: &Value) -> Result<ItemParse, AdapterError> {
    let Some(response) = value.get("response").filter(|r| !r.is_null()) else {
        return Ok(ItemParse::Withdrawn);
    };
    if response.as_object().is_some_and(|o| o.is_empty()) {
        return Ok(ItemParse::Withdrawn);
    }
    let item = row_to_item(response).ok_or(AdapterError::UnsupportedMedia)?;
    if item.provider_item_id != item_id {
        return Err(AdapterError::Malformed("id mismatch"));
    }
    Ok(ItemParse::Found(Box::new(item)))
}

pub(super) fn parse_search(value: &Value) -> Vec<ProviderItem> {
    value
        .pointer("/response/rows")
        .and_then(Value::as_array)
        .map(|rows| rows.iter().filter_map(row_to_item).collect())
        .unwrap_or_default()
}
