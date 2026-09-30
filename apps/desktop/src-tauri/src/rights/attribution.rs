//! Attribution completeness and deterministic credits rendering.
//! Mirrored by `packages/video-rights/src/attribution.ts`.

use serde::Serialize;

use super::types::{LicenseCode, StructuredAttribution};

fn is_blank(value: Option<&str>) -> bool {
    value.is_none_or(|v| v.trim().is_empty())
}

/// Returns missing required fields in a fixed order (camelCase field names).
pub fn missing_attribution_fields(
    code: LicenseCode,
    attribution: &StructuredAttribution,
) -> Vec<&'static str> {
    let mut missing = Vec::new();
    let requires_credit = code.requires_attribution();
    if requires_credit && is_blank(attribution.creator.as_deref()) {
        missing.push("creator");
    }
    if is_blank(attribution.source_url.as_deref()) {
        missing.push("sourceUrl");
    }
    if requires_credit && is_blank(attribution.license_url.as_deref()) {
        missing.push("licenseUrl");
    }
    missing
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreditEntry {
    pub receipt_id: String,
    pub attribution: StructuredAttribution,
}

/// Provider text is untrusted: collapse control characters so one entry stays one block.
fn flatten(value: &str) -> String {
    value
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect::<String>()
        .trim()
        .to_owned()
}

pub fn render_credits_text(entries: &[CreditEntry]) -> String {
    let mut sorted: Vec<&CreditEntry> = entries.iter().collect();
    sorted.sort_by(|left, right| left.receipt_id.cmp(&right.receipt_id));
    let blocks: Vec<String> = sorted
        .into_iter()
        .map(|entry| {
            let a = &entry.attribution;
            let title = match a.title.as_deref() {
                Some(title) if !title.trim().is_empty() => format!("\"{}\"", flatten(title)),
                _ => "Untitled".to_owned(),
            };
            let creator = match a.creator.as_deref() {
                Some(creator) if !creator.trim().is_empty() => format!(" by {}", flatten(creator)),
                _ => String::new(),
            };
            let license_url = a
                .license_url
                .as_deref()
                .map(|url| format!(" <{}>", flatten(url)))
                .unwrap_or_default();
            let source = a
                .source_url
                .as_deref()
                .map(flatten)
                .unwrap_or_else(|| "unavailable".to_owned());
            format!(
                "{title}{creator}\n  License: {}{license_url}\n  Source: {source} (via {})",
                flatten(&a.license_name),
                flatten(&a.provider_name)
            )
        })
        .collect();
    format!("Credits\n\n{}\n", blocks.join("\n\n"))
}
