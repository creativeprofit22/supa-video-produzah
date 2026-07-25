use std::{
    env,
    ffi::OsString,
    fs,
    io::Write,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use serde::Deserialize;
use serde_json::Value;
use tempfile::{tempdir, NamedTempFile};

use super::{
    error::{VideoCommandError, VideoErrorCode},
    grants::{GrantCategory, VideoPathGrants},
    probe::{
        parse_ffprobe_json, parse_tool_banner, probe_media_with_program, tool_info_from_result,
        video_ffmpeg_status_with_programs, VideoTool,
    },
    process::{
        run_supervised_with_test_environment, ProcessCancellation, ProcessFailure, ProcessSpec,
        SupervisedOutput,
    },
    project_io::{
        atomic_save_with, dialog_path, ensure_canonical_source_containment, open_project_from_path,
        read_project_bounded, sanitize_default_name, save_project_to_path, VideoSourceStatus,
        MAX_PROJECT_BYTES,
    },
    types::{
        is_recognizable_absolute_path, parse_project_json, parse_project_value, RationalRate,
        VideoProjectFileV1, VideoToolProblem,
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
        .env(PROCESS_HELPER_READY_MARKER_ENV, ready_marker)
        .env(PROCESS_HELPER_SURVIVOR_MARKER_ENV, survivor_marker)
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    let mut grandchild = grandchild
        .spawn()
        .expect("process-tree grandchild must spawn without a shell");

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

    let ready_marker = env::var_os(PROCESS_HELPER_READY_MARKER_ENV)
        .expect("process-tree ready marker must be configured");
    fs::write(ready_marker, b"ready").expect("process-tree ready marker must be writable");
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
