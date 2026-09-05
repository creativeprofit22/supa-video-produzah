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

function New-MockRun([string]$Label, [int]$ExitCode, [string]$Stdout, [int[]]$OwnedProcessIds = @(2147483000)) {
    $identities = @($OwnedProcessIds | ForEach-Object { $identity=Get-ProcessIdentity ([int]$_); if ($null -ne $identity) { $identity } else { [pscustomobject]@{ processId=[int]$_; startTimeUtcTicks=[int64]1 } } })
    return [pscustomobject][ordered]@{
        label=$Label
        exitCode=$ExitCode
        timedOut=$false
        durationMs=1
        baselineSystemVramMiB=100
        peakSystemVramMiB=100
        ownershipTrackingAvailable=$true
        ownedProcessIds=$OwnedProcessIds
        ownedProcessIdentities=$identities
        ownedProcessesRemaining=@()
        stdout=$Stdout
        stderr=''
    }
}

$script:Scratch = Join-Path ([IO.Path]::GetTempPath()) ('nemo-failure-probe-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $script:Scratch -Force | Out-Null
$script:MockMode = 'normal'
$script:InvocationLabels = New-Object System.Collections.Generic.List[string]
$script:AclRestoreCalls = New-Object System.Collections.Generic.List[string]
$script:Thresholds.requirements.failureTimeoutSeconds = 0

$childScript = Join-Path $script:Scratch 'owned-child.ps1'
$parentScript = Join-Path $script:Scratch 'owned-parent.ps1'
Write-Utf8Text $childScript 'Start-Sleep -Seconds 10'
$powershellPath = (Get-Command powershell.exe -ErrorAction Stop).Source
$childArgument = '"' + $childScript + '"'
Write-Utf8Text $parentScript ("Start-Process -FilePath '$powershellPath' -ArgumentList @('-NoProfile','-File','$childArgument') | Out-Null`r`nStart-Sleep -Seconds 10")
$ownershipRun = $null
try {
    $ownershipRun = Invoke-External $powershellPath @('-NoProfile','-ExecutionPolicy','Bypass','-File',$parentScript) 1 $script:Scratch 'owned-child-integration' -TerminationTimeoutMilliseconds 2000 -PipeDrainTimeoutMilliseconds 250
    Assert-Equal 'win32-process-start-trace-with-snapshot-fallback' $ownershipRun.ownershipTracking 'pre-launch recursive process tracking is used without a production Job Object'
    Assert-True $ownershipRun.ownershipTrackingAvailable 'recursive PID ownership tracking remains available'
    Assert-True (@($ownershipRun.ownedProcessIds).Count -ge 2) 'recursive tracking captures the spawned child PID'
    Assert-True $ownershipRun.timedOut 'controlled process reaches the shared runner timeout'
    Assert-True $ownershipRun.termination.succeeded 'shared runner terminates the controlled process tree'
    Assert-Equal 0 @($ownershipRun.ownedProcessesRemaining).Count 'shared runner leaves no controlled child residue'
    Assert-True ($ownershipRun.durationMs -lt 4000) 'inherited output handles cannot defeat the configured timeout and drain bounds'
} finally {
    if ($null -ne $ownershipRun -and @($ownershipRun.ownedProcessesRemaining).Count -gt 0) {
        $owned = @{}
        foreach ($identity in @($ownershipRun.ownedProcessIdentities)) { $owned[[int]$identity.processId] = $identity }
        [void](Stop-ProcessTree $ownershipRun.rootProcessId $owned 2000)
    }
}
function Get-CurrentVramUsedMiB {
    if ($script:MockMode -eq 'leaked-vram') { return 500 }
    return 100
}

function Get-MockFailureContract([string]$Label) {
    if ($Label -in @('failure-missing-model','diarization-missing-companion','diarization-standalone-missing')) { return @(3,'missing_model','The requested model file is missing; provide an existing model path.') }
    if ($Label -in @('failure-missing-input','failure-unsupported-extension','failure-metal-device')) { return @(2,'invalid_argument','The supplied argument is invalid; correct the input, extension, or device.') }
    return @(1,'runtime_error','The operation failed at runtime; inspect the input or output destination.')
}

function Invoke-External {
    param(
        [Parameter(Mandatory=$true)][string]$FilePath,
        [string[]]$Arguments = @(),
        [int]$TimeoutSeconds = 120,
        [string]$WorkingDirectory = $script:Scratch,
        [string]$Label = 'process',
        [switch]$Observe
    )
    $script:InvocationLabels.Add($Label)
    if ($Label -eq 'failure-acl-deny') { return New-MockRun $Label 0 '{}' }
    if ($script:MockMode -eq 'acl-exception' -and $Label -eq 'failure-missing-model') { throw 'injected failure after ACL denial' }

    if ($Label -eq 'diarization-without-companion') {
        $output = $Arguments[-1]
        if ($script:MockMode -eq 'malformed-diarization-error') { return New-MockRun $Label 2 '{malformed' }
        if ($script:MockMode -eq 'unexpected-diarization-error') { return New-MockRun $Label 1 '{"error":{"type":"runtime_error","message":"Unexpected diarization failure."}}' }
        if ($script:MockMode -eq 'empty-diarization-output') { Write-Utf8Text $output '{}'; return New-MockRun $Label 0 '{}' }
        Write-Utf8Text $output '{"file":"controlled.wav","text":"hello","confidence":0.9,"duration":2.0,"languages":["en"],"words":[{"word":"hello","start":0,"end":1,"confidence":0.9}]}'
        return New-MockRun $Label 0 '{}'
    }

    $contract = Get-MockFailureContract $Label
    $exitCode = [int]$contract[0]
    $type = [string]$contract[1]
    $message = [string]$contract[2]
    $stdout = ([ordered]@{ error=[ordered]@{ type=$type; message=$message } } | ConvertTo-Json -Compress)
    $output = if ($Arguments.Count) { $Arguments[-1] } else { $null }

    if ($script:MockMode -eq 'overwrite-existing' -and $Label -eq 'failure-existing-output') { Write-Utf8Text $output '{"overwritten":true}' }
    if ($script:MockMode -eq 'malformed-error' -and $Label -eq 'failure-malformed-wav') { $stdout = '{malformed' }
    if ($script:MockMode -eq 'diarization-output-on-error' -and $Label -eq 'diarization-missing-companion') { Write-Utf8Text $output '{"accepted":true}' }
    $owned = if ($script:MockMode -eq 'leaked-child') { @($PID) } else { @(2147483000) }
    return New-MockRun $Label $exitCode $stdout $owned
}

$productionRestoreAccessControlList = ${function:Restore-AccessControlList}
$aclProbe = Join-Path $script:Scratch 'acl-restore-integration'
New-Item -ItemType Directory -Path $aclProbe -Force | Out-Null
$originalAcl = Get-Acl -LiteralPath $aclProbe -ErrorAction Stop
$aclMutationApplied = $false
$aclExceptionCaught = $false
$aclRestoredAfterException = $false
try {
    & "$env:SystemRoot\System32\icacls.exe" $aclProbe /inheritance:r /deny "$env:USERNAME`:(W)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not apply ACL mutation for restoration integration test.' }
    $aclMutationApplied = $true
    throw 'injected exception after ACL mutation'
} catch {
    $aclExceptionCaught = $true
} finally {
    $aclRestoredAfterException = & $productionRestoreAccessControlList $aclProbe $originalAcl
}
Assert-True $aclMutationApplied 'ACL restoration test mutates the controlled directory'
Assert-True $aclExceptionCaught 'ACL restoration test injects an exception after mutation'
Assert-True $aclRestoredAfterException 'production ACL helper restores the original descriptor after exception'

function Restore-AccessControlList([string]$Path, $OriginalAcl) {
    $script:AclRestoreCalls.Add($Path)
    return $true
}

try {
    $tinyPath = Join-Path $script:Scratch 'tiny.wav'
    Write-Utf8Text $tinyPath 'controlled tiny fixture'
    $tiny = [pscustomobject]@{ path=$tinyPath }
    $uglyPath = Join-Path $script:Scratch 'ugly.wav'
    Write-Utf8Text $uglyPath 'controlled ugly fixture'
    $ugly = [pscustomobject]@{ path=$uglyPath; reference='hello'; duration=2.0 }

    $script:MockMode = 'normal'
    $matrix = Test-FailureMatrix 'controlled.exe' 'cuda:0' 'model.gguf' $tiny
    Assert-True $matrix.pass 'all seven controlled failure cases pass the full gate'
    Assert-Equal 7 @($matrix.rows).Count 'failure matrix executes exactly seven cases'
    Assert-Equal 7 @($matrix.rows | Where-Object { $_.errorContract.exactlyOne -and $_.errorContract.sanitized -and $_.errorContract.actionable }).Count 'each failure has one sanitized actionable JSON error'
    Assert-Equal 7 @($matrix.rows | Where-Object { $_.recovery.processesRecovered -and $_.recovery.vramRecovered }).Count 'each failure records process and VRAM recovery'
    Assert-Equal 7 @($matrix.rows | Where-Object { $_.outputCleaned }).Count 'each failure output is cleaned'
    $existing = @($matrix.rows | Where-Object { $_.id -eq 'existing-output' })[0]
    Assert-True $existing.existingOutputUnchanged 'preexisting output bytes remain unchanged'
    Assert-Equal $existing.preOutputHash $existing.postOutputHash 'preexisting output hash is stable'
    Assert-True $matrix.aclRestored 'ACL is restored after the normal matrix'

    $script:MockMode = 'overwrite-existing'
    $overwritten = Test-FailureMatrix 'controlled.exe' 'cuda:0' 'model.gguf' $tiny
    Assert-False $overwritten.pass 'overwritten existing output fails the matrix'
    Assert-False (@($overwritten.rows | Where-Object { $_.id -eq 'existing-output' })[0].existingOutputUnchanged) 'overwritten bytes are detected by hash'

    $script:MockMode = 'leaked-child'
    $leakedChild = Test-FailureMatrix 'controlled.exe' 'cuda:0' 'model.gguf' $tiny
    Assert-False $leakedChild.pass 'live owned child fails recovery'
    Assert-False $leakedChild.rows[0].recovery.processesRecovered 'live owned PID is reported'
    Assert-True $leakedChild.rows[0].residueCleanup.needed 'leaked child triggers bounded cleanup'
    Assert-False $leakedChild.rows[0].residueCleanup.pass 'harness PID safety guard prevents unsafe cleanup'

    $script:MockMode = 'leaked-vram'
    $leakedVram = Test-FailureMatrix 'controlled.exe' 'cuda:0' 'model.gguf' $tiny
    Assert-False $leakedVram.pass 'unreclaimed per-case VRAM fails recovery'
    Assert-False $leakedVram.rows[0].recovery.vramRecovered 'post-case VRAM residue is reported'

    $script:MockMode = 'malformed-error'
    $malformedError = Test-FailureMatrix 'controlled.exe' 'cuda:0' 'model.gguf' $tiny
    Assert-False $malformedError.pass 'malformed error JSON fails the matrix'
    Assert-False (@($malformedError.rows | Where-Object { $_.id -eq 'malformed-wav' })[0].errorContract.parseable) 'malformed error JSON is explicit evidence'

    $script:MockMode = 'acl-exception'
    $script:AclRestoreCalls.Clear()
    $threw = $false
    try { [void](Test-FailureMatrix 'controlled.exe' 'cuda:0' 'model.gguf' $tiny) } catch { $threw = $true }
    Assert-True $threw 'injected matrix exception propagates'
    Assert-Equal 1 $script:AclRestoreCalls.Count 'original ACL restoration runs exactly once after exception'

    $script:MockMode = 'normal'
    $diarization = Test-DiarizationReality 'controlled.exe' 'cuda:0' 'model.gguf' $ugly
    Assert-True $diarization.pass 'all three unavailable-diarization probes pass the full gate'
    Assert-Equal 3 @($diarization.probes).Count 'diarization executes exactly three probes'
    Assert-Equal 3 @($diarization.probes | Where-Object { $_.outputCleaned -and $_.recovery.pass }).Count 'every diarization probe cleans output and recovers resources'
    Assert-Equal 2 @($diarization.probes | Where-Object { $_.errorContract -and $_.errorContract.pass }).Count 'both missing-model probes enforce JSON error contracts'
    Assert-True (@($diarization.probes | Where-Object { $_.id -eq 'without-companion' })[0].outputSchemaValid) 'successful no-companion output satisfies the ASR schema'

    foreach ($invalidContract in @(
        '{"error":null,"type":"missing_model","message":"actionable fallback"}',
        '{"error":{"type":["missing_model"],"message":123}}',
        '{"error":{"type":"missing_model","message":"actionable"},"errors":[]}',
        '{"error":{"type":"missing_model","message":"x"}}'
    )) {
        Assert-False (Measure-JsonErrorContract $invalidContract 'missing_model').pass 'invalid or non-actionable JSON error is rejected'
    }
    $script:MockMode = 'malformed-diarization-error'
    $malformedDiarization = Test-DiarizationReality 'controlled.exe' 'cuda:0' 'model.gguf' $ugly
    Assert-False $malformedDiarization.pass 'nonzero diarization without parseable JSON fails'

    $script:MockMode = 'unexpected-diarization-error'
    $unexpectedDiarization = Test-DiarizationReality 'controlled.exe' 'cuda:0' 'model.gguf' $ugly
    Assert-False $unexpectedDiarization.pass 'wrong no-companion exit and error type fail'

    $script:MockMode = 'empty-diarization-output'
    $emptyDiarization = Test-DiarizationReality 'controlled.exe' 'cuda:0' 'model.gguf' $ugly
    Assert-False $emptyDiarization.pass 'empty successful no-companion output fails ASR schema validation'
    $script:MockMode = 'diarization-output-on-error'
    $residualDiarization = Test-DiarizationReality 'controlled.exe' 'cuda:0' 'model.gguf' $ugly
    $residualProbe = @($residualDiarization.probes | Where-Object { $_.id -eq 'missing-companion' })[0]
    Assert-False $residualDiarization.pass 'accepted output from failed diarization fails'
    Assert-True $residualProbe.unexpectedAcceptedOutput 'failed diarization output residue is detected'
    Assert-True $residualProbe.outputCleaned 'failed diarization output residue is removed'

    Write-Host 'All failure-matrix and unavailable-diarization validation tests passed.'
} finally {
    Remove-Item -LiteralPath $script:Scratch -Recurse -Force -ErrorAction SilentlyContinue
}
