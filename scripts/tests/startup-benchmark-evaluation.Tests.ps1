[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
. (Join-Path $RepositoryRoot "scripts/startup-benchmark-evaluation.ps1")

$script:Assertions = 0
function Assert-Equal {
  param($Actual, $Expected, [string]$Message)
  $script:Assertions += 1
  if ($Actual -ne $Expected) {
    throw "Assertion failed: $Message (expected=$Expected actual=$Actual)"
  }
}

function New-PassingSummary {
  return [pscustomobject]@{
    firstVisibleWindowP95Ms = 2400
    readyStatusP95Ms = 14000
    responsivenessFailures = 0
    maxResponsivenessProbeMs = 400
    loadingStateObservedEveryRun = $true
    projectActionsEnabledWhileResolvingEveryRun = $true
  }
}

function Get-Evaluation($Summary, [bool]$EnforcePerformanceBudgets = $true) {
  return Get-StartupBenchmarkEvaluation `
    -Summary $Summary `
    -FirstWindowBudgetMs 2500 `
    -ReadyBudgetMs 15000 `
    -ResponsivenessProbeTimeoutMs 500 `
    -EnforcePerformanceBudgets $EnforcePerformanceBudgets
}

$passing = Get-Evaluation (New-PassingSummary)
Assert-Equal $passing.correctnessPassed $true "passing smoke correctness"
Assert-Equal $passing.performancePassed $true "passing performance budgets"
Assert-Equal $passing.performanceEnforced $true "strict performance is the default"
Assert-Equal $passing.passed $true "strict passing result"

$slow = New-PassingSummary
$slow.readyStatusP95Ms = 15001
$strictSlow = Get-Evaluation $slow
Assert-Equal $strictSlow.correctnessPassed $true "slow startup remains correct"
Assert-Equal $strictSlow.performancePassed $false "strict mode detects a budget miss"
Assert-Equal $strictSlow.passed $false "strict mode blocks on a budget miss"

$advisorySlow = Get-Evaluation $slow $false
Assert-Equal $advisorySlow.performanceEnforced $false "advisory mode is reported"
Assert-Equal $advisorySlow.performancePassed $false "advisory mode still reports a budget miss"
Assert-Equal $advisorySlow.passed $true "advisory mode does not block on a budget miss"

$unresponsive = New-PassingSummary
$unresponsive.responsivenessFailures = 1
Assert-Equal (Get-Evaluation $unresponsive).passed $false "strict mode blocks on responsiveness failures"
Assert-Equal (Get-Evaluation $unresponsive $false).passed $true "advisory mode reports responsiveness without blocking"

$missingLoadingState = New-PassingSummary
$missingLoadingState.loadingStateObservedEveryRun = $false
Assert-Equal (Get-Evaluation $missingLoadingState $false).passed $false "advisory mode blocks when loading UI is missing"

$disabledProjectActions = New-PassingSummary
$disabledProjectActions.projectActionsEnabledWhileResolvingEveryRun = $false
Assert-Equal (Get-Evaluation $disabledProjectActions $false).passed $false "advisory mode blocks when required actions are disabled"

Write-Host "Startup benchmark evaluation tests passed ($script:Assertions assertions)"
