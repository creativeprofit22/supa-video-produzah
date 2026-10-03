# Builds the music beat detection sidecar (apps/desktop/src-tauri/beat-detector) in release mode.
# The executable is what tauri.media-tools.windows.conf.json bundles as `beat-detector/`
# (docs/adr/0004-music-beat-detection-sidecar.md). ONNX Runtime, CUDA and the models are not part
# of the build: they live in the user's music beat runtime folder
# (scripts/bootstrap-beat-runtime-windows.ps1).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Manifest = Join-Path $RepositoryRoot "apps/desktop/src-tauri/beat-detector/Cargo.toml"
& cargo build --release --locked --manifest-path $Manifest
if ($LASTEXITCODE -ne 0) { throw "beat detector build failed ($LASTEXITCODE)" }

$Overlay = Get-Content -LiteralPath (Join-Path $RepositoryRoot "apps/desktop/src-tauri/tauri.media-tools.windows.conf.json") -Raw |
    ConvertFrom-Json
$TauriRoot = Join-Path $RepositoryRoot "apps/desktop/src-tauri"
$found = 0
foreach ($resource in $Overlay.bundle.resources.PSObject.Properties) {
    if (-not $resource.Value.StartsWith("beat-detector/")) { continue }
    $source = Join-Path $TauriRoot $resource.Name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "beat detector resource missing after build: $source"
    }
    $found += 1
}
if ($found -eq 0) { throw "tauri.media-tools.windows.conf.json bundles no beat-detector/ resource" }
Write-Output "Beat detector built; bundle resources present."
