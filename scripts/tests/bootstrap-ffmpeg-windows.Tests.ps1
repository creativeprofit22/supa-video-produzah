[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$BootstrapScript = Join-Path $RepositoryRoot "scripts/bootstrap-ffmpeg-windows.ps1"
$ValidatorParityCorpusPath = Join-Path $RepositoryRoot "apps/desktop/src-tauri/media-toolchain/validator-parity.v1.json"
. $BootstrapScript -LoadFunctionsOnly

$script:Assertions = 0
function Assert-True {
    param([bool]$Condition, [string]$Message)
    $script:Assertions++
    if (-not $Condition) { throw "Assertion failed: $Message" }
}

function Assert-Throws {
    param([scriptblock]$Action, [string]$Message)
    $script:Assertions++
    try {
        & $Action
    }
    catch {
        return
    }
    throw "Assertion failed (expected failure): $Message"
}

function Set-ManifestMutations {
    param($Manifest, [object[]]$Mutations)
    foreach ($mutation in $Mutations) {
        $path = [string]$mutation.path
        $segments = @($path -split "/" | Where-Object { -not [string]::IsNullOrEmpty($_) })
        if (-not $path.StartsWith("/", [System.StringComparison]::Ordinal) -or $segments.Count -eq 0) {
            throw "Invalid validator parity mutation path: $path"
        }
        $cursor = $Manifest
        for ($index = 0; $index -lt ($segments.Count - 1); $index++) {
            $property = $cursor.PSObject.Properties[$segments[$index]]
            if ($null -eq $property) {
                throw "Validator parity mutation path does not exist: $path"
            }
            $cursor = $property.Value
        }
        $leaf = $cursor.PSObject.Properties[$segments[-1]]
        if ($null -eq $leaf) {
            throw "Validator parity mutation path does not exist: $path"
        }
        $leaf.Value = $mutation.value
    }
}

function Assert-ManifestAcceptance {
    param(
        [string]$SourcePath,
        [string]$Workspace,
        $Case
    )
    $candidate = Get-Content -LiteralPath $SourcePath -Raw | ConvertFrom-Json
    Set-ManifestMutations $candidate @($Case.mutations)
    $candidatePath = Join-Path $Workspace "manifest-matrix-$($Case.name).json"
    $candidate | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $candidatePath -Encoding UTF8
    $accepted = $true
    try {
        Read-StrictManifest $candidatePath | Out-Null
    }
    catch {
        $accepted = $false
    }
    Assert-True ($accepted -eq [bool]$Case.expected) "manifest matrix case '$($Case.name)' expected acceptance=$($Case.expected)"
}

function New-ZipFixture {
    param([string]$Path, [object[]]$Entries)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $archive = [System.IO.Compression.ZipFile]::Open($Path, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($fixtureEntry in $Entries) {
            $entry = $archive.CreateEntry([string]$fixtureEntry.Name)
            if ($fixtureEntry.PSObject.Properties.Name -contains "ExternalAttributes") {
                $entry.ExternalAttributes = [int]$fixtureEntry.ExternalAttributes
            }
            $stream = $entry.Open()
            try {
                $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$fixtureEntry.Content)
                $stream.Write($bytes, 0, $bytes.Length)
            }
            finally {
                $stream.Dispose()
            }
        }
    }
    finally {
        $archive.Dispose()
    }
}

function New-TestTarget {
    param([string]$FfmpegPath, [string]$FfprobePath)
    return [pscustomobject]@{
        binaries = [pscustomobject]@{
            ffmpeg = [pscustomobject]@{
                byteLength = (Get-Item -LiteralPath $FfmpegPath).Length
                sha256 = Get-LowerSha256 $FfmpegPath
            }
            ffprobe = [pscustomobject]@{
                byteLength = (Get-Item -LiteralPath $FfprobePath).Length
                sha256 = Get-LowerSha256 $FfprobePath
            }
        }
    }
}

$workspace = Join-Path ([System.IO.Path]::GetTempPath()) ("supa-video-bootstrap-tests-{0}" -f [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($workspace) | Out-Null
try {
    $manifestPath = Join-Path $RepositoryRoot "apps/desktop/src-tauri/media-toolchain/manifest.v1.json"
    $manifest = Read-StrictManifest $manifestPath
    Assert-True ($manifest.toolchainId -ceq "ffmpeg-8.1.2-gyan-essentials-windows-x86_64") "tracked manifest identity"

    $missingRubberbandPath = Join-Path $workspace "manifest-missing-rubberband.json"
    $missingRubberband = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $missingRubberband.targets.'x86_64-pc-windows-msvc'.requiredCapabilities.filters = @(
        $missingRubberband.targets.'x86_64-pc-windows-msvc'.requiredCapabilities.filters |
            Where-Object { $_ -cne "rubberband" }
    )
    $missingRubberband | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $missingRubberbandPath -Encoding UTF8
    Assert-Throws { Read-StrictManifest $missingRubberbandPath | Out-Null } "rubberband is required, not optional"

    $unknownManifestPath = Join-Path $workspace "manifest-unknown.json"
    $unknownManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $unknownManifest | Add-Member -NotePropertyName unexpected -NotePropertyValue $true
    $unknownManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $unknownManifestPath -Encoding UTF8
    Assert-Throws { Read-StrictManifest $unknownManifestPath | Out-Null } "unknown manifest property"

    $invalidHashManifestPath = Join-Path $workspace "manifest-hash.json"
    $invalidHashManifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    $invalidHashManifest.archive.sha256 = "A" * 64
    $invalidHashManifest | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $invalidHashManifestPath -Encoding UTF8
    Assert-Throws { Read-StrictManifest $invalidHashManifestPath | Out-Null } "uppercase archive hash"

    $parityCorpus = Get-Content -LiteralPath $ValidatorParityCorpusPath -Raw | ConvertFrom-Json
    Assert-True ($parityCorpus.schemaVersion -eq 1) "validator parity corpus schema"
    $caseNames = @($parityCorpus.cases | ForEach-Object { [string]$_.name })
    Assert-True (($caseNames | Select-Object -Unique).Count -eq $caseNames.Count) "validator parity case names are unique"
    foreach ($case in @($parityCorpus.cases)) {
        Assert-ManifestAcceptance $manifestPath $workspace $case
    }

    $tinyArchive = Join-Path $workspace "tiny.zip"
    [System.IO.File]::WriteAllBytes($tinyArchive, [byte[]](1, 2, 3))
    Assert-Throws { Assert-ArchiveIdentity $tinyArchive $manifest.archive } "archive byte-length mismatch"

    $referenceFfmpeg = Join-Path $workspace "reference-ffmpeg.exe"
    $referenceFfprobe = Join-Path $workspace "reference-ffprobe.exe"
    [System.IO.File]::WriteAllBytes($referenceFfmpeg, [System.Text.Encoding]::UTF8.GetBytes("ffmpeg-fixture"))
    [System.IO.File]::WriteAllBytes($referenceFfprobe, [System.Text.Encoding]::UTF8.GetBytes("ffprobe-fixture"))
    $target = New-TestTarget $referenceFfmpeg $referenceFfprobe

    $validZip = Join-Path $workspace "valid.zip"
    New-ZipFixture $validZip @(
        [pscustomobject]@{ Name = "root/bin/ffmpeg.exe"; Content = "ffmpeg-fixture" },
        [pscustomobject]@{ Name = "root/bin/ffprobe.exe"; Content = "ffprobe-fixture" }
    )
    $validOutput = Join-Path $workspace "valid-output"
    [System.IO.Directory]::CreateDirectory($validOutput) | Out-Null
    Expand-VerifiedExecutables $validZip $validOutput $target
    Assert-True (Test-ExactBinary (Join-Path $validOutput "ffmpeg.exe") $target.binaries.ffmpeg) "valid FFmpeg extraction"
    Assert-True (Test-ExactBinary (Join-Path $validOutput "ffprobe.exe") $target.binaries.ffprobe) "valid FFprobe extraction"

    $duplicateZip = Join-Path $workspace "duplicate.zip"
    New-ZipFixture $duplicateZip @(
        [pscustomobject]@{ Name = "root/bin/ffmpeg.exe"; Content = "ffmpeg-fixture" },
        [pscustomobject]@{ Name = "other/bin/FFMPEG.EXE"; Content = "ffmpeg-fixture" },
        [pscustomobject]@{ Name = "root/bin/ffprobe.exe"; Content = "ffprobe-fixture" }
    )
    $duplicateOutput = Join-Path $workspace "duplicate-output"
    [System.IO.Directory]::CreateDirectory($duplicateOutput) | Out-Null
    Assert-Throws { Expand-VerifiedExecutables $duplicateZip $duplicateOutput $target } "duplicate executable"

    $missingZip = Join-Path $workspace "missing.zip"
    New-ZipFixture $missingZip @(
        [pscustomobject]@{ Name = "root/bin/ffmpeg.exe"; Content = "ffmpeg-fixture" }
    )
    $missingOutput = Join-Path $workspace "missing-output"
    [System.IO.Directory]::CreateDirectory($missingOutput) | Out-Null
    Assert-Throws { Expand-VerifiedExecutables $missingZip $missingOutput $target } "missing executable"

    $unsafeZip = Join-Path $workspace "unsafe.zip"
    New-ZipFixture $unsafeZip @(
        [pscustomobject]@{ Name = "../outside.txt"; Content = "escape" },
        [pscustomobject]@{ Name = "root/bin/ffmpeg.exe"; Content = "ffmpeg-fixture" },
        [pscustomobject]@{ Name = "root/bin/ffprobe.exe"; Content = "ffprobe-fixture" }
    )
    $unsafeOutput = Join-Path $workspace "unsafe-output"
    [System.IO.Directory]::CreateDirectory($unsafeOutput) | Out-Null
    Assert-Throws { Expand-VerifiedExecutables $unsafeZip $unsafeOutput $target } "archive traversal"
    Assert-True (-not [System.IO.File]::Exists((Join-Path $workspace "outside.txt"))) "no traversal write"

    $linkedZip = Join-Path $workspace "linked.zip"
    New-ZipFixture $linkedZip @(
        [pscustomobject]@{ Name = "root/link"; Content = "target"; ExternalAttributes = ([int](0xA000 -shl 16)) },
        [pscustomobject]@{ Name = "root/bin/ffmpeg.exe"; Content = "ffmpeg-fixture" },
        [pscustomobject]@{ Name = "root/bin/ffprobe.exe"; Content = "ffprobe-fixture" }
    )
    $linkedOutput = Join-Path $workspace "linked-output"
    [System.IO.Directory]::CreateDirectory($linkedOutput) | Out-Null
    Assert-Throws { Expand-VerifiedExecutables $linkedZip $linkedOutput $target } "archive symlink metadata"

    $corruptZip = Join-Path $workspace "corrupt.zip"
    [System.IO.File]::WriteAllText($corruptZip, "not a zip")
    $corruptOutput = Join-Path $workspace "corrupt-output"
    [System.IO.Directory]::CreateDirectory($corruptOutput) | Out-Null
    Assert-Throws { Expand-VerifiedExecutables $corruptZip $corruptOutput $target } "corrupt ZIP"

    Assert-SafeStagingDirectory (Join-Path $RepositoryRoot "apps/desktop/src-tauri/media-toolchain/bin/x86_64-pc-windows-msvc") (Join-Path $RepositoryRoot "apps/desktop/src-tauri/media-toolchain")
    Assert-Throws { Assert-SafeStagingDirectory (Join-Path $RepositoryRoot "outside-staging") (Join-Path $RepositoryRoot "apps/desktop/src-tauri/media-toolchain") } "staging containment"

    Write-Host "Bootstrap adversarial tests passed ($script:Assertions assertions)"
}
finally {
    if ([System.IO.Directory]::Exists($workspace)) {
        [System.IO.Directory]::Delete($workspace, $true)
    }
}
