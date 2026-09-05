Set-StrictMode -Version 2.0

function New-GateResult([string]$Status, [string[]]$Reasons, $Evidence) {
    $reason = if ($Reasons.Count) { $Reasons -join '; ' } else { "$Status with no details." }
    return [ordered]@{ status=$Status; reason=$reason; evidence=$Evidence }
}

function Get-PercentileValue([double[]]$Values, [double]$Percentile) {
    $sorted = @($Values | Sort-Object)
    if ($sorted.Count -eq 0) { return $null }
    if ($sorted.Count -eq 1) { return [double]$sorted[0] }
    $position = ($sorted.Count - 1) * $Percentile
    $lower = [math]::Floor($position)
    $upper = [math]::Ceiling($position)
    if ($lower -eq $upper) { return [double]$sorted[$lower] }
    return [double]$sorted[$lower] + (($position - $lower) * ([double]$sorted[$upper] - [double]$sorted[$lower]))
}

function Test-ObjectProperty($Value, [string]$Name) {
    if ($null -eq $Value) { return $false }
    if ($Value -is [Collections.IDictionary]) { return $Value.Contains($Name) }
    return $null -ne $Value.PSObject.Properties[$Name]
}

function Test-StructuredObject($Value) {
    if ($null -eq $Value) { return $false }
    return $Value -is [Collections.IDictionary] -or $Value.GetType().FullName -eq 'System.Management.Automation.PSCustomObject'
}

function Test-JsonArray($Value) {
    return $null -ne $Value -and $Value -is [array]
}

function ConvertFrom-GitPorcelainStatus([AllowEmptyString()][string]$Text) {
    if ($Text.Length -eq 0) { return @() }
    if ($Text[$Text.Length - 1] -ne [char]0) { throw 'Malformed NUL-delimited Git status: missing final NUL.' }

    $records = @($Text.Split([char[]]@([char]0), [StringSplitOptions]::None))
    $entries = @()
    for ($index = 0; $index -lt $records.Count - 1; $index++) {
        $record = $records[$index]
        if ($record.Length -lt 4 -or $record[2] -cne ' ') { throw 'Malformed NUL-delimited Git status record.' }
        $status = $record.Substring(0, 2)
        if ($status -ceq '  ' -or ' MADRCUT?!'.IndexOf($status[0]) -lt 0 -or ' MADRCUT?!'.IndexOf($status[1]) -lt 0) { throw "Malformed Git status code: '$status'." }
        if (($status.Contains('?') -and $status -cne '??') -or ($status.Contains('!') -and $status -cne '!!')) { throw "Malformed Git status code: '$status'." }
        $path = $record.Substring(3)
        if ($path.Length -eq 0) { throw 'Malformed NUL-delimited Git status: empty path.' }

        $originalPath = $null
        if ($status.Contains('R') -or $status.Contains('C')) {
            $index++
            if ($index -ge $records.Count - 1 -or $records[$index].Length -eq 0) { throw 'Malformed NUL-delimited Git rename/copy status: missing original path.' }
            $originalPath = $records[$index]
        }
        $entries += [pscustomobject][ordered]@{ status=$status; index=$status[0].ToString(); worktree=$status[1].ToString(); path=$path; originalPath=$originalPath }
    }
    return $entries
}
function Test-FiniteNumber($Value) {
    if ($Value -isnot [byte] -and $Value -isnot [sbyte] -and $Value -isnot [int16] -and $Value -isnot [uint16] -and $Value -isnot [int32] -and $Value -isnot [uint32] -and $Value -isnot [int64] -and $Value -isnot [uint64] -and $Value -isnot [single] -and $Value -isnot [double] -and $Value -isnot [decimal]) { return $false }
    $number = [double]$Value
    return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)
}

function ConvertFrom-GitSubmoduleStatus([AllowEmptyString()][string]$Text) {
    $entries = @()
    $paths = @{}
    foreach ($line in @($Text -split "`r?`n" | Where-Object { $_.Length -gt 0 })) {
        if ($line -notmatch '^([ +\-U])([0-9a-fA-F]{40}) (.+?)(?: \(.+\))?$') { throw "Malformed recursive submodule status line: $line" }
        $path = $matches[3].Replace('\','/')
        if ($paths.ContainsKey($path)) { throw "Duplicate recursive submodule status path: $path" }
        $paths[$path] = $true
        $entries += [ordered]@{ prefix=$matches[1]; sha=$matches[2].ToLowerInvariant(); path=$path }
    }
    return $entries
}

function ConvertFrom-GitSubmoduleOrigins([AllowEmptyString()][string]$Text) {
    $entries = @()
    $paths = @{}
    foreach ($line in @($Text -split "`r?`n" | Where-Object { $_.Length -gt 0 })) {
        $fields = @($line -split "`t", 3)
        if ($fields.Count -ne 3 -or $fields[0] -eq '' -or $fields[1] -notmatch '^[0-9a-fA-F]{40}$' -or $fields[2] -eq '') { throw "Malformed recursive submodule origin line: $line" }
        $path = $fields[0].Replace('\','/')
        if ($paths.ContainsKey($path)) { throw "Duplicate recursive submodule origin path: $path" }
        $paths[$path] = $true
        $entries += [ordered]@{ path=$path; sha=$fields[1].ToLowerInvariant(); origin=$fields[2] }
    }
    return $entries
}

function Test-ExactHttpsUrl([AllowNull()][string]$Actual, [AllowNull()][string]$Expected) {
    if ($Actual -cne $Expected) { return $false }
    $uri = $null
    if (-not [Uri]::TryCreate($Actual, [UriKind]::Absolute, [ref]$uri)) { return $false }
    return $uri.Scheme -eq 'https' -and -not $uri.UserInfo
}

function Get-SubmoduleProvenance($Pins, $StatusRun, $OriginsRun) {
    $issues = @()
    $statusEntries = @()
    $originEntries = @()
    $statusSucceeded = ($null -ne $StatusRun -and (Test-ObjectProperty $StatusRun 'exitCode') -and $StatusRun.exitCode -eq 0 -and (Test-ObjectProperty $StatusRun 'timedOut') -and -not $StatusRun.timedOut)
    $originsSucceeded = ($null -ne $OriginsRun -and (Test-ObjectProperty $OriginsRun 'exitCode') -and $OriginsRun.exitCode -eq 0 -and (Test-ObjectProperty $OriginsRun 'timedOut') -and -not $OriginsRun.timedOut)
    if (-not $statusSucceeded) { $issues += 'recursive submodule status command did not succeed' }
    if (-not $originsSucceeded) { $issues += 'recursive submodule origin collection did not succeed' }
    if ($statusSucceeded) {
        try { $statusEntries = @(ConvertFrom-GitSubmoduleStatus ([string]$StatusRun.stdout)) } catch { $issues += $_.Exception.Message }
    }
    if ($originsSucceeded) {
        try { $originEntries = @(ConvertFrom-GitSubmoduleOrigins ([string]$OriginsRun.stdout)) } catch { $issues += $_.Exception.Message }
    }
    $expected = @($Pins)
    if ($statusEntries.Count -ne $expected.Count) { $issues += "recursive submodule status count $($statusEntries.Count) does not match pin count $($expected.Count)" }
    if ($originEntries.Count -ne $expected.Count) { $issues += "recursive submodule origin count $($originEntries.Count) does not match pin count $($expected.Count)" }
    foreach ($pin in $expected) {
        $path = ([string]$pin.path).Replace('\','/')
        $statuses = @($statusEntries | Where-Object { $_.path -ceq $path })
        $origins = @($originEntries | Where-Object { $_.path -ceq $path })
        if ($statuses.Count -ne 1) { $issues += "submodule $path status is absent or duplicated" }
        else {
            if ($statuses[0].prefix -cne ' ') { $issues += "submodule $path status prefix '$($statuses[0].prefix)' is not clean" }
            if ($statuses[0].sha -cne ([string]$pin.sha).ToLowerInvariant()) { $issues += "submodule $path status SHA does not match its immutable pin" }
        }
        if ($origins.Count -ne 1) { $issues += "submodule $path origin is absent or duplicated" }
        else {
            if ($origins[0].sha -cne ([string]$pin.sha).ToLowerInvariant()) { $issues += "submodule $path origin record SHA does not match its immutable pin" }
            if (-not (Test-ExactHttpsUrl $origins[0].origin ([string]$pin.origin))) { $issues += "submodule $path origin is not the exact pinned HTTPS URL" }
        }
    }
    return [ordered]@{ verified=($issues.Count -eq 0); issues=$issues; statusCommandSucceeded=$statusSucceeded; originsCommandSucceeded=$originsSucceeded; status=$statusEntries; origins=$originEntries }
}

function Get-PatchManifestProvenance($Expected, $Observed) {
    $issues = @()
    $expectedRows = @($Expected)
    $observedRows = @($Observed)
    if ($observedRows.Count -ne $expectedRows.Count) { $issues += "patch file count $($observedRows.Count) does not match pin count $($expectedRows.Count)" }
    foreach ($pin in $expectedRows) {
        $matches = @($observedRows | Where-Object { $_.path -ceq [string]$pin.path })
        if ($matches.Count -ne 1) { $issues += "expected patch $($pin.path) is absent or duplicated"; continue }
        if (([string]$matches[0].sha256).ToLowerInvariant() -cne ([string]$pin.sha256).ToLowerInvariant()) { $issues += "expected patch $($pin.path) content hash does not match" }
    }
    foreach ($row in $observedRows) {
        if (@($expectedRows | Where-Object { [string]$_.path -ceq [string]$row.path }).Count -ne 1) { $issues += "unexpected patch file $($row.path)" }
    }
    return [ordered]@{ verified=($issues.Count -eq 0); issues=$issues; files=$observedRows }
}

function ConvertFrom-CMakeCache([AllowEmptyString()][string]$Text) {
    $fields = [ordered]@{}
    foreach ($line in @($Text -split "`r?`n")) {
        if (-not $line -or $line.StartsWith('#') -or $line.StartsWith('//')) { continue }
        if ($line -notmatch '^([^:=]+):([^=]+)=(.*)$') { continue }
        $name = $matches[1]
        if ($fields.Contains($name)) { throw "Duplicate CMake cache field: $name" }
        $fields[$name] = [ordered]@{ type=$matches[2]; value=$matches[3] }
    }
    return $fields
}

function Test-CachePathEqual([AllowNull()][string]$Actual, [AllowNull()][string]$Expected) {
    if (-not $Actual -or -not $Expected) { return $false }
    return $Actual.Replace('/','\').TrimEnd('\').Equals($Expected.Replace('/','\').TrimEnd('\'), [StringComparison]::OrdinalIgnoreCase)
}

function Get-CompilerCacheProvenance($Fields, [ValidateSet('cuda','vulkan','cpu')][string]$Backend, $Expected) {
    $issues = @()
    $selected = [ordered]@{}
    foreach ($name in @('CMAKE_GENERATOR','CMAKE_BUILD_TYPE','CMAKE_C_COMPILER','CMAKE_CXX_COMPILER','CMAKE_MAKE_PROGRAM','CMAKE_TOOLCHAIN_FILE','CMAKE_CUDA_COMPILER','CMAKE_CUDA_HOST_COMPILER','CMAKE_CUDA_ARCHITECTURES')) {
        $selected[$name] = if ($Fields.Contains($name)) { $Fields[$name].value } else { $null }
    }
    if ($selected.CMAKE_GENERATOR -cne [string]$Expected.generator) { $issues += 'CMAKE_GENERATOR does not match the pinned generator' }
    if ($selected.CMAKE_BUILD_TYPE -cne [string]$Expected.config) { $issues += 'CMAKE_BUILD_TYPE does not match the pinned configuration' }
    if (-not (Test-CachePathEqual $selected.CMAKE_C_COMPILER ([string]$Expected.cCompiler))) { $issues += 'CMAKE_C_COMPILER does not match the preflight MSVC toolchain' }
    if (-not (Test-CachePathEqual $selected.CMAKE_CXX_COMPILER ([string]$Expected.cxxCompiler))) { $issues += 'CMAKE_CXX_COMPILER does not match the preflight MSVC toolchain' }
    if (-not $selected.CMAKE_MAKE_PROGRAM -or [IO.Path]::GetFileName($selected.CMAKE_MAKE_PROGRAM) -notin @('ninja','ninja.exe')) { $issues += 'CMAKE_MAKE_PROGRAM is not Ninja' }
    if ($selected.CMAKE_TOOLCHAIN_FILE) { $issues += 'CMAKE_TOOLCHAIN_FILE is unexpectedly set for the pinned ASR-only build' }
    if ($Backend -eq 'cuda') {
        if (-not (Test-CachePathEqual $selected.CMAKE_CUDA_COMPILER ([string]$Expected.cudaCompiler))) { $issues += 'CMAKE_CUDA_COMPILER does not match the preflight CUDA compiler' }
        if ($selected.CMAKE_CUDA_HOST_COMPILER -and -not (Test-CachePathEqual $selected.CMAKE_CUDA_HOST_COMPILER ([string]$Expected.cudaHostCompiler))) { $issues += 'CMAKE_CUDA_HOST_COMPILER does not match the preflight MSVC toolchain' }
        if ($selected.CMAKE_CUDA_ARCHITECTURES -cne [string]$Expected.cudaArch) { $issues += 'CMAKE_CUDA_ARCHITECTURES does not match the pinned architecture' }
    }
    return [ordered]@{ verified=($issues.Count -eq 0); issues=$issues; fields=$selected }
}

function Get-PostBuildMutationProvenance([ValidateSet('cuda','vulkan','cpu')][string]$Backend, $StatusRun, $GgmlTreeRun, [int]$BuildExit, $PatchLock) {
    $issues = @()
    $statusSucceeded = ($null -ne $StatusRun -and $StatusRun.exitCode -eq 0 -and -not $StatusRun.timedOut -and (-not (Test-ObjectProperty $StatusRun 'outputCaptureComplete') -or $StatusRun.outputCaptureComplete) -and (-not (Test-ObjectProperty $StatusRun 'stdoutTruncated') -or -not $StatusRun.stdoutTruncated))
    $treeSucceeded = ($null -ne $GgmlTreeRun -and $GgmlTreeRun.exitCode -eq 0 -and -not $GgmlTreeRun.timedOut)
    $statusEntries = @()
    if ($statusSucceeded) {
        try {
            if (Test-ObjectProperty $StatusRun 'status') { $statusEntries = @($StatusRun.status) } else { $statusEntries = @(ConvertFrom-GitPorcelainStatus ([string]$StatusRun.stdout)) }
        } catch {
            $statusSucceeded = $false
            $issues += $_.Exception.Message
        }
    }
    $tree = if ($treeSucceeded) { ([string]$GgmlTreeRun.stdout).Trim().ToLowerInvariant() } else { $null }
    if (-not $statusSucceeded) { $issues += 'post-build superproject status command did not succeed or returned incomplete status' }
    if (-not $treeSucceeded) { $issues += 'post-build ggml tree collection did not succeed' }
    $cleanTree = ([string]$PatchLock.cleanGgmlTree).ToLowerInvariant()
    $patchedTree = ([string]$PatchLock.postPatchGgmlTree).ToLowerInvariant()
    if ($Backend -eq 'cuda') {
        $isClean = ($statusSucceeded -and $statusEntries.Count -eq 0 -and $tree -ceq $cleanTree)
        $isExpectedPatch = ($statusSucceeded -and $statusEntries.Count -eq 1 -and $statusEntries[0].status -ceq ' M' -and $statusEntries[0].path -ceq 'ggml' -and $null -eq $statusEntries[0].originalPath -and $tree -ceq $patchedTree)
        if (-not $isClean -and -not $isExpectedPatch) { $issues += 'CUDA source mutation is neither clean nor the exact pinned ggml patch result' }
        if ($BuildExit -eq 0 -and -not $isExpectedPatch) { $issues += 'successful CUDA build lacks the exact pinned ggml patch result' }
        $mode = if ($isExpectedPatch) { 'expected-patch' } elseif ($isClean) { 'clean' } else { 'unexpected' }
    } else {
        $mode = if ($statusSucceeded -and $statusEntries.Count -eq 0 -and $tree -ceq $cleanTree) { 'clean' } else { 'unexpected' }
        if ($mode -ne 'clean') { $issues += "$Backend build mutated its verified source copy" }
    }
    return [ordered]@{ verified=($issues.Count -eq 0); issues=$issues; mode=$mode; superprojectStatus=$statusEntries; ggmlTree=$tree; expectedCleanGgmlTree=$cleanTree; expectedPostPatchGgmlTree=$(if ($Backend -eq 'cuda') { $patchedTree } else { $null }) }
}

function Get-GpuExecutionProof {
    param(
        [ValidateSet('cuda','vulkan')][string]$Backend,
        [string]$ExpectedDevice,
        $DoctorRun,
        $InferenceMeasurement,
        [double]$AllocationThresholdMiB,
        [string]$ExpectedGpuDescription
    )
    $issues = @()
    $expectedFeature = "backend_$Backend"
    $canonicalDeviceName = $ExpectedDevice.ToLowerInvariant().Replace(':','')
    if ($ExpectedDevice -ne "${Backend}:0") { $issues += "$Backend expected device must be ${Backend}:0, got '$ExpectedDevice'" }

    $doctorJson = $null
    if ($null -eq $DoctorRun) {
        $issues += "$Backend doctor evidence is absent"
    } else {
        if (-not (Test-ObjectProperty $DoctorRun 'exitCode') -or $DoctorRun.exitCode -ne 0) { $issues += "$Backend doctor did not exit 0" }
        if (-not (Test-ObjectProperty $DoctorRun 'timedOut') -or $DoctorRun.timedOut) { $issues += "$Backend doctor timed out or lacks timeout evidence" }
        if (Test-ObjectProperty $DoctorRun 'json') { $doctorJson = $DoctorRun.json }
        if ($null -eq $doctorJson) { $issues += "$Backend doctor JSON is absent" }
    }

    $selectedDevice = $null
    if ($null -ne $doctorJson) {
        foreach ($field in @('features','devices','accelerator_compiled','accelerator_available','driver_runtime_compatible')) {
            if (-not (Test-ObjectProperty $doctorJson $field)) { $issues += "$Backend doctor JSON is missing $field" }
        }
        if (Test-ObjectProperty $doctorJson 'features') {
            if ($null -eq $doctorJson.features) {
                $issues += "$Backend doctor JSON features is null"
            } else {
                foreach ($feature in @('backend_cuda','backend_metal','backend_vulkan')) {
                    if (-not (Test-ObjectProperty $doctorJson.features $feature)) { $issues += "$Backend doctor JSON is missing features.$feature" }
                    elseif ($doctorJson.features.$feature -isnot [bool]) { $issues += "$Backend doctor JSON features.$feature is not boolean" }
                }
                if ((Test-ObjectProperty $doctorJson.features $expectedFeature) -and ($doctorJson.features.$expectedFeature -isnot [bool] -or -not $doctorJson.features.$expectedFeature)) { $issues += "$Backend doctor JSON does not prove features.$expectedFeature=true" }
                foreach ($feature in @('backend_cuda','backend_metal','backend_vulkan') | Where-Object { $_ -ne $expectedFeature }) {
                    if ((Test-ObjectProperty $doctorJson.features $feature) -and $doctorJson.features.$feature -eq $true) { $issues += "$Backend doctor JSON unexpectedly reports features.$feature=true" }
                }
            }
        }
        foreach ($field in @('accelerator_compiled','accelerator_available','driver_runtime_compatible')) {
            if (Test-ObjectProperty $doctorJson $field) {
                if ($doctorJson.$field -isnot [bool] -or -not $doctorJson.$field) { $issues += "$Backend doctor JSON does not prove $field=true" }
            }
        }
        if (Test-ObjectProperty $doctorJson 'devices') {
            $matches = @($doctorJson.devices | Where-Object {
                (Test-ObjectProperty $_ 'name') -and ([string]$_.name).ToLowerInvariant().Replace(':','').Replace('-','').Replace('_','') -eq $canonicalDeviceName
            })
            if ($matches.Count -ne 1) {
                $issues += "$Backend doctor JSON expected exactly one $ExpectedDevice device (name $canonicalDeviceName), found $($matches.Count)"
            } else {
                $selectedDevice = $matches[0]
                foreach ($field in @('index','name','description','type','memory_free','memory_total','async','events')) {
                    if (-not (Test-ObjectProperty $selectedDevice $field)) { $issues += "$Backend doctor device is missing $field" }
                }
                if ((Test-ObjectProperty $selectedDevice 'index') -and [int]$selectedDevice.index -ne 0) { $issues += "$Backend doctor device index '$($selectedDevice.index)' is not 0" }
                if ((Test-ObjectProperty $selectedDevice 'type') -and $selectedDevice.type -ne 'gpu') { $issues += "$Backend doctor device type '$($selectedDevice.type)' is not gpu" }
                if ((Test-ObjectProperty $selectedDevice 'memory_total') -and [double]$selectedDevice.memory_total -le 0) { $issues += "$Backend doctor device memory_total is not positive" }
                if ((Test-ObjectProperty $selectedDevice 'memory_free') -and [double]$selectedDevice.memory_free -lt 0) { $issues += "$Backend doctor device memory_free is negative" }
                foreach ($field in @('async','events')) { if ((Test-ObjectProperty $selectedDevice $field) -and $selectedDevice.$field -isnot [bool]) { $issues += "$Backend doctor device $field is not boolean" } }
                if ($ExpectedGpuDescription -and (Test-ObjectProperty $selectedDevice 'description') -and ([string]$selectedDevice.description).IndexOf($ExpectedGpuDescription, [StringComparison]::OrdinalIgnoreCase) -lt 0) {
                    $issues += "$Backend doctor device '$($selectedDevice.description)' is not the expected $ExpectedGpuDescription"
                }
            }
        }
    }

    $inferenceRun = $null
    $allocationIncreaseMiB = $null
    $allocationEvidenceSource = $null
    if ($null -eq $InferenceMeasurement) {
        $issues += "$Backend JFK inference evidence is absent"
    } else {
        if (-not (Test-ObjectProperty $InferenceMeasurement 'backend') -or $InferenceMeasurement.backend -ne $Backend) { $issues += "$Backend inference backend identity is absent or wrong" }
        if (-not (Test-ObjectProperty $InferenceMeasurement 'fixture') -or $InferenceMeasurement.fixture -ne 'jfk-smoke') { $issues += "$Backend proof requires the jfk-smoke inference" }
        if (Test-ObjectProperty $InferenceMeasurement 'run') { $inferenceRun = $InferenceMeasurement.run }
        if ($null -eq $inferenceRun) {
            $issues += "$Backend JFK inference run is absent"
        } else {
            if (-not (Test-ObjectProperty $inferenceRun 'device') -or $inferenceRun.device -ne $ExpectedDevice) { $issues += "$Backend JFK inference did not use $ExpectedDevice" }
            if (-not (Test-ObjectProperty $inferenceRun 'exitCode') -or $inferenceRun.exitCode -ne 0) { $issues += "$Backend JFK inference did not exit 0" }
            if (-not (Test-ObjectProperty $inferenceRun 'timedOut') -or $inferenceRun.timedOut) { $issues += "$Backend JFK inference timed out or lacks timeout evidence" }
            if (-not (Test-ObjectProperty $inferenceRun 'selectedGpuUuid') -or [string]::IsNullOrWhiteSpace([string]$inferenceRun.selectedGpuUuid) -or -not (Test-ObjectProperty $inferenceRun 'selectedGpuIndex') -or $null -eq $inferenceRun.selectedGpuIndex) { $issues += "$Backend JFK inference lacks selected GTX 1080 index/UUID evidence" }
            if (-not (Test-ObjectProperty $inferenceRun 'networkObservationAvailable') -or -not $inferenceRun.networkObservationAvailable) { $issues += "$Backend JFK inference lacks descendant network observation" }
            if (-not (Test-ObjectProperty $inferenceRun 'unexpectedNetworkConnectionCount') -or $null -eq $inferenceRun.unexpectedNetworkConnectionCount) { $issues += "$Backend JFK inference lacks unexpected-traffic evidence" }
            elseif ([int]$inferenceRun.unexpectedNetworkConnectionCount -ne 0) { $issues += "$Backend JFK inference observed $($inferenceRun.unexpectedNetworkConnectionCount) unexpected descendant TCP connections" }
            $runFailure=Get-RunFailure $inferenceRun
            if($runFailure){$issues += "$Backend JFK inference $runFailure"}
            if (-not (Test-ObjectProperty $inferenceRun 'gpuPerProcessQueryAttempted') -or -not $inferenceRun.gpuPerProcessQueryAttempted) { $issues += "$Backend JFK inference did not attempt NVIDIA per-process allocation observation" }
            $perProcessSupported = (Test-ObjectProperty $inferenceRun 'gpuPerProcessSupported') -and [bool]$inferenceRun.gpuPerProcessSupported
            if (-not (Test-ObjectProperty $inferenceRun 'gpuPerProcessQuerySucceeded') -or -not $inferenceRun.gpuPerProcessQuerySucceeded) { $issues += "$Backend JFK inference NVIDIA per-process query did not succeed" }
            if (-not $perProcessSupported) { $issues += "$Backend JFK inference lacks supported NVIDIA per-process GPU allocation evidence" }
            $allocationEvidenceSource='owned-process-gpu-memory'
            if (-not (Test-ObjectProperty $inferenceRun 'baselineOwnedGpuMemoryMiB') -or $null -eq $inferenceRun.baselineOwnedGpuMemoryMiB -or -not (Test-ObjectProperty $inferenceRun 'peakOwnedGpuMemoryMiB') -or $null -eq $inferenceRun.peakOwnedGpuMemoryMiB) {
                $issues += "$Backend JFK inference lacks owned-process GPU allocation evidence"
            } else { $allocationIncreaseMiB=[double]$inferenceRun.peakOwnedGpuMemoryMiB-[double]$inferenceRun.baselineOwnedGpuMemoryMiB }
            if (-not (Test-ObjectProperty $inferenceRun 'baselineVramMiB') -or $null -eq $inferenceRun.baselineVramMiB -or -not (Test-ObjectProperty $inferenceRun 'peakVramMiB') -or $null -eq $inferenceRun.peakVramMiB) { $issues += "$Backend JFK inference lacks corroborating selected GTX 1080 VRAM evidence" }
            if ($null -ne $allocationIncreaseMiB -and $allocationIncreaseMiB -lt $AllocationThresholdMiB) { $issues += "$Backend JFK GTX 1080 allocation increase $allocationIncreaseMiB MiB is below $AllocationThresholdMiB MiB" }
            if((Test-ObjectProperty $inferenceRun 'ownedGpuMemoryIncreaseMiB') -and $null-ne$inferenceRun.ownedGpuMemoryIncreaseMiB -and $null-ne$allocationIncreaseMiB -and ([double]$inferenceRun.ownedGpuMemoryIncreaseMiB -ne [double]$allocationIncreaseMiB)){$issues += "$Backend JFK owned-process GPU allocation delta is inconsistent"}
            if((Test-ObjectProperty $inferenceRun 'vramIncreaseMiB') -and $null-ne$inferenceRun.vramIncreaseMiB -and ([double]$inferenceRun.vramIncreaseMiB -ne ([double]$inferenceRun.peakVramMiB-[double]$inferenceRun.baselineVramMiB))){$issues += "$Backend JFK selected-device VRAM delta is inconsistent"}
        }
    }

    $doctorProof = [ordered]@{
        pass=(@($issues | Where-Object { $_ -like "$Backend doctor*" }).Count -eq 0)
        exitCode=$(if ($null -ne $DoctorRun -and (Test-ObjectProperty $DoctorRun 'exitCode')) { $DoctorRun.exitCode } else { $null })
        timedOut=$(if ($null -ne $DoctorRun -and (Test-ObjectProperty $DoctorRun 'timedOut')) { $DoctorRun.timedOut } else { $null })
        expectedFeature=$expectedFeature
        observedFeature=$(if ($null -ne $doctorJson -and (Test-ObjectProperty $doctorJson 'features') -and $null -ne $doctorJson.features -and (Test-ObjectProperty $doctorJson.features $expectedFeature)) { $doctorJson.features.$expectedFeature } else { $null })
        compiledFeatures=[ordered]@{
            backend_cuda=$(if ($null -ne $doctorJson -and (Test-ObjectProperty $doctorJson 'features') -and $null -ne $doctorJson.features -and (Test-ObjectProperty $doctorJson.features 'backend_cuda')) { $doctorJson.features.backend_cuda } else { $null })
            backend_metal=$(if ($null -ne $doctorJson -and (Test-ObjectProperty $doctorJson 'features') -and $null -ne $doctorJson.features -and (Test-ObjectProperty $doctorJson.features 'backend_metal')) { $doctorJson.features.backend_metal } else { $null })
            backend_vulkan=$(if ($null -ne $doctorJson -and (Test-ObjectProperty $doctorJson 'features') -and $null -ne $doctorJson.features -and (Test-ObjectProperty $doctorJson.features 'backend_vulkan')) { $doctorJson.features.backend_vulkan } else { $null })
        }
        acceleratorCompiled=$(if ($null -ne $doctorJson -and (Test-ObjectProperty $doctorJson 'accelerator_compiled')) { $doctorJson.accelerator_compiled } else { $null })
        acceleratorAvailable=$(if ($null -ne $doctorJson -and (Test-ObjectProperty $doctorJson 'accelerator_available')) { $doctorJson.accelerator_available } else { $null })
        driverRuntimeCompatible=$(if ($null -ne $doctorJson -and (Test-ObjectProperty $doctorJson 'driver_runtime_compatible')) { $doctorJson.driver_runtime_compatible } else { $null })
        expectedDevice=$ExpectedDevice
        expectedGpuDescription=$ExpectedGpuDescription
        selectedDevice=$selectedDevice
    }
    $inferenceProof = [ordered]@{
        pass=($null -ne $allocationIncreaseMiB -and $allocationIncreaseMiB -ge $AllocationThresholdMiB -and @($issues | Where-Object { $_ -like "$Backend JFK*" -or $_ -like "$Backend inference*" -or $_ -like "$Backend proof*" }).Count -eq 0)
        fixture=$(if ($null -ne $InferenceMeasurement -and (Test-ObjectProperty $InferenceMeasurement 'fixture')) { $InferenceMeasurement.fixture } else { $null })
        device=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'device')) { $inferenceRun.device } else { $null })
        evidencePath=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'evidencePath')) { $inferenceRun.evidencePath } else { $null })
        selectedGpuIndex=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'selectedGpuIndex')) { $inferenceRun.selectedGpuIndex } else { $null })
        selectedGpuUuid=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'selectedGpuUuid')) { $inferenceRun.selectedGpuUuid } else { $null })
        baselineVramMiB=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'baselineVramMiB')) { $inferenceRun.baselineVramMiB } else { $null })
        peakVramMiB=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'peakVramMiB')) { $inferenceRun.peakVramMiB } else { $null })
        gpuPerProcessQueryAttempted=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'gpuPerProcessQueryAttempted')) { $inferenceRun.gpuPerProcessQueryAttempted } else { $false })
        gpuPerProcessQuerySucceeded=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'gpuPerProcessQuerySucceeded')) { $inferenceRun.gpuPerProcessQuerySucceeded } else { $false })
        gpuPerProcessSupported=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'gpuPerProcessSupported')) { $inferenceRun.gpuPerProcessSupported } else { $false })
        baselineOwnedGpuMemoryMiB=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'baselineOwnedGpuMemoryMiB')) { $inferenceRun.baselineOwnedGpuMemoryMiB } else { $null })
        peakOwnedGpuMemoryMiB=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'peakOwnedGpuMemoryMiB')) { $inferenceRun.peakOwnedGpuMemoryMiB } else { $null })
        allocationEvidenceSource=$allocationEvidenceSource
        allocationIncreaseMiB=$allocationIncreaseMiB
        thresholdMiB=$AllocationThresholdMiB
        networkObservationAvailable=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'networkObservationAvailable')) { $inferenceRun.networkObservationAvailable } else { $false })
        unexpectedNetworkConnectionCount=$(if ($null -ne $inferenceRun -and (Test-ObjectProperty $inferenceRun 'unexpectedNetworkConnectionCount')) { $inferenceRun.unexpectedNetworkConnectionCount } else { $null })
    }
    return [ordered]@{ schemaVersion=1; backend=$Backend; expectedDevice=$ExpectedDevice; pass=($issues.Count -eq 0); issues=$issues; doctor=$doctorProof; inference=$inferenceProof }
}

function Get-BackendBuildIssues($Entry, [ValidateSet('cuda','vulkan','cpu')][string]$Backend) {
    $issues = @()
    if ($null -eq $Entry) { return @("$Backend backend evidence is absent") }
    if (-not (Test-ObjectProperty $Entry 'buildExit') -or $Entry.buildExit -ne 0) { $issues += "$Backend build did not exit 0" }
    if (-not (Test-ObjectProperty $Entry 'timedOut') -or $Entry.timedOut) { $issues += "$Backend build timed out or lacks timeout evidence" }
    if (-not (Test-ObjectProperty $Entry 'exactExecutableProvenance') -or -not $Entry.exactExecutableProvenance) { $issues += "$Backend executable lacks exact current-build provenance" }
    if (-not (Test-ObjectProperty $Entry 'provenanceVerified') -or -not $Entry.provenanceVerified) { $issues += "$Backend source/compiler provenance is not verified" }
    if (-not (Test-ObjectProperty $Entry 'compilerCache') -or $null -eq $Entry.compilerCache -or -not (Test-ObjectProperty $Entry.compilerCache 'verified') -or -not $Entry.compilerCache.verified) { $issues += "$Backend CMake compiler cache is not verified" }
    if (-not (Test-ObjectProperty $Entry 'runnable') -or -not $Entry.runnable) { $issues += "$Backend backend is not runnable" }
    if ($Backend -eq 'cuda') {
        if (-not (Test-ObjectProperty $Entry 'cmakeCachePresent') -or -not $Entry.cmakeCachePresent -or -not (Test-ObjectProperty $Entry 'cmakeCacheSm61') -or -not $Entry.cmakeCacheSm61) { $issues += 'cuda CMakeCache sm_61 evidence is absent' }
        if (-not (Test-ObjectProperty $Entry 'cuobjdumpRan') -or -not $Entry.cuobjdumpRan -or -not (Test-ObjectProperty $Entry 'cuobjdumpExit') -or $Entry.cuobjdumpExit -ne 0 -or -not (Test-ObjectProperty $Entry 'cuobjdumpTimedOut') -or $Entry.cuobjdumpTimedOut -or -not (Test-ObjectProperty $Entry 'cuobjdumpSm61') -or -not $Entry.cuobjdumpSm61) { $issues += 'cuda successful cuobjdump sm_61 evidence is absent' }
    }
    return $issues
}

function Test-BackendBuildEligibility($Entry, [ValidateSet('cuda','vulkan','cpu')][string]$Backend) {
    return (@(Get-BackendBuildIssues $Entry $Backend).Count -eq 0)
}

function Get-GpuBuildGate($State) {
    $issues = @()
    foreach ($backend in @('cuda','vulkan')) { $issues += @(Get-BackendBuildIssues $State.backends[$backend] $backend) }
    $evidence = [ordered]@{ cuda=$State.backends['cuda']; vulkan=$State.backends['vulkan'] }
    if ($issues.Count) { return New-GateResult 'FAIL' $issues $evidence }
    return New-GateResult 'PASS' @('CUDA and Vulkan builds exited 0 without timeout and produced exact runnable Release executables; CUDA has successful CMakeCache and cuobjdump sm_61 proof.') $evidence
}

function Get-SpikeVerdict($Mandatory, $VerdictBlockingFailures) {
    $thresholdFailureCount = @($Mandatory.Keys | Where-Object { $Mandatory[$_].status -ne 'PASS' }).Count
    $blockingFailureCount = @($VerdictBlockingFailures).Count
    if ($thresholdFailureCount -eq 0 -and $blockingFailureCount -eq 0) { return 'PASS_TO_BENCHMARK' }
    return 'FAIL_MACHINE_SPIKE'
}

function Get-GpuPrerequisiteIssues($State) {
    $issues = @()
    foreach ($backend in @('cuda','vulkan')) {
        $entry = $State.backends[$backend]
        $buildIssues = @(Get-BackendBuildIssues $entry $backend)
        if ($buildIssues.Count) { $issues += $buildIssues; continue }
        if ($null -eq $entry.capabilities) { $issues += "$backend capability evidence is absent"; continue }
        if (-not $entry.capabilities.doctorOk) { $issues += "$backend doctor prerequisite failed" }
        if (-not $entry.capabilities.modelCompatible) { $issues += "$backend model compatibility prerequisite failed" }
    }
    return $issues
}

function Get-RunFailure($Run) {
    if ($null -eq $Run) { return 'run evidence is absent' }
    if ($Run.timedOut) { return 'run timed out' }
    if ($Run.exitCode -ne 0) { return "run exited $($Run.exitCode)" }
    if((Test-ObjectProperty $Run 'observed') -and $Run.observed){
        if(-not (Test-ObjectProperty $Run 'runnerSucceeded') -or -not $Run.runnerSucceeded){return 'observed runner evidence is incomplete'}
        if(-not (Test-ObjectProperty $Run 'ownershipTrackingAvailable') -or -not $Run.ownershipTrackingAvailable){return 'recursive ownership evidence is unavailable'}
        if((Test-ObjectProperty $Run 'ownershipErrors') -and @($Run.ownershipErrors).Count){return 'recursive ownership observation reported errors'}
        if(-not (Test-ObjectProperty $Run 'resourceSampleCount') -or [int]$Run.resourceSampleCount -le 0){return 'resource samples are absent'}
        if(-not (Test-ObjectProperty $Run 'processLifecycle') -or @($Run.processLifecycle).Count -eq 0){return 'process lifecycle evidence is absent'}
        if((Test-ObjectProperty $Run 'samplingErrors') -and @($Run.samplingErrors).Count){return 'resource sampling reported errors'}
    }
    return $null
}

function Get-SmokeAccuracyGate($State, $Thresholds) {
    $requirements = $Thresholds.requirements
    $expected = @(
        @{ fixture='jfk-smoke'; threshold='jfkWer' },
        @{ fixture='clean-keyterms'; threshold='cleanWer' },
        @{ fixture='ugly-dialogue'; threshold='uglyWer' }
    )
    $prerequisites = @(Get-GpuPrerequisiteIssues $State)
    $evidenceRows = @()
    $failures = @()
    $missing = @()
    $wordErrors = 0.0
    $referenceWords = 0.0

    foreach ($backend in @('cuda','vulkan')) {
        foreach ($definition in $expected) {
            $matches = @($State.metrics | Where-Object { $_.backend -eq $backend -and $_.fixture -eq $definition.fixture })
            if ($matches.Count -ne 1) {
                $missing += "$backend/$($definition.fixture) expected one measurement, found $($matches.Count)"
                continue
            }
            $row = $matches[0]
            $runFailure = Get-RunFailure $row.run
            if ($runFailure) { $failures += "$backend/$($definition.fixture) $runFailure"; continue }
            if ($null -eq $row.measurement) { $failures += "$backend/$($definition.fixture) measurement is absent"; continue }
            if (-not $row.measurement.schemaValid) {
                $schemaErrors=@($row.measurement.schemaErrors)
                $failures += "$backend/$($definition.fixture) transcript schema is invalid: $($schemaErrors -join ', ')"
                $evidenceRows += [ordered]@{ backend=$backend; fixture=$definition.fixture; schemaValid=$false; schemaErrors=$schemaErrors }
                continue
            }
            if ($null -eq $row.measurement.wer) { $failures += "$backend/$($definition.fixture) WER is absent"; continue }

            $limit = [double]$requirements.($definition.threshold)
            $wer = [double]$row.measurement.wer
            $evidenceRows += [ordered]@{ backend=$backend; fixture=$definition.fixture; schemaValid=$true; schemaErrors=@(); wer=$wer; threshold=$limit; pass=($wer -le $limit); keytermRecall=$(if(Test-ObjectProperty $row.measurement 'keytermRecall'){$row.measurement.keytermRecall}else{$null}); keytermCount=$(if(Test-ObjectProperty $row.measurement 'keytermCount'){$row.measurement.keytermCount}else{$null}); keytermMatches=$(if(Test-ObjectProperty $row.measurement 'keytermMatches'){$row.measurement.keytermMatches}else{$null}); keytermResults=$(if(Test-ObjectProperty $row.measurement 'keytermResults'){$row.measurement.keytermResults}else{@()}) }
            if ($wer -gt $limit) { $failures += "$backend/$($definition.fixture) WER $wer exceeds $($definition.threshold) $limit" }
            if ($row.measurement.referenceWordCount -gt 0 -and $null -ne $row.measurement.wordErrors) {
                $wordErrors += [double]$row.measurement.wordErrors
                $referenceWords += [double]$row.measurement.referenceWordCount
            } else {
                $failures += "$backend/$($definition.fixture) WER aggregation counts are absent"
            }
            if ($definition.fixture -eq 'clean-keyterms') {
                if ($null -eq $row.measurement.keytermRecall) {
                    $failures += "$backend/clean-keyterms key-term recall is absent"
                } else {
                    $recall = [double]$row.measurement.keytermRecall
                    if ($recall -lt [double]$requirements.cleanKeytermRecall) { $failures += "$backend/clean-keyterms key-term recall $recall is below cleanKeytermRecall $($requirements.cleanKeytermRecall)" }
                }
            }
        }
    }

    $combinedWer = if ($referenceWords -gt 0) { [math]::Round($wordErrors / $referenceWords, 6) } else { $null }
    if ($null -ne $combinedWer -and $combinedWer -gt [double]$requirements.combinedWer) { $failures += "combined weighted WER $combinedWer exceeds combinedWer $($requirements.combinedWer)" }
    $evidence = [ordered]@{ expectedMeasurements=6; successfulMeasurements=$evidenceRows.Count; measurements=$evidenceRows; combinedWordErrors=$wordErrors; combinedReferenceWords=$referenceWords; combinedWer=$combinedWer; combinedWerThreshold=[double]$requirements.combinedWer }

    if ($prerequisites.Count) { return New-GateResult 'NOT_RUN' @("Accuracy matrix was incomplete because prerequisites prevented measurement: $($prerequisites -join ', ')") $evidence }
    if ($missing.Count) { $failures += $missing }
    if ($failures.Count) { return New-GateResult 'FAIL' $failures $evidence }
    return New-GateResult 'PASS' @("All 6 backend/fixture WER limits and both key-term recall limits passed; combined weighted WER $combinedWer <= $($requirements.combinedWer)") $evidence
}

function Get-NormalizedGateWord([AllowNull()][string]$Word) {
    if (-not $Word) { return '' }
    return ([regex]::Replace($Word.Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant(), '[^\p{L}\p{Nd}]+', '')).Trim()
}

function Measure-NormalizedWordAlignment($ReferenceWords, $HypothesisWords) {
    $reference = @($ReferenceWords)
    $hypothesis = @($HypothesisWords)
    $rCount = $reference.Count
    $hCount = $hypothesis.Count
    $normalizedReference = @($reference | ForEach-Object { Get-NormalizedGateWord ([string]$_.word) })
    $normalizedHypothesis = @($hypothesis | ForEach-Object { Get-NormalizedGateWord ([string]$_.word) })
    $lcs = New-Object 'int[,]' ($rCount + 1), ($hCount + 1)

    for ($i=1; $i -le $rCount; $i++) {
        for ($j=1; $j -le $hCount; $j++) {
            $previousI=$i-1
            $previousJ=$j-1
            if ($normalizedReference[$previousI] -and $normalizedReference[$previousI] -eq $normalizedHypothesis[$previousJ]) {
                $diagonal=[int]$lcs[$previousI,$previousJ]
                $lcs[$i,$j] = $diagonal + 1
            } else {
                $above=[int]$lcs[$previousI,$j]
                $left=[int]$lcs[$i,$previousJ]
                $lcs[$i,$j] = if ($above -ge $left) { $above } else { $left }
            }
        }
    }

    $matchedPairs = @()
    $i = $rCount
    $j = $hCount
    while ($i -gt 0 -and $j -gt 0) {
        $previousI=$i-1
        $previousJ=$j-1
        if ($normalizedReference[$previousI] -and $normalizedReference[$previousI] -eq $normalizedHypothesis[$previousJ]) {
            $matchedPairs += [ordered]@{ referenceIndex=$previousI; hypothesisIndex=$previousJ; normalizedWord=$normalizedReference[$previousI] }
            $i--
            $j--
        } else {
            $above=[int]$lcs[$previousI,$j]
            $left=[int]$lcs[$i,$previousJ]
            if ($above -ge $left) { $i-- } else { $j-- }
        }
    }
    $matchedPairs = @($matchedPairs | Sort-Object referenceIndex)

    $matchedReference = New-Object 'Collections.Generic.HashSet[int]'
    $matchedHypothesis = New-Object 'Collections.Generic.HashSet[int]'
    foreach ($pair in $matchedPairs) {
        [void]$matchedReference.Add([int]$pair.referenceIndex)
        [void]$matchedHypothesis.Add([int]$pair.hypothesisIndex)
    }
    $missing = @()
    for ($index=0; $index -lt $rCount; $index++) {
        if (-not $matchedReference.Contains($index)) { $missing += [ordered]@{ referenceIndex=$index; normalizedWord=$normalizedReference[$index] } }
    }
    $unexpected = @()
    for ($index=0; $index -lt $hCount; $index++) {
        if (-not $matchedHypothesis.Contains($index)) { $unexpected += [ordered]@{ hypothesisIndex=$index; normalizedWord=$normalizedHypothesis[$index] } }
    }

    return [ordered]@{
        referenceWords=$rCount
        hypothesisWords=$hCount
        matchedWords=$matchedPairs.Count
        matchCoverage=$(if ($rCount) { [math]::Round($matchedPairs.Count/[double]$rCount,6) } else { 0 })
        sequenceDeltaWords=($missing.Count + $unexpected.Count)
        matches=$matchedPairs
        missing=$missing
        unexpected=$unexpected
    }
}

function Measure-BookmarkBoundaries($Document, $Bookmarks) {
    $indexedReference = @()
    $sourceIndex = 0
    foreach ($bookmark in @($Bookmarks)) {
        $indexedReference += [pscustomobject]@{ word=[string]$bookmark.word; seconds=[double]$bookmark.seconds; sourceIndex=$sourceIndex }
        $sourceIndex++
    }
    $reference = @($indexedReference | Sort-Object @{Expression={ [double]$_.seconds }}, @{Expression={ [int]$_.sourceIndex }})
    $hypothesis = @($Document.words)
    $alignment = Measure-NormalizedWordAlignment $reference $hypothesis
    $matches = @()
    $errors = @()
    foreach ($pair in @($alignment.matches)) {
        $expected = $reference[[int]$pair.referenceIndex]
        $actual = $hypothesis[[int]$pair.hypothesisIndex]
        $error = [math]::Abs(([double]$actual.start - [double]$expected.seconds) * 1000.0)
        $errors += $error
        $matches += [ordered]@{
            referenceIndex=[int]$pair.referenceIndex
            hypothesisIndex=[int]$pair.hypothesisIndex
            word=$pair.normalizedWord
            expectedStartSeconds=[math]::Round([double]$expected.seconds,6)
            actualStartSeconds=[math]::Round([double]$actual.start,6)
            startBoundaryErrorMs=[math]::Round($error,3)
        }
    }
    $missing = @($alignment.missing | ForEach-Object {
        $expected = $reference[[int]$_.referenceIndex]
        [ordered]@{ referenceIndex=[int]$_.referenceIndex; word=$_.normalizedWord; expectedStartSeconds=[math]::Round([double]$expected.seconds,6) }
    })
    $unexpected = @($alignment.unexpected | ForEach-Object {
        $actual = $hypothesis[[int]$_.hypothesisIndex]
        [ordered]@{ hypothesisIndex=[int]$_.hypothesisIndex; word=$_.normalizedWord; actualStartSeconds=$(if (Test-ObjectProperty $actual 'start') { [math]::Round([double]$actual.start,6) } else { $null }) }
    })
    $median = Get-PercentileValue ([double[]]$errors) 0.5
    $p95 = Get-PercentileValue ([double[]]$errors) 0.95
    return [ordered]@{
        expected=$reference.Count
        hypothesis=$hypothesis.Count
        matched=$matches.Count
        alignmentCoverage=$alignment.matchCoverage
        missingCount=$missing.Count
        unexpectedCount=$unexpected.Count
        sequenceDeltaWords=$alignment.sequenceDeltaWords
        startErrorsMs=@($errors | ForEach-Object { [math]::Round([double]$_,3) })
        medianStartBoundaryErrorMs=$(if ($null -ne $median) { [math]::Round($median,3) } else { $null })
        p95StartBoundaryErrorMs=$(if ($null -ne $p95) { [math]::Round($p95,3) } else { $null })
        matches=$matches
        missing=$missing
        unexpected=$unexpected
    }
}

function Get-WordTimestampGate($State, $Thresholds) {
    $prerequisites = @(Get-GpuPrerequisiteIssues $State)
    $failures=@(); $missing=@(); $boundaryErrors=@(); $rowsEvidence=@()
    $coverageLimit=[double]$Thresholds.requirements.timestampCoverage
    $alignmentCoverageLimit=[double]$Thresholds.requirements.timestampAlignmentCoverage
    $medianLimit=[double]$Thresholds.requirements.timestampMedianBoundaryErrorMs
    $p95Limit=[double]$Thresholds.requirements.timestampP95BoundaryErrorMs
    foreach ($backend in @('cuda','vulkan')) {
        foreach ($fixture in @('jfk-smoke','clean-keyterms','ugly-dialogue')) {
            $rows=@($State.metrics | Where-Object { $_.backend -eq $backend -and $_.fixture -eq $fixture })
            if ($rows.Count -ne 1) { $missing += "$backend/$fixture expected one timestamp measurement, found $($rows.Count)"; continue }
            $row=$rows[0]; $runFailure=Get-RunFailure $row.run
            if ($runFailure) { $failures += "$backend/$fixture $runFailure"; continue }
            $measurement=$row.measurement
            if ($null -eq $measurement) { $failures += "$backend/$fixture transcript timing schema is absent"; continue }
            if (-not $measurement.schemaValid) { $failures += "$backend/$fixture transcript timing schema is invalid: $(@($measurement.schemaErrors) -join ', ')"; continue }
            $coverage=[double]$measurement.timestampCoverage
            if ($coverage -lt $coverageLimit) { $failures += "$backend/$fixture output timestamp validity $coverage is below timestampCoverage $coverageLimit" }
            if ([int]$measurement.invalidIntervals -ne 0) { $failures += "$backend/$fixture has $($measurement.invalidIntervals) invalid intervals" }
            $alignment=$null
            if ($fixture -ne 'jfk-smoke') {
                if (-not (Test-ObjectProperty $measurement 'timestampAlignment') -or $null -eq $measurement.timestampAlignment -or [int]$measurement.timestampAlignment.expected -le 0) {
                    $failures += "$backend/$fixture has no normalized bookmark alignment"
                } else {
                    $alignment=$measurement.timestampAlignment
                    $alignmentCoverage=[double]$alignment.alignmentCoverage
                    $errors=@($alignment.startErrorsMs)
                    $records=@($alignment.matches)
                    if ([int]$alignment.matched -ne $errors.Count -or [int]$alignment.matched -ne $records.Count) {
                        $failures += "$backend/$fixture alignment detail is inconsistent: matched=$($alignment.matched), errors=$($errors.Count), records=$($records.Count)"
                    }
                    if ([int]$alignment.matched -gt [int]$alignment.expected) { $failures += "$backend/$fixture matched count exceeds expected count" }
                    if ($alignmentCoverage -lt $alignmentCoverageLimit) { $failures += "$backend/$fixture bookmark alignment coverage $([math]::Round($alignmentCoverage,6)) is below timestampAlignmentCoverage $alignmentCoverageLimit" }
                    if ($null -eq $alignment.medianStartBoundaryErrorMs) { $failures += "$backend/$fixture median aligned start-boundary error is absent" }
                    elseif ([double]$alignment.medianStartBoundaryErrorMs -gt $medianLimit) { $failures += "$backend/$fixture median aligned start-boundary error $($alignment.medianStartBoundaryErrorMs) ms exceeds timestampMedianBoundaryErrorMs $medianLimit ms" }
                    if ($null -eq $alignment.p95StartBoundaryErrorMs) { $failures += "$backend/$fixture p95 aligned start-boundary error is absent" }
                    elseif ([double]$alignment.p95StartBoundaryErrorMs -gt $p95Limit) { $failures += "$backend/$fixture p95 aligned start-boundary error $($alignment.p95StartBoundaryErrorMs) ms exceeds timestampP95BoundaryErrorMs $p95Limit ms" }
                    $boundaryErrors += @($errors | ForEach-Object { [double]$_ })
                }
            }
            $rowsEvidence += [ordered]@{
                backend=$backend
                fixture=$fixture
                timingBasis=$(if ($fixture -eq 'jfk-smoke') { 'output-schema-only' } else { 'fixture-bookmarks' })
                outputTimestampValidity=[ordered]@{ value=$coverage; threshold=$coverageLimit; pass=($coverage -ge $coverageLimit) }
                invalidIntervals=[int]$measurement.invalidIntervals
                alignmentCoverage=$(if ($alignment) { [ordered]@{ value=[double]$alignment.alignmentCoverage; threshold=$alignmentCoverageLimit; pass=([double]$alignment.alignmentCoverage -ge $alignmentCoverageLimit) } } else { $null })
                boundaryMatches=$(if ($alignment) { $alignment.matched } else { $null })
                medianStartBoundaryErrorMs=$(if ($alignment) { [ordered]@{ value=$alignment.medianStartBoundaryErrorMs; threshold=$medianLimit; pass=($null -ne $alignment.medianStartBoundaryErrorMs -and [double]$alignment.medianStartBoundaryErrorMs -le $medianLimit) } } else { $null })
                p95StartBoundaryErrorMs=$(if ($alignment) { [ordered]@{ value=$alignment.p95StartBoundaryErrorMs; threshold=$p95Limit; pass=($null -ne $alignment.p95StartBoundaryErrorMs -and [double]$alignment.p95StartBoundaryErrorMs -le $p95Limit) } } else { $null })
            }
        }
    }
    $median=Get-PercentileValue ([double[]]$boundaryErrors) 0.5
    $p95=Get-PercentileValue ([double[]]$boundaryErrors) 0.95
    $evidence=[ordered]@{
        thresholds=[ordered]@{ timestampCoverage=$coverageLimit; timestampAlignmentCoverage=$alignmentCoverageLimit; timestampMedianBoundaryErrorMs=$medianLimit; timestampP95BoundaryErrorMs=$p95Limit }
        measurements=$rowsEvidence
        pooled=[ordered]@{
            alignedBoundaryCount=$boundaryErrors.Count
            medianStartBoundaryErrorMs=$(if($null -ne $median){[math]::Round($median,3)}else{$null})
            p95StartBoundaryErrorMs=$(if($null -ne $p95){[math]::Round($p95,3)}else{$null})
        }
    }
    if ($prerequisites.Count) { return New-GateResult 'NOT_RUN' @("Timestamp matrix was incomplete because prerequisites prevented measurement: $($prerequisites -join ', ')") $evidence }
    if ($missing.Count) { $failures += $missing }
    if ($failures.Count) { return New-GateResult 'FAIL' $failures $evidence }
    return New-GateResult 'PASS' @("All per-backend/fixture timestamp checks passed; pooled median/p95 aligned start-boundary errors were $([math]::Round($median,3))/$([math]::Round($p95,3)) ms") $evidence
}

function Get-DeterminismWordIssues($Words) {
    $issues=@()
    if (-not (Test-JsonArray $Words)) { return @('document.words must be an array') }
    $wordList=@($Words)
    if ($wordList.Count -eq 0) { return @('word list is empty') }
    $previousStart=-1.0
    for ($index=0; $index -lt $wordList.Count; $index++) {
        $word=$wordList[$index]
        if (-not (Test-StructuredObject $word)) { $issues += "word $index must be an object"; continue }
        $missingFields=@(@('word','start','end','confidence') | Where-Object { -not (Test-ObjectProperty $word $_) })
        if ($missingFields.Count) { $issues += "word $index is missing $($missingFields -join ', ')"; continue }
        if ($word.word -isnot [string] -or -not (Get-NormalizedGateWord $word.word)) { $issues += "word $index word must be a non-empty string" }
        if (-not (Test-FiniteNumber $word.start)) { $issues += "word $index start must be a finite number"; continue }
        if (-not (Test-FiniteNumber $word.end)) { $issues += "word $index end must be a finite number"; continue }
        if (-not (Test-FiniteNumber $word.confidence) -or [double]$word.confidence -lt 0 -or [double]$word.confidence -gt 1) { $issues += "word $index confidence must be a finite number from 0 through 1" }
        $start=[double]$word.start
        $end=[double]$word.end
        if ($start -lt 0 -or $end -le $start) { $issues += "word $index has an invalid interval" }
        if ($start -lt $previousStart) { $issues += "word $index starts before its predecessor" }
        $previousStart=$start
    }
    return $issues
}

function Measure-Determinism($Runs) {
    $allRuns=@($Runs)
    $successfulRuns=0
    $validEntries=@()
    $runSummaries=@()
    for ($index=0; $index -lt $allRuns.Count; $index++) {
        $run=$allRuns[$index]
        $issues=@()
        $runFailure=Get-RunFailure $run
        if ($runFailure) {
            $issues += $runFailure
        } else {
            $successfulRuns++
            if ($null -eq $run.document -or -not (Test-ObjectProperty $run.document 'words')) {
                $issues += 'document.words is absent'
            } else {
                $issues += @(Get-DeterminismWordIssues $run.document.words)
            }
            if ((Test-ObjectProperty $run 'validation') -and $null -ne $run.validation -and -not $run.validation.schemaValid) {
                $issues += @($run.validation.schemaErrors | ForEach-Object { "transcript schema: $_" })
            }
        }
        $words=@()
        if ($null -ne $run.document -and (Test-ObjectProperty $run.document 'words') -and (Test-JsonArray $run.document.words)) { $words=@($run.document.words) }
        $normalizedWords=@($words | Where-Object { (Test-StructuredObject $_) -and (Test-ObjectProperty $_ 'word') -and $_.word -is [string] } | ForEach-Object { Get-NormalizedGateWord $_.word })
        $summary=[ordered]@{
            run=$index+1
            valid=($issues.Count -eq 0)
            issues=$issues
            sourcePath=$(if (Test-ObjectProperty $run 'evidencePath') { $run.evidencePath } else { $null })
            wordCount=$words.Count
            normalizedText=($normalizedWords -join ' ')
        }
        $runSummaries += $summary
        if ($issues.Count -eq 0) { $validEntries += [ordered]@{ run=$index+1; value=$run } }
    }
    $pairs=@()
    $maxBoundaryDelta=$null
    $maxSequenceDelta=0
    for ($left=0; $left -lt $validEntries.Count; $left++) {
        for ($right=$left+1; $right -lt $validEntries.Count; $right++) {
            $leftWords=@($validEntries[$left].value.document.words)
            $rightWords=@($validEntries[$right].value.document.words)
            $alignment=Measure-NormalizedWordAlignment $leftWords $rightWords
            $boundaryRows=@()
            $pairMaximum=$null
            foreach ($match in @($alignment.matches)) {
                $leftWord=$leftWords[[int]$match.referenceIndex]
                $rightWord=$rightWords[[int]$match.hypothesisIndex]
                $startDelta=[math]::Abs(([double]$rightWord.start-[double]$leftWord.start)*1000.0)
                $endDelta=[math]::Abs(([double]$rightWord.end-[double]$leftWord.end)*1000.0)
                $wordMaximum=[math]::Max($startDelta,$endDelta)
                if ($null -eq $pairMaximum -or $wordMaximum -gt $pairMaximum) { $pairMaximum=$wordMaximum }
                if ($null -eq $maxBoundaryDelta -or $wordMaximum -gt $maxBoundaryDelta) { $maxBoundaryDelta=$wordMaximum }
                $boundaryRows += [ordered]@{
                    leftWordIndex=[int]$match.referenceIndex
                    rightWordIndex=[int]$match.hypothesisIndex
                    word=$match.normalizedWord
                    startDeltaMs=[math]::Round($startDelta,3)
                    endDeltaMs=[math]::Round($endDelta,3)
                    maxBoundaryDeltaMs=[math]::Round($wordMaximum,3)
                }
            }
            $maxSequenceDelta=[math]::Max($maxSequenceDelta,[int]$alignment.sequenceDeltaWords)
            $pairs += [ordered]@{
                leftRun=$validEntries[$left].run
                rightRun=$validEntries[$right].run
                identicalNormalizedText=($alignment.sequenceDeltaWords -eq 0 -and $alignment.referenceWords -eq $alignment.hypothesisWords)
                leftWordCount=$alignment.referenceWords
                rightWordCount=$alignment.hypothesisWords
                matchedWords=$alignment.matchedWords
                missingWords=@($alignment.missing)
                unexpectedWords=@($alignment.unexpected)
                sequenceDeltaWords=$alignment.sequenceDeltaWords
                comparedBoundaries=($boundaryRows.Count*2)
                maxBoundaryDeltaMs=$(if ($null -ne $pairMaximum) { [math]::Round($pairMaximum,3) } else { $null })
                boundaryDeltas=$boundaryRows
            }
        }
    }
    $identical=($validEntries.Count -eq 3 -and $pairs.Count -eq 3 -and @($pairs | Where-Object { -not $_.identicalNormalizedText }).Count -eq 0)
    return [ordered]@{
        runs=$allRuns.Count
        successfulRuns=$successfulRuns
        validRuns=$validEntries.Count
        pairComparisons=$pairs.Count
        identicalText=$identical
        maxSequenceDeltaWords=$maxSequenceDelta
        maxBoundaryDeltaMs=$(if ($null -ne $maxBoundaryDelta) { [math]::Round($maxBoundaryDelta,3) } else { $null })
        runSummaries=$runSummaries
        pairs=$pairs
    }
}

function Get-DeterminismGate($State, $Thresholds) {
    $prerequisites=@(Get-GpuPrerequisiteIssues $State); $failures=@(); $evidence=@()
    $textLimit=[int]$Thresholds.requirements.determinismTextDeltaWords
    $boundaryLimit=[double]$Thresholds.requirements.determinismBoundaryDeltaMs
    foreach($backend in @('cuda','vulkan')) {
        $entry=$State.backends[$backend]
        if ($null -eq $entry -or -not (Test-ObjectProperty $entry 'determinism')) { $failures += "$backend determinism measurement is absent"; continue }
        $measurement=$entry.determinism
        $evidence += [ordered]@{
            backend=$backend
            textDelta=[ordered]@{ value=$measurement.maxSequenceDeltaWords; threshold=$textLimit; pass=([int]$measurement.maxSequenceDeltaWords -le $textLimit) }
            boundaryDeltaMs=[ordered]@{ value=$measurement.maxBoundaryDeltaMs; threshold=$boundaryLimit; pass=($null -ne $measurement.maxBoundaryDeltaMs -and [double]$measurement.maxBoundaryDeltaMs -le $boundaryLimit) }
            measurement=$measurement
        }
        if ($measurement.runs -ne 3 -or $measurement.successfulRuns -ne 3 -or $measurement.validRuns -ne 3) { $failures += "$backend completed $($measurement.successfulRuns) successful and $($measurement.validRuns) valid runs from $($measurement.runs) attempts; exactly 3 are required" }
        if (-not $measurement.identicalText -or [int]$measurement.maxSequenceDeltaWords -gt $textLimit) { $failures += "$backend maximum normalized word-sequence delta $($measurement.maxSequenceDeltaWords) exceeds determinismTextDeltaWords $textLimit" }
        if ($measurement.pairComparisons -ne 3) { $failures += "$backend produced $($measurement.pairComparisons) of 3 pairwise timestamp comparisons" }
        if ($null -eq $measurement.maxBoundaryDeltaMs) { $failures += "$backend aligned boundary delta is absent" }
        elseif ([double]$measurement.maxBoundaryDeltaMs -gt $boundaryLimit) { $failures += "$backend maximum boundary delta $($measurement.maxBoundaryDeltaMs) ms exceeds determinismBoundaryDeltaMs $boundaryLimit ms" }
    }
    if ($prerequisites.Count) { return New-GateResult 'NOT_RUN' @("Determinism measurement lacked GPU prerequisites: $($prerequisites -join ', ')") $evidence }
    if ($failures.Count) { return New-GateResult 'FAIL' $failures $evidence }
    return New-GateResult 'PASS' @("Both GPU backends completed three identical runs within $boundaryLimit ms") $evidence
}

function Get-GpuProofGate($State, $Thresholds) {
    $prerequisites=@(Get-GpuPrerequisiteIssues $State); $failures=@(); $evidence=@()
    $requiredIncrease=[double]$Thresholds.requirements.gpuAllocationIncreaseMiB
    $selectedGpu=$(if((Test-ObjectProperty $State 'preflight') -and $null-ne$State.preflight -and (Test-ObjectProperty $State.preflight 'selectedGpu')){$State.preflight.selectedGpu}else{$null})
    if($null-eq$selectedGpu){$prerequisites += 'selected preflight GPU identity'}
    foreach($backend in @('cuda','vulkan')) {
        $entry=$State.backends[$backend]
        $proof=$(if($null -ne $entry -and (Test-ObjectProperty $entry 'gpuProof')){$entry.gpuProof}else{$null})
        $evidence += [ordered]@{ backend=$backend; proof=$proof; thresholdMiB=$requiredIncrease }
        if($null -eq $proof){$failures += "$backend exact GPU execution proof is absent";continue}
        if(-not (Test-ObjectProperty $proof 'backend') -or $proof.backend -ne $backend){$failures += "$backend GPU proof backend identity is absent or wrong"}
        if(-not (Test-ObjectProperty $proof 'expectedDevice') -or $proof.expectedDevice -ne "${backend}:0"){$failures += "$backend GPU proof does not target ${backend}:0"}
        if(-not (Test-ObjectProperty $proof 'doctor') -or $null -eq $proof.doctor){
            $failures += "$backend GPU proof lacks pinned doctor backend/device evidence"
        } else {
            $doctor=$proof.doctor
            $expectedFeature="backend_$backend"
            if(-not (Test-ObjectProperty $doctor 'pass') -or -not $doctor.pass){$failures += "$backend GPU proof lacks a passing pinned doctor backend/device validation"}
            if(-not (Test-ObjectProperty $doctor 'expectedFeature') -or $doctor.expectedFeature -ne $expectedFeature -or -not (Test-ObjectProperty $doctor 'observedFeature') -or $doctor.observedFeature -isnot [bool] -or -not $doctor.observedFeature){$failures += "$backend GPU proof does not establish features.$expectedFeature=true"}
            if(-not (Test-ObjectProperty $doctor 'compiledFeatures') -or $null -eq $doctor.compiledFeatures){
                $failures += "$backend GPU proof lacks the pinned compiled backend fields"
            } else {
                foreach($feature in @('backend_cuda','backend_metal','backend_vulkan')){if(-not (Test-ObjectProperty $doctor.compiledFeatures $feature) -or $doctor.compiledFeatures.$feature -isnot [bool]){$failures += "$backend GPU proof compiled feature $feature is absent or non-boolean"}}
                foreach($feature in @('backend_cuda','backend_metal','backend_vulkan') | Where-Object { $_ -ne $expectedFeature }){if((Test-ObjectProperty $doctor.compiledFeatures $feature) -and $doctor.compiledFeatures.$feature -eq $true){$failures += "$backend GPU proof unexpectedly enables $feature"}}
            }
            foreach($field in @('acceleratorCompiled','acceleratorAvailable','driverRuntimeCompatible')){if(-not (Test-ObjectProperty $doctor $field) -or $doctor.$field -isnot [bool] -or -not $doctor.$field){$failures += "$backend GPU proof does not establish doctor.$field=true"}}
            if(-not (Test-ObjectProperty $doctor 'expectedDevice') -or $doctor.expectedDevice -ne "${backend}:0"){$failures += "$backend doctor proof does not target ${backend}:0"}
            if(-not (Test-ObjectProperty $doctor 'expectedGpuDescription') -or $doctor.expectedGpuDescription -ne 'NVIDIA GeForce GTX 1080'){$failures += "$backend doctor proof is not bound to the observed NVIDIA GeForce GTX 1080"}
            if(-not (Test-ObjectProperty $doctor 'selectedDevice') -or $null -eq $doctor.selectedDevice){
                $failures += "$backend doctor proof lacks the selected GPU device fields"
            } else {
                $selected=$doctor.selectedDevice
                foreach($field in @('index','name','description','type','memory_free','memory_total','async','events')){if(-not (Test-ObjectProperty $selected $field)){$failures += "$backend doctor proof selected device is missing $field"}}
                $expectedName="${backend}0"
                if((Test-ObjectProperty $selected 'index') -and [int]$selected.index -ne 0){$failures += "$backend doctor proof selected device index is not 0"}
                if((Test-ObjectProperty $selected 'name') -and ([string]$selected.name).ToLowerInvariant().Replace(':','').Replace('-','').Replace('_','') -ne $expectedName){$failures += "$backend doctor proof selected device is not ${backend}:0"}
                if((Test-ObjectProperty $selected 'type') -and $selected.type -ne 'gpu'){$failures += "$backend doctor proof selected device type is not gpu"}
                if((Test-ObjectProperty $selected 'description') -and ([string]$selected.description).IndexOf('NVIDIA GeForce GTX 1080',[StringComparison]::OrdinalIgnoreCase) -lt 0){$failures += "$backend doctor proof selected device is not the observed NVIDIA GeForce GTX 1080"}
            }
        }
        if(-not (Test-ObjectProperty $proof 'inference') -or $null -eq $proof.inference){$failures += "$backend GPU proof lacks JFK inference allocation evidence";continue}
        $inference=$proof.inference
        if(-not (Test-ObjectProperty $inference 'fixture') -or $inference.fixture -ne 'jfk-smoke'){$failures += "$backend GPU proof allocation is not from jfk-smoke"}
        if(-not (Test-ObjectProperty $inference 'device') -or $inference.device -ne "${backend}:0"){$failures += "$backend GPU proof JFK inference did not use ${backend}:0"}
        foreach($field in @('selectedGpuIndex','selectedGpuUuid','allocationEvidenceSource','allocationIncreaseMiB','thresholdMiB','networkObservationAvailable','unexpectedNetworkConnectionCount')){if(-not (Test-ObjectProperty $inference $field) -or $null -eq $inference.$field){$failures += "$backend GPU proof inference is missing $field"}}
        $selectedIdentityMismatch=$false
        if($null-ne$selectedGpu){
            if((Test-ObjectProperty $inference 'selectedGpuIndex') -and ([int]$inference.selectedGpuIndex -ne [int]$selectedGpu.index)){$selectedIdentityMismatch=$true}
            if((Test-ObjectProperty $inference 'selectedGpuUuid') -and ([string]$inference.selectedGpuUuid -ne [string]$selectedGpu.uuid)){$selectedIdentityMismatch=$true}
        }
        if($selectedIdentityMismatch){$failures += "$backend GPU proof allocation is not bound to the preflight-selected GTX 1080 index/UUID"}
        if((Test-ObjectProperty $inference 'networkObservationAvailable') -and -not $inference.networkObservationAvailable){$failures += "$backend GPU proof lacks descendant network observation"}
        if((Test-ObjectProperty $inference 'unexpectedNetworkConnectionCount') -and [int]$inference.unexpectedNetworkConnectionCount -ne 0){$failures += "$backend GPU proof observed unexpected descendant TCP traffic"}
        if(-not (Test-ObjectProperty $inference 'allocationIncreaseMiB') -or $null -eq $inference.allocationIncreaseMiB){
            $failures += "$backend GPU proof lacks selected-device or owned-process allocation evidence"
        } else {
            $increase=[double]$inference.allocationIncreaseMiB
            if($increase -lt $requiredIncrease){$failures += "$backend JFK GTX 1080 allocation increase $increase MiB is below gpuAllocationIncreaseMiB $requiredIncrease MiB"}
            if(-not (Test-ObjectProperty $inference 'thresholdMiB') -or [double]$inference.thresholdMiB -ne $requiredIncrease){$failures += "$backend GPU proof persisted threshold is absent or inconsistent"}
            if((Test-ObjectProperty $inference 'gpuPerProcessSupported') -and $inference.gpuPerProcessSupported -and $inference.allocationEvidenceSource -ne 'owned-process-gpu-memory'){$failures += "$backend GPU proof ignored supported NVIDIA per-process memory evidence"}
        }
        if(-not (Test-ObjectProperty $inference 'pass') -or -not $inference.pass -or -not (Test-ObjectProperty $proof 'pass') -or -not $proof.pass){$failures += "$backend exact GPU execution proof did not pass"}
    }
    if($prerequisites.Count){return New-GateResult 'NOT_RUN' @("GPU allocation proof lacked prerequisites: $($prerequisites -join ', ')") $evidence}
    if($failures.Count){return New-GateResult 'FAIL' $failures $evidence}
    return New-GateResult 'PASS' @("Both GPU backends proved their pinned doctor backend/device and selected-GTX-1080 JFK allocation increase of at least $requiredIncrease MiB without descendant TCP traffic") $evidence
}

function Get-PrivacyObservationGate($Commands) {
    $expectedRuns=@($Commands | Where-Object { $_.label -like 'transcribe-*' -or $_.label -like 'bench-cuda-*' -or $_.label -like 'bench-vulkan-*' })
    if($expectedRuns.Count -eq 0){return New-GateResult 'NOT_RUN' @('No transcribe/bench runs are available for privacy proof.') @()}
    $failures=@()
    foreach($run in $expectedRuns){
        if(-not (Test-ObjectProperty $run 'observed') -or -not $run.observed){$failures += "$($run.label) was not resource/privacy observed"}
        if(-not (Test-ObjectProperty $run 'runnerSucceeded') -or -not $run.runnerSucceeded){$failures += "$($run.label) observed runner evidence is incomplete"}
        if(-not (Test-ObjectProperty $run 'ownershipTrackingAvailable') -or -not $run.ownershipTrackingAvailable -or ((Test-ObjectProperty $run 'ownershipErrors') -and @($run.ownershipErrors).Count -gt 0)){$failures += "$($run.label) lacks error-free recursive process ownership observation"}
        if(-not (Test-ObjectProperty $run 'networkSampleAttemptCount') -or [int]$run.networkSampleAttemptCount -le 0 -or -not (Test-ObjectProperty $run 'networkSampleSuccessCount') -or [int]$run.networkSampleSuccessCount -ne [int]$run.networkSampleAttemptCount){$failures += "$($run.label) lacks complete descendant TCP samples"}
        if(-not (Test-ObjectProperty $run 'networkObservationAvailable') -or -not $run.networkObservationAvailable){$failures += "$($run.label) lacks descendant TCP observation"}
        if(-not (Test-ObjectProperty $run 'unexpectedNetworkConnectionCount') -or $null -eq $run.unexpectedNetworkConnectionCount){$failures += "$($run.label) lacks an unexpected-traffic count"}
        elseif([int]$run.unexpectedNetworkConnectionCount -ne 0){$failures += "$($run.label) observed $($run.unexpectedNetworkConnectionCount) unexpected descendant TCP connections"}
        if((Test-ObjectProperty $run 'samplingErrors') -and @($run.samplingErrors).Count -gt 0){$failures += "$($run.label) resource/privacy sampling reported errors"}
    }
    if($failures.Count){return New-GateResult 'FAIL' $failures $expectedRuns}
    return New-GateResult 'PASS' @("All $($expectedRuns.Count) observed transcribe/bench process trees had complete descendant TCP observation and zero unexpected traffic.") $expectedRuns
}

function Measure-GateWordError($ReferenceWords, $HypothesisWords) {
    $reference = @($ReferenceWords | ForEach-Object { Get-NormalizedGateWord ([string]$_) } | Where-Object { $_ })
    $hypothesis = @($HypothesisWords | ForEach-Object { Get-NormalizedGateWord ([string]$_) } | Where-Object { $_ })
    $previous = New-Object int[] ($hypothesis.Count + 1)
    $current = New-Object int[] ($hypothesis.Count + 1)
    for ($column=0; $column -le $hypothesis.Count; $column++) { $previous[$column]=$column }
    for ($row=1; $row -le $reference.Count; $row++) {
        $current[0]=$row
        for ($column=1; $column -le $hypothesis.Count; $column++) {
            $cost = if ($reference[$row-1] -eq $hypothesis[$column-1]) { 0 } else { 1 }
            $current[$column]=[math]::Min([math]::Min($current[$column-1]+1,$previous[$column]+1),$previous[$column-1]+$cost)
        }
        $swap=$previous; $previous=$current; $current=$swap
    }
    $errors=$previous[$hypothesis.Count]
    return [ordered]@{ wer=$(if($reference.Count){[math]::Round($errors/[double]$reference.Count,6)}else{$null}); wordErrors=$errors; referenceWordCount=$reference.Count; hypothesisWordCount=$hypothesis.Count }
}

function Measure-LongForm($Document, $Fixture) {
    $expectedPositions = if (Test-ObjectProperty $Fixture 'sentinelPositions') { @($Fixture.sentinelPositions | ForEach-Object { [double]$_.seconds }) } else { @($Fixture.expectedSentinelTimes | ForEach-Object { [double]$_ }) }
    if ($null -eq $Document -or -not (Test-ObjectProperty $Document 'words')) {
        return [ordered]@{ schemaValid=$false; wer=$null; quartileWer=@($null,$null,$null,$null); timestampCoverage=0; invalidIntervals=1; expectedSentinels=$expectedPositions.Count; recognizedSentinels=0; matchedSentinels=0; sentinelMatches=@(); expectedJoins=$(if(Test-ObjectProperty $Fixture 'joins'){@($Fixture.joins).Count}else{0}); quartileP95DriftMs=@($null,$null,$null,$null); maxQuartileP95DriftMs=$null; complete=$false }
    }
    $recognized = @()
    $validWords = @()
    $invalidIntervals = 0
    $previousStart = -1.0
    foreach ($word in @($Document.words)) {
        $fields = @(@('word','start','end') | Where-Object { -not $word.psobject.Properties.Name.Contains($_) })
        if ($fields.Count -or [double]$word.start -lt 0 -or [double]$word.end -le [double]$word.start -or [double]$word.end -gt [double]$Fixture.duration -or [double]$word.start -lt $previousStart) {
            $invalidIntervals++
            if ($fields.Count) { continue }
        }
        $normalized = Get-NormalizedGateWord ([string]$word.word)
        if ($normalized) { $recognized += [ordered]@{ normalizedWord=$normalized; start=[double]$word.start }; $validWords += $word }
        $previousStart = [double]$word.start
    }
    $sentinelText = if (Test-ObjectProperty $Fixture 'sentinel') { [string]$Fixture.sentinel } else { 'production transcript' }
    $sentinelWords = @((($sentinelText) -split '\s+') | ForEach-Object { Get-NormalizedGateWord $_ } | Where-Object { $_ })
    if ($sentinelWords.Count -ne 2) { $sentinelWords=@('production','transcript') }
    $recognizedSentinels = @()
    for ($index=0; $index -lt $recognized.Count-1; $index++) {
        if ($recognized[$index].normalizedWord -eq $sentinelWords[0] -and $recognized[$index+1].normalizedWord -eq $sentinelWords[1]) { $recognizedSentinels += [double]$recognized[$index].start }
    }
    $quartileDrifts = New-Object object[] 4
    for ($quartile=0; $quartile -lt 4; $quartile++) { $quartileDrifts[$quartile] = @() }
    $sentinelMatches=@()
    $matchedCount=[math]::Min($expectedPositions.Count,$recognizedSentinels.Count)
    for ($index=0; $index -lt $matchedCount; $index++) {
        $expectedTime=[double]$expectedPositions[$index]
        $actualTime=[double]$recognizedSentinels[$index]
        $drift=[math]::Abs($actualTime-$expectedTime)*1000.0
        $quartile=[math]::Min(3,[math]::Floor(($expectedTime/[double]$Fixture.duration)*4))
        $quartileDrifts[$quartile]=@($quartileDrifts[$quartile])+$drift
        $sentinelMatches += [ordered]@{ index=$index; expectedStartSeconds=[math]::Round($expectedTime,6); actualStartSeconds=[math]::Round($actualTime,6); driftMs=[math]::Round($drift,3); quartile=$quartile }
    }
    $p95 = New-Object object[] 4
    for ($quartile=0; $quartile -lt 4; $quartile++) { $p95[$quartile] = Get-PercentileValue ([double[]]$quartileDrifts[$quartile]) 0.95 }
    $numericP95 = @($p95 | Where-Object { $null -ne $_ })
    $referenceBookmarks = if (Test-ObjectProperty $Fixture 'bookmarks') { @($Fixture.bookmarks) } else { @() }
    $globalAlignment=Measure-NormalizedWordAlignment $referenceBookmarks $validWords
    $matchedReference=New-Object 'Collections.Generic.HashSet[int]'
    foreach($pair in @($globalAlignment.matches)){[void]$matchedReference.Add([int]$pair.referenceIndex)}
    $joinChecks=@();$droppedJoinWords=0;$duplicatedJoinWords=0
    foreach($join in $(if(Test-ObjectProperty $Fixture 'joins'){@($Fixture.joins)}else{@()})){
        $missing=@();foreach($referenceIndex in @($join.referenceIndexes)){if(-not $matchedReference.Contains([int]$referenceIndex)){$missing += [string]$referenceBookmarks[[int]$referenceIndex].word}}
        $duplicates=@();foreach($unexpected in @($globalAlignment.unexpected)){$word=$validWords[[int]$unexpected.hypothesisIndex];if([math]::Abs([double]$word.start-[double]$join.seconds) -le 2.0){$duplicates += [string]$word.word}}
        $droppedJoinWords += $missing.Count;$duplicatedJoinWords += $duplicates.Count
        $joinChecks += [ordered]@{ index=$join.index; seconds=$join.seconds; expectedWords=@($join.expectedWords); missing=$missing; duplicated=$duplicates; clean=($missing.Count -eq 0 -and $duplicates.Count -eq 0) }
    }
    $wer = Measure-GateWordError -ReferenceWords @($referenceBookmarks | ForEach-Object { $_.word }) -HypothesisWords @($validWords | ForEach-Object { $_.word })
    $quartileWer = New-Object object[] 4
    for ($quartile=0; $quartile -lt 4; $quartile++) {
        $lower=([double]$Fixture.duration/4.0)*$quartile; $upper=([double]$Fixture.duration/4.0)*($quartile+1)
        $referenceQuartile=@($referenceBookmarks | Where-Object { [double]$_.seconds -ge $lower -and [double]$_.seconds -lt $upper } | ForEach-Object { $_.word })
        $hypothesisQuartile=@($validWords | Where-Object { [double]$_.start -ge $lower -and [double]$_.start -lt $upper } | ForEach-Object { $_.word })
        $quartileWer[$quartile]=(Measure-GateWordError -ReferenceWords $referenceQuartile -HypothesisWords $hypothesisQuartile).wer
    }
    $totalDocumentWords = @($Document.words).Count
    return [ordered]@{
        schemaValid=($invalidIntervals -eq 0)
        wer=$wer.wer
        wordErrors=$wer.wordErrors
        referenceWordCount=$wer.referenceWordCount
        quartileWer=$quartileWer
        timestampCoverage=$(if ($totalDocumentWords) { [math]::Round(($totalDocumentWords-$invalidIntervals)/[double]$totalDocumentWords,6) } else { 0 })
        invalidIntervals=$invalidIntervals
        expectedSentinels=$expectedPositions.Count
        recognizedSentinels=$recognizedSentinels.Count
        matchedSentinels=$matchedCount
        sentinelMatches=$sentinelMatches
        missingSentinels=[math]::Max(0,$expectedPositions.Count-$recognizedSentinels.Count)
        unexpectedSentinels=[math]::Max(0,$recognizedSentinels.Count-$expectedPositions.Count)
        expectedJoins=$(if(Test-ObjectProperty $Fixture 'joins'){@($Fixture.joins).Count}else{0})
        measuredJoins=$joinChecks.Count
        cleanJoins=@($joinChecks|Where-Object{$_.clean}).Count
        droppedJoinWords=$droppedJoinWords
        duplicatedJoinWords=$duplicatedJoinWords
        joinChecks=$joinChecks
        quartileP95DriftMs=$p95
        maxQuartileP95DriftMs=$(if ($numericP95.Count) { [math]::Round(($numericP95 | Measure-Object -Maximum).Maximum, 3) } else { $null })
        complete=($expectedPositions.Count -gt 0 -and $recognizedSentinels.Count -eq $expectedPositions.Count -and $matchedCount -eq $expectedPositions.Count -and $numericP95.Count -eq 4 -and $joinChecks.Count -gt 0 -and $droppedJoinWords -eq 0 -and $duplicatedJoinWords -eq 0 -and $invalidIntervals -eq 0)
    }
}

function Get-LongFormGate($State, $Thresholds, [bool]$Skipped) {
    $prerequisites = @(Get-GpuPrerequisiteIssues $State)
    $rows = @($State.metrics | Where-Object { $_.fixture -eq 'long-stability' -and $_.backend -in @('cuda','vulkan') })
    $evidence = [ordered]@{ expectedMeasurements=2; actualMeasurements=$rows.Count; measurements=@($rows | ForEach-Object { [ordered]@{ backend=$_.backend; measurement=$_.measurement } }) }
    if ($Skipped) { return New-GateResult 'NOT_RUN' @('Long-form measurement was explicitly skipped by -SkipLongFixture.') $evidence }
    if ($prerequisites.Count) { return New-GateResult 'NOT_RUN' @("Long-form measurement did not have both GPU prerequisites: $($prerequisites -join ', ')") $evidence }
    if ($rows.Count -ne 2) { return New-GateResult 'FAIL' @("Expected two long-form measurements after prerequisites passed, found $($rows.Count)") $evidence }
    $failures=@(); $limit=[double]$Thresholds.requirements.longQuartileP95DriftMs; $maxDrift=0.0
    foreach($row in $rows) {
        $runFailure=Get-RunFailure $row.run
        if($runFailure){$failures += "$($row.backend) long-form $runFailure";continue}
        $measurement=$row.measurement
        if($null -eq $measurement){$failures += "$($row.backend) long-form measurement is absent";continue}
        if(-not $measurement.schemaValid){$failures += "$($row.backend) long-form transcript has $($measurement.invalidIntervals) invalid word intervals";continue}
        $joinFields=@(@('expectedJoins','measuredJoins','cleanJoins','droppedJoinWords','duplicatedJoinWords','joinChecks')|Where-Object{-not (Test-ObjectProperty $measurement $_)})
        if($joinFields.Count){$failures += "$($row.backend) long-form join measurement lacks: $($joinFields -join ', ')";continue}
        if([int]$measurement.expectedJoins -le 0 -or [int]$measurement.measuredJoins -ne [int]$measurement.expectedJoins -or [int]$measurement.cleanJoins -ne [int]$measurement.expectedJoins -or [int]$measurement.droppedJoinWords -ne 0 -or [int]$measurement.duplicatedJoinWords -ne 0 -or @($measurement.joinChecks).Count -ne [int]$measurement.expectedJoins){$failures += "$($row.backend) long-form joins are not clean: $($measurement.cleanJoins) of $($measurement.expectedJoins), dropped $($measurement.droppedJoinWords), duplicated $($measurement.duplicatedJoinWords)";continue}
        if(-not $measurement.complete){$failures += "$($row.backend) sentinel coverage is incomplete: recognized $($measurement.recognizedSentinels) of $($measurement.expectedSentinels), with $(@($measurement.quartileP95DriftMs|Where-Object{$null -ne $_}).Count) of 4 quartiles measured";continue}
        $maxDrift=[math]::Max($maxDrift,[double]$measurement.maxQuartileP95DriftMs)
        if([double]$measurement.maxQuartileP95DriftMs -gt $limit){$failures += "$($row.backend) maximum quartile p95 drift $($measurement.maxQuartileP95DriftMs) ms exceeds longQuartileP95DriftMs $limit ms"}
    }
    if($failures.Count){return New-GateResult 'FAIL' $failures $evidence}
    return New-GateResult 'PASS' @("Both GPU long-form runs completed with clean joins, full sentinel coverage, and maximum quartile p95 drift $maxDrift ms <= $limit ms") $evidence
}

function Get-BenchMeasurement($Run) {
    $failure = Get-RunFailure $Run
    if ($failure) { return [ordered]@{ valid=$false; reason=$failure } }
    $document = $null
    try { $document = $Run.stdout | ConvertFrom-Json } catch { return [ordered]@{ valid=$false; reason='bench stdout is not JSON' } }
    if ($null -eq $document.load_ms -or $null -eq $document.runs -or @($document.runs).Count -eq 0) { return [ordered]@{ valid=$false; reason='bench JSON lacks load_ms or runs' } }
    $warmRtfs = @()
    foreach ($benchRun in @($document.runs)) {
        if ($null -eq $benchRun.rtfx -or [double]$benchRun.rtfx -le 0) { return [ordered]@{ valid=$false; reason='bench run has invalid rtfx' } }
        $warmRtfs += 1.0 / [double]$benchRun.rtfx
    }
    return [ordered]@{ valid=$true; loadSeconds=([double]$document.load_ms/1000.0); warmRtfs=$warmRtfs; peakWorkingSetBytes=$Run.peakWorkingSetBytes; peakVramDeltaMiB=$(if ($null -ne $Run.peakSystemVramMiB -and $null -ne $Run.baselineSystemVramMiB) { [math]::Max(0,[double]$Run.peakSystemVramMiB-[double]$Run.baselineSystemVramMiB) } else { $null }) }
}

function Get-RuntimeGate($State, $Thresholds) {
    $requirements = $Thresholds.requirements
    $prerequisites = @(Get-GpuPrerequisiteIssues $State)
    $failures = @()
    $loads = @()
    $rtfs = @()
    $workingSets = @()
    $vramDeltas = @()
    $installedBytes = @()
    $benchEvidence = @()

    foreach ($backend in @('cuda','vulkan')) {
        $entry = $State.backends[$backend]
        if ($null -eq $entry) { continue }
        foreach ($mode in @('Offline','Stream')) {
            $property = "bench$mode"
            $bench = if (Test-ObjectProperty $entry $property) { Get-BenchMeasurement $entry.$property } else { [ordered]@{ valid=$false; reason='bench run evidence is absent' } }
            $benchEvidence += [ordered]@{ backend=$backend; mode=$mode.ToLowerInvariant(); valid=$bench.valid; reason=$(if ($bench.valid) { $null } else { $bench.reason }); loadSeconds=$(if ($bench.valid) { $bench.loadSeconds } else { $null }); warmRtfs=$(if ($bench.valid) { $bench.warmRtfs } else { @() }) }
            if (-not $bench.valid) { $failures += "$backend/$($mode.ToLowerInvariant()) $($bench.reason)"; continue }
            $loads += [double]$bench.loadSeconds
            $rtfs += @($bench.warmRtfs | ForEach-Object { [double]$_ })
            if ($null -ne $bench.peakWorkingSetBytes) { $workingSets += [double]$bench.peakWorkingSetBytes }
            if ($null -ne $bench.peakVramDeltaMiB) { $vramDeltas += [double]$bench.peakVramDeltaMiB }
        }
        if ((Test-ObjectProperty $entry 'runtimePlusModelBytes') -and $null -ne $entry.runtimePlusModelBytes) { $installedBytes += [double]$entry.runtimePlusModelBytes } else { $failures += "$backend runtime-plus-model installed size is absent" }
    }
    foreach ($row in @($State.metrics | Where-Object { $_.backend -in @('cuda','vulkan') -and $_.run.exitCode -eq 0 -and -not $_.run.timedOut })) {
        if ($null -ne $row.run.peakWorkingSetBytes) { $workingSets += [double]$row.run.peakWorkingSetBytes }
        if ($null -ne $row.run.peakVramMiB -and $null -ne $row.run.baselineVramMiB) { $vramDeltas += [math]::Max(0,[double]$row.run.peakVramMiB-[double]$row.run.baselineVramMiB) }
    }
    $medianRtf = Get-PercentileValue ([double[]]$rtfs) 0.5
    $maxLoad = if ($loads.Count) { ($loads | Measure-Object -Maximum).Maximum } else { $null }
    $maxWorkingSetGiB = if ($workingSets.Count) { [math]::Round((($workingSets | Measure-Object -Maximum).Maximum/1GB),6) } else { $null }
    $maxVramGiB = if ($vramDeltas.Count) { [math]::Round((($vramDeltas | Measure-Object -Maximum).Maximum/1024.0),6) } else { $null }
    $maxInstalledGiB = if ($installedBytes.Count) { [math]::Round((($installedBytes | Measure-Object -Maximum).Maximum/1GB),6) } else { $null }
    $evidence = [ordered]@{ benches=$benchEvidence; maxModelLoadSeconds=$maxLoad; modelLoadSecondsThreshold=[double]$requirements.modelLoadSeconds; medianWarmRtf=$medianRtf; medianWarmRtfThreshold=[double]$requirements.medianWarmRtf; peakWorkingSetGiB=$maxWorkingSetGiB; peakWorkingSetGiBThreshold=[double]$requirements.peakWorkingSetGiB; peakVramDeltaGiB=$maxVramGiB; peakVramGiBThreshold=[double]$requirements.peakVramGiB; runtimePlusModelGiB=$maxInstalledGiB; runtimePlusModelGiBThreshold=[double]$requirements.runtimePlusModelGiB }

    if ($prerequisites.Count) { return New-GateResult 'NOT_RUN' @("Runtime matrix was incomplete because prerequisites prevented measurement: $($prerequisites -join ', ')") $evidence }
    if ($loads.Count -ne 4 -or $rtfs.Count -eq 0 -or $workingSets.Count -eq 0 -or $vramDeltas.Count -eq 0 -or $installedBytes.Count -ne 2) { $failures += 'Runtime aggregate lacks one or more required load, warm RTF, working-set, VRAM, or installed-size measurements' }
    if ($null -ne $maxLoad -and $maxLoad -gt [double]$requirements.modelLoadSeconds) { $failures += "maximum model load $maxLoad s exceeds modelLoadSeconds $($requirements.modelLoadSeconds) s" }
    if ($null -ne $medianRtf -and $medianRtf -gt [double]$requirements.medianWarmRtf) { $failures += "median warm RTF $medianRtf exceeds medianWarmRtf $($requirements.medianWarmRtf)" }
    if ($null -ne $maxVramGiB -and $maxVramGiB -gt [double]$requirements.peakVramGiB) { $failures += "peak VRAM delta $maxVramGiB GiB exceeds peakVramGiB $($requirements.peakVramGiB) GiB" }
    if ($null -ne $maxWorkingSetGiB -and $maxWorkingSetGiB -gt [double]$requirements.peakWorkingSetGiB) { $failures += "peak working set $maxWorkingSetGiB GiB exceeds peakWorkingSetGiB $($requirements.peakWorkingSetGiB) GiB" }
    if ($null -ne $maxInstalledGiB -and $maxInstalledGiB -gt [double]$requirements.runtimePlusModelGiB) { $failures += "runtime plus model size $maxInstalledGiB GiB exceeds runtimePlusModelGiB $($requirements.runtimePlusModelGiB) GiB" }
    if ($failures.Count) { return New-GateResult 'FAIL' $failures $evidence }
    return New-GateResult 'PASS' @("All 4 benches and resource aggregates passed: max load $maxLoad s, median warm RTF $medianRtf, peak VRAM delta $maxVramGiB GiB, peak working set $maxWorkingSetGiB GiB, runtime plus model $maxInstalledGiB GiB") $evidence
}
