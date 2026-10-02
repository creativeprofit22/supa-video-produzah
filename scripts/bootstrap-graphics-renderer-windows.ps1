[CmdletBinding()]
param(
    # Use an already downloaded copy of the pinned archive instead of fetching it.
    [string]$ArchivePath,
    # Print the environment as `KEY=VALUE` lines only (for scripts that source it).
    [switch]$EnvOnly
)

# Build prerequisites of the graphics renderer sidecar (apps/desktop/src-tauri/graphics-renderer).
# fframes links FFmpeg 9 libav as shared libraries on Windows and generates its bindings with
# libclang. This script fetches a pinned FFmpeg 9 shared build, verifies its SHA-256, extracts it
# to .cache/ffmpeg9-shared and prints the environment the cargo build and the renderer need.
# LLVM is a system install (winget install LLVM.LLVM); it is located, not installed, here.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# BtbN prunes old auto-builds; keep a copy of the archive and pass -ArchivePath when the URL is gone.
$PinnedArchiveUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-10-01-13-06/ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-shared-9.0.zip"
$PinnedArchiveFilename = "ffmpeg-n9.0.2-22-g46d8f462ee-win64-gpl-shared-9.0.zip"
[int64]$PinnedArchiveByteLength = 86333540
$PinnedArchiveSha256 = "64f7d1460ce986804386582eeec3bd95117a4e84f7567ad416dd33f434fe8286"

$RepositoryRoot = Split-Path -Parent $PSScriptRoot
$CacheRoot = Join-Path $RepositoryRoot ".cache/ffmpeg9-shared"
$DownloadPath = Join-Path $CacheRoot $PinnedArchiveFilename
$ExtractRoot = Join-Path $CacheRoot "extracted"
$StampPath = Join-Path $ExtractRoot "archive.sha256"

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-PinnedArchive {
    param([Parameter(Mandatory = $true)][string]$Path)
    $length = (Get-Item -LiteralPath $Path).Length
    if ($length -ne $PinnedArchiveByteLength) {
        throw "FFmpeg 9 archive has $length bytes, expected $PinnedArchiveByteLength ($Path)"
    }
    $hash = Get-Sha256 -Path $Path
    if ($hash -cne $PinnedArchiveSha256) {
        throw "FFmpeg 9 archive SHA-256 is $hash, expected $PinnedArchiveSha256 ($Path)"
    }
}

function Find-LibClangDirectory {
    $candidates = @()
    if (-not [string]::IsNullOrWhiteSpace($env:LIBCLANG_PATH)) { $candidates += $env:LIBCLANG_PATH }
    $clang = Get-Command clang.exe -ErrorAction SilentlyContinue
    if ($null -ne $clang) { $candidates += (Split-Path -Parent $clang.Source) }
    $candidates += @("E:\Tools\LLVM\bin", "C:\Program Files\LLVM\bin")
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath (Join-Path $candidate "libclang.dll") -PathType Leaf) {
            return (Resolve-Path -LiteralPath $candidate).Path
        }
    }
    return $null
}

New-Item -ItemType Directory -Force -Path $CacheRoot | Out-Null

$alreadyExtracted = (Test-Path -LiteralPath $StampPath -PathType Leaf) -and
    ((Get-Content -LiteralPath $StampPath -Raw).Trim() -ceq $PinnedArchiveSha256)

if (-not $alreadyExtracted) {
    if ([string]::IsNullOrWhiteSpace($ArchivePath)) {
        if (-not (Test-Path -LiteralPath $DownloadPath -PathType Leaf)) {
            $partial = "$DownloadPath.partial"
            Invoke-WebRequest -Uri $PinnedArchiveUrl -OutFile $partial -UseBasicParsing
            Assert-PinnedArchive -Path $partial
            Move-Item -LiteralPath $partial -Destination $DownloadPath -Force
        }
        $ArchivePath = $DownloadPath
    }
    Assert-PinnedArchive -Path $ArchivePath

    if (Test-Path -LiteralPath $ExtractRoot) {
        Remove-Item -LiteralPath $ExtractRoot -Recurse -Force
    }
    $staging = "$ExtractRoot.partial"
    if (Test-Path -LiteralPath $staging) {
        Remove-Item -LiteralPath $staging -Recurse -Force
    }
    Expand-Archive -LiteralPath $ArchivePath -DestinationPath $staging
    Move-Item -LiteralPath $staging -Destination $ExtractRoot
    Set-Content -LiteralPath $StampPath -Value $PinnedArchiveSha256 -NoNewline
}

$ffmpegDir = Get-ChildItem -LiteralPath $ExtractRoot -Directory |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "include/libavcodec/avcodec.h") } |
    Select-Object -First 1
if ($null -eq $ffmpegDir) {
    throw "Extracted FFmpeg 9 archive has no include/libavcodec/avcodec.h under $ExtractRoot"
}
$ffmpegBin = Join-Path $ffmpegDir.FullName "bin"

$libclang = Find-LibClangDirectory
if ($null -eq $libclang) {
    throw "libclang.dll not found. Install LLVM (winget install LLVM.LLVM) or set LIBCLANG_PATH."
}

$lines = @(
    "FFMPEG_DIR=$($ffmpegDir.FullName)",
    "LIBCLANG_PATH=$libclang",
    "FFMPEG9_BIN=$ffmpegBin"
)
if ($EnvOnly) {
    $lines | ForEach-Object { Write-Output $_ }
    return
}

Write-Output "FFmpeg 9 shared build verified (sha256 $PinnedArchiveSha256)."
Write-Output "Set these before building or running the graphics renderer:"
$lines | ForEach-Object { Write-Output "  $_" }
Write-Output "  and prepend FFMPEG9_BIN to PATH (the renderer loads the FFmpeg 9 DLLs at start-up)."
