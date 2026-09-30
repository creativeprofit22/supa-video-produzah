//! Release gate enforced by the render authority. Every case runs through both
//! the fresh path (`validate_render_plan_with_rights`) and the persisted /
//! reauthorized path (`validate_persisted_render_plan`).

use super::*;
use crate::rights::{
    gate::{credits_sidecar_paths, RenderRights},
    store::{
        sha256_hex,
        tests::{sample_blobs, sample_receipt},
        ReceiptStore,
    },
    types::{AcquisitionReceipt, LicenseCode, LicenseId, RefreshStatus, UsePolicyProfile},
};
use crate::video::{
    render::{validate_persisted_render_plan, validate_render_plan_with_rights},
    types::RenderPlan,
};

const TOP_ASSET: &str = "55555555-5555-4555-8555-555555555555";
const DAY_MS: u64 = 24 * 60 * 60 * 1000;
const NOW_MS: u64 = 1_800_000_000_000;

struct Fixture {
    _dir: tempfile::TempDir,
    store: ReceiptStore,
    grants: VideoPathGrants,
    plan: Value,
    output: PathBuf,
}

/// The "top" input (bytes `b"top"`) is the acquired asset; "bottom" is a local import.
fn fixture() -> Fixture {
    let dir = tempdir().expect("dir");
    let (grants, plan) = granted_multitrack_render_plan(dir.path());
    let store = ReceiptStore::open(&dir.path().join("rights")).expect("store");
    let output = PathBuf::from(plan["outputPath"].as_str().expect("output"));
    Fixture {
        _dir: dir,
        store,
        grants,
        plan,
        output,
    }
}

fn acquired_receipt(fixture: &Fixture) -> AcquisitionReceipt {
    let blobs = sample_blobs("gate");
    let mut receipt = sample_receipt(&sha256_hex(b"top"), &blobs);
    receipt.content.byte_length = 3;
    receipt.last_refresh_at_ms = NOW_MS - DAY_MS;
    fixture
        .store
        .commit_receipt(&receipt, &blobs)
        .expect("commit");
    receipt
}

fn rights(store: &ReceiptStore) -> RenderRights<'_> {
    RenderRights {
        lookup: store,
        now_ms: NOW_MS,
        freshness: Duration::from_secs(30 * 24 * 60 * 60),
    }
}

fn with_rights_context(
    mut plan: Value,
    receipt_id: Option<&uuid::Uuid>,
    intended_use: &str,
) -> Value {
    let claims = match receipt_id {
        Some(id) => serde_json::json!({ (TOP_ASSET): id.to_string() }),
        None => serde_json::json!({}),
    };
    plan["rights"] = serde_json::json!({
        "intendedUse": intended_use,
        "acquisitionReceiptIdsByAssetId": claims,
    });
    plan
}

/// Runs the plan through both render-authority entry points and returns both results.
fn validate_both(fixture: &Fixture, plan: &Value) -> [Result<(), String>; 2] {
    let parse = || -> RenderPlan { serde_json::from_value(plan.clone()).expect("plan schema") };
    let rights = rights(&fixture.store);
    let map = |result: Result<_, VideoCommandError>| {
        result.map(|_| ()).map_err(|error| {
            let value = serde_json::to_value(&error).expect("error json");
            assert_eq!(value["code"], "invalid_render_plan", "{value}");
            value["details"]["category"]
                .as_str()
                .unwrap_or_default()
                .to_owned()
        })
    };
    [
        map(validate_render_plan_with_rights(
            parse(),
            "owner",
            &fixture.grants,
            &rights,
        )),
        map(validate_persisted_render_plan(
            parse(),
            "owner",
            &fixture.grants,
            &rights,
        )),
    ]
}

fn assert_blocked(fixture: &Fixture, plan: &Value, field: &str) {
    for (path, result) in ["fresh", "persisted"]
        .iter()
        .zip(validate_both(fixture, plan))
    {
        assert_eq!(
            result,
            Err(field.to_owned()),
            "{path} path must block with {field}"
        );
    }
    let (json, text) = credits_sidecar_paths(&fixture.output).expect("sidecar paths");
    assert!(
        !json.exists() && !text.exists(),
        "blocked renders write no credits"
    );
}

fn tamper(store: &ReceiptStore, sql: &str) {
    let connection = rusqlite::Connection::open(store.path()).expect("open");
    connection
        .execute_batch(&format!(
            "DROP TRIGGER IF EXISTS snapshot_blobs_immutable; PRAGMA foreign_keys = OFF; {sql}"
        ))
        .expect("tamper");
}

#[test]
fn valid_receipt_renders_and_writes_credits_sidecar() {
    let fixture = fixture();
    let receipt = acquired_receipt(&fixture);
    let plan = with_rights_context(
        fixture.plan.clone(),
        Some(&receipt.receipt_id),
        "commercial-online",
    );
    for (path, result) in ["fresh", "persisted"]
        .iter()
        .zip(validate_both(&fixture, &plan))
    {
        assert_eq!(result, Ok(()), "{path} path must pass");
    }
    let (json_path, text_path) = credits_sidecar_paths(&fixture.output).expect("paths");
    let json: Value =
        serde_json::from_slice(&fs::read(&json_path).expect("credits.json")).expect("json");
    assert_eq!(json["schemaVersion"], 1);
    assert_eq!(json["credits"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        json["credits"][0]["receiptId"],
        receipt.receipt_id.to_string()
    );
    assert_eq!(json["credits"][0]["content"]["digest"], sha256_hex(b"top"));
    let text = fs::read_to_string(&text_path).expect("CREDITS.txt");
    assert!(
        text.starts_with("Credits\n\n\"Example\" by Jane\n"),
        "{text}"
    );
    assert!(text.contains("License: CC BY 4.0 <https://creativecommons.org/licenses/by/4.0/>"));
}

#[test]
fn missing_receipt_for_claimed_asset_blocks() {
    let fixture = fixture();
    let plan = with_rights_context(
        fixture.plan.clone(),
        Some(&uuid::Uuid::new_v4()),
        "commercial-online",
    );
    assert_blocked(&fixture, &plan, "rights_receipt_missing");
}

#[test]
fn unreadable_receipt_row_blocks() {
    let fixture = fixture();
    acquired_receipt(&fixture);
    tamper(&fixture.store, "UPDATE receipts SET receipt_json = '{}';");
    assert_blocked(&fixture, &fixture.plan, "rights_receipt_missing");
}

#[test]
fn missing_snapshot_blocks() {
    let fixture = fixture();
    let receipt = acquired_receipt(&fixture);
    tamper(
        &fixture.store,
        &format!(
            "DELETE FROM snapshot_blobs WHERE digest = '{}';",
            receipt.snapshots[1].digest
        ),
    );
    assert_blocked(&fixture, &fixture.plan, "rights_snapshot_missing");
}

#[test]
fn tampered_snapshot_blocks() {
    let fixture = fixture();
    let receipt = acquired_receipt(&fixture);
    tamper(
        &fixture.store,
        &format!(
            "UPDATE snapshot_blobs SET bytes = x'00' WHERE digest = '{}';",
            receipt.snapshots[0].digest
        ),
    );
    assert_blocked(&fixture, &fixture.plan, "rights_snapshot_tampered");
}

#[test]
fn stale_refresh_blocks() {
    let fixture = fixture();
    let receipt = acquired_receipt(&fixture);
    fixture
        .store
        .record_refresh(
            &receipt.receipt_id,
            NOW_MS - 31 * DAY_MS,
            RefreshStatus::Unchanged,
            None,
        )
        .expect("last refresh 31 days ago");
    assert_blocked(&fixture, &fixture.plan, "rights_refresh_stale");
}

#[test]
fn changed_and_withdrawn_upstream_records_block() {
    for (status, field) in [
        (RefreshStatus::Changed, "rights_upstream_changed"),
        (RefreshStatus::Withdrawn, "rights_upstream_withdrawn"),
    ] {
        let fixture = fixture();
        let receipt = acquired_receipt(&fixture);
        fixture
            .store
            .record_refresh(&receipt.receipt_id, NOW_MS, status, None)
            .expect("refresh");
        assert_blocked(&fixture, &fixture.plan, field);
    }
}

#[test]
fn blocked_intended_use_blocks() {
    let fixture = fixture();
    let blobs = sample_blobs("nc");
    let mut receipt = sample_receipt(&sha256_hex(b"top"), &blobs);
    receipt.content.byte_length = 3;
    receipt.last_refresh_at_ms = NOW_MS;
    receipt.intended_use = UsePolicyProfile::NoncommercialPublic;
    receipt.license = LicenseId {
        code: LicenseCode::ByNc,
        version: Some("4.0".into()),
        url: Some("https://creativecommons.org/licenses/by-nc/4.0/".into()),
    };
    fixture
        .store
        .commit_receipt(&receipt, &blobs)
        .expect("commit");
    // Acquired for noncommercial use; the export declares a commercial use.
    let plan = with_rights_context(fixture.plan.clone(), Some(&receipt.receipt_id), "broadcast");
    assert_blocked(&fixture, &plan, "rights_use_blocked");
    // Without a declared export use, the acquisition use applies and passes.
    for result in validate_both(&fixture, &fixture.plan) {
        assert_eq!(result, Ok(()));
    }
}

#[test]
fn incomplete_attribution_blocks() {
    let fixture = fixture();
    let blobs = sample_blobs("attr");
    let mut receipt = sample_receipt(&sha256_hex(b"top"), &blobs);
    receipt.content.byte_length = 3;
    receipt.last_refresh_at_ms = NOW_MS;
    receipt.attribution.creator = None;
    fixture
        .store
        .commit_receipt(&receipt, &blobs)
        .expect("commit");
    assert_blocked(&fixture, &fixture.plan, "rights_attribution_incomplete");
}

#[test]
fn origin_stripped_from_plan_is_still_gated_by_digest() {
    let fixture = fixture();
    let receipt = acquired_receipt(&fixture);
    fixture
        .store
        .record_refresh(&receipt.receipt_id, NOW_MS, RefreshStatus::Withdrawn, None)
        .expect("withdraw");
    // No rights context at all: the UI claims nothing about the acquired asset.
    assert!(fixture.plan.get("rights").is_none());
    assert_blocked(&fixture, &fixture.plan, "rights_upstream_withdrawn");
    // An explicit empty claim map is equally ineffective.
    let plan = with_rights_context(fixture.plan.clone(), None, "private-preview");
    assert_blocked(&fixture, &plan, "rights_upstream_withdrawn");
}

#[test]
fn mismatched_acquisition_receipt_id_blocks() {
    let fixture = fixture();
    acquired_receipt(&fixture);
    // A real receipt for different bytes, claimed for the "top" asset.
    let blobs = sample_blobs("other");
    let other = sample_receipt(&sha256_hex(b"something else"), &blobs);
    fixture
        .store
        .commit_receipt(&other, &blobs)
        .expect("commit other");
    let plan = with_rights_context(
        fixture.plan.clone(),
        Some(&other.receipt_id),
        "commercial-online",
    );
    assert_blocked(&fixture, &plan, "rights_receipt_mismatch");
}

#[test]
fn claims_for_assets_outside_the_plan_are_rejected() {
    let fixture = fixture();
    let mut plan = fixture.plan.clone();
    plan["rights"] = serde_json::json!({
        "intendedUse": "private-preview",
        "acquisitionReceiptIdsByAssetId": { "99999999-9999-4999-8999-999999999999": uuid::Uuid::new_v4().to_string() },
    });
    assert_blocked(&fixture, &plan, "rights_context");
}

#[test]
fn unwritable_credits_sidecar_blocks_the_render() {
    let fixture = fixture();
    acquired_receipt(&fixture);
    let (json_path, _) = credits_sidecar_paths(&fixture.output).expect("paths");
    fs::create_dir(&json_path).expect("occupy sidecar path with a directory");
    for result in validate_both(&fixture, &fixture.plan) {
        assert_eq!(result, Err("rights_credits_write".to_owned()));
    }
}

/// Regression: a project whose inputs are only local imports (no `origin`, no receipt for
/// their digest) validates exactly as before, even with receipts for other content in the
/// store — including receipts whose byte length collides with a local input's — and no
/// credits sidecar is required or written.
#[test]
fn local_imports_still_export_without_credits() {
    let fixture = fixture();
    // Unrelated acquired content, one of them the same size as the 3-byte "top" input.
    for seed in ["unrelated-a", "unrelated-b"] {
        let blobs = sample_blobs(seed);
        let mut receipt = sample_receipt(&sha256_hex(seed.as_bytes()), &blobs);
        receipt.content.byte_length = if seed == "unrelated-a" { 3 } else { 999 };
        fixture
            .store
            .commit_receipt(&receipt, &blobs)
            .expect("commit");
    }
    let expected_without_rights =
        parse_and_validate_render_plan(fixture.plan.clone(), "owner", &fixture.grants)
            .expect("pre-rights validation");
    for (path, result) in ["fresh", "persisted"]
        .iter()
        .zip(validate_both(&fixture, &fixture.plan))
    {
        assert_eq!(result, Ok(()), "{path} path must pass for local imports");
    }
    let with_store = validate_render_plan_with_rights(
        serde_json::from_value(fixture.plan.clone()).expect("plan"),
        "owner",
        &fixture.grants,
        &rights(&fixture.store),
    )
    .expect("gated validation");
    // Order-independent comparison: the input map is a HashMap, so two parses may iterate
    // differently; the plan (HashMap equality) and the set of inputs must be identical.
    let sorted = |paths: &[PathBuf]| {
        let mut paths = paths.to_vec();
        paths.sort();
        paths
    };
    assert_eq!(with_store.plan, expected_without_rights.plan);
    assert_eq!(
        sorted(&with_store.input_paths),
        sorted(&expected_without_rights.input_paths)
    );
    assert_eq!(with_store.output_path, expected_without_rights.output_path);
    assert_eq!(
        with_store.duration_microseconds,
        expected_without_rights.duration_microseconds
    );
    let (json, text) = credits_sidecar_paths(&fixture.output).expect("paths");
    assert!(
        !json.exists() && !text.exists(),
        "no credits sidecar for local-only exports"
    );
}
