Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'run-spike.ps1') -ValidationTestOnly

function Assert-True([bool]$Condition, [string]$Label) {
    if (-not $Condition) { throw "$Label expected true." }
    Write-Host "PASS $Label"
}

function Assert-False([bool]$Condition, [string]$Label) {
    if ($Condition) { throw "$Label expected false." }
    Write-Host "PASS $Label"
}

function Assert-Equal($Expected, $Actual, [string]$Label) {
    if ($Expected -ne $Actual) { throw "$Label expected '$Expected', got '$Actual'." }
    Write-Host "PASS $Label -> $Actual"
}

$gpuInventoryFixture=@(
    '0, GPU-RTX, NVIDIA GeForce RTX 4090, 600.00, 24564, 20000, 8.9',
    '1, GPU-GTX1080, NVIDIA GeForce GTX 1080, 560.94, 8192, 7000, 6.1'
)
$selectedFixtureGpu=Select-ValidationGpu (ConvertFrom-NvidiaGpuInventoryCsv $gpuInventoryFixture)
Assert-Equal 1 $selectedFixtureGpu.index 'multi-GPU fixture selects the GTX 1080 instead of index 0'
Assert-Equal 'GPU-GTX1080' $selectedFixtureGpu.uuid 'multi-GPU fixture preserves selected device UUID'
$script:SelectedGpu=$selectedFixtureGpu
function Get-GpuObservation([int[]]$OwnedProcessIds = @()) {
    $rows=@($OwnedProcessIds | ForEach-Object {[pscustomobject]@{gpuUuid=$script:SelectedGpu.uuid;processId=[int]$_;usedMemoryMiB=64}})
    return [pscustomobject][ordered]@{available=$true;error=$null;deviceIndex=$script:SelectedGpu.index;deviceUuid=$script:SelectedGpu.uuid;systemUsedMiB=(100+($rows.Count*64));perProcessQuerySucceeded=$true;perProcessSupported=$true;perProcessError=$null;ownedUsedMiB=($rows.Count*64);processes=$rows}
}
function Get-CurrentVramUsedMiB { return 100 }

$script:Scratch = Join-Path ([IO.Path]::GetTempPath()) ('nemo-process-runner-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:Scratch -Force | Out-Null
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$productionStopOwnedProcessInstance = ${function:Stop-OwnedProcessInstance}
$activeRuns = New-Object System.Collections.Generic.List[object]

function ConvertTo-SingleQuotedLiteral([string]$Value) { return "'" + $Value.Replace("'","''") + "'" }

try {
    $finalOutput = Join-Path $script:Scratch 'final-output.json'
    $grandchildScript = Join-Path $script:Scratch 'grandchild.ps1'
    $childScript = Join-Path $script:Scratch 'child.ps1'
    $parentScript = Join-Path $script:Scratch 'parent.ps1'
    $powerShellLiteral = ConvertTo-SingleQuotedLiteral $powershellPath
    $grandchildLiteral = ConvertTo-SingleQuotedLiteral $grandchildScript
    $childLiteral = ConvertTo-SingleQuotedLiteral $childScript

    Write-Utf8Text $grandchildScript @'
param([string]$OutputPath)
$memory = New-Object byte[] (32MB)
for ($index=0; $index -lt $memory.Length; $index+=4096) { $memory[$index]=1 }
$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback,0)
$listener.Start()
$client = [Net.Sockets.TcpClient]::new()
$client.Connect([Net.IPAddress]::Loopback,$listener.LocalEndpoint.Port)
$accepted = $listener.AcceptTcpClient()
[Console]::Out.WriteLine('grandchild-ready')
[Console]::Out.Flush()
Start-Sleep -Seconds 20
$accepted.Dispose(); $client.Dispose(); $listener.Stop()
Set-Content -LiteralPath $OutputPath -Value '{"complete":true}' -Encoding UTF8
'@
    Write-Utf8Text $childScript "param([string]`$OutputPath)`r`n& $powerShellLiteral -NoProfile -ExecutionPolicy Bypass -File $grandchildLiteral `$OutputPath"
    Write-Utf8Text $parentScript "param([string]`$OutputPath)`r`n& $powerShellLiteral -NoProfile -ExecutionPolicy Bypass -File $childLiteral `$OutputPath"

    $cancelWhenTreeIsTracked = {
        param($State)
        $resourceReady=@($script:ResourceSamples | Where-Object { $_.label -eq 'controlled-tree-cancellation' -and $_.liveProcessCount -ge 3 }).Count -gt 0
        $networkReady=@($script:NetworkSamples | Where-Object { $_.label -eq 'controlled-tree-cancellation' -and $_.remoteAddress -in @('127.0.0.1','::1') }).Count -gt 0
        return (@($State.ownedProcessIds).Count -ge 3 -and @($State.ownershipEdges).Count -ge 2 -and $resourceReady -and $networkReady)
    }
    $cancelRun = Invoke-External -FilePath $powershellPath -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',$parentScript,$finalOutput) -TimeoutSeconds 8 -WorkingDirectory $script:Scratch -Label 'controlled-tree-cancellation' -Observe -CancellationPredicate $cancelWhenTreeIsTracked -TerminationTimeoutMilliseconds 1500 -PipeDrainTimeoutMilliseconds 250
    $activeRuns.Add($cancelRun)
    Assert-True $cancelRun.cancelled 'controlled parent-child-grandchild run reaches cancellation'
    Assert-False $cancelRun.timedOut 'controlled cancellation happens before timeout'
    Assert-True (@($cancelRun.ownedProcessIds).Count -ge 3) 'recursive ownership includes parent, child, and grandchild'
    Assert-Equal 0 @($cancelRun.ownedProcessesRemaining).Count 'cancellation leaves no owned process alive'
    Assert-True $cancelRun.termination.succeeded 'cancellation termination succeeds'
    Assert-True ($cancelRun.termination.durationMs -le 1500) "tree termination stays inside its configured bound (actual $($cancelRun.termination.durationMs) ms)"
    Assert-True $cancelRun.outputCaptureComplete 'inherited stdout and stderr pipes close after full-tree termination'
    Assert-True ($cancelRun.stdout -match 'grandchild-ready') 'grandchild stdout is retained as command evidence'
    Assert-False (Test-FinalizedJsonOutput $finalOutput) 'cancellation prevents finalized JSON output'
    $controlledSamples=@($script:ResourceSamples | Where-Object { $_.label -eq 'controlled-tree-cancellation' -and $_.liveProcessCount -ge 3 })
    Assert-True ($controlledSamples.Count -gt 0) 'controlled cancellation records recursive resource samples'
    $treeSample=$controlledSamples | Sort-Object aggregateWorkingSetBytes -Descending | Select-Object -First 1
    $largestProcessWorkingSet=@($treeSample.processWorkingSetBytes -split ';' | ForEach-Object {[int64]($_ -split '=')[1]} | Sort-Object -Descending | Select-Object -First 1)[0]
    Assert-True ([int64]$treeSample.aggregateWorkingSetBytes -gt $largestProcessWorkingSet) 'tree working set aggregates parent, child, and memory-allocating grandchild'
    Assert-Equal 1 $treeSample.selectedGpuIndex 'resource samples evaluate selected GPU index from fixture'
    Assert-Equal 'GPU-GTX1080' $treeSample.selectedGpuUuid 'resource samples bind VRAM to selected GPU UUID'
    Assert-True (@($script:NetworkSamples | Where-Object { $_.label -eq 'controlled-tree-cancellation' -and $_.pid -ne $cancelRun.rootProcessId -and $_.remoteAddress -in @('127.0.0.1','::1') }).Count -gt 0) 'descendant loopback TCP connection is recorded and marked unexpected'
    Assert-True ($cancelRun.unexpectedNetworkConnectionCount -gt 0) 'controlled descendant traffic reaches run privacy evidence'
    Assert-True (@($cancelRun.processLifecycle | Where-Object { -not $_.isRoot }).Count -ge 2) 'child lifecycle records child and grandchild start/exit evidence'
    Assert-True (@($cancelRun.processLifecycle | Where-Object { -not $_.isRoot -and $_.startTimeUtcTicks -gt 0 }).Count -ge 2) 'child lifecycle preserves PID start-time identities'
    Assert-True (@($controlledSamples | Where-Object { $_.ownedProcessCount -ge 3 -and $_.ownedProcessIds -match ';' }).Count -gt 0) 'each resource sample persists the recursive owned PID set'

    $recordedCancellation = @($script:Commands | Where-Object { $_.label -eq 'controlled-tree-cancellation' })[-1]
    Assert-True ($null -ne $recordedCancellation.rootProcessId) 'command evidence caches the root PID'
    Assert-Equal 'win32-process-start-trace-with-snapshot-fallback' $recordedCancellation.ownershipTracking 'command evidence records the pre-launch event strategy without a Job Object'
    Assert-True $recordedCancellation.ownershipTrackingAvailable 'process-start event tracking is available'
    Assert-Equal 0 @($recordedCancellation.ownershipErrors).Count 'command evidence records no ownership tracking errors'
    Assert-True (@($recordedCancellation.ownedProcessIdentities | Where-Object { $_.processId -gt 0 -and $_.startTimeUtcTicks -gt 0 }).Count -ge 3) 'owned identities include PID and UTC start-time ticks'
    Assert-True (@($recordedCancellation.ownershipEdges).Count -ge 2) 'command evidence records owned parent-to-child start-event edges'
    Assert-True ([DateTime]::Parse($recordedCancellation.endedUtc) -ge [DateTime]::Parse($recordedCancellation.startedUtc)) 'command evidence records ordered timestamps'
    Assert-True (@($recordedCancellation.arguments | Where-Object { $_ -match '<SCRATCH>' }).Count -ge 1) 'command evidence sanitizes scratch paths'

    $partialOutput = Join-Path $script:Scratch 'partial.json'
    $completeOutput = Join-Path $script:Scratch 'complete.json'
    Write-Utf8Text $partialOutput '{"complete":'
    Write-Utf8Text $completeOutput '{"complete":true}'
    Assert-False (Test-FinalizedJsonOutput $partialOutput) 'partial JSON is not mistaken for finalized output'
    Assert-True (Test-FinalizedJsonOutput $completeOutput) 'complete JSON is recognized as finalized output'

    $timeoutRun = Invoke-External -FilePath $powershellPath -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',$parentScript,(Join-Path $script:Scratch 'timeout-output.json')) -TimeoutSeconds 1 -WorkingDirectory $script:Scratch -Label 'controlled-tree-timeout' -TerminationTimeoutMilliseconds 1500 -PipeDrainTimeoutMilliseconds 250
    $activeRuns.Add($timeoutRun)
    Assert-True $timeoutRun.timedOut 'controlled inherited-pipe run reaches timeout'
    Assert-True $timeoutRun.termination.succeeded 'timeout terminates the full recursive tree'
    Assert-Equal 0 @($timeoutRun.ownedProcessesRemaining).Count 'timeout leaves no parent, child, or grandchild'
    Assert-True $timeoutRun.outputCaptureComplete 'timeout does not wait indefinitely on inherited pipes'
    Assert-True ($timeoutRun.durationMs -lt 3500) 'timeout returns inside execution, termination, and pipe-drain bounds'

    function Stop-OwnedProcessInstance([Diagnostics.Process]$Process) { throw "injected termination failure for PID $($Process.Id)" }
    $failureRun = $null
    try {
        $failureRun = Invoke-External -FilePath $powershellPath -Arguments @('-NoProfile','-Command','[Console]::Out.WriteLine("pipe-open"); Start-Sleep -Seconds 20') -TimeoutSeconds 1 -WorkingDirectory $script:Scratch -Label 'forced-termination-failure' -TerminationTimeoutMilliseconds 300 -PipeDrainTimeoutMilliseconds 100
        $activeRuns.Add($failureRun)
        Assert-True $failureRun.timedOut 'forced-failure run reaches timeout'
        Assert-False $failureRun.termination.succeeded 'termination failure is not swallowed'
        Assert-True (@($failureRun.termination.errors).Count -gt 0) 'termination errors are retained in command evidence'
        Assert-True (@($failureRun.ownedProcessesRemaining).Count -gt 0) 'failed termination reports live owned residue'
        Assert-False $failureRun.outputCaptureComplete 'open inherited pipes are reported as incomplete'
        Assert-True ($failureRun.durationMs -lt 2500) 'forced termination failure still returns within all configured bounds'
    } finally {
        Set-Item -Path function:Stop-OwnedProcessInstance -Value $productionStopOwnedProcessInstance
        if ($null -ne $failureRun) {
            $owned = @{}
            foreach ($identity in @($failureRun.ownedProcessIdentities)) { $owned[[int]$identity.processId] = $identity }
            [void](Stop-ProcessTree $failureRun.rootProcessId $owned 2000)
        }
    }

    $fastGrandchildScript = Join-Path $script:Scratch 'fast-grandchild.ps1'
    $fastIntermediateScript = Join-Path $script:Scratch 'fast-intermediate.ps1'
    $fastParentScript = Join-Path $script:Scratch 'fast-parent.ps1'
    Write-Utf8Text $fastGrandchildScript "[Console]::Out.WriteLine('fast-grandchild-ready'); [Console]::Out.Flush(); Start-Sleep -Seconds 20"
    $fastGrandchildLiteral = ConvertTo-SingleQuotedLiteral $fastGrandchildScript
    $fastIntermediateLiteral = ConvertTo-SingleQuotedLiteral $fastIntermediateScript
    Write-Utf8Text $fastIntermediateScript "Start-Process -FilePath $powerShellLiteral -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$fastGrandchildLiteral) -NoNewWindow"
    Write-Utf8Text $fastParentScript "& $powerShellLiteral -NoProfile -ExecutionPolicy Bypass -File $fastIntermediateLiteral; Start-Sleep -Seconds 20"
    $fastRun = Invoke-External -FilePath $powershellPath -Arguments @('-NoProfile','-ExecutionPolicy','Bypass','-File',$fastParentScript) -TimeoutSeconds 1 -WorkingDirectory $script:Scratch -Label 'fast-exit-intermediate' -TerminationTimeoutMilliseconds 1500 -PipeDrainTimeoutMilliseconds 250
    $activeRuns.Add($fastRun)
    Assert-True $fastRun.timedOut 'fast-intermediate fixture reaches timeout'
    Assert-True $fastRun.termination.succeeded 'event edges connect through an intermediate that exits before polling'
    Assert-True (@($fastRun.ownedProcessIds).Count -ge 2) 'living grandchild beyond fast-exit intermediate is tracked'
    $fastIntermediateEdge = @($fastRun.ownershipEdges | Where-Object {
        $candidateId = [int]$_.processId
        [int]$_.parentProcessId -eq [int]$fastRun.rootProcessId -and @($fastRun.ownershipEdges | Where-Object { [int]$_.parentProcessId -eq $candidateId }).Count -gt 0
    }) | Select-Object -First 1
    Assert-True ($null -ne $fastIntermediateEdge) 'start-event evidence retains the fast intermediate edge'
    Assert-True (@($fastRun.ownershipEdges | Where-Object { [int]$_.parentProcessId -eq [int]$fastIntermediateEdge.processId }).Count -ge 1) 'start-event evidence connects the grandchild through the exited intermediate'
    Assert-Equal 0 @($fastRun.ownedProcessesRemaining).Count 'fast-intermediate tree leaves no process alive'

    $realIdentity = Get-ProcessIdentity $PID
    $staleIdentity = [pscustomobject]@{ processId=$PID; startTimeUtcTicks=([int64]$realIdentity.startTimeUtcTicks - 1) }
    Assert-False (Test-ProcessIdentity $staleIdentity) 'stale PID identity is not considered live'
    $staleStopRefused = $false
    try { Stop-OwnedProcessIdentity $staleIdentity } catch { $staleStopRefused = $true }
    Assert-True $staleStopRefused 'termination refuses a PID whose start-time identity is stale'
    Assert-True (Test-ProcessIdentity $realIdentity) 'stale identity refusal does not terminate the reused-PID stand-in'

    $outputCap = 4096
    $largeOutputRun = Invoke-External -FilePath $powershellPath -Arguments @('-NoProfile','-Command','$s="x"*20000; [Console]::Out.Write($s); [Console]::Error.Write($s)') -TimeoutSeconds 5 -WorkingDirectory $script:Scratch -Label 'bounded-output' -OutputByteCap $outputCap
    Assert-Equal 0 $largeOutputRun.exitCode 'large-output command exits successfully while streams drain'
    Assert-True $largeOutputRun.outputCaptureComplete 'bounded output capture continues draining both streams'
    Assert-Equal 20000 $largeOutputRun.stdoutTotalBytes 'stdout total byte evidence records bytes beyond cap'
    Assert-Equal 20000 $largeOutputRun.stderrTotalBytes 'stderr total byte evidence records bytes beyond cap'
    Assert-True $largeOutputRun.stdoutTruncated 'stdout truncation is recorded'
    Assert-True $largeOutputRun.stderrTruncated 'stderr truncation is recorded'
    Assert-True ([Text.Encoding]::UTF8.GetByteCount($largeOutputRun.stdout) -le $outputCap) 'retained stdout obeys byte cap'
    Assert-True ([Text.Encoding]::UTF8.GetByteCount($largeOutputRun.stderr) -le $outputCap) 'retained stderr obeys byte cap'

    $normalRun = Invoke-External -FilePath $powershellPath -Arguments @('-NoProfile','-Command','Write-Output "stdout-evidence"; [Console]::Error.WriteLine("stderr-evidence")') -TimeoutSeconds 3 -WorkingDirectory $script:Scratch -Label 'completed-output-evidence'
    Assert-Equal 0 $normalRun.exitCode 'completed command exits successfully'
    Assert-True ($normalRun.stdout -match 'stdout-evidence') 'completed command records stdout'
    Assert-True ($normalRun.stderr -match 'stderr-evidence') 'completed command records stderr'
    Assert-True $normalRun.outputCaptureComplete 'completed command captures both output streams'

    Write-Host 'All bounded process runner validation tests passed.'
} finally {
    Set-Item -Path function:Stop-OwnedProcessInstance -Value $productionStopOwnedProcessInstance
    foreach ($run in $activeRuns) {
        foreach ($identity in @($run.ownedProcessIdentitiesRemaining)) { try { Stop-OwnedProcessIdentity $identity } catch { } }
    }
    Remove-Item -LiteralPath $script:Scratch -Recurse -Force -ErrorAction SilentlyContinue
}
