[CmdletBinding()]
param(
    # Folder to create. Point the app at it under Audio > Music beat runtime.
    [Parameter(Mandatory = $true)]
    [string]$RuntimeFolder,

    # Optional existing copy of final0.ckpt; otherwise it is downloaded.
    [string]$CheckpointPath,

    # PyTorch wheel index; the CUDA 12.8 index works on recent NVIDIA drivers.
    [string]$TorchIndexUrl = "https://download.pytorch.org/whl/cu128",

    [string]$PythonVersion = "3.12",

    # Only check an existing folder against the manifest.
    [switch]$VerifyOnly
)

# Builds the managed music-beat runtime folder used by supa-video:
#   <RuntimeFolder>\.venv\Scripts\python.exe   (beat-this + torch)
#   <RuntimeFolder>\final0.ckpt                (pinned SHA-256)
# Downloads PyTorch (~2.5 GB) and the 81 MB checkpoint. Requires `uv`.

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$ManifestPath = Join-Path $PSScriptRoot "..\apps\desktop\src-tauri\src\video\music-beat-runtime-manifest.json"
$Manifest = Get-Content -Raw -LiteralPath $ManifestPath | ConvertFrom-Json
$PinnedVersion = $Manifest.detector.version
$PinnedSha256 = $Manifest.checkpoint.sha256
$PinnedLength = [int64]$Manifest.checkpoint.byteLength
$CheckpointFile = $Manifest.checkpoint.file
$PythonRelative = $Manifest.python.windows -replace "/", "\"

function Test-Checkpoint([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -ne $PinnedLength) { return $false }
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant()
    return $hash -eq $PinnedSha256
}

function Test-Runtime([string]$Folder) {
    $python = Join-Path $Folder $PythonRelative
    $checkpoint = Join-Path $Folder $CheckpointFile
    if (-not (Test-Path -LiteralPath $python -PathType Leaf)) {
        Write-Error "python missing: $python"
    }
    if (-not (Test-Checkpoint $checkpoint)) {
        Write-Error "checkpoint missing or does not match the pinned SHA-256: $checkpoint"
    }
    $probe = "import importlib.metadata as m, json, sys; json.dump({'version': m.version('beat-this')}, sys.stdout)"
    $version = (& $python -I -c $probe | ConvertFrom-Json).version
    if ($version -ne $PinnedVersion) {
        Write-Error "beat-this $version installed, manifest pins $PinnedVersion"
    }
    Write-Output "music beat runtime ready: $Folder (beat-this $version)"
}

$RuntimeFolder = [System.IO.Path]::GetFullPath($RuntimeFolder)
if ($VerifyOnly) {
    Test-Runtime $RuntimeFolder
    return
}

if (-not (Get-Command uv -ErrorAction SilentlyContinue)) {
    Write-Error "uv is required: https://docs.astral.sh/uv/"
}
New-Item -ItemType Directory -Force -Path $RuntimeFolder | Out-Null

Push-Location $RuntimeFolder
try {
    if (-not (Test-Path -LiteralPath ".venv")) {
        uv venv --python $PythonVersion .venv
        if ($LASTEXITCODE -ne 0) { Write-Error "uv venv failed" }
    }
    $python = Join-Path $RuntimeFolder $PythonRelative
    uv pip install --python $python torch torchaudio --index-url $TorchIndexUrl
    if ($LASTEXITCODE -ne 0) { Write-Error "torch install failed" }
    uv pip install --python $python "beat-this==$PinnedVersion" soundfile
    if ($LASTEXITCODE -ne 0) { Write-Error "beat-this install failed" }
}
finally {
    Pop-Location
}

$target = Join-Path $RuntimeFolder $CheckpointFile
if (-not (Test-Checkpoint $target)) {
    if ($CheckpointPath) {
        Copy-Item -LiteralPath $CheckpointPath -Destination $target -Force
    }
    else {
        $partial = "$target.partial"
        Invoke-WebRequest -Uri $Manifest.checkpoint.url -OutFile $partial
        Move-Item -LiteralPath $partial -Destination $target -Force
    }
    if (-not (Test-Checkpoint $target)) {
        Remove-Item -LiteralPath $target -Force
        Write-Error "downloaded checkpoint does not match the pinned SHA-256 $PinnedSha256"
    }
}

Test-Runtime $RuntimeFolder
