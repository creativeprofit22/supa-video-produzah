use std::{collections::HashMap, path::PathBuf};

use serde_json::{json, Value};
use tauri::utils::config::{
    CapabilityEntry, Csp, CspDirectiveSources, DisabledCspModificationKind,
};

fn expected_csp(development: bool) -> HashMap<String, CspDirectiveSources> {
    let mut directives = HashMap::from([
        ("default-src", vec!["'self'"]),
        ("connect-src", vec!["ipc:", "http://ipc.localhost"]),
        ("font-src", vec!["'self'"]),
        (
            "img-src",
            vec!["'self'", "asset:", "http://asset.localhost"],
        ),
        (
            "media-src",
            vec!["'self'", "asset:", "http://asset.localhost"],
        ),
        ("object-src", vec!["'none'"]),
        ("script-src", vec!["'self'"]),
        ("style-src", vec!["'self'"]),
        ("base-uri", vec!["'none'"]),
        ("form-action", vec!["'none'"]),
    ]);

    if development {
        directives
            .get_mut("connect-src")
            .expect("connect-src must be present")
            .push("ws:");
        directives
            .get_mut("style-src")
            .expect("style-src must be present")
            .push("'unsafe-inline'");
    }

    directives
        .into_iter()
        .map(|(directive, sources)| {
            (
                directive.to_owned(),
                CspDirectiveSources::List(sources.into_iter().map(str::to_owned).collect()),
            )
        })
        .collect()
}

fn assert_exact_csp(actual: &Option<Csp>, expected: HashMap<String, CspDirectiveSources>) {
    match actual {
        Some(Csp::DirectiveMap(actual)) => assert_eq!(actual, &expected),
        Some(Csp::Policy(_)) => panic!("CSP must use an exact directive map"),
        None => panic!("CSP must be configured"),
    }
}

#[test]
fn generated_context_enforces_exact_runtime_security_policy() {
    let context: tauri::Context<tauri::Wry> = tauri::generate_context!();
    let security = &context.config().app.security;
    let source_config: Value = serde_json::from_str(include_str!("../tauri.conf.json"))
        .expect("Tauri configuration must be valid JSON");

    assert_exact_csp(&security.csp, expected_csp(false));
    assert_exact_csp(&security.dev_csp, expected_csp(true));
    assert!(matches!(
        security.dangerous_disable_asset_csp_modification,
        DisabledCspModificationKind::Flag(false)
    ));
    assert_eq!(
        security.capabilities,
        vec![CapabilityEntry::Reference("default".to_owned())]
    );
    assert_eq!(
        source_config["app"]["security"]["assetProtocol"],
        json!({
            "enable": true,
            "scope": ["$APPCACHE/supa-video-media-v1/derived/**/*"]
        })
    );
    assert_eq!(
        security.asset_protocol.scope.allowed_paths(),
        &[PathBuf::from("$APPCACHE/supa-video-media-v1/derived/**/*")]
    );
    assert!(security.asset_protocol.scope.forbidden_paths().is_none());
    let allowed = security.asset_protocol.scope.allowed_paths()[0].to_string_lossy();
    assert!(!allowed.contains("objects"));
    assert!(!allowed.contains("locks"));
    assert!(!allowed.contains("video-phase1"));
}

#[test]
fn default_capability_is_local_main_window_close_guard_access_only() {
    let capability: Value = serde_json::from_str(include_str!("../capabilities/default.json"))
        .expect("default capability must be valid JSON");

    assert_eq!(capability["identifier"], "default");
    assert_eq!(capability["local"], true);
    assert_eq!(capability["windows"], json!(["main"]));
    assert_eq!(
        capability["permissions"],
        json!([
            "core:event:allow-listen",
            "core:event:allow-unlisten",
            "core:window:allow-destroy"
        ])
    );
    assert!(capability.get("remote").is_none());
    assert_eq!(
        capability
            .as_object()
            .expect("capability must be an object")
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>(),
        [
            "$schema",
            "description",
            "identifier",
            "local",
            "permissions",
            "windows",
        ]
        .into_iter()
        .collect()
    );
}

#[test]
fn windows_media_overlay_maps_only_pinned_resources_to_declared_destinations() {
    let overlay: Value =
        serde_json::from_str(include_str!("../tauri.media-tools.windows.conf.json"))
            .expect("media-tool overlay must be valid JSON");
    let resources = overlay["bundle"]["resources"]
        .as_object()
        .expect("media-tool resources must be an exact map");
    assert_eq!(resources.len(), 7);
    assert_eq!(
        resources,
        &serde_json::from_value(json!({
            "media-toolchain/bin/x86_64-pc-windows-msvc/ffmpeg.exe": "media-tools/ffmpeg.exe",
            "media-toolchain/bin/x86_64-pc-windows-msvc/ffprobe.exe": "media-tools/ffprobe.exe",
            "media-toolchain/manifest.v1.json": "media-tools/manifest.v1.json",
            "media-toolchain/THIRD_PARTY_NOTICES.md": "media-tools/THIRD_PARTY_NOTICES.md",
            "media-toolchain/SOURCE_OFFER.md": "media-tools/SOURCE_OFFER.md",
            "media-toolchain/licenses/GPL-3.0.txt": "media-tools/licenses/GPL-3.0.txt",
            "media-toolchain/licenses/GYAN-FFMPEG-README.txt": "media-tools/licenses/GYAN-FFMPEG-README.txt"
        }))
        .expect("expected resource map must deserialize")
    );
    assert!(overlay["bundle"].get("externalBin").is_none());
}

fn production_command(source: &str, command_name: &str) -> String {
    let marker = format!("pub async fn {command_name}");
    let start = source
        .find(&marker)
        .unwrap_or_else(|| panic!("production command {command_name} must exist"));
    let remaining = &source[start..];
    let end = remaining
        .find("\n}\n")
        .map(|offset| offset + 3)
        .expect("production command must have a bounded body");
    remaining[..end].to_owned()
}

#[test]
fn production_media_commands_use_managed_paths_and_expose_no_tool_path_parameter() {
    let probe = include_str!("../src/video/probe.rs");
    let derived = include_str!("../src/video/derived.rs");
    let render = include_str!("../src/video/render.rs");
    let project_ipc = include_str!("../src/video/project/ipc.rs");
    for (source, command_name) in [
        (probe, "video_ffmpeg_status"),
        (probe, "video_probe_media"),
        (derived, "video_prepare_asset"),
        (render, "video_start_render"),
        (project_ipc, "video_execute_project_group"),
        (project_ipc, "video_relink_project_asset"),
    ] {
        let command = production_command(source, command_name);
        assert!(
            command.contains("MediaToolchain") || command.contains("toolchain"),
            "{command_name} must consume managed media-tool state"
        );
        assert!(!command.contains("ffmpeg_program:"));
        assert!(!command.contains("ffprobe_program:"));
        assert!(!command.contains("OsString::from(\"ffmpeg\")"));
        assert!(!command.contains("OsString::from(\"ffprobe\")"));
        assert!(!command.contains("std::env"));
    }
}
