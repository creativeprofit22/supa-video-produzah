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

function Use-TestBundle([string]$Name) {
    $script:EvidenceRoot = Join-Path ([IO.Path]::GetTempPath()) ("nemo-evidence-schema-$Name-" + [guid]::NewGuid().ToString('N'))
    $script:RawRoot = Join-Path $script:EvidenceRoot 'raw'
    New-Item -ItemType Directory -Path $script:RawRoot -Force | Out-Null
    $script:Commands = New-Object System.Collections.Generic.List[object]
    $script:Failures = New-Object System.Collections.Generic.List[string]
    $script:Warnings = New-Object System.Collections.Generic.List[string]
    return $script:EvidenceRoot
}

function Assert-NoBom([string]$Path, [string]$Label) {
    $bytes = [IO.File]::ReadAllBytes($Path)
    $hasBom = ($bytes.Length -ge 3 -and $bytes[0] -eq 0xef -and $bytes[1] -eq 0xbb -and $bytes[2] -eq 0xbf)
    Assert-False $hasBom $Label
}

function Assert-ManifestHashes([string]$Root) {
    $manifest = Get-Content -LiteralPath (Join-Path $Root 'manifest.json') -Raw | ConvertFrom-Json
    foreach ($entry in @($manifest.files)) {
        $path = Join-Path $Root ([string]$entry.path).Replace('/', [IO.Path]::DirectorySeparatorChar)
        Assert-True (Test-Path -LiteralPath $path -PathType Leaf) "manifest path exists: $($entry.path)"
        Assert-Equal ([string]$entry.sha256) (Get-Sha256 $path) "manifest hash: $($entry.path)"
    }
}

$bundles = New-Object System.Collections.Generic.List[string]
try {
    # Exercise the real source helper and persistence, without network or a checkout.
    $originalGit = ${function:Invoke-SourceGit}
    $originalProvenance = ${function:Get-SourceProvenance}
    $originalScratch = $script:Scratch
    try {
        function Invoke-SourceGit { return @{ exitCode=0; timedOut=$false } }
        function Get-SourceProvenance { return $script:LocalProvenanceFixture }
        $script:LocalProvenanceFixture = [ordered]@{
            verified=$true; issues=@(); origin='https://example.test/source.git'; head=('a'*40); tree=('b'*40)
            detached=$true; fsckExit=0; clean=$true; status=@(); statusFormat='porcelain-v1-z'
            dirtyState=@{clean=$true; entries=@()}; patches=@{verified=$true}
            submodules=@{verified=$true; status=@(@{path='vendor/nested'; sha=('c'*40)}); origins=@('https://example.test/nested.git')}
        }
        foreach ($boundary in @('network','json','license')) {
            $bundle = Use-TestBundle "source-$boundary"
            $bundles.Add($bundle)
            $script:Scratch = $bundle
            New-Item -ItemType Directory -Path (Join-Path $bundle 'source-pinned/LICENSE') -Force | Out-Null
            $script:SourceAcquisitionState = $null
            function Invoke-WebRequest {
                if ($boundary -eq 'network') { throw 'Injected commit API failure' }
                if ($boundary -eq 'json') { return @{Content='not JSON'} }
                return @{Content='{"commit":{"verification":{"verified":true}}}'}
            }
            $stages = New-EvidenceStages
            $caught = $false
            try { Get-VerifiedSource | Out-Null } catch { $caught = $true }
            Assert-True $caught "$boundary failure is propagated"
            Assert-True ($null -ne $script:SourceAcquisitionState) "$boundary preserves progressive source state"
            $partial = $script:SourceAcquisitionState
            Set-EvidenceStage $stages 'source' 'FAIL' 'Injected external boundary failure.'
            Set-EvidenceStage $stages 'submodules' $(if ($partial.provenance.submodules.verified) { 'PASS' } else { 'FAIL' }) 'Local verification completed.'
            Write-AcquisitionEvidence $partial $null $stages
            $saved = Get-Content -LiteralPath (Join-Path $script:RawRoot 'acquisition.json') -Raw | ConvertFrom-Json
            Assert-Equal 'FAIL' $saved.status "$boundary source fails"
            Assert-False $saved.runtime.verified "$boundary never promotes partial verification"
            Assert-Equal ($script:LocalProvenanceFixture | ConvertTo-Json -Depth 20 -Compress) ($saved.runtime.provenance | ConvertTo-Json -Depth 20 -Compress) "$boundary retains complete local evidence"
            Assert-Equal 'PASS' $stages.submodules.status "$boundary retains local submodule result"
            Assert-Equal $(if ($boundary -eq 'license') { 'PASS' } else { 'FAIL' }) $saved.runtime.commitApi.status "$boundary commit API status"
            Assert-Equal $(if ($boundary -eq 'license') { 'FAIL' } else { 'PENDING' }) $saved.runtime.licenseCheck.status "$boundary license status"
            foreach ($stage in @('build','model','fixtures','transcription','measurement')) {
                Assert-Equal 'NOT_RUN' $stages[$stage].status "$boundary downstream $stage is not run"
            }
        }
    } finally {
        ${function:Invoke-SourceGit} = $originalGit
        ${function:Get-SourceProvenance} = $originalProvenance
        Remove-Item Function:Invoke-WebRequest
        $script:Scratch = $originalScratch
    }

    # Mock a bundle that stops at preflight. Known run-owned residue must be replaced,
    # while every stage and empty table remains machine-readable.
    $failedRoot = Use-TestBundle 'preflight-fail'
    $bundles.Add($failedRoot)
    Write-Utf8Text (Join-Path $script:RawRoot 'transcribe-stale.json') '{"stale":true}'
    Write-Utf8Text (Join-Path $script:RawRoot 'gpu-proof-stale.json') '{"stale":true}'
    $failedStages = New-EvidenceStages
    Reset-RunScopedEvidence 'Preflight has not completed.'
    Set-EvidenceStage $failedStages 'preflight' 'FAIL' 'Required CUDA toolkit was not found.'
    Set-EvidenceStage $failedStages 'source' 'NOT_RUN' 'Source acquisition was blocked by failed preflight.'
    Set-EvidenceStage $failedStages 'submodules' 'NOT_RUN' 'Submodule verification was blocked by failed preflight.'
    Set-EvidenceStage $failedStages 'build' 'NOT_RUN' 'Builds were blocked by failed preflight.'
    Set-EvidenceStage $failedStages 'model' 'NOT_RUN' 'Model acquisition was blocked by failed preflight.'
    Set-EvidenceStage $failedStages 'fixtures' 'NOT_RUN' 'Fixture generation was blocked by failed preflight.'
    Set-EvidenceStage $failedStages 'transcription' 'NOT_RUN' 'Transcription was blocked by failed preflight.'
    Set-EvidenceStage $failedStages 'measurement' 'NOT_RUN' 'Measurement was blocked by failed preflight.'
    Set-EvidenceStage $failedStages 'cleanup' 'PASS' 'No scratch residue remained after bounded cleanup.'
    Set-EvidenceStage $failedStages 'repository-isolation' 'PASS' 'Final repository status stayed within the evidence allowlist.'
    Sync-StageArtifacts $failedStages

    Assert-False (Test-Path -LiteralPath (Join-Path $script:RawRoot 'transcribe-stale.json')) 'stale transcription evidence is removed at run start'
    Assert-False (Test-Path -LiteralPath (Join-Path $script:RawRoot 'gpu-proof-stale.json')) 'stale GPU proof evidence is removed at run start'
    $preflight = Get-Content -LiteralPath (Join-Path $script:RawRoot 'preflight.json') -Raw | ConvertFrom-Json
    Assert-Equal 'FAIL' $preflight.status 'preflight artifact reports failure'
    Assert-Equal 'Required CUDA toolkit was not found.' $preflight.reason 'preflight artifact reports actual reason'
    $fixtureNotRun = Get-Content -LiteralPath (Join-Path $script:RawRoot 'fixture-manifest.json') -Raw | ConvertFrom-Json
    Assert-Equal 'NOT_RUN' $fixtureNotRun.status 'fixture manifest is truthful on early failure'
    Assert-True (-not [string]::IsNullOrWhiteSpace([string]$fixtureNotRun.reason)) 'fixture manifest has a reason'
    $transcribeNotRun = Get-Content -LiteralPath (Join-Path $script:RawRoot 'transcribe-not-run.json') -Raw | ConvertFrom-Json
    Assert-Equal 'NOT_RUN' $transcribeNotRun.status 'transcription placeholder is truthful on early failure'
    $pendingAcquisition = Get-Content -LiteralPath (Join-Path $script:RawRoot 'acquisition.json') -Raw | ConvertFrom-Json
    Assert-False (Test-ObjectProperty $pendingAcquisition 'commands') 'command ledger is not serialized before final repository status'
    Assert-True ((Get-Content -LiteralPath (Join-Path $script:RawRoot 'source-state.txt') -Raw) -match '^status=NOT_RUN\nreason=Source acquisition') 'source text artifact is rewritten truthfully'
    foreach ($name in $script:StageNames) {
        Assert-True ($failedStages[$name].status -in @('PASS','FAIL','NOT_RUN')) "stage status is explicit: $name"
        Assert-True (-not [string]::IsNullOrWhiteSpace([string]$failedStages[$name].reason)) "stage reason exists: $name"
    }
    foreach ($table in @(
        @{name='metrics.csv';columns=$script:MetricColumns},
        @{name='resource-samples.csv';columns=$script:ResourceSampleColumns},
        @{name='network-observation.csv';columns=$script:NetworkSampleColumns},
        @{name='process-lifecycle.csv';columns=$script:ProcessLifecycleColumns}
    )) {
        $path = Join-Path $script:RawRoot $table.name
        $expectedHeader = ($table.columns | ForEach-Object { '"' + $_ + '"' }) -join ','
        Assert-Equal $expectedHeader (Get-Content -LiteralPath $path -First 1) "stable empty header: $($table.name)"
        Assert-NoBom $path "UTF-8 without BOM: $($table.name)"
    }

    # Mock a fully staged bundle, including real fixture/transcription/proof files and
    # an injected repository-isolation failure at finalization.
    $successRoot = Use-TestBundle 'staged-success'
    $bundles.Add($successRoot)
    Write-Utf8Text (Join-Path $script:RawRoot 'transcribe-prior.json') '{"prior":true}'
    Write-Utf8Text (Join-Path $script:RawRoot 'gpu-proof-prior.json') '{"prior":true}'
    Reset-RunScopedEvidence 'New staged run has not reached transcription.'
    $successStages = New-EvidenceStages
    foreach ($name in $script:StageNames) { Set-EvidenceStage $successStages $name 'PASS' "Mock $name stage completed successfully." }

    Write-Json (Join-Path $script:RawRoot 'fixture-manifest.json') ([ordered]@{schemaVersion=2;validation=[ordered]@{passed=$true};fixtures=[ordered]@{tiny=[ordered]@{id='tiny'}}})
    Set-FixtureManifestStatus 'PASS' 'All generated fixture assertions passed.'
    Write-Utf8Text (Join-Path $script:RawRoot 'transcribe-cuda-tiny.json') '{"text":"hello"}'
    Write-Utf8Text (Join-Path $script:RawRoot 'gpu-proof-cuda.json') '{"status":"PASS","reason":"Observed GPU allocation."}'
    Reconcile-TranscriptionArtifacts $successStages.transcription
    Assert-False (Test-Path -LiteralPath (Join-Path $script:RawRoot 'transcribe-not-run.json')) 'not-run transcription placeholder is removed when real evidence exists'
    Assert-False (Test-Path -LiteralPath (Join-Path $script:RawRoot 'transcribe-prior.json')) 'prior transcription cannot leak into a staged run'
    Assert-False (Test-Path -LiteralPath (Join-Path $script:RawRoot 'gpu-proof-prior.json')) 'prior proof cannot leak into a staged run'
    $fixturePass = Get-Content -LiteralPath (Join-Path $script:RawRoot 'fixture-manifest.json') -Raw | ConvertFrom-Json
    Assert-Equal 'PASS' $fixturePass.status 'real fixture manifest reports PASS'
    Assert-Equal 'All generated fixture assertions passed.' $fixturePass.reason 'real fixture manifest has a reason'
    Assert-True (Test-EvidenceOnlyRepositoryStatusLine ' M evidence/2026-08-09-nemo-asr-machine-validation/results.json') 'repository allowlist accepts tracked evidence updates'
    Assert-True (Test-EvidenceOnlyRepositoryStatusLine '?? evidence/2026-08-09-nemo-asr-machine-validation/raw/new.json') 'repository allowlist accepts untracked evidence updates'
    Assert-False (Test-EvidenceOnlyRepositoryStatusLine ' M src/escaped-change.cpp') 'repository allowlist rejects changes outside evidence'

    $script:Commands.Add([pscustomobject]@{sequence=1;label='repository-status-initial';exitCode=0})
    $script:Commands.Add([pscustomobject]@{sequence=2;label='repository-status-final';exitCode=0})
    Write-AcquisitionEvidence ([ordered]@{verified=$true}) ([ordered]@{verified=$true}) $successStages
    $ledger = Get-Content -LiteralPath (Join-Path $script:RawRoot 'acquisition.json') -Raw | ConvertFrom-Json
    Assert-Equal 'repository-status-final' @($ledger.commands)[-1].label 'command ledger ends with final repository status command'

    $thresholds = [ordered]@{
        wordTimestamps=[ordered]@{status='PASS';reason='mock'}
        determinism=[ordered]@{status='PASS';reason='mock'}
        longForm=[ordered]@{status='PASS';reason='mock'}
        runtime=[ordered]@{status='PASS';reason='mock'}
        cleanupIsolation=[ordered]@{status='PASS';reason='mock'}
    }
    $cleanup = [ordered]@{removed=$true;vramReturned=$true;processesRemaining=0;error=$null;pass=$true}
    $isolationReason = 'Repository diff escaped the evidence-only allowlist: src/unexpected.txt.'
    $cleanup = Complete-CleanupIsolation $cleanup $false $isolationReason $thresholds $successStages
    Add-Failure $isolationReason
    Write-Json (Join-Path $script:RawRoot 'cleanup.json') $cleanup
    Assert-False $cleanup.pass 'repository isolation failure makes cleanup fail'
    Assert-Equal 'FAIL' $cleanup.status 'repository isolation failure updates cleanup status'
    Assert-True ($cleanup.reason -match 'Repository isolation failed') 'repository isolation failure updates cleanup reason'
    Assert-Equal 'FAIL' $thresholds.cleanupIsolation.status 'repository isolation failure updates cleanup threshold'
    Assert-Equal $cleanup.reason $thresholds.cleanupIsolation.reason 'cleanup threshold reason matches cleanup artifact'
    Assert-Equal 'FAIL' $successStages.cleanup.status 'cleanup stage is consistent after isolation failure'
    Assert-Equal 'FAIL' $successStages.'repository-isolation'.status 'repository-isolation stage reports failure'

    $state = [ordered]@{
        preflight=[ordered]@{
            os=[ordered]@{caption='Mock Windows';architecture='64-bit'}
            cpu=[ordered]@{name='Mock CPU'}
            ramBytes=16GB
            selectedGpu=[ordered]@{name='Mock GTX 1080'}
            scratchFreeGiB=100
            tools=[ordered]@{git=[ordered]@{found=$true;version='git version mock'}}
        }
        stages=$successStages
        thresholds=$thresholds
        backends=[ordered]@{cuda=[ordered]@{buildExit=0;runnable=$true;sha256='abc'}}
        metrics=@([ordered]@{backend='cuda';fixture='tiny';run=[ordered]@{exitCode=0};measurement=[ordered]@{schemaValid=$true;wer=0.0}})
        diarization=[ordered]@{status='NOT_RUN';reason='mock';pass=$false}
        cancellation=[ordered]@{status='NOT_RUN';reason='mock';pass=$false}
        failureMatrix=[ordered]@{status='NOT_RUN';reason='mock';pass=$false}
    }
    Write-SpikeVerdict $state $cleanup
    $results = Get-Content -LiteralPath (Join-Path $script:EvidenceRoot 'results.json') -Raw | ConvertFrom-Json
    Assert-Equal 'FAIL' $results.cleanup.status 'results cleanup status matches cleanup artifact'
    Assert-False $results.cleanup.pass 'results cleanup pass matches cleanup artifact'
    Assert-Equal $results.cleanup.reason $results.thresholds.cleanupIsolation.reason 'results cleanup and threshold reasons are consistent'
    Assert-Equal 'FAIL' $results.stages.'repository-isolation'.status 'results include explicit repository-isolation failure'
    $readme = Get-Content -LiteralPath (Join-Path $script:EvidenceRoot 'README.md') -Raw
    Assert-True ($readme -match '## Preflight machine/toolchain summary') 'README includes bounded preflight summary'
    Assert-True ($readme -match '## Backend summary') 'README includes bounded backend summary'
    Assert-True ($readme -match '## Measurement summary') 'README includes bounded measurement summary'
    Assert-True ($readme -match 'git version mock') 'README includes bounded toolchain detail'

    Write-StableCsv (Join-Path $script:RawRoot 'metrics.csv') $script:MetricColumns @([pscustomobject]@{backend='cuda';fixture='tiny';exitCode=0})
    Write-Manifest
    Assert-ManifestHashes $script:EvidenceRoot
} finally {
    foreach ($bundle in $bundles) {
        if (Test-Path -LiteralPath $bundle) { Remove-Item -LiteralPath $bundle -Recurse -Force }
    }
}

Write-Host 'All evidence schema validation tests passed.'
