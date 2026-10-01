//! Local crash diagnostics. A panic hook writes a small, redacted JSON report
//! to `<app local data>/crash-reports/`; the next launch surfaces pending
//! reports through `app_take_crash_reports` and marks them seen. Reports never
//! leave the machine (no network) and never contain absolute paths, user
//! names, e-mail addresses or long tokens.

use std::{
    fs,
    io::Write,
    panic::PanicHookInfo,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};

pub(crate) const CRASH_DIR: &str = "crash-reports";
const MESSAGE_LIMIT: usize = 2_048;
const RETAINED_REPORTS: usize = 10;
const REPORT_LIMIT_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CrashReport {
    pub schema_version: u32,
    pub app_version: String,
    pub occurred_at_ms: u64,
    pub thread: String,
    /// `file:line` relative to the crate; never an absolute path.
    pub location: Option<String>,
    pub message: String,
}

/// Replaces anything that could identify the user or leak a secret.
pub(crate) fn redact(input: &str) -> String {
    let mut output = String::with_capacity(input.len().min(MESSAGE_LIMIT));
    for token in split_keep_whitespace(input) {
        output.push_str(&redact_token(token));
        if output.len() >= MESSAGE_LIMIT {
            break;
        }
    }
    let mut cut = output.len().min(MESSAGE_LIMIT);
    while !output.is_char_boundary(cut) {
        cut -= 1;
    }
    output.truncate(cut);
    output
}

fn split_keep_whitespace(input: &str) -> impl Iterator<Item = &str> {
    let mut rest = input;
    std::iter::from_fn(move || {
        if rest.is_empty() {
            return None;
        }
        let first_ws = rest.starts_with(char::is_whitespace);
        let end = rest
            .char_indices()
            .find(|(_, c)| c.is_whitespace() != first_ws)
            .map_or(rest.len(), |(index, _)| index);
        let (token, tail) = rest.split_at(end);
        rest = tail;
        Some(token)
    })
}

fn redact_token(token: &str) -> String {
    if token.trim().is_empty() {
        return token.to_owned();
    }
    let trimmed =
        token.trim_matches(|c: char| matches!(c, '"' | '\'' | '(' | ')' | ',' | ';' | '`'));
    let is_windows_path = trimmed.len() > 2
        && trimmed.as_bytes()[1] == b':'
        && trimmed.as_bytes()[0].is_ascii_alphabetic()
        && matches!(trimmed.as_bytes()[2], b'\\' | b'/');
    let is_unc = trimmed.starts_with("\\\\");
    let is_unix_path = trimmed.starts_with('/') && trimmed[1..].contains('/');
    let is_home = trimmed.starts_with("~/") || trimmed.starts_with("~\\");
    if is_windows_path || is_unc || is_unix_path || is_home {
        return token.replace(trimmed, "<path>");
    }
    if trimmed.contains('@') && trimmed.contains('.') && !trimmed.starts_with('@') {
        return token.replace(trimmed, "<email>");
    }
    let secretish = trimmed.len() >= 24
        && trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '+' | '/' | '=' | '.'))
        && trimmed.chars().any(|c| c.is_ascii_digit())
        && trimmed.chars().any(|c| c.is_ascii_alphabetic());
    if secretish {
        return token.replace(trimmed, "<redacted>");
    }
    token.to_owned()
}

fn relative_location(file: &str, line: u32) -> String {
    let normalized = file.replace('\\', "/");
    let relative = normalized
        .rsplit_once("/src/")
        .map(|(_, tail)| tail)
        .or_else(|| normalized.strip_prefix("src/"))
        .unwrap_or(normalized.as_str());
    let name = if relative.contains(':') || relative.starts_with('/') {
        relative.rsplit('/').next().unwrap_or("unknown")
    } else {
        relative
    };
    format!("{name}:{line}")
}

pub(crate) fn report_from_parts(
    payload: Option<&str>,
    location: Option<(&str, u32)>,
    thread: Option<&str>,
    now_ms: u64,
) -> CrashReport {
    CrashReport {
        schema_version: 1,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        occurred_at_ms: now_ms,
        thread: redact(thread.unwrap_or("unnamed")),
        location: location.map(|(file, line)| relative_location(file, line)),
        message: redact(payload.unwrap_or("panic without a text message")),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

/// Writes one report atomically and prunes the oldest beyond the retention cap.
pub(crate) fn write_report(dir: &Path, report: &CrashReport) -> std::io::Result<PathBuf> {
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec_pretty(report).map_err(std::io::Error::other)?;
    let mut temporary = tempfile::Builder::new()
        .prefix(".crash-")
        .suffix(".part")
        .tempfile_in(dir)?;
    temporary.write_all(&bytes)?;
    temporary.as_file().sync_all()?;
    let target = dir.join(format!(
        "crash-{:020}-{}.json",
        report.occurred_at_ms,
        std::process::id()
    ));
    temporary.persist(&target).map_err(|error| error.error)?;
    prune(dir)?;
    Ok(target)
}

fn report_files(dir: &Path, suffix: &str) -> std::io::Result<Vec<PathBuf>> {
    let mut files: Vec<PathBuf> = match fs::read_dir(dir) {
        Ok(entries) => entries
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_ok_and(|kind| kind.is_file()))
            .map(|entry| entry.path())
            .filter(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("crash-") && name.ends_with(suffix))
            })
            .collect(),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(error) => return Err(error),
    };
    files.sort();
    Ok(files)
}

fn prune(dir: &Path) -> std::io::Result<()> {
    let mut all = report_files(dir, ".json")?;
    all.sort_by_key(|path| {
        path.file_name().and_then(|name| name.to_str()).map(|name| {
            name.trim_end_matches(".seen.json")
                .trim_end_matches(".json")
                .to_owned()
        })
    });
    while all.len() > RETAINED_REPORTS {
        let oldest = all.remove(0);
        let _ = fs::remove_file(oldest);
    }
    Ok(())
}

/// Returns unseen reports (oldest first) and renames them `*.seen.json`.
/// Malformed or oversized files are skipped and marked seen, never surfaced raw.
pub(crate) fn take_pending(dir: &Path) -> std::io::Result<Vec<CrashReport>> {
    let mut reports = Vec::new();
    for path in report_files(dir, ".json")? {
        let name = path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or_default();
        if name.ends_with(".seen.json") {
            continue;
        }
        let parsed = fs::metadata(&path)
            .ok()
            .filter(|metadata| metadata.len() <= REPORT_LIMIT_BYTES)
            .and_then(|_| fs::read(&path).ok())
            .and_then(|bytes| serde_json::from_slice::<CrashReport>(&bytes).ok());
        if let Some(report) = parsed {
            reports.push(report);
        }
        let seen = path.with_file_name(name.replace(".json", ".seen.json"));
        fs::rename(&path, seen)?;
    }
    Ok(reports)
}

/// Installs the hook once at startup, chaining the previous (default) hook so
/// the usual stderr output is unchanged.
pub(crate) fn install_panic_hook(dir: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info: &PanicHookInfo<'_>| {
        let payload = info
            .payload()
            .downcast_ref::<&str>()
            .copied()
            .or_else(|| info.payload().downcast_ref::<String>().map(String::as_str));
        let location = info
            .location()
            .map(|location| (location.file(), location.line()));
        let thread = std::thread::current();
        let report = report_from_parts(payload, location, thread.name(), now_ms());
        let _ = write_report(&dir, &report);
        previous(info);
    }));
}

/// Pending crash reports from earlier runs; empty when there are none.
#[tauri::command]
pub async fn app_take_crash_reports<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
) -> Result<Vec<CrashReport>, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_local_data_dir()
        .map_err(|_| "crash_reports_unavailable".to_owned())?
        .join(CRASH_DIR);
    tauri::async_runtime::spawn_blocking(move || take_pending(&dir))
        .await
        .map_err(|_| "crash_reports_unavailable".to_owned())?
        .map_err(|_| "crash_reports_unavailable".to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn redacts_paths_emails_and_tokens_but_keeps_plain_words() {
        for (input, expected) in [
            (
                "failed to open C:\\Users\\alice\\Videos\\secret.mp4: denied",
                "failed to open <path> denied",
            ),
            (
                "read '/home/alice/project/a.svpvideo' failed",
                "read '<path>' failed",
            ),
            (
                "share \\\\server\\share\\file.mp4 gone",
                "share <path> gone",
            ),
            ("contact alice.smith@example.com now", "contact <email> now"),
            (
                "token sk-ant-api03-AbCdEf0123456789xyzXYZ leaked",
                "token <redacted> leaked",
            ),
            (
                "index out of bounds: the len is 3 but the index is 7",
                "index out of bounds: the len is 3 but the index is 7",
            ),
            ("~/Library/app.log missing", "<path> missing"),
        ] {
            assert_eq!(redact(input), expected, "{input}");
        }
    }

    #[test]
    fn bounds_message_size_on_a_char_boundary() {
        let long = "é".repeat(5_000);
        let redacted = redact(&long);
        assert!(redacted.len() <= MESSAGE_LIMIT);
        assert!(redacted.chars().all(|c| c == 'é'));
    }

    #[test]
    fn location_is_relative_and_never_absolute() {
        let report = report_from_parts(
            Some("boom at D:\\a\\b.rs"),
            Some((
                "C:\\build\\apps\\desktop\\src-tauri\\src\\video\\render.rs",
                42,
            )),
            Some("tokio-runtime-worker"),
            7,
        );
        assert_eq!(report.location.as_deref(), Some("video/render.rs:42"));
        assert_eq!(report.message, "boom at <path>");
        let json = serde_json::to_string(&report).unwrap();
        assert!(!json.contains("C:\\\\") && !json.contains("build"));
        assert_eq!(
            report_from_parts(
                None,
                Some(("/rustc/abc/library/core/src/panic.rs", 1)),
                None,
                0
            )
            .location
            .as_deref(),
            Some("panic.rs:1")
        );
    }

    #[test]
    fn write_take_marks_seen_skips_malformed_and_prunes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(CRASH_DIR);
        for at in 0..12_u64 {
            write_report(&root, &report_from_parts(Some("x"), None, None, at)).unwrap();
        }
        assert_eq!(
            report_files(&root, ".json").unwrap().len(),
            RETAINED_REPORTS
        );
        fs::write(root.join("crash-99999999999999999999-1.json"), b"{not json").unwrap();
        let taken = take_pending(&root).unwrap();
        assert_eq!(taken.len(), RETAINED_REPORTS);
        assert_eq!(taken.first().map(|report| report.occurred_at_ms), Some(2));
        assert!(
            take_pending(&root).unwrap().is_empty(),
            "reports are surfaced once"
        );
        assert!(take_pending(&dir.path().join("missing"))
            .unwrap()
            .is_empty());
    }

    #[test]
    fn panic_hook_writes_a_redacted_report() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(CRASH_DIR);
        let previous = std::panic::take_hook();
        std::panic::set_hook(Box::new(|_| {}));
        install_panic_hook(root.clone());
        let result = std::thread::Builder::new()
            .name("crash-test".to_owned())
            .spawn(|| panic!("cannot read C:\\Users\\bob\\clip.mp4"))
            .unwrap()
            .join();
        let _ = std::panic::take_hook();
        std::panic::set_hook(previous);
        assert!(result.is_err());
        // Other tests may panic concurrently while the hook is installed.
        let reports: Vec<_> = take_pending(&root)
            .unwrap()
            .into_iter()
            .filter(|report| report.thread == "crash-test")
            .collect();
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].thread, "crash-test");
        assert_eq!(reports[0].message, "cannot read <path>");
        assert!(reports[0]
            .location
            .as_deref()
            .is_some_and(|l| l.starts_with("crash_report.rs:")));
    }
}
