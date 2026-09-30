//! License normalization and item/collection conflict resolution.
//!
//! Normalization follows the Openverse approach of deriving a (code, version)
//! pair from the canonical creativecommons.org URL path first and falling back
//! to the provider's short name. A URL/name disagreement is treated as unknown
//! rather than guessed. Pexels and Pixabay never map to CC: they are `custom`
//! and rely on the snapshotted provider terms.
//!
//! Mirrored by `packages/video-rights/src/license.ts`; both are pinned by
//! `packages/video-rights/fixtures/license-matrix-v1.json`.

use super::types::{LicenseCode, LicenseId, ProviderId};

const CC_VERSIONS: [&str; 6] = ["1.0", "2.0", "2.1", "2.5", "3.0", "4.0"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LicenseInput<'a> {
    pub provider_id: ProviderId,
    pub url: Option<&'a str>,
    pub name: Option<&'a str>,
    pub version: Option<&'a str>,
}

pub fn unknown_license() -> LicenseId {
    LicenseId {
        code: LicenseCode::Unknown,
        version: None,
        url: None,
    }
}

fn custom_terms(provider_id: ProviderId) -> Option<(&'static str, &'static str)> {
    match provider_id {
        ProviderId::Pexels => Some(("https://www.pexels.com/license/", "Pexels License")),
        ProviderId::Pixabay => Some((
            "https://pixabay.com/service/license-summary/",
            "Pixabay Content License",
        )),
        _ => None,
    }
}

/// Terms URL that must be snapshotted for providers whose own terms govern use.
pub fn provider_terms_url(provider_id: ProviderId) -> Option<&'static str> {
    custom_terms(provider_id).map(|(url, _)| url)
}

fn cc_code(segment: &str) -> Option<LicenseCode> {
    Some(match segment {
        "by" => LicenseCode::By,
        "by-sa" => LicenseCode::BySa,
        "by-nc" => LicenseCode::ByNc,
        "by-nc-sa" => LicenseCode::ByNcSa,
        "by-nd" => LicenseCode::ByNd,
        "by-nc-nd" | "by-nd-nc" => LicenseCode::ByNcNd,
        _ => return None,
    })
}

fn normalize_version(value: Option<&str>) -> Option<String> {
    let trimmed = value?.trim();
    let expanded = if trimmed.len() == 1 && trimmed.chars().all(|c| c.is_ascii_digit()) {
        format!("{trimmed}.0")
    } else {
        trimmed.to_owned()
    };
    CC_VERSIONS.contains(&expanded.as_str()).then_some(expanded)
}

pub fn canonical_license(code: LicenseCode, version: Option<String>) -> LicenseId {
    match code {
        LicenseCode::Cc0 => LicenseId {
            code,
            version: Some("1.0".into()),
            url: Some("https://creativecommons.org/publicdomain/zero/1.0/".into()),
        },
        LicenseCode::Pdm => LicenseId {
            code,
            version: Some("1.0".into()),
            url: Some("https://creativecommons.org/publicdomain/mark/1.0/".into()),
        },
        LicenseCode::Custom | LicenseCode::Unknown => LicenseId {
            code,
            version: None,
            url: None,
        },
        _ => {
            let url = version.as_ref().map(|v| {
                format!(
                    "https://creativecommons.org/licenses/{}/{v}/",
                    code.as_str()
                )
            });
            LicenseId { code, version, url }
        }
    }
}

pub fn license_from_url(raw: &str) -> Option<LicenseId> {
    let parsed = url::Url::parse(raw.trim()).ok()?;
    if !matches!(parsed.scheme(), "https" | "http") {
        return None;
    }
    let host = parsed.host_str()?.to_ascii_lowercase();
    if host != "creativecommons.org" && host != "www.creativecommons.org" {
        return None;
    }
    let path = parsed.path().to_ascii_lowercase();
    let mut segments = path.split('/').filter(|segment| !segment.is_empty());
    let family = segments.next()?;
    let code = segments.next();
    let version = segments.next();
    if family == "publicdomain" {
        if version != Some("1.0") {
            return None;
        }
        return match code {
            Some("zero") => Some(canonical_license(LicenseCode::Cc0, None)),
            Some("mark") => Some(canonical_license(LicenseCode::Pdm, None)),
            _ => None,
        };
    }
    if family != "licenses" {
        return None;
    }
    let mapped = cc_code(code?)?;
    let version = normalize_version(version)?;
    Some(canonical_license(mapped, Some(version)))
}

pub fn license_from_name(name: &str, version_field: Option<&str>) -> Option<LicenseId> {
    let lowered = name.trim().to_lowercase();
    let mut tokens: Vec<&str> = lowered
        .split(|c: char| c.is_whitespace() || c == '_' || c == '-')
        .filter(|token| !token.is_empty())
        .collect();
    if tokens.is_empty() {
        return None;
    }
    let mut version: Option<String> = None;
    if let Some(last) = tokens.last() {
        let is_version = {
            let mut parts = last.splitn(2, '.');
            let major = parts.next().unwrap_or_default();
            let minor = parts.next();
            !major.is_empty()
                && major.chars().all(|c| c.is_ascii_digit())
                && minor.is_none_or(|m| !m.is_empty() && m.chars().all(|c| c.is_ascii_digit()))
        };
        if is_version {
            version = Some((*last).to_owned());
            tokens.pop();
        }
    }
    if tokens.first() == Some(&"cc") && tokens.len() > 1 {
        tokens.remove(0);
    }
    let joined = tokens.join("-");
    match joined.as_str() {
        "cc0" | "zero" => return Some(canonical_license(LicenseCode::Cc0, None)),
        "pdm" | "pd" | "public-domain" | "publicdomain" | "public-domain-mark" => {
            return Some(canonical_license(LicenseCode::Pdm, None))
        }
        _ => {}
    }
    let mapped = cc_code(&joined)?;
    let version = normalize_version(version.as_deref().or(version_field));
    Some(canonical_license(mapped, version))
}

pub fn normalize_license(input: &LicenseInput<'_>) -> LicenseId {
    if let Some((url, _)) = custom_terms(input.provider_id) {
        return LicenseId {
            code: LicenseCode::Custom,
            version: None,
            url: Some(url.into()),
        };
    }
    let from_url = input.url.and_then(license_from_url);
    let from_name = input
        .name
        .and_then(|name| license_from_name(name, input.version));
    match (from_url, from_name) {
        (Some(url), Some(name)) if url.code != name.code => unknown_license(),
        (Some(url), _) => url,
        (None, Some(name)) => name,
        (None, None) => unknown_license(),
    }
}

pub fn license_display_name(license: &LicenseId, provider_id: ProviderId) -> String {
    match license.code {
        LicenseCode::Cc0 => "CC0 1.0".into(),
        LicenseCode::Pdm => "Public Domain Mark 1.0".into(),
        LicenseCode::Unknown => "Unknown license".into(),
        LicenseCode::Custom => custom_terms(provider_id)
            .map(|(_, name)| name.to_owned())
            .unwrap_or_else(|| "Custom terms".into()),
        code => {
            let base = format!("CC {}", code.as_str().to_ascii_uppercase());
            match &license.version {
                Some(version) => format!("{base} {version}"),
                None => base,
            }
        }
    }
}

fn restrictiveness(code: LicenseCode) -> u8 {
    match code {
        LicenseCode::Cc0 => 0,
        LicenseCode::Pdm => 1,
        LicenseCode::By => 2,
        LicenseCode::BySa => 3,
        LicenseCode::Custom => 4,
        LicenseCode::ByNc => 5,
        LicenseCode::ByNd => 6,
        LicenseCode::ByNcSa => 7,
        LicenseCode::ByNcNd => 8,
        LicenseCode::Unknown => 9,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedLicense {
    pub license: LicenseId,
    pub conflict: bool,
}

/// An item-level license and a collection-level license may disagree. The
/// stricter one wins and the conflict is surfaced to policy as a warning.
pub fn resolve_license_conflict(
    item: &LicenseId,
    collection: Option<&LicenseId>,
) -> ResolvedLicense {
    let Some(collection) = collection.filter(|c| c.code != LicenseCode::Unknown) else {
        return ResolvedLicense {
            license: item.clone(),
            conflict: false,
        };
    };
    if item.code == LicenseCode::Unknown {
        return ResolvedLicense {
            license: collection.clone(),
            conflict: false,
        };
    }
    if item.code == collection.code {
        return ResolvedLicense {
            license: item.clone(),
            conflict: false,
        };
    }
    let stricter = if restrictiveness(collection.code) > restrictiveness(item.code) {
        collection
    } else {
        item
    };
    ResolvedLicense {
        license: stricter.clone(),
        conflict: true,
    }
}
