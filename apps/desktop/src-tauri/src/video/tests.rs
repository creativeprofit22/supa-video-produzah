use std::{
    fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use serde_json::Value;
use tempfile::{tempdir, NamedTempFile};

use super::{
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
    project_io::{
        atomic_save_with, dialog_path, ensure_canonical_source_containment, open_project_from_path,
        read_project_bounded, sanitize_default_name, save_project_to_path, VideoSourceStatus,
        MAX_PROJECT_BYTES,
    },
    types::{
        is_recognizable_absolute_path, parse_project_json, parse_project_value, VideoProjectFileV1,
    },
};

#[derive(Debug, Deserialize)]
struct ParityManifest {
    cases: Vec<ParityCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ParityCase {
    name: String,
    path: String,
    expected: String,
    canonical_path: Option<String>,
}

fn workspace_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../..")
        .canonicalize()
        .expect("workspace root must exist")
}

fn parity_directory() -> PathBuf {
    workspace_root().join("packages/video-contracts/fixtures/project-v1")
}

fn canonical_fixture_path() -> PathBuf {
    workspace_root().join("apps/desktop/src-tauri/fixtures/video-phase1/single-clip.svpvideo")
}

fn canonical_document() -> VideoProjectFileV1 {
    parse_project_json(&fs::read(canonical_fixture_path()).expect("fixture must be readable"))
        .expect("canonical fixture must be valid")
}

fn canonical_value() -> Value {
    serde_json::from_slice(&fs::read(canonical_fixture_path()).expect("fixture must be readable"))
        .expect("fixture JSON must parse")
}

fn write_project(path: &Path, value: &Value) {
    fs::write(
        path,
        serde_json::to_vec_pretty(value).expect("test document must serialize"),
    )
    .expect("test project must be writable");
}

#[test]
fn shared_contract_corpus_matches_expected_results() {
    let directory = parity_directory();
    let manifest: ParityManifest = serde_json::from_slice(
        &fs::read(directory.join("manifest.json")).expect("manifest must be readable"),
    )
    .expect("manifest must parse");

    for case in manifest.cases {
        let result = parse_project_json(
            &fs::read(directory.join(&case.path))
                .unwrap_or_else(|error| panic!("{} could not be read: {error}", case.name)),
        );
        let actual = match &result {
            Ok(_) => "valid",
            Err(error) => match error.code {
                VideoErrorCode::InvalidProject => "invalid_project",
                VideoErrorCode::UnsupportedSchema => "unsupported_schema",
                other => panic!("{} returned unexpected code {other:?}", case.name),
            },
        };
        assert_eq!(actual, case.expected, "parity case {}", case.name);

        if let (Ok(document), Some(canonical_path)) = (result, case.canonical_path) {
            let expected: Value = serde_json::from_slice(
                &fs::read(directory.join(canonical_path))
                    .expect("canonical output must be readable"),
            )
            .expect("canonical output must parse");
            let output = serde_json::to_value(document).expect("parsed document must serialize");
            assert_eq!(output, expected, "canonical parity case {}", case.name);
        }
    }
}

#[test]
fn canonical_and_transformed_fixtures_round_trip_structurally() {
    let canonical_input = canonical_value();
    let transformed_input: Value = serde_json::from_slice(
        &fs::read(parity_directory().join("valid-padded-nonblank.svpvideo"))
            .expect("transformed fixture must be readable"),
    )
    .expect("transformed fixture must parse");
    let transformed_expected: Value = serde_json::from_slice(
        &fs::read(parity_directory().join("valid-padded-nonblank.expected.json"))
            .expect("canonical transformed output must be readable"),
    )
    .expect("canonical output must parse");

    for (input, expected) in [
        (canonical_input.clone(), canonical_input.clone()),
        (transformed_input, transformed_expected),
    ] {
        let document = parse_project_value(input).expect("fixture must validate");
        let output = serde_json::to_value(document).expect("document must serialize");
        assert_eq!(output, expected);
    }

    for malformed_schema_version in [
        serde_json::json!("1"),
        serde_json::json!(1.5),
        serde_json::json!(0),
        serde_json::json!(-1),
    ] {
        let mut malformed = canonical_input.clone();
        malformed["schemaVersion"] = malformed_schema_version;
        assert_eq!(
            parse_project_value(malformed)
                .expect_err("malformed schema version must fail")
                .code,
            VideoErrorCode::InvalidProject
        );
    }

    let mut future = canonical_input;
    future["schemaVersion"] = serde_json::json!(2);
    assert_eq!(
        parse_project_value(future)
            .expect_err("future schema must be unsupported")
            .code,
        VideoErrorCode::UnsupportedSchema
    );
}

#[test]
fn grants_are_exact_isolated_normalized_and_revocable() {
    let directory = tempdir().expect("temporary directory must be created");
    let source = directory.path().join("source.mp4");
    fs::write(&source, b"video").expect("source must be written");
    let alias = directory.path().join(".").join("source.mp4");
    let grants = VideoPathGrants::default();

    let normalized = grants
        .grant_existing_file("main", GrantCategory::Source, &alias)
        .expect("source grant must succeed");
    assert_eq!(
        grants
            .authorize("main", GrantCategory::Source, &source)
            .expect("normalized alias must authorize"),
        normalized
    );
    assert_eq!(
        grants
            .authorize("other", GrantCategory::Source, &source)
            .expect_err("another window must not authorize")
            .code,
        VideoErrorCode::PathNotGranted
    );
    assert_eq!(
        grants
            .authorize("main", GrantCategory::Project, &source)
            .expect_err("another category must not authorize")
            .code,
        VideoErrorCode::PathNotGranted
    );
    assert_eq!(
        grants
            .grant_existing_file("main", GrantCategory::Project, &source)
            .expect_err("category collisions must fail")
            .code,
        VideoErrorCode::InvalidPath
    );

    grants
        .revoke_window("main")
        .expect("revocation must succeed");
    assert_eq!(
        grants
            .authorize("main", GrantCategory::Source, &source)
            .expect_err("revoked path must not authorize")
            .code,
        VideoErrorCode::PathNotGranted
    );
}

#[test]
fn bounded_reader_accepts_cap_and_rejects_larger_file() {
    let directory = tempdir().expect("temporary directory must be created");
    let at_cap = directory.path().join("at-cap.svpvideo");
    fs::write(&at_cap, vec![b' '; MAX_PROJECT_BYTES as usize])
        .expect("at-cap file must be written");
    assert_eq!(
        read_project_bounded(&at_cap)
            .expect("at-cap read must succeed")
            .len() as u64,
        MAX_PROJECT_BYTES
    );

    let over_cap = directory.path().join("over-cap.svpvideo");
    fs::write(&over_cap, vec![b' '; MAX_PROJECT_BYTES as usize + 1])
        .expect("over-cap file must be written");
    assert_eq!(
        read_project_bounded(&over_cap)
            .expect_err("over-cap read must fail")
            .code,
        VideoErrorCode::Phase1Limit
    );
}

#[test]
fn relative_source_resolves_and_receives_a_grant() {
    let directory = tempdir().expect("temporary directory must be created");
    let project_path = directory.path().join("project.svpvideo");
    let source_directory = directory.path().join("media");
    let source_path = source_directory.join("single-clip.mp4");
    fs::create_dir(&source_directory).expect("source directory must be created");
    fs::write(&source_path, b"video").expect("source must be written");

    for relative_path in ["media/single-clip.mp4", "media\\single-clip.mp4"] {
        let mut value = canonical_value();
        value["revisions"][0]["state"]["asset"]["locator"]["relativePath"] =
            Value::String(relative_path.to_owned());
        write_project(&project_path, &value);
        let grants = VideoPathGrants::default();

        let opened = open_project_from_path("main", &project_path, &grants)
            .expect("contained source project must open");
        assert_eq!(opened.sources.len(), 1);
        assert_eq!(opened.sources[0].status, VideoSourceStatus::Resolved);
        grants
            .authorize("main", GrantCategory::Source, &source_path)
            .expect("resolved source must be granted");
    }
}

#[test]
fn absent_and_ungranted_fallback_media_report_safe_statuses() {
    let directory = tempdir().expect("temporary directory must be created");
    let missing_project = directory.path().join("missing.svpvideo");
    fs::copy(canonical_fixture_path(), &missing_project).expect("project must be copied");
    let missing = open_project_from_path("missing", &missing_project, &VideoPathGrants::default())
        .expect("missing media does not invalidate a project");
    assert_eq!(missing.sources[0].status, VideoSourceStatus::Missing);

    let fallback = directory.path().join("fallback.mp4");
    fs::write(&fallback, b"video").expect("fallback must be written");
    let fallback_project = directory.path().join("fallback.svpvideo");
    let mut value = canonical_value();
    value["revisions"][0]["state"]["asset"]["locator"] = serde_json::json!({
        "relativePath": "absent.mp4",
        "absolutePath": fallback.to_string_lossy()
    });
    write_project(&fallback_project, &value);
    let grants = VideoPathGrants::default();
    let relink = open_project_from_path("main", &fallback_project, &grants)
        .expect("ungranted fallback project must open");
    assert_eq!(relink.sources[0].status, VideoSourceStatus::RelinkRequired);

    grants
        .grant_existing_file("granted", GrantCategory::Source, &fallback)
        .expect("fallback source must be granted independently");
    let resolved = open_project_from_path("granted", &fallback_project, &grants)
        .expect("granted fallback project must open");
    assert_eq!(resolved.sources[0].status, VideoSourceStatus::Resolved);
}

#[test]
fn canonical_source_containment_accepts_contained_path() {
    let directory = tempdir().expect("temporary directory must be created");
    let project_directory = directory.path().join("project");
    fs::create_dir(&project_directory).expect("project directory must be created");
    let source = project_directory.join("source.mp4");
    fs::write(&source, b"video").expect("contained source must be written");
    let canonical_project_directory =
        fs::canonicalize(project_directory).expect("project directory must canonicalize");
    let canonical_source = fs::canonicalize(source).expect("source must canonicalize");

    ensure_canonical_source_containment(&canonical_project_directory, &canonical_source)
        .expect("contained canonical source must be accepted");
}

#[test]
fn canonical_source_containment_rejects_outside_path() {
    let directory = tempdir().expect("temporary directory must be created");
    let project_directory = directory.path().join("project");
    let outside_directory = directory.path().join("outside");
    fs::create_dir(&project_directory).expect("project directory must be created");
    fs::create_dir(&outside_directory).expect("outside directory must be created");
    let outside_source = outside_directory.join("source.mp4");
    fs::write(&outside_source, b"video").expect("outside source must be written");
    let canonical_project_directory =
        fs::canonicalize(project_directory).expect("project directory must canonicalize");
    let canonical_source = fs::canonicalize(outside_source).expect("source must canonicalize");

    let error =
        ensure_canonical_source_containment(&canonical_project_directory, &canonical_source)
            .expect_err("outside canonical source must be rejected");
    assert_eq!(error.code, VideoErrorCode::InvalidPath);
    assert_eq!(error.details["operation"], "resolve_source");
    assert_eq!(error.details["category"], "containment");
}

#[test]
fn symlink_escape_is_rejected_when_platform_supports_symlinks() {
    let project_directory = tempdir().expect("project directory must be created");
    let outside_directory = tempdir().expect("outside directory must be created");
    let project_path = project_directory.path().join("escape.svpvideo");
    let outside_source = outside_directory.path().join("outside.mp4");
    let link = project_directory.path().join("single-clip.mp4");
    fs::copy(canonical_fixture_path(), &project_path).expect("project must be copied");
    fs::write(&outside_source, b"video").expect("outside source must be written");
    if let Err(error) = create_file_symlink(&outside_source, &link) {
        eprintln!(
            "SKIPPED symlink escape integration assertion: symlink setup unsupported: {error}"
        );
        return;
    }

    let error = open_project_from_path("main", &project_path, &VideoPathGrants::default())
        .expect_err("an escaping symlink must fail");
    assert_eq!(error.code, VideoErrorCode::InvalidPath);
    assert_eq!(error.details["operation"], "resolve_source");
    assert_eq!(error.details["category"], "containment");
    eprintln!("VERIFIED symlink escape rejected with invalid_path/containment");
}

#[cfg(unix)]
fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}

#[cfg(windows)]
fn create_file_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_file(source, link)
}

#[test]
fn successful_atomic_save_replaces_with_pretty_valid_json() {
    let directory = tempdir().expect("temporary directory must be created");
    let destination = directory.path().join("project.svpvideo");
    fs::write(&destination, b"old bytes").expect("old project must be written");
    let grants = VideoPathGrants::default();
    grants
        .grant_destination("main", GrantCategory::Project, &destination)
        .expect("destination must be granted");

    save_project_to_path("main", &destination, &canonical_document(), &grants)
        .expect("save must succeed");
    let bytes = fs::read(&destination).expect("saved project must be readable");
    assert!(bytes.ends_with(b"\n"));
    assert!(bytes.starts_with(b"{\n  \"schemaVersion\""));
    parse_project_json(&bytes).expect("saved project must remain valid");
}

#[test]
fn validation_and_promotion_failures_preserve_old_bytes_and_clean_temp_files() {
    let directory = tempdir().expect("temporary directory must be created");
    let destination = directory.path().join("project.svpvideo");
    let old_bytes = b"old project bytes";
    fs::write(&destination, old_bytes).expect("old project must be written");
    let grants = VideoPathGrants::default();
    grants
        .grant_destination("main", GrantCategory::Project, &destination)
        .expect("destination must be granted");

    let mut invalid = canonical_document();
    invalid.name = "   ".to_owned();
    assert_eq!(
        save_project_to_path("main", &destination, &invalid, &grants)
            .expect_err("invalid save must fail")
            .code,
        VideoErrorCode::InvalidProject
    );
    assert_eq!(
        fs::read(&destination).expect("old project must remain"),
        old_bytes
    );

    let entries_before = fs::read_dir(directory.path())
        .expect("directory must be readable")
        .count();
    let result = atomic_save_with(&destination, b"new bytes", |temporary, _| {
        drop(temporary);
        Err(VideoCommandError::project_io(
            "save_project",
            "injected_promote",
        ))
    });
    assert_eq!(
        result.expect_err("injected promotion must fail").code,
        VideoErrorCode::ProjectIo
    );
    assert_eq!(
        fs::read(&destination).expect("old project must remain"),
        old_bytes
    );
    assert_eq!(
        fs::read_dir(directory.path())
            .expect("directory must be readable")
            .count(),
        entries_before,
        "temporary file must be cleaned"
    );
}

#[test]
fn oversized_serialized_document_is_rejected_before_writing() {
    let directory = tempdir().expect("temporary directory must be created");
    let destination = directory.path().join("large.svpvideo");
    fs::write(&destination, b"old bytes").expect("old project must be written");
    let grants = VideoPathGrants::default();
    grants
        .grant_destination("main", GrantCategory::Project, &destination)
        .expect("destination must be granted");

    let mut value = canonical_value();
    let template = value["revisions"][0].clone();
    let mut revisions = Vec::with_capacity(10_000);
    let mut previous_id: Option<String> = None;
    for index in 0..10_000_u64 {
        let id = format!("00000000-0000-4000-8000-{index:012x}");
        let mut revision = template.clone();
        revision["id"] = Value::String(id.clone());
        revision["parentRevisionId"] = previous_id
            .as_ref()
            .map_or(Value::Null, |parent| Value::String(parent.clone()));
        revision["sequenceNumber"] = Value::from(index);
        revisions.push(revision);
        previous_id = Some(id);
    }
    value["currentRevisionId"] = Value::String(previous_id.expect("revision id must exist"));
    value["revisions"] = Value::Array(revisions);
    let document = parse_project_value(value).expect("large document must be structurally valid");

    assert_eq!(
        save_project_to_path("main", &destination, &document, &grants)
            .expect_err("oversized save must fail")
            .code,
        VideoErrorCode::Phase1Limit
    );
    assert_eq!(
        fs::read(&destination).expect("old project must remain"),
        b"old bytes"
    );
}

#[test]
fn cancellation_and_default_name_helpers_are_safe() {
    assert_eq!(
        dialog_path(None, "pick_source", "source").expect("cancellation is successful"),
        None
    );
    assert_eq!(
        sanitize_default_name("  movie.mov  ", "mp4", "export.mp4")
            .expect("safe name must normalize"),
        "movie.mp4"
    );
    assert_eq!(
        sanitize_default_name("../escape", "mp4", "export.mp4")
            .expect_err("path-like names must fail")
            .code,
        VideoErrorCode::InvalidPath
    );
    for path in [
        r"\\server\share\clip.mp4",
        r"//server/share/clip.mp4",
        r"\/server/share/clip.mp4",
        r"/\server\share\clip.mp4",
    ] {
        assert!(
            is_recognizable_absolute_path(path),
            "UNC path must be recognized: {path}"
        );
    }
}

#[test]
fn named_temp_file_type_remains_same_directory_capable() {
    let directory = tempdir().expect("temporary directory must be created");
    let temporary = NamedTempFile::new_in(directory.path()).expect("temp file must be created");
    assert_eq!(temporary.path().parent(), Some(directory.path()));
}
