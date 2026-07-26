[CmdletBinding()]
param(
    [string]$ArchivePath,
    [string]$ManifestPath,
    [switch]$VerifyOnly,
    [switch]$LoadFunctionsOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$TargetTriple = "x86_64-pc-windows-msvc"
$PinnedToolchainId = "ffmpeg-8.1.2-gyan-essentials-windows-x86_64"
$PinnedSourceCommit = "38b88335f99e76ed89ff3c93f877fdefce736c13"
$PinnedSourceUrl = "https://github.com/FFmpeg/FFmpeg/commit/$PinnedSourceCommit"
$PinnedProviderUrl = "https://www.gyan.dev/ffmpeg/builds/"
$PinnedProviderBuildDate = "2026-06-27"
$PinnedArchiveUrl = "https://github.com/GyanD/codexffmpeg/releases/download/8.1.2/ffmpeg-8.1.2-essentials_build.zip"
$PinnedArchiveFilename = "ffmpeg-8.1.2-essentials_build.zip"
[int64]$PinnedArchiveByteLength = 109728040
$PinnedArchiveSha256 = "db580001caa24ac104c8cb856cd113a87b0a443f7bdf47d8c12b1d740584a2ec"
$MaxProbeOutputBytes = 1MB
$ProbeTimeoutMilliseconds = 15000
$RepositoryRoot = Split-Path -Parent $PSScriptRoot
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $RepositoryRoot "apps/desktop/src-tauri/media-toolchain/manifest.v1.json"
}

function Assert-ExactProperties {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Context
    )

    if ($null -eq $Value -or $Value -isnot [pscustomobject]) {
        throw "$Context must be an object"
    }
    $actual = @($Value.PSObject.Properties.Name | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($wanted -join "`n")) {
        throw "$Context has invalid properties (expected: $($wanted -join ', '); actual: $($actual -join ', '))"
    }
}

function Assert-ExactArray {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string]$Context,
        [switch]$AllowEmpty
    )

    if ($Value -is [string] -or $Value -isnot [System.Collections.IEnumerable]) {
        throw "$Context must be an array"
    }
    $items = @($Value)
    if (-not $AllowEmpty -and $items.Count -eq 0) {
        throw "$Context cannot be empty"
    }
    $seen = @{}
    foreach ($item in $items) {
        if ($item -isnot [string] -or [string]::IsNullOrWhiteSpace($item) -or $item -cnotmatch '^[A-Za-z0-9_.-]+$') {
            throw "$Context contains an invalid value"
        }
        if ($seen.ContainsKey($item)) {
            throw "$Context contains a duplicate value: $item"
        }
        $seen[$item] = $true
    }
    return $items
}

function Assert-ExactStringSet {
    param(
        [Parameter(Mandatory = $true)]$Value,
        [Parameter(Mandatory = $true)][string[]]$Expected,
        [Parameter(Mandatory = $true)][string]$Context
    )
    $items = Assert-ExactArray $Value $Context
    $actual = @($items | Sort-Object)
    $wanted = @($Expected | Sort-Object)
    if (($actual -join "`n") -cne ($wanted -join "`n")) {
        throw "$Context must equal the pinned set"
    }
    return $items
}

function Assert-Sha256 {
    param([string]$Value, [string]$Context)
    if ($Value -cnotmatch '^[0-9a-f]{64}$') {
        throw "$Context must be a lowercase SHA-256"
    }
}

function Assert-RelativeResourcePath {
    param([string]$Value, [string]$Expected, [string]$Context)
    if ($Value -cne $Expected -or $Value.Contains("\") -or $Value.StartsWith("/") -or $Value.Contains("..")) {
        throw "$Context must equal $Expected"
    }
}

function Test-IsoCalendarDate {
    param($Value)
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') {
        return $false
    }
    $parsed = [datetime]::MinValue
    return [datetime]::TryParseExact(
        $Value,
        "yyyy-MM-dd",
        [System.Globalization.CultureInfo]::InvariantCulture,
        [System.Globalization.DateTimeStyles]::None,
        [ref]$parsed
    )
}

function Test-HttpsEvidenceReference {
    param($Value)
    if ($Value -isnot [string] -or $Value.Length -lt 12 -or $Value.Length -gt 2048 -or
        -not $Value.StartsWith("https://", [System.StringComparison]::Ordinal)) {
        return $false
    }
    $remainder = $Value.Substring(8)
    $slashIndex = $remainder.IndexOf("/", [System.StringComparison]::Ordinal)
    if ($slashIndex -le 0) {
        return $false
    }
    $hostName = $remainder.Substring(0, $slashIndex)
    $evidencePath = $remainder.Substring($slashIndex + 1)
    $labels = @($hostName.Split("."))
    if ($hostName.Length -gt 253 -or $labels.Count -lt 2 -or [string]::IsNullOrEmpty($evidencePath) -or
        $evidencePath -cnotmatch '^[\x21-\x7E]+$' -or $evidencePath.Contains("\") -or $evidencePath.Contains("#")) {
        return $false
    }
    foreach ($label in $labels) {
        if ($label -cnotmatch '^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$') {
            return $false
        }
    }
    return $labels[-1] -cmatch '^[A-Za-z]{2,63}$'
}

function Read-StrictManifest {
    param([string]$Path)

    $resolvedPath = [System.IO.Path]::GetFullPath($Path)
    if (-not [System.IO.File]::Exists($resolvedPath)) {
        throw "Media-tool manifest was not found"
    }
    $raw = [System.IO.File]::ReadAllText($resolvedPath, [System.Text.Encoding]::UTF8)
    if ([System.Text.Encoding]::UTF8.GetByteCount($raw) -gt 128KB) {
        throw "Media-tool manifest is too large"
    }
    try {
        $manifest = $raw | ConvertFrom-Json
    }
    catch {
        throw "Media-tool manifest is not valid JSON"
    }

    Assert-ExactProperties $manifest @("schemaVersion", "toolchainId", "ffmpeg", "archive", "targets", "compliance", "distributionReview") "manifest"
    if ($manifest.schemaVersion -isnot [long] -and $manifest.schemaVersion -isnot [int]) {
        throw "manifest.schemaVersion must be an integer"
    }
    if ([int64]$manifest.schemaVersion -ne 1) {
        throw "Unsupported media-tool manifest schema"
    }
    if ($manifest.toolchainId -isnot [string] -or $manifest.toolchainId -cne $PinnedToolchainId) {
        throw "manifest.toolchainId must equal the pinned toolchain identity"
    }

    Assert-ExactProperties $manifest.ffmpeg @("version", "shortVersion", "releaseTag", "sourceCommit", "sourceUrl", "provider", "providerUrl", "providerBuildDate", "variant", "declaredLicenseClass", "architecture", "requiredBuildFlags") "manifest.ffmpeg"
    if ($manifest.ffmpeg.version -cne "8.1.2-essentials_build-www.gyan.dev" -or
        $manifest.ffmpeg.shortVersion -cne "8.1.2" -or
        $manifest.ffmpeg.releaseTag -cne "n8.1.2" -or
        $manifest.ffmpeg.sourceCommit -cne $PinnedSourceCommit -or
        $manifest.ffmpeg.sourceUrl -cne $PinnedSourceUrl -or
        $manifest.ffmpeg.sourceUrl -cne "https://github.com/FFmpeg/FFmpeg/commit/$($manifest.ffmpeg.sourceCommit)" -or
        $manifest.ffmpeg.provider -cne "Gyan Doshi (gyan.dev)" -or
        $manifest.ffmpeg.providerUrl -cne $PinnedProviderUrl -or
        $manifest.ffmpeg.providerBuildDate -cne $PinnedProviderBuildDate -or
        $manifest.ffmpeg.variant -cne "release essentials" -or
        $manifest.ffmpeg.declaredLicenseClass -cne "GPL-3.0-or-later" -or
        $manifest.ffmpeg.architecture -cne "x86_64") {
        throw "manifest.ffmpeg identity is invalid"
    }
    $requiredBuildFlags = Assert-ExactStringSet `
        $manifest.ffmpeg.requiredBuildFlags `
        @("--enable-gpl", "--enable-version3", "--enable-static", "--enable-libx264", "--enable-libx265", "--enable-libzimg") `
        "manifest.ffmpeg.requiredBuildFlags"

    Assert-ExactProperties $manifest.archive @("url", "filename", "byteLength", "sha256") "manifest.archive"
    if ($manifest.archive.url -isnot [string] -or $manifest.archive.url -cne $PinnedArchiveUrl -or
        $manifest.archive.filename -isnot [string] -or $manifest.archive.filename -cne $PinnedArchiveFilename -or
        (($manifest.archive.byteLength -isnot [long]) -and ($manifest.archive.byteLength -isnot [int])) -or
        [int64]$manifest.archive.byteLength -ne $PinnedArchiveByteLength -or
        $manifest.archive.sha256 -isnot [string] -or $manifest.archive.sha256 -cne $PinnedArchiveSha256) {
        throw "manifest.archive must equal the pinned archive identity"
    }

    Assert-ExactProperties $manifest.targets @($TargetTriple) "manifest.targets"
    $target = $manifest.targets.$TargetTriple
    Assert-ExactProperties $target @("architecture", "resourceRoot", "binaries", "requiredCapabilities") "manifest.targets.$TargetTriple"
    if ($target.architecture -cne "x86_64" -or $target.resourceRoot -cne "media-tools") {
        throw "Target architecture or resource root is invalid"
    }
    Assert-ExactProperties $target.binaries @("ffmpeg", "ffprobe") "target.binaries"
    foreach ($toolName in @("ffmpeg", "ffprobe")) {
        $binary = $target.binaries.$toolName
        Assert-ExactProperties $binary @("filename", "resourcePath", "byteLength", "sha256") "target.binaries.$toolName"
        $expectedFilename = "$toolName.exe"
        $expectedByteLength = if ($toolName -ceq "ffmpeg") { 101897728 } else { 101692928 }
        if ($binary.filename -cne $expectedFilename -or
            (($binary.byteLength -isnot [long]) -and ($binary.byteLength -isnot [int])) -or
            [int64]$binary.byteLength -ne $expectedByteLength) {
            throw "target.binaries.$toolName metadata is invalid"
        }
        Assert-RelativeResourcePath ([string]$binary.resourcePath) "media-tools/$expectedFilename" "target.binaries.$toolName.resourcePath"
        Assert-Sha256 ([string]$binary.sha256) "target.binaries.$toolName.sha256"
    }

    Assert-ExactProperties $target.requiredCapabilities @("encoders", "muxers", "filters") "target.requiredCapabilities"
    $null = Assert-ExactStringSet $target.requiredCapabilities.encoders @("libx264", "aac", "mjpeg") "target.requiredCapabilities.encoders"
    $null = Assert-ExactStringSet $target.requiredCapabilities.muxers @("mp4", "image2") "target.requiredCapabilities.muxers"
    $null = Assert-ExactStringSet $target.requiredCapabilities.filters @("scale", "fps", "pad", "tile", "setsar", "zscale", "tonemap") "target.requiredCapabilities.filters"

    Assert-ExactProperties $manifest.compliance @("thirdPartyNoticesPath", "licensePaths", "providerNoticePath", "sourceOfferPath") "manifest.compliance"
    Assert-RelativeResourcePath ([string]$manifest.compliance.thirdPartyNoticesPath) "media-tools/THIRD_PARTY_NOTICES.md" "manifest.compliance.thirdPartyNoticesPath"
    Assert-RelativeResourcePath ([string]$manifest.compliance.providerNoticePath) "media-tools/licenses/GYAN-FFMPEG-README.txt" "manifest.compliance.providerNoticePath"
    Assert-RelativeResourcePath ([string]$manifest.compliance.sourceOfferPath) "media-tools/SOURCE_OFFER.md" "manifest.compliance.sourceOfferPath"
    $licensePaths = @($manifest.compliance.licensePaths)
    if ($licensePaths.Count -ne 1 -or $licensePaths[0] -cne "media-tools/licenses/GPL-3.0.txt") {
        throw "manifest.compliance.licensePaths is invalid"
    }

    Assert-ExactProperties $manifest.distributionReview @("status", "reviewedBy", "reviewedAt", "reference") "manifest.distributionReview"
    if (@("pending", "approved", "rejected") -cnotcontains [string]$manifest.distributionReview.status) {
        throw "manifest.distributionReview.status is invalid"
    }
    if ($manifest.distributionReview.status -ceq "approved") {
        if ($manifest.distributionReview.reviewedBy -isnot [string] -or
            [string]::IsNullOrWhiteSpace($manifest.distributionReview.reviewedBy)) {
            throw "Approved distribution review requires reviewedBy"
        }
        if (-not (Test-IsoCalendarDate $manifest.distributionReview.reviewedAt)) {
            throw "Approved distribution review requires reviewedAt in YYYY-MM-DD format"
        }
        if (-not (Test-HttpsEvidenceReference $manifest.distributionReview.reference)) {
            throw "Approved distribution review requires reference as a durable HTTPS URL"
        }
    }
    elseif ($null -ne $manifest.distributionReview.reviewedBy -or
        $null -ne $manifest.distributionReview.reviewedAt -or
        $null -ne $manifest.distributionReview.reference) {
        throw "Pending or rejected distribution review cannot contain review metadata"
    }

    return $manifest
}

function Get-LowerSha256 {
    param([string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Test-ExactBinary {
    param([string]$Path, $Binary)
    if (-not [System.IO.File]::Exists($Path)) {
        return $false
    }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne [int64]$Binary.byteLength) {
        return $false
    }
    return (Get-LowerSha256 $Path) -ceq [string]$Binary.sha256
}

function Invoke-BoundedTool {
    param(
        [string]$Program,
        [string[]]$Arguments,
        [string]$Operation
    )

    $start = [System.Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $Program
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    $start.Arguments = ($Arguments | ForEach-Object {
        if ($_ -match '[\s"]') { '"' + ($_ -replace '"', '\"') + '"' } else { $_ }
    }) -join ' '
    $process = [System.Diagnostics.Process]::new()
    $process.StartInfo = $start
    try {
        if (-not $process.Start()) {
            throw "$Operation could not start"
        }
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($ProbeTimeoutMilliseconds)) {
            try { $process.Kill() } catch { }
            throw "$Operation timed out"
        }
        $stdout = $stdoutTask.GetAwaiter().GetResult()
        $stderr = $stderrTask.GetAwaiter().GetResult()
        $combined = $stdout + "`n" + $stderr
        if ([System.Text.Encoding]::UTF8.GetByteCount($combined) -gt $MaxProbeOutputBytes) {
            throw "$Operation output exceeded its bound"
        }
        if ($process.ExitCode -ne 0) {
            throw "$Operation failed with exit code $($process.ExitCode)"
        }
        return $combined
    }
    finally {
        $process.Dispose()
    }
}

function Assert-CapabilityList {
    param([string]$Output, [string[]]$Required, [string]$Kind)
    foreach ($capability in $Required) {
        if ($Output -notmatch "(?m)^\s*[A-Z\.]{1,8}\s+$([regex]::Escape($capability))\s") {
            throw "Bundled FFmpeg is missing required $Kind capability: $capability"
        }
    }
}

function Test-ToolchainCapabilities {
    param([string]$FfmpegPath, [string]$FfprobePath, $Manifest, $Target)

    $ffmpegVersion = Invoke-BoundedTool $FfmpegPath @("-hide_banner", "-version") "FFmpeg version probe"
    $ffprobeVersion = Invoke-BoundedTool $FfprobePath @("-hide_banner", "-version") "FFprobe version probe"
    $expectedVersion = [string]$Manifest.ffmpeg.version
    if (-not $ffmpegVersion.Contains("ffmpeg version $expectedVersion") -or -not $ffprobeVersion.Contains("ffprobe version $expectedVersion")) {
        throw "Bundled media-tool version does not match the manifest"
    }

    $buildConfiguration = Invoke-BoundedTool $FfmpegPath @("-hide_banner", "-buildconf") "FFmpeg build-configuration probe"
    foreach ($flag in @($Manifest.ffmpeg.requiredBuildFlags)) {
        if (-not $buildConfiguration.Contains([string]$flag)) {
            throw "Bundled FFmpeg is missing required build flag: $flag"
        }
    }

    $encoders = Invoke-BoundedTool $FfmpegPath @("-hide_banner", "-encoders") "FFmpeg encoder probe"
    $muxers = Invoke-BoundedTool $FfmpegPath @("-hide_banner", "-muxers") "FFmpeg muxer probe"
    $filters = Invoke-BoundedTool $FfmpegPath @("-hide_banner", "-filters") "FFmpeg filter probe"
    Assert-CapabilityList $encoders @($Target.requiredCapabilities.encoders) "encoder"
    Assert-CapabilityList $muxers @($Target.requiredCapabilities.muxers) "muxer"
    Assert-CapabilityList $filters @($Target.requiredCapabilities.filters) "filter"
}

function Get-VerifiedArchive {
    param($Manifest, [string]$SuppliedArchivePath)

    if (-not [string]::IsNullOrWhiteSpace($SuppliedArchivePath)) {
        $resolvedArchive = [System.IO.Path]::GetFullPath($SuppliedArchivePath)
        if (-not [System.IO.File]::Exists($resolvedArchive)) {
            throw "Supplied FFmpeg archive was not found"
        }
        return @{ Path = $resolvedArchive; Temporary = $false }
    }

    $temporaryArchive = Join-Path ([System.IO.Path]::GetTempPath()) ("supa-video-ffmpeg-{0}.zip" -f [guid]::NewGuid().ToString("N"))
    $handler = [System.Net.Http.HttpClientHandler]::new()
    $handler.AllowAutoRedirect = $true
    $handler.UseDefaultCredentials = $false
    $handler.PreAuthenticate = $false
    $client = [System.Net.Http.HttpClient]::new($handler)
    $client.Timeout = [TimeSpan]::FromMinutes(10)
    try {
        $response = $client.GetAsync([string]$Manifest.archive.url, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead).GetAwaiter().GetResult()
        $response.EnsureSuccessStatusCode()
        if ($null -ne $response.Content.Headers.ContentLength -and $response.Content.Headers.ContentLength -ne [int64]$Manifest.archive.byteLength) {
            throw "Downloaded FFmpeg archive length does not match the manifest"
        }
        $input = $response.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $output = [System.IO.File]::Open($temporaryArchive, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
        try {
            $buffer = New-Object byte[] 1MB
            [int64]$total = 0
            while (($read = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
                $total += $read
                if ($total -gt [int64]$Manifest.archive.byteLength) {
                    throw "Downloaded FFmpeg archive exceeded its declared size"
                }
                $output.Write($buffer, 0, $read)
            }
            $output.Flush($true)
        }
        finally {
            $output.Dispose()
            $input.Dispose()
            $response.Dispose()
        }
        return @{ Path = $temporaryArchive; Temporary = $true }
    }
    catch {
        if ([System.IO.File]::Exists($temporaryArchive)) {
            [System.IO.File]::Delete($temporaryArchive)
        }
        throw
    }
    finally {
        $client.Dispose()
        $handler.Dispose()
    }
}

function Assert-ArchiveIdentity {
    param([string]$Path, $Archive)
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $item.Length -ne [int64]$Archive.byteLength) {
        throw "FFmpeg archive length or file type does not match the manifest"
    }
    if ((Get-LowerSha256 $Path) -cne [string]$Archive.sha256) {
        throw "FFmpeg archive SHA-256 does not match the manifest"
    }
}

function Expand-VerifiedExecutables {
    param([string]$Archive, [string]$Destination, $Target)

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [System.IO.Compression.ZipFile]::OpenRead($Archive)
    try {
        $binaryEntries = @{ ffmpeg = @(); ffprobe = @() }
        foreach ($entry in $zip.Entries) {
            $normalized = $entry.FullName.Replace("\", "/")
            $segments = @($normalized.Split("/", [System.StringSplitOptions]::RemoveEmptyEntries))
            if ($normalized.StartsWith("/") -or $normalized -match '^[A-Za-z]:' -or $segments -contains "..") {
                throw "FFmpeg archive contains an unsafe path"
            }
            $unixType = (($entry.ExternalAttributes -shr 16) -band 0xF000)
            $windowsReparse = ($entry.ExternalAttributes -band 0x400) -ne 0
            if ($unixType -eq 0xA000 -or $windowsReparse) {
                throw "FFmpeg archive contains a link or reparse point"
            }
            foreach ($toolName in @("ffmpeg", "ffprobe")) {
                if ([System.IO.Path]::GetFileName($normalized) -ieq "$toolName.exe") {
                    $binaryEntries[$toolName] += $entry
                }
            }
        }

        foreach ($toolName in @("ffmpeg", "ffprobe")) {
            $matchingEntries = @($binaryEntries[$toolName])
            if ($matchingEntries.Count -ne 1) {
                throw "FFmpeg archive must contain exactly one $toolName.exe"
            }
            $entry = $matchingEntries[0]
            $normalized = $entry.FullName.Replace("\", "/")
            if ($normalized -cnotmatch '^[^/]+/bin/' + $toolName + '\.exe$') {
                throw "FFmpeg archive contains $toolName.exe at an unexpected path"
            }
            $destinationPath = Join-Path $Destination "$toolName.exe"
            $source = $entry.Open()
            $output = [System.IO.File]::Open($destinationPath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            try {
                $source.CopyTo($output)
                $output.Flush($true)
            }
            finally {
                $output.Dispose()
                $source.Dispose()
            }
            if (-not (Test-ExactBinary $destinationPath $Target.binaries.$toolName)) {
                throw "Extracted $toolName.exe does not match the manifest"
            }
        }
    }
    finally {
        $zip.Dispose()
    }
}

function Assert-SafeStagingDirectory {
    param([string]$Path, [string]$MediaToolchainRoot)
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $fullRoot = [System.IO.Path]::GetFullPath($MediaToolchainRoot).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
    if (-not $fullPath.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Staging path escaped the media-toolchain directory"
    }
    $cursor = $fullPath
    while ($cursor.StartsWith($fullRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
        if ([System.IO.Directory]::Exists($cursor)) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Staging path contains a reparse point"
            }
        }
        $parent = [System.IO.Path]::GetDirectoryName($cursor)
        if ([string]::IsNullOrEmpty($parent) -or $parent -eq $cursor) { break }
        $cursor = $parent
    }
}

if ($LoadFunctionsOnly) {
    return
}

$manifest = Read-StrictManifest $ManifestPath
$target = $manifest.targets.$TargetTriple
$mediaToolchainRoot = Join-Path $RepositoryRoot "apps/desktop/src-tauri/media-toolchain"
$stagingDirectory = Join-Path $mediaToolchainRoot "bin/$TargetTriple"
Assert-SafeStagingDirectory $stagingDirectory $mediaToolchainRoot
$ffmpegPath = Join-Path $stagingDirectory "ffmpeg.exe"
$ffprobePath = Join-Path $stagingDirectory "ffprobe.exe"

$alreadyStaged = (Test-ExactBinary $ffmpegPath $target.binaries.ffmpeg) -and (Test-ExactBinary $ffprobePath $target.binaries.ffprobe)
if ($alreadyStaged) {
    Test-ToolchainCapabilities $ffmpegPath $ffprobePath $manifest $target
    Write-Host "Verified bundled media tools: $($manifest.toolchainId)"
    exit 0
}
if ($VerifyOnly) {
    throw "Bundled media tools are missing or do not match the manifest; run media:bootstrap:windows"
}

$archiveRecord = Get-VerifiedArchive $manifest $ArchivePath
$temporaryExtract = Join-Path ([System.IO.Path]::GetTempPath()) ("supa-video-ffmpeg-extract-{0}" -f [guid]::NewGuid().ToString("N"))
[System.IO.Directory]::CreateDirectory($temporaryExtract) | Out-Null
try {
    Assert-ArchiveIdentity $archiveRecord.Path $manifest.archive
    Expand-VerifiedExecutables $archiveRecord.Path $temporaryExtract $target
    $temporaryFfmpeg = Join-Path $temporaryExtract "ffmpeg.exe"
    $temporaryFfprobe = Join-Path $temporaryExtract "ffprobe.exe"
    Test-ToolchainCapabilities $temporaryFfmpeg $temporaryFfprobe $manifest $target

    [System.IO.Directory]::CreateDirectory($stagingDirectory) | Out-Null
    Assert-SafeStagingDirectory $stagingDirectory $mediaToolchainRoot
    $promotions = @{}
    foreach ($toolName in @("ffmpeg", "ffprobe")) {
        $source = Join-Path $temporaryExtract "$toolName.exe"
        $promotion = Join-Path $stagingDirectory (".{0}.{1}.new" -f $toolName, [guid]::NewGuid().ToString("N"))
        [System.IO.File]::Copy($source, $promotion, $false)
        if (-not (Test-ExactBinary $promotion $target.binaries.$toolName)) {
            throw "Promotion copy for $toolName.exe failed verification"
        }
        $promotions[$toolName] = $promotion
    }
    foreach ($toolName in @("ffmpeg", "ffprobe")) {
        $destination = Join-Path $stagingDirectory "$toolName.exe"
        if ([System.IO.File]::Exists($destination)) {
            [System.IO.File]::Replace($promotions[$toolName], $destination, $null, $true)
        }
        else {
            [System.IO.File]::Move($promotions[$toolName], $destination)
        }
    }

    if (-not (Test-ExactBinary $ffmpegPath $target.binaries.ffmpeg) -or -not (Test-ExactBinary $ffprobePath $target.binaries.ffprobe)) {
        throw "Staged media tools failed final verification"
    }
    Test-ToolchainCapabilities $ffmpegPath $ffprobePath $manifest $target
    Write-Host "Staged and verified bundled media tools: $($manifest.toolchainId)"
}
finally {
    if ([System.IO.Directory]::Exists($temporaryExtract)) {
        [System.IO.Directory]::Delete($temporaryExtract, $true)
    }
    if ($archiveRecord.Temporary -and [System.IO.File]::Exists($archiveRecord.Path)) {
        [System.IO.File]::Delete($archiveRecord.Path)
    }
}
