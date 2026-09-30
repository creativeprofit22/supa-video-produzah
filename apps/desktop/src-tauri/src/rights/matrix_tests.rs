//! Pins the Rust authority to the shared license matrix also used by the
//! TypeScript mirror in `packages/video-rights`.

use std::collections::BTreeMap;

use serde::Deserialize;

use super::{
    attribution::{missing_attribution_fields, render_credits_text, CreditEntry},
    license::{license_display_name, normalize_license, resolve_license_conflict, LicenseInput},
    policy::evaluate_policy,
    types::{
        LicenseCode, LicenseId, PolicyDecision, ProviderId, StructuredAttribution, UsePolicyProfile,
    },
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Matrix {
    schema_version: u8,
    profiles: Vec<UsePolicyProfile>,
    normalization: Vec<NormalizationRow>,
    policy: Vec<PolicyRow>,
    conflicts: Vec<ConflictRow>,
    attribution: Vec<AttributionRow>,
    credits: Vec<CreditsRow>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizationInput {
    provider_id: ProviderId,
    url: Option<String>,
    name: Option<String>,
    version: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NormalizationRow {
    name: String,
    input: NormalizationInput,
    expected: LicenseId,
    display_name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PolicyRow {
    code: LicenseCode,
    conflict: bool,
    expected: BTreeMap<String, PolicyDecision>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictExpected {
    license: LicenseId,
    conflict: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ConflictRow {
    name: String,
    item: LicenseId,
    collection: Option<LicenseId>,
    expected: ConflictExpected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AttributionRow {
    name: String,
    code: LicenseCode,
    attribution: StructuredAttribution,
    expected_missing: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreditsEntryRow {
    receipt_id: String,
    attribution: StructuredAttribution,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreditsRow {
    name: String,
    entries: Vec<CreditsEntryRow>,
    expected_text: String,
}

fn matrix() -> Matrix {
    let parsed: Matrix = serde_json::from_str(include_str!(
        "../../../../../packages/video-rights/fixtures/license-matrix-v1.json"
    ))
    .expect("shared license matrix must match the Rust mirror");
    assert_eq!(parsed.schema_version, 1);
    parsed
}

fn profile_key(profile: UsePolicyProfile) -> String {
    serde_json::to_value(profile)
        .expect("profile serializes")
        .as_str()
        .expect("profile is a string")
        .to_owned()
}

#[test]
fn normalization_matches_shared_matrix() {
    for row in matrix().normalization {
        let input = LicenseInput {
            provider_id: row.input.provider_id,
            url: row.input.url.as_deref(),
            name: row.input.name.as_deref(),
            version: row.input.version.as_deref(),
        };
        let license = normalize_license(&input);
        assert_eq!(license, row.expected, "normalization: {}", row.name);
        assert_eq!(
            license_display_name(&license, row.input.provider_id),
            row.display_name,
            "display: {}",
            row.name
        );
    }
}

#[test]
fn policy_matches_shared_matrix_for_every_profile() {
    let matrix = matrix();
    assert_eq!(matrix.profiles.len(), 5);
    let mut codes_seen = std::collections::BTreeSet::new();
    for row in &matrix.policy {
        codes_seen.insert(row.code.as_str());
        for profile in &matrix.profiles {
            let expected = row
                .expected
                .get(&profile_key(*profile))
                .unwrap_or_else(|| panic!("missing profile for {}", row.code.as_str()));
            assert_eq!(
                &evaluate_policy(row.code, *profile, row.conflict),
                expected,
                "policy {} conflict={} {:?}",
                row.code.as_str(),
                row.conflict,
                profile
            );
        }
    }
    assert_eq!(codes_seen.len(), 10, "every license code is covered");
}

#[test]
fn conflicts_match_shared_matrix() {
    for row in matrix().conflicts {
        let resolved = resolve_license_conflict(&row.item, row.collection.as_ref());
        assert_eq!(
            resolved.license, row.expected.license,
            "conflict: {}",
            row.name
        );
        assert_eq!(
            resolved.conflict, row.expected.conflict,
            "conflict flag: {}",
            row.name
        );
    }
}

#[test]
fn attribution_completeness_matches_shared_matrix() {
    for row in matrix().attribution {
        let missing: Vec<String> = missing_attribution_fields(row.code, &row.attribution)
            .into_iter()
            .map(str::to_owned)
            .collect();
        assert_eq!(missing, row.expected_missing, "attribution: {}", row.name);
    }
}

#[test]
fn credits_text_matches_shared_matrix() {
    for row in matrix().credits {
        let entries: Vec<CreditEntry> = row
            .entries
            .into_iter()
            .map(|entry| CreditEntry {
                receipt_id: entry.receipt_id,
                attribution: entry.attribution,
            })
            .collect();
        assert_eq!(
            render_credits_text(&entries),
            row.expected_text,
            "credits: {}",
            row.name
        );
    }
}
