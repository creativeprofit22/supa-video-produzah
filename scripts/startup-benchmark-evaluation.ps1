Set-StrictMode -Version Latest

function Get-StartupBenchmarkEvaluation {
  [CmdletBinding()]
  param(
    [Parameter(Mandatory = $true)]
    $Summary,

    [Parameter(Mandatory = $true)]
    [int]$FirstWindowBudgetMs,

    [Parameter(Mandatory = $true)]
    [int]$ReadyBudgetMs,

    [Parameter(Mandatory = $true)]
    [int]$ResponsivenessProbeTimeoutMs,

    [bool]$EnforcePerformanceBudgets = $true
  )

  $correctnessPassed =
    [bool]$Summary.loadingStateObservedEveryRun -and
    [bool]$Summary.projectActionsEnabledWhileResolvingEveryRun

  $performancePassed =
    [double]$Summary.firstVisibleWindowP95Ms -le $FirstWindowBudgetMs -and
    [double]$Summary.readyStatusP95Ms -le $ReadyBudgetMs -and
    [int]$Summary.responsivenessFailures -eq 0 -and
    [double]$Summary.maxResponsivenessProbeMs -le $ResponsivenessProbeTimeoutMs

  return [pscustomobject][ordered]@{
    correctnessPassed = $correctnessPassed
    performancePassed = $performancePassed
    performanceEnforced = $EnforcePerformanceBudgets
    passed = $correctnessPassed -and ($performancePassed -or -not $EnforcePerformanceBudgets)
  }
}
