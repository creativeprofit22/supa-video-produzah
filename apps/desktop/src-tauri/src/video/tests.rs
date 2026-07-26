use std::{
    cell::Cell,
    env,
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, UNIX_EPOCH},
};

use serde::Deserialize;
use serde_json::Value;
use tempfile::{tempdir, NamedTempFile};

use super::{
    derived::{
        acquire_profile_cache_lock_with, artifact_paths, artifact_paths_in_validated_cache,
        cache_pair_is_valid_with, create_temp_artifacts, duration_within_one_frame,
        ensure_profile_cache_directory, fit_proxy_dimensions, fit_proxy_dimensions_for_display,
        map_cache_error, one_frame_tolerance_microseconds, prepare_asset_core,
        promote_validated_pair, promote_validated_pair_with, proxy_ffmpeg_args, run_derived_ffmpeg,
        source_fingerprint, source_fingerprint_with_profile, thumbnail_ffmpeg_args,
        unix_time_parts, validate_proxy_artifact, validate_thumbnail_artifact, ArtifactFileFacts,
        ArtifactValidationError, CacheLifecycleError, DerivedArtifactPaths, DerivedModelError,
        MediaPrograms, OutputDimensions, PrepareAssetCoreRequest, SourceIdentity,
        ValidatedDerivedInput, PREVIEW_PROFILE,
    },
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
    probe::{
        parse_ffprobe_json, parse_ffprobe_json_inspected, parse_tool_banner,
        probe_media_with_program, probe_trusted_media_with_program, tool_info_from_result,
        video_ffmpeg_status_with_programs, InspectedMedia, VideoTool,
    },
    process::{
        run_supervised, run_supervised_streaming_with_test_environment,
        run_supervised_with_test_environment, ProcessCancellation, ProcessFailure, ProcessSpec,
        StdoutRecordObserver, SupervisedOutput,
    },
    project_io::{
        atomic_save_with, dialog_path, ensure_canonical_source_containment, open_project_from_path,
        read_project_bounded, regrant_project_source_from_path, sanitize_default_name,
        save_project_to_path, VideoSourceStatus, MAX_PROJECT_BYTES,
    },
    render::{
        create_owned_partial, ensure_preview_directory, parse_and_validate_render_plan,
        partial_render_path, promote_render_partial, render_execution_arguments, run_render_worker,
        validate_render_output, RenderEventSink, RenderProgress, RenderWorkerRequest,
        VideoRenderJobs,
    },
    types::{
        is_recognizable_absolute_path, parse_project_json, parse_project_value, MediaAudioShape,
        MediaColorMetadata, MediaDisplayShape, MediaProbe, RationalRate, VideoProjectFileV1,
        VideoRenderEvent, VideoToolProblem,
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
fn source_regrant_accepts_only_the_current_assets_exact_absolute_fallback() {
    let directory = tempdir().expect("temporary directory must be created");
    let project_path = directory.path().join("external.svpvideo");
    let expected_source = directory.path().join("expected.mp4");
    let wrong_source = directory.path().join("wrong.mp4");
    fs::write(&expected_source, b"expected video").expect("expected source must be written");
    fs::write(&wrong_source, b"wrong video").expect("wrong source must be written");

    let mut value = canonical_value();
    value["revisions"][0]["state"]["asset"]["locator"] = serde_json::json!({
        "absolutePath": expected_source.to_string_lossy()
    });
    write_project(&project_path, &value);
    let document = parse_project_value(value).expect("regrant fixture must validate");
    let asset_id = document.revisions[0]
        .state
        .asset
        .as_ref()
        .expect("fixture asset must exist")
        .id
        .clone();
    let grants = VideoPathGrants::default();
    grants
        .grant_existing_file("main", GrantCategory::Project, &project_path)
        .expect("opened project grant must exist");

    let mismatch =
        regrant_project_source_from_path("main", &project_path, &asset_id, &wrong_source, &grants)
            .expect_err("a different selected source must be rejected");
    assert_eq!(mismatch.code, VideoErrorCode::InvalidPath);
    assert_eq!(mismatch.details["operation"], "regrant_project_source");
    assert_eq!(mismatch.details["category"], "source_mismatch");
    assert_eq!(
        grants
            .authorize("main", GrantCategory::Source, &wrong_source)
            .expect_err("mismatched source must not receive a grant")
            .code,
        VideoErrorCode::PathNotGranted
    );

    let resolved = regrant_project_source_from_path(
        "main",
        &project_path,
        &asset_id,
        &expected_source,
        &grants,
    )
    .expect("the exact source fallback must be regranted");
    assert_eq!(resolved.asset_id, asset_id);
    assert_eq!(resolved.status, VideoSourceStatus::Resolved);
    assert_eq!(
        resolved.resolved_path.as_deref(),
        expected_source
            .canonicalize()
            .expect("expected source must canonicalize")
            .to_str()
    );
    grants
        .authorize("main", GrantCategory::Source, &expected_source)
        .expect("the exact source must be granted");
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

#[cfg(unix)]
fn create_directory_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(source, link)
}

#[cfg(windows)]
fn create_directory_symlink(source: &Path, link: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(source, link)
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

const DERIVED_PROJECT_ID: &str = "11111111-1111-4111-8111-111111111111";
const DERIVED_ASSET_ID: &str = "22222222-2222-4222-8222-222222222222";

fn derived_rate() -> RationalRate {
    RationalRate {
        numerator: 30_000,
        denominator: 1_001,
    }
}

fn derived_identity(path: &Path) -> SourceIdentity<'_> {
    SourceIdentity {
        canonical_path: path,
        file_size_bytes: 129_211,
        modified_unix_seconds: 1_700_000_000,
        modified_nanoseconds: 123_456_789,
    }
}

fn display_shape(
    sample_numerator: u64,
    sample_denominator: u64,
    display_numerator: u64,
    display_denominator: u64,
    rotation_degrees: u16,
) -> MediaDisplayShape {
    MediaDisplayShape::checked(
        RationalRate::checked_reduced(sample_numerator, sample_denominator)
            .expect("test sample aspect ratio must be valid"),
        RationalRate::checked_reduced(display_numerator, display_denominator)
            .expect("test display aspect ratio must be valid"),
        rotation_degrees,
    )
    .expect("test display shape must be valid")
}

fn expected_ffmpeg_prefix(source: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i"]
        .into_iter()
        .map(OsString::from)
        .collect();
    args.push(source.as_os_str().to_owned());
    args
}

fn extend_os_tokens(args: &mut Vec<OsString>, tokens: &[&str]) {
    args.extend(tokens.iter().map(OsString::from));
}

#[test]
fn derived_identity_validation_rejects_malicious_ids_and_non_reduced_rates() {
    let uppercase_project = DERIVED_PROJECT_ID.to_ascii_uppercase();
    let input = ValidatedDerivedInput::new(&uppercase_project, DERIVED_ASSET_ID, derived_rate())
        .expect("canonical uppercase UUID text must normalize safely");
    assert_eq!(input.project_segment, DERIVED_PROJECT_ID);
    assert_eq!(input.asset_segment, DERIVED_ASSET_ID);

    for malicious in [
        "../11111111-1111-4111-8111-111111111111",
        "11111111-1111-4111-8111-111111111111/escape",
        r"11111111-1111-4111-8111-111111111111\escape",
        "11111111111141118111111111111111",
        "11111111-1111-9111-8111-111111111111",
        "11111111-1111-4111-c111-111111111111",
        "",
    ] {
        assert_eq!(
            ValidatedDerivedInput::new(malicious, DERIVED_ASSET_ID, derived_rate()),
            Err(DerivedModelError::ProjectId),
            "malicious project ID must fail: {malicious:?}"
        );
        assert_eq!(
            ValidatedDerivedInput::new(DERIVED_PROJECT_ID, malicious, derived_rate()),
            Err(DerivedModelError::AssetId),
            "malicious asset ID must fail: {malicious:?}"
        );
    }

    for invalid_rate in [
        RationalRate {
            numerator: 0,
            denominator: 1,
        },
        RationalRate {
            numerator: 1,
            denominator: 0,
        },
        RationalRate {
            numerator: 60,
            denominator: 2,
        },
        RationalRate {
            numerator: 9_007_199_254_740_992,
            denominator: 1,
        },
    ] {
        assert_eq!(
            ValidatedDerivedInput::new(DERIVED_PROJECT_ID, DERIVED_ASSET_ID, invalid_rate),
            Err(DerivedModelError::SequenceRate)
        );
    }
}

#[test]
fn derived_unix_time_parts_preserve_pre_epoch_timestamps() {
    assert_eq!(unix_time_parts(UNIX_EPOCH), Some((0, 0)));
    assert_eq!(
        unix_time_parts(UNIX_EPOCH + Duration::new(1, 250_000_000)),
        Some((1, 250_000_000))
    );
    assert_eq!(
        unix_time_parts(UNIX_EPOCH - Duration::new(1, 250_000_000)),
        Some((-2, 750_000_000))
    );
    assert_eq!(
        unix_time_parts(UNIX_EPOCH - Duration::from_secs(1)),
        Some((-1, 0))
    );
}

#[test]
fn derived_geometry_fits_landscape_portrait_odd_and_tiny_sources_without_upscaling() {
    assert_eq!(
        fit_proxy_dimensions(1_920, 1_080).expect("landscape dimensions must fit"),
        OutputDimensions {
            width: 1_280,
            height: 720
        }
    );
    assert_eq!(
        fit_proxy_dimensions(1_080, 1_920).expect("portrait dimensions must fit"),
        OutputDimensions {
            width: 404,
            height: 720
        }
    );
    assert_eq!(
        fit_proxy_dimensions(2_560, 1_080).expect("wide dimensions must fit"),
        OutputDimensions {
            width: 1_280,
            height: 540
        }
    );
    assert_eq!(
        fit_proxy_dimensions(640, 360).expect("small dimensions must not upscale"),
        OutputDimensions {
            width: 640,
            height: 360
        }
    );
    assert_eq!(
        fit_proxy_dimensions(321, 181).expect("odd dimensions must round down"),
        OutputDimensions {
            width: 320,
            height: 180
        }
    );
    assert_eq!(
        fit_proxy_dimensions(3, 3).expect("small viable dimensions must remain viable"),
        OutputDimensions {
            width: 2,
            height: 2
        }
    );
    for (width, height) in [(0, 10), (10, 0), (1, 100), (100, 1)] {
        assert_eq!(
            fit_proxy_dimensions(width, height),
            Err(DerivedModelError::Dimensions)
        );
    }
}

#[test]
fn derived_geometry_uses_rotation_and_pixel_aspect_for_display_correct_outputs() {
    assert_eq!(
        fit_proxy_dimensions_for_display(1_920, 1_080, &display_shape(1, 1, 16, 9, 90))
            .expect("rotated source dimensions must fit"),
        OutputDimensions {
            width: 404,
            height: 720,
        }
    );
    assert_eq!(
        fit_proxy_dimensions_for_display(720, 576, &display_shape(16, 15, 4, 3, 0))
            .expect("anamorphic source dimensions must fit"),
        OutputDimensions {
            width: 720,
            height: 540,
        }
    );
    assert_eq!(
        fit_proxy_dimensions_for_display(720, 576, &display_shape(16, 15, 4, 3, 270))
            .expect("rotated anamorphic source dimensions must fit"),
        OutputDimensions {
            width: 540,
            height: 720,
        }
    );
    assert_eq!(
        fit_proxy_dimensions_for_display(720, 576, &display_shape(16, 15, 4, 3, 180))
            .expect("half-turn source dimensions must fit"),
        OutputDimensions {
            width: 720,
            height: 540,
        }
    );
}

#[test]
fn derived_fingerprint_is_stable_and_invalidates_on_every_identity_and_profile_input() {
    let directory = tempdir().expect("temporary root must be created");
    let source = directory.path().join("source clip.mp4");
    let other_source = directory.path().join("other clip.mp4");
    let identity = derived_identity(&source);
    let rate = derived_rate();
    let baseline = source_fingerprint(&identity, &rate).expect("fingerprint must be created");
    assert_eq!(baseline.len(), 64);
    assert!(baseline
        .bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)));
    assert_eq!(
        source_fingerprint(&identity, &rate).expect("fingerprint must be deterministic"),
        baseline
    );

    for changed_identity in [
        SourceIdentity {
            canonical_path: &other_source,
            ..identity.clone()
        },
        SourceIdentity {
            file_size_bytes: identity.file_size_bytes + 1,
            ..identity.clone()
        },
        SourceIdentity {
            modified_unix_seconds: identity.modified_unix_seconds + 1,
            ..identity.clone()
        },
        SourceIdentity {
            modified_nanoseconds: identity.modified_nanoseconds + 1,
            ..identity.clone()
        },
    ] {
        assert_ne!(
            source_fingerprint(&changed_identity, &rate).expect("changed identity must hash"),
            baseline
        );
    }
    for changed_rate in [
        RationalRate {
            numerator: 24_000,
            denominator: 1_001,
        },
        RationalRate {
            numerator: 30_000,
            denominator: 1_003,
        },
    ] {
        assert_ne!(
            source_fingerprint(&identity, &changed_rate).expect("changed rate must hash"),
            baseline
        );
    }

    macro_rules! assert_profile_field_is_hashed {
        ($field:ident, $changed:expr) => {{
            let mut profile = PREVIEW_PROFILE;
            profile.$field = $changed;
            assert_ne!(
                source_fingerprint_with_profile(&identity, &rate, &profile)
                    .expect("changed profile must hash"),
                baseline,
                "profile field was omitted from fingerprint: {}",
                stringify!($field)
            );
        }};
    }
    assert_profile_field_is_hashed!(directory_name, "preview-v2");
    assert_profile_field_is_hashed!(proxy_max_width, 1_278);
    assert_profile_field_is_hashed!(proxy_max_height, 718);
    assert_profile_field_is_hashed!(scale_flags, "bicubic");
    assert_profile_field_is_hashed!(proxy_video_encoder, "h264");
    assert_profile_field_is_hashed!(proxy_video_encoder_color_range, "full");
    assert_profile_field_is_hashed!(proxy_preset, "fast");
    assert_profile_field_is_hashed!(proxy_crf, 22);
    assert_profile_field_is_hashed!(proxy_pixel_format, "yuv422p");
    assert_profile_field_is_hashed!(proxy_sample_aspect_ratio, "4/3");
    assert_profile_field_is_hashed!(proxy_color_range, "pc");
    assert_profile_field_is_hashed!(proxy_color_space, "smpte170m");
    assert_profile_field_is_hashed!(proxy_color_primaries, "smpte170m");
    assert_profile_field_is_hashed!(proxy_color_transfer, "smpte170m");
    assert_profile_field_is_hashed!(proxy_hdr_linear_transfer, "bt709");
    assert_profile_field_is_hashed!(proxy_hdr_nominal_peak_luminance, "203");
    assert_profile_field_is_hashed!(proxy_hdr_intermediate_pixel_format, "gbrp16le");
    assert_profile_field_is_hashed!(proxy_hdr_tonemap, "mobius");
    assert_profile_field_is_hashed!(proxy_hdr_tonemap_desaturation, "1");
    assert_profile_field_is_hashed!(proxy_hdr_signal_peak, "4");
    assert_profile_field_is_hashed!(proxy_hdr_dither, "ordered");
    assert_profile_field_is_hashed!(proxy_movflags, "empty_moov");
    assert_profile_field_is_hashed!(proxy_audio_encoder, "pcm_s16le");
    assert_profile_field_is_hashed!(proxy_audio_bitrate, "128k");
    assert_profile_field_is_hashed!(proxy_audio_sample_rate, 44_100);
    assert_profile_field_is_hashed!(thumbnail_count, 9);
    assert_profile_field_is_hashed!(thumbnail_cell_width, 158);
    assert_profile_field_is_hashed!(thumbnail_cell_height, 88);
    assert_profile_field_is_hashed!(thumbnail_pad_color, "white");
    assert_profile_field_is_hashed!(thumbnail_tile_layout, "5x2");
    assert_profile_field_is_hashed!(thumbnail_encoder, "png");
    assert_profile_field_is_hashed!(thumbnail_quality, 3);

    let relative = Path::new("relative/source.mp4");
    assert_eq!(
        source_fingerprint(&derived_identity(relative), &rate),
        Err(DerivedModelError::SourceIdentity)
    );
    let invalid_timestamp = SourceIdentity {
        modified_nanoseconds: 1_000_000_000,
        ..identity
    };
    assert_eq!(
        source_fingerprint(&invalid_timestamp, &rate),
        Err(DerivedModelError::SourceIdentity)
    );
}

#[test]
fn derived_artifact_paths_are_safe_descendants_with_owned_names() {
    let directory = tempdir().expect("temporary cache root must be created");
    let input = ValidatedDerivedInput::new(DERIVED_PROJECT_ID, DERIVED_ASSET_ID, derived_rate())
        .expect("derived input must validate");
    let fingerprint = "a".repeat(64);
    let paths = artifact_paths(directory.path(), &input, &fingerprint)
        .expect("artifact paths must be built");
    let expected_directory = directory
        .path()
        .join("video-phase1")
        .join(DERIVED_PROJECT_ID)
        .join(DERIVED_ASSET_ID)
        .join("preview-v1");
    assert_eq!(paths.profile_directory, expected_directory);
    assert_eq!(
        paths.proxy_path,
        expected_directory.join(format!("proxy-{fingerprint}.mp4"))
    );
    assert_eq!(
        paths.thumbnail_path,
        expected_directory.join(format!("thumbnail-{fingerprint}.jpg"))
    );
    assert!(paths.profile_directory.starts_with(directory.path()));
    assert!(paths.proxy_path.starts_with(directory.path()));
    assert!(paths.thumbnail_path.starts_with(directory.path()));

    for unsafe_fingerprint in [
        "a",
        "../escape",
        &"A".repeat(64),
        &format!("{}g", "a".repeat(63)),
    ] {
        assert_eq!(
            artifact_paths(directory.path(), &input, unsafe_fingerprint),
            Err(DerivedModelError::Fingerprint)
        );
    }
}

#[test]
fn derived_duration_tolerance_is_exactly_one_ceil_frame() {
    let rate = derived_rate();
    assert_eq!(
        one_frame_tolerance_microseconds(&rate).expect("frame tolerance must compute"),
        33_367
    );
    assert!(duration_within_one_frame(2_000_000, 2_033_367, &rate)
        .expect("valid durations must compare"));
    assert!(!duration_within_one_frame(2_000_000, 2_033_368, &rate)
        .expect("valid durations must compare"));
    assert_eq!(
        duration_within_one_frame(0, 1, &rate),
        Err(DerivedModelError::Duration)
    );
}

#[test]
fn derived_proxy_argv_is_exact_for_audio_and_video_only_sources() {
    let source = PathBuf::from("source folder/input; private.mp4");
    let destination = PathBuf::from("cache folder/proxy temp.mp4");
    let dimensions = OutputDimensions {
        width: 1_280,
        height: 720,
    };
    let rate = derived_rate();

    let mut expected_av = expected_ffmpeg_prefix(&source);
    extend_os_tokens(
        &mut expected_av,
        &[
            "-map",
            "0:3",
            "-map",
            "0:7",
            "-vf",
            "scale=1280:720:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,fps=30000/1001",
            "-c:v",
            "libx264",
            "-x264-params",
            "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-ar",
            "48000",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ],
    );
    expected_av.push(destination.as_os_str().to_owned());
    assert_eq!(
        proxy_ffmpeg_args(&source, &destination, dimensions, &rate, false, 3, Some(7))
            .expect("AV proxy argv must build"),
        expected_av
    );

    let mut expected_video_only = expected_ffmpeg_prefix(&source);
    extend_os_tokens(
        &mut expected_video_only,
        &[
            "-map",
            "0:3",
            "-vf",
            "scale=1280:720:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,fps=30000/1001",
            "-c:v",
            "libx264",
            "-x264-params",
            "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=limited",
            "-preset",
            "medium",
            "-crf",
            "23",
            "-pix_fmt",
            "yuv420p",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-an",
            "-movflags",
            "+faststart",
            "-f",
            "mp4",
        ],
    );
    expected_video_only.push(destination.as_os_str().to_owned());
    assert_eq!(
        proxy_ffmpeg_args(&source, &destination, dimensions, &rate, false, 3, None)
            .expect("video-only proxy argv must build"),
        expected_video_only
    );

    let hdr = proxy_ffmpeg_args(&source, &destination, dimensions, &rate, true, 3, None)
        .expect("HDR proxy argv must build");
    let filter_index = hdr
        .iter()
        .position(|token| token == "-vf")
        .expect("HDR argv must contain a video filter");
    assert_eq!(
        hdr[filter_index + 1],
        "zscale=transfer=linear:npl=100,format=gbrpf32le,tonemap=tonemap=hable:desat=2:peak=10,zscale=primaries=bt709:transfer=bt709:matrix=bt709:range=tv:dither=error_diffusion,scale=1280:720:flags=lanczos:out_color_matrix=bt709:out_range=tv,setsar=1,fps=30000/1001"
    );
}

#[test]
fn derived_thumbnail_argv_is_one_exact_ten_frame_tile_plan() {
    let source = PathBuf::from("source folder/input; private.mp4");
    let destination = PathBuf::from("cache folder/thumbnail temp.jpg");
    let mut expected = expected_ffmpeg_prefix(&source);
    extend_os_tokens(
        &mut expected,
        &[
            "-map",
            "0:3",
            "-vf",
            "fps=10000000/2000000:round=down:start_time=0,scale=160:90:force_original_aspect_ratio=decrease:reset_sar=1:flags=lanczos,pad=160:90:(ow-iw)/2:(oh-ih)/2:color=black,tile=10x1",
            "-frames:v",
            "1",
            "-c:v",
            "mjpeg",
            "-q:v",
            "2",
            "-f",
            "image2",
        ],
    );
    expected.push(destination.as_os_str().to_owned());
    assert_eq!(
        thumbnail_ffmpeg_args(&source, &destination, 2_000_000, 3)
            .expect("thumbnail argv must build"),
        expected
    );
    assert_eq!(
        thumbnail_ffmpeg_args(&source, &destination, 0, 3),
        Err(DerivedModelError::Duration)
    );
}

fn derived_valid_inspected(source_has_audio: bool) -> InspectedMedia {
    InspectedMedia {
        probe: MediaProbe {
            duration_microseconds: 2_000_000,
            average_frame_rate: derived_rate(),
            real_frame_rate: derived_rate(),
            variable_frame_rate: false,
            width: 1_280,
            height: 720,
            video_codec_name: "h264".to_owned(),
            audio: source_has_audio.then(|| MediaAudioShape {
                codec_name: "aac".to_owned(),
                channels: 2,
                sample_rate: 48_000,
            }),
            file_size_bytes: 4_096,
        },
        video_stream_index: 0,
        audio_stream_index: source_has_audio.then_some(1),
        pixel_format: Some("yuv420p".to_owned()),
        color: MediaColorMetadata {
            color_range: Some("tv".to_owned()),
            color_space: Some("bt709".to_owned()),
            color_primaries: Some("bt709".to_owned()),
            color_transfer: Some("bt709".to_owned()),
        },
        display_shape: display_shape(1, 1, 16, 9, 0),
    }
}

fn derived_valid_file_facts() -> ArtifactFileFacts {
    ArtifactFileFacts {
        is_regular_file: true,
        byte_len: 4_096,
    }
}

fn derived_expected_dimensions() -> OutputDimensions {
    OutputDimensions {
        width: 1_280,
        height: 720,
    }
}

#[test]
fn derived_probe_parser_exposes_pixel_format_without_changing_public_media_probe() {
    let json = br#"{
        "streams": [
            {
                "index": 0,
                "codec_type": "video",
                "disposition": { "attached_pic": 1 }
            },
            {
                "index": 3,
                "codec_type": "video",
                "codec_name": "h264",
                "pix_fmt": "yuv420p",
                "color_range": "tv",
                "color_space": "bt709",
                "color_primaries": "bt709",
                "color_transfer": "bt709",
                "width": 1280,
                "height": 720,
                "avg_frame_rate": "30000/1001",
                "r_frame_rate": "30000/1001",
                "disposition": { "attached_pic": 0 }
            },
            {
                "index": 7,
                "codec_type": "audio",
                "codec_name": "aac",
                "sample_rate": "48000",
                "channels": 2
            }
        ],
        "format": { "duration": "2.000000", "size": "4096" }
    }"#;
    let inspected =
        parse_ffprobe_json_inspected(json, 4_096).expect("derived ffprobe metadata must parse");
    let public = parse_ffprobe_json(json, 4_096).expect("public ffprobe metadata must still parse");
    assert_eq!(inspected.video_stream_index, 3);
    assert_eq!(inspected.audio_stream_index, Some(7));
    assert_eq!(inspected.pixel_format.as_deref(), Some("yuv420p"));
    assert_eq!(
        inspected.color,
        MediaColorMetadata {
            color_range: Some("tv".to_owned()),
            color_space: Some("bt709".to_owned()),
            color_primaries: Some("bt709".to_owned()),
            color_transfer: Some("bt709".to_owned()),
        }
    );
    assert!(!inspected.color.is_hdr());
    assert_eq!(inspected.display_shape, display_shape(1, 1, 16, 9, 0));
    assert_eq!(public, inspected.probe);
    let public_json = serde_json::to_value(&public).expect("public probe must serialize");
    assert_eq!(
        public_json
            .as_object()
            .expect("probe must be an object")
            .len(),
        9
    );
    assert!(public_json.get("rotationDegrees").is_none());
    assert!(public_json.get("sampleAspectRatio").is_none());
    assert!(public_json.get("displayAspectRatio").is_none());

    let legacy_fixture = parse_ffprobe_json_inspected(&ffprobe_fixture("av.json"), 129_211)
        .expect("existing source fixture without pixel format must remain valid");
    assert_eq!(legacy_fixture.video_stream_index, 0);
    assert_eq!(legacy_fixture.audio_stream_index, Some(1));
    assert_eq!(legacy_fixture.pixel_format, None);
    assert_eq!(legacy_fixture.color, MediaColorMetadata::default());
    assert!(!legacy_fixture.color.is_hdr());
    assert_eq!(legacy_fixture.display_shape, display_shape(1, 1, 16, 9, 0));
}

#[test]
fn derived_probe_parser_retains_color_metadata_and_classifies_hdr_by_transfer() {
    let pq_json = br#"{
        "streams": [{
            "codec_type": "video",
            "codec_name": "hevc",
            "pix_fmt": "yuv420p10le",
            "color_range": "tv",
            "color_space": "bt2020nc",
            "color_primaries": "bt2020",
            "color_transfer": "smpte2084",
            "width": 3840,
            "height": 2160,
            "avg_frame_rate": "24/1",
            "r_frame_rate": "24/1",
            "disposition": { "attached_pic": 0 }
        }],
        "format": { "duration": "1.000000", "size": "4096" }
    }"#;
    let pq = parse_ffprobe_json_inspected(pq_json, 4_096).expect("PQ metadata must parse");
    assert_eq!(pq.color.color_range.as_deref(), Some("tv"));
    assert_eq!(pq.color.color_space.as_deref(), Some("bt2020nc"));
    assert_eq!(pq.color.color_primaries.as_deref(), Some("bt2020"));
    assert_eq!(pq.color.color_transfer.as_deref(), Some("smpte2084"));
    assert!(pq.color.is_hdr());

    let hlg_json = String::from_utf8(pq_json.to_vec())
        .expect("test JSON must be UTF-8")
        .replace("smpte2084", "arib-std-b67");
    let hlg =
        parse_ffprobe_json_inspected(hlg_json.as_bytes(), 4_096).expect("HLG metadata must parse");
    assert!(hlg.color.is_hdr());

    let wide_gamut_sdr_json = String::from_utf8(pq_json.to_vec())
        .expect("test JSON must be UTF-8")
        .replace("smpte2084", "bt2020-10");
    let wide_gamut_sdr = parse_ffprobe_json_inspected(wide_gamut_sdr_json.as_bytes(), 4_096)
        .expect("wide-gamut SDR metadata must parse");
    assert!(!wide_gamut_sdr.color.is_hdr());
}

#[test]
fn derived_probe_parser_reads_anamorphic_ratios_and_normalizes_rotation() {
    let json = br#"{
        "streams": [{
            "codec_type": "video",
            "codec_name": "h264",
            "pix_fmt": "yuv420p",
            "width": 720,
            "height": 576,
            "sample_aspect_ratio": "16:15",
            "display_aspect_ratio": "4:3",
            "avg_frame_rate": "25/1",
            "r_frame_rate": "25/1",
            "disposition": { "attached_pic": 0 },
            "tags": { "rotate": "180" },
            "side_data_list": [{ "rotation": -90 }]
        }],
        "format": { "duration": "1.000000", "size": "4096" }
    }"#;
    let inspected =
        parse_ffprobe_json_inspected(json, 4_096).expect("anamorphic rotated metadata must parse");
    assert_eq!(inspected.probe.width, 720);
    assert_eq!(inspected.probe.height, 576);
    assert_eq!(inspected.display_shape, display_shape(16, 15, 4, 3, 270));

    let tag_only = String::from_utf8(json.to_vec())
        .expect("test JSON must be UTF-8")
        .replace("[{ \"rotation\": -90 }]", "[]");
    let tag_inspected = parse_ffprobe_json_inspected(tag_only.as_bytes(), 4_096)
        .expect("legacy rotate tag must parse");
    assert_eq!(
        tag_inspected.display_shape,
        display_shape(16, 15, 4, 3, 180)
    );

    let mismatched_dar = String::from_utf8(json.to_vec())
        .expect("test JSON must be UTF-8")
        .replace("\"4:3\"", "\"16:9\"");
    assert!(parse_ffprobe_json(mismatched_dar.as_bytes(), 4_096).is_err());
    let invalid_rotation = String::from_utf8(json.to_vec())
        .expect("test JSON must be UTF-8")
        .replace("-90", "45");
    assert!(parse_ffprobe_json(invalid_rotation.as_bytes(), 4_096).is_err());
}

#[test]
fn derived_proxy_validator_accepts_only_the_controlled_video_shape() {
    let valid = derived_valid_inspected(true);
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &valid,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Ok(())
    );

    let mut wrong_codec = valid.clone();
    wrong_codec.probe.video_codec_name = "hevc".to_owned();
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_codec,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::VideoCodec)
    );

    let mut wrong_dimensions = valid.clone();
    wrong_dimensions.probe.width = 1_278;
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_dimensions,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::Dimensions)
    );
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &valid,
            OutputDimensions {
                width: 1_282,
                height: 720,
            },
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::Dimensions)
    );

    let mut wrong_pixel_format = valid.clone();
    wrong_pixel_format.pixel_format = Some("yuv422p".to_owned());
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_pixel_format,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::PixelFormat)
    );
    let mut missing_pixel_format = valid.clone();
    missing_pixel_format.pixel_format = None;
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &missing_pixel_format,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::PixelFormat)
    );

    let mut wrong_color = valid.clone();
    wrong_color.color.color_transfer = Some("smpte2084".to_owned());
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_color,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::ColorMetadata)
    );
    let mut missing_color = valid.clone();
    missing_color.color.color_range = None;
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &missing_color,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::ColorMetadata)
    );
}

#[test]
fn derived_proxy_validator_compares_display_dimensions_not_coded_dimensions() {
    let mut anamorphic = derived_valid_inspected(true);
    anamorphic.probe.width = 960;
    anamorphic.probe.height = 720;
    anamorphic.display_shape = display_shape(4, 3, 16, 9, 0);
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &anamorphic,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Ok(())
    );

    let mut rotated = derived_valid_inspected(true);
    rotated.probe.width = 720;
    rotated.probe.height = 1_280;
    rotated.display_shape = display_shape(1, 1, 9, 16, 90);
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &rotated,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Ok(())
    );

    rotated.display_shape = display_shape(1, 1, 9, 16, 0);
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &rotated,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::Dimensions)
    );
}

#[test]
fn derived_proxy_validator_rejects_rate_vfr_audio_and_duration_mismatches() {
    let valid = derived_valid_inspected(true);

    let mut wrong_average_rate = valid.clone();
    wrong_average_rate.probe.average_frame_rate = RationalRate {
        numerator: 24,
        denominator: 1,
    };
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_average_rate,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::FrameRate)
    );
    let mut wrong_real_rate = valid.clone();
    wrong_real_rate.probe.real_frame_rate = RationalRate {
        numerator: 24,
        denominator: 1,
    };
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_real_rate,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::FrameRate)
    );

    let mut vfr = valid.clone();
    vfr.probe.variable_frame_rate = true;
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &vfr,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::VariableFrameRate)
    );

    let mut wrong_audio = valid.clone();
    wrong_audio
        .probe
        .audio
        .as_mut()
        .expect("audio exists")
        .codec_name = "mp3".to_owned();
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_audio,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::Audio)
    );
    let mut wrong_audio_rate = valid.clone();
    wrong_audio_rate
        .probe
        .audio
        .as_mut()
        .expect("audio exists")
        .sample_rate = 44_100;
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &wrong_audio_rate,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::Audio)
    );
    let video_only = derived_valid_inspected(false);
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &video_only,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            false,
        ),
        Ok(())
    );
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &video_only,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::Audio)
    );
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &valid,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            false,
        ),
        Err(ArtifactValidationError::Audio)
    );

    let mut boundary_duration = valid.clone();
    boundary_duration.probe.duration_microseconds = 2_033_367;
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &boundary_duration,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Ok(())
    );
    boundary_duration.probe.duration_microseconds = 2_033_368;
    assert_eq!(
        validate_proxy_artifact(
            derived_valid_file_facts(),
            &boundary_duration,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::Duration)
    );
}

#[test]
fn derived_artifact_validators_reject_nonfiles_empty_files_and_wrong_paths() {
    let valid = derived_valid_inspected(true);
    assert_eq!(
        validate_proxy_artifact(
            ArtifactFileFacts {
                is_regular_file: false,
                byte_len: 4_096,
            },
            &valid,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::NotRegularFile)
    );
    assert_eq!(
        validate_proxy_artifact(
            ArtifactFileFacts {
                is_regular_file: true,
                byte_len: 0,
            },
            &valid,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::EmptyFile)
    );
    assert_eq!(
        validate_proxy_artifact(
            ArtifactFileFacts {
                is_regular_file: true,
                byte_len: 4_095,
            },
            &valid,
            derived_expected_dimensions(),
            &derived_rate(),
            2_000_000,
            true,
        ),
        Err(ArtifactValidationError::ProbeSizeMismatch)
    );

    let expected = Path::new("cache/thumbnail-fingerprint.jpg");
    assert_eq!(
        validate_thumbnail_artifact(expected, expected, derived_valid_file_facts()),
        Ok(())
    );
    assert_eq!(
        validate_thumbnail_artifact(
            Path::new("cache/other.jpg"),
            expected,
            derived_valid_file_facts(),
        ),
        Err(ArtifactValidationError::Path)
    );
    assert_eq!(
        validate_thumbnail_artifact(
            Path::new("cache/thumbnail-fingerprint.png"),
            Path::new("cache/thumbnail-fingerprint.png"),
            derived_valid_file_facts(),
        ),
        Err(ArtifactValidationError::FileExtension)
    );
    assert_eq!(
        validate_thumbnail_artifact(
            expected,
            expected,
            ArtifactFileFacts {
                is_regular_file: true,
                byte_len: 0,
            },
        ),
        Err(ArtifactValidationError::EmptyFile)
    );
    assert_eq!(
        validate_thumbnail_artifact(
            expected,
            expected,
            ArtifactFileFacts {
                is_regular_file: false,
                byte_len: 4_096,
            },
        ),
        Err(ArtifactValidationError::NotRegularFile)
    );
}

fn derived_cache_input() -> ValidatedDerivedInput {
    ValidatedDerivedInput::new(DERIVED_PROJECT_ID, DERIVED_ASSET_ID, derived_rate())
        .expect("derived cache input must validate")
}

fn derived_fingerprint_hex(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn derived_file_matches(path: &Path, expected: &[u8]) -> bool {
    fs::read(path).is_ok_and(|bytes| bytes == expected)
}

#[test]
fn derived_cache_directory_is_created_componentwise_and_rejects_symlink_escapes() {
    let workspace = tempdir().expect("cache workspace must be created");
    let cache_root = workspace.path().join("app-cache");
    let input = derived_cache_input();
    let directory = ensure_profile_cache_directory(&cache_root, &input)
        .expect("contained cache directory must be created");
    let canonical_root = fs::canonicalize(&cache_root).expect("cache root must canonicalize");
    let expected = canonical_root
        .join("video-phase1")
        .join(DERIVED_PROJECT_ID)
        .join(DERIVED_ASSET_ID)
        .join("preview-v1");
    assert_eq!(directory.profile_directory, expected);
    assert!(directory.profile_directory.is_dir());
    assert_eq!(
        fs::canonicalize(&directory.profile_directory).expect("profile must canonicalize"),
        directory.profile_directory
    );

    let escape_workspace = tempdir().expect("escape workspace must be created");
    let escape_root = escape_workspace.path().join("app-cache");
    let outside = tempdir().expect("outside directory must be created");
    fs::create_dir(&escape_root).expect("escape cache root must be created");
    let namespace_link = escape_root.join("video-phase1");
    if let Err(error) = create_directory_symlink(outside.path(), &namespace_link) {
        eprintln!("SKIPPED derived cache symlink assertion: symlink setup unsupported: {error}");
        return;
    }
    assert_eq!(
        ensure_profile_cache_directory(&escape_root, &input),
        Err(CacheLifecycleError::Escape)
    );
    assert_eq!(
        fs::read_dir(outside.path())
            .expect("outside directory must remain readable")
            .count(),
        0,
        "cache creation must not write through an escaping link"
    );
}

#[test]
fn derived_profile_cache_lock_serializes_different_fingerprint_promotion_and_cleanup() {
    let workspace = tempdir().expect("cache lock workspace must be created");
    let directory =
        ensure_profile_cache_directory(&workspace.path().join("app-cache"), &derived_cache_input())
            .expect("cache directory must be created");
    let first_paths = artifact_paths_in_validated_cache(&directory, &derived_fingerprint_hex('a'))
        .expect("first artifact paths must be created");
    let second_paths = artifact_paths_in_validated_cache(&directory, &derived_fingerprint_hex('b'))
        .expect("second artifact paths must be created");
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .expect("first lock runtime must build");
    let first_lock = runtime
        .block_on(acquire_profile_cache_lock_with(
            &directory,
            Duration::from_secs(1),
            Duration::from_millis(1),
            || {},
        ))
        .expect("first profile lock must be acquired");

    let (contended_sender, contended_receiver) = mpsc::channel();
    let (acquired_sender, acquired_receiver) = mpsc::channel();
    let second_directory = directory.clone();
    let second_paths_for_thread = second_paths.clone();
    let second_thread = thread::spawn(move || {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .build()
            .expect("second lock runtime must build");
        let mut contended_sender = Some(contended_sender);
        let _second_lock = runtime
            .block_on(acquire_profile_cache_lock_with(
                &second_directory,
                Duration::from_secs(5),
                Duration::from_millis(1),
                || {
                    if let Some(sender) = contended_sender.take() {
                        sender
                            .send(())
                            .expect("contention marker must be delivered");
                    }
                },
            ))
            .expect("second profile lock must acquire after the first releases");
        acquired_sender
            .send(())
            .expect("acquisition marker must be delivered");

        let temporary = create_temp_artifacts(&second_directory)
            .expect("second temporary pair must be created");
        fs::write(&temporary.proxy, b"second-proxy")
            .expect("second proxy temporary must be written");
        fs::write(&temporary.thumbnail, b"second-thumbnail")
            .expect("second thumbnail temporary must be written");
        promote_validated_pair(
            &second_directory,
            &second_paths_for_thread,
            temporary,
            |path| derived_file_matches(path, b"second-proxy"),
            |path| derived_file_matches(path, b"second-thumbnail"),
        )
        .expect("second pair must promote while holding the profile lock");
    });

    contended_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("second preparation must observe the held profile lock");
    assert_eq!(
        acquired_receiver.try_recv(),
        Err(mpsc::TryRecvError::Empty),
        "second preparation must not enter the lifecycle while the first holds the lock"
    );

    let temporary =
        create_temp_artifacts(&directory).expect("first temporary pair must be created");
    fs::write(&temporary.proxy, b"first-proxy").expect("first proxy temporary must be written");
    fs::write(&temporary.thumbnail, b"first-thumbnail")
        .expect("first thumbnail temporary must be written");
    promote_validated_pair(
        &directory,
        &first_paths,
        temporary,
        |path| derived_file_matches(path, b"first-proxy"),
        |path| derived_file_matches(path, b"first-thumbnail"),
    )
    .expect("first pair must complete while holding the profile lock");
    assert!(derived_file_matches(
        &first_paths.proxy_path,
        b"first-proxy"
    ));
    assert!(derived_file_matches(
        &first_paths.thumbnail_path,
        b"first-thumbnail"
    ));
    assert!(!second_paths.proxy_path.exists());
    assert!(!second_paths.thumbnail_path.exists());

    drop(first_lock);
    acquired_receiver
        .recv_timeout(Duration::from_secs(2))
        .expect("second preparation must acquire after release");
    second_thread
        .join()
        .expect("second preparation thread must finish");
    assert!(derived_file_matches(
        &second_paths.proxy_path,
        b"second-proxy"
    ));
    assert!(derived_file_matches(
        &second_paths.thumbnail_path,
        b"second-thumbnail"
    ));
    assert!(!first_paths.proxy_path.exists());
    assert!(!first_paths.thumbnail_path.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn derived_profile_cache_lock_timeout_is_bounded_typed_and_redacted() {
    let workspace = tempdir().expect("cache lock workspace must be created");
    let secret_cache_root = workspace.path().join("private-cache-lock-secret");
    let directory = ensure_profile_cache_directory(&secret_cache_root, &derived_cache_input())
        .expect("cache directory must be created");
    let first_lock = acquire_profile_cache_lock_with(
        &directory,
        Duration::from_secs(1),
        Duration::from_millis(1),
        || {},
    )
    .await
    .expect("first profile lock must be acquired");
    let mut contention_count = 0;

    let timeout = acquire_profile_cache_lock_with(
        &directory,
        Duration::ZERO,
        Duration::from_millis(1),
        || contention_count += 1,
    )
    .await
    .expect_err("contended zero-duration lock attempt must time out");
    assert_eq!(timeout, CacheLifecycleError::LockTimeout);
    assert_eq!(contention_count, 1);

    let command_error = map_cache_error(timeout);
    assert_eq!(command_error.code, VideoErrorCode::ProjectIo);
    assert_eq!(command_error.details["operation"], "prepare_asset");
    assert_eq!(command_error.details["category"], "cache_lock_timeout");
    let serialized =
        serde_json::to_string(&command_error).expect("cache lock error must serialize safely");
    assert!(!serialized.contains("private-cache-lock-secret"));
    assert!(!serialized.contains(&directory.profile_directory.to_string_lossy().to_string()));

    drop(first_lock);
    acquire_profile_cache_lock_with(&directory, Duration::ZERO, Duration::from_millis(1), || {})
        .await
        .expect("released profile lock must be immediately reusable");
}

#[test]
fn derived_temp_artifacts_are_suffixed_same_directory_paths_and_delete_on_drop() {
    let workspace = tempdir().expect("cache workspace must be created");
    let directory =
        ensure_profile_cache_directory(&workspace.path().join("app-cache"), &derived_cache_input())
            .expect("cache directory must be created");
    let temporary = create_temp_artifacts(&directory).expect("temporary pair must be created");
    let proxy_path = temporary.proxy.to_path_buf();
    let thumbnail_path = temporary.thumbnail.to_path_buf();
    assert_eq!(
        proxy_path.parent(),
        Some(directory.profile_directory.as_path())
    );
    assert_eq!(
        thumbnail_path.parent(),
        Some(directory.profile_directory.as_path())
    );
    assert_eq!(
        proxy_path.extension().and_then(|value| value.to_str()),
        Some("mp4")
    );
    assert_eq!(
        thumbnail_path.extension().and_then(|value| value.to_str()),
        Some("jpg")
    );
    assert!(proxy_path.is_file());
    assert!(thumbnail_path.is_file());
    drop(temporary);
    assert!(!proxy_path.exists());
    assert!(!thumbnail_path.exists());
}

#[test]
fn derived_cache_promotion_repairs_corruption_validates_finals_and_cleans_only_owned_stale_files() {
    let workspace = tempdir().expect("cache workspace must be created");
    let directory =
        ensure_profile_cache_directory(&workspace.path().join("app-cache"), &derived_cache_input())
            .expect("cache directory must be created");
    let paths = artifact_paths_in_validated_cache(&directory, &derived_fingerprint_hex('a'))
        .expect("owned paths must be created");
    fs::write(&paths.proxy_path, b"corrupt-proxy").expect("corrupt proxy must be written");
    fs::write(&paths.thumbnail_path, b"corrupt-thumbnail")
        .expect("corrupt thumbnail must be written");
    assert!(!cache_pair_is_valid_with(
        &directory,
        &paths,
        |path| derived_file_matches(path, b"valid-proxy"),
        |path| derived_file_matches(path, b"valid-thumbnail"),
    )
    .expect("cache hit validation must run"));

    let stale_proxy = directory
        .profile_directory
        .join(format!("proxy-{}.mp4", derived_fingerprint_hex('b')));
    let stale_thumbnail = directory
        .profile_directory
        .join(format!("thumbnail-{}.jpg", derived_fingerprint_hex('c')));
    let stale_partial = directory
        .profile_directory
        .join(format!("proxy-{}.mp4", derived_fingerprint_hex('d')));
    let unrelated = directory.profile_directory.join("notes.txt");
    let similar_unowned = directory.profile_directory.join("proxy-short.mp4");
    for path in [&stale_proxy, &stale_thumbnail, &stale_partial] {
        fs::write(path, b"stale").expect("stale owned artifact must be written");
    }
    fs::write(&unrelated, b"keep").expect("unrelated file must be written");
    fs::write(&similar_unowned, b"keep-too").expect("similar file must be written");

    let temporary = create_temp_artifacts(&directory).expect("temporary pair must be created");
    let temporary_proxy = temporary.proxy.to_path_buf();
    let temporary_thumbnail = temporary.thumbnail.to_path_buf();
    fs::write(&temporary.proxy, b"valid-proxy").expect("proxy temp must be written");
    fs::write(&temporary.thumbnail, b"valid-thumbnail").expect("thumbnail temp must be written");
    let proxy_checks = Cell::new(0);
    let thumbnail_checks = Cell::new(0);
    promote_validated_pair(
        &directory,
        &paths,
        temporary,
        |path| {
            proxy_checks.set(proxy_checks.get() + 1);
            derived_file_matches(path, b"valid-proxy")
        },
        |path| {
            thumbnail_checks.set(thumbnail_checks.get() + 1);
            derived_file_matches(path, b"valid-thumbnail")
        },
    )
    .expect("validated pair must promote");

    assert_eq!(
        proxy_checks.get(),
        2,
        "proxy temp and final must be validated"
    );
    assert_eq!(
        thumbnail_checks.get(),
        2,
        "thumbnail temp and final must be validated"
    );
    assert_eq!(
        fs::read(&paths.proxy_path).expect("proxy must read"),
        b"valid-proxy"
    );
    assert_eq!(
        fs::read(&paths.thumbnail_path).expect("thumbnail must read"),
        b"valid-thumbnail"
    );
    assert!(!temporary_proxy.exists());
    assert!(!temporary_thumbnail.exists());
    assert!(!stale_proxy.exists());
    assert!(!stale_thumbnail.exists());
    assert!(!stale_partial.exists());
    assert_eq!(
        fs::read(unrelated).expect("unrelated file must survive"),
        b"keep"
    );
    assert_eq!(
        fs::read(similar_unowned).expect("similar unowned file must survive"),
        b"keep-too"
    );
    assert!(cache_pair_is_valid_with(
        &directory,
        &paths,
        |path| derived_file_matches(path, b"valid-proxy"),
        |path| derived_file_matches(path, b"valid-thumbnail"),
    )
    .expect("repaired cache must validate"));
}

#[test]
fn derived_pre_promotion_failures_preserve_old_pair_and_delete_temporaries() {
    let workspace = tempdir().expect("cache workspace must be created");
    let directory =
        ensure_profile_cache_directory(&workspace.path().join("app-cache"), &derived_cache_input())
            .expect("cache directory must be created");
    let paths = artifact_paths_in_validated_cache(&directory, &derived_fingerprint_hex('a'))
        .expect("owned paths must be created");
    fs::write(&paths.proxy_path, b"old-proxy").expect("old proxy must be written");
    fs::write(&paths.thumbnail_path, b"old-thumbnail").expect("old thumbnail must be written");
    let stale = directory
        .profile_directory
        .join(format!("proxy-{}.mp4", derived_fingerprint_hex('b')));
    fs::write(&stale, b"stale").expect("stale artifact must be written");

    let temporary = create_temp_artifacts(&directory).expect("temporary pair must be created");
    let temporary_proxy = temporary.proxy.to_path_buf();
    let temporary_thumbnail = temporary.thumbnail.to_path_buf();
    fs::write(&temporary.proxy, b"new-proxy").expect("proxy temp must be written");
    fs::write(&temporary.thumbnail, b"invalid-thumbnail").expect("thumbnail temp must be written");
    assert_eq!(
        promote_validated_pair(
            &directory,
            &paths,
            temporary,
            |path| derived_file_matches(path, b"new-proxy"),
            |path| derived_file_matches(path, b"new-thumbnail"),
        ),
        Err(CacheLifecycleError::TemporaryValidation)
    );
    assert_eq!(
        fs::read(&paths.proxy_path).expect("old proxy must read"),
        b"old-proxy"
    );
    assert_eq!(
        fs::read(&paths.thumbnail_path).expect("old thumbnail must read"),
        b"old-thumbnail"
    );
    assert!(!temporary_proxy.exists());
    assert!(!temporary_thumbnail.exists());
    assert!(
        stale.exists(),
        "cleanup must wait until a new pair succeeds"
    );
}

#[test]
fn derived_promotion_failures_are_repairable_and_cannot_write_outside_cache() {
    let workspace = tempdir().expect("cache workspace must be created");
    let outside = tempdir().expect("outside directory must be created");
    let directory =
        ensure_profile_cache_directory(&workspace.path().join("app-cache"), &derived_cache_input())
            .expect("cache directory must be created");
    let paths = artifact_paths_in_validated_cache(&directory, &derived_fingerprint_hex('a'))
        .expect("owned paths must be created");
    fs::write(&paths.proxy_path, b"old-proxy").expect("old proxy must be written");
    fs::write(&paths.thumbnail_path, b"old-thumbnail").expect("old thumbnail must be written");

    let forged_proxy = outside
        .path()
        .join(format!("proxy-{}.mp4", derived_fingerprint_hex('a')));
    let forged = DerivedArtifactPaths {
        profile_directory: directory.profile_directory.clone(),
        proxy_path: forged_proxy.clone(),
        thumbnail_path: paths.thumbnail_path.clone(),
    };
    let temporary = create_temp_artifacts(&directory).expect("temporary pair must be created");
    let temporary_proxy = temporary.proxy.to_path_buf();
    let temporary_thumbnail = temporary.thumbnail.to_path_buf();
    fs::write(&temporary.proxy, b"new-proxy").expect("proxy temp must be written");
    fs::write(&temporary.thumbnail, b"new-thumbnail").expect("thumbnail temp must be written");
    assert_eq!(
        promote_validated_pair(&directory, &forged, temporary, |_| true, |_| true,),
        Err(CacheLifecycleError::UnsafeArtifactPath)
    );
    assert!(!forged_proxy.exists());
    assert!(!temporary_proxy.exists());
    assert!(!temporary_thumbnail.exists());

    let temporary = create_temp_artifacts(&directory).expect("temporary pair must be created");
    let failed_proxy_temp = temporary.proxy.to_path_buf();
    let failed_thumbnail_temp = temporary.thumbnail.to_path_buf();
    fs::write(&temporary.proxy, b"new-proxy").expect("proxy temp must be written");
    fs::write(&temporary.thumbnail, b"new-thumbnail").expect("thumbnail temp must be written");
    assert_eq!(
        promote_validated_pair_with(
            &directory,
            &paths,
            temporary,
            |path| derived_file_matches(path, b"new-proxy"),
            |path| derived_file_matches(path, b"new-thumbnail"),
            |temporary, _| Err(temporary),
        ),
        Err(CacheLifecycleError::Promotion)
    );
    assert_eq!(
        fs::read(&paths.proxy_path).expect("old proxy must read"),
        b"old-proxy"
    );
    assert_eq!(
        fs::read(&paths.thumbnail_path).expect("old thumbnail must read"),
        b"old-thumbnail"
    );
    assert!(!failed_proxy_temp.exists());
    assert!(!failed_thumbnail_temp.exists());

    let temporary = create_temp_artifacts(&directory).expect("temporary pair must be created");
    fs::write(&temporary.proxy, b"new-proxy").expect("proxy temp must be written");
    fs::write(&temporary.thumbnail, b"new-thumbnail").expect("thumbnail temp must be written");
    let promotion_count = Cell::new(0);
    assert_eq!(
        promote_validated_pair_with(
            &directory,
            &paths,
            temporary,
            |path| derived_file_matches(path, b"new-proxy"),
            |path| derived_file_matches(path, b"new-thumbnail"),
            |temporary, destination| {
                promotion_count.set(promotion_count.get() + 1);
                if promotion_count.get() == 2 {
                    Err(temporary)
                } else {
                    temporary.persist(destination).map_err(|error| error.path)
                }
            },
        ),
        Err(CacheLifecycleError::Promotion)
    );
    assert_eq!(
        fs::read(&paths.proxy_path).expect("new proxy must read"),
        b"new-proxy"
    );
    assert_eq!(
        fs::read(&paths.thumbnail_path).expect("old thumbnail must read"),
        b"old-thumbnail"
    );
    assert!(!cache_pair_is_valid_with(
        &directory,
        &paths,
        |path| derived_file_matches(path, b"new-proxy"),
        |path| derived_file_matches(path, b"new-thumbnail"),
    )
    .expect("partial pair must be checked"));

    let repair = create_temp_artifacts(&directory).expect("repair pair must be created");
    fs::write(&repair.proxy, b"new-proxy").expect("repair proxy must be written");
    fs::write(&repair.thumbnail, b"new-thumbnail").expect("repair thumbnail must be written");
    promote_validated_pair(
        &directory,
        &paths,
        repair,
        |path| derived_file_matches(path, b"new-proxy"),
        |path| derived_file_matches(path, b"new-thumbnail"),
    )
    .expect("next call must repair an incomplete pair");
    assert_eq!(
        fs::read(&paths.thumbnail_path).expect("repaired thumbnail must read"),
        b"new-thumbnail"
    );
}

fn derived_missing_programs() -> MediaPrograms {
    MediaPrograms {
        ffmpeg: OsString::from("missing-private-ffmpeg-secret"),
        ffprobe: OsString::from("missing-private-ffprobe-secret"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn derived_prepare_rejects_ungranted_source_before_tools_or_cache() {
    let workspace = tempdir().expect("prepare workspace must be created");
    let source = workspace.path().join("private-ungranted-source.mp4");
    fs::write(&source, b"not-media").expect("source fixture must be written");
    let cache_root = workspace.path().join("cache-must-not-exist");
    let error = prepare_asset_core(
        PrepareAssetCoreRequest {
            owner_label: "ungranted-owner",
            project_id: DERIVED_PROJECT_ID,
            asset_id: DERIVED_ASSET_ID,
            source_path: &source,
            sequence_rate: derived_rate(),
        },
        &VideoPathGrants::default(),
        &cache_root,
        derived_missing_programs(),
    )
    .await
    .expect_err("ungranted source must fail before tool execution");
    assert_eq!(error.code, VideoErrorCode::PathNotGranted);
    assert_eq!(error.details["operation"], "authorize_path");
    assert!(!cache_root.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn derived_prepare_rejects_malformed_ids_and_rates_before_cache_writes() {
    let workspace = tempdir().expect("prepare workspace must be created");
    let source = workspace.path().join("private-input-source.mp4");
    fs::write(&source, b"not-media").expect("source fixture must be written");
    let grants = VideoPathGrants::default();

    let invalid_id_cache = workspace.path().join("invalid-id-cache");
    let invalid_id = prepare_asset_core(
        PrepareAssetCoreRequest {
            owner_label: "input-owner",
            project_id: "../escape",
            asset_id: DERIVED_ASSET_ID,
            source_path: &source,
            sequence_rate: derived_rate(),
        },
        &grants,
        &invalid_id_cache,
        derived_missing_programs(),
    )
    .await
    .expect_err("malformed project ID must fail first");
    assert_eq!(invalid_id.code, VideoErrorCode::InvalidPath);
    assert_eq!(invalid_id.details["category"], "project_id");
    assert!(!invalid_id_cache.exists());

    let invalid_rate_cache = workspace.path().join("invalid-rate-cache");
    let invalid_rate = prepare_asset_core(
        PrepareAssetCoreRequest {
            owner_label: "input-owner",
            project_id: DERIVED_PROJECT_ID,
            asset_id: DERIVED_ASSET_ID,
            source_path: &source,
            sequence_rate: RationalRate {
                numerator: 60,
                denominator: 2,
            },
        },
        &grants,
        &invalid_rate_cache,
        derived_missing_programs(),
    )
    .await
    .expect_err("non-reduced rate must fail first");
    assert_eq!(invalid_rate.code, VideoErrorCode::Phase1Limit);
    assert_eq!(invalid_rate.details["category"], "sequence_rate");
    assert!(!invalid_rate_cache.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn derived_prepare_missing_ffprobe_is_typed_redacted_and_precedes_cache_creation() {
    let workspace = tempdir().expect("prepare workspace must be created");
    let source = workspace.path().join("private-probe-source-secret.mp4");
    fs::write(&source, b"not-media").expect("source fixture must be written");
    let cache_root = workspace.path().join("cache-must-not-exist");
    let grants = VideoPathGrants::default();
    grants
        .grant_existing_file("probe-owner", GrantCategory::Source, &source)
        .expect("source grant must be created");
    let error = prepare_asset_core(
        PrepareAssetCoreRequest {
            owner_label: "probe-owner",
            project_id: DERIVED_PROJECT_ID,
            asset_id: DERIVED_ASSET_ID,
            source_path: &source,
            sequence_rate: derived_rate(),
        },
        &grants,
        &cache_root,
        derived_missing_programs(),
    )
    .await
    .expect_err("missing ffprobe must fail safely");
    assert_eq!(error.code, VideoErrorCode::ToolUnavailable);
    assert_eq!(error.details["operation"], "prepare_source_probe");
    assert_eq!(error.details["executable"], "ffprobe");
    let serialized = serde_json::to_string(&error).expect("probe error must serialize");
    assert!(!serialized.contains("private-probe-source-secret"));
    assert!(!serialized.contains("missing-private-ffprobe-secret"));
    assert!(!cache_root.exists());
}

#[tokio::test(flavor = "current_thread")]
async fn derived_prepare_missing_ffmpeg_is_typed_and_redacts_arguments_and_program() {
    let workspace = tempdir().expect("ffmpeg workspace must be created");
    let secret_path = workspace.path().join("private-ffmpeg-source-secret.mp4");
    let secret_program = "missing-private-ffmpeg-secret";
    let error = run_derived_ffmpeg(
        OsString::from(secret_program),
        vec![secret_path.as_os_str().to_owned()],
        "prepare_proxy",
        Duration::from_secs(1),
        ProcessCancellation::new(),
    )
    .await
    .expect_err("missing ffmpeg must fail safely");
    assert_eq!(error.code, VideoErrorCode::ToolUnavailable);
    assert_eq!(error.details["operation"], "prepare_proxy");
    assert_eq!(error.details["executable"], "ffmpeg");
    let serialized = serde_json::to_string(&error).expect("ffmpeg error must serialize");
    assert!(!serialized.contains("private-ffmpeg-source-secret"));
    assert!(!serialized.contains(secret_program));
}

#[tokio::test(flavor = "current_thread")]
async fn derived_trusted_probe_failures_are_typed_and_redacted() {
    let directory = tempdir().expect("trusted probe directory must be created");
    let secret_path = directory.path().join("private-derived-cache-secret.mp4");
    fs::write(&secret_path, b"not-media").expect("trusted probe input must be written");
    let secret_executable = "missing-private-ffprobe-secret";
    let error = probe_trusted_media_with_program(
        &secret_path,
        OsString::from(secret_executable),
        ProcessCancellation::new(),
        "validate_proxy",
    )
    .await
    .expect_err("missing trusted ffprobe executable must fail safely");
    assert_eq!(error.code, VideoErrorCode::ToolUnavailable);
    assert_eq!(error.details["operation"], "validate_proxy");
    assert_eq!(error.details["executable"], "ffprobe");
    let serialized = serde_json::to_string(&error).expect("probe error must serialize");
    assert!(!serialized.contains("private-derived-cache-secret"));
    assert!(!serialized.contains(secret_executable));
    assert!(!serialized.contains(&secret_path.to_string_lossy().to_string()));
}

fn ffprobe_fixture(name: &str) -> Vec<u8> {
    fs::read(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("fixtures/ffprobe")
            .join(name),
    )
    .unwrap_or_else(|error| panic!("ffprobe fixture {name} must be readable: {error}"))
}

#[test]
fn ffprobe_parser_accepts_canonical_av_and_video_only_metadata() {
    let av =
        parse_ffprobe_json(&ffprobe_fixture("av.json"), 129_211).expect("AV fixture must parse");
    assert_eq!(av.duration_microseconds, 2_000_000);
    assert_eq!(av.width, 320);
    assert_eq!(av.height, 180);
    assert_eq!(av.video_codec_name, "h264");
    assert_eq!(
        av.average_frame_rate,
        RationalRate {
            numerator: 30,
            denominator: 1,
        }
    );
    assert_eq!(av.real_frame_rate, av.average_frame_rate);
    assert!(!av.variable_frame_rate);
    assert_eq!(av.file_size_bytes, 129_211);
    let audio = av.audio.expect("AV fixture must contain audio");
    assert_eq!(audio.codec_name, "aac");
    assert_eq!(audio.channels, 1);
    assert_eq!(audio.sample_rate, 48_000);

    let video_only = parse_ffprobe_json(&ffprobe_fixture("video-only.json"), 2_048)
        .expect("video-only fixture must parse");
    assert_eq!(video_only.audio, None);
    assert_eq!(video_only.duration_microseconds, 3_500_000);
}

#[test]
fn ffprobe_parser_reduces_rates_falls_back_and_detects_vfr_exactly() {
    let fallback = parse_ffprobe_json(&ffprobe_fixture("rate-fallback.json"), 4_096)
        .expect("rate fallback fixture must parse");
    assert_eq!(
        fallback.average_frame_rate,
        RationalRate {
            numerator: 30_000,
            denominator: 1_001,
        }
    );
    assert_eq!(fallback.real_frame_rate, fallback.average_frame_rate);
    assert!(!fallback.variable_frame_rate);

    let vfr =
        parse_ffprobe_json(&ffprobe_fixture("vfr.json"), 4_096).expect("VFR fixture must parse");
    assert!(vfr.variable_frame_rate);

    let boundary = parse_ffprobe_json(&ffprobe_fixture("nominal-boundary.json"), 4_096)
        .expect("nominal boundary fixture must parse");
    assert!(!boundary.variable_frame_rate);
}

#[test]
fn ffprobe_parser_ceils_sub_microsecond_duration() {
    let probe = parse_ffprobe_json(&ffprobe_fixture("duration-ceil.json"), 1)
        .expect("duration fixture must parse");
    assert_eq!(probe.duration_microseconds, 1_000_001);
}

#[test]
fn ffprobe_parser_rejects_malformed_and_unsupported_metadata() {
    assert!(parse_ffprobe_json(b"{", 1).is_err());
    for fixture in [
        "malformed.json",
        "invalid-rate.json",
        "missing-duration.json",
        "missing-video.json",
        "attached-picture-only.json",
        "malformed-audio.json",
        "unsafe-numeric.json",
        "zero-size.json",
        "zero-dimensions.json",
    ] {
        assert!(
            parse_ffprobe_json(&ffprobe_fixture(fixture), 1_024).is_err(),
            "fixture must be rejected: {fixture}"
        );
    }

    let invalid_duration = br#"{"streams":[{"codec_type":"video","codec_name":"h264","width":1,"height":1,"avg_frame_rate":"1/1","r_frame_rate":"1/1","duration":"N/A","disposition":{"attached_pic":0}}],"format":{"duration":"1e3","size":"1"}}"#;
    assert!(parse_ffprobe_json(invalid_duration, 1).is_err());
    assert!(parse_ffprobe_json(&ffprobe_fixture("av.json"), 0).is_err());
}

const RENDER_PLAN_ID: &str = "33333333-3333-4333-8333-333333333333";
const RENDER_REVISION_ID: &str = "44444444-4444-4444-8444-444444444444";

fn render_plan_value(input: &Path, output: &Path, audio: bool, plan_id: &str) -> Value {
    render_plan_value_for_profile(input, output, audio, plan_id, 60, 30_000, 1_001, 1_280, 720)
}

#[allow(clippy::too_many_arguments)]
fn render_plan_value_for_profile(
    input: &Path,
    output: &Path,
    audio: bool,
    plan_id: &str,
    duration_frames: u64,
    rate_numerator: u64,
    rate_denominator: u64,
    width: u64,
    height: u64,
) -> Value {
    let input = input.to_string_lossy().into_owned();
    let output = output.to_string_lossy().into_owned();
    let duration_numerator = u128::from(duration_frames) * u128::from(rate_denominator) * 1_000_000;
    let duration_denominator = u128::from(rate_numerator);
    let duration_microseconds =
        u64::try_from((duration_numerator + duration_denominator / 2) / duration_denominator)
            .expect("test render duration must fit u64");
    let duration = format!(
        "{}.{:06}",
        duration_microseconds / 1_000_000,
        duration_microseconds % 1_000_000
    );
    let filter = format!(
        "scale={width}:{height}:force_original_aspect_ratio=decrease:flags=lanczos,pad={width}:{height}:(ow-iw)/2:(oh-ih)/2:black,fps={rate_numerator}/{rate_denominator}"
    );
    let mut argv = vec![
        "-hide_banner".to_owned(),
        "-nostdin".to_owned(),
        "-loglevel".to_owned(),
        "warning".to_owned(),
        "-progress".to_owned(),
        "pipe:1".to_owned(),
        "-nostats".to_owned(),
        "-i".to_owned(),
        input.clone(),
        "-ss".to_owned(),
        "0.000000".to_owned(),
        "-t".to_owned(),
        duration,
        "-map".to_owned(),
        "0:v:0".to_owned(),
    ];
    if audio {
        argv.extend(["-map".to_owned(), "0:a:0".to_owned()]);
    } else {
        argv.push("-an".to_owned());
    }
    argv.extend([
        "-vf".to_owned(),
        filter,
        "-c:v".to_owned(),
        "libx264".to_owned(),
        "-pix_fmt".to_owned(),
        "yuv420p".to_owned(),
    ]);
    if audio {
        argv.extend([
            "-c:a".to_owned(),
            "aac".to_owned(),
            "-ar".to_owned(),
            "48000".to_owned(),
        ]);
    }
    argv.extend([
        "-movflags".to_owned(),
        "+faststart".to_owned(),
        output.clone(),
    ]);
    serde_json::json!({
        "schemaVersion": 1,
        "planId": plan_id,
        "revisionId": RENDER_REVISION_ID,
        "executable": "ffmpeg",
        "inputPath": input,
        "outputPath": output,
        "expected": {
            "durationFrames": duration_frames,
            "rate": { "numerator": rate_numerator, "denominator": rate_denominator },
            "width": width,
            "height": height,
            "audio": audio
        },
        "argv": argv
    })
}

fn validated_render_fixture(
    directory: &Path,
    audio: bool,
    plan_id: &str,
) -> (VideoPathGrants, super::render::ValidatedRenderPlan) {
    let source = directory.join(format!("source-{plan_id}.mp4"));
    let output = directory.join(format!("output-{plan_id}.mp4"));
    fs::write(&source, b"source").expect("source must be written");
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file("owner", GrantCategory::Source, &source)
        .expect("source must be granted");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("output must be granted");
    let validated = parse_and_validate_render_plan(
        render_plan_value(&source, &output, audio, plan_id),
        "owner",
        &grants,
    )
    .expect("exact compiler plan must validate");
    (grants, validated)
}

#[test]
fn render_plan_validation_accepts_exact_av_and_video_only_and_rejects_mutations() {
    for audio in [true, false] {
        let directory = tempdir().expect("render workspace must be created");
        let (_, validated) = validated_render_fixture(directory.path(), audio, RENDER_PLAN_ID);
        assert_eq!(validated.duration_microseconds, 2_002_000);
        let partial = partial_render_path(&validated).expect("partial path must derive");
        assert_eq!(
            partial.file_name().and_then(|name| name.to_str()),
            Some(".svp-part-33333333-3333-4333-8333-333333333333.mp4")
        );
        assert!(
            !validated.plan.argv.iter().any(|argument| argument == "-y"),
            "validated plan must retain destination no-clobber semantics"
        );
    }

    let directory = tempdir().expect("strict workspace must be created");
    let source = directory.path().join("strict-source.mp4");
    let output = directory.path().join("strict-output.mp4");
    fs::write(&source, b"source").expect("source must be written");
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file("owner", GrantCategory::Source, &source)
        .expect("source must grant");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("output must grant");
    let exact = render_plan_value(&source, &output, true, RENDER_PLAN_ID);
    let invalid_plans = [
        {
            let mut value = exact.clone();
            value["executable"] = Value::String("sh".to_owned());
            value
        },
        {
            let mut value = exact.clone();
            value["expected"]["width"] = Value::from(1279);
            value
        },
        {
            let mut value = exact.clone();
            value["argv"][0] = Value::String("-y".to_owned());
            value
        },
        {
            let mut value = exact.clone();
            value["argv"][12] = Value::String("2.000000".to_owned());
            value
        },
        {
            let mut value = exact.clone();
            value["argv"][10] = Value::String("00.000000".to_owned());
            value
        },
        {
            let mut value = exact;
            value["surprise"] = Value::Bool(true);
            value
        },
    ];
    for invalid in invalid_plans {
        assert_eq!(
            parse_and_validate_render_plan(invalid, "owner", &grants)
                .expect_err("mutated render plan must fail")
                .code,
            VideoErrorCode::InvalidRenderPlan
        );
    }
}

#[test]
fn render_execution_argv_exactly_overwrites_only_the_owned_partial() {
    for audio in [true, false] {
        let directory = tempdir().expect("render execution workspace must be created");
        let (_, validated) = validated_render_fixture(directory.path(), audio, RENDER_PLAN_ID);
        let partial = partial_render_path(&validated).expect("partial path must derive");
        let source = validated.input_path.to_string_lossy().into_owned();
        let partial = partial.to_string_lossy().into_owned();
        let mut expected = vec![
            "-hide_banner".to_owned(),
            "-nostdin".to_owned(),
            "-y".to_owned(),
            "-loglevel".to_owned(),
            "warning".to_owned(),
            "-progress".to_owned(),
            "pipe:1".to_owned(),
            "-nostats".to_owned(),
            "-i".to_owned(),
            source,
            "-ss".to_owned(),
            "0.000000".to_owned(),
            "-t".to_owned(),
            "2.002000".to_owned(),
            "-map".to_owned(),
            "0:v:0".to_owned(),
        ];
        if audio {
            expected.extend(["-map".to_owned(), "0:a:0".to_owned()]);
        } else {
            expected.push("-an".to_owned());
        }
        expected.extend([
            "-vf".to_owned(),
            "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,fps=30000/1001".to_owned(),
            "-c:v".to_owned(),
            "libx264".to_owned(),
            "-pix_fmt".to_owned(),
            "yuv420p".to_owned(),
        ]);
        if audio {
            expected.extend([
                "-c:a".to_owned(),
                "aac".to_owned(),
                "-ar".to_owned(),
                "48000".to_owned(),
            ]);
        }
        expected.extend(["-movflags".to_owned(), "+faststart".to_owned(), partial]);

        assert_eq!(
            render_execution_arguments(
                &validated,
                &partial_render_path(&validated).expect("partial path must derive")
            )
            .expect("execution arguments must build"),
            expected
        );
        assert_eq!(
            validated.plan.argv.last(),
            Some(&validated.output_path.to_string_lossy().into_owned()),
            "the validated plan must still target the final destination"
        );
    }
}

#[test]
fn render_progress_is_monotonic_clamped_and_prefers_out_time_us() {
    let mut progress = RenderProgress::new(2_000_000);
    assert_eq!(
        progress.ingest_record(b"out_time_ms=100\r\nprogress=continue\r\n"),
        Some(100)
    );
    assert_eq!(
        progress.ingest_record(b"out_time_ms=900\nout_time_us=700\nprogress=continue\n"),
        Some(700)
    );
    assert_eq!(
        progress.ingest_record(b"out_time_us=699\nprogress=continue\n"),
        None
    );
    assert_eq!(
        progress.ingest_record(b"out_time_us=-1\nout_time_ms=bad\n"),
        None
    );
    assert_eq!(
        progress.ingest_record(b"out_time_us=999999999999999999999999\n"),
        None
    );
    assert_eq!(
        progress.ingest_record(b"out_time_us=3000000\n"),
        Some(2_000_000)
    );
    assert_eq!(progress.ingest_record(b"progress=end\n"), None);
}

#[test]
fn render_registry_is_owner_scoped_and_bounds_tombstones() {
    let directory = tempdir().expect("registry workspace must be created");
    let (_, first) = validated_render_fixture(directory.path(), true, RENDER_PLAN_ID);
    let jobs = VideoRenderJobs::with_tombstone_limit(2);
    let (identity, _) = jobs.register("owner", &first).expect("job must register");
    assert_eq!(
        jobs.register("owner", &first)
            .expect_err("duplicate id must fail")
            .code,
        VideoErrorCode::InvalidRenderPlan
    );
    assert_eq!(
        jobs.cancel("intruder", &identity.job_id)
            .expect_err("wrong owner must fail")
            .code,
        VideoErrorCode::InvalidRenderPlan
    );
    jobs.cancel("owner", &identity.job_id)
        .expect("owner cancel must work");
    jobs.cancel("owner", &identity.job_id)
        .expect("repeat cancel must work");
    assert!(jobs.settle(&identity.job_id).expect("settlement must work"));
    assert!(!jobs
        .settle(&identity.job_id)
        .expect("repeat settlement must be inert"));
    jobs.cancel("owner", &identity.job_id)
        .expect("settled cancellation must be idempotent");

    for (index, id) in [
        "55555555-5555-4555-8555-555555555555",
        "66666666-6666-4666-8666-666666666666",
    ]
    .into_iter()
    .enumerate()
    {
        let (_, plan) = validated_render_fixture(directory.path(), index % 2 == 0, id);
        let (identity, _) = jobs
            .register("owner", &plan)
            .expect("new job must register");
        assert!(jobs.settle(&identity.job_id).expect("new job must settle"));
    }
    assert_eq!(jobs.tombstone_count(), 2);
}

#[test]
fn render_registry_bulk_cancellation_is_scoped_idempotent_and_worker_settled() {
    let directory = tempdir().expect("bulk cancellation workspace must be created");
    let jobs = VideoRenderJobs::default();
    let mut registered = Vec::new();
    for (owner, job_id) in [
        ("first-owner", "77777777-7777-4777-8777-777777777777"),
        ("first-owner", "88888888-8888-4888-8888-888888888888"),
        ("second-owner", "99999999-9999-4999-8999-999999999999"),
    ] {
        let (_, validated) = validated_render_fixture(directory.path(), false, job_id);
        let (identity, cancellation) = jobs
            .register(owner, &validated)
            .expect("bulk cancellation job must register");
        registered.push((identity.job_id, cancellation));
    }

    jobs.cancel_owner("first-owner")
        .expect("owner cleanup must cancel its jobs");
    jobs.cancel_owner("first-owner")
        .expect("repeated owner cleanup must be idempotent");
    assert!(registered[0].1.is_cancelled());
    assert!(registered[1].1.is_cancelled());
    assert!(!registered[2].1.is_cancelled());
    assert!(registered.iter().all(|(job_id, _)| jobs.is_active(job_id)));
    assert_eq!(jobs.tombstone_count(), 0);

    jobs.cancel_all().expect("shutdown must cancel every job");
    jobs.cancel_all()
        .expect("repeated shutdown cleanup must be idempotent");
    assert!(registered
        .iter()
        .all(|(job_id, cancellation)| cancellation.is_cancelled() && jobs.is_active(job_id)));
    assert_eq!(jobs.tombstone_count(), 0);

    for (job_id, _) in registered {
        assert!(jobs
            .settle(&job_id)
            .expect("the worker must retain terminal settlement ownership"));
    }
    assert_eq!(jobs.tombstone_count(), 3);
}

#[test]
fn render_output_validation_and_preview_directory_reject_unsafe_shapes() {
    let directory = tempdir().expect("render validation workspace must be created");
    let (_, validated) = validated_render_fixture(directory.path(), true, RENDER_PLAN_ID);
    let artifact = directory.path().join("artifact.mp4");
    fs::write(&artifact, vec![0_u8; 4_096]).expect("artifact must be written");
    let mut inspected = derived_valid_inspected(true);
    inspected.probe.duration_microseconds = 2_002_000;
    assert_eq!(
        validate_render_output(&artifact, &inspected, &validated),
        Ok(())
    );
    inspected.pixel_format = Some("yuv422p".to_owned());
    assert_eq!(
        validate_render_output(&artifact, &inspected, &validated)
            .expect_err("wrong pixel format must fail")
            .code,
        VideoErrorCode::InvalidMedia
    );

    let cache = directory.path().join("cache");
    fs::create_dir(&cache).expect("cache root must exist");
    let preview = ensure_preview_directory(&cache, RENDER_PLAN_ID)
        .expect("controlled preview directory must be created");
    assert!(preview.starts_with(&cache));
    assert_eq!(
        preview.file_name().and_then(|name| name.to_str()),
        Some(RENDER_PLAN_ID)
    );
    assert_eq!(
        ensure_preview_directory(&cache, "../escape")
            .expect_err("escaping job id must fail")
            .code,
        VideoErrorCode::InvalidRenderPlan
    );
}

#[test]
fn render_partial_workflow_precreates_cleans_and_preserves_final_no_clobber() {
    let directory = tempdir().expect("promotion workspace must be created");
    let (_, validated) = validated_render_fixture(directory.path(), true, RENDER_PLAN_ID);
    let partial_path = partial_render_path(&validated).expect("partial path must derive");
    let unrelated = directory.path().join(".svp-part-unrelated.mp4");
    fs::write(&unrelated, b"unrelated").expect("unrelated file must be written");
    {
        let partial = create_owned_partial(&partial_path).expect("partial must be owned");
        let metadata = fs::symlink_metadata(&partial_path).expect("partial must be pre-created");
        assert!(metadata.file_type().is_file());
        assert_eq!(metadata.len(), 0, "pre-created partial must start empty");
        assert_eq!(
            create_owned_partial(&partial_path)
                .expect_err("an existing partial must never be claimed")
                .code,
            VideoErrorCode::InvalidRenderPlan
        );

        let execution = render_execution_arguments(&validated, &partial_path)
            .expect("execution arguments must target the owned partial");
        assert_eq!(&execution[1..3], ["-nostdin", "-y"]);
        assert_eq!(
            execution.last().map(String::as_str),
            partial_path.to_str(),
            "FFmpeg must overwrite only the pre-created partial"
        );
        assert!(
            !execution
                .iter()
                .any(|argument| argument == validated.output_path.to_string_lossy().as_ref()),
            "FFmpeg must never receive the final destination"
        );

        let mut ffmpeg_output = fs::OpenOptions::new()
            .write(true)
            .truncate(true)
            .open(&partial)
            .expect("the owned partial must be reopenable for controlled overwrite");
        ffmpeg_output
            .write_all(b"new export")
            .expect("controlled overwrite must succeed");
    }
    assert!(!partial_path.exists(), "owned partial must drop cleanly");
    assert_eq!(
        fs::read(&unrelated).expect("unrelated file must remain"),
        b"unrelated"
    );

    fs::write(&validated.output_path, b"old export").expect("old export must exist");
    let partial = create_owned_partial(&partial_path).expect("replacement partial must be owned");
    fs::write(&partial, b"replacement").expect("replacement must write");
    assert_eq!(
        promote_render_partial(partial, &validated.output_path, false)
            .expect_err("no-clobber promotion must reject existing destination")
            .code,
        VideoErrorCode::OutputExists
    );
    assert_eq!(
        fs::read(&validated.output_path).expect("old export must remain"),
        b"old export"
    );
    assert!(
        !partial_path.exists(),
        "failed promotion must clean partial"
    );

    let partial = create_owned_partial(&partial_path).expect("overwrite partial must be owned");
    fs::write(&partial, b"replacement").expect("replacement must write");
    promote_render_partial(partial, &validated.output_path, true)
        .expect("explicit overwrite must atomically replace");
    assert_eq!(
        fs::read(&validated.output_path).expect("replacement must exist"),
        b"replacement"
    );
    assert_eq!(
        fs::read(&unrelated).expect("unrelated file must remain"),
        b"unrelated"
    );
}

const RENDER_INTEGRATION_OWNER: &str = "render-worker-integration";
const RENDER_AV_PLAN_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RENDER_VIDEO_ONLY_PLAN_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RENDER_COLLISION_PLAN_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RENDER_CANCELLATION_PLAN_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

#[derive(Clone, Copy)]
struct RenderTestProfile {
    duration_frames: u64,
    rate_numerator: u64,
    rate_denominator: u64,
    width: u64,
    height: u64,
}

const CANONICAL_RENDER_PROFILE: RenderTestProfile = RenderTestProfile {
    duration_frames: 60,
    rate_numerator: 30,
    rate_denominator: 1,
    width: 320,
    height: 180,
};

const CANCELLATION_RENDER_PROFILE: RenderTestProfile = RenderTestProfile {
    duration_frames: 900,
    rate_numerator: 30,
    rate_denominator: 1,
    width: 1_280,
    height: 720,
};

fn canonical_media_fixture() -> PathBuf {
    workspace_root().join("apps/desktop/src-tauri/fixtures/video-phase1/single-clip.mp4")
}

fn validated_system_render_fixture(
    directory: &Path,
    source: &Path,
    audio: bool,
    plan_id: &str,
    profile: RenderTestProfile,
) -> super::render::ValidatedRenderPlan {
    let output = directory.join(format!("output-{plan_id}.mp4"));
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file(RENDER_INTEGRATION_OWNER, GrantCategory::Source, source)
        .expect("integration source must be granted");
    let output = grants
        .grant_destination(RENDER_INTEGRATION_OWNER, GrantCategory::Output, &output)
        .expect("integration output must be granted");
    parse_and_validate_render_plan(
        render_plan_value_for_profile(
            &source,
            &output,
            audio,
            plan_id,
            profile.duration_frames,
            profile.rate_numerator,
            profile.rate_denominator,
            profile.width,
            profile.height,
        ),
        RENDER_INTEGRATION_OWNER,
        &grants,
    )
    .expect("integration render plan must validate")
}

fn registered_system_render_worker(
    validated: super::render::ValidatedRenderPlan,
    overwrite: bool,
    app_cache_dir: PathBuf,
) -> (
    RenderWorkerRequest,
    VideoRenderJobs,
    Arc<Mutex<Vec<VideoRenderEvent>>>,
) {
    let jobs = VideoRenderJobs::default();
    let (identity, cancellation) = jobs
        .register(RENDER_INTEGRATION_OWNER, &validated)
        .expect("integration render job must register");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let events_for_sink = captured.clone();
    let events: RenderEventSink = Arc::new(move |event| {
        events_for_sink
            .lock()
            .expect("integration event capture must lock")
            .push(event);
        Ok(())
    });
    events.as_ref()(identity.started()).expect("started event must be captured");
    let request = RenderWorkerRequest {
        validated,
        overwrite,
        app_cache_dir,
        ffmpeg_program: OsString::from("ffmpeg"),
        ffprobe_program: OsString::from("ffprobe"),
        cancellation,
        identity,
        jobs: jobs.clone(),
        events,
    };
    (request, jobs, captured)
}

fn captured_render_events(captured: &Arc<Mutex<Vec<VideoRenderEvent>>>) -> Vec<VideoRenderEvent> {
    captured
        .lock()
        .expect("integration event capture must lock")
        .clone()
}

fn is_render_terminal_event(event: &VideoRenderEvent) -> bool {
    matches!(
        event,
        VideoRenderEvent::Completed { .. }
            | VideoRenderEvent::Failed { .. }
            | VideoRenderEvent::Cancelled { .. }
    )
}

fn assert_worker_event_order(events: &[VideoRenderEvent]) {
    assert!(
        matches!(events.first(), Some(VideoRenderEvent::Started { .. })),
        "started must be the first event: {events:?}"
    );
    assert!(
        events.len() >= 3,
        "worker must emit started, progress, and terminal events: {events:?}"
    );
    assert!(
        events[1..events.len() - 1]
            .iter()
            .all(|event| matches!(event, VideoRenderEvent::Progress { .. })),
        "only progress may appear between started and terminal: {events:?}"
    );
    assert_eq!(
        events
            .iter()
            .filter(|event| is_render_terminal_event(event))
            .count(),
        1,
        "worker must emit exactly one terminal event: {events:?}"
    );
    assert!(
        is_render_terminal_event(events.last().expect("terminal event must exist")),
        "terminal event must be last: {events:?}"
    );
}

async fn probe_and_validate_system_render(
    path: &Path,
    validated: &super::render::ValidatedRenderPlan,
    operation: &'static str,
) -> InspectedMedia {
    let inspected = probe_trusted_media_with_program(
        path,
        OsString::from("ffprobe"),
        ProcessCancellation::new(),
        operation,
    )
    .await
    .expect("render artifact must probe through the supervised system FFprobe");
    validate_render_output(path, &inspected, validated)
        .expect("render artifact must satisfy the worker's verified output contract");
    inspected
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn render_worker_local_ffmpeg_exports_av_and_video_only_with_ordered_verified_events() {
    let source = canonical_media_fixture();
    for (audio, plan_id) in [
        (true, RENDER_AV_PLAN_ID),
        (false, RENDER_VIDEO_ONLY_PLAN_ID),
    ] {
        let workspace = tempdir().expect("render integration workspace must be created");
        let validated = validated_system_render_fixture(
            workspace.path(),
            &source,
            audio,
            plan_id,
            CANONICAL_RENDER_PROFILE,
        );
        let (request, _, captured) = registered_system_render_worker(
            validated.clone(),
            false,
            workspace.path().join("app-cache"),
        );

        run_render_worker(request).await;

        let events = captured_render_events(&captured);
        assert_worker_event_order(&events);
        let completed = match events.last().expect("completed event must exist") {
            VideoRenderEvent::Completed { output, .. } => output.clone(),
            other => panic!("valid system render must complete, got {other:?}"),
        };
        assert_eq!(
            completed.output_path,
            validated.output_path.to_string_lossy()
        );
        let preview_path = PathBuf::from(&completed.preview_path);
        let final_inspected = probe_and_validate_system_render(
            &validated.output_path,
            &validated,
            "probe_render_final_integration",
        )
        .await;
        let preview_inspected = probe_and_validate_system_render(
            &preview_path,
            &validated,
            "probe_render_preview_integration",
        )
        .await;
        assert_eq!(completed.probe, preview_inspected.probe);
        assert_eq!(final_inspected.probe, preview_inspected.probe);
        assert_eq!(final_inspected.probe.audio.is_some(), audio);
        assert_eq!(
            fs::read(&validated.output_path).expect("final render must be readable"),
            fs::read(&preview_path).expect("preview render must be readable"),
            "preview must be a verified copy of the final render"
        );
        assert!(
            !partial_render_path(&validated)
                .expect("partial path must derive")
                .exists(),
            "successful worker must promote and remove its partial"
        );
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn render_worker_local_ffmpeg_preserves_no_overwrite_collision() {
    let workspace = tempdir().expect("render collision workspace must be created");
    let validated = validated_system_render_fixture(
        workspace.path(),
        &canonical_media_fixture(),
        true,
        RENDER_COLLISION_PLAN_ID,
        CANONICAL_RENDER_PROFILE,
    );
    let preserved = b"pre-existing export must survive";
    fs::write(&validated.output_path, preserved).expect("collision destination must be written");
    let partial_path = partial_render_path(&validated).expect("partial path must derive");
    let (request, _, captured) = registered_system_render_worker(
        validated.clone(),
        false,
        workspace.path().join("app-cache"),
    );

    run_render_worker(request).await;

    let events = captured_render_events(&captured);
    assert_worker_event_order(&events);
    match events.last().expect("failed event must exist") {
        VideoRenderEvent::Failed { error, .. } => {
            assert_eq!(error.code, VideoErrorCode::OutputExists)
        }
        other => panic!("no-overwrite collision must fail, got {other:?}"),
    }
    assert_eq!(
        fs::read(&validated.output_path).expect("collision destination must remain readable"),
        preserved
    );
    assert!(
        !partial_path.exists(),
        "failed no-overwrite promotion must clean the owned partial"
    );
    assert!(
        !workspace
            .path()
            .join("app-cache/video-phase1/render-preview")
            .exists(),
        "failed promotion must not create a preview"
    );
}

fn create_long_canonical_render_source(destination: &Path) {
    let source = canonical_media_fixture();
    let mut args = vec![
        OsString::from("-hide_banner"),
        OsString::from("-loglevel"),
        OsString::from("error"),
        OsString::from("-nostdin"),
        OsString::from("-y"),
        OsString::from("-stream_loop"),
        OsString::from("-1"),
        OsString::from("-i"),
        source.as_os_str().to_owned(),
        OsString::from("-t"),
        OsString::from("30.000000"),
        OsString::from("-map"),
        OsString::from("0:v:0"),
        OsString::from("-map"),
        OsString::from("0:a:0"),
        OsString::from("-c:v"),
        OsString::from("libx264"),
        OsString::from("-preset"),
        OsString::from("ultrafast"),
        OsString::from("-pix_fmt"),
        OsString::from("yuv420p"),
        OsString::from("-r"),
        OsString::from("30"),
        OsString::from("-c:a"),
        OsString::from("aac"),
        OsString::from("-ar"),
        OsString::from("48000"),
        OsString::from("-movflags"),
        OsString::from("+faststart"),
    ];
    args.push(destination.as_os_str().to_owned());
    run_local_ffmpeg(args);
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn render_worker_local_ffmpeg_cancellation_reaps_process_and_cleans_partial_once() {
    let workspace = tempdir().expect("render cancellation workspace must be created");
    let long_source = workspace.path().join("long-canonical-source.mp4");
    create_long_canonical_render_source(&long_source);
    let validated = validated_system_render_fixture(
        workspace.path(),
        &long_source,
        true,
        RENDER_CANCELLATION_PLAN_ID,
        CANCELLATION_RENDER_PROFILE,
    );
    let output_path = validated.output_path.clone();
    let partial_path = partial_render_path(&validated).expect("partial path must derive");
    let (request, jobs, captured) =
        registered_system_render_worker(validated, false, workspace.path().join("app-cache"));
    let worker = tokio::spawn(run_render_worker(request));
    let deadline = tokio::time::Instant::now() + Duration::from_secs(15);

    loop {
        let saw_incomplete_progress = captured
            .lock()
            .expect("integration event capture must lock")
            .iter()
            .any(|event| {
                matches!(
                    event,
                    VideoRenderEvent::Progress {
                        completed_microseconds,
                        duration_microseconds: 30_000_000,
                        ..
                    } if *completed_microseconds > 0 && *completed_microseconds < 30_000_000
                )
            });
        if saw_incomplete_progress {
            break;
        }
        if worker.is_finished() {
            worker
                .await
                .expect("render worker task must join before early completion failure");
            panic!("long real render completed before cancellation could be exercised");
        }
        if tokio::time::Instant::now() >= deadline {
            jobs.cancel(RENDER_INTEGRATION_OWNER, RENDER_CANCELLATION_PLAN_ID)
                .expect("timed-out integration worker must cancel");
            worker
                .await
                .expect("timed-out integration worker task must join");
            panic!("long real render emitted no cancellable progress before the deadline");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    jobs.cancel(RENDER_INTEGRATION_OWNER, RENDER_CANCELLATION_PLAN_ID)
        .expect("active integration render must cancel");
    worker
        .await
        .expect("cancelled integration worker task must join");

    let events = captured_render_events(&captured);
    assert_worker_event_order(&events);
    assert!(
        matches!(events.last(), Some(VideoRenderEvent::Cancelled { .. })),
        "cancelled must be the sole terminal event: {events:?}"
    );
    assert!(
        !output_path.exists(),
        "cancelled worker must not commit output"
    );
    assert!(
        !partial_path.exists(),
        "cancelled worker must clean its owned partial after reaping FFmpeg"
    );
    fs::remove_file(&long_source)
        .expect("reaped FFmpeg must release the generated source file handle");
    tokio::time::sleep(Duration::from_millis(250)).await;
    assert!(
        !partial_path.exists(),
        "no surviving FFmpeg process may recreate or continue writing the partial"
    );
    assert_eq!(
        captured_render_events(&captured).len(),
        events.len(),
        "no event may arrive after the cancelled terminal event"
    );
}

const PROCESS_HELPER_MODE_ENV: &str = "SUPA_VIDEO_PROCESS_HELPER_MODE";
const PROCESS_HELPER_MARKER_ENV: &str = "SUPA_VIDEO_PROCESS_HELPER_MARKER";
const PROCESS_HELPER_READY_MARKER_ENV: &str = "SUPA_VIDEO_PROCESS_HELPER_READY_MARKER";
const PROCESS_HELPER_SURVIVOR_MARKER_ENV: &str = "SUPA_VIDEO_PROCESS_HELPER_SURVIVOR_MARKER";
const PROCESS_TREE_DESCENDANT_SURVIVAL_DELAY: Duration = Duration::from_secs(4);
const PROCESS_TREE_PIPE_RELEASE_DEADLINE: Duration = Duration::from_secs(3);

fn helper_process_args() -> Vec<OsString> {
    [
        "--exact",
        "video::tests::supervised_process_helper",
        "--nocapture",
        "--test-threads=1",
    ]
    .into_iter()
    .map(OsString::from)
    .collect()
}

fn helper_process_spec(
    timeout: Duration,
    stdout_limit: usize,
    stderr_tail_limit: usize,
    operation: &'static str,
) -> ProcessSpec {
    ProcessSpec {
        program: env::current_exe()
            .expect("current test executable must be available")
            .into_os_string(),
        args: helper_process_args(),
        operation,
        timeout,
        stdout_limit,
        stderr_tail_limit,
    }
}

fn helper_process_environment(
    mode: &str,
    marker: Option<&Path>,
) -> Vec<(OsString, Option<OsString>)> {
    vec![
        (
            OsString::from(PROCESS_HELPER_MODE_ENV),
            Some(OsString::from(mode)),
        ),
        (
            OsString::from(PROCESS_HELPER_MARKER_ENV),
            marker.map(|path| path.as_os_str().to_owned()),
        ),
    ]
}

async fn run_helper_process(
    mode: &str,
    timeout: Duration,
    stdout_limit: usize,
    stderr_tail_limit: usize,
    cancellation: ProcessCancellation,
    operation: &'static str,
    marker: Option<&Path>,
) -> Result<SupervisedOutput, ProcessFailure> {
    run_supervised_with_test_environment(
        helper_process_spec(timeout, stdout_limit, stderr_tail_limit, operation),
        cancellation,
        helper_process_environment(mode, marker),
    )
    .await
}

fn process_tree_environment(
    ready_marker: &Path,
    survivor_marker: &Path,
) -> Vec<(OsString, Option<OsString>)> {
    let mut environment = helper_process_environment("process_tree_parent", None);
    environment.extend([
        (
            OsString::from(PROCESS_HELPER_READY_MARKER_ENV),
            Some(ready_marker.as_os_str().to_owned()),
        ),
        (
            OsString::from(PROCESS_HELPER_SURVIVOR_MARKER_ENV),
            Some(survivor_marker.as_os_str().to_owned()),
        ),
    ]);
    environment
}

fn process_tree_parent() {
    let ready_marker = env::var_os(PROCESS_HELPER_READY_MARKER_ENV)
        .expect("process-tree ready marker must be configured");
    let survivor_marker = env::var_os(PROCESS_HELPER_SURVIVOR_MARKER_ENV)
        .expect("process-tree survivor marker must be configured");
    let mut grandchild = Command::new(
        env::current_exe().expect("current test executable must be available to the helper"),
    );
    grandchild
        .args(helper_process_args())
        .env(PROCESS_HELPER_MODE_ENV, "process_tree_grandchild")
        .env(PROCESS_HELPER_SURVIVOR_MARKER_ENV, survivor_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut grandchild = grandchild
        .spawn()
        .expect("process-tree grandchild must spawn without a shell");
    fs::write(ready_marker, b"ready")
        .expect("process-tree ready marker must be writable after grandchild spawn");

    thread::sleep(Duration::from_secs(30));
    let _ = grandchild.kill();
    let _ = grandchild.wait();
}

fn process_tree_grandchild() {
    print!("grandchild-inherited-stdout");
    std::io::stdout()
        .flush()
        .expect("grandchild stdout must flush");
    eprint!("grandchild-inherited-stderr");
    std::io::stderr()
        .flush()
        .expect("grandchild stderr must flush");

    thread::sleep(PROCESS_TREE_DESCENDANT_SURVIVAL_DELAY);
    let survivor_marker = env::var_os(PROCESS_HELPER_SURVIVOR_MARKER_ENV)
        .expect("process-tree survivor marker must be configured");
    fs::write(survivor_marker, b"survived").expect("process-tree survivor marker must be writable");
}

#[test]
fn supervised_process_helper() {
    let Ok(mode) = env::var(PROCESS_HELPER_MODE_ENV) else {
        return;
    };
    match mode.as_str() {
        "success" => {
            print!("supervised-capture");
            std::io::stdout().flush().expect("stdout must flush");
        }
        "nonzero" => std::process::exit(23),
        "stdout_limit" => {
            std::io::stdout()
                .write_all(&vec![b'o'; 128 * 1024])
                .expect("stdout must accept helper bytes");
            std::io::stdout().flush().expect("stdout must flush");
            thread::sleep(Duration::from_secs(2));
        }
        "progress_stream" => {
            for index in 1..=5_000 {
                println!("out_time_us={index}\nprogress=continue");
            }
            println!("progress=end");
        }
        "progress_overlong" => {
            std::io::stdout()
                .write_all(&vec![b'p'; 8 * 1024])
                .expect("stdout must accept overlong progress line");
            std::io::stdout().flush().expect("stdout must flush");
            thread::sleep(Duration::from_secs(2));
        }
        "stderr_tail" => {
            std::io::stderr()
                .write_all(&vec![b'e'; 128 * 1024])
                .expect("stderr must accept helper bytes");
            std::io::stderr().flush().expect("stderr must flush");
        }
        "wait" => {
            thread::sleep(Duration::from_secs(2));
            if let Ok(marker) = env::var(PROCESS_HELPER_MARKER_ENV) {
                fs::write(marker, b"survived").expect("helper marker must be writable");
            }
        }
        "process_tree_parent" => process_tree_parent(),
        "process_tree_grandchild" => process_tree_grandchild(),
        other => panic!("unknown process helper mode: {other}"),
    }
}

#[tokio::test(flavor = "current_thread")]
async fn supervisor_captures_bounds_terminates_cancels_and_reaps_without_shell() {
    let success = run_helper_process(
        "success",
        Duration::from_secs(5),
        64 * 1024,
        64 * 1024,
        ProcessCancellation::new(),
        "helper_success",
        None,
    )
    .await
    .expect("successful helper must settle");
    assert!(success.status.success());
    assert!(
        String::from_utf8_lossy(&success.stdout).contains("supervised-capture"),
        "helper stdout must be captured"
    );
    assert!(!success.stderr_truncated);

    let nonzero = run_helper_process(
        "nonzero",
        Duration::from_secs(5),
        64 * 1024,
        64 * 1024,
        ProcessCancellation::new(),
        "helper_nonzero",
        None,
    )
    .await
    .expect_err("nonzero helper must fail");
    match nonzero {
        ProcessFailure::NonZero {
            operation,
            exit_code,
            ..
        } => {
            assert_eq!(operation, "helper_nonzero");
            assert_eq!(exit_code, Some(23));
        }
        other => panic!("unexpected nonzero result: {other:?}"),
    }

    let output_limit = run_helper_process(
        "stdout_limit",
        Duration::from_secs(5),
        1_024,
        4_096,
        ProcessCancellation::new(),
        "helper_output_limit",
        None,
    )
    .await
    .expect_err("oversized stdout must fail");
    assert!(matches!(
        output_limit,
        ProcessFailure::StdoutLimit {
            operation: "helper_output_limit",
            limit: 1_024
        }
    ));

    let stderr = run_helper_process(
        "stderr_tail",
        Duration::from_secs(5),
        64 * 1024,
        4_096,
        ProcessCancellation::new(),
        "helper_stderr",
        None,
    )
    .await
    .expect("large stderr must be drained");
    assert!(stderr.stderr_truncated);
    assert_eq!(stderr.stderr_tail.len(), 4_096);

    let directory = tempdir().expect("marker directory must be created");
    let timeout_marker = directory.path().join("timeout-survivor");
    let timed_out = run_helper_process(
        "wait",
        Duration::from_millis(100),
        64 * 1024,
        4_096,
        ProcessCancellation::new(),
        "helper_timeout",
        Some(&timeout_marker),
    )
    .await
    .expect_err("slow helper must time out");
    assert!(matches!(
        timed_out,
        ProcessFailure::Timeout {
            operation: "helper_timeout"
        }
    ));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!timeout_marker.exists(), "timed-out child must be reaped");

    let cancel_marker = directory.path().join("cancel-survivor");
    let cancellation = ProcessCancellation::new();
    let trigger = cancellation.clone();
    let run = run_supervised_with_test_environment(
        helper_process_spec(Duration::from_secs(5), 64 * 1024, 4_096, "helper_cancel"),
        cancellation,
        helper_process_environment("wait", Some(&cancel_marker)),
    );
    let cancel = async move {
        tokio::time::sleep(Duration::from_millis(100)).await;
        trigger.cancel();
        trigger.cancel();
    };
    let (cancelled, ()) = tokio::join!(run, cancel);
    assert!(matches!(
        cancelled.expect_err("cancelled helper must fail"),
        ProcessFailure::Cancelled {
            operation: "helper_cancel"
        }
    ));
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert!(!cancel_marker.exists(), "cancelled child must be reaped");

    for index in 0..2 {
        let marker = directory.path().join(format!("repeat-survivor-{index}"));
        let result = run_helper_process(
            "wait",
            Duration::from_millis(75),
            64 * 1024,
            4_096,
            ProcessCancellation::new(),
            "helper_repeat",
            Some(&marker),
        )
        .await;
        assert!(matches!(result, Err(ProcessFailure::Timeout { .. })));
        assert!(!marker.exists(), "settled child must not survive return");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn streaming_supervisor_discards_progress_and_rejects_overlong_records() {
    let records = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
    let captured = records.clone();
    let observer: StdoutRecordObserver = Arc::new(move |record| {
        captured
            .lock()
            .expect("record capture must lock")
            .push(record.to_vec());
    });
    let output = run_supervised_streaming_with_test_environment(
        helper_process_spec(Duration::from_secs(5), 1_024, 4_096, "progress_stream"),
        ProcessCancellation::new(),
        helper_process_environment("progress_stream", None),
        observer,
    )
    .await
    .expect("bounded progress stream must succeed");
    assert!(
        output.stdout.is_empty(),
        "streaming mode must not retain stdout"
    );
    {
        let captured = records.lock().expect("record capture must lock");
        assert!(captured.len() >= 5_001);
        assert!(captured
            .iter()
            .any(|record| record.ends_with(b"progress=end\n")));
    }

    let observer: StdoutRecordObserver = Arc::new(|_| {});
    let overlong = run_supervised_streaming_with_test_environment(
        helper_process_spec(Duration::from_secs(5), 1_024, 4_096, "progress_overlong"),
        ProcessCancellation::new(),
        helper_process_environment("progress_overlong", None),
        observer,
    )
    .await
    .expect_err("overlong unterminated record must fail");
    assert!(matches!(
        overlong,
        ProcessFailure::StdoutLimit {
            operation: "progress_overlong",
            limit: 1_024
        }
    ));
}

#[cfg(any(unix, windows))]
async fn wait_for_process_tree_ready(marker: &Path) -> bool {
    let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
    loop {
        if marker.exists() {
            return true;
        }
        if tokio::time::Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

#[cfg(any(unix, windows))]
async fn assert_process_tree_descendant_was_terminated(survivor_marker: &Path) {
    tokio::time::sleep(PROCESS_TREE_DESCENDANT_SURVIVAL_DELAY + Duration::from_millis(250)).await;
    assert!(
        !survivor_marker.exists(),
        "descendant survived process-tree termination"
    );
}

#[cfg(any(unix, windows))]
#[tokio::test(flavor = "current_thread")]
async fn supervisor_timeout_terminates_grandchild_and_releases_inherited_pipes() {
    let directory = tempdir().expect("process-tree marker directory must be created");
    let ready_marker = directory.path().join("timeout-grandchild-ready");
    let survivor_marker = directory.path().join("timeout-grandchild-survived");
    let run = run_supervised_with_test_environment(
        helper_process_spec(
            Duration::from_millis(1_500),
            64 * 1024,
            4_096,
            "helper_tree_timeout",
        ),
        ProcessCancellation::new(),
        process_tree_environment(&ready_marker, &survivor_marker),
    );

    let result = tokio::time::timeout(PROCESS_TREE_PIPE_RELEASE_DEADLINE, run)
        .await
        .expect("timeout termination must close grandchild-inherited stdout and stderr pipes")
        .expect_err("process tree must time out");
    assert!(matches!(
        result,
        ProcessFailure::Timeout {
            operation: "helper_tree_timeout"
        }
    ));
    assert!(
        ready_marker.exists(),
        "grandchild must start before timeout termination"
    );
    assert_process_tree_descendant_was_terminated(&survivor_marker).await;
}

#[cfg(any(unix, windows))]
#[tokio::test(flavor = "current_thread")]
async fn supervisor_cancellation_terminates_grandchild_and_releases_inherited_pipes() {
    let directory = tempdir().expect("process-tree marker directory must be created");
    let ready_marker = directory.path().join("cancel-grandchild-ready");
    let survivor_marker = directory.path().join("cancel-grandchild-survived");
    let cancellation = ProcessCancellation::new();
    let trigger = cancellation.clone();
    let run = run_supervised_with_test_environment(
        helper_process_spec(
            Duration::from_secs(15),
            64 * 1024,
            4_096,
            "helper_tree_cancel",
        ),
        cancellation,
        process_tree_environment(&ready_marker, &survivor_marker),
    );
    let cancel_after_grandchild_starts = async {
        let ready = wait_for_process_tree_ready(&ready_marker).await;
        trigger.cancel();
        ready
    };

    let (result, ready) = tokio::time::timeout(PROCESS_TREE_PIPE_RELEASE_DEADLINE, async {
        tokio::join!(run, cancel_after_grandchild_starts)
    })
    .await
    .expect("cancellation must close grandchild-inherited stdout and stderr pipes");
    assert!(ready, "grandchild must start before cancellation");
    assert!(matches!(
        result.expect_err("process tree must be cancelled"),
        ProcessFailure::Cancelled {
            operation: "helper_tree_cancel"
        }
    ));
    assert_process_tree_descendant_was_terminated(&survivor_marker).await;
}

#[test]
fn tool_checks_normalize_banners_and_classify_safe_failures() {
    let ffmpeg = parse_tool_banner(
        VideoTool::Ffmpeg,
        b"  ffmpeg version 8.1.2 Copyright ignored\r\nbuild configuration secret\n",
    );
    assert!(ffmpeg.available);
    assert_eq!(
        ffmpeg.version.as_deref(),
        Some("ffmpeg version 8.1.2 Copyright ignored")
    );
    assert_eq!(ffmpeg.problem, None);

    let wrong = parse_tool_banner(VideoTool::Ffprobe, b"ffmpeg version 8.1.2\n");
    assert_eq!(wrong.problem, Some(VideoToolProblem::InvalidVersion));

    let missing = tool_info_from_result(
        VideoTool::Ffprobe,
        Err(ProcessFailure::Spawn {
            operation: "check_ffprobe",
            kind: std::io::ErrorKind::NotFound,
        }),
    );
    assert_eq!(missing.problem, Some(VideoToolProblem::NotFound));

    let failed = tool_info_from_result(
        VideoTool::Ffprobe,
        Err(ProcessFailure::NonZero {
            operation: "check_ffprobe",
            exit_code: Some(1),
            stderr_tail: b"must never escape".to_vec(),
            stderr_truncated: false,
        }),
    );
    assert_eq!(failed.problem, Some(VideoToolProblem::Failed));

    let timed_out = tool_info_from_result(
        VideoTool::Ffprobe,
        Err(ProcessFailure::Timeout {
            operation: "check_ffprobe",
        }),
    );
    assert_eq!(timed_out.problem, Some(VideoToolProblem::TimedOut));
}

#[tokio::test(flavor = "current_thread")]
async fn probe_authorizes_owner_source_before_spawning_and_redacts_failures() {
    let directory = tempdir().expect("temporary directory must be created");
    let source = directory.path().join("private-source.mp4");
    fs::write(&source, b"not media").expect("source fixture must be writable");
    let grants = VideoPathGrants::default();
    let missing_program = OsString::from("__supa_video_missing_ffprobe_executable__");

    let denied = probe_media_with_program(
        "main",
        &grants,
        &source,
        missing_program.clone(),
        ProcessCancellation::new(),
    )
    .await
    .expect_err("ungranted source must fail before process spawn");
    assert_eq!(denied.code, VideoErrorCode::PathNotGranted);

    grants
        .grant_existing_file("main", GrantCategory::Source, &source)
        .expect("source grant must succeed");
    let unavailable = probe_media_with_program(
        "main",
        &grants,
        &source,
        missing_program,
        ProcessCancellation::new(),
    )
    .await
    .expect_err("missing granted ffprobe must be typed");
    assert_eq!(unavailable.code, VideoErrorCode::ToolUnavailable);
    let serialized = serde_json::to_string(&unavailable).expect("error must serialize");
    assert!(!serialized.contains("private-source"));
    assert!(!serialized.contains("missing_ffprobe_executable"));
    assert!(!serialized.contains("not media"));
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn local_ffmpeg_status_and_canonical_probe_match_fixture() {
    let status =
        video_ffmpeg_status_with_programs(OsString::from("ffmpeg"), OsString::from("ffprobe"))
            .await;
    assert!(status.ready, "system FFmpeg tools must be available");
    assert!(status.ffmpeg.available);
    assert!(status.ffprobe.available);

    let source =
        workspace_root().join("apps/desktop/src-tauri/fixtures/video-phase1/single-clip.mp4");
    let grants = VideoPathGrants::default();
    grants
        .grant_existing_file("integration", GrantCategory::Source, &source)
        .expect("canonical source must be granted");
    let probe = probe_media_with_program(
        "integration",
        &grants,
        &source,
        OsString::from("ffprobe"),
        ProcessCancellation::new(),
    )
    .await
    .expect("canonical source must probe");

    assert_eq!(probe.duration_microseconds, 2_000_000);
    assert_eq!(probe.width, 320);
    assert_eq!(probe.height, 180);
    assert_eq!(probe.video_codec_name, "h264");
    assert_eq!(probe.file_size_bytes, 129_211);
    assert_eq!(
        probe.average_frame_rate,
        RationalRate {
            numerator: 30,
            denominator: 1,
        }
    );
    assert_eq!(probe.real_frame_rate, probe.average_frame_rate);
    assert!(!probe.variable_frame_rate);
    let audio = probe.audio.expect("canonical fixture must contain audio");
    assert_eq!(audio.codec_name, "aac");
    assert_eq!(audio.channels, 1);
    assert_eq!(audio.sample_rate, 48_000);
}

async fn derived_probe_thumbnail_shape(path: &Path) -> Value {
    let spec = ProcessSpec {
        program: OsString::from("ffprobe"),
        args: vec![
            OsString::from("-v"),
            OsString::from("error"),
            OsString::from("-output_format"),
            OsString::from("json"),
            OsString::from("-select_streams"),
            OsString::from("v:0"),
            OsString::from("-show_entries"),
            OsString::from("stream=codec_name,width,height"),
            OsString::from("-i"),
            path.as_os_str().to_owned(),
        ],
        operation: "probe_thumbnail_integration",
        timeout: Duration::from_secs(30),
        stdout_limit: 64 * 1024,
        stderr_tail_limit: 64 * 1024,
    };
    let output = run_supervised(spec, ProcessCancellation::new())
        .await
        .expect("thumbnail must probe through the supervisor");
    serde_json::from_slice(&output.stdout).expect("thumbnail ffprobe JSON must parse")
}

fn run_local_ffmpeg(args: Vec<OsString>) {
    let output = Command::new("ffmpeg")
        .args(args)
        .stdin(Stdio::null())
        .output()
        .expect("system FFmpeg must start");
    assert!(
        output.status.success(),
        "system FFmpeg failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg with libx265, zscale, and tonemap support"]
async fn derived_local_ffmpeg_tone_maps_hdr_to_tagged_bt709_sdr() {
    let workspace = tempdir().expect("HDR integration workspace must be created");
    let source = workspace.path().join("hdr-source.mp4");
    let proxy = workspace.path().join("sdr-proxy.mp4");
    let mut source_args: Vec<OsString> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=320x180:rate=10:duration=1",
        "-vf",
        "format=yuv420p10le",
        "-c:v",
        "libx265",
        "-preset",
        "ultrafast",
        "-pix_fmt",
        "yuv420p10le",
        "-x265-params",
        "colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:range=limited",
        "-an",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    source_args.push(source.as_os_str().to_owned());
    run_local_ffmpeg(source_args);

    let source_inspected = probe_trusted_media_with_program(
        &source,
        OsString::from("ffprobe"),
        ProcessCancellation::new(),
        "probe_hdr_source_integration",
    )
    .await
    .expect("synthetic HDR source must probe");
    assert_eq!(source_inspected.color.color_range.as_deref(), Some("tv"));
    assert_eq!(
        source_inspected.color.color_space.as_deref(),
        Some("bt2020nc")
    );
    assert_eq!(
        source_inspected.color.color_primaries.as_deref(),
        Some("bt2020")
    );
    assert_eq!(
        source_inspected.color.color_transfer.as_deref(),
        Some("smpte2084")
    );
    assert!(source_inspected.color.is_hdr());

    let rate = RationalRate {
        numerator: 10,
        denominator: 1,
    };
    let dimensions = OutputDimensions {
        width: 320,
        height: 180,
    };
    run_local_ffmpeg(
        proxy_ffmpeg_args(
            &source,
            &proxy,
            dimensions,
            &rate,
            source_inspected.color.is_hdr(),
            source_inspected.video_stream_index,
            source_inspected.audio_stream_index,
        )
        .expect("HDR proxy argv must build"),
    );

    let proxy_inspected = probe_trusted_media_with_program(
        &proxy,
        OsString::from("ffprobe"),
        ProcessCancellation::new(),
        "probe_hdr_proxy_integration",
    )
    .await
    .expect("tone-mapped proxy must probe");
    assert_eq!(
        proxy_inspected.color,
        MediaColorMetadata {
            color_range: Some("tv".to_owned()),
            color_space: Some("bt709".to_owned()),
            color_primaries: Some("bt709".to_owned()),
            color_transfer: Some("bt709".to_owned()),
        }
    );
    assert!(!proxy_inspected.color.is_hdr());
    let byte_len = fs::metadata(&proxy)
        .expect("tone-mapped proxy metadata must exist")
        .len();
    assert_eq!(
        validate_proxy_artifact(
            ArtifactFileFacts {
                is_regular_file: true,
                byte_len,
            },
            &proxy_inspected,
            dimensions,
            &rate,
            1_000_000,
            false,
        ),
        Ok(())
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg with display-rotation and reset_sar support"]
async fn derived_local_ffmpeg_normalizes_rotated_and_anamorphic_sources() {
    let workspace = tempdir().expect("display geometry workspace must be created");
    let base = workspace.path().join("rotation-base.mp4");
    let rotated = workspace.path().join("rotated.mp4");
    let anamorphic = workspace.path().join("anamorphic.mp4");

    let generated_video_args = |filter_input: &str, destination: &Path| {
        let mut args: Vec<OsString> = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-nostdin",
            "-y",
            "-f",
            "lavfi",
            "-i",
            filter_input,
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-an",
        ]
        .into_iter()
        .map(OsString::from)
        .collect();
        args.push(destination.as_os_str().to_owned());
        args
    };
    run_local_ffmpeg(generated_video_args(
        "testsrc2=size=320x180:rate=10:duration=1",
        &base,
    ));
    let mut rotate_args: Vec<OsString> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-display_rotation",
        "90",
        "-i",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    rotate_args.push(base.as_os_str().to_owned());
    extend_os_tokens(&mut rotate_args, &["-map", "0:v:0", "-c", "copy"]);
    rotate_args.push(rotated.as_os_str().to_owned());
    run_local_ffmpeg(rotate_args);

    let mut anamorphic_args: Vec<OsString> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        "testsrc2=size=720x576:rate=10:duration=1",
        "-vf",
        "setsar=16/15",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-an",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    anamorphic_args.push(anamorphic.as_os_str().to_owned());
    run_local_ffmpeg(anamorphic_args);

    let cache_root = workspace.path().join("app-cache");
    let grants = VideoPathGrants::default();
    let cases = [
        (
            "rotated-integration",
            "33333333-3333-4333-8333-333333333333",
            rotated.as_path(),
            display_shape(1, 1, 16, 9, 90),
            OutputDimensions {
                width: 180,
                height: 320,
            },
        ),
        (
            "anamorphic-integration",
            "44444444-4444-4444-8444-444444444444",
            anamorphic.as_path(),
            display_shape(16, 15, 4, 3, 0),
            OutputDimensions {
                width: 720,
                height: 540,
            },
        ),
    ];

    for (owner, asset_id, source, expected_source_shape, expected_dimensions) in cases {
        let source_inspected = probe_trusted_media_with_program(
            source,
            OsString::from("ffprobe"),
            ProcessCancellation::new(),
            "probe_display_source_integration",
        )
        .await
        .expect("synthetic display source must probe");
        assert_eq!(source_inspected.display_shape, expected_source_shape);
        grants
            .grant_existing_file(owner, GrantCategory::Source, source)
            .expect("synthetic display source must be granted");
        let prepared = prepare_asset_core(
            PrepareAssetCoreRequest {
                owner_label: owner,
                project_id: DERIVED_PROJECT_ID,
                asset_id,
                source_path: source,
                sequence_rate: RationalRate {
                    numerator: 10,
                    denominator: 1,
                },
            },
            &grants,
            &cache_root,
            MediaPrograms {
                ffmpeg: OsString::from("ffmpeg"),
                ffprobe: OsString::from("ffprobe"),
            },
        )
        .await
        .expect("display source must prepare");
        assert_eq!(prepared.proxy_probe.width, expected_dimensions.width);
        assert_eq!(prepared.proxy_probe.height, expected_dimensions.height);

        let proxy_inspected = probe_trusted_media_with_program(
            Path::new(&prepared.proxy_path),
            OsString::from("ffprobe"),
            ProcessCancellation::new(),
            "probe_display_proxy_integration",
        )
        .await
        .expect("normalized display proxy must probe");
        assert_eq!(
            proxy_inspected.display_shape,
            display_shape(
                1,
                1,
                expected_dimensions.width,
                expected_dimensions.height,
                0,
            )
        );
        let thumbnail = derived_probe_thumbnail_shape(Path::new(&prepared.thumbnail_path)).await;
        assert_eq!(thumbnail["streams"][0]["width"], 1_600);
        assert_eq!(thumbnail["streams"][0]["height"], 90);
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn derived_local_ffmpeg_prepares_reuses_and_repairs_controlled_artifacts() {
    let workspace = tempdir().expect("derived integration workspace must be created");
    let cache_root = workspace.path().join("app-cache");
    let source =
        workspace_root().join("apps/desktop/src-tauri/fixtures/video-phase1/single-clip.mp4");
    let grants = VideoPathGrants::default();
    grants
        .grant_existing_file("derived-integration", GrantCategory::Source, &source)
        .expect("canonical source must be granted");
    let request = || PrepareAssetCoreRequest {
        owner_label: "derived-integration",
        project_id: DERIVED_PROJECT_ID,
        asset_id: DERIVED_ASSET_ID,
        source_path: &source,
        sequence_rate: RationalRate {
            numerator: 30,
            denominator: 1,
        },
    };
    let actual_programs = || MediaPrograms {
        ffmpeg: OsString::from("ffmpeg"),
        ffprobe: OsString::from("ffprobe"),
    };

    let prepared = prepare_asset_core(request(), &grants, &cache_root, actual_programs())
        .await
        .expect("canonical fixture must prepare");
    assert_eq!(prepared.proxy_probe.video_codec_name, "h264");
    assert_eq!(prepared.proxy_probe.width, 320);
    assert_eq!(prepared.proxy_probe.height, 180);
    assert_eq!(
        prepared.proxy_probe.average_frame_rate,
        RationalRate {
            numerator: 30,
            denominator: 1,
        }
    );
    assert_eq!(
        prepared.proxy_probe.real_frame_rate,
        prepared.proxy_probe.average_frame_rate
    );
    assert!(!prepared.proxy_probe.variable_frame_rate);
    assert_eq!(
        prepared
            .proxy_probe
            .audio
            .as_ref()
            .expect("prepared proxy must contain audio")
            .codec_name,
        "aac"
    );
    let proxy_path = PathBuf::from(&prepared.proxy_path);
    let thumbnail_path = PathBuf::from(&prepared.thumbnail_path);
    assert!(proxy_path.is_file());
    assert!(thumbnail_path.is_file());
    let thumbnail_probe = derived_probe_thumbnail_shape(&thumbnail_path).await;
    assert_eq!(thumbnail_probe["streams"][0]["codec_name"], "mjpeg");
    assert_eq!(thumbnail_probe["streams"][0]["width"], 1_600);
    assert_eq!(thumbnail_probe["streams"][0]["height"], 90);

    let profile_directory = proxy_path
        .parent()
        .expect("proxy must have a profile directory")
        .to_path_buf();
    let stale_proxy = profile_directory.join(format!("proxy-{}.mp4", derived_fingerprint_hex('e')));
    let stale_thumbnail =
        profile_directory.join(format!("thumbnail-{}.jpg", derived_fingerprint_hex('f')));
    let stale_partial =
        profile_directory.join(format!("proxy-{}.mp4", derived_fingerprint_hex('1')));
    for path in [&stale_proxy, &stale_thumbnail, &stale_partial] {
        fs::write(path, b"stale-owned-artifact").expect("stale artifact must be writable");
    }

    let reused = prepare_asset_core(
        request(),
        &grants,
        &cache_root,
        MediaPrograms {
            ffmpeg: OsString::from("missing-ffmpeg-proves-cache-reuse"),
            ffprobe: OsString::from("ffprobe"),
        },
    )
    .await
    .expect("valid prepared pair must be reused without ffmpeg");
    assert_eq!(reused, prepared);
    assert!(!stale_proxy.exists());
    assert!(!stale_thumbnail.exists());
    assert!(!stale_partial.exists());

    for path in [&stale_proxy, &stale_thumbnail, &stale_partial] {
        fs::write(path, b"stale-owned-artifact").expect("stale artifact must be writable");
    }
    fs::write(&proxy_path, b"corrupt-proxy").expect("proxy corruption must be injected");

    let repaired = prepare_asset_core(request(), &grants, &cache_root, actual_programs())
        .await
        .expect("corrupt prepared pair must be repaired");
    assert_eq!(repaired.proxy_path, prepared.proxy_path);
    assert_eq!(repaired.thumbnail_path, prepared.thumbnail_path);
    assert_eq!(repaired.proxy_probe.video_codec_name, "h264");
    assert_eq!(repaired.proxy_probe.width, 320);
    assert_eq!(repaired.proxy_probe.height, 180);
    assert!(!stale_proxy.exists());
    assert!(!stale_thumbnail.exists());
    assert!(!stale_partial.exists());
    let repaired_thumbnail_probe = derived_probe_thumbnail_shape(&thumbnail_path).await;
    assert_eq!(
        repaired_thumbnail_probe["streams"][0]["codec_name"],
        "mjpeg"
    );
    assert_eq!(repaired_thumbnail_probe["streams"][0]["width"], 1_600);
    assert_eq!(repaired_thumbnail_probe["streams"][0]["height"], 90);

    let mut remaining_owned = Vec::new();
    for entry in fs::read_dir(&profile_directory).expect("profile directory must remain readable") {
        let entry = entry.expect("profile entry must be readable");
        let name = entry.file_name().to_string_lossy().into_owned();
        assert!(
            !name.starts_with(".svp-video-"),
            "temporary artifact survived: {name}"
        );
        if name.starts_with("proxy-") || name.starts_with("thumbnail-") {
            remaining_owned.push(name);
        }
    }
    remaining_owned.sort();
    let mut expected_owned = vec![
        proxy_path
            .file_name()
            .expect("proxy filename must exist")
            .to_string_lossy()
            .into_owned(),
        thumbnail_path
            .file_name()
            .expect("thumbnail filename must exist")
            .to_string_lossy()
            .into_owned(),
    ];
    expected_owned.sort();
    assert_eq!(remaining_owned, expected_owned);
}
