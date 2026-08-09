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
    cache::{CacheArtifactKind, CacheArtifactRegistration, MediaCacheService},
    derived::{
        acquire_profile_cache_lock_with, artifact_paths, artifact_paths_in_validated_cache,
        cache_pair_is_valid_with, create_temp_artifacts, derive_media_identity,
        derive_profile_identity, derive_recipe_digest, duration_within_one_frame,
        ensure_profile_cache_directory, fit_proxy_dimensions, fit_proxy_dimensions_for_display,
        map_cache_error, one_frame_tolerance_microseconds, plan_asset_core, prepare_asset_core,
        prepare_asset_durable, prepared_asset_plan_fixture, promote_validated_pair,
        promote_validated_pair_with, proxy_ffmpeg_args, proxy_recipe, resume_durable_preparations,
        resume_durable_preparations_with_test_workers, run_derived_ffmpeg, source_fingerprint,
        source_fingerprint_with_profile, thumbnail_ffmpeg_args, thumbnail_recipe, unix_time_parts,
        validate_proxy_artifact, validate_thumbnail_artifact, ArtifactFileFacts,
        ArtifactValidationError, CacheLifecycleError, DerivedArtifactKind, DerivedArtifactPaths,
        DerivedModelError, MediaPrograms, OutputDimensions, PrepareAssetCoreRequest,
        SourceIdentity, ValidatedDerivedInput, PREVIEW_PROFILE,
    },
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
    jobs::{
        current_timestamp_millis,
        model::{
            MediaJobError, MediaJobErrorCategory, MediaJobEventType, MediaJobKind,
            MediaJobPriority, MediaJobProgress, MediaJobProgressUnit, MediaJobRecoveryAction,
            MediaJobState,
        },
        scheduler::{MediaJobWorker, MediaWorkerFuture, MediaWorkerOutcome, SchedulerResource},
        store::{MediaJobStore, MediaJobTransition, NewMediaJob},
        MediaJobService,
    },
    media_store::{
        acquire_artifact, ensure_direct_directory_for_test, ingest_blocking_for_test,
        ingest_with_failpoint_for_test, lock_file_for_test, source_fingerprint_bytes_for_test,
        source_fingerprint_for_test, ArtifactStoreKind, IngestFailpoint, PublicationFailpoint,
        MEDIA_STORE_NAMESPACE,
    },
    probe::{
        parse_ffprobe_json, parse_ffprobe_json_inspected, parse_thumbnail_artifact_json,
        parse_tool_banner, probe_media_with_program, probe_trusted_media_with_program,
        tool_info_from_result, video_ffmpeg_status_with_programs,
        video_tool_status_from_inspection, InspectedMedia, ThumbnailArtifactProbe, VideoTool,
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
        cancel_render_for_owner, create_owned_partial, ensure_preview_directory,
        map_render_preview_failure, parse_and_validate_render_plan, partial_render_path,
        promote_render_partial, promote_render_partial_if_active,
        promote_render_partial_if_active_with_hook, reauthorize_final_render_output_with_context,
        render_dedupe_key, render_execution_arguments, run_render_worker, validate_render_output,
        RenderEventSink, RenderProgress, RenderWorkerRequest,
    },
    toolchain::{
        MediaToolchain, MediaToolchainError, MediaToolchainInspection, MediaToolchainProblem,
    },
    types::{
        is_recognizable_absolute_path, parse_project_json, parse_project_value, MediaAudioShape,
        MediaColorMetadata, MediaContentAlgorithm, MediaContentIdentityV1, MediaDisplayShape,
        MediaProbe, RationalRate, VideoProjectFileV1, VideoRenderEvent, VideoToolProblem,
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

fn derived_valid_thumbnail_probe() -> ThumbnailArtifactProbe {
    ThumbnailArtifactProbe {
        file_size_bytes: 4_096,
        video_codec_name: "mjpeg".to_owned(),
        width: PREVIEW_PROFILE.thumbnail_count * PREVIEW_PROFILE.thumbnail_cell_width,
        height: PREVIEW_PROFILE.thumbnail_cell_height,
        decoded_frame_count: 1,
    }
}

fn derived_expected_dimensions() -> OutputDimensions {
    OutputDimensions {
        width: 1_280,
        height: 720,
    }
}

#[test]
fn thumbnail_probe_parser_requires_one_decoded_video_frame_with_bounded_shape_and_size() {
    let valid = br#"{
        "streams": [{
            "codec_type": "video",
            "codec_name": "mjpeg",
            "width": 1600,
            "height": 90,
            "nb_read_frames": "1"
        }]
    }"#;
    assert_eq!(
        parse_thumbnail_artifact_json(valid, 4_096),
        Ok(derived_valid_thumbnail_probe())
    );

    for invalid in [
        br#"{"streams": []}"#.as_slice(),
        br#"{"streams": [{"codec_type":"audio","codec_name":"mjpeg","width":1600,"height":90,"nb_read_frames":"1"}]}"#.as_slice(),
        br#"{"streams": [{"codec_type":"video","codec_name":"mjpeg","width":0,"height":90,"nb_read_frames":"1"}]}"#.as_slice(),
        br#"{"streams": [{"codec_type":"video","codec_name":"mjpeg","width":1600,"height":90}]}"#.as_slice(),
    ] {
        assert!(parse_thumbnail_artifact_json(invalid, 4_096).is_err());
    }
    assert!(parse_thumbnail_artifact_json(valid, 0).is_err());
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
fn derived_proxy_and_thumbnail_artifact_validators_reject_invalid_shapes() {
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
    let valid_thumbnail = derived_valid_thumbnail_probe();
    assert_eq!(
        validate_thumbnail_artifact(
            expected,
            expected,
            derived_valid_file_facts(),
            &valid_thumbnail,
        ),
        Ok(())
    );
    assert_eq!(
        validate_thumbnail_artifact(
            Path::new("cache/other.jpg"),
            expected,
            derived_valid_file_facts(),
            &valid_thumbnail,
        ),
        Err(ArtifactValidationError::Path)
    );
    assert_eq!(
        validate_thumbnail_artifact(
            Path::new("cache/thumbnail-fingerprint.png"),
            Path::new("cache/thumbnail-fingerprint.png"),
            derived_valid_file_facts(),
            &valid_thumbnail,
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
            &valid_thumbnail,
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
            &valid_thumbnail,
        ),
        Err(ArtifactValidationError::NotRegularFile)
    );

    let mut wrong_probe_size = valid_thumbnail.clone();
    wrong_probe_size.file_size_bytes -= 1;
    assert_eq!(
        validate_thumbnail_artifact(
            expected,
            expected,
            derived_valid_file_facts(),
            &wrong_probe_size,
        ),
        Err(ArtifactValidationError::ProbeSizeMismatch)
    );
    let mut wrong_codec = valid_thumbnail.clone();
    wrong_codec.video_codec_name = "png".to_owned();
    assert_eq!(
        validate_thumbnail_artifact(expected, expected, derived_valid_file_facts(), &wrong_codec,),
        Err(ArtifactValidationError::VideoCodec)
    );
    let mut multiple_frames = valid_thumbnail.clone();
    multiple_frames.decoded_frame_count = 2;
    assert_eq!(
        validate_thumbnail_artifact(
            expected,
            expected,
            derived_valid_file_facts(),
            &multiple_frames,
        ),
        Err(ArtifactValidationError::FrameCount)
    );
    for wrong_dimensions in [
        ThumbnailArtifactProbe {
            width: valid_thumbnail.width - 1,
            ..valid_thumbnail.clone()
        },
        ThumbnailArtifactProbe {
            height: valid_thumbnail.height + 1,
            ..valid_thumbnail.clone()
        },
    ] {
        assert_eq!(
            validate_thumbnail_artifact(
                expected,
                expected,
                derived_valid_file_facts(),
                &wrong_dimensions,
            ),
            Err(ArtifactValidationError::Dimensions)
        );
    }
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
    MediaPrograms::explicit(
        OsString::from("missing-private-ffmpeg-secret"),
        OsString::from("missing-private-ffprobe-secret"),
    )
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
            sequence_rate: Some(derived_rate()),
            expected_content_identity: None,
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
            sequence_rate: Some(derived_rate()),
            expected_content_identity: None,
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
            sequence_rate: Some(RationalRate {
                numerator: 60,
                denominator: 2,
            }),
            expected_content_identity: None,
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
async fn derived_prepare_missing_ffprobe_is_typed_redacted_after_safe_ingest() {
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
            sequence_rate: Some(derived_rate()),
            expected_content_identity: None,
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
    let store = cache_root.join(MEDIA_STORE_NAMESPACE);
    assert!(
        store.join("objects").is_dir(),
        "authorized bytes must ingest before managed probing"
    );
    assert!(
        !store.join("derived").exists(),
        "tool failure must precede derived artifact creation"
    );
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

fn hidden_render_plan_value(input: &Path, output: &Path, audio: bool, plan_id: &str) -> Value {
    with_hidden_render_video(render_plan_value(input, output, audio, plan_id))
}

fn with_hidden_render_video(mut plan: Value) -> Value {
    plan["expected"]["videoHidden"] = Value::Bool(true);
    let filter = plan["argv"]
        .as_array_mut()
        .and_then(|arguments| {
            arguments.iter_mut().find(|argument| {
                argument
                    .as_str()
                    .is_some_and(|value| value.starts_with("scale="))
            })
        })
        .expect("test render filter must exist");
    *filter = Value::String(
        filter
            .as_str()
            .expect("test render filter must be text")
            .replace(
                ",fps=",
                ",drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill,fps=",
            ),
    );
    plan
}

fn multitrack_render_plan_value(top: &Path, bottom: &Path, output: &Path) -> Value {
    let top = top.to_string_lossy().into_owned();
    let bottom = bottom.to_string_lossy().into_owned();
    let output = output.to_string_lossy().into_owned();
    let top_asset = "55555555-5555-4555-8555-555555555555";
    let bottom_asset = "66666666-6666-4666-8666-666666666666";
    let filter = "color=c=black:s=1280x720:r=30/1:d=2.000000[base];[0:v:0]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,colorchannelmixer=aa=0.425,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30/1[v0];[0:a:0]asetpts=PTS-STARTPTS[a0];[1:v:0]setpts=PTS-STARTPTS,scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,colorchannelmixer=aa=0.000,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30/1[v1];[base][v1]overlay=0:0:format=auto[stack0];[stack0][v0]overlay=0:0:format=auto[stack1];[stack1]null[vout];[a0]anull[aout]";
    serde_json::json!({
        "schemaVersion": 2,
        "planId": RENDER_PLAN_ID,
        "revisionId": RENDER_REVISION_ID,
        "executable": "ffmpeg",
        "inputPathsByAssetId": { (top_asset): top, (bottom_asset): bottom },
        "videoInputs": [
            { "assetId": top_asset, "path": top, "sourceInMicroseconds": 0, "positionXPermille": 0, "positionYPermille": 0, "scaleXPermille": 1_000, "scaleYPermille": 1_000, "rotationMilliDegrees": 0, "opacityPermille": 425, "hidden": false, "muted": false, "hasAudio": true },
            { "assetId": bottom_asset, "path": bottom, "sourceInMicroseconds": 1_000_000, "positionXPermille": 0, "positionYPermille": 0, "scaleXPermille": 1_000, "scaleYPermille": 1_000, "rotationMilliDegrees": 0, "opacityPermille": 0, "hidden": false, "muted": true, "hasAudio": true }
        ],
        "outputPath": output,
        "expected": {
            "durationFrames": 60,
            "rate": { "numerator": 30, "denominator": 1 },
            "width": 1280,
            "height": 720,
            "audio": true
        },
        "argv": [
            "-hide_banner", "-nostdin", "-loglevel", "warning", "-progress", "pipe:1", "-nostats",
            "-ss", "0.000000", "-t", "2.000000", "-i", top,
            "-ss", "1.000000", "-t", "2.000000", "-i", bottom,
            "-filter_complex", filter, "-map", "[vout]", "-map", "[aout]", "-t", "2.000000",
            "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-ar", "48000",
            "-movflags", "+faststart", output
        ]
    })
}

fn granted_multitrack_render_plan(directory: &Path) -> (VideoPathGrants, Value) {
    let top = directory.join("opacity-top.mp4");
    let bottom = directory.join("opacity-bottom.mp4");
    let output = directory.join("opacity-output.mp4");
    fs::write(&top, b"top").expect("opacity top source must be written");
    fs::write(&bottom, b"bottom").expect("opacity bottom source must be written");
    let grants = VideoPathGrants::default();
    let top = grants
        .grant_existing_file("owner", GrantCategory::Source, &top)
        .expect("opacity top source must grant");
    let bottom = grants
        .grant_existing_file("owner", GrantCategory::Source, &bottom)
        .expect("opacity bottom source must grant");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("opacity output must grant");
    let plan = multitrack_render_plan_value(&top, &bottom, &output);
    (grants, plan)
}

fn multitrack_filter_mut(plan: &mut Value) -> &mut Value {
    plan["argv"]
        .as_array_mut()
        .and_then(|arguments| {
            arguments.iter_mut().find(|argument| {
                argument
                    .as_str()
                    .is_some_and(|value| value.starts_with("color="))
            })
        })
        .expect("multitrack filter must exist")
}

const RENDER_CAPTION_FILTER: &str = "drawtext=text='Path\\\\it\\'s\\: 50\\%\\, \\[yes\\]\\;\\nnext\\nline\\nend':fontcolor=white:fontsize=h/18:box=1:boxcolor=black@0.65:boxborderw=12:x=(w-text_w)/2:y=h-text_h-h/12:enable='between(t\\,0.250000\\,1.750000)'";

fn render_caption_value() -> Value {
    serde_json::json!({
        "trackId": "77777777-7777-4777-8777-777777777777",
        "captionId": "88888888-8888-4888-8888-888888888888",
        "startMicroseconds": 250_000,
        "endMicroseconds": 1_750_000,
        "text": "Path\\it's: 50%, [yes];\r\nnext\rline\nend"
    })
}

fn with_exact_render_caption(mut plan: Value) -> Value {
    plan["captions"] = Value::Array(vec![render_caption_value()]);
    let schema_version = plan["schemaVersion"]
        .as_u64()
        .expect("test render schema version must be numeric");
    let filter = plan["argv"]
        .as_array_mut()
        .and_then(|arguments| {
            arguments.iter_mut().find(|argument| {
                argument.as_str().is_some_and(|value| {
                    value.starts_with(if schema_version == 1 {
                        "scale="
                    } else {
                        "color="
                    })
                })
            })
        })
        .expect("test render filter must exist");
    let current = filter.as_str().expect("test render filter must be text");
    *filter = Value::String(if schema_version == 1 {
        format!("{current},{RENDER_CAPTION_FILTER}")
    } else {
        current.replace(
            ";[stack1]null[vout]",
            &format!(";[stack1]{RENDER_CAPTION_FILTER}[caption0];[caption0]null[vout]"),
        )
    });
    plan
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
            !validated
                .plan
                .argv()
                .iter()
                .any(|argument| argument == "-y"),
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
fn render_caption_metadata_exactly_binds_v1_and_v2_argv_and_escapes_drawtext() {
    let directory = tempdir().expect("caption render workspace must be created");
    let source = directory.path().join("caption-source.mp4");
    let top = directory.path().join("caption-top.mp4");
    let bottom = directory.path().join("caption-bottom.mp4");
    let v1_output = directory.path().join("caption-v1-output.mp4");
    let v2_output = directory.path().join("caption-v2-output.mp4");
    for (path, bytes) in [
        (&source, b"source".as_slice()),
        (&top, b"top".as_slice()),
        (&bottom, b"bottom".as_slice()),
    ] {
        fs::write(path, bytes).expect("caption source must be written");
    }
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file("owner", GrantCategory::Source, &source)
        .expect("caption source must grant");
    let top = grants
        .grant_existing_file("owner", GrantCategory::Source, &top)
        .expect("caption top source must grant");
    let bottom = grants
        .grant_existing_file("owner", GrantCategory::Source, &bottom)
        .expect("caption bottom source must grant");
    let v1_output = grants
        .grant_destination("owner", GrantCategory::Output, &v1_output)
        .expect("caption V1 output must grant");
    let v2_output = grants
        .grant_destination("owner", GrantCategory::Output, &v2_output)
        .expect("caption V2 output must grant");

    let v1_without_caption = render_plan_value(&source, &v1_output, true, RENDER_PLAN_ID);
    assert!(v1_without_caption.get("captions").is_none());
    let validated_without_caption =
        parse_and_validate_render_plan(v1_without_caption.clone(), "owner", &grants)
            .expect("omitted V1 captions must default to an empty exact chain");
    assert_eq!(
        serde_json::to_value(&validated_without_caption.plan).unwrap()["captions"],
        serde_json::json!([])
    );

    let v1_with_caption = with_exact_render_caption(v1_without_caption.clone());
    let validated_v1 = parse_and_validate_render_plan(v1_with_caption.clone(), "owner", &grants)
        .expect("exact shown V1 caption must validate");
    assert!(validated_v1
        .plan
        .argv()
        .iter()
        .any(|argument| argument.contains(RENDER_CAPTION_FILTER)));

    let v2_without_caption = multitrack_render_plan_value(&top, &bottom, &v2_output);
    assert!(v2_without_caption.get("captions").is_none());
    parse_and_validate_render_plan(v2_without_caption.clone(), "owner", &grants)
        .expect("omitted V2 captions must use stackN followed by null");
    let v2_with_caption = with_exact_render_caption(v2_without_caption.clone());
    let validated_v2 = parse_and_validate_render_plan(v2_with_caption.clone(), "owner", &grants)
        .expect("exact shown V2 caption chain must validate");
    assert!(validated_v2
        .plan
        .argv()
        .iter()
        .any(|argument| argument.contains(&format!(
            "[stack1]{RENDER_CAPTION_FILTER}[caption0];[caption0]null[vout]"
        ))));

    let mut metadata_only_v1 = v1_without_caption;
    metadata_only_v1["captions"] = Value::Array(vec![render_caption_value()]);
    let mut argv_only_v1 = v1_with_caption;
    argv_only_v1
        .as_object_mut()
        .expect("V1 plan must be an object")
        .remove("captions");
    let mut metadata_only_v2 = v2_without_caption;
    metadata_only_v2["captions"] = Value::Array(vec![render_caption_value()]);
    let mut argv_only_v2 = v2_with_caption;
    argv_only_v2
        .as_object_mut()
        .expect("V2 plan must be an object")
        .remove("captions");

    for forged in [
        metadata_only_v1,
        argv_only_v1,
        metadata_only_v2,
        argv_only_v2,
    ] {
        let error = parse_and_validate_render_plan(forged, "owner", &grants)
            .expect_err("forged caption metadata or argv must fail");
        assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
        assert_eq!(error.details["category"], "argv_grammar");
    }
}

#[test]
fn render_caption_validation_rejects_malformed_caption_metadata() {
    let directory = tempdir().expect("caption validation workspace must be created");
    let source = directory.path().join("caption-invalid-source.mp4");
    let output = directory.path().join("caption-invalid-output.mp4");
    fs::write(&source, b"source").expect("caption source must be written");
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file("owner", GrantCategory::Source, &source)
        .expect("caption source must grant");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("caption output must grant");
    let base = render_plan_value(&source, &output, true, RENDER_PLAN_ID);

    let mut malformed = Vec::new();
    for mutate in [
        ("text", Value::String(String::new())),
        ("text", Value::String("contains\0nul".to_owned())),
        ("text", Value::String("😀".repeat(8_193))),
        ("endMicroseconds", Value::from(250_000)),
        ("endMicroseconds", Value::from(9_007_199_254_740_992_u64)),
    ] {
        let mut caption = render_caption_value();
        caption[mutate.0] = mutate.1;
        let mut plan = base.clone();
        plan["captions"] = Value::Array(vec![caption]);
        malformed.push(plan);
    }

    for plan in malformed {
        let error = parse_and_validate_render_plan(plan, "owner", &grants)
            .expect_err("malformed caption metadata must fail before argv comparison");
        assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
        assert_eq!(error.details["category"], "captions");
    }
}

#[test]
fn multitrack_render_plan_binds_order_visibility_audio_and_source_ranges_to_exact_argv() {
    let directory = tempdir().expect("multitrack render workspace must be created");
    let top = directory.path().join("top.mp4");
    let bottom = directory.path().join("bottom.mp4");
    let output = directory.path().join("output.mp4");
    fs::write(&top, b"top").expect("top source must be written");
    fs::write(&bottom, b"bottom").expect("bottom source must be written");
    let grants = VideoPathGrants::default();
    let top = grants
        .grant_existing_file("owner", GrantCategory::Source, &top)
        .expect("top source must grant");
    let bottom = grants
        .grant_existing_file("owner", GrantCategory::Source, &bottom)
        .expect("bottom source must grant");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("output must grant");
    let exact = multitrack_render_plan_value(&top, &bottom, &output);
    parse_and_validate_render_plan(exact.clone(), "owner", &grants)
        .expect("exact structured multitrack plan must validate");

    let mutations = [
        {
            let mut value = exact.clone();
            value["videoInputs"]
                .as_array_mut()
                .expect("video inputs must be an array")
                .swap(0, 1);
            value
        },
        {
            let mut value = exact.clone();
            value["videoInputs"][1]["hidden"] = Value::Bool(true);
            value
        },
        {
            let mut value = exact.clone();
            value["videoInputs"][1]["muted"] = Value::Bool(false);
            value
        },
        {
            let mut value = exact;
            value["videoInputs"][1]["sourceInMicroseconds"] = Value::from(500_000);
            value
        },
    ];
    for mutation in mutations {
        let error = parse_and_validate_render_plan(mutation, "owner", &grants)
            .expect_err("metadata mutation without exact argv regeneration must fail");
        assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
        assert_eq!(error.details["category"], "argv_grammar");
    }
}

#[test]
fn render_transform_geometry_requires_exact_metadata_and_filter_graph() {
    let directory = tempdir().expect("transform render workspace must be created");
    let (grants, exact) = granted_multitrack_render_plan(directory.path());
    let mut transformed = exact.clone();
    let input = &mut transformed["videoInputs"][0];
    input["positionXPermille"] = Value::from(125);
    input["positionYPermille"] = Value::from(-250);
    input["scaleXPermille"] = Value::from(1_500);
    input["scaleYPermille"] = Value::from(750);
    input["rotationMilliDegrees"] = Value::from(45_000);
    let filter = multitrack_filter_mut(&mut transformed);
    let transformed_filter = filter
        .as_str()
        .unwrap()
        .replace(
            "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,colorchannelmixer=aa=0.425,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,fps=30/1[v0]",
            "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,format=rgba,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black@0,scale=w='max(1\\,round(iw*1.500))':h='max(1\\,round(ih*0.750))':flags=lanczos,rotate=angle=45.000*PI/180:ow=rotw(iw):oh=roth(ih):c=black@0,colorchannelmixer=aa=0.425,fps=30/1[v0]",
        )
        .replace(
            "[stack0][v0]overlay=0:0:format=auto[stack1]",
            "[stack0][v0]overlay=x='(main_w-overlay_w)/2+main_w*0.125':y='(main_h-overlay_h)/2-main_h*0.250':format=auto[stack1]",
        );
    *filter = Value::String(transformed_filter);
    parse_and_validate_render_plan(transformed.clone(), "owner", &grants)
        .expect("matching transformed metadata and graph must validate");

    let mut metadata_only = exact.clone();
    metadata_only["videoInputs"][0]["positionXPermille"] = Value::from(125);
    let error = parse_and_validate_render_plan(metadata_only, "owner", &grants)
        .expect_err("geometry metadata without a matching graph must fail");
    assert_eq!(error.details["category"], "argv_grammar");

    for (field, invalid) in [
        ("positionXPermille", Value::from(1_000_001)),
        ("positionYPermille", Value::from(-1_000_001)),
        ("scaleXPermille", Value::from(0)),
        ("scaleYPermille", Value::from(1_000_001)),
        ("rotationMilliDegrees", Value::from(360_000_001)),
    ] {
        let mut malformed = exact.clone();
        malformed["videoInputs"][0][field] = invalid;
        let error = parse_and_validate_render_plan(malformed, "owner", &grants)
            .expect_err("out-of-bounds geometry metadata must fail schema validation");
        assert_eq!(error.details["category"], "schema");
    }
}

#[test]
fn render_opacity_partial_uses_exact_integer_filter_and_filter_order() {
    let directory = tempdir().expect("opacity render workspace must be created");
    let (grants, exact) = granted_multitrack_render_plan(directory.path());
    let validated = parse_and_validate_render_plan(exact.clone(), "owner", &grants)
        .expect("partial and zero opacity must validate");
    let serialized = serde_json::to_value(&validated.plan).expect("render plan must serialize");
    assert_eq!(serialized["videoInputs"][0]["opacityPermille"], 425);
    assert_eq!(serialized["videoInputs"][1]["opacityPermille"], 0);

    let filter = validated
        .plan
        .argv()
        .iter()
        .find(|argument| argument.starts_with("color="))
        .expect("validated multitrack filter must exist");
    assert!(filter.contains("format=rgba,colorchannelmixer=aa=0.425,pad="));
    assert!(filter.contains("format=rgba,colorchannelmixer=aa=0.000,pad="));

    let mut reordered = exact;
    let filter = multitrack_filter_mut(&mut reordered);
    *filter = Value::String(filter.as_str().unwrap().replace(
        "format=rgba,colorchannelmixer=aa=0.425,pad=",
        "colorchannelmixer=aa=0.425,format=rgba,pad=",
    ));
    let error = parse_and_validate_render_plan(reordered, "owner", &grants)
        .expect_err("reordered opacity filter must fail");
    assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
    assert_eq!(error.details["category"], "argv_grammar");
}

#[test]
fn render_opacity_enforces_inclusive_permille_bounds() {
    let directory = tempdir().expect("opacity bounds workspace must be created");
    let (grants, exact) = granted_multitrack_render_plan(directory.path());

    let mut upper_bound = exact.clone();
    upper_bound["videoInputs"][0]["opacityPermille"] = Value::from(1_000);
    let filter = multitrack_filter_mut(&mut upper_bound);
    *filter = Value::String(filter.as_str().unwrap().replace("aa=0.425", "aa=1.000"));
    parse_and_validate_render_plan(upper_bound, "owner", &grants)
        .expect("one-thousand permille opacity must validate");

    let mut missing = exact.clone();
    missing["videoInputs"][0]
        .as_object_mut()
        .unwrap()
        .remove("opacityPermille");
    let mut negative = exact.clone();
    negative["videoInputs"][0]["opacityPermille"] = Value::from(-1);
    let mut above_maximum = exact;
    above_maximum["videoInputs"][0]["opacityPermille"] = Value::from(1_001);

    for invalid in [missing, negative, above_maximum] {
        let error = parse_and_validate_render_plan(invalid, "owner", &grants)
            .expect_err("missing or out-of-range opacity must fail schema validation");
        assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
        assert_eq!(error.details["category"], "schema");
    }
}

#[test]
fn render_opacity_rejects_metadata_filter_mismatches_and_preserves_audio_at_zero() {
    let directory = tempdir().expect("opacity mismatch workspace must be created");
    let (grants, exact) = granted_multitrack_render_plan(directory.path());

    let mut metadata_only = exact.clone();
    metadata_only["videoInputs"][0]["opacityPermille"] = Value::from(426);

    let mut missing_filter = exact.clone();
    let filter = multitrack_filter_mut(&mut missing_filter);
    *filter = Value::String(
        filter
            .as_str()
            .unwrap()
            .replace("colorchannelmixer=aa=0.425,", ""),
    );

    let mut tampered_filter = exact.clone();
    let filter = multitrack_filter_mut(&mut tampered_filter);
    *filter = Value::String(filter.as_str().unwrap().replace("aa=0.425", "aa=0.426"));

    for invalid in [metadata_only, missing_filter, tampered_filter] {
        let error = parse_and_validate_render_plan(invalid, "owner", &grants)
            .expect_err("opacity metadata and filter arguments must match exactly");
        assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
        assert_eq!(error.details["category"], "argv_grammar");
    }

    let mut zero_opacity_with_audio = exact;
    zero_opacity_with_audio["videoInputs"][0]["opacityPermille"] = Value::from(0);
    let filter = multitrack_filter_mut(&mut zero_opacity_with_audio);
    *filter = Value::String(filter.as_str().unwrap().replace("aa=0.425", "aa=0.000"));
    let validated = parse_and_validate_render_plan(zero_opacity_with_audio, "owner", &grants)
        .expect("zero opacity must not mute an independently audible input");
    assert!(validated.plan.expected().audio);
    assert!(validated
        .plan
        .argv()
        .iter()
        .any(|argument| argument.contains("[0:a:0]asetpts=PTS-STARTPTS[a0]")));
}

#[test]
fn render_plan_v2_strict_fields_match_typescript_contract() {
    let directory = tempdir().expect("strict V2 render workspace must be created");
    let top = directory.path().join("strict-top.mp4");
    let bottom = directory.path().join("strict-bottom.mp4");
    let output = directory.path().join("strict-output.mp4");
    fs::write(&top, b"top").expect("strict top source must be written");
    fs::write(&bottom, b"bottom").expect("strict bottom source must be written");
    let grants = VideoPathGrants::default();
    let top = grants
        .grant_existing_file("owner", GrantCategory::Source, &top)
        .expect("strict top source must grant");
    let bottom = grants
        .grant_existing_file("owner", GrantCategory::Source, &bottom)
        .expect("strict bottom source must grant");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("strict output must grant");
    let exact = multitrack_render_plan_value(&top, &bottom, &output);
    let validated = parse_and_validate_render_plan(exact.clone(), "owner", &grants)
        .expect("exact strict V2 plan must validate");
    assert!(!validated.plan.expected().video_hidden);
    let serialized = serde_json::to_value(&validated.plan).expect("V2 plan must serialize");
    assert!(serialized["expected"].get("videoHidden").is_none());

    let exact_with_caption = with_exact_render_caption(exact.clone());
    parse_and_validate_render_plan(exact_with_caption.clone(), "owner", &grants)
        .expect("exact strict V2 caption plan must validate");

    let forbidden_field_mutations = [
        {
            let mut value = exact.clone();
            value["surprise"] = Value::Bool(true);
            value
        },
        {
            let mut value = exact.clone();
            value["expected"]["videoHidden"] = Value::Bool(false);
            value
        },
        {
            let mut value = exact.clone();
            value["expected"]["surprise"] = Value::Bool(true);
            value
        },
        {
            let mut value = exact.clone();
            value["expected"]["rate"]["surprise"] = Value::Bool(true);
            value
        },
        {
            let mut value = exact;
            value["videoInputs"][0]["surprise"] = Value::Bool(true);
            value
        },
        {
            let mut value = exact_with_caption;
            value["captions"][0]["surprise"] = Value::Bool(true);
            value
        },
    ];
    for mutation in forbidden_field_mutations {
        let error = parse_and_validate_render_plan(mutation, "owner", &grants)
            .expect_err("every field forbidden by the strict V2 schema must fail");
        assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
        assert_eq!(error.details["category"], "schema");
    }
}

#[test]
fn render_visibility_plan_accepts_exact_filter_and_rejects_mutation_removal_or_injection() {
    const DRAWBOX: &str = "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill";
    const EXACT_FILTER: &str = "scale=1280:720:force_original_aspect_ratio=decrease:flags=lanczos,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black,drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill,fps=30000/1001";
    let directory = tempdir().expect("hidden render workspace must be created");
    let source = directory.path().join("hidden-source.mp4");
    let output = directory.path().join("hidden-output.mp4");
    fs::write(&source, b"source").expect("source must be written");
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file("owner", GrantCategory::Source, &source)
        .expect("source must grant");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("output must grant");

    let exact = hidden_render_plan_value(&source, &output, true, RENDER_PLAN_ID);
    let validated = parse_and_validate_render_plan(exact.clone(), "owner", &grants)
        .expect("exact hidden render plan must validate");
    assert!(validated.plan.expected().video_hidden);
    assert_eq!(
        validated
            .plan
            .argv()
            .iter()
            .find(|argument| argument.starts_with("scale="))
            .map(String::as_str),
        Some(EXACT_FILTER)
    );

    let mut mutated = exact.clone();
    let mutated_filter = mutated["argv"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|argument| {
            argument
                .as_str()
                .is_some_and(|value| value.starts_with("scale="))
        })
        .unwrap();
    *mutated_filter = Value::String(
        mutated_filter
            .as_str()
            .unwrap()
            .replace("color=black", "color=red"),
    );

    let mut removed = exact;
    let removed_filter = removed["argv"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|argument| {
            argument
                .as_str()
                .is_some_and(|value| value.starts_with("scale="))
        })
        .unwrap();
    *removed_filter = Value::String(
        removed_filter
            .as_str()
            .unwrap()
            .replace(&format!(",{DRAWBOX}"), ""),
    );

    let mut injected = render_plan_value(&source, &output, true, RENDER_PLAN_ID);
    let injected_filter = injected["argv"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|argument| {
            argument
                .as_str()
                .is_some_and(|value| value.starts_with("scale="))
        })
        .unwrap();
    *injected_filter = Value::String(
        injected_filter
            .as_str()
            .unwrap()
            .replace(",fps=", &format!(",{DRAWBOX},fps=")),
    );

    for (description, invalid) in [
        ("mutated", mutated),
        ("removed", removed),
        ("injected", injected),
    ] {
        let error = match parse_and_validate_render_plan(invalid, "owner", &grants) {
            Ok(_) => panic!("{description} hidden filter must fail"),
            Err(error) => error,
        };
        assert_eq!(error.code, VideoErrorCode::InvalidRenderPlan);
        assert_eq!(error.details["category"], "argv_grammar");
    }
}

#[test]
fn render_visibility_legacy_plan_without_hidden_field_remains_compatible() {
    let directory = tempdir().expect("legacy render workspace must be created");
    let source = directory.path().join("legacy-source.mp4");
    let output = directory.path().join("legacy-output.mp4");
    fs::write(&source, b"source").expect("source must be written");
    let grants = VideoPathGrants::default();
    let source = grants
        .grant_existing_file("owner", GrantCategory::Source, &source)
        .expect("source must grant");
    let output = grants
        .grant_destination("owner", GrantCategory::Output, &output)
        .expect("output must grant");
    let legacy = render_plan_value(&source, &output, true, RENDER_PLAN_ID);
    assert!(legacy["expected"].get("videoHidden").is_none());

    let validated = parse_and_validate_render_plan(legacy, "owner", &grants)
        .expect("legacy plan without videoHidden must validate");
    assert!(!validated.plan.expected().video_hidden);
    assert!(validated
        .plan
        .argv()
        .iter()
        .all(|argument| !argument.contains("drawbox=")));
    let serialized = serde_json::to_value(&validated.plan).unwrap();
    assert!(serialized["expected"].get("videoHidden").is_none());
}

#[test]
fn render_execution_argv_exactly_overwrites_only_the_owned_partial() {
    for audio in [true, false] {
        let directory = tempdir().expect("render execution workspace must be created");
        let (_, validated) = validated_render_fixture(directory.path(), audio, RENDER_PLAN_ID);
        let partial = partial_render_path(&validated).expect("partial path must derive");
        let source = validated.input_paths[0].to_string_lossy().into_owned();
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
            validated.plan.argv().last(),
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

struct QueuedRenderCancellationWorker;

impl MediaJobWorker for QueuedRenderCancellationWorker {
    fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
        panic!("queued render cancellation fixture must not execute")
    }
}

async fn enqueue_render_cancellation_fixture(
    jobs: &MediaJobService,
    owner_label: &str,
    label: &str,
) -> super::jobs::model::MediaJobRecord {
    jobs.store()
        .enqueue(NewMediaJob {
            kind: MediaJobKind::FinalRender,
            parent_id: None,
            dedupe_key: format!("render-cancellation:{label}:{}", uuid::Uuid::new_v4()),
            project_id: None,
            asset_id: None,
            revision_id: Some(format!("{label}-revision")),
            priority: MediaJobPriority::Export,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 1,
                unit: MediaJobProgressUnit::Items,
            },
            max_attempts: 3,
            summary: format!("Render cancellation fixture {label}"),
            private_payload: serde_json::json!({
                "ownerLabel": owner_label,
                "plan": { "schemaVersion": 1 },
                "overwrite": false,
                "outputAuthorizationPresent": true,
            }),
            created_at_ms: current_timestamp_millis(),
        })
        .await
        .expect("render cancellation fixture must enqueue")
        .job
}

#[tokio::test(flavor = "current_thread")]
async fn render_cancel_compatibility_handles_unknown_wrong_owner_terminal_and_active_jobs() {
    const OWNER: &str = "render-cancellation-owner";
    let workspace = tempdir().expect("render cancellation workspace must be created");
    let jobs = MediaJobService::initialize(
        workspace.path().join("local-data"),
        workspace.path().join("app-cache"),
    )
    .await
    .expect("render cancellation media jobs must initialize");

    let unknown = cancel_render_for_owner(OWNER, &jobs, "missing-render-job")
        .await
        .expect_err("unknown render job must fail");
    assert_eq!(unknown.code, VideoErrorCode::InvalidRenderPlan);
    assert_eq!(unknown.details["category"], "unknown_job");

    let owned_by_another_window =
        enqueue_render_cancellation_fixture(&jobs, "another-owner", "wrong-owner").await;
    let wrong_owner = cancel_render_for_owner(OWNER, &jobs, &owned_by_another_window.id)
        .await
        .expect_err("another owner's render job must stay hidden");
    assert_eq!(wrong_owner.code, VideoErrorCode::InvalidRenderPlan);
    assert_eq!(wrong_owner.details["category"], "unknown_job");

    let terminal = enqueue_render_cancellation_fixture(&jobs, OWNER, "terminal").await;
    jobs.store()
        .transition(
            terminal.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Cancelled,
                stage: "cancelled".to_owned(),
                progress: terminal.progress.clone(),
                attempt: None,
                error: None,
                retry_at_ms: None,
                result: None,
                cancellation_requested: true,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Render cancellation fixture settled.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .expect("terminal render fixture must settle");
    cancel_render_for_owner(OWNER, &jobs, &terminal.id)
        .await
        .expect("terminal render cancellation must be idempotent");
    let terminal_after_cancel = jobs
        .store()
        .get_private(terminal.id)
        .await
        .expect("terminal render fixture must remain readable");
    assert_eq!(terminal_after_cancel.public.state, MediaJobState::Cancelled);

    let ffmpeg_permit = jobs
        .scheduler()
        .acquire_resource_permit(SchedulerResource::Ffmpeg)
        .await
        .expect("test must hold the FFmpeg permit");
    let active = enqueue_render_cancellation_fixture(&jobs, OWNER, "active").await;
    jobs.scheduler()
        .submit(
            active.id.clone(),
            active.priority,
            active.attempt,
            active.max_attempts,
            SchedulerResource::Ffmpeg,
            Arc::new(QueuedRenderCancellationWorker),
        )
        .await
        .expect("active render fixture must enter the scheduler");
    cancel_render_for_owner(OWNER, &jobs, &active.id)
        .await
        .expect("active render cancellation must succeed");
    let cancelled = jobs
        .store()
        .get_private(active.id)
        .await
        .expect("cancelled render fixture must remain readable");
    assert_eq!(cancelled.public.state, MediaJobState::Cancelled);
    assert!(cancelled.public.cancellation_requested);

    drop(ffmpeg_permit);
    jobs.shutdown()
        .await
        .expect("render cancellation media jobs must shut down");
}

#[test]
fn render_preview_preserves_tool_unavailable_but_normalizes_ordinary_failures() {
    let unavailable = MediaToolchainError::for_test(MediaToolchainProblem::IntegrityFailed)
        .into_command_error("verify_render_preview");
    let unavailable = map_render_preview_failure(unavailable);
    assert_eq!(unavailable.code, VideoErrorCode::ToolUnavailable);
    assert_eq!(unavailable.details["category"], "integrity_failed");

    let cancelled = map_render_preview_failure(VideoCommandError::process_cancelled(
        "verify_render_preview",
        "ffprobe",
    ));
    assert_eq!(cancelled.code, VideoErrorCode::ProcessCancelled);

    let ordinary = map_render_preview_failure(VideoCommandError::process_failed(
        "verify_render_preview",
        "ffprobe",
        Some(1),
    ));
    assert_eq!(ordinary.code, VideoErrorCode::ProjectIo);
    assert_eq!(ordinary.details["category"], "copy_or_verify");
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

#[tokio::test(flavor = "current_thread")]
async fn render_cancellation_during_post_render_preview_preserves_existing_destination() {
    let directory = tempdir().expect("cancellation promotion workspace must be created");
    let (_, validated) = validated_render_fixture(directory.path(), true, RENDER_PLAN_ID);
    let partial_path = partial_render_path(&validated).expect("partial path must derive");
    fs::write(&validated.output_path, b"old export").expect("old export must exist");
    let partial = create_owned_partial(&partial_path).expect("replacement partial must be owned");
    fs::write(&partial, b"stale replacement").expect("replacement partial must be writable");

    let cancellation = ProcessCancellation::new();
    let cancellation_trigger = cancellation.clone();
    let (preview_started_tx, preview_started_rx) = tokio::sync::oneshot::channel();
    let (preview_finished_tx, preview_finished_rx) = tokio::sync::oneshot::channel();
    let preview_work = async move {
        preview_started_tx
            .send(())
            .expect("preview start must be observable");
        preview_finished_rx
            .await
            .expect("preview completion must be released after cancellation");
    };
    let cancel_during_preview = async {
        preview_started_rx
            .await
            .expect("preview work must start before cancellation");
        assert_eq!(
            fs::read(&validated.output_path).expect("old export must remain during preview"),
            b"old export"
        );
        cancellation_trigger.cancel();
        preview_finished_tx
            .send(())
            .expect("cancelled preview work must be released");
    };
    tokio::join!(preview_work, cancel_during_preview);

    let error =
        promote_render_partial_if_active(partial, &validated.output_path, true, &cancellation)
            .expect_err("a render cancelled during preview must not publish its partial");
    assert_eq!(error.code, VideoErrorCode::ProcessCancelled);
    assert_eq!(
        fs::read(&validated.output_path).expect("old export must survive cancellation"),
        b"old export"
    );
    assert!(
        !partial_path.exists(),
        "cancelled publication must clean the stale partial"
    );
}

#[test]
fn render_promotion_and_cancellation_are_atomic_inside_commit_boundary() {
    let directory = tempdir().expect("atomic promotion workspace must be created");
    let (_, validated) = validated_render_fixture(directory.path(), true, RENDER_PLAN_ID);
    let partial_path = partial_render_path(&validated).expect("partial path must derive");
    fs::write(&validated.output_path, b"old export").expect("old export must exist");
    let partial = create_owned_partial(&partial_path).expect("replacement partial must be owned");
    fs::write(&partial, b"committed replacement").expect("replacement partial must be writable");

    let cancellation = ProcessCancellation::new();
    let promotion_cancellation = cancellation.clone();
    let cancel_cancellation = cancellation.clone();
    let destination = validated.output_path.clone();
    let promotion_destination = destination.clone();
    let boundary_destination = destination.clone();
    let (boundary_entered_tx, boundary_entered_rx) = mpsc::channel();
    let (release_boundary_tx, release_boundary_rx) = mpsc::channel();
    let promotion = thread::spawn(move || {
        promote_render_partial_if_active_with_hook(
            partial,
            &promotion_destination,
            true,
            &promotion_cancellation,
            || {
                assert_eq!(
                    fs::read(&boundary_destination)
                        .expect("old export must remain inside commit boundary"),
                    b"old export"
                );
                boundary_entered_tx
                    .send(())
                    .expect("commit boundary entry must be observable");
                release_boundary_rx
                    .recv()
                    .expect("commit boundary must be released after cancellation starts");
            },
        )
    });

    boundary_entered_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("promotion must pause inside the commit boundary");
    let (cancel_started_tx, cancel_started_rx) = mpsc::channel();
    let cancel = thread::spawn(move || {
        cancel_started_tx
            .send(())
            .expect("cancellation attempt must be observable");
        cancel_cancellation.cancel();
    });
    cancel_started_rx
        .recv_timeout(Duration::from_secs(1))
        .expect("cancellation must start while promotion owns the boundary");
    release_boundary_tx
        .send(())
        .expect("promotion boundary must be releasable");

    promotion
        .join()
        .expect("promotion thread must not panic")
        .expect("promotion that owns the boundary must commit");
    cancel.join().expect("cancellation thread must not panic");
    assert!(
        !cancellation.is_cancelled(),
        "cancellation after the commit linearization point must not win"
    );
    assert_eq!(
        fs::read(&destination).expect("committed replacement must exist"),
        b"committed replacement"
    );
    assert!(!partial_path.exists(), "committed partial must be consumed");
}

const RENDER_INTEGRATION_OWNER: &str = "render-worker-integration";
const RENDER_AV_PLAN_ID: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RENDER_VIDEO_ONLY_PLAN_ID: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const RENDER_COLLISION_PLAN_ID: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const RENDER_CANCELLATION_PLAN_ID: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const RENDER_RESTART_PLAN_ID: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const RENDER_HIDDEN_AV_PLAN_ID: &str = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const RENDER_HIDDEN_MUTED_PLAN_ID: &str = "12121212-1212-4212-8212-121212121212";

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
    validated_system_render_fixture_with_visibility(
        directory, source, audio, false, plan_id, profile,
    )
}

fn validated_system_hidden_render_fixture(
    directory: &Path,
    source: &Path,
    audio: bool,
    plan_id: &str,
    profile: RenderTestProfile,
) -> super::render::ValidatedRenderPlan {
    validated_system_render_fixture_with_visibility(
        directory, source, audio, true, plan_id, profile,
    )
}

fn validated_system_render_fixture_with_visibility(
    directory: &Path,
    source: &Path,
    audio: bool,
    video_hidden: bool,
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
    let plan = render_plan_value_for_profile(
        &source,
        &output,
        audio,
        plan_id,
        profile.duration_frames,
        profile.rate_numerator,
        profile.rate_denominator,
        profile.width,
        profile.height,
    );
    let plan = if video_hidden {
        with_hidden_render_video(plan)
    } else {
        plan
    };
    parse_and_validate_render_plan(plan, RENDER_INTEGRATION_OWNER, &grants)
        .expect("integration render plan must validate")
}

fn registered_render_worker(
    validated: super::render::ValidatedRenderPlan,
    overwrite: bool,
    app_cache_dir: PathBuf,
    programs: MediaPrograms,
) -> (RenderWorkerRequest, Arc<Mutex<Vec<VideoRenderEvent>>>) {
    let durable_job_id = uuid::Uuid::new_v4().to_string();
    assert_ne!(durable_job_id, validated.plan.plan_id().as_str());
    let identity = super::render::RenderEventIdentity {
        job_id: durable_job_id,
        plan_id: validated.plan.plan_id().as_str().to_owned(),
        revision_id: validated.plan.revision_id().as_str().to_owned(),
    };
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
        programs,
        cancellation: ProcessCancellation::new(),
        identity,
        events,
    };
    (request, captured)
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

async fn probe_and_validate_render(
    path: &Path,
    validated: &super::render::ValidatedRenderPlan,
    programs: &MediaPrograms,
    operation: &'static str,
) -> InspectedMedia {
    let inspected = probe_trusted_media_with_program(
        path,
        programs
            .verified_ffprobe(operation)
            .await
            .expect("render FFprobe program must verify"),
        ProcessCancellation::new(),
        operation,
    )
    .await
    .expect("render artifact must probe through the supervised FFprobe program");
    validate_render_output(path, &inspected, validated)
        .expect("render artifact must satisfy the worker's verified output contract");
    inspected
}

#[tokio::test(flavor = "current_thread")]
async fn final_render_output_reauthorization_rejects_owner_state_path_and_missing_grant() {
    const OWNER: &str = "owner";
    let workspace = tempdir().expect("reauthorization rejection workspace must be created");
    let app_cache_dir = workspace.path().join("app-cache");
    let (_, validated) = validated_render_fixture(workspace.path(), true, RENDER_PLAN_ID);
    let jobs =
        MediaJobService::initialize(workspace.path().join("local-data"), app_cache_dir.clone())
            .await
            .expect("reauthorization rejection jobs must initialize");
    let created_at_ms = current_timestamp_millis();
    let queued = jobs
        .store()
        .enqueue(NewMediaJob {
            kind: MediaJobKind::FinalRender,
            parent_id: None,
            dedupe_key: render_dedupe_key(&validated, false),
            project_id: None,
            asset_id: None,
            revision_id: Some(validated.plan.revision_id().as_str().to_owned()),
            priority: MediaJobPriority::Export,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: validated.duration_microseconds,
                unit: MediaJobProgressUnit::Microseconds,
            },
            max_attempts: 3,
            summary: "Export project revision".to_owned(),
            private_payload: serde_json::json!({
                "ownerLabel": OWNER,
                "plan": validated.plan.clone(),
                "overwrite": false,
                "outputAuthorizationPresent": true,
            }),
            created_at_ms,
        })
        .await
        .expect("queued render rejection fixture must persist")
        .job;
    let fresh_grants = VideoPathGrants::default();
    let events: RenderEventSink = Arc::new(|_| Ok(()));
    let programs = MediaPrograms::explicit(OsString::from("ffmpeg"), OsString::from("ffprobe"));
    let output_path = validated.output_path.to_string_lossy().into_owned();

    let wrong_owner = reauthorize_final_render_output_with_context(
        "another-owner",
        &fresh_grants,
        &jobs,
        programs.clone(),
        app_cache_dir.clone(),
        &queued.id,
        &output_path,
        events.clone(),
    )
    .await
    .expect_err("another owner must not reauthorize the render");
    assert_eq!(wrong_owner.details["category"], "unknown_job");

    let wrong_state = reauthorize_final_render_output_with_context(
        OWNER,
        &fresh_grants,
        &jobs,
        programs.clone(),
        app_cache_dir.clone(),
        &queued.id,
        &output_path,
        events.clone(),
    )
    .await
    .expect_err("a queued render must not accept output reauthorization");
    assert_eq!(
        wrong_state.details["category"],
        "output_reauthorization_state"
    );

    jobs.store()
        .transition(
            queued.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Blocked,
                stage: "authorization".to_owned(),
                progress: queued.progress.clone(),
                attempt: Some(queued.attempt),
                error: Some(MediaJobError {
                    code: "output_authorization_required".to_owned(),
                    category: MediaJobErrorCategory::OutputAuthorizationRequired,
                    message: "Choose the export destination again to continue.".to_owned(),
                    retryable: false,
                    action: Some(MediaJobRecoveryAction::ReauthorizeOutput),
                }),
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Output authorization is required.".to_owned()),
                occurred_at_ms: current_timestamp_millis(),
            },
        )
        .await
        .expect("render rejection fixture must become blocked");

    let path_mismatch = reauthorize_final_render_output_with_context(
        OWNER,
        &fresh_grants,
        &jobs,
        programs.clone(),
        app_cache_dir.clone(),
        &queued.id,
        &workspace.path().join("different.mp4").to_string_lossy(),
        events.clone(),
    )
    .await
    .expect_err("a different destination must not mutate the durable plan");
    assert_eq!(path_mismatch.details["category"], "output_path_mismatch");

    let missing_grant = reauthorize_final_render_output_with_context(
        OWNER,
        &fresh_grants,
        &jobs,
        programs,
        app_cache_dir,
        &queued.id,
        &output_path,
        events,
    )
    .await
    .expect_err("the persisted destination needs a fresh owner grant");
    assert_eq!(missing_grant.details["category"], "output_grant");
    jobs.shutdown()
        .await
        .expect("reauthorization rejection jobs must shut down");
}

pub(crate) async fn assert_final_render_restart_reauthorization(programs: MediaPrograms) {
    let workspace = tempdir().expect("restart recovery workspace must be created");
    let local_data_dir = workspace.path().join("local-data");
    let app_cache_dir = workspace.path().join("app-cache");
    let validated = validated_system_render_fixture(
        workspace.path(),
        &canonical_media_fixture(),
        true,
        RENDER_RESTART_PLAN_ID,
        CANONICAL_RENDER_PROFILE,
    );
    let persisted_plan_id = validated.plan.plan_id().as_str().to_owned();
    let persisted_revision_id = validated.plan.revision_id().as_str().to_owned();
    let created_at_ms = current_timestamp_millis();
    let store = MediaJobStore::initialize(local_data_dir.clone())
        .await
        .expect("initial durable render store must initialize");
    let initial = store
        .enqueue(NewMediaJob {
            kind: MediaJobKind::FinalRender,
            parent_id: None,
            dedupe_key: render_dedupe_key(&validated, false),
            project_id: None,
            asset_id: None,
            revision_id: Some(validated.plan.revision_id().as_str().to_owned()),
            priority: MediaJobPriority::Export,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: validated.duration_microseconds,
                unit: MediaJobProgressUnit::Microseconds,
            },
            max_attempts: 3,
            summary: "Export project revision".to_owned(),
            private_payload: serde_json::json!({
                "ownerLabel": RENDER_INTEGRATION_OWNER,
                "plan": validated.plan.clone(),
                "overwrite": false,
                "outputAuthorizationPresent": true,
            }),
            created_at_ms,
        })
        .await
        .expect("initial durable render must enqueue")
        .job;
    store
        .transition(
            initial.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Running,
                stage: "render".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: validated.duration_microseconds,
                    unit: MediaJobProgressUnit::Microseconds,
                },
                attempt: Some(1),
                error: None,
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Final render started before restart.".to_owned()),
                occurred_at_ms: created_at_ms,
            },
        )
        .await
        .expect("initial render must enter running state");
    drop(store);
    let partial_path =
        partial_render_path(&validated).expect("interrupted render partial path must derive");
    fs::write(&partial_path, b"interrupted render bytes")
        .expect("interrupted render partial must exist before restart");

    let jobs = MediaJobService::initialize(local_data_dir, app_cache_dir.clone())
        .await
        .expect("restarted media job service must initialize");
    assert_eq!(jobs.recovery().blocked_count, 1);
    let blocked = jobs
        .store()
        .get_private(initial.id.clone())
        .await
        .expect("interrupted render must remain durable");
    assert_eq!(blocked.public.state, MediaJobState::Blocked);
    assert_eq!(
        blocked
            .public
            .error
            .as_ref()
            .map(|error| error.code.as_str()),
        Some("output_authorization_required")
    );
    assert_eq!(blocked.payload_version, 1);

    let fresh_grants = VideoPathGrants::default();
    fresh_grants
        .grant_destination(
            RENDER_INTEGRATION_OWNER,
            GrantCategory::Output,
            &validated.output_path,
        )
        .expect("restarted render output must receive fresh authorization");
    let captured = Arc::new(Mutex::new(Vec::new()));
    let captured_for_sink = captured.clone();
    let events: RenderEventSink = Arc::new(move |event| {
        captured_for_sink
            .lock()
            .expect("restart compatibility event capture must lock")
            .push(event);
        Ok(())
    });

    let restarted = reauthorize_final_render_output_with_context(
        RENDER_INTEGRATION_OWNER,
        &fresh_grants,
        &jobs,
        programs,
        app_cache_dir,
        &initial.id,
        &validated.output_path.to_string_lossy(),
        events,
    )
    .await
    .expect("freshly authorized Job Center path must resume the durable job");
    assert!(
        !partial_path.exists(),
        "fresh output authorization must remove the prior process partial before retry"
    );
    assert_eq!(restarted.id, initial.id);
    assert_eq!(
        restarted.revision_id.as_deref(),
        Some(persisted_revision_id.as_str())
    );
    let refreshed_payload = jobs
        .store()
        .get_private(initial.id.clone())
        .await
        .expect("reauthorized durable payload must remain readable");
    assert_eq!(
        refreshed_payload.private_payload["plan"]["planId"],
        persisted_plan_id
    );
    jobs.scheduler().wait_idle().await;

    let completed = jobs
        .store()
        .get_private(initial.id.clone())
        .await
        .expect("resumed durable render must remain readable");
    assert_eq!(completed.public.state, MediaJobState::Complete);
    assert_eq!(completed.payload_version, 2);
    assert!(completed.public.error.is_none());
    assert!(validated.output_path.is_file());
    let durable_events = jobs
        .store()
        .events(Some(initial.id.clone()), 0, 100)
        .await
        .expect("durable render events must be readable");
    assert_eq!(
        durable_events
            .events
            .iter()
            .filter(|event| event.state == MediaJobState::Complete)
            .count(),
        1,
        "the resumed durable job must settle complete exactly once"
    );
    let compatibility_events = captured_render_events(&captured);
    assert_worker_event_order(&compatibility_events);
    assert_eq!(
        compatibility_events
            .iter()
            .filter(|event| matches!(event, VideoRenderEvent::Completed { .. }))
            .count(),
        1,
        "compatibility lifecycle must report completion exactly once"
    );
    jobs.shutdown()
        .await
        .expect("restarted media job service must shut down cleanly");
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn final_render_restart_reauthorization_requeues_same_job_and_completes_once() {
    assert_final_render_restart_reauthorization(MediaPrograms::explicit(
        OsString::from("ffmpeg"),
        OsString::from("ffprobe"),
    ))
    .await;
}

pub(crate) async fn assert_render_worker_exports(programs: MediaPrograms) {
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
        let (request, captured) = registered_render_worker(
            validated.clone(),
            false,
            workspace.path().join("app-cache"),
            programs.clone(),
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
        let final_inspected = probe_and_validate_render(
            &validated.output_path,
            &validated,
            &programs,
            "probe_render_final_integration",
        )
        .await;
        let preview_inspected = probe_and_validate_render(
            &preview_path,
            &validated,
            &programs,
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
async fn render_worker_local_ffmpeg_exports_av_and_video_only_with_ordered_verified_events() {
    assert_render_worker_exports(MediaPrograms::explicit(
        OsString::from("ffmpeg"),
        OsString::from("ffprobe"),
    ))
    .await;
}

fn assert_every_render_frame_is_black(ffmpeg: &OsString, path: &Path, expected_frame_count: u64) {
    let output = Command::new(ffmpeg)
        .args(["-hide_banner", "-nostdin", "-loglevel", "info", "-i"])
        .arg(path)
        .args([
            "-an",
            "-vf",
            "blackframe=amount=100:threshold=32",
            "-f",
            "null",
            "-",
        ])
        .output()
        .expect("black-frame FFmpeg assertion must run");
    assert!(
        output.status.success(),
        "black-frame FFmpeg assertion failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stderr = String::from_utf8_lossy(&output.stderr);
    let black_frame_count = stderr
        .lines()
        .filter(|line| line.contains("Parsed_blackframe") && line.contains("pblack:100"))
        .count();
    assert_eq!(
        black_frame_count,
        usize::try_from(expected_frame_count).unwrap(),
        "every decoded render frame must be 100% black; FFmpeg stderr:\n{stderr}"
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg, FFprobe, and the canonical media fixture"]
async fn render_visibility_local_ffmpeg_outputs_black_video_and_respects_audio_mute() {
    let programs = MediaPrograms::explicit(OsString::from("ffmpeg"), OsString::from("ffprobe"));
    let ffmpeg = programs
        .verified_ffmpeg("verify_hidden_render_black_frames")
        .await
        .expect("hidden render FFmpeg program must verify");
    let source = canonical_media_fixture();
    for (muted, plan_id) in [
        (false, RENDER_HIDDEN_AV_PLAN_ID),
        (true, RENDER_HIDDEN_MUTED_PLAN_ID),
    ] {
        let workspace = tempdir().expect("hidden render integration workspace must be created");
        let validated = validated_system_hidden_render_fixture(
            workspace.path(),
            &source,
            !muted,
            plan_id,
            CANONICAL_RENDER_PROFILE,
        );
        let (request, captured) = registered_render_worker(
            validated.clone(),
            false,
            workspace.path().join("app-cache"),
            programs.clone(),
        );

        run_render_worker(request).await;

        let events = captured_render_events(&captured);
        assert_worker_event_order(&events);
        assert!(
            matches!(events.last(), Some(VideoRenderEvent::Completed { .. })),
            "hidden render must complete: {events:?}"
        );
        let inspected = probe_and_validate_render(
            &validated.output_path,
            &validated,
            &programs,
            "probe_hidden_render_integration",
        )
        .await;
        assert_eq!(
            inspected.probe.audio.is_some(),
            !muted,
            "FFprobe audio presence must match track mute state"
        );
        assert_every_render_frame_is_black(
            &ffmpeg,
            &validated.output_path,
            CANONICAL_RENDER_PROFILE.duration_frames,
        );
    }
}

pub(crate) async fn assert_render_worker_collision(programs: MediaPrograms) {
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
    let (request, captured) = registered_render_worker(
        validated.clone(),
        false,
        workspace.path().join("app-cache"),
        programs,
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

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn render_worker_local_ffmpeg_preserves_no_overwrite_collision() {
    assert_render_worker_collision(MediaPrograms::explicit(
        OsString::from("ffmpeg"),
        OsString::from("ffprobe"),
    ))
    .await;
}

async fn create_long_canonical_render_source(destination: &Path, programs: &MediaPrograms) {
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
    let ffmpeg = programs
        .verified_ffmpeg("create_long_render_source")
        .await
        .expect("long render source FFmpeg must verify");
    run_derived_ffmpeg(
        ffmpeg,
        args,
        "create_long_render_source",
        Duration::from_secs(120),
        ProcessCancellation::new(),
    )
    .await
    .expect("long render source must be generated");
}

pub(crate) async fn assert_render_worker_cancellation(programs: MediaPrograms) {
    let workspace = tempdir().expect("render cancellation workspace must be created");
    let long_source = workspace.path().join("long-canonical-source.mp4");
    create_long_canonical_render_source(&long_source, &programs).await;
    let validated = validated_system_render_fixture(
        workspace.path(),
        &long_source,
        true,
        RENDER_CANCELLATION_PLAN_ID,
        CANCELLATION_RENDER_PROFILE,
    );
    let output_path = validated.output_path.clone();
    let partial_path = partial_render_path(&validated).expect("partial path must derive");
    let (request, captured) = registered_render_worker(
        validated,
        false,
        workspace.path().join("app-cache"),
        programs,
    );
    let cancellation = request.cancellation.clone();
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
            cancellation.cancel();
            worker
                .await
                .expect("timed-out integration worker task must join");
            panic!("long real render emitted no cancellable progress before the deadline");
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }

    cancellation.cancel();
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

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn render_worker_local_ffmpeg_cancellation_reaps_process_and_cleans_partial_once() {
    assert_render_worker_cancellation(MediaPrograms::explicit(
        OsString::from("ffmpeg"),
        OsString::from("ffprobe"),
    ))
    .await;
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

#[test]
fn bundled_status_preserves_asymmetric_tool_failures_and_redacts_inspection_data() {
    let toolchain = MediaToolchain::from_test_programs(
        PathBuf::from("private-ffmpeg-path"),
        PathBuf::from("private-ffprobe-path"),
    );
    let cases = [
        (true, MediaToolchainProblem::NotFound, "not_found"),
        (
            true,
            MediaToolchainProblem::IncompatibleBuild,
            "incompatible_build",
        ),
        (false, MediaToolchainProblem::NotFound, "not_found"),
        (
            false,
            MediaToolchainProblem::IncompatibleBuild,
            "incompatible_build",
        ),
    ];

    for (ffmpeg_failed, problem, expected_problem) in cases {
        let healthy_ffmpeg = Ok("ffmpeg version private raw output".to_owned());
        let healthy_ffprobe = Ok("ffprobe version private raw output".to_owned());
        let inspection = if ffmpeg_failed {
            MediaToolchainInspection {
                ffmpeg_version: Err(MediaToolchainError::for_test(problem)),
                ffprobe_version: healthy_ffprobe,
            }
        } else {
            MediaToolchainInspection {
                ffmpeg_version: healthy_ffmpeg,
                ffprobe_version: Err(MediaToolchainError::for_test(problem)),
            }
        };
        let status = video_tool_status_from_inspection(&toolchain, inspection);
        let failed = serde_json::json!({ "available": false, "problem": expected_problem });
        let healthy = serde_json::json!({ "available": true, "version": "8.1.2" });
        let expected = if ffmpeg_failed {
            serde_json::json!({
                "source": "bundled",
                "toolchainId": "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
                "ffmpeg": failed,
                "ffprobe": healthy,
                "ready": false
            })
        } else {
            serde_json::json!({
                "source": "bundled",
                "toolchainId": "ffmpeg-8.1.2-gyan-essentials-windows-x86_64",
                "ffmpeg": healthy,
                "ffprobe": failed,
                "ready": false
            })
        };
        let serialized = serde_json::to_value(status).expect("status must serialize");
        assert_eq!(serialized, expected);
        let encoded = serialized.to_string();
        assert!(!encoded.contains("private"));
        assert!(!encoded.contains("path"));
        assert!(!encoded.contains("raw output"));
    }
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
    derived_probe_thumbnail_shape_with_programs(
        path,
        &MediaPrograms::explicit(OsString::from("ffmpeg"), OsString::from("ffprobe")),
    )
    .await
}

async fn derived_probe_thumbnail_shape_with_programs(
    path: &Path,
    programs: &MediaPrograms,
) -> Value {
    let spec = ProcessSpec {
        program: programs
            .verified_ffprobe("probe_thumbnail_integration")
            .await
            .expect("thumbnail FFprobe must verify"),
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

async fn write_thumbnail_image_with_programs(
    path: &Path,
    codec: &str,
    width: u64,
    height: u64,
    programs: &MediaPrograms,
) {
    let source = format!("color=c=black:s={width}x{height}");
    let mut args: Vec<OsString> = [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-f",
        "lavfi",
        "-i",
        &source,
        "-frames:v",
        "1",
        "-c:v",
        codec,
        "-f",
        "image2",
    ]
    .into_iter()
    .map(OsString::from)
    .collect();
    args.push(path.as_os_str().to_owned());
    let ffmpeg = programs
        .verified_ffmpeg("write_thumbnail_integration")
        .await
        .expect("thumbnail FFmpeg must verify");
    run_derived_ffmpeg(
        ffmpeg,
        args,
        "write_thumbnail_integration",
        Duration::from_secs(30),
        ProcessCancellation::new(),
    )
    .await
    .expect("thumbnail test image must be generated");
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
                sequence_rate: Some(RationalRate {
                    numerator: 10,
                    denominator: 1,
                }),
                expected_content_identity: None,
            },
            &grants,
            &cache_root,
            MediaPrograms::explicit(OsString::from("ffmpeg"), OsString::from("ffprobe")),
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

#[derive(Clone, Copy, Debug)]
enum PreparationCrashBoundary {
    AfterPlanPersistence,
    AfterProxyChildCreation,
    DuringProxyExecution,
}

struct RecoveryCompletingWorker {
    kind: MediaJobKind,
}

impl MediaJobWorker for RecoveryCompletingWorker {
    fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let kind = self.kind;
        Box::pin(async move {
            let result = match kind {
                MediaJobKind::Proxy => serde_json::json!({
                    "path": "recovered-proxy.mp4",
                    "probe": {
                        "durationMicroseconds": 2_000_000,
                        "averageFrameRate": { "numerator": 30, "denominator": 1 },
                        "realFrameRate": { "numerator": 30, "denominator": 1 },
                        "variableFrameRate": false,
                        "width": 320,
                        "height": 180,
                        "videoCodecName": "h264",
                        "audio": { "codecName": "aac", "channels": 2, "sampleRate": 48_000 },
                        "fileSizeBytes": 4_096
                    }
                }),
                MediaJobKind::ThumbnailTile => serde_json::json!({
                    "path": "recovered-thumbnail.jpg"
                }),
                other => panic!("unexpected recovery worker kind: {other:?}"),
            };
            MediaWorkerOutcome::Complete {
                result,
                progress: MediaJobProgress {
                    completed: 1,
                    total: 1,
                    unit: MediaJobProgressUnit::Items,
                },
            }
        })
    }
}

async fn enqueue_interrupted_preparation(
    store: &MediaJobStore,
    plan: Value,
    boundary: PreparationCrashBoundary,
) -> String {
    let created_at_ms = current_timestamp_millis().saturating_sub(1_000);
    let parent = store
        .enqueue(NewMediaJob {
            kind: MediaJobKind::AssetPreparation,
            parent_id: None,
            dedupe_key: format!("restart-safe-parent:{boundary:?}"),
            project_id: Some(DERIVED_PROJECT_ID.to_owned()),
            asset_id: Some(DERIVED_ASSET_ID.to_owned()),
            revision_id: None,
            priority: MediaJobPriority::Interactive,
            priority_value: 0,
            stage: "queued".to_owned(),
            progress: MediaJobProgress {
                completed: 0,
                total: 2,
                unit: MediaJobProgressUnit::Stages,
            },
            max_attempts: 3,
            summary: "Prepare media asset".to_owned(),
            private_payload: serde_json::json!({
                "canonicalObjectAvailable": true,
                "ownerLabel": "restart-safe-preparation",
                "projectId": DERIVED_PROJECT_ID,
                "plan": plan.clone(),
            }),
            created_at_ms,
        })
        .await
        .expect("interrupted parent must enqueue")
        .job;
    store
        .transition(
            parent.id.clone(),
            MediaJobTransition {
                state: MediaJobState::Running,
                stage: "derived_media".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 2,
                    unit: MediaJobProgressUnit::Stages,
                },
                attempt: Some(1),
                error: None,
                retry_at_ms: None,
                result: None,
                cancellation_requested: false,
                event_type: MediaJobEventType::StateChanged,
                message: Some("Preparing preview media before restart.".to_owned()),
                occurred_at_ms: created_at_ms + 1,
            },
        )
        .await
        .expect("interrupted parent must enter running state");

    if matches!(
        boundary,
        PreparationCrashBoundary::AfterProxyChildCreation
            | PreparationCrashBoundary::DuringProxyExecution
    ) {
        let proxy_key = plan["proxyIdentity"]["key"]
            .as_str()
            .expect("fixture proxy identity must have a key");
        let proxy = store
            .enqueue(NewMediaJob {
                kind: MediaJobKind::Proxy,
                parent_id: Some(parent.id.clone()),
                dedupe_key: format!("proxy:{proxy_key}:{}", parent.id),
                project_id: parent.project_id.clone(),
                asset_id: parent.asset_id.clone(),
                revision_id: None,
                priority: MediaJobPriority::Interactive,
                priority_value: 0,
                stage: "queued".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 1,
                    unit: MediaJobProgressUnit::Items,
                },
                max_attempts: 3,
                summary: "Build preview proxy".to_owned(),
                private_payload: serde_json::json!({
                    "canonicalObjectAvailable": true,
                    "ownerLabel": "restart-safe-preparation",
                    "projectId": DERIVED_PROJECT_ID,
                    "plan": plan,
                }),
                created_at_ms: created_at_ms + 2,
            })
            .await
            .expect("interrupted proxy child must enqueue")
            .job;
        if matches!(boundary, PreparationCrashBoundary::DuringProxyExecution) {
            store
                .transition(
                    proxy.id,
                    MediaJobTransition {
                        state: MediaJobState::Running,
                        stage: "running".to_owned(),
                        progress: MediaJobProgress {
                            completed: 0,
                            total: 1,
                            unit: MediaJobProgressUnit::Items,
                        },
                        attempt: Some(1),
                        error: None,
                        retry_at_ms: None,
                        result: None,
                        cancellation_requested: false,
                        event_type: MediaJobEventType::StateChanged,
                        message: Some("Proxy execution interrupted by restart.".to_owned()),
                        occurred_at_ms: created_at_ms + 3,
                    },
                )
                .await
                .expect("interrupted proxy must enter running state");
        }
    }
    parent.id
}

async fn assert_preparation_restart_boundary(boundary: PreparationCrashBoundary) {
    let workspace = tempdir().expect("restart preparation workspace must be created");
    let local_data_dir = workspace.path().join("local-data");
    let cache_root = workspace.path().join("app-cache");
    let store = MediaJobStore::initialize(local_data_dir.clone())
        .await
        .expect("initial restart store must initialize");
    let plan = prepared_asset_plan_fixture(&cache_root);
    let parent_id = enqueue_interrupted_preparation(&store, plan, boundary).await;
    drop(store);

    let jobs = MediaJobService::initialize(local_data_dir, cache_root)
        .await
        .expect("restarted preparation service must initialize");
    let worker_factory =
        Arc::new(|kind| Arc::new(RecoveryCompletingWorker { kind }) as Arc<dyn MediaJobWorker>);
    resume_durable_preparations_with_test_workers(
        &jobs,
        MediaPrograms::explicit(
            OsString::from("unused-test-ffmpeg"),
            OsString::from("unused-test-ffprobe"),
        ),
        worker_factory,
    )
    .await
    .expect("restart recovery must complete");
    jobs.scheduler().wait_idle().await;

    let records = jobs
        .store()
        .list(100, true, Some(DERIVED_PROJECT_ID.to_owned()), None)
        .await
        .expect("recovered preparation records must list")
        .jobs;
    assert_eq!(
        records.len(),
        3,
        "recovery must materialize exactly two children"
    );
    assert_eq!(
        records
            .iter()
            .filter(|record| record.id == parent_id && record.parent_id.is_none())
            .count(),
        1
    );
    for kind in [
        MediaJobKind::AssetPreparation,
        MediaJobKind::Proxy,
        MediaJobKind::ThumbnailTile,
    ] {
        let matches = records
            .iter()
            .filter(|record| record.kind == kind)
            .collect::<Vec<_>>();
        assert_eq!(matches.len(), 1, "recovery must dedupe {kind:?}");
        assert_eq!(matches[0].state, MediaJobState::Complete);
        let events = jobs
            .store()
            .events(Some(matches[0].id.clone()), 0, 100)
            .await
            .expect("recovered job events must list");
        assert_eq!(
            events
                .events
                .iter()
                .filter(|event| event.state == MediaJobState::Complete)
                .count(),
            1,
            "{kind:?} must complete exactly once"
        );
    }
    jobs.shutdown()
        .await
        .expect("restarted preparation service must shut down");
}

#[tokio::test(flavor = "current_thread")]
async fn restart_safe_preparation_materializes_both_children_after_plan_persistence() {
    assert_preparation_restart_boundary(PreparationCrashBoundary::AfterPlanPersistence).await;
}

#[tokio::test(flavor = "current_thread")]
async fn restart_safe_preparation_materializes_thumbnail_after_proxy_child_creation() {
    assert_preparation_restart_boundary(PreparationCrashBoundary::AfterProxyChildCreation).await;
}

#[tokio::test(flavor = "current_thread")]
async fn restart_safe_preparation_requeues_interrupted_proxy_execution() {
    assert_preparation_restart_boundary(PreparationCrashBoundary::DuringProxyExecution).await;
}

pub(crate) async fn assert_durable_preparation_restart_boundaries(programs: MediaPrograms) {
    let workspace = tempdir().expect("system restart workspace must be created");
    let source = canonical_media_fixture();
    for (index, boundary) in [
        PreparationCrashBoundary::AfterPlanPersistence,
        PreparationCrashBoundary::AfterProxyChildCreation,
        PreparationCrashBoundary::DuringProxyExecution,
    ]
    .into_iter()
    .enumerate()
    {
        let case_root = workspace.path().join(format!("case-{index}"));
        let local_data_dir = case_root.join("local-data");
        let cache_root = case_root.join("app-cache");
        let owner = format!("system-restart-preparation-{index}");
        let grants = VideoPathGrants::default();
        grants
            .grant_existing_file(&owner, GrantCategory::Source, &source)
            .expect("system restart source must be granted");
        let plan = plan_asset_core(
            PrepareAssetCoreRequest {
                owner_label: &owner,
                project_id: DERIVED_PROJECT_ID,
                asset_id: DERIVED_ASSET_ID,
                source_path: &source,
                sequence_rate: Some(RationalRate {
                    numerator: 30,
                    denominator: 1,
                }),
                expected_content_identity: None,
            },
            &grants,
            &cache_root,
            &programs,
        )
        .await
        .expect("system restart plan must prepare");
        let plan = serde_json::to_value(plan).expect("system restart plan must serialize");
        let store = MediaJobStore::initialize(local_data_dir.clone())
            .await
            .expect("system restart store must initialize");
        let parent_id = enqueue_interrupted_preparation(&store, plan, boundary).await;
        drop(store);

        let jobs = MediaJobService::initialize(local_data_dir, cache_root)
            .await
            .expect("system restart service must reopen");
        resume_durable_preparations(&jobs, programs.clone())
            .await
            .expect("system FFmpeg restart recovery must complete");
        jobs.scheduler().wait_idle().await;

        let records = jobs
            .store()
            .list(100, true, Some(DERIVED_PROJECT_ID.to_owned()), None)
            .await
            .expect("system restart records must list")
            .jobs;
        assert_eq!(
            records.len(),
            3,
            "{boundary:?} must keep exactly three jobs"
        );
        for kind in [
            MediaJobKind::AssetPreparation,
            MediaJobKind::Proxy,
            MediaJobKind::ThumbnailTile,
        ] {
            let matching = records
                .iter()
                .filter(|record| record.kind == kind)
                .collect::<Vec<_>>();
            assert_eq!(matching.len(), 1, "{boundary:?} must dedupe {kind:?}");
            assert_eq!(matching[0].state, MediaJobState::Complete);
        }
        let completed = jobs
            .store()
            .get_private(parent_id.clone())
            .await
            .expect("system restart parent must load");
        let prepared: super::types::PreparedVideoAsset = serde_json::from_value(
            completed
                .result
                .expect("system restart parent must persist its result"),
        )
        .expect("system restart result must deserialize");
        assert!(Path::new(&prepared.proxy_path).is_file());
        assert!(Path::new(&prepared.thumbnail_path).is_file());
        let parent_events = jobs
            .store()
            .events(Some(parent_id), 0, 100)
            .await
            .expect("system restart parent events must list");
        assert_eq!(
            parent_events
                .events
                .iter()
                .filter(|event| event.state == MediaJobState::Complete)
                .count(),
            1,
            "{boundary:?} must complete the parent exactly once"
        );
        jobs.shutdown()
            .await
            .expect("system restart service must shut down");
    }
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn durable_preparation_restart_system_ffmpeg_proves_all_crash_boundaries() {
    assert_durable_preparation_restart_boundaries(MediaPrograms::explicit(
        OsString::from("ffmpeg"),
        OsString::from("ffprobe"),
    ))
    .await;
}

pub(crate) async fn assert_durable_preparation_records(programs: MediaPrograms) {
    let workspace = tempdir().expect("durable preparation workspace must be created");
    let cache_root = workspace.path().join("app-cache");
    let source =
        workspace_root().join("apps/desktop/src-tauri/fixtures/video-phase1/single-clip.mp4");
    let grants = VideoPathGrants::default();
    grants
        .grant_existing_file("durable-preparation", GrantCategory::Source, &source)
        .expect("canonical source must be granted");
    let jobs = MediaJobService::initialize(workspace.path().join("local-data"), cache_root.clone())
        .await
        .expect("durable media service must initialize");

    let request = || PrepareAssetCoreRequest {
        owner_label: "durable-preparation",
        project_id: DERIVED_PROJECT_ID,
        asset_id: DERIVED_ASSET_ID,
        source_path: &source,
        sequence_rate: Some(RationalRate {
            numerator: 30,
            denominator: 1,
        }),
        expected_content_identity: None,
    };
    let prepared = prepare_asset_durable(request(), &grants, &cache_root, programs.clone(), &jobs)
        .await
        .expect("durable preparation must complete");
    assert!(Path::new(&prepared.proxy_path).is_file());
    assert!(Path::new(&prepared.thumbnail_path).is_file());
    fs::remove_file(&prepared.proxy_path).expect("durable cache miss must be injectable");
    let regenerated = prepare_asset_durable(request(), &grants, &cache_root, programs, &jobs)
        .await
        .expect("durable cache miss must regenerate");
    assert_eq!(regenerated.source_identity, prepared.source_identity);
    assert_eq!(regenerated.proxy_identity, prepared.proxy_identity);
    assert_eq!(regenerated.thumbnail_identity, prepared.thumbnail_identity);
    assert!(Path::new(&regenerated.proxy_path).is_file());
    assert!(Path::new(&regenerated.thumbnail_path).is_file());

    let records = jobs
        .store()
        .list(100, true, Some(DERIVED_PROJECT_ID.to_owned()), None)
        .await
        .expect("durable records must list")
        .jobs;
    assert_eq!(records.len(), 3);
    assert_eq!(
        records
            .iter()
            .filter(|record| record.parent_id.is_none())
            .count(),
        1
    );
    assert!(records
        .iter()
        .any(|record| record.kind == MediaJobKind::Proxy));
    assert!(records
        .iter()
        .any(|record| record.kind == MediaJobKind::ThumbnailTile));
    assert!(records
        .iter()
        .all(|record| record.state == super::jobs::model::MediaJobState::Complete));
    let cache_status = jobs.cache().status().await.expect("cache status must load");
    assert_eq!(cache_status.artifact_count, 3);
    assert_eq!(cache_status.leased_artifact_count, 3);
    assert!(cache_status.managed_bytes > 0);
    jobs.shutdown()
        .await
        .expect("durable scheduler must stop cleanly");
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn durable_preparation_records_parent_and_hidden_children() {
    assert_durable_preparation_records(MediaPrograms::explicit(
        OsString::from("ffmpeg"),
        OsString::from("ffprobe"),
    ))
    .await;
}

pub(crate) async fn assert_derived_media_reuse_repair(programs: MediaPrograms) {
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
        sequence_rate: Some(RationalRate {
            numerator: 30,
            denominator: 1,
        }),
        expected_content_identity: None,
    };
    let actual_programs = || programs.clone();

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
    let mut mismatched_identity = prepared.source_identity.clone();
    mismatched_identity.digest = "ff".repeat(32);
    let mismatch_error = prepare_asset_core(
        PrepareAssetCoreRequest {
            expected_content_identity: Some(mismatched_identity),
            ..request()
        },
        &grants,
        &cache_root,
        actual_programs(),
    )
    .await
    .expect_err("an identified project asset must reject changed source bytes");
    assert_eq!(mismatch_error.code, VideoErrorCode::InvalidMedia);
    assert_eq!(
        mismatch_error.details["category"],
        "source_identity_mismatch"
    );
    let proxy_path = PathBuf::from(&prepared.proxy_path);
    let thumbnail_path = PathBuf::from(&prepared.thumbnail_path);
    assert!(proxy_path.is_file());
    assert!(thumbnail_path.is_file());
    let thumbnail_probe =
        derived_probe_thumbnail_shape_with_programs(&thumbnail_path, &programs).await;
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

    let reuse_programs = if programs.toolchain_id() == "test-explicit-programs" {
        MediaPrograms::explicit(
            OsString::from("missing-ffmpeg-proves-cache-reuse"),
            OsString::from("ffprobe"),
        )
    } else {
        programs.clone()
    };
    let reused = prepare_asset_core(request(), &grants, &cache_root, reuse_programs)
        .await
        .expect("valid prepared pair must be reused without ffmpeg");
    assert_eq!(reused, prepared);
    assert!(stale_proxy.exists());
    assert!(stale_thumbnail.exists());
    assert!(stale_partial.exists());

    fs::write(&thumbnail_path, b"non-JPEG corrupt thumbnail bytes")
        .expect("non-JPEG thumbnail corruption must be injectable");
    let repaired_non_jpeg = prepare_asset_core(request(), &grants, &cache_root, actual_programs())
        .await
        .expect("non-JPEG thumbnail bytes must be rejected and repaired");
    assert_eq!(repaired_non_jpeg, prepared);
    let repaired_probe =
        derived_probe_thumbnail_shape_with_programs(&thumbnail_path, &programs).await;
    assert_eq!(repaired_probe["streams"][0]["codec_name"], "mjpeg");
    assert_eq!(repaired_probe["streams"][0]["width"], 1_600);
    assert_eq!(repaired_probe["streams"][0]["height"], 90);

    let png_thumbnail = workspace.path().join("wrong-codec-thumbnail.png");
    write_thumbnail_image_with_programs(&png_thumbnail, "png", 1_600, 90, &programs).await;
    let png_probe = derived_probe_thumbnail_shape_with_programs(&png_thumbnail, &programs).await;
    assert_eq!(png_probe["streams"][0]["codec_name"], "png");
    fs::copy(&png_thumbnail, &thumbnail_path)
        .expect("PNG bytes must replace only the exact thumbnail artifact");
    assert_eq!(
        fs::read(&thumbnail_path).expect("replaced thumbnail bytes must read"),
        fs::read(&png_thumbnail).expect("PNG fixture bytes must read")
    );
    let repaired_wrong_codec =
        prepare_asset_core(request(), &grants, &cache_root, actual_programs())
            .await
            .expect("wrong thumbnail codec must be rejected and repaired");
    assert_eq!(repaired_wrong_codec, prepared);
    let repaired_probe =
        derived_probe_thumbnail_shape_with_programs(&thumbnail_path, &programs).await;
    assert_eq!(repaired_probe["streams"][0]["codec_name"], "mjpeg");
    assert_eq!(repaired_probe["streams"][0]["width"], 1_600);
    assert_eq!(repaired_probe["streams"][0]["height"], 90);

    write_thumbnail_image_with_programs(&thumbnail_path, "mjpeg", 800, 90, &programs).await;
    let wrong_dimensions_probe =
        derived_probe_thumbnail_shape_with_programs(&thumbnail_path, &programs).await;
    assert_eq!(wrong_dimensions_probe["streams"][0]["codec_name"], "mjpeg");
    assert_eq!(wrong_dimensions_probe["streams"][0]["width"], 800);
    let repaired_wrong_dimensions =
        prepare_asset_core(request(), &grants, &cache_root, actual_programs())
            .await
            .expect("wrong thumbnail dimensions must be rejected and repaired");
    assert_eq!(repaired_wrong_dimensions, prepared);
    let repaired_probe =
        derived_probe_thumbnail_shape_with_programs(&thumbnail_path, &programs).await;
    assert_eq!(repaired_probe["streams"][0]["codec_name"], "mjpeg");
    assert_eq!(repaired_probe["streams"][0]["width"], 1_600);
    assert_eq!(repaired_probe["streams"][0]["height"], 90);

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
    assert!(stale_proxy.exists());
    assert!(stale_thumbnail.exists());
    assert!(stale_partial.exists());
    let repaired_thumbnail_probe =
        derived_probe_thumbnail_shape_with_programs(&thumbnail_path, &programs).await;
    assert_eq!(
        repaired_thumbnail_probe["streams"][0]["codec_name"],
        "mjpeg"
    );
    assert_eq!(repaired_thumbnail_probe["streams"][0]["width"], 1_600);
    assert_eq!(repaired_thumbnail_probe["streams"][0]["height"], 90);

    for entry in fs::read_dir(&profile_directory).expect("artifact directory must remain readable")
    {
        let entry = entry.expect("artifact entry must be readable");
        let name = entry.file_name().to_string_lossy().into_owned();
        assert!(
            !name.starts_with(".derive-"),
            "temporary artifact survived: {name}"
        );
    }
    assert_eq!(
        fs::read(&stale_proxy).expect("unrelated proxy-like file must survive"),
        b"stale-owned-artifact"
    );
    assert_eq!(
        fs::read(&stale_thumbnail).expect("unrelated thumbnail-like file must survive"),
        b"stale-owned-artifact"
    );
}

#[tokio::test(flavor = "current_thread")]
#[ignore = "requires system FFmpeg and the canonical media fixture"]
async fn derived_local_ffmpeg_prepares_reuses_and_repairs_controlled_artifacts() {
    assert_derived_media_reuse_repair(MediaPrograms::explicit(
        OsString::from("ffmpeg"),
        OsString::from("ffprobe"),
    ))
    .await;
}

fn assert_no_ingest_partials(root: &Path) {
    if !root.exists() {
        return;
    }
    for entry in fs::read_dir(root).expect("media store directory must be readable") {
        let entry = entry.expect("media store entry must be readable");
        let path = entry.path();
        if path.is_dir() {
            assert_no_ingest_partials(&path);
        } else {
            let name = entry.file_name().to_string_lossy().into_owned();
            assert!(
                !name.starts_with(".ingest-") && !name.ends_with(".part"),
                "ingest partial survived: {name}"
            );
        }
    }
}

#[test]
fn content_addressed_ingest_deduplicates_repairs_and_preserves_unrelated_files() {
    let workspace = tempdir().expect("media store workspace must exist");
    let first_source = workspace.path().join("first-name.mp4");
    let second_source = workspace.path().join("second-name.mov");
    let bytes = b"same exact source bytes";
    fs::write(&first_source, bytes).expect("first source must write");
    fs::write(&second_source, bytes).expect("second source must write");
    let cache = workspace.path().join("cache");

    let first = ingest_blocking_for_test(
        first_source
            .canonicalize()
            .expect("first source must canonicalize"),
        cache.clone(),
    )
    .expect("first source must ingest");
    let second = ingest_blocking_for_test(
        second_source
            .canonicalize()
            .expect("second source must canonicalize"),
        cache.clone(),
    )
    .expect("duplicate source must ingest");
    assert_eq!(first.identity, second.identity);
    assert_eq!(first.object_path, second.object_path);
    assert_ne!(first.fingerprint.digest, second.fingerprint.digest);

    let unrelated = cache.join(MEDIA_STORE_NAMESPACE).join("unrelated.keep");
    fs::write(&unrelated, b"do not delete").expect("unrelated file must write");
    fs::write(&first.object_path, b"corrupt").expect("owned object must be corruptible");
    let repaired = ingest_blocking_for_test(
        first_source
            .canonicalize()
            .expect("source must canonicalize"),
        cache.clone(),
    )
    .expect("corrupt exact object must repair");
    assert_eq!(repaired.identity, first.identity);
    assert_eq!(
        fs::read(&repaired.object_path).expect("repaired object must read"),
        bytes
    );
    assert_eq!(
        fs::read(unrelated).expect("unrelated file must survive"),
        b"do not delete"
    );
    assert_no_ingest_partials(&cache);
}

#[test]
fn content_addressed_ingest_mutation_and_concurrency_select_safe_objects() {
    let workspace = tempdir().expect("media mutation workspace must exist");
    let source = workspace.path().join("source.bin");
    fs::write(&source, b"version one").expect("source must write");
    let source = source.canonicalize().expect("source must canonicalize");
    let cache = workspace.path().join("cache");
    let original = ingest_blocking_for_test(source.clone(), cache.clone())
        .expect("original source must ingest");
    fs::write(&source, b"version two").expect("source mutation must write");
    let mutated = ingest_blocking_for_test(source.clone(), cache.clone())
        .expect("mutated source must ingest");
    assert_ne!(original.identity.digest, mutated.identity.digest);
    assert_ne!(original.object_path, mutated.object_path);

    let mut workers = Vec::new();
    for _ in 0..8 {
        let source = source.clone();
        let cache = cache.clone();
        workers.push(thread::spawn(move || {
            ingest_blocking_for_test(source, cache).expect("concurrent ingest must converge")
        }));
    }
    let results: Vec<_> = workers
        .into_iter()
        .map(|worker| worker.join().expect("ingest worker must not panic"))
        .collect();
    assert!(results
        .iter()
        .all(|result| result.object_path == mutated.object_path));
    assert_no_ingest_partials(&cache);
}

#[test]
fn content_addressed_ingest_failpoints_leave_no_promoted_partial() {
    for failpoint in [
        IngestFailpoint::Read,
        IngestFailpoint::ChangedDuringRead,
        IngestFailpoint::Write,
        IngestFailpoint::Flush,
        IngestFailpoint::Sync,
        IngestFailpoint::Promotion,
        IngestFailpoint::PostPromotion,
    ] {
        let workspace = tempdir().expect("failpoint workspace must exist");
        let source = workspace.path().join("source.bin");
        fs::write(&source, b"failpoint source bytes").expect("source must write");
        let cache = workspace.path().join("cache");
        assert!(ingest_with_failpoint_for_test(
            source.canonicalize().expect("source must canonicalize"),
            cache.clone(),
            failpoint,
        )
        .is_err());
        assert_no_ingest_partials(&cache);
        let object_root = cache.join(MEDIA_STORE_NAMESPACE).join("objects");
        if object_root.exists() {
            let promoted_objects = walk_regular_files(&object_root);
            assert!(
                promoted_objects.is_empty(),
                "failpoint {failpoint:?} promoted an object: {promoted_objects:?}"
            );
        }
    }
}

#[derive(Clone)]
struct SourcePublicationGateWorker {
    source: PathBuf,
    cache_root: PathBuf,
    cache: MediaCacheService,
    failpoint: IngestFailpoint,
}

impl MediaJobWorker for SourcePublicationGateWorker {
    fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let source = self.source.clone();
        let cache_root = self.cache_root.clone();
        let cache = self.cache.clone();
        let failpoint = self.failpoint;
        Box::pin(async move {
            let ingested = match ingest_with_failpoint_for_test(source, cache_root, failpoint) {
                Ok(ingested) => ingested,
                Err(_) => return publication_gate_failure(),
            };
            if cache
                .register(CacheArtifactRegistration {
                    key: ingested.identity.digest.clone(),
                    content_digest: ingested.identity.digest,
                    kind: CacheArtifactKind::SourceObject,
                    path: ingested.object_path,
                    profile_id: None,
                    toolchain_id: None,
                    recipe_id: None,
                })
                .await
                .is_err()
            {
                return publication_gate_failure();
            }
            MediaWorkerOutcome::Complete {
                result: serde_json::json!({ "published": true }),
                progress: MediaJobProgress {
                    completed: 1,
                    total: 1,
                    unit: MediaJobProgressUnit::Items,
                },
            }
        })
    }
}

#[derive(Clone)]
struct PublicationGateWorker {
    cache_root: PathBuf,
    cache: MediaCacheService,
    key: String,
    failpoint: PublicationFailpoint,
}

fn publication_gate_failure() -> MediaWorkerOutcome {
    MediaWorkerOutcome::Failed {
        error: MediaJobError {
            code: "durable_publication_failed".to_owned(),
            category: MediaJobErrorCategory::IntegrityFailed,
            message: "Durable publication did not cross its commit gate.".to_owned(),
            retryable: false,
            action: None,
        },
        progress: MediaJobProgress {
            completed: 0,
            total: 1,
            unit: MediaJobProgressUnit::Items,
        },
    }
}

impl MediaJobWorker for PublicationGateWorker {
    fn run(&self, _job_id: String, _cancellation: ProcessCancellation) -> MediaWorkerFuture {
        let cache_root = self.cache_root.clone();
        let cache = self.cache.clone();
        let key = self.key.clone();
        let failpoint = self.failpoint;
        Box::pin(async move {
            let guard = match acquire_artifact(&cache_root, ArtifactStoreKind::Proxy, &key).await {
                Ok(guard) => guard,
                Err(_) => return publication_gate_failure(),
            };
            let mut temporary = match guard.temporary() {
                Ok(temporary) => temporary,
                Err(_) => return publication_gate_failure(),
            };
            if temporary.write_all(b"durable derived bytes").is_err() {
                return publication_gate_failure();
            }
            if guard
                .promote_with_failpoint_for_test(temporary, failpoint)
                .is_err()
            {
                return publication_gate_failure();
            }
            if fs::read(guard.path()).ok().as_deref() != Some(b"durable derived bytes")
                || guard.confirm_durable().is_err()
            {
                return publication_gate_failure();
            }
            if cache
                .register(CacheArtifactRegistration {
                    key: key.clone(),
                    content_digest: key.clone(),
                    kind: CacheArtifactKind::Proxy,
                    path: guard.path().to_path_buf(),
                    profile_id: None,
                    toolchain_id: None,
                    recipe_id: None,
                })
                .await
                .is_err()
            {
                return publication_gate_failure();
            }
            MediaWorkerOutcome::Complete {
                result: serde_json::json!({ "path": guard.path() }),
                progress: MediaJobProgress {
                    completed: 1,
                    total: 1,
                    unit: MediaJobProgressUnit::Items,
                },
            }
        })
    }
}

#[tokio::test(flavor = "current_thread")]
async fn durability_failpoints_block_catalog_registration_and_job_completion() {
    for (index, failpoint) in [
        PublicationFailpoint::BeforeRename,
        PublicationFailpoint::AfterRename,
    ]
    .into_iter()
    .enumerate()
    {
        let workspace = tempdir().expect("durability gate workspace must exist");
        let cache_root = workspace.path().join("cache");
        let jobs =
            MediaJobService::initialize(workspace.path().join("local-data"), cache_root.clone())
                .await
                .expect("durability gate media service must initialize");
        let key = format!("{:064x}", index + 1);
        let job = jobs
            .store()
            .enqueue(NewMediaJob {
                kind: MediaJobKind::Proxy,
                parent_id: None,
                dedupe_key: format!("durability-gate-{index}"),
                project_id: None,
                asset_id: None,
                revision_id: None,
                priority: MediaJobPriority::Interactive,
                priority_value: 0,
                stage: "queued".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 1,
                    unit: MediaJobProgressUnit::Items,
                },
                max_attempts: 1,
                summary: "Prove durable publication gate".to_owned(),
                private_payload: serde_json::json!({}),
                created_at_ms: current_timestamp_millis(),
            })
            .await
            .expect("durability gate job must enqueue")
            .job;
        jobs.scheduler()
            .submit(
                job.id.clone(),
                job.priority,
                job.attempt,
                job.max_attempts,
                SchedulerResource::BlockingIo,
                Arc::new(PublicationGateWorker {
                    cache_root: cache_root.clone(),
                    cache: jobs.cache().clone(),
                    key: key.clone(),
                    failpoint,
                }),
            )
            .await
            .expect("durability gate worker must submit");
        jobs.scheduler().wait_idle().await;

        let stored = jobs
            .store()
            .get_private(job.id.clone())
            .await
            .expect("durability gate job must load");
        assert_eq!(stored.public.state, MediaJobState::Failed);
        assert!(
            stored.result.is_none(),
            "failed gate cannot persist a result"
        );
        let events = jobs
            .store()
            .events(Some(job.id), 0, 100)
            .await
            .expect("durability gate events must load");
        assert!(!events
            .events
            .iter()
            .any(|event| event.state == MediaJobState::Complete));
        let status = jobs.cache().status().await.expect("cache status must load");
        assert_eq!(
            status.artifact_count, 0,
            "failed gate cannot register a row"
        );
        let destination = cache_root
            .join(MEDIA_STORE_NAMESPACE)
            .join("derived")
            .join("proxy")
            .join(&key[..2])
            .join(format!("{key}.mp4"));
        assert!(
            !destination.exists(),
            "failed gate must clean its publication"
        );
        jobs.shutdown()
            .await
            .expect("durability gate service must shut down");
    }
}

#[tokio::test(flavor = "current_thread")]
async fn source_durability_failpoints_block_catalog_registration_and_job_completion() {
    for (index, failpoint) in [IngestFailpoint::Promotion, IngestFailpoint::PostPromotion]
        .into_iter()
        .enumerate()
    {
        let workspace = tempdir().expect("source durability workspace must exist");
        let source = workspace.path().join("source.bin");
        fs::write(&source, b"durable source bytes").expect("source bytes must write");
        let source = source.canonicalize().expect("source must canonicalize");
        let cache_root = workspace.path().join("cache");
        let jobs =
            MediaJobService::initialize(workspace.path().join("local-data"), cache_root.clone())
                .await
                .expect("source durability service must initialize");
        let job = jobs
            .store()
            .enqueue(NewMediaJob {
                kind: MediaJobKind::AssetPreparation,
                parent_id: None,
                dedupe_key: format!("source-durability-gate-{index}"),
                project_id: None,
                asset_id: None,
                revision_id: None,
                priority: MediaJobPriority::Interactive,
                priority_value: 0,
                stage: "queued".to_owned(),
                progress: MediaJobProgress {
                    completed: 0,
                    total: 1,
                    unit: MediaJobProgressUnit::Items,
                },
                max_attempts: 1,
                summary: "Prove durable source publication gate".to_owned(),
                private_payload: serde_json::json!({}),
                created_at_ms: current_timestamp_millis(),
            })
            .await
            .expect("source durability job must enqueue")
            .job;
        jobs.scheduler()
            .submit(
                job.id.clone(),
                job.priority,
                job.attempt,
                job.max_attempts,
                SchedulerResource::BlockingIo,
                Arc::new(SourcePublicationGateWorker {
                    source,
                    cache_root: cache_root.clone(),
                    cache: jobs.cache().clone(),
                    failpoint,
                }),
            )
            .await
            .expect("source durability worker must submit");
        jobs.scheduler().wait_idle().await;

        let stored = jobs
            .store()
            .get_private(job.id.clone())
            .await
            .expect("source durability job must load");
        assert_eq!(stored.public.state, MediaJobState::Failed);
        assert!(stored.result.is_none());
        let events = jobs
            .store()
            .events(Some(job.id), 0, 100)
            .await
            .expect("source durability events must load");
        assert!(!events
            .events
            .iter()
            .any(|event| event.state == MediaJobState::Complete));
        let status = jobs.cache().status().await.expect("cache status must load");
        assert_eq!(
            status.artifact_count, 0,
            "failed source cannot register a row"
        );
        let object_root = cache_root.join(MEDIA_STORE_NAMESPACE).join("objects");
        assert!(
            !object_root.exists() || walk_regular_files(&object_root).is_empty(),
            "failed source gate must clean its publication"
        );
        jobs.shutdown()
            .await
            .expect("source durability service must shut down");
    }
}

fn walk_regular_files(root: &Path) -> Vec<PathBuf> {
    let mut files = Vec::new();
    for entry in fs::read_dir(root).expect("directory must be readable") {
        let path = entry.expect("entry must be readable").path();
        if path.is_dir() {
            files.extend(walk_regular_files(&path));
        } else {
            files.push(path);
        }
    }
    files
}

#[test]
fn content_addressed_store_rejects_components_symlinks_and_lock_contention() {
    let workspace = tempdir().expect("containment workspace must exist");
    let root = workspace
        .path()
        .canonicalize()
        .expect("root must canonicalize");
    for malformed in ["", ".", "..", "a/b", "a\\b", "nul\0part"] {
        assert!(ensure_direct_directory_for_test(&root, malformed).is_err());
    }
    let non_directory = root.join("ordinary-file");
    fs::write(&non_directory, b"file").expect("ordinary file must write");
    assert!(ensure_direct_directory_for_test(&root, "ordinary-file").is_err());

    let lock_path = root.join("held.lock");
    let held = lock_file_for_test(&lock_path, Duration::from_secs(1))
        .expect("first lock must be acquired");
    let contender_path = lock_path.clone();
    let contender =
        thread::spawn(move || lock_file_for_test(&contender_path, Duration::from_millis(75)));
    assert!(
        contender
            .join()
            .expect("lock contender must not panic")
            .is_err(),
        "contended lock must time out"
    );
    drop(held);
    lock_file_for_test(&lock_path, Duration::from_secs(1))
        .expect("released lock must be reacquired");

    let target = root.join("target-directory");
    fs::create_dir(&target).expect("target directory must exist");
    let link = root.join("linked-directory");
    #[cfg(windows)]
    let linked = std::os::windows::fs::symlink_dir(&target, &link).is_ok();
    #[cfg(unix)]
    let linked = std::os::unix::fs::symlink(&target, &link).is_ok();
    #[cfg(not(any(windows, unix)))]
    let linked = false;
    if linked {
        assert!(ensure_direct_directory_for_test(&root, "linked-directory").is_err());
    }
}

#[test]
fn source_fingerprint_matches_shared_utf8_vector_and_changes_with_path() {
    let vector = source_fingerprint_bytes_for_test(
        "/media/café.mp4".as_bytes(),
        123_456,
        1_720_000_000,
        123_456_789,
    )
    .expect("shared fingerprint vector must derive");
    assert_eq!(
        vector.digest,
        "3f93442f2ca6148106623062a8f44483bac6fd0de29fa903dca3da1dd895ee39"
    );
    let path_vector = source_fingerprint_for_test(
        Path::new("/media/café.mp4"),
        123_456,
        1_720_000_000,
        123_456_789,
    )
    .expect("UTF-8 path fingerprint vector must derive");
    assert_eq!(path_vector, vector);
    let renamed = source_fingerprint_for_test(
        Path::new("/media/renamed.mp4"),
        123_456,
        1_720_000_000,
        123_456_789,
    )
    .expect("renamed fingerprint must derive");
    assert_ne!(vector.digest, renamed.digest);
}

#[tokio::test]
async fn ingest_authorizes_before_creating_the_store() {
    let workspace = tempdir().expect("authorization workspace must exist");
    let source = workspace.path().join("source.bin");
    fs::write(&source, b"authorization source").expect("source must write");
    let cache = workspace.path().join("cache-must-not-exist");
    let grants = VideoPathGrants::default();
    assert!(
        super::media_store::ingest_source("ungranted-owner", &grants, &source, &cache,)
            .await
            .is_err()
    );
    assert!(
        !cache.exists(),
        "grant rejection must precede store creation"
    );
}

#[test]
fn rust_media_identity_matches_shared_vector() {
    let profile_identity =
        derive_profile_identity(&PREVIEW_PROFILE).expect("preview profile identity must derive");
    assert_eq!(
        profile_identity.profile_digest,
        "b055cc1bf33f212debe685eeb7b19a1e0d0a31843e5780ac97b4c97eee0f97c4"
    );
    let argv = [
        "-i",
        "{source}",
        "-map",
        "0:v:0",
        "-c:v",
        "libx264",
        "{destination}",
    ]
    .into_iter()
    .map(str::to_owned)
    .collect::<Vec<_>>();
    let validation = ["regular_nonzero", "probe_size_exact", "h264_yuv420p"]
        .into_iter()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    let recipe_digest = derive_recipe_digest(DerivedArtifactKind::Proxy, &argv, &validation)
        .expect("shared recipe digest must derive");
    assert_eq!(
        recipe_digest,
        "7a27f8436627ebc489d09fedeb040190de32b4443efc42ecfdb86e3334864bb9"
    );
    let source_identity = MediaContentIdentityV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest: "0123456789abcdef".repeat(4),
        byte_length: 123_456,
    };
    let identity = derive_media_identity(
        DerivedArtifactKind::Proxy,
        &source_identity,
        "ffmpeg-test-v1",
        &profile_identity,
        &recipe_digest,
    )
    .expect("shared derived identity must derive");
    assert_eq!(
        identity.key,
        "e27c60d494f85cb45da098ea8c803f3cf24b2dc9fdd56ad7569e4c02033c1cc5"
    );
}

#[test]
fn output_affecting_inputs_invalidate_recipe_profile_and_derived_keys() {
    let rate = RationalRate {
        numerator: 30,
        denominator: 1,
    };
    let dimensions = OutputDimensions {
        width: 1_280,
        height: 720,
    };
    let (proxy_argv, proxy_validation) = proxy_recipe(dimensions, &rate, false, 0, Some(1))
        .expect("baseline proxy recipe must derive");
    let proxy_digest =
        derive_recipe_digest(DerivedArtifactKind::Proxy, &proxy_argv, &proxy_validation)
            .expect("baseline proxy digest must derive");
    for changed in [
        proxy_recipe(
            OutputDimensions {
                width: 640,
                height: 360,
            },
            &rate,
            false,
            0,
            Some(1),
        ),
        proxy_recipe(
            dimensions,
            &RationalRate {
                numerator: 24,
                denominator: 1,
            },
            false,
            0,
            Some(1),
        ),
        proxy_recipe(dimensions, &rate, true, 0, Some(1)),
        proxy_recipe(dimensions, &rate, false, 2, Some(1)),
        proxy_recipe(dimensions, &rate, false, 0, None),
    ] {
        let (argv, validation) = changed.expect("changed proxy recipe must derive");
        assert_ne!(
            derive_recipe_digest(DerivedArtifactKind::Proxy, &argv, &validation)
                .expect("changed proxy digest must derive"),
            proxy_digest
        );
    }

    let (thumbnail_argv, thumbnail_validation) =
        thumbnail_recipe(2_000_000, 0).expect("baseline thumbnail recipe must derive");
    let thumbnail_digest = derive_recipe_digest(
        DerivedArtifactKind::ThumbnailTile,
        &thumbnail_argv,
        &thumbnail_validation,
    )
    .expect("baseline thumbnail digest must derive");
    for changed in [
        thumbnail_recipe(3_000_000, 0),
        thumbnail_recipe(2_000_000, 2),
    ] {
        let (argv, validation) = changed.expect("changed thumbnail recipe must derive");
        assert_ne!(
            derive_recipe_digest(DerivedArtifactKind::ThumbnailTile, &argv, &validation)
                .expect("changed thumbnail digest must derive"),
            thumbnail_digest
        );
    }

    let baseline_profile =
        derive_profile_identity(&PREVIEW_PROFILE).expect("baseline profile must derive");
    let mut changed_profile = PREVIEW_PROFILE;
    changed_profile.proxy_color_transfer = "smpte2084";
    assert_ne!(
        derive_profile_identity(&changed_profile)
            .expect("changed profile must derive")
            .profile_digest,
        baseline_profile.profile_digest
    );
    changed_profile = PREVIEW_PROFILE;
    changed_profile.thumbnail_count += 1;
    assert_ne!(
        derive_profile_identity(&changed_profile)
            .expect("changed sampling profile must derive")
            .profile_digest,
        baseline_profile.profile_digest
    );

    let source_identity = MediaContentIdentityV1 {
        schema_version: 1,
        algorithm: MediaContentAlgorithm::Sha256,
        digest: "11".repeat(32),
        byte_length: 100,
    };
    let baseline = derive_media_identity(
        DerivedArtifactKind::Proxy,
        &source_identity,
        "toolchain-a",
        &baseline_profile,
        &proxy_digest,
    )
    .expect("baseline identity must derive");
    let changed_toolchain = derive_media_identity(
        DerivedArtifactKind::Proxy,
        &source_identity,
        "toolchain-b",
        &baseline_profile,
        &proxy_digest,
    )
    .expect("toolchain identity must derive");
    let changed_source = derive_media_identity(
        DerivedArtifactKind::Proxy,
        &MediaContentIdentityV1 {
            digest: "22".repeat(32),
            ..source_identity
        },
        "toolchain-a",
        &baseline_profile,
        &proxy_digest,
    )
    .expect("source identity must derive");
    assert_ne!(baseline.key, changed_toolchain.key);
    assert_ne!(baseline.key, changed_source.key);

    let mut reordered = proxy_argv;
    reordered.swap(0, 1);
    assert_ne!(
        derive_recipe_digest(DerivedArtifactKind::Proxy, &reordered, &proxy_validation)
            .expect("reordered recipe must derive"),
        proxy_digest
    );
}
