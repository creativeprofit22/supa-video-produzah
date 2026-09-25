[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][int]$OwnedPid,
    [Parameter(Mandatory = $true)][string]$ExpectedExecutable,
    [Parameter(Mandatory = $true)][string]$ExpectedCreationUtc,
    [ValidateRange(5, 4500)][int]$DurationSeconds = 3600
)
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$allowedRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "runs")) + [IO.Path]::DirectorySeparatorChar
$executable = [IO.Path]::GetFullPath($ExpectedExecutable)
if (-not $executable.StartsWith($allowedRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing non-isolated executable" }
$root = Get-CimInstance Win32_Process -Filter "ProcessId = $OwnedPid"
if ($null -eq $root -or $root.ExecutablePath -ine $executable -or $root.CreationDate.ToUniversalTime().ToString("o") -cne $ExpectedCreationUtc) { throw "Owned process identity mismatch" }
$known = @{}
$known[[string]$OwnedPid] = $ExpectedCreationUtc
$clock = [Diagnostics.Stopwatch]::StartNew()
for ($sample = 0; $sample -le [Math]::Floor($DurationSeconds / 5); $sample++) {
    $all = @(Get-CimInstance Win32_Process)
    $byId = @{}
    foreach ($process in $all) { $byId[[string]$process.ProcessId] = $process }
    $currentRoot = $byId[[string]$OwnedPid]
    $rootAlive = $null -ne $currentRoot -and $currentRoot.CreationDate.ToUniversalTime().ToString("o") -ceq $ExpectedCreationUtc
    # Expand only while parent creation identities match; reused PIDs never grant ownership.
    $changed = $true
    while ($changed -and $rootAlive) {
        $changed = $false
        foreach ($process in $all) {
            $key = [string]$process.ProcessId
            $parent = [string]$process.ParentProcessId
            if ($known.ContainsKey($key) -or -not $known.ContainsKey($parent)) { continue }
            $parentProcess = $byId[$parent]
            if ($null -ne $parentProcess -and $parentProcess.CreationDate.ToUniversalTime().ToString("o") -ceq $known[$parent] -and $process.CreationDate -ge $parentProcess.CreationDate) {
                $known[$key] = $process.CreationDate.ToUniversalTime().ToString("o")
                $changed = $true
            }
        }
    }
    $rows = @()
    foreach ($key in @($known.Keys)) {
        $process = $byId[$key]
        if ($null -eq $process -or $process.CreationDate.ToUniversalTime().ToString("o") -cne $known[$key]) { continue }
        $rows += [ordered]@{ pid = $process.ProcessId; creationUtc = $known[$key]; name = $process.Name; cpuSeconds = ([double]$process.KernelModeTime + [double]$process.UserModeTime) / 10000000; privateBytes = [double]$process.PrivatePageCount; workingSet = [double]$process.WorkingSetSize; handles = [int]$process.HandleCount }
    }
    [ordered]@{ sample = $sample; utc = [DateTime]::UtcNow.ToString("o"); seconds = $clock.Elapsed.TotalSeconds; rootAlive = $rootAlive; processCount = $rows.Count; processes = $rows } | ConvertTo-Json -Depth 5 -Compress
    if (-not $rootAlive) { break }
    if ($known.Count -gt 4096) { throw "Owned process identity cap exceeded" }
    $wait = ($sample + 1) * 5 - $clock.Elapsed.TotalSeconds
    if ($sample -lt [Math]::Floor($DurationSeconds / 5) -and $wait -gt 0) { Start-Sleep -Milliseconds ([int]($wait * 1000)) }
}
# Observation only: never terminate a process or manipulate the user's other applications.
