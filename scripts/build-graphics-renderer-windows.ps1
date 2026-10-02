[CmdletBinding()]
param(
    # Use an already downloaded copy of the pinned FFmpeg 9 archive instead of fetching it.
    [string]$ArchivePath
)

# Builds the graphics renderer sidecar (apps/desktop/src-tauri/graphics-renderer) in release mode.
# The build copies the FFmpeg 9 DLLs next to supa-graphics-render.exe, and that folder is what
# tauri.media-tools.windows.conf.json bundles as `graphics-renderer/` (docs/adr/0003-graphics-clips.md).

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$Bootstrap = Join-Path $PSScriptRoot "bootstrap-graphics-renderer-windows.ps1"
$bootstrapArguments = @{ EnvOnly = $true }
if (-not [string]::IsNullOrWhiteSpace($ArchivePath)) { $bootstrapArguments.ArchivePath = $ArchivePath }

foreach ($line in & $Bootstrap @bootstrapArguments) {
    $name, $value = $line -split "=", 2
    if ([string]::IsNullOrWhiteSpace($name) -or $null -eq $value) { continue }
    Set-Item -Path "Env:$name" -Value $value
}
if ([string]::IsNullOrWhiteSpace($env:FFMPEG9_BIN)) { throw "bootstrap did not report FFMPEG9_BIN" }
$env:PATH = "$env:FFMPEG9_BIN;$env:LIBCLANG_PATH;$env:PATH"

$Manifest = Join-Path $RepositoryRoot "apps/desktop/src-tauri/graphics-renderer/Cargo.toml"
& cargo build --release --locked --manifest-path $Manifest
if ($LASTEXITCODE -ne 0) { throw "graphics renderer build failed ($LASTEXITCODE)" }

$Overlay = Get-Content -LiteralPath (Join-Path $RepositoryRoot "apps/desktop/src-tauri/tauri.media-tools.windows.conf.json") -Raw |
    ConvertFrom-Json
$TauriRoot = Join-Path $RepositoryRoot "apps/desktop/src-tauri"
foreach ($resource in $Overlay.bundle.resources.PSObject.Properties) {
    if (-not $resource.Value.StartsWith("graphics-renderer/")) { continue }
    $source = Join-Path $TauriRoot $resource.Name
    if (-not (Test-Path -LiteralPath $source -PathType Leaf)) {
        throw "graphics renderer resource missing after build: $source"
    }
}
Write-Output "Graphics renderer built; bundle resources present."
