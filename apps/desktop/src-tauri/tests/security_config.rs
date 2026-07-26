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
            "scope": ["$APPCACHE/video-phase1/**/*"]
        })
    );
    assert_eq!(
        security.asset_protocol.scope.allowed_paths(),
        &[PathBuf::from("$APPCACHE/video-phase1/**/*")]
    );
    assert!(security.asset_protocol.scope.forbidden_paths().is_none());
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
