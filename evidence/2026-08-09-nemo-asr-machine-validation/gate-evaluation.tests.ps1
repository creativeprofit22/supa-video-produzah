Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $root 'gate-evaluation.ps1')
$thresholds = Get-Content -LiteralPath (Join-Path $root 'thresholds.json') -Raw | ConvertFrom-Json

function Assert-Equal($Expected, $Actual, [string]$Label) {
    if ($Expected -ne $Actual) { throw "$Label expected '$Expected', got '$Actual'." }
    Write-Host "PASS $Label -> $Actual"
}

function New-Run([string]$Stdout = '') {
    return [pscustomobject]@{ device=$null; exitCode=0; timedOut=$false; stdout=$Stdout; baselineWorkingSetBytes=100MB; peakWorkingSetBytes=1GB; workingSetIncreaseBytes=(924MB); selectedGpuIndex=1; selectedGpuUuid='GPU-GTX1080'; baselineVramMiB=500; peakVramMiB=1524; vramIncreaseMiB=1024; baselineSystemVramMiB=500; peakSystemVramMiB=1524; gpuPerProcessQueryAttempted=$true; gpuPerProcessQuerySucceeded=$true; gpuPerProcessSupported=$true; baselineOwnedGpuMemoryMiB=0; peakOwnedGpuMemoryMiB=1024; ownedGpuMemoryIncreaseMiB=1024; resourceSampleCount=1; networkSampleAttemptCount=1; networkSampleSuccessCount=1; networkObservationAvailable=$true; tcpObservationCount=0; unexpectedNetworkConnectionCount=0; observed=$true; runnerSucceeded=$true; ownershipTrackingAvailable=$true; ownershipErrors=@(); processLifecycle=@([pscustomobject]@{processId=123;isRoot=$true}); samplingErrors=@(); label='transcribe-fixture' }
}

function New-BenchRun([double]$LoadMs = 1000, [double]$Rtfx = 4) {
    $json = [ordered]@{ load_ms=$LoadMs; runs=@([ordered]@{ concurrency=1; rtfx=$Rtfx }) } | ConvertTo-Json -Depth 5 -Compress
    return New-Run $json
}

function New-DoctorRun([ValidateSet('cuda','vulkan')][string]$Backend) {
    $cuda = if ($Backend -eq 'cuda') { 'true' } else { 'false' }
    $vulkan = if ($Backend -eq 'vulkan') { 'true' } else { 'false' }
    $deviceName = if ($Backend -eq 'cuda') { 'CUDA0' } else { 'Vulkan0' }
    $json = @"
{
  "version": "0.1.0",
  "features": { "backend_cuda": $cuda, "backend_metal": false, "backend_vulkan": $vulkan },
  "devices": [{ "index": 0, "name": "$deviceName", "description": "NVIDIA GeForce GTX 1080", "type": "gpu", "memory_free": 7000000000, "memory_total": 8589934592, "async": true, "events": true }],
  "accelerator_compiled": true,
  "accelerator_available": true,
  "driver_runtime_compatible": true,
  "runtime_warnings": []
}
"@ | ConvertFrom-Json
    return [pscustomobject]@{ exitCode=0; timedOut=$false; json=$json }
}

function New-GpuEvidence([ValidateSet('cuda','vulkan')][string]$Backend, [double]$IncreaseMiB = 1024) {
    $run = New-Run
    $run.device = "${Backend}:0"
    $run.peakVramMiB = $run.baselineVramMiB + $IncreaseMiB
    return [pscustomobject]@{ backend=$Backend; fixture='jfk-smoke'; run=$run; measurement=[pscustomobject]@{schemaValid=$true} }
}

function New-Backend([string]$Name) {
    return [ordered]@{
        name=$Name
        buildExit=0
        timedOut=$false
        executablePreexisted=$false
        executableExists=$true
        exactExecutableProvenance=$true
        provenanceVerified=$true
        compilerCache=[ordered]@{ verified=$true; issues=@(); fields=[ordered]@{} }
        runnable=$true
        cmakeCachePresent=$true
        cmakeCacheSm61=$true
        cuobjdumpRan=$true
        cuobjdumpExit=0
        cuobjdumpTimedOut=$false
        cuobjdumpSm61=$true
        cudaSm61=$true
        capabilities=[ordered]@{ doctorOk=$true; modelCompatible=$true; matrix=[ordered]@{ doctor=(New-DoctorRun $Name) } }
        gpuProof=Get-GpuExecutionProof $Name "${Name}:0" (New-DoctorRun $Name) (New-GpuEvidence $Name) ([double]$thresholds.requirements.gpuAllocationIncreaseMiB) 'NVIDIA GeForce GTX 1080'
        runtimePlusModelBytes=1GB
        benchOffline=New-BenchRun
        benchStream=New-BenchRun
        determinism=[ordered]@{ runs=3; successfulRuns=3; validRuns=3; pairComparisons=3; identicalText=$true; maxSequenceDeltaWords=0; maxBoundaryDeltaMs=10; runSummaries=@(); pairs=@() }
    }
}

function New-Measurement([double]$Wer, [int]$Errors, [double]$Recall = 1.0) {
    $startErrors=@()
    $matches=@()
    for($index=0; $index -lt 100; $index++) {
        $startErrors += 75
        $matches += [ordered]@{ referenceIndex=$index; hypothesisIndex=$index; word="word$index"; expectedStartSeconds=$index; actualStartSeconds=($index+0.075); startBoundaryErrorMs=75 }
    }
    $alignment=[ordered]@{
        expected=100
        hypothesis=100
        matched=100
        alignmentCoverage=1.0
        missingCount=0
        unexpectedCount=0
        sequenceDeltaWords=0
        startErrorsMs=$startErrors
        medianStartBoundaryErrorMs=75
        p95StartBoundaryErrorMs=75
        matches=$matches
        missing=@()
        unexpected=@()
    }
    return [ordered]@{ schemaValid=$true; wer=$Wer; wordErrors=$Errors; referenceWordCount=100; keytermRecall=$Recall; timestampCoverage=1.0; invalidIntervals=0; timestampAlignment=$alignment; boundaryExpected=100; boundaryMatched=100; boundaryStartErrorsMs=$alignment.startErrorsMs }
}

function New-PassState {
    $backends = [ordered]@{ cuda=(New-Backend 'cuda'); vulkan=(New-Backend 'vulkan') }
    $metrics = @()
    foreach ($backend in @('cuda','vulkan')) {
        $metrics += [pscustomobject]@{ backend=$backend; fixture='jfk-smoke'; run=(New-Run); measurement=(New-Measurement 0.10 10) }
        $metrics += [pscustomobject]@{ backend=$backend; fixture='clean-keyterms'; run=(New-Run); measurement=(New-Measurement 0.05 5 0.875) }
        $metrics += [pscustomobject]@{ backend=$backend; fixture='ugly-dialogue'; run=(New-Run); measurement=(New-Measurement 0.20 20) }
    }
    $longMeasurement = [pscustomobject]@{ schemaValid=$true; invalidIntervals=0; expectedSentinels=40; recognizedSentinels=40; matchedSentinels=40; expectedJoins=3; measuredJoins=3; cleanJoins=3; droppedJoinWords=0; duplicatedJoinWords=0; joinChecks=@([pscustomobject]@{clean=$true},[pscustomobject]@{clean=$true},[pscustomobject]@{clean=$true}); quartileP95DriftMs=@(100,110,120,130); maxQuartileP95DriftMs=130; complete=$true }
    $metrics += [pscustomobject]@{ backend='cuda'; fixture='long-stability'; run=(New-Run); measurement=$longMeasurement }
    $metrics += [pscustomobject]@{ backend='vulkan'; fixture='long-stability'; run=(New-Run); measurement=$longMeasurement }
    return [pscustomobject]@{ preflight=[pscustomobject]@{selectedGpu=[pscustomobject]@{index=1;uuid='GPU-GTX1080';name='NVIDIA GeForce GTX 1080'}}; backends=$backends; metrics=$metrics }
}

$state = New-PassState
Assert-Equal 'PASS' (Get-SmokeAccuracyGate $state $thresholds).status 'smoke passing path'
$state = New-PassState
($state.metrics | Where-Object { $_.backend -eq 'vulkan' -and $_.fixture -eq 'ugly-dialogue' }).measurement.wer = 0.50
Assert-Equal 'FAIL' (Get-SmokeAccuracyGate $state $thresholds).status 'smoke failing path'
$state = New-PassState
$state.backends.cuda.runnable = $false
Assert-Equal 'NOT_RUN' (Get-SmokeAccuracyGate $state $thresholds).status 'smoke prerequisite path'

$state = New-PassState
Assert-Equal 'PASS' (Get-WordTimestampGate $state $thresholds).status 'timestamp passing path'
$state = New-PassState
($state.metrics | Where-Object { $_.fixture -eq 'ugly-dialogue' }) | ForEach-Object {
    $_.measurement.timestampAlignment.startErrorsMs=@(1000,1000,1000)
    $_.measurement.timestampAlignment.medianStartBoundaryErrorMs=1000
    $_.measurement.timestampAlignment.p95StartBoundaryErrorMs=1000
}
Assert-Equal 'FAIL' (Get-WordTimestampGate $state $thresholds).status 'timestamp failing path'
$state = New-PassState
$state.backends.cuda.runnable=$false
Assert-Equal 'NOT_RUN' (Get-WordTimestampGate $state $thresholds).status 'timestamp prerequisite path'

$state = New-PassState
Assert-Equal 'PASS' (Get-DeterminismGate $state $thresholds).status 'determinism passing path'
$state = New-PassState
$state.backends.cuda.determinism.maxBoundaryDeltaMs=25
Assert-Equal 'FAIL' (Get-DeterminismGate $state $thresholds).status 'determinism failing path'
$state = New-PassState
$state.backends.cuda.runnable=$false
Assert-Equal 'NOT_RUN' (Get-DeterminismGate $state $thresholds).status 'determinism prerequisite path'

$requiredGpuIncrease=[double]$thresholds.requirements.gpuAllocationIncreaseMiB
$cudaProof=Get-GpuExecutionProof 'cuda' 'cuda:0' (New-DoctorRun 'cuda') (New-GpuEvidence 'cuda') $requiredGpuIncrease 'NVIDIA GeForce GTX 1080'
Assert-Equal $true $cudaProof.pass 'expected CUDA doctor/device and allocation proof'
$vulkanProof=Get-GpuExecutionProof 'vulkan' 'vulkan:0' (New-DoctorRun 'vulkan') (New-GpuEvidence 'vulkan') $requiredGpuIncrease 'NVIDIA GeForce GTX 1080'
Assert-Equal $true $vulkanProof.pass 'expected Vulkan doctor/device and allocation proof'

$wrongBackendDoctor=New-DoctorRun 'cuda'
$wrongBackendDoctor.json.features.backend_cuda=$false
$wrongBackendDoctor.json.features.backend_vulkan=$true
$wrongBackendProof=Get-GpuExecutionProof 'cuda' 'cuda:0' $wrongBackendDoctor (New-GpuEvidence 'cuda') $requiredGpuIncrease 'NVIDIA GeForce GTX 1080'
Assert-Equal $false $wrongBackendProof.pass 'wrong compiled backend is rejected'

$wrongDeviceDoctor=New-DoctorRun 'cuda'
$wrongDeviceDoctor.json.devices[0].name='CUDA1'
$wrongDeviceProof=Get-GpuExecutionProof 'cuda' 'cuda:0' $wrongDeviceDoctor (New-GpuEvidence 'cuda') $requiredGpuIncrease 'NVIDIA GeForce GTX 1080'
Assert-Equal $false $wrongDeviceProof.pass 'wrong doctor device is rejected'

$wrongDeviceFieldsDoctor=New-DoctorRun 'cuda'
$wrongDeviceFieldsDoctor.json.devices[0].index=7
$wrongDeviceFieldsDoctor.json.devices[0].async='true'
$wrongDeviceFieldsProof=Get-GpuExecutionProof 'cuda' 'cuda:0' $wrongDeviceFieldsDoctor (New-GpuEvidence 'cuda') $requiredGpuIncrease 'NVIDIA GeForce GTX 1080'
Assert-Equal $false $wrongDeviceFieldsProof.pass 'invalid pinned doctor device field values are rejected'

$missingFieldDoctor=New-DoctorRun 'cuda'
$missingFieldDoctor.json.features.PSObject.Properties.Remove('backend_cuda')
$missingFieldDoctor.json.devices[0].PSObject.Properties.Remove('memory_total')
$missingFieldDoctor.json.PSObject.Properties.Remove('driver_runtime_compatible')
$missingFieldProof=Get-GpuExecutionProof 'cuda' 'cuda:0' $missingFieldDoctor (New-GpuEvidence 'cuda') $requiredGpuIncrease 'NVIDIA GeForce GTX 1080'
Assert-Equal $false $missingFieldProof.pass 'missing pinned doctor and device fields are rejected'

$insufficientProof=Get-GpuExecutionProof 'cuda' 'cuda:0' (New-DoctorRun 'cuda') (New-GpuEvidence 'cuda' ($requiredGpuIncrease-1)) $requiredGpuIncrease 'NVIDIA GeForce GTX 1080'
Assert-Equal $false $insufficientProof.pass 'insufficient JFK GTX 1080 allocation is rejected'

$state = New-PassState
Assert-Equal 'PASS' (Get-GpuProofGate $state $thresholds).status 'valid dual-GPU proof passing path'
$state = New-PassState
$state.backends.cuda.gpuProof.doctor.observedFeature=$false
Assert-Equal 'FAIL' (Get-GpuProofGate $state $thresholds).status 'GPU gate rejects wrong persisted backend proof'
$state = New-PassState
$state.backends.cuda.gpuProof.inference.peakVramMiB=$state.backends.cuda.gpuProof.inference.baselineVramMiB+10
$state.backends.cuda.gpuProof.inference.allocationIncreaseMiB=10
$state.backends.cuda.gpuProof.inference.pass=$false
$state.backends.cuda.gpuProof.pass=$false
Assert-Equal 'FAIL' (Get-GpuProofGate $state $thresholds).status 'GPU proof insufficient allocation path'
$state = New-PassState
$state.backends.cuda.runnable=$false
Assert-Equal 'NOT_RUN' (Get-GpuProofGate $state $thresholds).status 'GPU proof prerequisite path'

$privacyRun=New-Run
Assert-Equal 'PASS' (Get-PrivacyObservationGate @($privacyRun)).status 'privacy gate accepts complete zero-traffic observation'
$privacyRun=New-Run
$privacyRun.unexpectedNetworkConnectionCount=1
Assert-Equal 'FAIL' (Get-PrivacyObservationGate @($privacyRun)).status 'privacy gate rejects unexpected descendant traffic'
$privacyRun=New-Run
$privacyRun.networkObservationAvailable=$false
Assert-Equal 'FAIL' (Get-PrivacyObservationGate @($privacyRun)).status 'privacy gate fails closed on missing descendant observation'
$privacyRun=New-Run
$privacyRun.networkSampleSuccessCount=0
Assert-Equal 'FAIL' (Get-PrivacyObservationGate @($privacyRun)).status 'privacy gate fails closed when no TCP sample succeeds'
$privacyRun=New-Run
$privacyRun.runnerSucceeded=$false
Assert-Equal 'FAIL' (Get-PrivacyObservationGate @($privacyRun)).status 'privacy gate rejects incomplete observed-run evidence'

$state = New-PassState
$state.backends.cuda.gpuProof.inference.unexpectedNetworkConnectionCount=1
$state.backends.cuda.gpuProof.inference.pass=$false
$state.backends.cuda.gpuProof.pass=$false
Assert-Equal 'FAIL' (Get-GpuProofGate $state $thresholds).status 'GPU proof rejects unexpected traffic in inference evidence'
$state = New-PassState
$state.backends.cuda.gpuProof.inference.selectedGpuIndex=0
Assert-Equal 'FAIL' (Get-GpuProofGate $state $thresholds).status 'GPU proof rejects allocation evidence from index 0 instead of the selected GTX 1080'
$state = New-PassState
$state.backends.cuda.gpuProof.inference.gpuPerProcessSupported=$false
$state.backends.cuda.gpuProof.inference.pass=$false
$state.backends.cuda.gpuProof.pass=$false
Assert-Equal 'FAIL' (Get-GpuProofGate $state $thresholds).status 'GPU proof fails closed when owned-process allocation support is missing'

$state = New-PassState
Assert-Equal 'PASS' (Get-LongFormGate $state $thresholds $false).status 'long-form passing path'
$state = New-PassState
($state.metrics | Where-Object { $_.backend -eq 'cuda' -and $_.fixture -eq 'long-stability' }).measurement.maxQuartileP95DriftMs = 500
Assert-Equal 'FAIL' (Get-LongFormGate $state $thresholds $false).status 'long-form failing path'
$state = New-PassState
Assert-Equal 'NOT_RUN' (Get-LongFormGate $state $thresholds $true).status 'long-form skipped path'

$state = New-PassState
Assert-Equal 'PASS' (Get-RuntimeGate $state $thresholds).status 'runtime passing path'
$state = New-PassState
$state.backends.vulkan.benchStream = New-BenchRun 13000 4
Assert-Equal 'FAIL' (Get-RuntimeGate $state $thresholds).status 'runtime failing path'
$state = New-PassState
$state.backends.vulkan.capabilities.modelCompatible = $false
Assert-Equal 'NOT_RUN' (Get-RuntimeGate $state $thresholds).status 'runtime prerequisite path'

$expectedSentinelTimes=@(1.0,11.0,21.0,31.0)
$fixture = [pscustomobject]@{ duration=40.0; sentinel='production transcript'; sentinelPositions=@($expectedSentinelTimes|ForEach-Object{[pscustomobject]@{seconds=$_}}); joins=@([pscustomobject]@{index=1;seconds=10.0;referenceIndexes=@(0,1,2,3);expectedWords=@('production','transcript','production','transcript')},[pscustomobject]@{index=2;seconds=20.0;referenceIndexes=@(2,3,4,5);expectedWords=@('production','transcript','production','transcript')},[pscustomobject]@{index=3;seconds=30.0;referenceIndexes=@(4,5,6,7);expectedWords=@('production','transcript','production','transcript')}); bookmarks=@() }
$words = @()
foreach ($start in $expectedSentinelTimes) {
    $fixture.bookmarks += [pscustomobject]@{ word='production'; seconds=$start }
    $fixture.bookmarks += [pscustomobject]@{ word='transcript'; seconds=($start+0.5) }
    $words += [pscustomobject]@{ word='production'; start=$start; end=($start+0.4) }
    $words += [pscustomobject]@{ word='transcript'; start=($start+0.5); end=($start+0.9) }
}
$document = [pscustomobject]@{ words=$words }
$longMeasurement = Measure-LongForm $document $fixture
Assert-Equal $true $longMeasurement.complete 'long-form structured sentinel aggregation'
Assert-Equal 0 $longMeasurement.wer 'long-form WER uses persisted chronological gold'
Assert-Equal 0 $longMeasurement.maxQuartileP95DriftMs 'long-form quartile p95 drift'
Assert-Equal 3 $longMeasurement.expectedJoins 'long-form persisted join count'
Assert-Equal 4 @($longMeasurement.sentinelMatches).Count 'long-form sentinel identity count'
$extraSentinelDocument=[pscustomobject]@{words=@($words+[pscustomobject]@{word='production';start=39.0;end=39.2}+[pscustomobject]@{word='transcript';start=39.3;end=39.6})}
Assert-Equal $false (Measure-LongForm $extraSentinelDocument $fixture).complete 'unexpected long-form sentinel is rejected'
$droppedJoinDocument=[pscustomobject]@{words=@($words|Where-Object{[double]$_.start -ne 11.0})}
$droppedJoinMeasurement=Measure-LongForm $droppedJoinDocument $fixture
Assert-Equal $false $droppedJoinMeasurement.complete 'dropped long-form join word is rejected'
Assert-Equal $true ($droppedJoinMeasurement.droppedJoinWords -gt 0) 'dropped long-form join word is counted'

$bookmarks=@(
    [pscustomobject]@{word='Alpha,';seconds=1.0},
    [pscustomobject]@{word='BETA';seconds=2.0},
    [pscustomobject]@{word='gamma';seconds=3.0}
)
$alignedDocument=[pscustomobject]@{words=@(
    [pscustomobject]@{word='alpha';start=1.05;end=1.2},
    [pscustomobject]@{word='beta!';start=2.1;end=2.3},
    [pscustomobject]@{word='Gamma';start=3.15;end=3.4}
)}
$alignedMeasurement=Measure-BookmarkBoundaries $alignedDocument $bookmarks
Assert-Equal 3 $alignedMeasurement.matched 'aligned timestamps match normalized words'
Assert-Equal 1 $alignedMeasurement.alignmentCoverage 'aligned timestamp coverage'
Assert-Equal 100 $alignedMeasurement.medianStartBoundaryErrorMs 'aligned timestamp median boundary error'
Assert-Equal 145 $alignedMeasurement.p95StartBoundaryErrorMs 'aligned timestamp p95 boundary error'
$state=New-PassState
($state.metrics | Where-Object { $_.backend -eq 'cuda' -and $_.fixture -eq 'clean-keyterms' }).measurement.timestampAlignment=$alignedMeasurement
Assert-Equal 'PASS' (Get-WordTimestampGate $state $thresholds).status 'aligned timestamp gate evaluation'

$missingDocument=[pscustomobject]@{words=@(
    [pscustomobject]@{word='alpha';start=1.0;end=1.2},
    [pscustomobject]@{word='gamma';start=3.0;end=3.2}
)}
$missingMeasurement=Measure-BookmarkBoundaries $missingDocument $bookmarks
Assert-Equal 2 $missingMeasurement.matched 'missing timestamp matched count'
Assert-Equal 1 $missingMeasurement.missingCount 'missing timestamp reference count'
Assert-Equal 0.666667 $missingMeasurement.alignmentCoverage 'missing timestamp alignment coverage'
$state=New-PassState
($state.metrics | Where-Object { $_.backend -eq 'cuda' -and $_.fixture -eq 'clean-keyterms' }).measurement.timestampAlignment=$missingMeasurement
Assert-Equal 'FAIL' (Get-WordTimestampGate $state $thresholds).status 'missing timestamp gate evaluation'

$reorderedDocument=[pscustomobject]@{words=@(
    [pscustomobject]@{word='beta';start=1.0;end=1.2},
    [pscustomobject]@{word='alpha';start=2.0;end=2.2},
    [pscustomobject]@{word='gamma';start=3.0;end=3.2}
)}
$reorderedMeasurement=Measure-BookmarkBoundaries $reorderedDocument $bookmarks
Assert-Equal 2 $reorderedMeasurement.matched 'reordered timestamp matched count'
Assert-Equal 1 $reorderedMeasurement.missingCount 'reordered timestamp missing count'
Assert-Equal 1 $reorderedMeasurement.unexpectedCount 'reordered timestamp unexpected count'
Assert-Equal 2 $reorderedMeasurement.sequenceDeltaWords 'reordered timestamp sequence delta'
$state=New-PassState
($state.metrics | Where-Object { $_.backend -eq 'cuda' -and $_.fixture -eq 'clean-keyterms' }).measurement.timestampAlignment=$reorderedMeasurement
Assert-Equal 'FAIL' (Get-WordTimestampGate $state $thresholds).status 'reordered timestamp gate evaluation'

$driftedDocument=[pscustomobject]@{words=@(
    [pscustomobject]@{word='alpha';start=1.5;end=1.7},
    [pscustomobject]@{word='beta';start=2.5;end=2.7},
    [pscustomobject]@{word='gamma';start=3.5;end=3.7}
)}
$driftedMeasurement=Measure-BookmarkBoundaries $driftedDocument $bookmarks
Assert-Equal 500 $driftedMeasurement.medianStartBoundaryErrorMs 'drifted timestamp median boundary error'
Assert-Equal 500 $driftedMeasurement.p95StartBoundaryErrorMs 'drifted timestamp p95 boundary error'
$state=New-PassState
($state.metrics | Where-Object { $_.backend -eq 'cuda' -and $_.fixture -eq 'clean-keyterms' }).measurement.timestampAlignment=$driftedMeasurement
Assert-Equal 'FAIL' (Get-WordTimestampGate $state $thresholds).status 'drifted timestamp gate evaluation'

function New-DeterminismRun($Words, [double]$Offset = 0) {
    $run=New-Run
    $documentWords=@()
    for($index=0; $index -lt @($Words).Count; $index++) {
        $start=1.0+$index+$Offset
        $documentWords += [pscustomobject]@{word=$Words[$index];start=$start;end=($start+0.2);confidence=0.95}
    }
    $run | Add-Member -NotePropertyName document -NotePropertyValue ([pscustomobject]@{words=$documentWords})
    return $run
}

$determinismRuns=@(
    (New-DeterminismRun @('alpha','beta') 0.0),
    (New-DeterminismRun @('Alpha','BETA!') 0.005),
    (New-DeterminismRun @('alpha','beta') 0.01)
)
$determinismMeasurement=Measure-Determinism $determinismRuns
Assert-Equal $true $determinismMeasurement.identicalText 'determinism normalized sequence aggregation'
Assert-Equal 3 $determinismMeasurement.pairComparisons 'determinism three pair comparisons'
Assert-Equal 10 $determinismMeasurement.maxBoundaryDeltaMs 'determinism timestamp delta aggregation'

$missingDeterminism=Measure-Determinism @(
    (New-DeterminismRun @('alpha','beta')),
    (New-DeterminismRun @('alpha')),
    (New-DeterminismRun @('alpha','beta'))
)
Assert-Equal $false $missingDeterminism.identicalText 'determinism missing word detection'
Assert-Equal 1 $missingDeterminism.maxSequenceDeltaWords 'determinism missing word delta'

$invalidTimestampRun=New-Run
$invalidTimestampRun | Add-Member -NotePropertyName document -NotePropertyValue ([pscustomobject]@{words=@([pscustomobject]@{word='alpha';start=1.0})})
$invalidTimestampDeterminism=Measure-Determinism @(
    (New-DeterminismRun @('alpha','beta')),
    $invalidTimestampRun,
    (New-DeterminismRun @('alpha','beta'))
)
Assert-Equal 2 $invalidTimestampDeterminism.validRuns 'determinism missing timestamp field rejected'

$reorderedDeterminism=Measure-Determinism @(
    (New-DeterminismRun @('alpha','beta')),
    (New-DeterminismRun @('beta','alpha')),
    (New-DeterminismRun @('alpha','beta'))
)
Assert-Equal $false $reorderedDeterminism.identicalText 'determinism reordered word detection'
Assert-Equal 2 $reorderedDeterminism.maxSequenceDeltaWords 'determinism reordered word delta'

$driftedDeterminism=Measure-Determinism @(
    (New-DeterminismRun @('alpha','beta') 0.0),
    (New-DeterminismRun @('alpha','beta') 0.025),
    (New-DeterminismRun @('alpha','beta') 0.05)
)
Assert-Equal 50 $driftedDeterminism.maxBoundaryDeltaMs 'determinism drifted timestamp delta'
$state=New-PassState
$state.backends.cuda.determinism=$driftedDeterminism
Assert-Equal 'FAIL' (Get-DeterminismGate $state $thresholds).status 'determinism drift threshold from thresholds.json'

$state=New-PassState
Assert-Equal 'PASS' (Get-GpuBuildGate $state).status 'fully passing build evidence'

$state=New-PassState
$state.backends.cuda.buildExit=1
$state.backends.cuda.executablePreexisted=$true
$state.backends.cuda.executableExists=$true
$state.backends.cuda.exactExecutableProvenance=$false
$state.backends.cuda.runnable=$true
Assert-Equal 'FAIL' (Get-GpuBuildGate $state).status 'failed build with leftover executable is rejected'

$state=New-PassState
$state.backends.cuda.timedOut=$true
$state.backends.cuda.runnable=$true
Assert-Equal 'FAIL' (Get-GpuBuildGate $state).status 'timed-out build is rejected'

$state=New-PassState
$state.backends.cuda.cuobjdumpRan=$false
$state.backends.cuda.cuobjdumpExit=$null
$state.backends.cuda.cuobjdumpSm61=$false
$state.backends.cuda.cudaSm61=$false
Assert-Equal 'FAIL' (Get-GpuBuildGate $state).status 'missing cuobjdump proof is rejected'

$passingThresholds=[ordered]@{ provenance=[ordered]@{status='PASS'}; gpuBuilds=[ordered]@{status='PASS'}; cleanupIsolation=[ordered]@{status='PASS'} }
Assert-Equal 'FAIL_MACHINE_SPIKE' (Get-SpikeVerdict $passingThresholds @('verdict-blocking failure')) 'nonempty failures block final verdict'
Assert-Equal 'PASS_TO_BENCHMARK' (Get-SpikeVerdict $passingThresholds @()) 'fully passing state reaches benchmark verdict'

$nul = [char]0
$nonAsciiPath = "na$([char]0x00ef)ve-$([char]0x97f3)$([char]0x58f0).txt"
$porcelainText = @(
    '?? space name.txt',
    " M tab`tname.txt",
    'A  quote"name.txt',
    "?? $nonAsciiPath",
    "?? line`nbreak.txt",
    "R  renamed`ntarget.txt",
    "rename source`tname.txt",
    'C  copied "target".txt',
    'copy source.txt'
) -join $nul
$porcelainText += $nul
$porcelainEntries = @(ConvertFrom-GitPorcelainStatus $porcelainText)
Assert-Equal 7 $porcelainEntries.Count 'NUL status parser preserves every fixture record'
Assert-Equal "tab`tname.txt" $porcelainEntries[1].path 'NUL status parser preserves tabs'
Assert-Equal 'quote"name.txt' $porcelainEntries[2].path 'NUL status parser preserves quotes'
Assert-Equal $nonAsciiPath $porcelainEntries[3].path 'NUL status parser preserves non-ASCII paths'
Assert-Equal "line`nbreak.txt" $porcelainEntries[4].path 'NUL status parser preserves embedded newlines'
Assert-Equal "renamed`ntarget.txt" $porcelainEntries[5].path 'NUL rename parser preserves destination path'
Assert-Equal "rename source`tname.txt" $porcelainEntries[5].originalPath 'NUL rename parser consumes the following original path'
Assert-Equal 'copy source.txt' $porcelainEntries[6].originalPath 'NUL copy parser consumes the following original path'
$malformedRejected = $false
try { [void]@(ConvertFrom-GitPorcelainStatus "R  target.txt$nul") } catch { $malformedRejected = $true }
Assert-Equal $true $malformedRejected 'NUL rename without an original path is rejected'
$lock = Get-Content -LiteralPath (Join-Path $root 'provenance-lock.json') -Raw | ConvertFrom-Json
$statusText = (@($lock.runtime.submodules | ForEach-Object { " $($_.sha) $($_.path) ($($_.sha.Substring(0,7)))" }) -join "`n")
$originsText = (@($lock.runtime.submodules | ForEach-Object { "$($_.path)`t$($_.sha)`t$($_.origin)" }) -join "`n")
$statusRun = [pscustomobject]@{ exitCode=0; timedOut=$false; stdout=$statusText }
$originsRun = [pscustomobject]@{ exitCode=0; timedOut=$false; stdout=$originsText }
$parsedStatus = @(ConvertFrom-GitSubmoduleStatus $statusText)
Assert-Equal $lock.runtime.submodules.Count $parsedStatus.Count 'recursive submodule status parser count'
Assert-Equal ' ' $parsedStatus[0].prefix 'recursive submodule clean prefix preserved'
Assert-Equal $true (Get-SubmoduleProvenance $lock.runtime.submodules $statusRun $originsRun).verified 'recursive submodule pins accepted'
$wrongStatus = $statusText.Replace([string]$lock.runtime.submodules[0].sha, ('0' * 40))
Assert-Equal $false (Get-SubmoduleProvenance $lock.runtime.submodules ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=$wrongStatus}) $originsRun).verified 'wrong recursive submodule SHA rejected'
$nonHttpsOrigins = $originsText.Replace([string]$lock.runtime.submodules[0].origin, 'git@github.com:ggml-org/ggml.git')
Assert-Equal $false (Get-SubmoduleProvenance $lock.runtime.submodules $statusRun ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=$nonHttpsOrigins})).verified 'non-HTTPS submodule origin rejected'
Assert-Equal $false (Get-SubmoduleProvenance $lock.runtime.submodules $statusRun ([pscustomobject]@{exitCode=1;timedOut=$false;stdout='' })).verified 'failed recursive origin foreach rejected'

$patchExpected = @([pscustomobject]@{path='ggml-patches/expected.patch';sha256=('a' * 64)})
$patchObserved = @([pscustomobject]@{path='ggml-patches/expected.patch';sha256=('a' * 64)})
Assert-Equal $true (Get-PatchManifestProvenance $patchExpected $patchObserved).verified 'exact expected patch content accepted'
Assert-Equal $false (Get-PatchManifestProvenance $patchExpected @($patchObserved + [pscustomobject]@{path='ggml-patches/extra.patch';sha256=('b' * 64)})).verified 'unexpected patch file rejected'
$patchLock = [pscustomobject]@{cleanGgmlTree=('1' * 40);postPatchGgmlTree=('2' * 40)}
$expectedPatchMutation = Get-PostBuildMutationProvenance 'cuda' ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=(" M ggml$nul")}) ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=('2' * 40)}) 0 $patchLock
Assert-Equal $true $expectedPatchMutation.verified 'exact expected ggml patch mutation accepted'
$unexpectedGgmlMutation = Get-PostBuildMutationProvenance 'cuda' ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=(" M ggml$nul")}) ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=('3' * 40)}) 0 $patchLock
Assert-Equal $false $unexpectedGgmlMutation.verified 'unexpected ggml modification rejected'
$truncatedMutation = Get-PostBuildMutationProvenance 'cuda' ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=(" M ggml$nul");stdoutTruncated=$true}) ([pscustomobject]@{exitCode=0;timedOut=$false;stdout=('2' * 40)}) 0 $patchLock
Assert-Equal $false $truncatedMutation.verified 'truncated status evidence fails closed'

$cacheText = @'
CMAKE_GENERATOR:INTERNAL=Ninja
CMAKE_BUILD_TYPE:STRING=Release
CMAKE_C_COMPILER:FILEPATH=C:\VS\cl.exe
CMAKE_CXX_COMPILER:FILEPATH=C:\VS\cl.exe
CMAKE_MAKE_PROGRAM:FILEPATH=C:\Tools\ninja.exe
CMAKE_CUDA_COMPILER:FILEPATH=C:\CUDA\nvcc.exe
CMAKE_CUDA_HOST_COMPILER:FILEPATH=C:\VS\cl.exe
CMAKE_CUDA_ARCHITECTURES:STRING=61
'@
$cacheExpected = [pscustomobject]@{generator='Ninja';config='Release';cCompiler='C:\VS\cl.exe';cxxCompiler='C:\VS\cl.exe';cudaCompiler='C:\CUDA\nvcc.exe';cudaHostCompiler='C:\VS\cl.exe';cudaArch='61'}
$cacheFields = ConvertFrom-CMakeCache $cacheText
Assert-Equal $true (Get-CompilerCacheProvenance $cacheFields 'cuda' $cacheExpected).verified 'pinned compiler cache accepted'
$mismatchFields = ConvertFrom-CMakeCache $cacheText.Replace('C:\VS\cl.exe','C:\Other\cl.exe')
Assert-Equal $false (Get-CompilerCacheProvenance $mismatchFields 'cuda' $cacheExpected).verified 'compiler cache mismatch rejected'
$hostMismatchFields = ConvertFrom-CMakeCache $cacheText.Replace('CMAKE_CUDA_HOST_COMPILER:FILEPATH=C:\VS\cl.exe','CMAKE_CUDA_HOST_COMPILER:FILEPATH=C:\Other\cl.exe')
Assert-Equal $false (Get-CompilerCacheProvenance $hostMismatchFields 'cuda' $cacheExpected).verified 'CUDA host compiler cache mismatch rejected'

Write-Host 'All gate evaluation tests passed.'