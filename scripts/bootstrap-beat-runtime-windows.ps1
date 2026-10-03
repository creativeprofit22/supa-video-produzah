[CmdletBinding()]
param(
    # Folder to fill. Point the app at it under Audio > Music beat runtime.
    [Parameter(Mandatory = $true)]
    [string]$RuntimeFolder,

    # Where downloaded archives are kept between runs (about 1.7 GB for the GPU pack).
    # Defaults to <repo>/.cache/beat-runtime-downloads.
    [string]$DownloadCache,

    # Only fetch the models; the detector then runs on the CPU.
    [switch]$SkipGpuPack,

    # Only check an existing folder against the manifest; download nothing.
    [switch]$VerifyOnly
)

# Builds the music beat runtime folder used by the supa-beat-detect sidecar:
#   <RuntimeFolder>\models\mel_spectrogram.onnx, beat_this.onnx   (required)
#   <RuntimeFolder>\cuda\*.dll                                     (optional GPU pack)
# Every file and archive is pinned by SHA-256 and size in
# apps/desktop/src-tauri/src/video/beat-detect-runtime-manifest.json; nothing unverified is
# left in the folder. The GPU pack is ONNX Runtime 1.28.0 (CUDA 12 build) plus the CUDA 12.8
# runtime, cuBLAS and cuDNN 9 libraries, extracted from NVIDIA's redistributable archives.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ManifestPath = Join-Path $PSScriptRoot "..\apps\desktop\src-tauri\src\video\beat-detect-runtime-manifest.json"
$Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
if ($Manifest.schemaVersion -ne 2) {
    throw "unsupported manifest schema $($Manifest.schemaVersion) in $ManifestPath"
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-PinnedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][int64]$ByteLength,
        [Parameter(Mandatory = $true)][string]$Sha256
    )
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -ne $ByteLength) { return $false }
    return (Get-Sha256 -Path $Path) -ceq $Sha256
}

function Assert-PlainName {
    param([Parameter(Mandatory = $true)][string]$Name)
    if ($Name -notmatch '^[A-Za-z0-9._-]+$' -or $Name -match '^\.+$') {
        throw "manifest file name is not a plain file name: $Name"
    }
}

# Downloads $Url to $Target through a .partial file, accepting it only when it matches the pin.
function Save-PinnedDownload {
    param(
        [Parameter(Mandatory = $true)][string]$Url,
        [Parameter(Mandatory = $true)][string]$Target,
        [Parameter(Mandatory = $true)][int64]$ByteLength,
        [Parameter(Mandatory = $true)][string]$Sha256
    )
    if (Test-PinnedFile -Path $Target -ByteLength $ByteLength -Sha256 $Sha256) { return }
    $partial = "$Target.partial"
    Write-Output "downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $partial -UseBasicParsing
    if (-not (Test-PinnedFile -Path $partial -ByteLength $ByteLength -Sha256 $Sha256)) {
        Remove-Item -LiteralPath $partial -Force
        throw "download does not match the pinned SHA-256 $Sha256 and size ${ByteLength}: $Url"
    }
    Move-Item -LiteralPath $partial -Destination $Target -Force
}

function Test-Models {
    param([Parameter(Mandatory = $true)][string]$Folder)
    $ok = $true
    foreach ($model in $Manifest.models.files) {
        $path = Join-Path (Join-Path $Folder $Manifest.models.folder) $model.file
        if (-not (Test-PinnedFile -Path $path -ByteLength $model.byteLength -Sha256 $model.sha256)) {
            Write-Warning "model missing or does not match the manifest: $path"
            $ok = $false
        }
    }
    return $ok
}

function Test-GpuPack {
    param([Parameter(Mandatory = $true)][string]$Folder)
    $ok = $true
    foreach ($file in $Manifest.gpuPack.files) {
        $path = Join-Path (Join-Path $Folder $Manifest.gpuPack.folder) $file.file
        if (-not (Test-PinnedFile -Path $path -ByteLength $file.byteLength -Sha256 $file.sha256)) {
            Write-Warning "GPU pack file missing or does not match the manifest: $path"
            $ok = $false
        }
    }
    return $ok
}

$RuntimeFolder = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($RuntimeFolder)
if ([string]::IsNullOrWhiteSpace($DownloadCache)) {
    $DownloadCache = Join-Path (Split-Path -Parent $PSScriptRoot) ".cache/beat-runtime-downloads"
}
$DownloadCache = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($DownloadCache)
foreach ($model in $Manifest.models.files) { Assert-PlainName -Name $model.file }
foreach ($file in $Manifest.gpuPack.files) { Assert-PlainName -Name $file.file }

if (-not $VerifyOnly) {
    $modelsFolder = Join-Path $RuntimeFolder $Manifest.models.folder
    New-Item -ItemType Directory -Force -Path $modelsFolder | Out-Null
    foreach ($model in $Manifest.models.files) {
        Save-PinnedDownload -Url $model.url -Target (Join-Path $modelsFolder $model.file) `
            -ByteLength $model.byteLength -Sha256 $model.sha256
    }

    if (-not $SkipGpuPack) {
        Add-Type -AssemblyName System.IO.Compression.FileSystem
        New-Item -ItemType Directory -Force -Path $DownloadCache | Out-Null
        $packFolder = Join-Path $RuntimeFolder $Manifest.gpuPack.folder
        New-Item -ItemType Directory -Force -Path $packFolder | Out-Null
        foreach ($archive in $Manifest.gpuPack.archives) {
            $files = @($Manifest.gpuPack.files | Where-Object { $_.archive -eq $archive.id })
            $pending = @($files | Where-Object {
                    -not (Test-PinnedFile -Path (Join-Path $packFolder $_.file) -ByteLength $_.byteLength -Sha256 $_.sha256)
                })
            if ($pending.Count -eq 0) { continue }
            $archivePath = Join-Path $DownloadCache ([System.IO.Path]::GetFileName(([uri]$archive.url).AbsolutePath))
            Save-PinnedDownload -Url $archive.url -Target $archivePath -ByteLength $archive.byteLength -Sha256 $archive.sha256
            $zip = [System.IO.Compression.ZipFile]::OpenRead($archivePath)
            try {
                foreach ($file in $pending) {
                    $entry = $zip.GetEntry($file.archivePath)
                    if ($null -eq $entry) { throw "$($file.archivePath) not found in $archivePath" }
                    $target = Join-Path $packFolder $file.file
                    $partial = "$target.partial"
                    [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $partial, $true)
                    if (-not (Test-PinnedFile -Path $partial -ByteLength $file.byteLength -Sha256 $file.sha256)) {
                        Remove-Item -LiteralPath $partial -Force
                        throw "extracted $($file.file) does not match the pinned SHA-256 $($file.sha256)"
                    }
                    Move-Item -LiteralPath $partial -Destination $target -Force
                }
            }
            finally {
                $zip.Dispose()
            }
        }
    }
}

if (-not (Test-Models -Folder $RuntimeFolder)) {
    throw "music beat runtime is incomplete: $RuntimeFolder"
}
$gpu = if ($SkipGpuPack -and -not (Test-Path -LiteralPath (Join-Path $RuntimeFolder $Manifest.gpuPack.folder))) {
    "no GPU pack (CPU only)"
}
elseif (Test-GpuPack -Folder $RuntimeFolder) { "GPU pack verified" }
else { "no valid GPU pack (CPU only)" }
Write-Output "music beat runtime ready: $RuntimeFolder ($($Manifest.detector.version), $gpu)"
