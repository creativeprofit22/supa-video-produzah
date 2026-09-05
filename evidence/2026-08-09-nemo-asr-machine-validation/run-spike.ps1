[CmdletBinding()]
param(
    [int]$BuildTimeoutSeconds = 3600,
    [int]$AcquisitionTimeoutSeconds = 1800,
    [switch]$SkipLongFixture,
    [switch]$ValidationTestOnly
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:EvidenceRoot = [IO.Path]::GetFullPath($PSScriptRoot)
$script:RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$script:RawRoot = Join-Path $script:EvidenceRoot 'raw'
$script:Lock = Get-Content -LiteralPath (Join-Path $script:EvidenceRoot 'provenance-lock.json') -Raw | ConvertFrom-Json
$script:Thresholds = Get-Content -LiteralPath (Join-Path $script:EvidenceRoot 'thresholds.json') -Raw | ConvertFrom-Json
. (Join-Path $script:EvidenceRoot 'gate-evaluation.ps1')
. (Join-Path $script:EvidenceRoot 'provenance-validation.ps1')
$script:Scratch = $null
$script:MarkerName = '.nemo-asr-spike-owner'
$script:RunId = [guid]::NewGuid().ToString('D')
$script:ProcessSequence = 0
$script:Commands = New-Object System.Collections.Generic.List[object]
$script:ResourceSamples = New-Object System.Collections.Generic.List[object]
$script:NetworkSamples = New-Object System.Collections.Generic.List[object]
$script:ProcessLifecycleSamples = New-Object System.Collections.Generic.List[object]
$script:Failures = New-Object System.Collections.Generic.List[string]
$script:Warnings = New-Object System.Collections.Generic.List[string]
$script:BackendResults = [ordered]@{}
$script:FixtureState = $null
$script:ModelState = $null
$script:SelectedGpu = $null
$script:BaselineVramMiB = $null
$script:InitialRepositoryStatus = $null
$script:StartedUtc = [DateTime]::UtcNow.ToString('o')
$script:StageNames = @('preflight','source','submodules','build','model','fixtures','transcription','measurement','cleanup','repository-isolation')
$script:MetricColumns = @('backend','fixture','exitCode','durationMs','schemaValid','schemaErrors','wer','keytermCount','keytermMatches','keytermRecall','timestampCoverage','invalidIntervals','timestampAlignmentCoverage','timestampMatchedWords','timestampMissingWords','timestampUnexpectedWords','timestampMedianStartBoundaryErrorMs','timestampP95StartBoundaryErrorMs','longQuartileWer','longExpectedJoins','longCleanJoins','longDroppedJoinWords','longDuplicatedJoinWords','longExpectedSentinels','longMatchedSentinels','longMaxQuartileP95DriftMs','runType','commandLabel','baselineWorkingSetBytes','peakWorkingSetBytes','workingSetIncreaseBytes','selectedGpuIndex','selectedGpuUuid','baselineVramMiB','peakVramMiB','vramIncreaseMiB','resourceSampleCount','gpuPerProcessQueryAttempted','gpuPerProcessQuerySucceeded','gpuPerProcessSupported','baselineOwnedGpuMemoryMiB','peakOwnedGpuMemoryMiB','ownedGpuMemoryIncreaseMiB','networkSampleAttemptCount','networkSampleSuccessCount','networkObservationAvailable','tcpObservationCount','unexpectedNetworkConnectionCount')
$script:ResourceSampleColumns = @('utc','label','rootPid','ownedProcessIds','ownedProcessCount','liveProcessIds','liveProcessCount','aggregateWorkingSetBytes','processWorkingSetBytes','selectedGpuIndex','selectedGpuUuid','baselineSelectedGpuUsedMiB','selectedGpuUsedMiB','selectedGpuDeltaMiB','gpuPerProcessQuerySucceeded','gpuPerProcessSupported','gpuPerProcessError','ownedGpuUsedMiB','ownedGpuProcessMemoryMiB','networkObservationAvailable','networkErrors','descendantTcpConnections')
$script:NetworkSampleColumns = @('utc','label','rootPid','pid','state','localAddress','localPort','remoteAddress','remotePort','unexpected')
$script:ProcessLifecycleColumns = @('label','rootPid','processId','parentProcessId','isRoot','source','startTimeUtcTicks','startedUtc','exitConfirmedByUtc','exitObserved')

function Write-Utf8Text([string]$Path, [string]$Text) {
    $parent = Split-Path -Parent $Path
    if ($parent -and -not (Test-Path -LiteralPath $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [IO.File]::WriteAllText($Path, $Text, (New-Object Text.UTF8Encoding($false)))
}

function Write-Json([string]$Path, $Value, [int]$Depth = 20) {
    Write-Utf8Text $Path (($Value | ConvertTo-Json -Depth $Depth) + "`n")
}

function Get-Sha256([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $null }
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function New-EvidenceStages([string]$Reason = 'Stage was not reached in this run.') {
    $stages = [ordered]@{}
    foreach ($name in $script:StageNames) { $stages[$name] = [ordered]@{ status='NOT_RUN'; reason=$Reason } }
    return $stages
}

function Set-EvidenceStage($Stages, [string]$Name, [ValidateSet('PASS','FAIL','NOT_RUN')][string]$Status, [string]$Reason) {
    if ($Name -notin $script:StageNames) { throw "Unknown evidence stage '$Name'." }
    if ([string]::IsNullOrWhiteSpace($Reason)) { throw "Evidence stage '$Name' requires an actual reason." }
    $Stages[$Name] = [ordered]@{ status=$Status; reason=(Sanitize-Text $Reason) }
}

function Write-StableCsv([string]$Path, [string[]]$Columns, $Rows) {
    $items = @($Rows)
    if ($items.Count -gt 0) {
        $lines = @($items | Select-Object -Property $Columns | ConvertTo-Csv -NoTypeInformation)
    } else {
        $lines = @(($Columns | ForEach-Object { '"' + $_.Replace('"','""') + '"' }) -join ',')
    }
    Write-Utf8Text $Path (($lines -join "`n") + "`n")
}

function Set-TextArtifactStatus([string]$Path, $Stage) {
    $body = ''
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
        $body = Get-Content -LiteralPath $Path -Raw
        $body = [regex]::Replace($body, '\Astatus=(?:PASS|FAIL|NOT_RUN)\r?\nreason=.*?\r?\n(?:\r?\n)?', '', [Text.RegularExpressions.RegexOptions]::Singleline)
    }
    $prefix = "status=$($Stage.status)`nreason=$($Stage.reason)`n"
    if (-not [string]::IsNullOrWhiteSpace($body)) { $prefix += "`n" + $body.TrimStart() }
    Write-Utf8Text $Path ($prefix.TrimEnd() + "`n")
}

function Reset-RunScopedEvidence([string]$Reason = 'Stage was not reached because the run stopped earlier.') {
    if (-not (Test-Path -LiteralPath $script:RawRoot)) { New-Item -ItemType Directory -Path $script:RawRoot -Force | Out-Null }
    foreach ($pattern in @('transcribe-*.json','gpu-proof-*.json')) {
        Get-ChildItem -LiteralPath $script:RawRoot -Filter $pattern -File -ErrorAction SilentlyContinue | Remove-Item -Force
    }
    $notRun = [ordered]@{ schemaVersion=2; status='NOT_RUN'; reason=$Reason; transcriptions=@() }
    Write-Json (Join-Path $script:RawRoot 'transcribe-not-run.json') $notRun
    Write-Json (Join-Path $script:RawRoot 'fixture-manifest.json') ([ordered]@{ schemaVersion=2; status='NOT_RUN'; reason=$Reason; fixtures=@() })
    Write-Json (Join-Path $script:RawRoot 'preflight.json') ([ordered]@{ schemaVersion=2; status='NOT_RUN'; reason=$Reason; safeToContinue=$false })
    # The command ledger is deliberately absent until repository-status-final has run.
    Write-Json (Join-Path $script:RawRoot 'acquisition.json') ([ordered]@{ schemaVersion=2; status='NOT_RUN'; reason=$Reason; runtime=$null; model=$null })
    foreach ($name in @('source-state.txt','submodules.txt','binary-inspection.txt','build-cuda.log','build-vulkan.log','build-cpu-diagnostic.log')) {
        Set-TextArtifactStatus (Join-Path $script:RawRoot $name) ([ordered]@{status='NOT_RUN';reason=$Reason})
    }
    Write-StableCsv (Join-Path $script:RawRoot 'metrics.csv') $script:MetricColumns @()
    Write-StableCsv (Join-Path $script:RawRoot 'resource-samples.csv') $script:ResourceSampleColumns @()
    Write-StableCsv (Join-Path $script:RawRoot 'network-observation.csv') $script:NetworkSampleColumns @()
    Write-StableCsv (Join-Path $script:RawRoot 'process-lifecycle.csv') $script:ProcessLifecycleColumns @()
}

function Set-FixtureManifestStatus([ValidateSet('PASS','FAIL','NOT_RUN')][string]$Status, [string]$Reason) {
    $path = Join-Path $script:RawRoot 'fixture-manifest.json'
    $manifest = if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path -Raw | ConvertFrom-Json } else { [pscustomobject]@{schemaVersion=2;fixtures=@()} }
    $ordered = [ordered]@{ schemaVersion=$(if ($manifest.schemaVersion) { $manifest.schemaVersion } else { 2 }); status=$Status; reason=$Reason }
    foreach ($property in $manifest.psobject.Properties) { if ($property.Name -notin @('schemaVersion','status','reason')) { $ordered[$property.Name]=$property.Value } }
    Write-Json $path $ordered 50
}

function Reconcile-TranscriptionArtifacts($Stage) {
    $placeholder = Join-Path $script:RawRoot 'transcribe-not-run.json'
    $real = @(Get-ChildItem -LiteralPath $script:RawRoot -Filter 'transcribe-*.json' -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -ne 'transcribe-not-run.json' })
    if ($real.Count -gt 0) {
        if (Test-Path -LiteralPath $placeholder) { Remove-Item -LiteralPath $placeholder -Force }
    } else {
        Write-Json $placeholder ([ordered]@{ schemaVersion=2; status=$Stage.status; reason=$Stage.reason; transcriptions=@() })
    }
}

function Write-AcquisitionEvidence($Runtime, $Model, $Stages) {
    $sourceStage = $Stages.source
    Write-Json (Join-Path $script:RawRoot 'acquisition.json') ([ordered]@{ schemaVersion=2; status=$sourceStage.status; reason=$sourceStage.reason; runtime=$Runtime; model=$Model; commands=$script:Commands.ToArray() }) 30
}

function Test-EvidenceOnlyRepositoryStatusLine([string]$Line) {
    if ([string]::IsNullOrWhiteSpace($Line)) { return $true }
    $normalized = $Line.TrimEnd("`r")
    if ($normalized -match ' -> ') { return $false }
    return ($normalized -match '^.. evidence/2026-08-09-nemo-asr-machine-validation(?:/|$)' -or $normalized -match '^.. evidence/2026-08-09-asr-architecture-research\.md$')
}

function Complete-CleanupIsolation($Cleanup, [bool]$RepositoryPassed, [string]$RepositoryReason, $Thresholds, $Stages) {
    if (-not (Test-ObjectProperty $Cleanup 'pass')) { $Cleanup['pass']=$false }
    $cleanupOwnPass = [bool]$Cleanup.pass
    $cleanupOwnReason = if ($cleanupOwnPass) { 'Marker-owned scratch deletion, VRAM return, and process cleanup passed.' } elseif ((Test-ObjectProperty $Cleanup 'error') -and $Cleanup.error) { "Cleanup failed: $($Cleanup.error)" } else { 'Scratch deletion, VRAM return, or process cleanup failed.' }
    Set-EvidenceStage $Stages 'repository-isolation' $(if($RepositoryPassed){'PASS'}else{'FAIL'}) $RepositoryReason
    if (-not $RepositoryPassed) {
        $Cleanup.pass = $false
        $Cleanup['status'] = 'FAIL'
        $Cleanup['reason'] = "$cleanupOwnReason Repository isolation failed: $RepositoryReason"
    } else {
        $Cleanup['status'] = $(if($cleanupOwnPass){'PASS'}else{'FAIL'})
        $Cleanup['reason'] = $cleanupOwnReason
    }
    Set-EvidenceStage $Stages 'cleanup' $Cleanup.status $Cleanup.reason
    $Thresholds.cleanupIsolation.status = $Cleanup.status
    $Thresholds.cleanupIsolation.reason = $Cleanup.reason
    return $Cleanup
}

function Finalize-NotRunStageReasons($Stages) {
    $lastFailure = $null
    foreach ($name in $script:StageNames) {
        $stage = $Stages[$name]
        if ($stage.status -eq 'FAIL') { $lastFailure = $name; continue }
        if ($stage.status -eq 'NOT_RUN' -and $stage.reason -match '^Stage was not reached') {
            $reason = if ($lastFailure) { "Stage was not run because the earlier '$lastFailure' stage failed." } else { 'Stage had no scheduled work in this bounded run.' }
            Set-EvidenceStage $Stages $name 'NOT_RUN' $reason
        }
    }
}

function Sync-StageArtifacts($Stages) {
    $preflightPath=Join-Path $script:RawRoot 'preflight.json'
    $preflightDocument=if(Test-Path -LiteralPath $preflightPath){Get-Content -LiteralPath $preflightPath -Raw|ConvertFrom-Json}else{[pscustomobject]@{schemaVersion=2}}
    $preflightOrdered=[ordered]@{schemaVersion=2;status=$Stages.preflight.status;reason=$Stages.preflight.reason}
    foreach($property in $preflightDocument.psobject.Properties){if($property.Name -notin @('schemaVersion','status','reason')){$preflightOrdered[$property.Name]=$property.Value}}
    Write-Json $preflightPath $preflightOrdered 20
    Set-TextArtifactStatus (Join-Path $script:RawRoot 'source-state.txt') $Stages.source
    Set-TextArtifactStatus (Join-Path $script:RawRoot 'submodules.txt') $Stages.submodules
    Set-TextArtifactStatus (Join-Path $script:RawRoot 'binary-inspection.txt') $Stages.build
    foreach ($name in @('build-cuda.log','build-vulkan.log','build-cpu-diagnostic.log')) { Set-TextArtifactStatus (Join-Path $script:RawRoot $name) $Stages.build }
    Set-FixtureManifestStatus $Stages.fixtures.status $Stages.fixtures.reason
    Reconcile-TranscriptionArtifacts $Stages.transcription
}

function Add-Failure([string]$Message) {
    if (-not $script:Failures.Contains($Message)) { $script:Failures.Add($Message) }
}

function Add-Warning([string]$Message) {
    if (-not $script:Warnings.Contains($Message)) { $script:Warnings.Add($Message) }
}

function Add-BackendBuildIssue([string]$Backend, [string]$Message) {
    if ($Backend -eq 'cpu') { Add-Warning $Message } else { Add-Failure $Message }
}

function Sanitize-Text([AllowNull()][string]$Text) {
    if ($null -eq $Text) { return $null }
    $value = $Text
    if ($script:Scratch) { $value = $value -ireplace [regex]::Escape($script:Scratch), '<SCRATCH>'; $value = $value -ireplace [regex]::Escape($script:Scratch.Replace('\','/')), '<SCRATCH>' }
    if ($env:USERPROFILE) { $value = $value -ireplace [regex]::Escape($env:USERPROFILE), '<USER_PROFILE>'; $value = $value -ireplace [regex]::Escape($env:USERPROFILE.Replace('\','/')), '<USER_PROFILE>' }
    return $value
}

function Quote-NativeArgument([string]$Argument) {
    if ($Argument -notmatch '[\s"]') { return $Argument }
    return '"' + ($Argument -replace '(\\*)"', '$1$1\"' -replace '(\\+)$', '$1$1') + '"'
}

if (-not ('BoundedStreamCapture' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Threading.Tasks;

public sealed class BoundedStreamCaptureResult {
    public byte[] Bytes { get; set; }
    public long TotalBytes { get; set; }
    public bool Truncated { get; set; }
}

public static class BoundedStreamCapture {
    public static async Task<BoundedStreamCaptureResult> DrainAsync(Stream stream, int byteCap) {
        byte[] buffer = new byte[8192];
        using (var kept = new MemoryStream(Math.Max(0, Math.Min(byteCap, 8192)))) {
            long total = 0;
            while (true) {
                int read = await stream.ReadAsync(buffer, 0, buffer.Length).ConfigureAwait(false);
                if (read == 0) break;
                total += read;
                int remaining = byteCap - (int)kept.Length;
                if (remaining > 0) kept.Write(buffer, 0, Math.Min(remaining, read));
            }
            return new BoundedStreamCaptureResult {
                Bytes = kept.ToArray(), TotalBytes = total, Truncated = total > byteCap
            };
        }
    }
}
'@
}

if (-not ('RetainedProcessSnapshotTracker' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class RetainedProcessSnapshotEdge {
    public int ParentProcessId { get; set; }
    public int ProcessId { get; set; }
    public long ObservedUtcTicks { get; set; }
    public long StartTimeUtcTicks { get; set; }
}

public sealed class RetainedProcessSnapshotTracker : IDisposable {
    const uint TH32CS_SNAPPROCESS = 0x00000002;
    static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);
    readonly ConcurrentDictionary<string, RetainedProcessSnapshotEdge> edges = new ConcurrentDictionary<string, RetainedProcessSnapshotEdge>();
    readonly Thread thread;
    volatile bool stopped;
    volatile bool armed;
    int capturing;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
    struct PROCESSENTRY32 {
        public uint dwSize, cntUsage, th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID, cntThreads, th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
    }

    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)] static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)] static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr handle);

    public RetainedProcessSnapshotTracker() {
        thread = new Thread(Run) { IsBackground = true, Name = "Nemo process snapshot tracker" };
        thread.Start();
    }

    void Run() {
        // simplification: privilege-free recovery fallback polls continuously; replace with ETW when start-trace access is available.
        while (!stopped) { Capture(); Thread.Yield(); }
    }

    void Capture() {
        if (Interlocked.Exchange(ref capturing, 1) != 0) return;
        try {
            IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if (snapshot == INVALID_HANDLE_VALUE) return;
            try {
                var entry = new PROCESSENTRY32 { dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32)) };
                if (!Process32First(snapshot, ref entry)) return;
                long observed = DateTime.UtcNow.Ticks;
                do {
                    int processId = unchecked((int)entry.th32ProcessID);
                    int parentId = unchecked((int)entry.th32ParentProcessID);
                    if (processId > 0 && parentId > 0) {
                        var edge = new RetainedProcessSnapshotEdge { ParentProcessId = parentId, ProcessId = processId, ObservedUtcTicks = observed };
                        if (edges.TryAdd(parentId + ":" + processId, edge) && armed) {
                            try { using (var process = Process.GetProcessById(processId)) edge.StartTimeUtcTicks = process.StartTime.ToUniversalTime().Ticks; } catch { }
                        }
                    }
                } while (Process32Next(snapshot, ref entry));
            } finally { CloseHandle(snapshot); }
        } finally { Volatile.Write(ref capturing, 0); }
    }

    public void Arm() { armed = true; }
    public RetainedProcessSnapshotEdge[] GetEdges() { return new List<RetainedProcessSnapshotEdge>(edges.Values).ToArray(); }
    public void Stop() { stopped = true; if (Thread.CurrentThread != thread) thread.Join(1000); Capture(); }
    public void Dispose() { Stop(); }
}
'@
}

function Get-ProcessSnapshot {
    return @(Get-CimInstance Win32_Process -ErrorAction Stop | Select-Object ProcessId,ParentProcessId)
}

function Get-ProcessIdentity([int]$ProcessId) {
    if ($ProcessId -le 0) { return $null }
    try {
        $process = Get-Process -Id $ProcessId -ErrorAction Stop
        $ticks = $process.StartTime.ToUniversalTime().Ticks
        return [pscustomobject][ordered]@{ processId=$ProcessId; startTimeUtcTicks=[int64]$ticks }
    } catch { return $null }
}

function Test-ProcessIdentity($Identity) {
    if ($null -eq $Identity) { return $false }
    $current = Get-ProcessIdentity ([int]$Identity.processId)
    return ($null -ne $current -and [int64]$current.startTimeUtcTicks -eq [int64]$Identity.startTimeUtcTicks)
}

function New-ProcessStartTracker {
    $errors = New-Object System.Collections.Generic.List[string]
    $tracker = [pscustomobject][ordered]@{
        strategy='win32-process-start-trace-with-snapshot-fallback'
        sourceIdentifier=('nemo-process-start-' + [guid]::NewGuid().ToString('N'))
        startedUtcTicks=[DateTime]::UtcNow.Ticks
        rootProcessId=$null
        available=$true
        edges=(New-Object System.Collections.Generic.List[object])
        ownedEdges=(New-Object System.Collections.Generic.List[object])
        errors=$errors
        subscription=$null
        snapshotTracker=(New-Object RetainedProcessSnapshotTracker)
        snapshotEdgeKeys=(New-Object 'System.Collections.Generic.HashSet[string]')
    }
    try {
        $tracker.subscription = Register-WmiEvent -Class Win32_ProcessStartTrace -SourceIdentifier $tracker.sourceIdentifier -ErrorAction Stop
        $tracker.available = $true
    } catch {
        # Snapshot fallback remains available when Win32 start-trace registration is denied.
        $tracker.subscription = $null
    }
    return $tracker
}

function Receive-ProcessStartEdges($Tracker) {
    if ($null -eq $Tracker -or $null -eq $Tracker.subscription) { return }
    try {
        foreach ($eventRecord in @(Get-Event -SourceIdentifier $Tracker.sourceIdentifier -ErrorAction SilentlyContinue)) {
            try {
                $newEvent = $eventRecord.SourceEventArgs.NewEvent
                $eventTicks = [DateTime]::UtcNow.Ticks
                try {
                    $rawTime = [uint64]$newEvent.TIME_CREATED
                    if ($rawTime -gt 0) { $eventTicks = [DateTime]::FromFileTimeUtc([int64]$rawTime).Ticks }
                } catch { }
                $processId = [int]$newEvent.ProcessID
                $identity = Get-ProcessIdentity $processId
                $eventIdentityTicks = $null
                if ($null -ne $identity -and [math]::Abs([double]([int64]$identity.startTimeUtcTicks - [int64]$eventTicks)) -le [TimeSpan]::TicksPerSecond) { $eventIdentityTicks = [int64]$identity.startTimeUtcTicks }
                $Tracker.edges.Add([pscustomobject][ordered]@{ parentProcessId=[int]$newEvent.ParentProcessID; processId=$processId; startTimeUtcTicks=$eventIdentityTicks; eventUtcTicks=[int64]$eventTicks; source='Win32_ProcessStartTrace' })
            } finally { Remove-Event -EventIdentifier $eventRecord.EventIdentifier -ErrorAction SilentlyContinue }
        }
    } catch {
        $message = Sanitize-Text ("Process-start event receive failed: $($_.Exception.Message) at $($_.InvocationInfo.ScriptLineNumber)")
        if (-not $Tracker.errors.Contains($message)) { $Tracker.errors.Add($message) }
        $Tracker.available = $false
    }
}

function Stop-ProcessStartTracker($Tracker) {
    if ($null -eq $Tracker) { return }
    if ($null -ne $Tracker.snapshotTracker) { $Tracker.snapshotTracker.Stop() }
    if ($null -ne $Tracker.subscription) {
        try { Unregister-Event -SourceIdentifier $Tracker.sourceIdentifier -ErrorAction Stop }
        catch {
            $message = Sanitize-Text $_.Exception.Message
            if (-not $Tracker.errors.Contains($message)) { $Tracker.errors.Add($message) }
        }
    }
    # Unsubscribe first, then drain every event queued before unregistration so no final child edge is discarded.
    Receive-ProcessStartEdges $Tracker
    Get-Event -SourceIdentifier $Tracker.sourceIdentifier -ErrorAction SilentlyContinue | Remove-Event -ErrorAction SilentlyContinue
}

function Update-OwnedProcessIdentities {
    param(
        [Parameter(Mandatory=$true)]$RootIdentity,
        [Parameter(Mandatory=$true)]$OwnedProcessIdentities,
        $Tracker = $null,
        $Snapshot = $null,
        [switch]$SkipSnapshot
    )
    $rootId = [int]$RootIdentity.processId
    if (-not $OwnedProcessIdentities.ContainsKey($rootId)) { $OwnedProcessIdentities[$rootId] = $RootIdentity }
    Receive-ProcessStartEdges $Tracker
    if ($null -ne $Tracker -and $null -ne $Tracker.snapshotTracker) {
        foreach ($snapshotEdge in $Tracker.snapshotTracker.GetEdges()) {
            if ([int64]$snapshotEdge.ObservedUtcTicks -lt [int64]$Tracker.startedUtcTicks) { continue }
            $key = "$([int]$snapshotEdge.ParentProcessId):$([int]$snapshotEdge.ProcessId)"
            if ($Tracker.snapshotEdgeKeys.Add($key)) {
                $Tracker.edges.Add([pscustomobject][ordered]@{ parentProcessId=[int]$snapshotEdge.ParentProcessId; processId=[int]$snapshotEdge.ProcessId; startTimeUtcTicks=$(if ([int64]$snapshotEdge.StartTimeUtcTicks -gt 0) { [int64]$snapshotEdge.StartTimeUtcTicks } else { $null }); eventUtcTicks=[int64]$snapshotEdge.ObservedUtcTicks; source='toolhelp-snapshot' })
            }
        }
    }
    $edges = New-Object System.Collections.Generic.List[object]
    $edgeKeys=@{}
    if ($null -ne $Tracker) {
        foreach ($edge in @($Tracker.ownedEdges.ToArray()) + @($Tracker.edges.ToArray())) {
            $edgeKey="$([int]$edge.parentProcessId):$([int]$edge.processId):$($edge.startTimeUtcTicks)"
            if(-not$edgeKeys.ContainsKey($edgeKey)){$edgeKeys[$edgeKey]=$true;$edges.Add($edge)}
        }
    }
    # Current snapshots close ordinary live trees immediately; retained accepted edges preserve exited intermediates and lifecycle parentage.
    if (-not $SkipSnapshot) {
        if ($null -eq $Snapshot) { $Snapshot = Get-ProcessSnapshot }
        $observedTicks = [DateTime]::UtcNow.Ticks
        $liveParentIds = New-Object 'System.Collections.Generic.HashSet[int]'
        foreach ($knownIdentity in @($OwnedProcessIdentities.Values)) { if (Test-ProcessIdentity $knownIdentity) { [void]$liveParentIds.Add([int]$knownIdentity.processId) } }
        $snapshotAdded = $true
        while ($snapshotAdded) {
            $snapshotAdded = $false
            foreach ($candidate in @($Snapshot)) {
                $processId = [int]$candidate.ProcessId
                if ($processId -le 0 -or -not $liveParentIds.Contains([int]$candidate.ParentProcessId) -or $liveParentIds.Contains($processId)) { continue }
                $identity = Get-ProcessIdentity $processId
                if ($null -eq $identity -or [int64]$identity.startTimeUtcTicks -lt [int64]$RootIdentity.startTimeUtcTicks) { continue }
                $edges.Add([pscustomobject]@{ parentProcessId=[int]$candidate.ParentProcessId; processId=$processId; startTimeUtcTicks=[int64]$identity.startTimeUtcTicks; eventUtcTicks=$observedTicks; source='live-snapshot' })
                [void]$liveParentIds.Add($processId)
                $snapshotAdded = $true
            }
        }
    }
    $reachable = New-Object 'System.Collections.Generic.HashSet[int]'
    [void]$reachable.Add($rootId)
    $acceptedEdges = New-Object System.Collections.Generic.List[object]
    if ($null -ne $Tracker -and $null -ne $Tracker.subscription) {
        # Replay start events in order. A new event for an existing PID supersedes its old generation,
        # so a recycled PID cannot inherit ownership from an exited process.
        $generations = @{ $rootId = [int64]$RootIdentity.startTimeUtcTicks }
        foreach ($edge in @($edges | Where-Object { [int64]$_.eventUtcTicks -ge [int64]$Tracker.startedUtcTicks })) {
            $childId = [int]$edge.processId
            if ($childId -le 0) { continue }
            if ($childId -eq $rootId) {
                if ($null -eq $edge.startTimeUtcTicks -or [int64]$edge.startTimeUtcTicks -ne [int64]$RootIdentity.startTimeUtcTicks) { [void]$generations.Remove($rootId) }
                continue
            }
            $parentOwned = $generations.ContainsKey([int]$edge.parentProcessId)
            [void]$generations.Remove($childId)
            if ($parentOwned) {
                $acceptedEdges.Add($edge)
                $generations[$childId] = if ($null -ne $edge.startTimeUtcTicks) { [int64]$edge.startTimeUtcTicks } else { [int64]$edge.eventUtcTicks }
            }
        }
        foreach ($candidateId in $generations.Keys) { [void]$reachable.Add([int]$candidateId) }
        $Tracker.ownedEdges.Clear()
        foreach ($edge in $acceptedEdges) { $Tracker.ownedEdges.Add($edge) }
    } else {
        $added = $true
        while ($added) {
            $added = $false
            foreach ($edge in $edges) {
                $childId = [int]$edge.processId
                if ($childId -gt 0 -and $reachable.Contains([int]$edge.parentProcessId) -and $reachable.Add($childId)) { $acceptedEdges.Add($edge); $added = $true }
            }
        }
        if ($null -ne $Tracker) {
            $Tracker.ownedEdges.Clear()
            foreach ($edge in $acceptedEdges) { $Tracker.ownedEdges.Add($edge) }
        }
    }
    foreach ($candidateId in @($reachable)) {
        if ($OwnedProcessIdentities.ContainsKey([int]$candidateId)) { continue }
        $identity = Get-ProcessIdentity ([int]$candidateId)
        $identityEdges = @($acceptedEdges | Where-Object { [int]$_.processId -eq [int]$candidateId -and $null -ne $_.startTimeUtcTicks })
        $identityWasObserved = ($null -ne $identity -and @($identityEdges | Where-Object { [int64]$_.startTimeUtcTicks -eq [int64]$identity.startTimeUtcTicks }).Count -gt 0)
        if ($identityWasObserved -and [int64]$identity.startTimeUtcTicks -ge [int64]$RootIdentity.startTimeUtcTicks) { $OwnedProcessIdentities[[int]$candidateId] = $identity }
    }
    return @($OwnedProcessIdentities.Values | ForEach-Object { $_ })
}

function Get-LiveOwnedProcessIdentities($OwnedProcessIdentities) {
    return @($OwnedProcessIdentities.Values | ForEach-Object { $_ } | Where-Object { Test-ProcessIdentity $_ })
}

function Stop-OwnedProcessInstance([Diagnostics.Process]$Process) {
    $Process.Kill()
}

function Stop-OwnedProcessIdentity($Identity) {
    if ($null -eq $Identity) { throw 'Owned process identity is missing.' }
    $process = Get-Process -Id ([int]$Identity.processId) -ErrorAction Stop
    try {
        if ([int64]$process.StartTime.ToUniversalTime().Ticks -ne [int64]$Identity.startTimeUtcTicks) {
            throw "PID $($Identity.processId) no longer has owned start-time identity $($Identity.startTimeUtcTicks)."
        }
        Stop-OwnedProcessInstance $process
    } finally { $process.Dispose() }
}

function Stop-ProcessTree {
    param(
        [Parameter(Mandatory=$true)][int]$RootProcessId,
        $OwnedProcessIdentities = $null,
        [int]$TimeoutMilliseconds = 5000,
        $Tracker = $null
    )
    if ($null -eq $OwnedProcessIdentities) { $OwnedProcessIdentities = @{} }
    if ($OwnedProcessIdentities -isnot [System.Collections.IDictionary]) {
        $converted = @{}
        foreach ($id in @($OwnedProcessIdentities)) { $identity=Get-ProcessIdentity ([int]$id); if ($null -ne $identity) { $converted[[int]$id]=$identity } }
        $OwnedProcessIdentities = $converted
    }
    $rootIdentity = if ($OwnedProcessIdentities.ContainsKey($RootProcessId)) { $OwnedProcessIdentities[$RootProcessId] } else { Get-ProcessIdentity $RootProcessId }
    if ($null -ne $rootIdentity) { $OwnedProcessIdentities[$RootProcessId]=$rootIdentity }
    $started = [DateTime]::UtcNow
    $deadline = $started.AddMilliseconds([math]::Max(0,$TimeoutMilliseconds))
    # Reserve bounded bookkeeping time so final identity/event evidence is emitted before the public deadline.
    $workDeadline = $deadline.AddMilliseconds(-[math]::Min(200,[math]::Max(0,$TimeoutMilliseconds/4)))
    $errors = New-Object System.Collections.Generic.List[string]
    $trackingAvailable = ($null -ne $rootIdentity)
    $quietPeriodMilliseconds = [math]::Min(500,[math]::Max(0,$TimeoutMilliseconds))
    $emptySince = $null
    $observedEdgeCount = if ($null -ne $Tracker) { $Tracker.edges.Count } else { 0 }
    do {
        try { if ($null -ne $rootIdentity) { [void](Update-OwnedProcessIdentities $rootIdentity $OwnedProcessIdentities $Tracker -SkipSnapshot) } }
        catch { $trackingAvailable=$false; $message=Sanitize-Text $_.Exception.Message; if (-not $errors.Contains($message)){$errors.Add($message)} }
        if ($null -ne $Tracker -and $Tracker.edges.Count -ne $observedEdgeCount) { $observedEdgeCount=$Tracker.edges.Count; $emptySince=$null }
        $remaining = @(Get-LiveOwnedProcessIdentities $OwnedProcessIdentities)
        if ($remaining.Count -eq 0) {
            if ($null -eq $emptySince) { $emptySince=[DateTime]::UtcNow }
            if (([DateTime]::UtcNow-$emptySince).TotalMilliseconds -ge $quietPeriodMilliseconds) { break }
            if ([DateTime]::UtcNow -lt $workDeadline) { Start-Sleep -Milliseconds ([math]::Min(25,[math]::Max(1,($workDeadline-[DateTime]::UtcNow).TotalMilliseconds))) }
            continue
        }
        $emptySince = $null
        $stopOrder = @($remaining | Sort-Object @{ Expression = { if ([int]$_.processId -eq $RootProcessId) { 1 } else { 0 } } })
        foreach ($identity in $stopOrder) {
            if ([DateTime]::UtcNow -ge $workDeadline) { break }
            $processId = [int]$identity.processId
            if ($processId -eq $PID) { $message="Refused to terminate the validation harness PID $processId."; if(-not $errors.Contains($message)){$errors.Add($message)}; continue }
            try { Stop-OwnedProcessIdentity $identity }
            catch { $message="PID ${processId}: $(Sanitize-Text $_.Exception.Message)"; if(-not $errors.Contains($message)){$errors.Add($message)} }
        }
        if ([DateTime]::UtcNow -lt $workDeadline) { Start-Sleep -Milliseconds ([math]::Min(50,[math]::Max(1,($workDeadline-[DateTime]::UtcNow).TotalMilliseconds))) }
    } while ([DateTime]::UtcNow -lt $workDeadline)
    try { if ($null -ne $rootIdentity) { [void](Update-OwnedProcessIdentities $rootIdentity $OwnedProcessIdentities $Tracker -SkipSnapshot) } } catch { $trackingAvailable=$false }
    $remaining = @(Get-LiveOwnedProcessIdentities $OwnedProcessIdentities)
    $ended = [DateTime]::UtcNow
    return [pscustomobject][ordered]@{ attempted=$true; rootProcessId=$RootProcessId; timeoutMilliseconds=$TimeoutMilliseconds; startedUtc=$started.ToString('o'); endedUtc=$ended.ToString('o'); durationMs=[math]::Round(($ended-$started).TotalMilliseconds,1); trackingAvailable=$trackingAvailable; errors=$errors.ToArray(); remainingProcessIds=@($remaining | ForEach-Object {[int]$_.processId}); remainingProcessIdentities=$remaining; succeeded=($trackingAvailable -and $remaining.Count -eq 0) }
}

function ConvertFrom-NvidiaGpuInventoryCsv([string[]]$Lines) {
    $rows = @()
    foreach ($line in @($Lines | Where-Object { $_ -and $_.Trim() })) {
        $parts = @($line -split ',\s*')
        if ($parts.Count -lt 7) { throw "Malformed NVIDIA GPU inventory row: $line" }
        $rows += [pscustomobject][ordered]@{ index=[int]$parts[0]; uuid=$parts[1].Trim(); name=$parts[2].Trim(); driver=$parts[3].Trim(); totalVramMiB=[int]$parts[4]; freeVramMiB=[int]$parts[5]; computeCapability=$parts[6].Trim() }
    }
    return $rows
}

function Select-ValidationGpu($GpuRows) {
    $matches = @($GpuRows | Where-Object { $_.name -eq 'NVIDIA GeForce GTX 1080' -and $_.computeCapability -eq '6.1' })
    if ($matches.Count -ne 1) { return $null }
    return $matches[0]
}

function ConvertFrom-NvidiaComputeAppsCsv([string[]]$Lines) {
    $rows = @()
    foreach ($line in @($Lines | Where-Object { $_ -and $_.Trim() })) {
        $parts = @($line -split ',\s*')
        if ($parts.Count -lt 3 -or $parts[1] -notmatch '^\d+$' -or $parts[2] -notmatch '^\d+$') { throw "Malformed NVIDIA compute-app row: $line" }
        $rows += [pscustomobject][ordered]@{ gpuUuid=$parts[0].Trim(); processId=[int]$parts[1]; usedMemoryMiB=[int]$parts[2] }
    }
    return $rows
}

function Get-GpuObservation([int[]]$OwnedProcessIds = @()) {
    $selected = $script:SelectedGpu
    if ($null -eq $selected) { return [pscustomobject][ordered]@{ available=$false; error='Selected GPU identity is absent.'; deviceIndex=$null; deviceUuid=$null; systemUsedMiB=$null; perProcessQuerySucceeded=$false; perProcessSupported=$null; perProcessError='Selected GPU identity is absent.'; ownedUsedMiB=$null; processes=@() } }
    $nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if (-not $nvidia) { return [pscustomobject][ordered]@{ available=$false; error='nvidia-smi.exe is unavailable.'; deviceIndex=$selected.index; deviceUuid=$selected.uuid; systemUsedMiB=$null; perProcessQuerySucceeded=$false; perProcessSupported=$null; perProcessError='nvidia-smi.exe is unavailable.'; ownedUsedMiB=$null; processes=@() } }
    try {
        $systemRun = Invoke-QuickProcess $nvidia.Source @('-i',$selected.uuid,'--query-gpu=memory.used','--format=csv,noheader,nounits') 5
        $systemLine = @($systemRun.stdout -split "`r?`n" | Where-Object { $_ }) | Select-Object -First 1
        $systemUsed = if ($systemRun.exitCode -eq 0 -and $systemLine -match '^\s*(\d+)') { [int]$matches[1] } else { $null }
        $processRun = Invoke-QuickProcess $nvidia.Source @('--query-compute-apps=gpu_uuid,pid,used_gpu_memory','--format=csv,noheader,nounits') 5
        $processRows = @()
        $processError = $null
        $perProcessSupported=$null
        $perProcessQuerySucceeded=$false
        if ($processRun.exitCode -eq 0 -and $processRun.stdout -match '(?i)not supported|\bN/A\b') {
            $perProcessSupported=$false; $perProcessQuerySucceeded=$true
            $processError=Sanitize-Text $processRun.stdout
        } elseif ($processRun.exitCode -ne 0) {
            $processError=Sanitize-Text ((@($processRun.stderr,$processRun.stdout) | Where-Object { $_ }) -join ' ')
        } elseif ([string]::IsNullOrWhiteSpace($processRun.stdout)) {
            $perProcessSupported=$true; $perProcessQuerySucceeded=$true
        } else {
            try { $processRows = @(ConvertFrom-NvidiaComputeAppsCsv @($processRun.stdout -split "`r?`n")); $perProcessSupported=$true; $perProcessQuerySucceeded=$true } catch { $processError=Sanitize-Text $_.Exception.Message }
        }
        $ownedSet = @{}; foreach ($processId in @($OwnedProcessIds)) { $ownedSet[[int]$processId]=$true }
        $selectedRows = @($processRows | Where-Object { $_.gpuUuid -eq $selected.uuid -and $ownedSet.ContainsKey([int]$_.processId) })
        $ownedUsed = if ($perProcessSupported -eq $true) { [int64](@($selectedRows | Measure-Object -Property usedMemoryMiB -Sum).Sum) } else { $null }
        return [pscustomobject][ordered]@{ available=($null -ne $systemUsed); error=$(if($null-ne$systemUsed){$null}else{'Selected GPU memory query returned no numeric value.'}); deviceIndex=[int]$selected.index; deviceUuid=$selected.uuid; systemUsedMiB=$systemUsed; perProcessQuerySucceeded=$perProcessQuerySucceeded; perProcessSupported=$perProcessSupported; perProcessError=$processError; ownedUsedMiB=$ownedUsed; processes=$selectedRows }
    } catch { return [pscustomobject][ordered]@{ available=$false; error=(Sanitize-Text $_.Exception.Message); deviceIndex=$selected.index; deviceUuid=$selected.uuid; systemUsedMiB=$null; perProcessQuerySucceeded=$false; perProcessSupported=$null; perProcessError=(Sanitize-Text $_.Exception.Message); ownedUsedMiB=$null; processes=@() } }
}

function Add-ResourceSample {
    param($OwnedProcessIdentities, $LiveProcessIdentities, [string]$Label, [int]$RootProcessId, $BaselineGpuUsedMiB)
    $utc=[DateTime]::UtcNow.ToString('o')
    $workingSets=@(); $aggregateWorkingSet=0L; $liveIds=@()
    $networkAvailable=($null -ne (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)); $networkCount=0; $networkErrors=@()
    foreach ($identity in @($LiveProcessIdentities)) {
        $processId=[int]$identity.processId; $sampleProcess=Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($null -eq $sampleProcess) { continue }
        $liveIds += $processId; $workingSet=[int64]$sampleProcess.WorkingSet64; $aggregateWorkingSet += $workingSet; $workingSets += "${processId}=${workingSet}"
    }
    if ($networkAvailable) {
        try {
            $liveSet=@{}; foreach($processId in $liveIds){$liveSet[[int]$processId]=$true}
            foreach ($connection in @(Get-NetTCPConnection -ErrorAction Stop | Where-Object { $liveSet.ContainsKey([int]$_.OwningProcess) })) {
                $networkCount++; $processId=[int]$connection.OwningProcess
                $script:NetworkSamples.Add([pscustomobject][ordered]@{ utc=$utc; label=$Label; rootPid=$RootProcessId; pid=$processId; state=[string]$connection.State; localAddress=[string]$connection.LocalAddress; localPort=$connection.LocalPort; remoteAddress=[string]$connection.RemoteAddress; remotePort=$connection.RemotePort; unexpected=$true })
            }
        } catch { $networkAvailable=$false; $networkErrors += (Sanitize-Text $_.Exception.Message) }
    }
    $gpu=Get-GpuObservation $liveIds
    $gpuDelta=if($null-ne$gpu.systemUsedMiB-and$null-ne$BaselineGpuUsedMiB){[double]$gpu.systemUsedMiB-[double]$BaselineGpuUsedMiB}else{$null}
    $gpuProcesses=@($gpu.processes | ForEach-Object { "$($_.processId)=$($_.usedMemoryMiB)" })
    $ownedIds=@($OwnedProcessIdentities | ForEach-Object {[int]$_.processId})
    $script:ResourceSamples.Add([pscustomobject][ordered]@{ utc=$utc; label=$Label; rootPid=$RootProcessId; ownedProcessIds=(@($ownedIds)-join ';'); ownedProcessCount=@($ownedIds).Count; liveProcessIds=(@($liveIds)-join ';'); liveProcessCount=@($liveIds).Count; aggregateWorkingSetBytes=$aggregateWorkingSet; processWorkingSetBytes=($workingSets-join ';'); selectedGpuIndex=$gpu.deviceIndex; selectedGpuUuid=$gpu.deviceUuid; baselineSelectedGpuUsedMiB=$BaselineGpuUsedMiB; selectedGpuUsedMiB=$gpu.systemUsedMiB; selectedGpuDeltaMiB=$gpuDelta; gpuPerProcessQuerySucceeded=$gpu.perProcessQuerySucceeded; gpuPerProcessSupported=$gpu.perProcessSupported; gpuPerProcessError=$gpu.perProcessError; ownedGpuUsedMiB=$gpu.ownedUsedMiB; ownedGpuProcessMemoryMiB=($gpuProcesses-join ';'); networkObservationAvailable=$networkAvailable; networkErrors=($networkErrors -join ' | '); descendantTcpConnections=$networkCount })
    return [pscustomobject][ordered]@{ aggregateWorkingSetBytes=$aggregateWorkingSet; liveProcessIds=$liveIds; gpu=$gpu; networkObservationAvailable=$networkAvailable; networkErrors=$networkErrors; networkCount=$networkCount }
}

function Get-ProcessLifecycleEvidence($RootIdentity, $OwnedProcessIdentities, $OwnershipEdges, [DateTime]$EndedUtc) {
    $rows=@{}
    if($null-ne$RootIdentity){$rootKey="$([int]$RootIdentity.processId):$([int64]$RootIdentity.startTimeUtcTicks)";$rows[$rootKey]=[ordered]@{processId=[int]$RootIdentity.processId;parentProcessId=$null;isRoot=$true;startTimeUtcTicks=[int64]$RootIdentity.startTimeUtcTicks;source='root-launch'}}
    foreach($edge in $OwnershipEdges){
        $processId=[int]$edge.processId
        $startTicks=$null; if($null-ne$edge.startTimeUtcTicks){$startTicks=[int64]$edge.startTimeUtcTicks}
        $identityKey="$processId`:$startTicks"
        if(-not $rows.ContainsKey($identityKey)){$rows[$identityKey]=[ordered]@{processId=$processId;parentProcessId=[int]$edge.parentProcessId;isRoot=$false;startTimeUtcTicks=$startTicks;source=[string]$edge.source}}
    }
    foreach($identity in $OwnedProcessIdentities.Values){$identityKey="$([int]$identity.processId):$([int64]$identity.startTimeUtcTicks)";if(-not $rows.ContainsKey($identityKey)){$rows[$identityKey]=[ordered]@{processId=[int]$identity.processId;parentProcessId=$null;isRoot=($null-ne$RootIdentity-and[int]$identity.processId -eq [int]$RootIdentity.processId);startTimeUtcTicks=[int64]$identity.startTimeUtcTicks;source='owned-snapshot'}}}
    return @($rows.Values | ForEach-Object {
        $identity=if($null-ne$_.startTimeUtcTicks){[pscustomobject]@{processId=$_.processId;startTimeUtcTicks=$_.startTimeUtcTicks}}else{$null}
        [pscustomobject][ordered]@{ rootPid=$(if($null-ne$RootIdentity){[int]$RootIdentity.processId}else{$null}); processId=$_.processId; parentProcessId=$_.parentProcessId; isRoot=$_.isRoot; source=$_.source; startTimeUtcTicks=$_.startTimeUtcTicks; startedUtc=$(if($null-ne$_.startTimeUtcTicks){([DateTime]::new([int64]$_.startTimeUtcTicks,[DateTimeKind]::Utc)).ToString('o')}else{$null}); exitConfirmedByUtc=$(if($null-ne$identity-and-not(Test-ProcessIdentity $identity)){$EndedUtc.ToString('o')}else{$null}); endedUtc=$(if($null-ne$identity-and-not(Test-ProcessIdentity $identity)){$EndedUtc.ToString('o')}else{$null}); exitObserved=($null-ne$identity-and-not(Test-ProcessIdentity $identity)) }
    })
}

function Invoke-BoundedProcess {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 120,
        [string]$WorkingDirectory = $script:Scratch,
        [string]$Label = 'process',
        [switch]$Observe,
        [scriptblock]$CancellationPredicate = $null,
        [int]$TerminationTimeoutMilliseconds = 5000,
        [int]$PipeDrainTimeoutMilliseconds = 500,
        [int]$OutputByteCap = 1048576,
        [switch]$RecordCommand,
        [Collections.IDictionary]$EnvironmentVariables = $null,
        [Text.Encoding]$ProcessOutputEncoding = $null
    )
    if ($OutputByteCap -lt 0) { throw 'OutputByteCap must be non-negative.' }
    if ($RecordCommand) { $script:ProcessSequence++ }
    $argumentLine = ($Arguments | ForEach-Object { Quote-NativeArgument $_ }) -join ' '
    $psi = New-Object Diagnostics.ProcessStartInfo
    $psi.FileName=$FilePath; $psi.Arguments=$argumentLine; $psi.WorkingDirectory=$WorkingDirectory
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    if ($null -ne $ProcessOutputEncoding) { $psi.StandardOutputEncoding=$ProcessOutputEncoding; $psi.StandardErrorEncoding=$ProcessOutputEncoding }
    if ($null -ne $EnvironmentVariables) {
        $psi.EnvironmentVariables.Clear()
        foreach ($key in $EnvironmentVariables.Keys) { $psi.EnvironmentVariables[[string]$key] = [string]$EnvironmentVariables[$key] }
    }
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $psi
    $timedOut=$false; $cancelled=$false; $startError=$null; $stdout=''; $stderr=''
    $stdoutTask=$null; $stderrTask=$null; $stdoutComplete=$false; $stderrComplete=$false
    $stdoutEncoding=[Text.Encoding]::UTF8; $stderrEncoding=[Text.Encoding]::UTF8
    $stdoutTotalBytes=0L; $stderrTotalBytes=0L; $stdoutTruncated=$false; $stderrTruncated=$false
    $exitCode=$null; $baselineWorkingSet=$null; $peakWorkingSet=0L
    $networkPreflightError=$null
    if($Observe){try{if($null-eq(Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)){throw 'Get-NetTCPConnection is unavailable.'};[void]@(Get-NetTCPConnection -ErrorAction Stop)}catch{$networkPreflightError=Sanitize-Text $_.Exception.Message}}
    $baselineGpu = if ($Observe) { Get-GpuObservation @() } else { $null }
    $observedVramBaseline = if ($null-ne$baselineGpu) { $baselineGpu.systemUsedMiB } else { $null }
    $observedVramPeak=$observedVramBaseline; $currentVram=$observedVramBaseline; $rootProcessId=$null; $rootIdentity=$null
    $baselineOwnedGpuMemory=0.0; $peakOwnedGpuMemory=$null; $gpuPerProcessSupported=$false; $gpuPerProcessAttempted=$false; $gpuPerProcessQuerySucceeded=$true
    $resourceSampleCount=0; $networkSampleSuccessCount=0; $networkSamplingFailed=$false; $networkSampleStart=$script:NetworkSamples.Count
    $ownedProcessIdentities=@{}; $ownedProcessesRemaining=@(); $ownershipTrackingAvailable=$true
    $ownershipErrors=New-Object System.Collections.Generic.List[string]
    $samplingErrors=New-Object System.Collections.Generic.List[string]
    if($null-ne$networkPreflightError){$samplingErrors.Add("Descendant TCP sampler preflight failed: $networkPreflightError")}
    $started = [DateTime]::UtcNow
    $tracker = New-ProcessStartTracker # Must subscribe immediately before root launch.
    foreach ($message in $tracker.errors.ToArray()) { if (-not $ownershipErrors.Contains($message)) { $ownershipErrors.Add($message) } }
    $termination=[pscustomobject][ordered]@{ attempted=$false; rootProcessId=$null; timeoutMilliseconds=$TerminationTimeoutMilliseconds; startedUtc=$null; endedUtc=$null; durationMs=0; trackingAvailable=$true; errors=@(); remainingProcessIds=@(); remainingProcessIdentities=@(); succeeded=$true }
    try {
        if (-not $process.Start()) { throw "Process did not start: $FilePath" }
        $rootProcessId=[int]$process.Id
        $rootIdentity=[pscustomobject][ordered]@{ processId=$rootProcessId; startTimeUtcTicks=[int64]$process.StartTime.ToUniversalTime().Ticks }
        $tracker.rootProcessId=$rootProcessId
        if ($null -ne $tracker.snapshotTracker) { $tracker.snapshotTracker.Arm() }
        $ownedProcessIdentities[$rootProcessId]=$rootIdentity
        $stdoutEncoding=$process.StandardOutput.CurrentEncoding
        $stderrEncoding=$process.StandardError.CurrentEncoding
        $stdoutTask=[BoundedStreamCapture]::DrainAsync($process.StandardOutput.BaseStream,$OutputByteCap)
        $stderrTask=[BoundedStreamCapture]::DrainAsync($process.StandardError.BaseStream,$OutputByteCap)
        $deadline=$started.AddSeconds([math]::Max(0,$TimeoutSeconds))
        while ($true) {
            try { [void](Update-OwnedProcessIdentities $rootIdentity $ownedProcessIdentities $tracker) }
            catch { $ownershipTrackingAvailable=$false; $message=Sanitize-Text $_.Exception.Message; if(-not $ownershipErrors.Contains($message)){$ownershipErrors.Add($message)} }
            $ownedIdentities=@($ownedProcessIdentities.Values)
            $ownedIds=@($ownedIdentities | ForEach-Object {[int]$_.processId})
            $liveIdentities=@(Get-LiveOwnedProcessIdentities $ownedProcessIdentities)
            $liveIds=@($liveIdentities | ForEach-Object {[int]$_.processId})
            if ($Observe -and $liveIds.Count -gt 0) {
                try {
                    $sample=Add-ResourceSample $ownedIdentities $liveIdentities $Label $rootProcessId $observedVramBaseline
                    $resourceSampleCount++
                    if($sample.networkObservationAvailable){$networkSampleSuccessCount++}else{$networkSamplingFailed=$true;foreach($networkError in @($sample.networkErrors)){$message="Descendant TCP observation failed: $networkError";if(-not$samplingErrors.Contains($message)){$samplingErrors.Add($message)}}}
                    if($null-eq$baselineWorkingSet){$baselineWorkingSet=[int64]$sample.aggregateWorkingSetBytes}
                    if([int64]$sample.aggregateWorkingSetBytes-gt$peakWorkingSet){$peakWorkingSet=[int64]$sample.aggregateWorkingSetBytes}
                    if(-not$sample.networkObservationAvailable-and@($sample.networkErrors).Count-eq 0){$message='Get-NetTCPConnection is unavailable; descendant privacy observation is incomplete.';if(-not$samplingErrors.Contains($message)){$samplingErrors.Add($message)}}
                    if($sample.gpu.available){$currentVram=$sample.gpu.systemUsedMiB;if($null-eq$observedVramPeak-or$currentVram-gt$observedVramPeak){$observedVramPeak=$currentVram}}else{$message="Selected GPU observation failed: $($sample.gpu.error)";if(-not$samplingErrors.Contains($message)){$samplingErrors.Add($message)}}
                    $gpuIdentityMismatch=($null-ne$script:SelectedGpu-and(([string]$sample.gpu.deviceUuid -ne [string]$script:SelectedGpu.uuid)-or([int]$sample.gpu.deviceIndex -ne [int]$script:SelectedGpu.index)))
                    if($gpuIdentityMismatch){$message='GPU sampler identity changed from the preflight-selected GTX 1080.';if(-not$samplingErrors.Contains($message)){$samplingErrors.Add($message)}}
                    $gpuPerProcessAttempted=$true
                    if(-not$sample.gpu.perProcessQuerySucceeded){$gpuPerProcessQuerySucceeded=$false;$message="NVIDIA per-process GPU query failed: $($sample.gpu.perProcessError)";if(-not$samplingErrors.Contains($message)){$samplingErrors.Add($message)}}
                    if($sample.gpu.perProcessSupported -eq $true){
                        $gpuPerProcessSupported=$true
                        if($null-eq$baselineOwnedGpuMemory){$baselineOwnedGpuMemory=[double]$sample.gpu.ownedUsedMiB}
                        if($null-eq$peakOwnedGpuMemory-or[double]$sample.gpu.ownedUsedMiB-gt$peakOwnedGpuMemory){$peakOwnedGpuMemory=[double]$sample.gpu.ownedUsedMiB}
                    }
                } catch { $message=Sanitize-Text $_.Exception.Message;if(-not$samplingErrors.Contains($message)){$samplingErrors.Add($message)} }
            }
            if($null-ne$CancellationPredicate-and-not$cancelled-and$liveIds.Count-gt 0){
                $state=[pscustomobject][ordered]@{rootProcessId=$rootProcessId;ownedProcessIds=$ownedIds;ownedProcessIdentities=$ownedIdentities;ownershipEdges=$tracker.ownedEdges.ToArray();elapsedMs=[math]::Round(([DateTime]::UtcNow-$started).TotalMilliseconds,1);baselineSystemVramMiB=$observedVramBaseline;currentSystemVramMiB=$currentVram;aggregateWorkingSetBytes=$peakWorkingSet}
                if([bool](& $CancellationPredicate $state)){$cancelled=$true}
            }
            if($cancelled){$termination=Stop-ProcessTree $rootProcessId $ownedProcessIdentities $TerminationTimeoutMilliseconds $tracker;break}
            if($liveIds.Count-eq 0){break}
            if([DateTime]::UtcNow-ge$deadline){$timedOut=$true;$termination=Stop-ProcessTree $rootProcessId $ownedProcessIdentities $TerminationTimeoutMilliseconds $tracker;break}
            Start-Sleep -Milliseconds 200
        }
    } catch {
        $startError=Sanitize-Text $_.Exception.Message
        if($null-ne$rootProcessId){$termination=Stop-ProcessTree $rootProcessId $ownedProcessIdentities $TerminationTimeoutMilliseconds $tracker}
    } finally {
        Stop-ProcessStartTracker $tracker
        if($null-ne$rootIdentity){
            try{[void](Update-OwnedProcessIdentities $rootIdentity $ownedProcessIdentities $tracker)}catch{$ownershipTrackingAvailable=$false;$message=Sanitize-Text $_.Exception.Message;if(-not$ownershipErrors.Contains($message)){$ownershipErrors.Add($message)}}
            $ownedProcessesRemaining=@(Get-LiveOwnedProcessIdentities $ownedProcessIdentities)
        }
        foreach($message in $tracker.errors.ToArray()){if(-not$ownershipErrors.Contains($message)){$ownershipErrors.Add($message)}}
        $outputTasks=@($stdoutTask,$stderrTask|Where-Object{$null-ne$_})
        if($outputTasks.Count-gt 0){try{[void][Threading.Tasks.Task]::WaitAll([Threading.Tasks.Task[]]$outputTasks,[math]::Max(0,$PipeDrainTimeoutMilliseconds))}catch{}}
        if($null-ne$stdoutTask-and$stdoutTask.Status-eq[Threading.Tasks.TaskStatus]::RanToCompletion){$capture=$stdoutTask.Result;$stdout=$stdoutEncoding.GetString($capture.Bytes);$stdoutTotalBytes=$capture.TotalBytes;$stdoutTruncated=$capture.Truncated;$stdoutComplete=$true}
        if($null-ne$stderrTask-and$stderrTask.Status-eq[Threading.Tasks.TaskStatus]::RanToCompletion){$capture=$stderrTask.Result;$stderr=$stderrEncoding.GetString($capture.Bytes);$stderrTotalBytes=$capture.TotalBytes;$stderrTruncated=$capture.Truncated;$stderrComplete=$true}
        if(-not$stdoutComplete-and$null-ne$stdoutTask){$startError=(@($startError,"Standard output did not close within $PipeDrainTimeoutMilliseconds ms.")|Where-Object{$_})-join' ';try{$process.StandardOutput.Close()}catch{}}
        if(-not$stderrComplete-and$null-ne$stderrTask){$startError=(@($startError,"Standard error did not close within $PipeDrainTimeoutMilliseconds ms.")|Where-Object{$_})-join' ';try{$process.StandardError.Close()}catch{}}
        try{if($process.HasExited){$exitCode=$process.ExitCode}}catch{}
        $process.Dispose()
    }
    $ended=[DateTime]::UtcNow
    $ownedIdentities=@($ownedProcessIdentities.Values)
    $lifecycle=@(Get-ProcessLifecycleEvidence $rootIdentity $ownedProcessIdentities $tracker.ownedEdges $ended)
    foreach($entry in $lifecycle){$script:ProcessLifecycleSamples.Add([pscustomobject][ordered]@{label=$Label;rootPid=$entry.rootPid;processId=$entry.processId;parentProcessId=$entry.parentProcessId;isRoot=$entry.isRoot;source=$entry.source;startTimeUtcTicks=$entry.startTimeUtcTicks;startedUtc=$entry.startedUtc;exitConfirmedByUtc=$entry.exitConfirmedByUtc;exitObserved=$entry.exitObserved})}
    $networkRows=@($script:NetworkSamples | Select-Object -Skip $networkSampleStart)
    $unexpectedNetworkRows=@($networkRows | Where-Object {$_.unexpected})
    $networkObservationAvailable=($resourceSampleCount-gt 0-and$networkSampleSuccessCount-eq$resourceSampleCount-and-not$networkSamplingFailed)
    $workingSetIncrease=if($null-ne$baselineWorkingSet){[int64]$peakWorkingSet-[int64]$baselineWorkingSet}else{$null}
    $vramIncrease=if($null-ne$observedVramBaseline-and$null-ne$observedVramPeak){[double]$observedVramPeak-[double]$observedVramBaseline}else{$null}
    $ownedGpuIncrease=if($gpuPerProcessSupported-and$null-ne$baselineOwnedGpuMemory-and$null-ne$peakOwnedGpuMemory){[double]$peakOwnedGpuMemory-[double]$baselineOwnedGpuMemory}else{$null}
    $record=[ordered]@{
        sequence=$(if($RecordCommand){$script:ProcessSequence}else{$null});label=$Label;executable=Sanitize-Text $FilePath
        arguments=@($Arguments|ForEach-Object{Sanitize-Text $_});workingDirectory=Sanitize-Text $WorkingDirectory;observed=[bool]$Observe
        startedUtc=$started.ToString('o');endedUtc=$ended.ToString('o');durationMs=[math]::Round(($ended-$started).TotalMilliseconds,1)
        timeoutSeconds=$TimeoutSeconds;terminationTimeoutMilliseconds=$TerminationTimeoutMilliseconds;pipeDrainTimeoutMilliseconds=$PipeDrainTimeoutMilliseconds
        outputByteCap=$OutputByteCap;timedOut=$timedOut;cancelled=$cancelled;exitCode=$exitCode;startError=Sanitize-Text $startError
        baselineWorkingSetBytes=$baselineWorkingSet;peakWorkingSetBytes=$peakWorkingSet;workingSetIncreaseBytes=$workingSetIncrease
        selectedGpuIndex=$(if($null-ne$baselineGpu){$baselineGpu.deviceIndex}else{$null});selectedGpuUuid=$(if($null-ne$baselineGpu){$baselineGpu.deviceUuid}else{$null});baselineSystemVramMiB=$observedVramBaseline;peakSystemVramMiB=$observedVramPeak;systemVramIncreaseMiB=$vramIncrease
        resourceSampleCount=$resourceSampleCount;gpuPerProcessQueryAttempted=$gpuPerProcessAttempted;gpuPerProcessQuerySucceeded=(!$Observe-or($gpuPerProcessAttempted-and$gpuPerProcessQuerySucceeded));gpuPerProcessSupported=$gpuPerProcessSupported;baselineOwnedGpuMemoryMiB=$baselineOwnedGpuMemory;peakOwnedGpuMemoryMiB=$peakOwnedGpuMemory;ownedGpuMemoryIncreaseMiB=$ownedGpuIncrease
        networkSampleAttemptCount=$resourceSampleCount;networkSampleSuccessCount=$networkSampleSuccessCount;networkObservationAvailable=(!$Observe-or$networkObservationAvailable);tcpObservationCount=$networkRows.Count;unexpectedNetworkConnectionCount=$unexpectedNetworkRows.Count;unexpectedNetworkConnections=$unexpectedNetworkRows
        rootProcessId=$rootProcessId;rootProcessIdentity=$rootIdentity;ownershipTracking=$tracker.strategy;ownershipTrackingAvailable=($ownershipTrackingAvailable-and$tracker.available);ownershipErrors=$ownershipErrors.ToArray();ownershipEdges=$tracker.ownedEdges.ToArray();processLifecycle=$lifecycle
        ownedProcessIds=@($ownedIdentities|ForEach-Object{[int]$_.processId});ownedProcessIdentities=$ownedIdentities
        ownedProcessesRemaining=@($ownedProcessesRemaining|ForEach-Object{[int]$_.processId});ownedProcessIdentitiesRemaining=$ownedProcessesRemaining;termination=$termination
        outputCaptureComplete=($stdoutComplete-and$stderrComplete);stdoutComplete=$stdoutComplete;stderrComplete=$stderrComplete
        runnerSucceeded=($null-eq$startError-and$ownershipTrackingAvailable-and$tracker.available-and$ownedProcessesRemaining.Count-eq 0-and$termination.succeeded-and$stdoutComplete-and$stderrComplete-and(!$Observe-or$samplingErrors.Count-eq 0))
        stdoutTotalBytes=$stdoutTotalBytes;stderrTotalBytes=$stderrTotalBytes;stdoutTruncated=$stdoutTruncated;stderrTruncated=$stderrTruncated
        samplingErrors=$samplingErrors.ToArray();stdout=Sanitize-Text $stdout;stderr=Sanitize-Text $stderr
    }
    if($RecordCommand){$script:Commands.Add([pscustomobject]$record)}
    return [pscustomobject]$record
}

function Invoke-External {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 120,
        [string]$WorkingDirectory = $script:Scratch,
        [string]$Label = 'process',
        [switch]$Observe,
        [scriptblock]$CancellationPredicate = $null,
        [int]$TerminationTimeoutMilliseconds = 5000,
        [int]$PipeDrainTimeoutMilliseconds = 500,
        [int]$OutputByteCap = 1048576,
        [Collections.IDictionary]$EnvironmentVariables = $null,
        [Text.Encoding]$ProcessOutputEncoding = $null
    )
    return Invoke-BoundedProcess -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $WorkingDirectory -Label $Label -Observe:$Observe -CancellationPredicate $CancellationPredicate -TerminationTimeoutMilliseconds $TerminationTimeoutMilliseconds -PipeDrainTimeoutMilliseconds $PipeDrainTimeoutMilliseconds -OutputByteCap $OutputByteCap -RecordCommand -EnvironmentVariables $EnvironmentVariables -ProcessOutputEncoding $ProcessOutputEncoding
}

function Invoke-QuickProcess([string]$FilePath, [string[]]$Arguments, [int]$TimeoutSeconds = 10) {
    return Invoke-BoundedProcess -FilePath $FilePath -Arguments $Arguments -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $script:RepositoryRoot -Label 'quick-process' -TerminationTimeoutMilliseconds 1000 -PipeDrainTimeoutMilliseconds 250
}

function Get-CurrentVramUsedMiB {
    $observation=Get-GpuObservation @()
    return $observation.systemUsedMiB
}

function Get-ToolVersion([string]$Name, [string[]]$Arguments = @('--version')) {
    $command = Get-Command $Name -ErrorAction SilentlyContinue
    if (-not $command) { return [ordered]@{ found=$false; path=$null; version=$null } }
    $result = Invoke-External -FilePath $command.Source -Arguments $Arguments -TimeoutSeconds 20 -WorkingDirectory $script:RepositoryRoot -Label "version-$Name"
    return [ordered]@{ found=($result.exitCode -eq 0); path=(Sanitize-Text $command.Source); version=((@($result.stdout, $result.stderr) -join "`n").Trim()) }
}

function New-SpikeWorkspace {
    throw 'Recovered validation runner is test-only; workspace creation is intentionally disabled.'
}

function Test-Prerequisites {
    $os = Get-CimInstance Win32_OperatingSystem
    $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
    $computer = Get-CimInstance Win32_ComputerSystem
    $drive = Get-PSDrive -Name ([IO.Path]::GetPathRoot($script:Scratch).Substring(0,1))
    $gpuRows = @()
    $nvidia = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
    if ($nvidia) {
        $gpuQuery = Invoke-External $nvidia.Source @('--query-gpu=index,uuid,name,driver_version,memory.total,memory.free,compute_cap','--format=csv,noheader,nounits') 20 $script:Scratch 'preflight-gpu'
        if($gpuQuery.exitCode -eq 0){$gpuRows=@(ConvertFrom-NvidiaGpuInventoryCsv @($gpuQuery.stdout -split "`r?`n"))}
    }
    $script:SelectedGpu = Select-ValidationGpu $gpuRows
    $script:BaselineVramMiB = Get-CurrentVramUsedMiB
    $tools = [ordered]@{
        powershell = [ordered]@{ found=$true; path=(Sanitize-Text (Get-Process -Id $PID).Path); version=$PSVersionTable.PSVersion.ToString() }
        git = Get-ToolVersion git @('--version')
        cmake = Get-ToolVersion cmake @('--version')
        ninja = Get-ToolVersion ninja @('--version')
        ffmpeg = Get-ToolVersion ffmpeg @('-version')
        nvcc = Get-ToolVersion nvcc @('--version')
        cuobjdump = Get-ToolVersion cuobjdump @('--version')
        vulkaninfo = Get-ToolVersion vulkaninfo @('--summary')
    }
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $msvc = [ordered]@{ found=$false; installationPath=$null; version=$null; dumpbin=$null }
    if (Test-Path -LiteralPath $vswhere) {
        $install = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
        if ($install) {
            $versionRoot = Join-Path $install 'VC\Tools\MSVC'
            $versionDir = Get-ChildItem -LiteralPath $versionRoot -Directory -ErrorAction SilentlyContinue | Sort-Object Name -Descending | Select-Object -First 1
            if ($versionDir) {
                $dumpbin = Join-Path $versionDir.FullName 'bin\Hostx64\x64\dumpbin.exe'
                $msvc = [ordered]@{ found=$true; installationPath=(Sanitize-Text $install); version=$versionDir.Name; dumpbin=(Sanitize-Text $dumpbin); dumpbinExists=(Test-Path -LiteralPath $dumpbin) }
            }
        }
    }
    $targetGpu = @($gpuRows | Where-Object { $_.name -eq 'NVIDIA GeForce GTX 1080' -and $_.computeCapability -eq '6.1' })
    $freeGiB = [math]::Round($drive.Free / 1GB, 2)
    $required = [ordered]@{
        windowsX64 = ([Environment]::Is64BitOperatingSystem)
        git = $tools.git.found
        cmake = $tools.cmake.found
        ninja = $tools.ninja.found
        ffmpeg = $tools.ffmpeg.found
        msvcX64 = $msvc.found
        cudaToolkit = ($tools.nvcc.found -and $tools.cuobjdump.found)
        vulkanTools = $tools.vulkaninfo.found
        gtx1080Compute61 = ($targetGpu.Count -eq 1)
        freeVram = ($targetGpu.Count -eq 1 -and $targetGpu[0].freeVramMiB -ge [int]$script:Thresholds.requirements.freeVramMiB)
        scratchDisk = ($freeGiB -ge [double]$script:Thresholds.requirements.scratchFreeGiB)
    }
    $failedRequirements = @($required.Keys | Where-Object { -not $required[$_] })
    foreach ($name in $failedRequirements) { Add-Failure "Preflight requirement failed: $name" }
    $safeToContinue = $required.windowsX64 -and $required.scratchDisk -and $required.gtx1080Compute61 -and $required.freeVram
    $preflightStatus = if ($failedRequirements.Count -eq 0) { 'PASS' } else { 'FAIL' }
    $preflightReason = if ($failedRequirements.Count -eq 0) { 'All bounded machine, disk, GPU, and toolchain prerequisites passed.' } else { 'Failed prerequisites: ' + ($failedRequirements -join ', ') + '.' }
    $windowsSdkRegistry = Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Microsoft SDKs\Windows\v10.0' -Name ProductVersion -ErrorAction SilentlyContinue
    $windowsSdkVersion = if ($null -ne $windowsSdkRegistry) { $windowsSdkRegistry.ProductVersion } else { $null }
    $state = [ordered]@{
        schemaVersion=2
        status=$preflightStatus
        reason=$preflightReason
        capturedUtc=[DateTime]::UtcNow.ToString('o')
        os=[ordered]@{ caption=$os.Caption; version=$os.Version; build=$os.BuildNumber; architecture=$os.OSArchitecture }
        cpu=[ordered]@{ name=$cpu.Name.Trim(); logicalProcessors=$cpu.NumberOfLogicalProcessors }
        ramBytes=[int64]$computer.TotalPhysicalMemory
        gpu=$gpuRows
        selectedGpu=$script:SelectedGpu
        baselineSystemVramMiB=$script:BaselineVramMiB
        scratchFreeGiB=$freeGiB
        tools=$tools
        msvc=$msvc
        windowsSdk=[ordered]@{ registryVersion=$windowsSdkVersion }
        vulkanSdk=[ordered]@{ configured=([bool]$env:VULKAN_SDK); path=(Sanitize-Text $env:VULKAN_SDK) }
        required=$required
        safeToContinue=$safeToContinue
    }
    Write-Json (Join-Path $script:RawRoot 'preflight.json') $state
    return $state
}

function Get-ObservedPatchManifest([string]$Source) {
    $patchRoot = Join-Path $Source 'ggml-patches'
    if (-not (Test-Path -LiteralPath $patchRoot -PathType Container)) { return @() }
    return @(Get-ChildItem -LiteralPath $patchRoot -Filter '*.patch' -File -ErrorAction Stop | Sort-Object Name | ForEach-Object {
        [ordered]@{ path=("ggml-patches/" + $_.Name); sha256=Get-Sha256 $_.FullName }
    })
}

function Get-DeterministicGitArguments([string[]]$Arguments = @()) {
    return @('-c','core.autocrlf=false','-c','core.eol=lf','-c','core.longpaths=true','-c','credential.helper=','-c','credential.interactive=never') + @($Arguments)
}

function Get-SanitizedGitEnvironment([string]$IndexFile = $null) {
    $environment = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables().GetEnumerator()) {
        if (-not ([string]$entry.Key).StartsWith('GIT_', [StringComparison]::OrdinalIgnoreCase)) { $environment[[string]$entry.Key] = [string]$entry.Value }
    }
    $environment['GIT_CONFIG_GLOBAL'] = 'NUL'
    $environment['GIT_CONFIG_SYSTEM'] = 'NUL'
    $environment['GIT_CONFIG_NOSYSTEM'] = '1'
    $environment['GIT_TERMINAL_PROMPT'] = '0'
    $environment['GCM_INTERACTIVE'] = 'Never'
    if (-not [string]::IsNullOrWhiteSpace($IndexFile)) { $environment['GIT_INDEX_FILE'] = $IndexFile }
    return $environment
}

function Invoke-SourceGit {
    param(
        [Parameter(Mandatory=$true)][string[]]$Arguments,
        [int]$TimeoutSeconds = 120,
        [string]$WorkingDirectory = $script:Scratch,
        [string]$Label = 'source-git',
        [string]$IndexFile = $null,
        [int]$OutputByteCap = 1048576
    )
    $git = (Get-Command git -ErrorAction Stop).Source
    return Invoke-External -FilePath $git -Arguments (Get-DeterministicGitArguments $Arguments) -TimeoutSeconds $TimeoutSeconds -WorkingDirectory $WorkingDirectory -Label $Label -OutputByteCap $OutputByteCap -EnvironmentVariables (Get-SanitizedGitEnvironment $IndexFile) -ProcessOutputEncoding ([Text.Encoding]::UTF8)
}

function Test-CompleteGitCapture($Run) {
    return ($Run.exitCode -eq 0 -and -not $Run.timedOut -and $Run.outputCaptureComplete -and -not $Run.stdoutTruncated -and -not $Run.stderrTruncated)
}

function Get-GitDirtyState([string]$Repository, [string]$Label) {
    $outputByteCap = 262144
    $statusRun = Invoke-SourceGit -Arguments @('-C',$Repository,'status','--porcelain=v1','-z','--untracked-files=all') -TimeoutSeconds 120 -WorkingDirectory $script:Scratch -Label "$Label-status" -OutputByteCap $outputByteCap
    $stagedRawRun = Invoke-SourceGit -Arguments @('-C',$Repository,'diff','--cached','--raw','--no-abbrev','-z','--no-ext-diff','--no-textconv','--') -TimeoutSeconds 120 -WorkingDirectory $script:Scratch -Label "$Label-staged-raw" -OutputByteCap $outputByteCap
    $stagedNumstatRun = Invoke-SourceGit -Arguments @('-C',$Repository,'diff','--cached','--numstat','-z','--no-ext-diff','--no-textconv','--') -TimeoutSeconds 120 -WorkingDirectory $script:Scratch -Label "$Label-staged-numstat" -OutputByteCap $outputByteCap
    $unstagedRawRun = Invoke-SourceGit -Arguments @('-C',$Repository,'diff','--raw','--no-abbrev','-z','--no-ext-diff','--no-textconv','--') -TimeoutSeconds 120 -WorkingDirectory $script:Scratch -Label "$Label-unstaged-raw" -OutputByteCap $outputByteCap
    $unstagedNumstatRun = Invoke-SourceGit -Arguments @('-C',$Repository,'diff','--numstat','-z','--no-ext-diff','--no-textconv','--') -TimeoutSeconds 120 -WorkingDirectory $script:Scratch -Label "$Label-unstaged-numstat" -OutputByteCap $outputByteCap
    $issues = @()
    $statusEntries = @()
    $statusCaptureSucceeded = Test-CompleteGitCapture $statusRun
    if ($statusCaptureSucceeded) {
        try { $statusEntries = @(ConvertFrom-GitPorcelainStatus ([string]$statusRun.stdout)) } catch { $statusCaptureSucceeded = $false; $issues += $_.Exception.Message }
    }
    if (-not $statusCaptureSucceeded) { $issues += "$Label Git status failed, was truncated, or was malformed" }
    $stagedCaptureSucceeded = ((Test-CompleteGitCapture $stagedRawRun) -and (Test-CompleteGitCapture $stagedNumstatRun))
    $unstagedCaptureSucceeded = ((Test-CompleteGitCapture $unstagedRawRun) -and (Test-CompleteGitCapture $unstagedNumstatRun))
    if (-not $stagedCaptureSucceeded) { $issues += "$Label staged Git diff evidence failed or was truncated" }
    if (-not $unstagedCaptureSucceeded) { $issues += "$Label unstaged Git diff evidence failed or was truncated" }
    $captureSucceeded = ($statusCaptureSucceeded -and $stagedCaptureSucceeded -and $unstagedCaptureSucceeded)
    return [ordered]@{
        clean=($captureSucceeded -and $statusEntries.Count -eq 0)
        captureSucceeded=$captureSucceeded
        statusCaptureSucceeded=$statusCaptureSucceeded
        statusFormat='porcelain-v1-z'
        status=@($statusEntries)
        trackedChanges=[ordered]@{
            staged=[ordered]@{ comparison='HEAD-to-index'; rawFormat='git-diff-raw-z'; raw=$stagedRawRun.stdout; rawBytes=$stagedRawRun.stdoutTotalBytes; numstatFormat='git-diff-numstat-z'; numstat=$stagedNumstatRun.stdout; numstatBytes=$stagedNumstatRun.stdoutTotalBytes; complete=$stagedCaptureSucceeded; outputByteCap=$outputByteCap }
            unstaged=[ordered]@{ comparison='index-to-worktree'; rawFormat='git-diff-raw-z'; raw=$unstagedRawRun.stdout; rawBytes=$unstagedRawRun.stdoutTotalBytes; numstatFormat='git-diff-numstat-z'; numstat=$unstagedNumstatRun.stdout; numstatBytes=$unstagedNumstatRun.stdoutTotalBytes; complete=$unstagedCaptureSucceeded; outputByteCap=$outputByteCap }
        }
        issues=$issues
    }
}

function Get-SourceProvenance([string]$Source, [string]$Label, [bool]$RequireClean) {
    $headRun = Invoke-SourceGit @('-C',$Source,'rev-parse','HEAD') 60 $script:Scratch "$Label-head"
    $treeRun = Invoke-SourceGit @('-C',$Source,'rev-parse','HEAD^{tree}') 60 $script:Scratch "$Label-tree"
    $originRun = Invoke-SourceGit @('-C',$Source,'remote','get-url','origin') 60 $script:Scratch "$Label-origin"
    $branchRun = Invoke-SourceGit @('-C',$Source,'symbolic-ref','-q','HEAD') 60 $script:Scratch "$Label-detached"
    $fsckRun = Invoke-SourceGit @('-C',$Source,'fsck','--full') 600 $script:Scratch "$Label-fsck"
    $dirtyState = Get-GitDirtyState $Source $Label
    $ignoredRun = Invoke-SourceGit @('-C',$Source,'clean','-ndX') 120 $script:Scratch "$Label-ignored"
    $submoduleStatusRun = Invoke-SourceGit @('-C',$Source,'submodule','status','--recursive') 120 $script:Scratch "$Label-submodule-status"
    $submoduleOriginsRun = Invoke-SourceGit @('-C',$Source,'submodule','foreach','--recursive','--quiet','printf "%s\t%s\t%s\n" "$displaypath" "$(git rev-parse HEAD)" "$(git remote get-url origin)"') 300 $script:Scratch "$Label-submodule-origins"
    $submoduleIgnoredRun = Invoke-SourceGit @('-C',$Source,'submodule','foreach','--recursive','--quiet','git clean -ndX | sed "s|^|$displaypath\t|"') 300 $script:Scratch "$Label-submodule-ignored"
    $head = $headRun.stdout.Trim()
    $tree = $treeRun.stdout.Trim()
    $origin = $originRun.stdout.Trim()
    $branch = $branchRun.stdout.Trim()
    $issues = @($dirtyState.issues)
    $statusEntries = @($dirtyState.status)
    $statusCaptureSucceeded = $dirtyState.statusCaptureSucceeded
    $submodules = Get-SubmoduleProvenance $script:Lock.runtime.submodules $submoduleStatusRun $submoduleOriginsRun
    $patches = Get-PatchManifestProvenance $script:Lock.runtime.patches.files (Get-ObservedPatchManifest $Source)
    foreach ($commandRun in @($headRun,$treeRun,$originRun,$fsckRun,$ignoredRun,$submoduleIgnoredRun)) { if ($commandRun.exitCode -ne 0 -or $commandRun.timedOut) { $issues += "$Label Git provenance command failed or timed out" } }
    if ($branchRun.timedOut -or $branchRun.exitCode -notin @(0,1)) { $issues += "$Label detached-HEAD command failed or timed out" }
    if ($ignoredRun.stdout.Trim() -or $submoduleIgnoredRun.stdout.Trim()) { $issues += "$Label contains ignored files outside the immutable source tree" }
    if ($head -cne [string]$script:Lock.runtime.commit) { $issues += "$Label HEAD does not match the immutable runtime commit" }
    if ($tree -cne [string]$script:Lock.runtime.tree) { $issues += "$Label tree does not match the immutable runtime tree" }
    if (-not (Test-ExactHttpsUrl $origin ([string]$script:Lock.runtime.repository))) { $issues += "$Label origin is not the exact pinned HTTPS URL" }
    if ($branch) { $issues += "$Label HEAD is not detached" }
    $clean = $dirtyState.clean
    if ($RequireClean -and -not $clean) { $issues += "$Label superproject is not clean" }
    if (-not $submodules.verified) { $issues += @($submodules.issues | ForEach-Object { "$Label $_" }) }
    if (-not $patches.verified) { $issues += @($patches.issues | ForEach-Object { "$Label $_" }) }
    return [ordered]@{ verified=($issues.Count -eq 0); issues=$issues; origin=$origin; head=$head; tree=$tree; detached=([bool](-not $branch)); fsckExit=$fsckRun.exitCode; clean=$clean; status=@($statusEntries); statusFormat=$dirtyState.statusFormat; dirtyState=$dirtyState; ignoredFiles=@($ignoredRun.stdout.Trim(),$submoduleIgnoredRun.stdout.Trim() | Where-Object { $_ }); submodules=$submodules; patches=$patches }
}

function Get-VerifiedSource {
    $script:SourceAcquisitionState = $null
    $source = Join-Path $script:Scratch 'source-pinned'
    $clone = Invoke-SourceGit @('clone','--no-checkout',$script:Lock.runtime.repository,$source) $AcquisitionTimeoutSeconds $script:Scratch 'source-clone'
    if ($clone.exitCode -ne 0 -or $clone.timedOut) { throw "Runtime clone failed: $($clone.stderr)" }
    $checkout = Invoke-SourceGit @('-C',$source,'checkout','--detach',$script:Lock.runtime.commit) 300 $script:Scratch 'source-checkout'
    $submodule = Invoke-SourceGit @('-C',$source,'submodule','update','--init','--recursive') $AcquisitionTimeoutSeconds $script:Scratch 'source-submodules'
    if ($checkout.exitCode -ne 0 -or $checkout.timedOut -or $submodule.exitCode -ne 0 -or $submodule.timedOut) { throw 'Pinned checkout or recursive submodule acquisition failed.' }
    $provenance = Get-SourceProvenance $source 'source' $true
    # Retain local evidence before the commit API or license I/O can throw.
    $state = [ordered]@{ path=$source; verified=$false; provenance=$provenance; origin=$provenance.origin; head=$provenance.head; tree=$provenance.tree; detached=$provenance.detached; fsckExit=$provenance.fsckExit; clean=$provenance.clean; commitVerified=$false; commitApiSha256=$null; licenseSha256=$null; license=$null; submodules=$provenance.submodules.status; submoduleOrigins=$provenance.submodules.origins; commitApi=[ordered]@{status='PENDING';error=$null}; licenseCheck=[ordered]@{status='PENDING';error=$null} }
    $script:SourceAcquisitionState = $state
    $apiPath = Join-Path $script:Scratch 'commit-api.json'
    $headers = @{ 'User-Agent'='supa-video-produzah-evidence-spike'; 'Accept'='application/vnd.github+json' }
    try {
        $apiResponse = Invoke-WebRequest -UseBasicParsing -Uri $script:Lock.runtime.commitApi -Headers $headers -MaximumRedirection 5 -TimeoutSec 60
        Write-Utf8Text $apiPath $apiResponse.Content
        $state.commitApiSha256 = Get-Sha256 $apiPath
        $api = $apiResponse.Content | ConvertFrom-Json
        $state.commitVerified = ($api.commit.verification.verified -is [bool] -and $api.commit.verification.verified -eq $true)
        if (-not $state.commitVerified) { throw 'Commit API did not confirm verification.' }
        $state.commitApi.status = 'PASS'
    } catch {
        $state.commitApi.status = 'FAIL'
        $state.commitApi.error = Sanitize-Text $_.Exception.Message
        throw
    }
    $licensePath = Join-Path $source 'LICENSE'
    try {
        $licenseText = Get-Content -LiteralPath $licensePath -Raw -ErrorAction Stop
        $state.licenseSha256 = Get-Sha256 $licensePath
        if ($licenseText -notmatch 'Apache License') { throw 'Runtime license was not Apache-2.0.' }
        $state.license = 'Apache-2.0'
        $state.licenseCheck.status = 'PASS'
    } catch {
        $state.licenseCheck.status = 'FAIL'
        $state.licenseCheck.error = Sanitize-Text $_.Exception.Message
        throw
    }
    $verified = $provenance.verified
    if (-not $verified) { Add-Failure ('Pinned runtime provenance verification failed: ' + (@($provenance.issues) -join '; ')) }
    $statusJson = ConvertTo-Json -InputObject @($provenance.status) -Depth 5 -Compress
    Write-Utf8Text (Join-Path $script:RawRoot 'source-state.txt') ("origin=$($provenance.origin)`nhead=$($provenance.head)`ntree=$($provenance.tree)`ndetached=$($provenance.detached)`nstatusFormat=$($provenance.statusFormat)`nstatus=$statusJson`nfsckExit=$($provenance.fsckExit)`nsubmodulesVerified=$($provenance.submodules.verified)`npatchesVerified=$($provenance.patches.verified)`ncommitApiSha256=$(Get-Sha256 $apiPath)`ncommitVerified=$($api.commit.verification.verified)`nlicenseSha256=$(Get-Sha256 $licensePath)`nlicense=Apache-2.0`n")
    Write-Utf8Text (Join-Path $script:RawRoot 'submodules.txt') ("status:`n$($provenance.submodules.status | ConvertTo-Json -Depth 5)`n`norigins:`n$($provenance.submodules.origins | ConvertTo-Json -Depth 5)`n")
    $state.verified = $verified
    return $state
}

function Copy-VerifiedSource([string]$PinnedSource, [string]$Backend) {
    $target = Join-Path $script:Scratch "source-$Backend"
    $clone = Invoke-SourceGit @('clone','--no-hardlinks','--recurse-submodules',$PinnedSource,$target) $AcquisitionTimeoutSeconds $script:Scratch "source-copy-$Backend"
    if ($clone.exitCode -ne 0 -or $clone.timedOut) { throw "$Backend independent source clone failed." }
    $checkout = Invoke-SourceGit @('-C',$target,'checkout','--detach',$script:Lock.runtime.commit) 120 $script:Scratch "source-checkout-$Backend"
    $remote = Invoke-SourceGit @('-C',$target,'remote','set-url','origin',$script:Lock.runtime.repository) 60 $script:Scratch "source-origin-$Backend"
    if ($checkout.exitCode -ne 0 -or $checkout.timedOut -or $remote.exitCode -ne 0 -or $remote.timedOut) { throw "$Backend independent source setup failed." }
    $provenance = Get-SourceProvenance $target "source-copy-$Backend" $true
    if (-not $provenance.verified) { throw "$Backend independent source verification failed: $(@($provenance.issues) -join '; ')" }
    return [ordered]@{ path=$target; provenance=$provenance }
}

function Get-PeArchitecture([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        $reader = New-Object IO.BinaryReader($stream)
        $stream.Position = 0x3c
        $peOffset = $reader.ReadInt32()
        $stream.Position = $peOffset + 4
        $machine = $reader.ReadUInt16()
        if ($machine -eq 0x8664) { return 'x64' }
        return ('0x{0:x4}' -f $machine)
    } finally { $stream.Dispose() }
}

function Get-GitWorktreeTree([string]$Repository, [string]$Label) {
    $indexPath = Join-Path $script:Scratch "$Label.index"
    Remove-Item -LiteralPath $indexPath -Force -ErrorAction SilentlyContinue
    try {
        $read = Invoke-SourceGit @('-C',$Repository,'read-tree','HEAD') 60 $script:Scratch "$Label-read-tree" $indexPath
        if ($read.exitCode -ne 0 -or $read.timedOut) { return $read }
        $add = Invoke-SourceGit @('-C',$Repository,'add','-A') 120 $script:Scratch "$Label-add" $indexPath
        if ($add.exitCode -ne 0 -or $add.timedOut) { return $add }
        return Invoke-SourceGit @('-C',$Repository,'write-tree') 60 $script:Scratch "$Label-write-tree" $indexPath
    } finally {
        Remove-Item -LiteralPath $indexPath -Force -ErrorAction SilentlyContinue
    }
}

function Build-PinnedBackend([string]$PinnedSource, [ValidateSet('cuda','vulkan','cpu')][string]$Backend, $Preflight) {
    $copyState = Copy-VerifiedSource $PinnedSource $Backend
    $source = $copyState.path
    $build = Join-Path $script:Scratch "build-$Backend"
    $exe = Join-Path $build 'bin\nemo-speech.exe'
    $executablePreexisted = Test-Path -LiteralPath $exe -PathType Leaf
    $logPath = Join-Path $script:RawRoot $(if ($Backend -eq 'cpu') { 'build-cpu-diagnostic.log' } else { "build-$Backend.log" })
    $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',(Join-Path $source 'scripts\windows\build.ps1'),'-Backend',$Backend,'-Config',$script:Lock.builds.config,'-BuildDir',$build)
    if ($Backend -eq 'cuda') { $args += @('-CudaArch',$script:Lock.builds.cudaArch) }
    $args += '-AsrOnly'
    $powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
    $run = Invoke-External $powershell $args $BuildTimeoutSeconds $source "build-$Backend"
    Write-Utf8Text $logPath ("COMMAND: powershell.exe $((@($args | ForEach-Object { Sanitize-Text $_ })) -join ' ')`nEXIT: $($run.exitCode)`nTIMED_OUT: $($run.timedOut)`n--- STDOUT ---`n$($run.stdout)`n--- STDERR ---`n$($run.stderr)`n")
    $binaryExists = Test-Path -LiteralPath $exe -PathType Leaf
    $exactExecutableProvenance = (-not $executablePreexisted -and $binaryExists)
    $inspection = [ordered]@{ backend=$Backend; buildExit=$run.exitCode; timedOut=$run.timedOut; source=(Sanitize-Text $source); buildDir=(Sanitize-Text $build); expectedExecutable=(Sanitize-Text $exe); executablePreexisted=$executablePreexisted; executableExists=$binaryExists; exactExecutableProvenance=$exactExecutableProvenance; sha256=$null; peArchitecture=$null; dumpbin=$null; cmakeCachePresent=$false; cmakeCacheSha256=$null; cmakeCacheSm61=$false; compilerCache=$null; cuobjdumpRan=$false; cuobjdumpExit=$null; cuobjdumpTimedOut=$false; cuobjdumpSm61=$false; cudaSm61=$false; versionExit=$null; versionTimedOut=$false; runnable=$false; sourceDiff=$null; unexpectedSourceMutation=$false; sourceProvenance=$copyState.provenance; postSourceProvenance=$null; mutationProvenance=$null; provenanceVerified=$false }
    $cache = Join-Path $build 'CMakeCache.txt'
    $inspection.cmakeCachePresent = Test-Path -LiteralPath $cache -PathType Leaf
    $cacheFields = [ordered]@{}
    if ($inspection.cmakeCachePresent) {
        $cacheText = Get-Content -LiteralPath $cache -Raw
        $inspection.cmakeCacheSha256 = Get-Sha256 $cache
        try { $cacheFields = ConvertFrom-CMakeCache $cacheText } catch { $cacheFields = [ordered]@{} }
        if ($Backend -eq 'cuda' -and $cacheFields.Contains('CMAKE_CUDA_ARCHITECTURES')) { $inspection.cmakeCacheSm61 = ($cacheFields.CMAKE_CUDA_ARCHITECTURES.value -ceq [string]$script:Lock.builds.cudaArch) }
    }
    $msvcInstall = if ($Preflight.msvc.installationPath) { $Preflight.msvc.installationPath.Replace('<USER_PROFILE>', $env:USERPROFILE).Replace('<SCRATCH>', $script:Scratch) } else { $null }
    $cl = if ($msvcInstall -and $Preflight.msvc.version) { Join-Path $msvcInstall "VC\Tools\MSVC\$($Preflight.msvc.version)\bin\Hostx64\x64\cl.exe" } else { $null }
    $nvcc = if ($Preflight.tools.nvcc.path) { $Preflight.tools.nvcc.path.Replace('<USER_PROFILE>', $env:USERPROFILE).Replace('<SCRATCH>', $script:Scratch) } else { $null }
    $compilerExpected = [ordered]@{ generator=$script:Lock.builds.generator; config=$script:Lock.builds.config; cCompiler=$cl; cxxCompiler=$cl; cudaCompiler=$nvcc; cudaHostCompiler=$cl; cudaArch=$script:Lock.builds.cudaArch }
    $inspection.compilerCache = Get-CompilerCacheProvenance $cacheFields $Backend $compilerExpected
    if ($binaryExists) {
        $inspection.sha256 = Get-Sha256 $exe
        $inspection.peArchitecture = Get-PeArchitecture $exe
        $dumpbinPath = $Preflight.msvc.dumpbin
        if ($dumpbinPath) { $dumpbinPath = $dumpbinPath.Replace('<USER_PROFILE>', $env:USERPROFILE).Replace('<SCRATCH>', $script:Scratch) }
        if ($dumpbinPath -and (Test-Path -LiteralPath $dumpbinPath)) {
            $dump = Invoke-External $dumpbinPath @('/headers','/dependents',$exe) 60 $script:Scratch "dumpbin-$Backend"
            $inspection.dumpbin = $dump.stdout
        }
        if ($Backend -eq 'cuda' -and $Preflight.tools.cuobjdump.found) {
            $cuobjdumpPath = $Preflight.tools.cuobjdump.path.Replace('<USER_PROFILE>', $env:USERPROFILE).Replace('<SCRATCH>', $script:Scratch)
            $cu = Invoke-External $cuobjdumpPath @('--list-elf',$exe) 60 $script:Scratch 'cuobjdump-cuda'
            $inspection.cuobjdumpRan = $true
            $inspection.cuobjdumpExit = $cu.exitCode
            $inspection.cuobjdumpTimedOut = $cu.timedOut
            $inspection.cuobjdumpSm61 = [bool](($cu.stdout + $cu.stderr) -match 'sm_61')
        }
        $inspection.cudaSm61 = ($inspection.cmakeCachePresent -and $inspection.cmakeCacheSm61 -and $inspection.cuobjdumpRan -and $inspection.cuobjdumpExit -eq 0 -and -not $inspection.cuobjdumpTimedOut -and $inspection.cuobjdumpSm61)
        if ($run.exitCode -eq 0 -and -not $run.timedOut -and $inspection.exactExecutableProvenance) {
            $version = Invoke-External $exe @('--version') 30 $script:Scratch "version-$Backend"
            $inspection.versionExit = $version.exitCode
            $inspection.versionTimedOut = $version.timedOut
            $inspection.runnable = ($version.exitCode -eq 0 -and -not $version.timedOut)
        }
    }
    $postSource = Get-SourceProvenance $source "post-build-source-$Backend" $false
    $ggmlTreeRun = Get-GitWorktreeTree (Join-Path $source 'ggml') "post-build-ggml-$Backend"
    $mutation = Get-PostBuildMutationProvenance $Backend ([ordered]@{ exitCode=0; timedOut=$false; status=@($postSource.status) }) $ggmlTreeRun $run.exitCode $script:Lock.runtime.patches
    $inspection.sourceDiff = $postSource.status
    $inspection.postSourceProvenance = $postSource
    $inspection.mutationProvenance = $mutation
    $inspection.unexpectedSourceMutation = -not $mutation.verified
    $inspection.provenanceVerified = ($copyState.provenance.verified -and $postSource.verified -and $mutation.verified -and $inspection.compilerCache.verified)
    foreach ($issue in @(Get-BackendBuildIssues $inspection $Backend)) { Add-BackendBuildIssue $Backend $issue }
    $script:BackendResults[$Backend] = $inspection
    return $inspection
}

function Get-VerifiedModel {
    $destination = Join-Path $script:Scratch $script:Lock.model.file
    $metadataPath = Join-Path $script:Scratch 'model-metadata.json'
    $script:ModelState = [ordered]@{
        verified=$false
        metadata=[ordered]@{ verified=$false; acquisition=$null; responseSha256=$null; issues=@(); repositoryId=$null; revision=$null; file=$null; license=$null }
        download=$null
        bytes=$null
        sha256=$null
        license=$null
        licenseUrl=$null
        redistributionWarning='Model redistribution remains unresolved; weights are not persisted in this repository.'
    }

    $metadataUriBuilder = New-Object UriBuilder([string]$script:Lock.model.metadataUrl)
    $metadataUriBuilder.Query = 'blobs=true'
    $metadataAcquisition = Invoke-BoundedHttpRequest -Uri $metadataUriBuilder.Uri.AbsoluteUri -DestinationPath $metadataPath -MaximumBytes 4194304 -MaximumAttempts 3 -MaximumRedirects 5 -TimeoutSeconds 60 -AllowedHosts @($script:Lock.model.acquisitionHosts)
    $script:ModelState.metadata.acquisition = $metadataAcquisition
    if (-not $metadataAcquisition.succeeded) {
        Add-Failure 'Pinned model metadata acquisition failed inside its retry, redirect, timeout, or byte bound.'
        throw 'Pinned model metadata acquisition failed closed before model download.'
    }

    $script:ModelState.metadata.responseSha256 = Get-Sha256 $metadataPath
    try {
        $metadataDocument = Get-Content -LiteralPath $metadataPath -Raw | ConvertFrom-Json
        $metadataVerification = Test-PinnedModelMetadata $metadataDocument $script:Lock.model
    } catch {
        $script:ModelState.metadata.issues = @('metadata response was not valid JSON with the required provenance shape')
        Add-Failure 'Pinned model metadata response was malformed.'
        throw 'Pinned model metadata validation failed closed before model download.'
    }
    foreach ($field in @('verified','issues','repositoryId','revision','file','license')) { $script:ModelState.metadata[$field] = $metadataVerification[$field] }
    $script:ModelState.license = $metadataVerification.license.name
    $script:ModelState.licenseUrl = $metadataVerification.license.url
    if (-not $metadataVerification.verified) {
        Add-Failure ('Pinned model metadata provenance failed: ' + (@($metadataVerification.issues) -join '; '))
        throw 'Pinned model metadata validation failed closed before model download.'
    }

    $downloadAcquisition = Invoke-BoundedHttpRequest -Uri ([string]$script:Lock.model.url) -DestinationPath $destination -MaximumBytes ([int64]$script:Lock.model.bytes) -MaximumAttempts 3 -MaximumRedirects 5 -TimeoutSeconds $AcquisitionTimeoutSeconds -AllowedHosts @($script:Lock.model.acquisitionHosts)
    $script:ModelState.download = $downloadAcquisition
    if (-not $downloadAcquisition.succeeded) {
        Add-Failure 'Pinned model download failed inside its retry, redirect, timeout, or byte bound.'
        throw 'Pinned model download failed closed before execution.'
    }

    $bytes = (Get-Item -LiteralPath $destination).Length
    $sha = Get-Sha256 $destination
    $payloadVerified = ($bytes -eq [int64]$script:Lock.model.bytes -and $sha -ceq [string]$script:Lock.model.sha256)
    $script:ModelState.bytes = $bytes
    $script:ModelState.sha256 = $sha
    $script:ModelState.verified = ($metadataVerification.verified -and $downloadAcquisition.succeeded -and $payloadVerified)
    if (-not $script:ModelState.verified) {
        Remove-Item -LiteralPath $destination -Force -ErrorAction SilentlyContinue
        Add-Failure 'Model byte count or SHA-256 did not match the metadata-validated immutable pin.'
        throw 'Pinned model verification failed closed before execution.'
    }
    return [ordered]@{ path=$destination; evidence=$script:ModelState }
}

. (Join-Path $script:EvidenceRoot 'fixture-generation.ps1')

function Normalize-Transcript([AllowNull()][string]$Text) {
    if (-not $Text) { return '' }
    $normalized = $Text.Normalize([Text.NormalizationForm]::FormKC).ToLowerInvariant()
    $normalized = [regex]::Replace($normalized, '[^\p{L}\p{Nd}]+', ' ')
    return [regex]::Replace($normalized.Trim(), '\s+', ' ')
}

function Get-WerMeasurement([string]$Reference, [string]$Hypothesis) {
    $r = @((Normalize-Transcript $Reference) -split ' ' | Where-Object { $_ })
    $h = @((Normalize-Transcript $Hypothesis) -split ' ' | Where-Object { $_ })
    $rCount = $r.Count
    $hCount = $h.Count
    if ($rCount -eq 0) { return $null }
    $d = New-Object 'int[,]' ($rCount + 1), ($hCount + 1)
    for ($i=0; $i -le $rCount; $i++) { $d[$i,0] = $i }
    for ($j=0; $j -le $hCount; $j++) { $d[0,$j] = $j }
    for ($i=1; $i -le $rCount; $i++) {
        $previousI = $i - 1
        for ($j=1; $j -le $hCount; $j++) {
            $previousJ = $j - 1
            $cost = if ($r[$previousI] -eq $h[$previousJ]) { 0 } else { 1 }
            $deletion = $d[$previousI,$j] + 1
            $insertion = $d[$i,$previousJ] + 1
            $substitution = $d[$previousI,$previousJ] + $cost
            $d[$i,$j] = [math]::Min([math]::Min($deletion,$insertion),$substitution)
        }
    }
    $distance = $d[$rCount,$hCount]
    return [ordered]@{ wordErrors=$distance; referenceWordCount=$rCount; wer=[math]::Round($distance / [double]$rCount, 6) }
}

function Get-Wer([string]$Reference, [string]$Hypothesis) {
    $measurement = Get-WerMeasurement $Reference $Hypothesis
    return $(if ($null -eq $measurement) { $null } else { $measurement.wer })
}

function Test-TokenPhrase($TextTokens, $TermTokens) {
    $text = @($TextTokens)
    $term = @($TermTokens)
    if ($term.Count -eq 0 -or $text.Count -lt $term.Count) { return $false }
    for ($start=0; $start -le $text.Count-$term.Count; $start++) {
        $matches = $true
        for ($offset=0; $offset -lt $term.Count; $offset++) {
            if ($text[$start+$offset] -cne $term[$offset]) { $matches=$false; break }
        }
        if ($matches) { return $true }
    }
    return $false
}

function Measure-Transcript($Document, [string]$Reference, [double]$Duration, [string[]]$Keyterms = @(), $Bookmarks = @()) {
    $required = @('file','text','confidence','duration','languages','words')
    $missing = if (Test-StructuredObject $Document) { @($required | Where-Object { -not (Test-ObjectProperty $Document $_) }) } else { @($required) }
    $schemaErrors = @()
    if (-not (Test-StructuredObject $Document)) { $schemaErrors += 'document: expected a JSON object' }
    foreach ($field in $missing) { $schemaErrors += "${field}: required field is missing" }

    $documentText = ''
    if (Test-ObjectProperty $Document 'file') {
        if ($Document.file -isnot [string] -or [string]::IsNullOrWhiteSpace($Document.file)) { $schemaErrors += 'file: expected a non-empty string' }
    }
    if (Test-ObjectProperty $Document 'text') {
        if ($Document.text -isnot [string]) { $schemaErrors += 'text: expected a string' }
        else {
            $documentText = $Document.text
            if ($Duration -gt 0 -and -not (Normalize-Transcript $documentText)) { $schemaErrors += 'text: expected meaningful transcript text for nonempty audio' }
        }
    }
    if (Test-ObjectProperty $Document 'confidence') {
        if (-not (Test-FiniteNumber $Document.confidence) -or [double]$Document.confidence -lt 0 -or [double]$Document.confidence -gt 1) { $schemaErrors += 'confidence: expected a finite number from 0 through 1' }
    }
    if (Test-ObjectProperty $Document 'duration') {
        if (-not (Test-FiniteNumber $Document.duration)) { $schemaErrors += 'duration: expected a finite number' }
        elseif ([double]$Document.duration -lt 0 -or ($Duration -gt 0 -and [double]$Document.duration -le 0)) { $schemaErrors += 'duration: expected a positive duration for nonempty audio' }
    }
    if (Test-ObjectProperty $Document 'languages') {
        if (-not (Test-JsonArray $Document.languages)) { $schemaErrors += 'languages: expected an array' }
        else {
            $languages = @($Document.languages)
            if ($Duration -gt 0 -and $languages.Count -eq 0) { $schemaErrors += 'languages: expected at least one language for nonempty audio' }
            for ($index=0; $index -lt $languages.Count; $index++) {
                if ($languages[$index] -isnot [string] -or [string]::IsNullOrWhiteSpace($languages[$index])) { $schemaErrors += "languages[$index]: expected a non-empty string" }
            }
        }
    }

    $documentWords = @()
    $wordsAreArray = $false
    if (Test-ObjectProperty $Document 'words') {
        if (-not (Test-JsonArray $Document.words)) { $schemaErrors += 'words: expected an array' }
        else { $wordsAreArray=$true; $documentWords=@($Document.words) }
    }
    if ($Duration -gt 0 -and $wordsAreArray -and $documentWords.Count -eq 0) { $schemaErrors += 'words: expected at least one meaningful word for nonempty audio' }

    $invalidWords = 0
    $invalidIntervals = 0
    $speakerCount = 0
    $validIntervals = 0
    $previousStart = -1.0
    for ($index=0; $index -lt $documentWords.Count; $index++) {
        $word = $documentWords[$index]
        $wordErrorsBefore = $schemaErrors.Count
        if (-not (Test-StructuredObject $word)) {
            $schemaErrors += "words[$index]: expected an object"
            $invalidWords++
            $invalidIntervals++
            continue
        }
        $wordMissing = @(@('word','start','end','confidence') | Where-Object { -not (Test-ObjectProperty $word $_) })
        foreach ($field in $wordMissing) { $schemaErrors += "words[$index].${field}: required field is missing" }

        if (Test-ObjectProperty $word 'word') {
            if ($word.word -isnot [string] -or -not (Normalize-Transcript $word.word)) { $schemaErrors += "words[$index].word: expected a meaningful string" }
        }
        $startValid = (Test-ObjectProperty $word 'start') -and (Test-FiniteNumber $word.start)
        $endValid = (Test-ObjectProperty $word 'end') -and (Test-FiniteNumber $word.end)
        if ((Test-ObjectProperty $word 'start') -and -not $startValid) { $schemaErrors += "words[$index].start: expected a finite number" }
        if ((Test-ObjectProperty $word 'end') -and -not $endValid) { $schemaErrors += "words[$index].end: expected a finite number" }
        if (Test-ObjectProperty $word 'confidence') {
            if (-not (Test-FiniteNumber $word.confidence) -or [double]$word.confidence -lt 0 -or [double]$word.confidence -gt 1) { $schemaErrors += "words[$index].confidence: expected a finite number from 0 through 1" }
        }

        $intervalValid = $startValid -and $endValid
        if ($intervalValid) {
            $start = [double]$word.start
            $end = [double]$word.end
            if ($start -lt 0) { $schemaErrors += "words[$index]: start must be non-negative"; $intervalValid=$false }
            if ($end -le $start) { $schemaErrors += "words[$index]: end must be greater than start"; $intervalValid=$false }
            if ($end -gt $Duration) { $schemaErrors += "words[$index]: end exceeds source duration $Duration"; $intervalValid=$false }
            if ($start -lt $previousStart) { $schemaErrors += "words[$index]: start precedes the previous word"; $intervalValid=$false }
            $previousStart = $start
        }
        if ($intervalValid) { $validIntervals++ } else { $invalidIntervals++ }

        if (Test-ObjectProperty $word 'speaker') {
            if (-not (Test-FiniteNumber $word.speaker) -or [double]$word.speaker -le 0 -or [math]::Floor([double]$word.speaker) -ne [double]$word.speaker) { $schemaErrors += "words[$index].speaker: expected a positive integer tag" }
            else { $speakerCount++ }
        }
        if ($schemaErrors.Count -gt $wordErrorsBefore) { $invalidWords++ }
    }

    $normalizedText = Normalize-Transcript $documentText
    $textTokens = @($normalizedText -split ' ' | Where-Object { $_ })
    $keytermResults = @()
    foreach ($term in @($Keyterms)) {
        $normalizedTerm = Normalize-Transcript $term
        $termTokens = @($normalizedTerm -split ' ' | Where-Object { $_ })
        $keytermResults += [ordered]@{ term=$term; normalized=$normalizedTerm; matched=(Test-TokenPhrase $textTokens $termTokens) }
    }
    $recallHits = @($keytermResults | Where-Object { $_.matched }).Count
    $keytermCount = @($Keyterms).Count
    $werMeasurement = Get-WerMeasurement $Reference $documentText

    $timestampAlignment = [ordered]@{ expected=@($Bookmarks).Count; hypothesis=$documentWords.Count; matched=0; alignmentCoverage=0; missingCount=@($Bookmarks).Count; unexpectedCount=$documentWords.Count; sequenceDeltaWords=(@($Bookmarks).Count+$documentWords.Count); startErrorsMs=@(); medianStartBoundaryErrorMs=$null; p95StartBoundaryErrorMs=$null; matches=@(); missing=@(); unexpected=@() }
    if ($wordsAreArray -and $invalidWords -eq 0) { $timestampAlignment = Measure-BookmarkBoundaries ([pscustomobject]@{words=$documentWords}) $Bookmarks }

    return [ordered]@{
        schemaValid=($schemaErrors.Count -eq 0)
        schemaErrors=$schemaErrors
        missingFields=$missing
        wer=$(if ($null -eq $werMeasurement) { $null } else { $werMeasurement.wer })
        wordErrors=$(if ($null -eq $werMeasurement) { $null } else { $werMeasurement.wordErrors })
        referenceWordCount=$(if ($null -eq $werMeasurement) { 0 } else { $werMeasurement.referenceWordCount })
        timestampCoverage=$(if ($documentWords.Count) { [math]::Round($validIntervals/[double]$documentWords.Count,6) } else { 0 })
        invalidWords=$invalidWords
        invalidIntervals=$invalidIntervals
        speakerFields=$speakerCount
        keytermCount=$keytermCount
        keytermMatches=$recallHits
        keytermResults=$keytermResults
        keytermRecall=$(if ($keytermCount) { [math]::Round($recallHits/[double]$keytermCount,6) } else { $null })
        timestampAlignment=$timestampAlignment
        boundaryExpected=$timestampAlignment.expected
        boundaryMatched=$timestampAlignment.matched
        boundaryStartErrorsMs=$timestampAlignment.startErrorsMs
        boundaryMedianStartErrorMs=$timestampAlignment.medianStartBoundaryErrorMs
        boundaryP95StartErrorMs=$timestampAlignment.p95StartBoundaryErrorMs
        normalizedText=$normalizedText
    }
}

function Invoke-MeasuredTranscription([string]$Backend, [string]$Exe, [string]$Device, $Fixture, [string]$Model, [string]$Suffix = '', [switch]$Stream) {
    $safeId = "$Backend-$($Fixture.id)$Suffix"
    $output = Join-Path $script:Scratch "output-$safeId.json"
    $args = @('--json','--verbose','transcribe',$Fixture.path,'--model',$Model,'--device',$Device,'--format','json','--word-times')
    if ($Stream) { $args += '--stream' }
    $args += @('--output',$output)
    $run = Invoke-External $Exe $args 2400 $script:Scratch "transcribe-$safeId" -Observe
    $persisted = Join-Path $script:RawRoot "transcribe-$safeId.json"
    $document = $null
    $parseError = $null
    if ($run.exitCode -eq 0 -and (Test-Path -LiteralPath $output)) {
        try {
            $document = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json
            Write-Utf8Text $persisted ((Get-Content -LiteralPath $output -Raw).Replace($script:Scratch,'<SCRATCH>'))
            $placeholder = Join-Path $script:RawRoot 'transcribe-not-run.json'
            if (Test-Path -LiteralPath $placeholder) { Remove-Item -LiteralPath $placeholder -Force }
        } catch { $parseError = $_.Exception.Message }
    }
    return [ordered]@{ backend=$Backend; device=$Device; fixture=$Fixture.id; stream=[bool]$Stream; commandLabel=$run.label; exitCode=$run.exitCode; timedOut=$run.timedOut; durationMs=$run.durationMs; outputBytes=$(if (Test-Path $output) { (Get-Item $output).Length } else { 0 }); evidencePath=$(if ($null -ne $document) { "raw/transcribe-$safeId.json" } else { $null }); document=$document; parseError=$parseError; baselineWorkingSetBytes=$run.baselineWorkingSetBytes; peakWorkingSetBytes=$run.peakWorkingSetBytes; workingSetIncreaseBytes=$run.workingSetIncreaseBytes; selectedGpuIndex=$run.selectedGpuIndex; selectedGpuUuid=$run.selectedGpuUuid; baselineVramMiB=$run.baselineSystemVramMiB; peakVramMiB=$run.peakSystemVramMiB; vramIncreaseMiB=$run.systemVramIncreaseMiB; resourceSampleCount=$run.resourceSampleCount; gpuPerProcessQueryAttempted=$run.gpuPerProcessQueryAttempted; gpuPerProcessQuerySucceeded=$run.gpuPerProcessQuerySucceeded; gpuPerProcessSupported=$run.gpuPerProcessSupported; baselineOwnedGpuMemoryMiB=$run.baselineOwnedGpuMemoryMiB; peakOwnedGpuMemoryMiB=$run.peakOwnedGpuMemoryMiB; ownedGpuMemoryIncreaseMiB=$run.ownedGpuMemoryIncreaseMiB; networkSampleAttemptCount=$run.networkSampleAttemptCount; networkSampleSuccessCount=$run.networkSampleSuccessCount; networkObservationAvailable=$run.networkObservationAvailable; tcpObservationCount=$run.tcpObservationCount; unexpectedNetworkConnectionCount=$run.unexpectedNetworkConnectionCount; observed=$run.observed; runnerSucceeded=$run.runnerSucceeded; ownershipTrackingAvailable=$run.ownershipTrackingAvailable; ownershipErrors=$run.ownershipErrors; samplingErrors=$run.samplingErrors; processLifecycle=$run.processLifecycle }
}

function Invoke-CapabilityMatrix([string]$Backend, [string]$Exe, [string]$Model) {
    $commands = @(
        @{ label='version'; args=@('--version') },
        @{ label='doctor'; args=@('--json','doctor') },
        @{ label='help-transcribe'; args=@('help','transcribe') },
        @{ label='help-diarize'; args=@('help','diarize') },
        @{ label='help-bench'; args=@('help','bench') },
        @{ label='model-info'; args=@('model','info',$Model) }
    )
    $results = [ordered]@{}
    foreach ($command in $commands) {
        $run = Invoke-External $Exe $command.args 120 $script:Scratch "$Backend-$($command.label)"
        $json = $null
        if ($command.label -in @('doctor','model-info') -and $run.exitCode -eq 0) { try { $json = $run.stdout | ConvertFrom-Json } catch { } }
        $results[$command.label] = [ordered]@{ exitCode=$run.exitCode; timedOut=$run.timedOut; stdout=$run.stdout; stderr=$run.stderr; json=$json }
    }
    return $results
}

function Measure-JsonErrorContract([AllowNull()][string]$Stdout, [AllowNull()][string]$ExpectedType) {
    $document = $null
    $parseError = $null
    try { $document = $Stdout | ConvertFrom-Json -ErrorAction Stop } catch { $parseError = Sanitize-Text $_.Exception.Message }
    $parseableObject = ($null -ne $document -and (Test-StructuredObject $document) -and -not (Test-JsonArray $document))
    $type = $null
    $message = $null
    $shape = $null
    $hasError = ($parseableObject -and (Test-ObjectProperty $document 'error'))
    $hasErrors = ($parseableObject -and (Test-ObjectProperty $document 'errors'))
    $hasTopType = ($parseableObject -and (Test-ObjectProperty $document 'type'))
    $hasTopMessage = ($parseableObject -and (Test-ObjectProperty $document 'message'))
    $nestedShape = ($hasError -and -not $hasErrors -and -not $hasTopType -and -not $hasTopMessage -and (Test-StructuredObject $document.error) -and -not (Test-JsonArray $document.error) -and (Test-ObjectProperty $document.error 'type') -and (Test-ObjectProperty $document.error 'message') -and $document.error.type -is [string] -and $document.error.message -is [string])
    $directShape = (-not $hasError -and -not $hasErrors -and $hasTopType -and $hasTopMessage -and $document.type -is [string] -and $document.message -is [string])
    if ($nestedShape) { $shape='nested-error'; $type=$document.error.type; $message=$document.error.message }
    elseif ($directShape) { $shape='direct-error'; $type=$document.type; $message=$document.message }
    $validShape = ($nestedShape -or $directShape)
    $errorCount = if ($validShape) { 1 } elseif ($hasError -or $hasErrors -or $hasTopType -or $hasTopMessage) { 0 } else { 0 }
    $sanitized = (-not [string]::IsNullOrWhiteSpace($Stdout) -and $Stdout -ceq (Sanitize-Text $Stdout))
    $actionHint = ($validShape -and $message -match '(?i)\b(provide|use|choose|set|check|verify|correct|remove|create|ensure|select|specify|retry|inspect|change)\b')
    $actionable = ($validShape -and -not [string]::IsNullOrWhiteSpace($message) -and $message.Trim().Length -ge 12 -and $message.Trim() -cne $type.Trim() -and $actionHint)
    $typeMatches = (-not [string]::IsNullOrWhiteSpace($ExpectedType) -and $type -ceq $ExpectedType)
    $exactlyOne = ($validShape -and $errorCount -eq 1)
    return [ordered]@{ parseable=$parseableObject; parseError=$parseError; shape=$shape; validShape=$validShape; errorCount=$errorCount; exactlyOne=$exactlyOne; sanitized=$sanitized; actionHint=$actionHint; actionable=$actionable; expectedType=$ExpectedType; actualType=$type; message=$(if($message){Sanitize-Text $message}else{$null}); typeMatches=$typeMatches; pass=($parseableObject -and $validShape -and $exactlyOne -and $sanitized -and $actionable -and $typeMatches) }
}

function Wait-ForInvocationRecovery($Run, [int]$TimeoutSeconds) {
    $baseline = if (Test-ObjectProperty $Run 'baselineSystemVramMiB') { $Run.baselineSystemVramMiB } else { $null }
    $identitiesAvailable = ((Test-ObjectProperty $Run 'ownershipTrackingAvailable') -and $Run.ownershipTrackingAvailable -and (Test-ObjectProperty $Run 'ownedProcessIdentities'))
    $identities = @(if ($identitiesAvailable) { @($Run.ownedProcessIdentities) })
    $ownedIds = @($identities | ForEach-Object { [int]$_.processId })
    $deadline = [DateTime]::UtcNow.AddSeconds([math]::Max(0,$TimeoutSeconds))
    $currentVram = $null
    $remaining = @()
    $vramRecovered = $false
    $processesRecovered = $false
    do {
        $currentVram = Get-CurrentVramUsedMiB
        $remaining = @(if ($identitiesAvailable) { $identities | Where-Object { Test-ProcessIdentity $_ } | ForEach-Object { [int]$_.processId } })
        $vramRecovered = ($null -ne $baseline -and $null -ne $currentVram -and [double]$currentVram -le [double]$baseline + [double]$script:Thresholds.requirements.cleanupVramToleranceMiB)
        $processesRecovered = ($identitiesAvailable -and $ownedIds.Count -gt 0 -and $remaining.Count -eq 0)
        if ($vramRecovered -and $processesRecovered) { break }
        if ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    } while ([DateTime]::UtcNow -lt $deadline)
    return [ordered]@{ preVramMiB=$baseline; postVramMiB=$currentVram; vramDeltaMiB=$(if($null -ne $baseline -and $null -ne $currentVram){[double]$currentVram-[double]$baseline}else{$null}); vramRecovered=$vramRecovered; ownedProcessCheckAvailable=$identitiesAvailable; ownedProcessIds=$ownedIds; ownedProcessCount=$ownedIds.Count; remainingProcessIds=$remaining; processesRecovered=$processesRecovered; pass=($vramRecovered -and $processesRecovered) }
}

function Clear-InvocationResidue($Run, [int]$TimeoutSeconds) {
    $baseline = if (Test-ObjectProperty $Run 'baselineSystemVramMiB') { $Run.baselineSystemVramMiB } else { $null }
    $identities = if (Test-ObjectProperty $Run 'ownedProcessIdentities') { @($Run.ownedProcessIdentities) } else { @() }
    $initialRemaining = @($identities | Where-Object { Test-ProcessIdentity $_ })
    $stopErrors = @()
    $stoppedIds = @()
    foreach ($identity in $initialRemaining) {
        $processId = [int]$identity.processId
        if ($processId -eq $PID) { $stopErrors += "Refused to terminate the validation harness PID $processId."; continue }
        try { Stop-OwnedProcessIdentity $identity; $stoppedIds += $processId } catch { $stopErrors += Sanitize-Text $_.Exception.Message }
    }
    $deadline = [DateTime]::UtcNow.AddSeconds([math]::Max(0,$TimeoutSeconds))
    $remaining = @()
    $currentVram = $null
    do {
        $remaining = @($identities | Where-Object { Test-ProcessIdentity $_ } | ForEach-Object { [int]$_.processId })
        $currentVram = Get-CurrentVramUsedMiB
        $vramRecovered = ($null -ne $baseline -and $null -ne $currentVram -and [double]$currentVram -le [double]$baseline + [double]$script:Thresholds.requirements.cleanupVramToleranceMiB)
        if ($remaining.Count -eq 0 -and $vramRecovered) { break }
        if ([DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 500 }
    } while ([DateTime]::UtcNow -lt $deadline)
    return [ordered]@{ needed=$true; initialRemainingProcessIds=@($initialRemaining | ForEach-Object { [int]$_.processId }); stoppedProcessIds=$stoppedIds; stopErrors=$stopErrors; remainingProcessIds=$remaining; postCleanupVramMiB=$currentVram; vramRecovered=$vramRecovered; pass=($remaining.Count -eq 0 -and $vramRecovered -and $stopErrors.Count -eq 0) }
}

function Test-DiarizationReality([string]$Exe, [string]$Device, [string]$Model, $Ugly) {
    $missing = Join-Path $script:Scratch 'missing-sortformer.gguf'
    $probes = @(
        @{ id='without-companion'; args=@('--json','transcribe',$Ugly.path,'--model',$Model,'--device',$Device,'--format','json','--word-times','--diarize','--output',(Join-Path $script:Scratch 'diarize-no-companion.json')); expectedExit=2; expectedType='invalid_argument'; allowsSuccess=$true },
        @{ id='missing-companion'; args=@('--json','transcribe',$Ugly.path,'--model',$Model,'--device',$Device,'--format','json','--word-times','--diar-model',$missing,'--output',(Join-Path $script:Scratch 'diarize-missing-companion.json')); expectedExit=3; expectedType='missing_model'; allowsSuccess=$false },
        @{ id='standalone-missing'; args=@('--json','diarize',$Ugly.path,'--model',$missing,'--device',$Device,'--format','json','--output',(Join-Path $script:Scratch 'diarize-standalone.json')); expectedExit=3; expectedType='missing_model'; allowsSuccess=$false }
    )
    $rows = @()
    foreach ($probe in $probes) {
        $output = $probe.args[-1]
        if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
        $run = $null
        $errorContract = $null
        $recovery = $null
        $residueCleanup = $null
        $outputExisted = $false
        $outputBytes = 0
        $outputHash = $null
        $outputParseable = $false
        $outputSchemaValid = $false
        $outputParseError = $null
        $speakerFields = 0
        $outputCleaned = $false
        try {
            $run = Invoke-External $Exe $probe.args 120 $script:Scratch "diarization-$($probe.id)" -Observe
            if ($run.exitCode -ne 0) { $errorContract = Measure-JsonErrorContract $run.stdout $probe.expectedType }
            $recovery = Wait-ForInvocationRecovery $run ([int]$script:Thresholds.requirements.failureTimeoutSeconds)
            $residueCleanup = if ($recovery.pass) { [ordered]@{ needed=$false; pass=$true } } else { Clear-InvocationResidue $run ([int]$script:Thresholds.requirements.failureTimeoutSeconds) }
            $outputExisted = Test-Path -LiteralPath $output -PathType Leaf
            if ($outputExisted) {
                $outputBytes = (Get-Item -LiteralPath $output).Length
                $outputHash = Get-Sha256 $output
                try {
                    $document = Get-Content -LiteralPath $output -Raw | ConvertFrom-Json -ErrorAction Stop
                    $outputParseable = ($null -ne $document -and (Test-StructuredObject $document) -and -not (Test-JsonArray $document))
                    if ($outputParseable -and (Test-ObjectProperty $Ugly 'reference') -and (Test-ObjectProperty $Ugly 'duration')) {
                        $outputMeasurement = Measure-Transcript $document $Ugly.reference ([double]$Ugly.duration)
                        $outputSchemaValid = $outputMeasurement.schemaValid
                    }
                    if ($outputParseable -and (Test-ObjectProperty $document 'words') -and (Test-JsonArray $document.words)) {
                        $speakerFields = @($document.words | Where-Object { Test-ObjectProperty $_ 'speaker' }).Count
                    }
                } catch { $outputParseError = Sanitize-Text $_.Exception.Message }
            }
        } finally {
            try { if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force } } catch { }
            $outputCleaned = -not (Test-Path -LiteralPath $output)
        }
        $explicitFailure = ($run.exitCode -eq $probe.expectedExit -and -not $run.timedOut -and $null -ne $errorContract -and $errorContract.pass -and -not $outputExisted)
        if ($probe.id -eq 'without-companion') {
            $behavior = if ($run.exitCode -eq 0) { 'successful-asr-without-speakers' } else { 'expected-invalid-argument-error' }
            $behaviorPass = if ($run.exitCode -eq 0) { ($probe.allowsSuccess -and -not $run.timedOut -and $outputExisted -and $outputParseable -and $outputSchemaValid -and $speakerFields -eq 0) } else { $explicitFailure }
            $unexpectedAcceptedOutput = ($run.exitCode -ne 0 -and $outputExisted)
        } else {
            $behavior = 'expected-missing-model-error'
            $behaviorPass = $explicitFailure
            $unexpectedAcceptedOutput = $outputExisted
        }
        $pass = ($behaviorPass -and $recovery.pass -and $residueCleanup.pass -and $outputCleaned -and -not $unexpectedAcceptedOutput)
        $rows += [ordered]@{ id=$probe.id; behavior=$behavior; expectedExit=$probe.expectedExit; actualExit=$run.exitCode; expectedType=$probe.expectedType; actualType=$(if($errorContract){$errorContract.actualType}else{$null}); timedOut=$run.timedOut; errorContract=$errorContract; outputExisted=$outputExisted; outputBytes=$outputBytes; outputHash=$outputHash; outputParseable=$outputParseable; outputSchemaValid=$outputSchemaValid; outputParseError=$outputParseError; speakerFields=$speakerFields; unexpectedAcceptedOutput=$unexpectedAcceptedOutput; outputCleaned=$outputCleaned; recovery=$recovery; residueCleanup=$residueCleanup; pass=$pass }
    }
    return [ordered]@{ diarizationAvailable=$false; der='NOT_RUN'; overlapDer='NOT_RUN'; speakerAttributedWer='NOT_RUN'; probes=$rows; pass=($rows.Count -eq 3 -and @($rows | Where-Object { -not $_.pass }).Count -eq 0) }
}

function Test-FinalizedJsonOutput([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return $false }
    if ((Get-Item -LiteralPath $Path).Length -eq 0) { return $false }
    try { $null = Get-Content -LiteralPath $Path -Raw | ConvertFrom-Json -ErrorAction Stop; return $true } catch { return $false }
}

function Test-Cancellation([string]$Exe, [string]$Device, [string]$Model, $LongFixture) {
    if (-not (Test-Path -LiteralPath $LongFixture.path)) { return [ordered]@{ status='NOT_RUN'; reason='Long fixture unavailable.'; pass=$false } }
    $output = Join-Path $script:Scratch 'cancellation-output.json'
    if (Test-Path -LiteralPath $output) { Remove-Item -LiteralPath $output -Force }
    $args = @('--json','--verbose','transcribe',$LongFixture.path,'--model',$Model,'--device',$Device,'--format','json','--word-times','--output',$output)
    $confirmation = [pscustomobject]@{ confirmed=$false }
    $requiredIncrease = [double]$script:Thresholds.requirements.gpuAllocationIncreaseMiB
    $predicate = {
        param($State)
        if ($null -ne $State.baselineSystemVramMiB -and $null -ne $State.currentSystemVramMiB -and ([double]$State.currentSystemVramMiB-[double]$State.baselineSystemVramMiB) -ge $requiredIncrease) {
            $confirmation.confirmed = $true
            return $true
        }
        return $false
    }.GetNewClosure()
    $terminationBoundMs = [int]([double]$script:Thresholds.requirements.cancellationExitSeconds * 1000)
    $run = Invoke-External -FilePath $Exe -Arguments $args -TimeoutSeconds 45 -WorkingDirectory $script:Scratch -Label 'cancellation-long-form' -Observe -CancellationPredicate $predicate -TerminationTimeoutMilliseconds $terminationBoundMs -PipeDrainTimeoutMilliseconds 250
    $baseline = $run.baselineSystemVramMiB
    $returned = $false
    $returnDeadline=[DateTime]::UtcNow.AddSeconds([int]$script:Thresholds.requirements.cancellationVramReturnSeconds)
    do {
        $now=Get-CurrentVramUsedMiB
        if ($null -ne $now -and $null -ne $baseline -and $now -le $baseline+[int]$script:Thresholds.requirements.cleanupVramToleranceMiB) { $returned=$true; break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $returnDeadline)
    $outputExists = Test-Path -LiteralPath $output -PathType Leaf
    $outputBytes = if ($outputExists) { (Get-Item -LiteralPath $output).Length } else { 0 }
    $finalizedOutput = Test-FinalizedJsonOutput $output
    $exitSeconds = [math]::Round(([double]$run.termination.durationMs/1000),3)
    $descendants = @($run.ownedProcessesRemaining).Count
    $resourceSampleCount = @($script:ResourceSamples | Where-Object { $_.label -eq 'cancellation-long-form' }).Count
    $pass = ($confirmation.confirmed -and $run.cancelled -and -not $run.timedOut -and $run.runnerSucceeded -and $exitSeconds -le [double]$script:Thresholds.requirements.cancellationExitSeconds -and -not $finalizedOutput -and $descendants -eq 0 -and $returned -and $resourceSampleCount -gt 0)
    return [ordered]@{ status='EXECUTED'; inferenceConfirmed=$confirmation.confirmed; exitSeconds=$exitSeconds; finalizedOutput=$finalizedOutput; outputExists=$outputExists; outputBytes=$outputBytes; descendants=$descendants; vramReturned=$returned; resourceSampleCount=$resourceSampleCount; command=$run; pass=$pass }
}

function Get-AccessControlListSnapshot([string]$Path) {
    $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor [System.Security.AccessControl.AccessControlSections]::Access
    $sourceAcl = Get-Acl -LiteralPath $Path -ErrorAction Stop
    $snapshot = New-Object System.Security.AccessControl.DirectorySecurity
    $snapshot.SetSecurityDescriptorSddlForm($sourceAcl.GetSecurityDescriptorSddlForm($sections), $sections)
    return $snapshot
}

function Restore-AccessControlList([string]$Path, $OriginalAcl) {
    $restoreSections = [System.Security.AccessControl.AccessControlSections]::Access
    $restoreAcl = New-Object System.Security.AccessControl.DirectorySecurity
    $restoreAcl.SetSecurityDescriptorSddlForm($OriginalAcl.GetSecurityDescriptorSddlForm($restoreSections), $restoreSections)
    (Get-Item -LiteralPath $Path -Force -ErrorAction Stop).SetAccessControl($restoreAcl)
    $restoredAcl = Get-AccessControlListSnapshot $Path
    return ($restoredAcl.Owner -ceq $OriginalAcl.Owner -and $restoredAcl.AreAccessRulesProtected -eq $OriginalAcl.AreAccessRulesProtected -and $restoredAcl.AccessToString -ceq $OriginalAcl.AccessToString)
}

function Test-FailureMatrix([string]$Exe, [string]$Device, [string]$Model, $Tiny) {
    $malformed = Join-Path $script:Scratch 'malformed.wav'; Write-Utf8Text $malformed 'not a wav'
    $unsupported = Join-Path $script:Scratch 'unsupported.mp3'; Write-Utf8Text $unsupported 'not an mp3'
    $existing = Join-Path $script:Scratch 'existing-output.json'; Write-Utf8Text $existing '{"sentinel":"must-remain-byte-identical"}'
    $deniedDir = Join-Path $script:Scratch 'acl-denied'; New-Item -ItemType Directory -Path $deniedDir -Force | Out-Null
    $originalDeniedDirectoryAcl = Get-AccessControlListSnapshot $deniedDir
    $icacls = (Get-Command icacls.exe -ErrorAction Stop).Source
    $cases = @(
        @{ id='missing-model'; expectedExit=3; expectedType='missing_model'; input=$Tiny.path; model=(Join-Path $script:Scratch 'missing-asr.gguf'); device=$Device; output=(Join-Path $script:Scratch 'failure-missing-model.json') },
        @{ id='missing-input'; expectedExit=2; expectedType='invalid_argument'; input=(Join-Path $script:Scratch 'missing.wav'); model=$Model; device=$Device; output=(Join-Path $script:Scratch 'failure-missing-input.json') },
        @{ id='malformed-wav'; expectedExit=1; expectedType='runtime_error'; input=$malformed; model=$Model; device=$Device; output=(Join-Path $script:Scratch 'failure-malformed.json') },
        @{ id='unsupported-extension'; expectedExit=2; expectedType='invalid_argument'; input=$unsupported; model=$Model; device=$Device; output=(Join-Path $script:Scratch 'failure-extension.json') },
        @{ id='existing-output'; expectedExit=1; expectedType='runtime_error'; input=$Tiny.path; model=$Model; device=$Device; output=$existing },
        @{ id='metal-device'; expectedExit=2; expectedType='invalid_argument'; input=$Tiny.path; model=$Model; device='metal'; output=(Join-Path $script:Scratch 'failure-metal.json') },
        @{ id='acl-denied'; expectedExit=1; expectedType='runtime_error'; input=$Tiny.path; model=$Model; device=$Device; output=(Join-Path $deniedDir 'denied.json') }
    )
    $rows = @()
    $aclDenyApplied = $false
    $aclRestored = $false
    $aclRestoreErrors = @()
    try {
        $denyAcl = Invoke-External $icacls @($deniedDir,'/inheritance:r','/deny',"$env:USERNAME`:(W)") 30 $script:Scratch 'failure-acl-deny'
        if ($denyAcl.exitCode -ne 0 -or $denyAcl.timedOut) { throw 'Could not apply the controlled ACL-denied failure fixture.' }
        $aclDenyApplied = $true
        foreach ($case in $cases) {
            $isExistingOutputCase = ($case.id -eq 'existing-output')
            if (-not $isExistingOutputCase -and (Test-Path -LiteralPath $case.output)) { Remove-Item -LiteralPath $case.output -Force }
            $outputExistedBefore = Test-Path -LiteralPath $case.output -PathType Leaf
            $preOutputHash = if ($outputExistedBefore) { Get-Sha256 $case.output } else { $null }
            $preOutputBytes = if ($outputExistedBefore) { (Get-Item -LiteralPath $case.output).Length } else { 0 }
            $run = $null
            $errorContract = $null
            $recovery = $null
            $residueCleanup = $null
            $postOutputExists = $false
            $postOutputHash = $null
            $postOutputBytes = 0
            $outputCleaned = $false
            try {
                $args = @('--json','transcribe',$case.input,'--model',$case.model,'--device',$case.device,'--format','json','--no-warmup','--output',$case.output)
                $run = Invoke-External $Exe $args ([int]$script:Thresholds.requirements.failureTimeoutSeconds) $script:Scratch "failure-$($case.id)" -Observe
                $errorContract = Measure-JsonErrorContract $run.stdout $case.expectedType
                $recovery = Wait-ForInvocationRecovery $run ([int]$script:Thresholds.requirements.failureTimeoutSeconds)
                $residueCleanup = if ($recovery.pass) { [ordered]@{ needed=$false; pass=$true } } else { Clear-InvocationResidue $run ([int]$script:Thresholds.requirements.failureTimeoutSeconds) }
                $postOutputExists = Test-Path -LiteralPath $case.output -PathType Leaf
                if ($postOutputExists) {
                    $postOutputHash = Get-Sha256 $case.output
                    $postOutputBytes = (Get-Item -LiteralPath $case.output).Length
                }
            } finally {
                try { if (Test-Path -LiteralPath $case.output) { Remove-Item -LiteralPath $case.output -Force } } catch { }
                $outputCleaned = -not (Test-Path -LiteralPath $case.output)
            }
            $existingOutputUnchanged = ($isExistingOutputCase -and $outputExistedBefore -and $postOutputExists -and $preOutputHash -ceq $postOutputHash -and $preOutputBytes -eq $postOutputBytes)
            $unexpectedAcceptedOutput = if ($isExistingOutputCase) { -not $existingOutputUnchanged } else { $postOutputExists }
            $pass = ($run.exitCode -eq $case.expectedExit -and -not $run.timedOut -and $errorContract.pass -and $recovery.pass -and $residueCleanup.pass -and -not $unexpectedAcceptedOutput -and $outputCleaned)
            $rows += [ordered]@{ id=$case.id; expectedExit=$case.expectedExit; actualExit=$run.exitCode; expectedType=$case.expectedType; actualType=$errorContract.actualType; timedOut=$run.timedOut; errorContract=$errorContract; outputExistedBefore=$outputExistedBefore; preOutputHash=$preOutputHash; preOutputBytes=$preOutputBytes; postOutputExists=$postOutputExists; postOutputHash=$postOutputHash; postOutputBytes=$postOutputBytes; existingOutputUnchanged=$existingOutputUnchanged; unexpectedAcceptedOutput=$unexpectedAcceptedOutput; outputCleaned=$outputCleaned; recovery=$recovery; residueCleanup=$residueCleanup; pass=$pass }
        }
    } finally {
        try {
            $aclRestored = Restore-AccessControlList $deniedDir $originalDeniedDirectoryAcl
            if (-not $aclRestored) { $aclRestoreErrors += 'Restored ACL does not match the original access-control descriptor.' }
        } catch { $aclRestoreErrors += Sanitize-Text $_.Exception.Message }
        foreach ($case in $cases) {
            try { if (Test-Path -LiteralPath $case.output) { Remove-Item -LiteralPath $case.output -Force } } catch { }
        }
    }
    return [ordered]@{ rows=$rows; aclDenyApplied=$aclDenyApplied; aclRestored=$aclRestored; aclRestoreErrors=$aclRestoreErrors; pass=($rows.Count -eq 7 -and @($rows | Where-Object { -not $_.pass }).Count -eq 0 -and $aclDenyApplied -and $aclRestored) }
}

function Remove-SpikeWorkspace {
    $result=[ordered]@{ attemptedUtc=[DateTime]::UtcNow.ToString('o'); safePath=$false; markerMatched=$false; removed=$false; error=$null; vramReturned=$false; processesRemaining=$null }
    try {
        if (-not $script:Scratch) { throw 'Scratch was never created.' }
        $tempRoot=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
        $canonical=[IO.Path]::GetFullPath($script:Scratch)
        $result.safePath=$canonical.StartsWith($tempRoot+'\',[StringComparison]::OrdinalIgnoreCase)
        $marker=Join-Path $canonical $script:MarkerName
        $result.markerMatched=((Test-Path $marker) -and (Get-Content $marker -Raw).Trim() -eq $script:RunId)
        if (-not $result.safePath -or -not $result.markerMatched) { throw 'Cleanup guard rejected the scratch path.' }
        Remove-Item -LiteralPath $canonical -Recurse -Force
        $result.removed=-not (Test-Path $canonical)
    } catch { $result.error=Sanitize-Text $_.Exception.Message; Add-Failure "Cleanup failed: $($result.error)" }
    $deadline=[DateTime]::UtcNow.AddSeconds([int]$script:Thresholds.requirements.cleanupVramReturnSeconds)
    do { $vram=Get-CurrentVramUsedMiB; if ($null -ne $vram -and $null -ne $script:BaselineVramMiB -and $vram -le $script:BaselineVramMiB+[int]$script:Thresholds.requirements.cleanupVramToleranceMiB) { $result.vramReturned=$true; break }; Start-Sleep -Milliseconds 500 } while ([DateTime]::UtcNow -lt $deadline)
    $remaining=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -and $_.CommandLine -like "*$($script:RunId)*" })
    $result.processesRemaining=$remaining.Count
    $result.pass=($result.removed -and $result.vramReturned -and $remaining.Count -eq 0)
    if (-not $result.pass) { Add-Failure 'Cleanup/isolation threshold failed.' }
    return $result
}

function Write-Manifest {
    $files=Get-ChildItem -LiteralPath $script:EvidenceRoot -File -Recurse | Where-Object { $_.Name -ne 'manifest.json' } | Sort-Object FullName
    $entries=@($files | ForEach-Object { [ordered]@{ path=$_.FullName.Substring($script:EvidenceRoot.Length+1).Replace('\','/'); bytes=$_.Length; sha256=Get-Sha256 $_.FullName } })
    Write-Json (Join-Path $script:EvidenceRoot 'manifest.json') ([ordered]@{ schemaVersion=1; generatedUtc=[DateTime]::UtcNow.ToString('o'); excludes=@('manifest.json'); files=$entries })
}

function Write-SpikeVerdict($State, $Cleanup) {
    $mandatory=$State.thresholds
    $verdict=Get-SpikeVerdict $mandatory $script:Failures.ToArray()
    $results=[ordered]@{ schemaVersion=2; verdict=$verdict; architectureAccepted=$false; startedUtc=$script:StartedUtc; completedUtc=[DateTime]::UtcNow.ToString('o'); runId=$script:RunId; stages=$State.stages; thresholds=$mandatory; failures=$script:Failures.ToArray(); warnings=$script:Warnings.ToArray(); backends=$State.backends; metrics=$State.metrics; diarization=$State.diarization; cancellation=$State.cancellation; failureMatrix=$State.failureMatrix; cleanup=$Cleanup; authoritativeGate=@() }
    $criteria=@(
        'Eight human clips and long form complete offline without crash/OOM','Local aggregate WER within 2 points of AssemblyAI','Local aggregate WER 15% relatively better than Purfview large-v3','No clip more than 5 WER points worse than AssemblyAI','Prompted named-entity F1 threshold','Word-time coverage and boundary accuracy','Zero invalid word intervals','Zero chunk-boundary duplicate/dropped words','Punctuation F1 threshold','DER, overlap DER, and speaker-attributed WER','Runtime limits','Installed-size limits','TranscriptArtifactV1 publication','Three-run text/timestamp determinism'
    )
    for($i=0;$i -lt $criteria.Count;$i++) { $status='NOT_RUN'; if($i -eq 5 -and $mandatory.wordTimestamps.status -eq 'PASS'){$status='PARTIAL_SYNTHETIC'}; if($i -eq 6 -and $mandatory.wordTimestamps.status -eq 'PASS'){$status='PARTIAL_SYNTHETIC'}; if($i -eq 7 -and $mandatory.longForm.status -eq 'PASS'){$status='PARTIAL_SYNTHETIC'}; if($i -eq 10 -and $mandatory.runtime.status -eq 'PASS'){$status='PARTIAL_MACHINE'}; if($i -eq 11 -and $mandatory.runtime.status -eq 'PASS'){$status='PARTIAL_MACHINE'}; if($i -eq 13 -and $mandatory.determinism.status -eq 'PASS'){$status='PARTIAL_SYNTHETIC'}; $results.authoritativeGate += [ordered]@{ criterion=$i+1; description=$criteria[$i]; status=$status } }
    Write-Json (Join-Path $script:EvidenceRoot 'results.json') $results 30
    $rows=@(('# ' + $verdict),'','**Architecture accepted:** false','','This disposable Windows spike cannot promote the ASR architecture. Synthetic fixtures do not replace the eight human-annotated ugly clips.','','## Stage status','')
    foreach($name in $State.stages.Keys) { $rows += ('- **{0}:** {1} - {2}' -f $name,$State.stages[$name].status,$State.stages[$name].reason) }
    $rows += @('','## Preflight machine/toolchain summary','')
    if ($null -eq $State.preflight) { $rows += '- NOT_RUN - no machine inventory was captured.' } else {
        $gpuName = if ($State.preflight.selectedGpu) { [string]$State.preflight.selectedGpu.name } else { 'none selected' }
        $rows += ('- **Machine:** {0} {1}; CPU {2}; RAM {3:N1} GiB; selected GPU {4}; scratch {5} GiB free.' -f $State.preflight.os.caption,$State.preflight.os.architecture,$State.preflight.cpu.name,([double]$State.preflight.ramBytes/1GB),$gpuName,$State.preflight.scratchFreeGiB)
        foreach ($toolName in @($State.preflight.tools.Keys | Select-Object -First 12)) {
            $tool=$State.preflight.tools[$toolName]; $version=if($tool.version){(([string]$tool.version -replace '[\r\n]+',' ').Trim() | ForEach-Object { if($_.Length -gt 120){$_.Substring(0,120)+'...'}else{$_} })}else{'unavailable'}
            $rows += ('- **{0}:** found={1}; version={2}' -f $toolName,$tool.found,$version)
        }
    }
    $rows += @('','## Backend summary','')
    foreach($backend in @('cuda','vulkan','cpu')) { $b=$State.backends[$backend]; if($null -eq $b){$rows += ('- **{0}:** NOT_RUN' -f $backend)}else{$rows += ('- **{0}:** build exit {1}; runnable {2}; artifact SHA-256 {3}' -f $backend,$b.buildExit,$b.runnable,$b.sha256)} }
    $rows += @('','## Measurement summary','',('- **Rows:** {0}; stage {1} - {2}' -f @($State.metrics).Count,$State.stages.measurement.status,$State.stages.measurement.reason))
    foreach ($metric in @($State.metrics | Select-Object -First 20)) {
        $wer = if ($metric.measurement -and (Test-ObjectProperty $metric.measurement 'wer')) { $metric.measurement.wer } else { 'n/a' }
        $schema = if ($metric.measurement -and (Test-ObjectProperty $metric.measurement 'schemaValid')) { $metric.measurement.schemaValid } else { 'n/a' }
        $rows += ('- **{0}/{1}:** exit={2}; schema={3}; WER={4}' -f $metric.backend,$metric.fixture,$metric.run.exitCode,$schema,$wer)
    }
    if (@($State.metrics).Count -gt 20) { $rows += ('- ... {0} additional measurement rows are retained in `raw/metrics.csv`.' -f (@($State.metrics).Count-20)) }
    $rows += @('','## Threshold results','')
    foreach($name in $mandatory.Keys) { $rows += ('- **{0}:** {1} - {2}' -f $name,$mandatory[$name].status,$mandatory[$name].reason) }
    $rows += @('','## Verdict-blocking failures','')
    if($script:Failures.Count){foreach($failure in $script:Failures){$rows += ('- {0}' -f $failure)}}else{$rows += '- None.'}
    $rows += @('','## Diagnostic warnings (non-blocking)','')
    if($script:Warnings.Count){foreach($warning in $script:Warnings){$rows += ('- {0}' -f $warning)}}else{$rows += '- None.'}
    $rows += @('','## Cleanup',('- **Status:** {0} - {1}' -f $Cleanup.status,$Cleanup.reason),('- **Removed scratch:** {0}' -f $Cleanup.removed),('- **VRAM returned:** {0}' -f $Cleanup.vramReturned),('- **Processes remaining:** {0}' -f $Cleanup.processesRemaining),'','## Authoritative 14-point production gate','')
    foreach($criterion in $results.authoritativeGate){$rows += ('- **{0}. {1}:** {2}' -f $criterion.criterion,$criterion.status,$criterion.description)}
    $rows += @('','## Verification','','The bounded model provenance contract is covered by `provenance-validation.tests.ps1`: parsed revision, repository, sibling/LFS bytes and SHA-256, OpenMDW-1.1 fields, bounded retries, host-allowlisted redirects, redirect-loop rejection, and query/credential-redacted redirect status chains.','','The shared bounded process runner is covered by `process-runner-validation.tests.ps1`: parent -> child -> grandchild cancellation, fast-exit intermediates, inherited open pipes, forced termination failure, PID-reuse safety, finalized-output checks, bounded output capture, resource samples, and timeout-duration assertions.','','Run all targeted contracts from this directory: `evidence-schema-validation.tests.ps1`, `process-runner-validation.tests.ps1`, `failure-probe-validation.tests.ps1`, `fixture-generation.tests.ps1`, `gate-evaluation.tests.ps1`, `provenance-validation.tests.ps1`, and `transcript-validation.tests.ps1`.','','## Evidence index','','`manifest.json` hashes every other persisted text/JSON/CSV evidence file. No model, executable, source checkout, or audio is retained.','')
    Write-Utf8Text (Join-Path $script:EvidenceRoot 'README.md') (($rows -join "`n")+"`n")
}

if ($ValidationTestOnly) { return }

# simplification: retained logs cannot prove the machine-run body; restore verified source before enabling it.
throw 'Recovered validation runner is test-only; machine validation is intentionally disabled.'
