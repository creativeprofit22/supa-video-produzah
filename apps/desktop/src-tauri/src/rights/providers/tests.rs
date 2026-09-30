//! Adapter tests against recorded-shape fixtures. No live API is contacted.

use super::*;
use crate::rights::types::{LicenseCode, PolicyOutcome};

macro_rules! fixture {
    ($name:literal) => {
        include_bytes!(concat!(
            "../../../../../../packages/video-rights/fixtures/providers/",
            $name
        ))
    };
}

fn found(result: Result<ItemParse, AdapterError>) -> ProviderItem {
    match result.expect("parse ok") {
        ItemParse::Found(item) => *item,
        ItemParse::Withdrawn => panic!("expected an item"),
    }
}

#[test]
fn commons_item_strips_markup_and_normalizes_by_sa() {
    let item = found(parse_item(
        ProviderId::WikimediaCommons,
        "File:Sunrise over hills.webm",
        fixture!("commons-item.json"),
    ));
    assert_eq!(item.media_kind, MediaKind::Video);
    assert_eq!(item.creator.as_deref(), Some("Jane & Co"));
    assert_eq!(item.duration_ms, Some(4_500));
    assert_eq!(item.expected_media_type.as_deref(), Some("video/webm"));
    let rights = normalize_item(&item);
    assert_eq!(rights.license.code, LicenseCode::BySa);
    assert_eq!(rights.license.version.as_deref(), Some("4.0"));
    assert_eq!(rights.attribution.license_name, "CC BY-SA 4.0");
    assert_eq!(
        rights.attribution.source_url.as_deref(),
        Some("https://commons.wikimedia.org/wiki/File:Sunrise_over_hills.webm")
    );
    assert!(!rights.conflict);
}

#[test]
fn commons_missing_page_is_withdrawn() {
    let result = parse_item(
        ProviderId::WikimediaCommons,
        "File:Sunrise over hills.webm",
        fixture!("commons-missing.json"),
    );
    assert_eq!(result, Ok(ItemParse::Withdrawn));
}

#[test]
fn commons_item_id_mismatch_is_rejected() {
    let result = parse_item(
        ProviderId::WikimediaCommons,
        "File:Other.webm",
        fixture!("commons-item.json"),
    );
    assert_eq!(result, Err(AdapterError::Malformed("title mismatch")));
}

#[test]
fn commons_search_is_ordered_by_index_and_skips_broken_pages() {
    let items = parse_search(
        ProviderId::WikimediaCommons,
        MediaKind::Video,
        fixture!("commons-search.json"),
    )
    .expect("search");
    let ids: Vec<&str> = items.iter().map(|i| i.provider_item_id.as_str()).collect();
    assert_eq!(ids, ["File:First.webm", "File:Second.webm"]);
    let pd = normalize_item(&items[1]);
    assert_eq!(pd.license.code, LicenseCode::Pdm);
}

#[test]
fn openverse_image_maps_license_and_prefixed_id() {
    let item = found(parse_item(
        ProviderId::Openverse,
        "image:4bc43a04-ef46-4544-a0c1-63c63f56e276",
        fixture!("openverse-image.json"),
    ));
    let rights = normalize_item(&item);
    assert_eq!(rights.license.code, LicenseCode::By);
    assert_eq!(rights.license.version.as_deref(), Some("2.0"));
    assert_eq!(item.creator.as_deref(), Some("someone"));
}

#[test]
fn openverse_search_skips_invalid_ids_and_advises_nc_block_for_commercial() {
    let items = parse_search(
        ProviderId::Openverse,
        MediaKind::Image,
        fixture!("openverse-search.json"),
    )
    .expect("search");
    assert_eq!(items.len(), 1);
    let candidate = candidate_for(&items[0], UsePolicyProfile::CommercialOnline);
    assert_eq!(candidate.license.code, LicenseCode::ByNc);
    assert_eq!(candidate.advisory_policy.outcome, PolicyOutcome::Block);
}

#[test]
fn smithsonian_cc0_item_and_collection_agree() {
    let item = found(parse_item(
        ProviderId::Smithsonian,
        "edanmdm-nasm_A19610048000",
        fixture!("smithsonian-item.json"),
    ));
    let rights = normalize_item(&item);
    assert_eq!(rights.license.code, LicenseCode::Cc0);
    assert!(!rights.conflict);
    assert_eq!(
        item.title.as_deref(),
        Some("Ryan NYP \"Spirit of St. Louis\"")
    );
}

#[test]
fn smithsonian_item_collection_disagreement_resolves_to_stricter_with_conflict() {
    let item = found(parse_item(
        ProviderId::Smithsonian,
        "edanmdm-conflict_1",
        fixture!("smithsonian-conflict.json"),
    ));
    let rights = normalize_item(&item);
    assert_eq!(rights.item_license.code, LicenseCode::Cc0);
    assert_eq!(
        rights.collection_license.as_ref().map(|l| l.code),
        Some(LicenseCode::Unknown)
    );
    // Unknown collection does not override a known item license.
    assert_eq!(rights.license.code, LicenseCode::Cc0);
}

#[test]
fn pexels_video_is_custom_and_picks_best_mp4_under_1080p() {
    let item = found(parse_item(
        ProviderId::Pexels,
        "video:3571264",
        fixture!("pexels-video.json"),
    ));
    assert_eq!(
        item.download_url,
        "https://videos.pexels.com/video-files/3571264/hd.mp4"
    );
    assert_eq!(item.width, Some(1920));
    let rights = normalize_item(&item);
    assert_eq!(rights.license.code, LicenseCode::Custom);
    assert_eq!(
        rights.license.url.as_deref(),
        Some("https://www.pexels.com/license/")
    );
    assert_eq!(rights.attribution.license_name, "Pexels License");
    let candidate = candidate_for(&item, UsePolicyProfile::Broadcast);
    assert_eq!(candidate.advisory_policy.outcome, PolicyOutcome::Warn);
}

#[test]
fn pexels_search_skips_items_without_mp4() {
    let items = parse_search(
        ProviderId::Pexels,
        MediaKind::Video,
        fixture!("pexels-search.json"),
    )
    .expect("search");
    assert_eq!(items.len(), 1);
}

#[test]
fn pixabay_video_and_empty_hits_withdrawn() {
    let item = found(parse_item(
        ProviderId::Pixabay,
        "video:125",
        fixture!("pixabay-video.json"),
    ));
    assert_eq!(
        item.creator_url.as_deref(),
        Some("https://pixabay.com/users/Coverr-Free-Footage-1281706/")
    );
    assert_eq!(normalize_item(&item).license.code, LicenseCode::Custom);
    assert_eq!(
        parse_item(
            ProviderId::Pixabay,
            "video:125",
            fixture!("pixabay-empty.json")
        ),
        Ok(ItemParse::Withdrawn)
    );
}

#[test]
fn freesound_http_license_url_is_canonicalized_and_title_is_sanitized() {
    let item = found(parse_item(
        ProviderId::Freesound,
        "1234",
        fixture!("freesound-sound.json"),
    ));
    assert_eq!(item.title.as_deref(), Some("Rain on window"));
    let rights = normalize_item(&item);
    assert_eq!(rights.license.code, LicenseCode::By);
    assert_eq!(
        rights.license.url.as_deref(),
        Some("https://creativecommons.org/licenses/by/3.0/")
    );
}

#[test]
fn freesound_search_skips_records_without_previews() {
    let items = parse_search(
        ProviderId::Freesound,
        MediaKind::Audio,
        fixture!("freesound-search.json"),
    )
    .expect("search");
    assert_eq!(items.len(), 1);
}

#[test]
fn item_requests_reject_traversal_and_foreign_shapes() {
    let endpoints = ProviderEndpoints::production();
    for (provider, id) in [
        (ProviderId::WikimediaCommons, "../api.php"),
        (ProviderId::WikimediaCommons, "Sunrise.webm"),
        (ProviderId::Openverse, "image:../../admin"),
        (
            ProviderId::Openverse,
            "video:4bc43a04-ef46-4544-a0c1-63c63f56e276",
        ),
        (ProviderId::Pexels, "video:12a"),
        (ProviderId::Pixabay, "gif:1"),
        (ProviderId::Freesound, "12/34"),
    ] {
        let key = requires_key(provider).then(|| Secret::new("k"));
        assert!(
            item_request(&endpoints, provider, id, key).is_err(),
            "{provider:?} {id} must be rejected"
        );
    }
}

#[test]
fn keyed_providers_require_a_key_and_keep_it_out_of_the_url() {
    let endpoints = ProviderEndpoints::production();
    assert_eq!(
        item_request(&endpoints, ProviderId::Pexels, "video:1", None).map(|_| ()),
        Err(AdapterError::KeyMissing)
    );
    let request = item_request(
        &endpoints,
        ProviderId::Pixabay,
        "video:125",
        Some(Secret::new("SECRET")),
    )
    .expect("request");
    assert!(
        !request.url.as_str().contains("SECRET"),
        "key is attached at send time only"
    );
    assert_eq!(request.url.host_str(), Some("pixabay.com"));
    let commons = item_request(
        &endpoints,
        ProviderId::WikimediaCommons,
        "File:A b.webm",
        None,
    )
    .expect("commons");
    assert!(matches!(
        commons.credential,
        crate::rights::net::Credential::None
    ));
}

#[test]
fn search_rejects_blank_long_and_control_queries() {
    let endpoints = ProviderEndpoints::production();
    for query in ["", "   ", "a\u{0}b", &"x".repeat(201)] {
        assert_eq!(
            search_request(
                &endpoints,
                ProviderId::WikimediaCommons,
                query,
                MediaKind::Video,
                None
            )
            .map(|_| ()),
            Err(AdapterError::InvalidQuery)
        );
    }
}

#[test]
fn display_links_must_be_https() {
    let mut item = found(parse_item(
        ProviderId::Freesound,
        "1234",
        fixture!("freesound-sound.json"),
    ));
    item.landing_url = Some("http://freesound.org/x".into());
    assert_eq!(normalize_item(&item).attribution.source_url, None);
}

#[test]
fn internet_archive_item_picks_original_mp4_and_maps_license() {
    let item = found(parse_item(
        ProviderId::InternetArchive,
        "Flickr-18926153804",
        fixture!("internet-archive-item.json"),
    ));
    assert_eq!(item.media_kind, MediaKind::Video);
    assert_eq!(
        item.download_url,
        "https://archive.org/download/Flickr-18926153804/20150708_HDR-18926153804.mp4"
    );
    assert_eq!(item.expected_media_type.as_deref(), Some("video/mp4"));
    assert_eq!(
        (item.width, item.height, item.duration_ms),
        (Some(1920), Some(1080), Some(8_480))
    );
    assert_eq!(
        item.title.as_deref(),
        Some("20150708 Sunrise timelapse HDR")
    );
    assert_eq!(item.creator.as_deref(), Some("Chao-Wei Juan"));
    let rights = normalize_item(&item);
    assert_eq!(rights.license.code, LicenseCode::ByNc);
    assert_eq!(
        rights.attribution.source_url.as_deref(),
        Some("https://archive.org/details/Flickr-18926153804")
    );
    let candidate = candidate_for(&item, UsePolicyProfile::CommercialOnline);
    assert_eq!(candidate.advisory_policy.outcome, PolicyOutcome::Block);
}

#[test]
fn internet_archive_missing_dark_and_mismatched_items() {
    assert_eq!(
        parse_item(ProviderId::InternetArchive, "Flickr-18926153804", b"{}"),
        Ok(ItemParse::Withdrawn)
    );
    let dark = br#"{"is_dark":true,"metadata":{"identifier":"Flickr-18926153804","mediatype":"movies"},"files":[]}"#;
    assert_eq!(
        parse_item(ProviderId::InternetArchive, "Flickr-18926153804", dark),
        Ok(ItemParse::Withdrawn)
    );
    assert_eq!(
        parse_item(
            ProviderId::InternetArchive,
            "Other-item",
            fixture!("internet-archive-item.json")
        ),
        Err(AdapterError::Malformed("identifier mismatch"))
    );
    let no_media = br#"{"metadata":{"identifier":"x1","mediatype":"movies"},"files":[{"name":"a.txt"},{"name":"sub/b.mp4"}]}"#;
    assert_eq!(
        parse_item(ProviderId::InternetArchive, "x1", no_media),
        Err(AdapterError::UnsupportedMedia)
    );
}

#[test]
fn internet_archive_item_without_license_is_unknown_and_blocked_publicly() {
    let unlicensed = br#"{"metadata":{"identifier":"x1","mediatype":"movies","title":"T"},"files":[{"name":"clip.mp4","source":"original","size":"10"}]}"#;
    let item = found(parse_item(ProviderId::InternetArchive, "x1", unlicensed));
    assert_eq!(normalize_item(&item).license.code, LicenseCode::Unknown);
    assert_eq!(
        candidate_for(&item, UsePolicyProfile::NoncommercialPublic)
            .advisory_policy
            .outcome,
        PolicyOutcome::Block
    );
}

#[test]
fn internet_archive_file_names_are_percent_encoded_in_one_segment() {
    let tricky = br#"{"metadata":{"identifier":"x1","mediatype":"movies"},"files":[{"name":"my clip #1?.mp4","source":"original"}]}"#;
    let item = found(parse_item(ProviderId::InternetArchive, "x1", tricky));
    assert_eq!(
        item.download_url,
        "https://archive.org/download/x1/my%20clip%20%231%3F.mp4"
    );
}

#[test]
fn internet_archive_search_filters_ids_and_kinds_and_sanitizes_query() {
    let items = parse_search(
        ProviderId::InternetArchive,
        MediaKind::Video,
        fixture!("internet-archive-search.json"),
    )
    .expect("search");
    let ids: Vec<&str> = items.iter().map(|i| i.provider_item_id.as_str()).collect();
    assert_eq!(ids, ["Flickr-18926153804", "prelinger-sunrise-1950"]);
    assert_eq!(items[1].title.as_deref(), Some("Sunrise Over the City"));
    assert_eq!(normalize_item(&items[1]).license.code, LicenseCode::Pdm);

    let endpoints = ProviderEndpoints::production();
    let request = search_request(
        &endpoints,
        ProviderId::InternetArchive,
        "sunrise OR mediatype:(texts) AND licenseurl:x",
        MediaKind::Video,
        None,
    )
    .expect("request");
    let q: String = request
        .url
        .query_pairs()
        .find(|(k, _)| k == "q")
        .map(|(_, v)| v.into_owned())
        .expect("q");
    assert_eq!(
        q,
        "(sunrise mediatype texts licenseurl x) AND mediatype:movies AND licenseurl:*"
    );
    assert!(matches!(
        request.credential,
        crate::rights::net::Credential::None
    ));
    assert_eq!(
        search_request(
            &endpoints,
            ProviderId::InternetArchive,
            "( ) :",
            MediaKind::Video,
            None
        )
        .map(|_| ()),
        Err(AdapterError::InvalidQuery)
    );
    for bad in ["../x", "-lead", "a/b", "a b"] {
        assert!(
            item_request(&endpoints, ProviderId::InternetArchive, bad, None).is_err(),
            "{bad}"
        );
    }
}
