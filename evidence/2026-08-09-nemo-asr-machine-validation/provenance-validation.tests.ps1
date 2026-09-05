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

function New-FixtureResponseProvider([object[]]$Responses) {
    $providerState = [pscustomobject]@{ index=0 }
    return {
        param([Uri]$Uri, [int]$TimeoutSeconds)
        if ($providerState.index -ge $Responses.Count) { throw 'Fixture response sequence was exhausted.' }
        $entry = $Responses[$providerState.index]
        $providerState.index++
        if ([string]$entry.requestUrl -cne $Uri.AbsoluteUri) { throw "Fixture expected a different request URI at index $($providerState.index - 1)." }
        if ($null -ne $entry.PSObject.Properties['transportError'] -and $entry.transportError) { throw (New-Object Net.WebException('fixture transport error')) }
        if ($null -ne $entry.PSObject.Properties['delayMilliseconds']) { Start-Sleep -Milliseconds ([int]$entry.delayMilliseconds) }
        $stream = New-Object IO.MemoryStream
        if ($null -ne $entry.PSObject.Properties['body']) {
            $bytes = [Text.Encoding]::UTF8.GetBytes([string]$entry.body)
            $stream.Write($bytes, 0, $bytes.Length)
            $stream.Position = 0
        }
        return [pscustomobject][ordered]@{
            statusCode=[int]$entry.statusCode
            location=$(if ($null -ne $entry.PSObject.Properties['location']) { [string]$entry.location } else { $null })
            responseUri=$Uri
            stream=$stream
            disposable=$null
        }
    }.GetNewClosure()
}

function Invoke-TestGit([string[]]$Arguments, [string]$WorkingDirectory, [string]$Label) {
    $run = Invoke-SourceGit -Arguments $Arguments -TimeoutSeconds 30 -WorkingDirectory $WorkingDirectory -Label $Label
    if ($run.exitCode -ne 0 -or $run.timedOut) { throw "$Label failed: $($run.stderr)" }
    return $run
}

function New-TestGitRepository([string]$Path, [string]$Content, [string]$WorkingDirectory) {
    [void](Invoke-TestGit @('init','--quiet',$Path) $WorkingDirectory 'fixture-init')
    Write-Utf8Text (Join-Path $Path 'payload.txt') $Content
    [void](Invoke-TestGit @('-C',$Path,'add','payload.txt') $WorkingDirectory 'fixture-add')
    [void](Invoke-TestGit @('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',$Path,'commit','--quiet','-m','fixture') $WorkingDirectory 'fixture-commit')
    return (Invoke-TestGit @('-C',$Path,'rev-parse','HEAD') $WorkingDirectory 'fixture-head').stdout.Trim()
}

function Get-FileUri([string]$Path) {
    return ([Uri][IO.Path]::GetFullPath($Path)).AbsoluteUri
}

$fixtures = [IO.File]::ReadAllText((Join-Path $root 'provenance-validation-fixtures.json'), [Text.Encoding]::UTF8) | ConvertFrom-Json
$lock = Get-Content -LiteralPath (Join-Path $root 'provenance-lock.json') -Raw | ConvertFrom-Json
$allowedFixtureHosts = @('huggingface.co','cdn-lfs.huggingface.co')

$matching = Test-PinnedModelMetadata $fixtures.metadataCases.matching $lock.model
Assert-True $matching.verified 'matching revision, OpenMDW-1.1 license, sibling identity, bytes, and SHA-256 verify'
Assert-Equal '1c8deaecc64b91f034d73e08dd8b64625eb3395d' $matching.revision 'matching metadata preserves parsed revision'
Assert-Equal 'openmdw-1.1' $matching.license.name 'matching metadata preserves parsed license instead of copying the lock'
Assert-Equal 'nemotron-3.5-asr-streaming-0.6b.q8_0.gguf' $matching.file.name 'matching metadata preserves parsed sibling identity'

$wrongRevision = Test-PinnedModelMetadata $fixtures.metadataCases.wrongRevision $lock.model
Assert-False $wrongRevision.verified 'wrong metadata revision fails closed'
Assert-True (@($wrongRevision.issues | Where-Object { $_ -match 'revision' }).Count -gt 0) 'wrong revision records a revision issue'

$wrongLicense = Test-PinnedModelMetadata $fixtures.metadataCases.wrongLicense $lock.model
Assert-False $wrongLicense.verified 'wrong metadata license fails closed'
Assert-True (@($wrongLicense.issues | Where-Object { $_ -match 'license' }).Count -ge 3) 'wrong license records identifier, name, and URL issues'
Assert-Equal 'Apache-2.0' $wrongLicense.license.name 'wrong metadata license evidence remains the parsed remote value'

$wrongSibling = Test-PinnedModelMetadata $fixtures.metadataCases.wrongSiblingIdentity $lock.model
Assert-False $wrongSibling.verified 'wrong sibling identity fails closed even with matching bytes and SHA-256'
Assert-True (@($wrongSibling.issues | Where-Object { $_ -match 'sibling' }).Count -gt 0) 'wrong sibling records a file identity issue'

$scratch = Join-Path ([IO.Path]::GetTempPath()) ('nemo-provenance-tests-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
try {
    $script:Scratch = $scratch
    $expectedGlobal = Join-Path $scratch 'expected-global'
    $expectedSystem = Join-Path $scratch 'expected-system'
    $expectedEnvironment = Join-Path $scratch 'expected-environment'
    $attacker = Join-Path $scratch 'redirect-target'
    $expectedGlobalHead = New-TestGitRepository $expectedGlobal "global`n" $scratch
    $expectedSystemHead = New-TestGitRepository $expectedSystem "system`n" $scratch
    $expectedEnvironmentHead = New-TestGitRepository $expectedEnvironment "environment`n" $scratch
    $attackerHead = New-TestGitRepository $attacker "redirected`n" $scratch
    Assert-False ($expectedGlobalHead -eq $attackerHead) 'hostile Git fixture commits differ'

    $globalUri = Get-FileUri $expectedGlobal
    $systemUri = Get-FileUri $expectedSystem
    $environmentUri = Get-FileUri $expectedEnvironment
    $attackerUri = Get-FileUri $attacker
    $globalConfig = Join-Path $scratch 'hostile-global.gitconfig'
    $systemConfig = Join-Path $scratch 'hostile-system.gitconfig'
    Write-Utf8Text $globalConfig ("[core]`nautocrlf = true`neol = crlf`n[url `"$attackerUri`"]`ninsteadOf = $globalUri`n")
    Write-Utf8Text $systemConfig ("[core]`nautocrlf = true`neol = crlf`n[url `"$attackerUri`"]`ninsteadOf = $systemUri`n")

    $hostileEnvironment = [ordered]@{
        GIT_CONFIG_GLOBAL=$globalConfig
        GIT_CONFIG_SYSTEM=$systemConfig
        GIT_CONFIG_NOSYSTEM='0'
        GIT_CONFIG_COUNT='1'
        GIT_CONFIG_KEY_0="url.$attackerUri.insteadOf"
        GIT_CONFIG_VALUE_0=$environmentUri
        GIT_DIR=(Join-Path $attacker '.git')
        GIT_WORK_TREE=$attacker
        GIT_INDEX_FILE=(Join-Path $attacker '.git\index')
        GIT_TERMINAL_PROMPT='1'
        GCM_INTERACTIVE='Always'
    }
    $originalEnvironment = @{}
    foreach ($name in $hostileEnvironment.Keys) {
        $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, [string]$hostileEnvironment[$name], 'Process')
    }
    try {
        $sanitized = Get-SanitizedGitEnvironment
        Assert-Equal 'NUL' $sanitized['GIT_CONFIG_GLOBAL'] 'source Git uses the Windows null global config'
        Assert-Equal 'NUL' $sanitized['GIT_CONFIG_SYSTEM'] 'source Git uses the Windows null system config'
        Assert-Equal '1' $sanitized['GIT_CONFIG_NOSYSTEM'] 'source Git disables system config discovery'
        Assert-Equal '0' $sanitized['GIT_TERMINAL_PROMPT'] 'source Git disables terminal prompts'
        Assert-False $sanitized.ContainsKey('GIT_DIR') 'source Git removes inherited repository routing'
        Assert-False $sanitized.ContainsKey('GIT_WORK_TREE') 'source Git removes inherited worktree routing'
        Assert-False $sanitized.ContainsKey('GIT_CONFIG_COUNT') 'source Git removes inherited command config routing'

        $globalClone = Join-Path $scratch 'global-clone'
        $systemClone = Join-Path $scratch 'system-clone'
        $environmentClone = Join-Path $scratch 'environment-clone'
        [void](Invoke-TestGit @('-c','protocol.file.allow=always','clone','--quiet',$globalUri,$globalClone) $scratch 'global-isolation-clone')
        [void](Invoke-TestGit @('-c','protocol.file.allow=always','clone','--quiet',$systemUri,$systemClone) $scratch 'system-isolation-clone')
        [void](Invoke-TestGit @('-c','protocol.file.allow=always','clone','--quiet',$environmentUri,$environmentClone) $scratch 'environment-isolation-clone')
        Assert-Equal $expectedGlobalHead (Invoke-TestGit @('-C',$globalClone,'rev-parse','HEAD') $scratch 'global-isolation-head').stdout.Trim() 'hostile global config cannot redirect checkout'
        Assert-Equal $expectedSystemHead (Invoke-TestGit @('-C',$systemClone,'rev-parse','HEAD') $scratch 'system-isolation-head').stdout.Trim() 'hostile system config cannot redirect checkout'
        Assert-Equal $expectedEnvironmentHead (Invoke-TestGit @('-C',$environmentClone,'rev-parse','HEAD') $scratch 'environment-isolation-head').stdout.Trim() 'inherited GIT_CONFIG entries cannot redirect checkout'
        Assert-False ([IO.File]::ReadAllBytes((Join-Path $globalClone 'payload.txt')) -contains 13) 'hostile config cannot rewrite checkout line endings'

        $routedHead = (Invoke-TestGit @('-C',$expectedGlobal,'rev-parse','HEAD') $scratch 'repository-routing-head').stdout.Trim()
        Assert-Equal $expectedGlobalHead $routedHead 'inherited GIT_DIR and GIT_WORK_TREE cannot redirect provenance'
        $deterministicArguments = @(Get-DeterministicGitArguments @('status'))
        Assert-True (($deterministicArguments -join "`n") -match 'credential\.helper=') 'source Git retains disabled credential helpers'
        Assert-True (($deterministicArguments -join "`n") -match 'core\.autocrlf=false') 'source Git retains deterministic line-ending settings'
    } finally {
        foreach ($name in $hostileEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $originalEnvironment[$name], 'Process') }
    }

    $fixturePath = Join-Path $root 'provenance-validation-fixtures.json'
    $emitterScript = '$f=[IO.File]::ReadAllText(''' + $fixturePath.Replace("'", "''") + ''',[Text.Encoding]::UTF8)|ConvertFrom-Json;$n=[char]0;$r=@($f.gitStatusPaths.untracked|ForEach-Object{"?? $_"});$r+=@(("R  "+[string]$f.gitStatusPaths.rename.destination),[string]$f.gitStatusPaths.rename.original,("C  "+[string]$f.gitStatusPaths.copy.destination),[string]$f.gitStatusPaths.copy.original);$b=[Text.Encoding]::UTF8.GetBytes(($r -join $n)+$n);$o=[Console]::OpenStandardOutput();$o.Write($b,0,$b.Length);$o.Flush()'
    $statusCapture = Invoke-External -FilePath (Get-Command powershell.exe -ErrorAction Stop).Source -Arguments @('-NoProfile','-NonInteractive','-Command',$emitterScript) -TimeoutSeconds 30 -WorkingDirectory $scratch -Label 'status-nul-capture' -ProcessOutputEncoding ([Text.Encoding]::UTF8)
    Assert-Equal 0 $statusCapture.exitCode 'NUL fixture emitter exits successfully'
    Assert-True $statusCapture.runnerSucceeded 'NUL fixture emitter completes successfully'
    Assert-True $statusCapture.outputCaptureComplete 'command capture retains complete NUL-delimited status output'
    Assert-False $statusCapture.stdoutTruncated 'command capture does not truncate the status fixture'
    Assert-True ($statusCapture.stdout.IndexOf([char]0) -ge 0) 'command capture preserves NUL separators'
    $statusEntries = @(ConvertFrom-GitPorcelainStatus $statusCapture.stdout)
    foreach ($path in @($fixtures.gitStatusPaths.untracked)) { Assert-Equal 1 @($statusEntries | Where-Object { $_.status -ceq '??' -and $_.path -ceq [string]$path }).Count "NUL status preserves fixture path '$path'" }
    $renameEntries = @($statusEntries | Where-Object { $_.status.Contains('R') })
    Assert-Equal 1 $renameEntries.Count 'NUL status capture identifies one rename'
    Assert-Equal ([string]$fixtures.gitStatusPaths.rename.destination) $renameEntries[0].path 'NUL status rename preserves destination path'
    Assert-Equal ([string]$fixtures.gitStatusPaths.rename.original) $renameEntries[0].originalPath 'NUL status rename preserves original path'
    $copyEntries = @($statusEntries | Where-Object { $_.status.Contains('C') })
    Assert-Equal 1 $copyEntries.Count 'NUL status capture identifies one copy'
    Assert-Equal ([string]$fixtures.gitStatusPaths.copy.destination) $copyEntries[0].path 'NUL status copy preserves destination path'
    Assert-Equal ([string]$fixtures.gitStatusPaths.copy.original) $copyEntries[0].originalPath 'NUL status copy preserves original path'

    $stagedRepository = Join-Path $scratch 'staged-diagnostics'
    [void](New-TestGitRepository $stagedRepository "fixture`n" $scratch)
    $trackedRelativePath = 'nested/staged tracked.txt'
    $trackedPath = Join-Path $stagedRepository $trackedRelativePath
    New-Item -ItemType Directory -Path (Split-Path -Parent $trackedPath) -Force | Out-Null
    Write-Utf8Text $trackedPath "before`n"
    [void](Invoke-TestGit @('-C',$stagedRepository,'add','--',$trackedRelativePath) $scratch 'staged-fixture-add')
    [void](Invoke-TestGit @('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-C',$stagedRepository,'commit','--quiet','-m','tracked nested fixture') $scratch 'staged-fixture-commit')
    Write-Utf8Text $trackedPath "after`n"
    [void](Invoke-TestGit @('-C',$stagedRepository,'add','--',$trackedRelativePath) $scratch 'staged-mutation-add')
    $dirtyCommandStart = $script:Commands.Count
    $dirtyState = Get-GitDirtyState $stagedRepository 'staged-mutation'
    Assert-True $dirtyState.captureSucceeded 'staged mutation diagnostics complete within their byte bounds'
    Assert-False $dirtyState.clean 'staged tracked mutation classifies the repository as dirty'
    Assert-Equal 1 @($dirtyState.status | Where-Object { $_.status -ceq 'M ' -and $_.index -ceq 'M' -and $_.worktree -ceq ' ' -and $_.path -ceq $trackedRelativePath }).Count 'staged tracked mutation preserves its exact nested path and index classification'
    Assert-True ($dirtyState.trackedChanges.staged.raw.Length -gt 0) 'staged tracked mutation has non-empty raw evidence'
    Assert-True ($dirtyState.trackedChanges.staged.numstat.Length -gt 0) 'staged tracked mutation has non-empty numstat evidence'
    Assert-True ($dirtyState.trackedChanges.staged.numstat.Contains($trackedRelativePath)) 'staged numstat evidence preserves the exact nested path'
    Assert-Equal 0 $dirtyState.trackedChanges.unstaged.raw.Length 'staged-only mutation has no unstaged raw evidence'
    Assert-Equal 0 $dirtyState.trackedChanges.unstaged.numstat.Length 'staged-only mutation has no unstaged numstat evidence'
    $persistedDirtyState = $dirtyState | ConvertTo-Json -Depth 10 | ConvertFrom-Json
    Assert-Equal 'HEAD-to-index' $persistedDirtyState.trackedChanges.staged.comparison 'persisted dirty state distinguishes staged evidence'
    Assert-Equal 'index-to-worktree' $persistedDirtyState.trackedChanges.unstaged.comparison 'persisted dirty state distinguishes unstaged evidence'
    $dirtyDiffCommands = @($script:Commands | Select-Object -Skip $dirtyCommandStart | Where-Object { $_.label -match '^staged-mutation-(?:staged|unstaged)-(?:raw|numstat)$' })
    Assert-Equal 4 $dirtyDiffCommands.Count 'dirty diagnostics capture staged and unstaged raw and numstat evidence separately'
    foreach ($command in $dirtyDiffCommands) {
        Assert-True ($command.arguments -contains '--no-ext-diff') "$($command.label) disables external diff drivers"
        Assert-True ($command.arguments -contains '--no-textconv') "$($command.label) disables text conversion filters"
    }

    $successResponses = @($fixtures.redirectCases.successWithSecrets)
    $successProvider = New-FixtureResponseProvider $successResponses
    $successPath = Join-Path $scratch 'success.bin'
    $success = Invoke-BoundedHttpRequest -Uri ([string]$successResponses[0].requestUrl) -DestinationPath $successPath -MaximumBytes 64 -MaximumAttempts 3 -MaximumRedirects 5 -TimeoutSeconds 5 -AllowedHosts $allowedFixtureHosts -ResponseProvider $successProvider
    Assert-True $success.succeeded 'bounded acquisition follows the representative redirect sequence'
    Assert-Equal 2 @($success.redirectChain).Count 'redirect evidence persists every response in sequence'
    Assert-Equal 302 $success.redirectChain[0].statusCode 'redirect evidence preserves initial status'
    Assert-Equal 200 $success.redirectChain[1].statusCode 'redirect evidence preserves final status'
    Assert-Equal 'verified-body' ([IO.File]::ReadAllText($successPath)) 'bounded acquisition persists the final response body'
    $successEvidenceJson = $success | ConvertTo-Json -Depth 20 -Compress
    Assert-False ($successEvidenceJson -match '\?|top-secret|credential-secret|signature-secret|X-Amz|token=') 'redirect evidence strips queries and credentials from every persisted URL'

    $loopResponses = @($fixtures.redirectCases.loop)
    $loopProvider = New-FixtureResponseProvider $loopResponses
    $loop = Invoke-BoundedHttpRequest -Uri ([string]$loopResponses[0].requestUrl) -DestinationPath (Join-Path $scratch 'loop.bin') -MaximumBytes 64 -MaximumAttempts 3 -MaximumRedirects 5 -TimeoutSeconds 5 -AllowedHosts $allowedFixtureHosts -ResponseProvider $loopProvider
    Assert-False $loop.succeeded 'redirect loop fails closed'
    Assert-Equal 1 $loop.attempt 'redirect loop is treated as fatal instead of consuming retries'
    Assert-Equal 'redirect-loop' $loop.attempts[0].error 'redirect loop is identified in bounded evidence'
    Assert-Equal 2 @($loop.redirectChain).Count 'redirect loop retains the observed status sequence'
    Assert-False (($loop | ConvertTo-Json -Depth 20 -Compress) -match '\?|first-secret|second-secret|token|credential') 'redirect-loop evidence also redacts query material'

    $privateResponses = @($fixtures.redirectCases.disallowedPrivateRedirect)
    $privateProvider = New-FixtureResponseProvider $privateResponses
    $private = Invoke-BoundedHttpRequest -Uri ([string]$privateResponses[0].requestUrl) -DestinationPath (Join-Path $scratch 'private.bin') -MaximumBytes 64 -MaximumAttempts 3 -MaximumRedirects 5 -TimeoutSeconds 5 -AllowedHosts $allowedFixtureHosts -ResponseProvider $privateProvider
    Assert-False $private.succeeded 'redirect outside the pinned Hugging Face host set fails closed'
    Assert-Equal 'unsafe-redirect-target' $private.attempts[0].error 'private-network redirect is rejected before a request is sent'
    Assert-Equal 1 @($private.redirectChain).Count 'disallowed redirect evidence contains only the trusted origin response'
    Assert-False (($private | ConvertTo-Json -Depth 20 -Compress) -match '127\.0\.0\.1|admin/action|token|secret') 'disallowed redirect target is never persisted'

    $retryResponses = @($fixtures.redirectCases.retryThenSuccess)
    $retryProvider = New-FixtureResponseProvider $retryResponses
    $retry = Invoke-BoundedHttpRequest -Uri ([string]$retryResponses[0].requestUrl) -DestinationPath (Join-Path $scratch 'retry.bin') -MaximumBytes 64 -MaximumAttempts 3 -MaximumRedirects 5 -TimeoutSeconds 5 -AllowedHosts $allowedFixtureHosts -ResponseProvider $retryProvider
    Assert-True $retry.succeeded 'transient metadata transport failure is retried'
    Assert-Equal 2 $retry.attempt 'successful retry records both bounded attempts'
    Assert-True ($retry.attempts[0].error -match '^transport-error:') 'retry evidence records a sanitized transport error type'

    $oversizedResponses = @($fixtures.redirectCases.oversized)
    $oversizedProvider = New-FixtureResponseProvider $oversizedResponses
    $oversized = Invoke-BoundedHttpRequest -Uri ([string]$oversizedResponses[0].requestUrl) -DestinationPath (Join-Path $scratch 'oversized.bin') -MaximumBytes 10 -MaximumAttempts 3 -MaximumRedirects 5 -TimeoutSeconds 5 -AllowedHosts $allowedFixtureHosts -ResponseProvider $oversizedProvider
    Assert-False $oversized.succeeded 'response beyond its byte cap fails closed'
    Assert-Equal 'response-body-exceeds-byte-limit' $oversized.attempts[0].error 'byte-cap failure is represented without response content'
    Assert-False (Test-Path -LiteralPath (Join-Path $scratch 'oversized.bin')) 'partial oversized response is removed'

    $slowResponses = @($fixtures.redirectCases.slowBody)
    $slowProvider = New-FixtureResponseProvider $slowResponses
    $slow = Invoke-BoundedHttpRequest -Uri ([string]$slowResponses[0].requestUrl) -DestinationPath (Join-Path $scratch 'slow.bin') -MaximumBytes 64 -MaximumAttempts 1 -MaximumRedirects 5 -TimeoutSeconds 1 -AllowedHosts $allowedFixtureHosts -ResponseProvider $slowProvider
    Assert-False $slow.succeeded 'response body beyond the attempt deadline fails closed'
    Assert-Equal 'attempt-timeout' $slow.attempts[0].error 'attempt timeout is represented without remote content'
    Assert-False (Test-Path -LiteralPath (Join-Path $scratch 'slow.bin')) 'partial timed-out response is removed'
} finally {
    Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host 'All model provenance validation tests passed.'
