[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$RamMapPath,

  [ValidateRange(10, 100)]
  [int]$Iterations = 10,

  [ValidateRange(100, 60000)]
  [int]$FirstWindowBudgetMs = 2500,

  [ValidateRange(1000, 600000)]
  [int]$ReadyBudgetMs = 15000,

  [ValidateRange(50, 5000)]
  [int]$ResponsivenessProbeTimeoutMs = 500,

  [ValidateRange(1, 600)]
  [int]$RunTimeoutSeconds = 120,

  [switch]$AdvisoryPerformance,

  [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "startup-benchmark-evaluation.ps1")
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class StartupBenchmarkNativeMethods
{
    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool IsWindowVisible(IntPtr windowHandle);

    [DllImport("user32.dll", SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr windowHandle,
        uint message,
        UIntPtr wordParameter,
        IntPtr longParameter,
        uint flags,
        uint timeoutMilliseconds,
        out UIntPtr result);
}
"@

$sendMessageAbortIfHung = 0x0002
$windowMessageNull = 0x0000
$pollIntervalMilliseconds = 25

function Assert-Administrator {
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = [Security.Principal.WindowsPrincipal]::new($identity)
  if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Cold-file-cache startup benchmarking requires an elevated PowerShell session"
  }
}

function Resolve-RequiredFile([string]$Path, [string]$Description) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Description does not exist: $Path"
  }
  return (Resolve-Path -LiteralPath $Path).Path
}

function Assert-RamMapPublisher([string]$Path) {
  $signature = Get-AuthenticodeSignature -LiteralPath $Path
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid) {
    throw "RAMMap must have a valid Authenticode signature; status=$($signature.Status)"
  }
  if ($null -eq $signature.SignerCertificate -or
      -not $signature.SignerCertificate.Subject.Contains("O=Microsoft Corporation")) {
    throw "RAMMap must be signed by Microsoft Corporation"
  }
}

function Clear-StandbyFileCache([string]$Path) {
  $purge = Start-Process `
    -FilePath $Path `
    -ArgumentList "-accepteula", "-Et" `
    -Wait `
    -PassThru `
    -WindowStyle Hidden
  if ($purge.ExitCode -ne 0) {
    throw "RAMMap standby-list purge exited with code $($purge.ExitCode)"
  }
}

function Stop-ProcessTree([Diagnostics.Process]$Process) {
  $Process.Refresh()
  if ($Process.HasExited) {
    return
  }

  & taskkill.exe /PID $Process.Id /T /F 2>&1 | Out-Null
  $Process.WaitForExit(5000) | Out-Null
}

function Find-DescendantByName(
  [Windows.Automation.AutomationElement]$Root,
  [string]$Name
) {
  $condition = [Windows.Automation.PropertyCondition]::new(
    [Windows.Automation.AutomationElement]::NameProperty,
    $Name
  )
  return $Root.FindFirst([Windows.Automation.TreeScope]::Descendants, $condition)
}

function Measure-Percentile([double[]]$Values, [double]$Percentile) {
  $sorted = @($Values | Sort-Object)
  $index = [Math]::Ceiling($Percentile * $sorted.Count) - 1
  return [Math]::Round([double]$sorted[$index], 1)
}

function Measure-Median([double[]]$Values) {
  $sorted = @($Values | Sort-Object)
  $middle = [Math]::Floor($sorted.Count / 2)
  if (($sorted.Count % 2) -eq 1) {
    return [Math]::Round([double]$sorted[$middle], 1)
  }
  return [Math]::Round(([double]$sorted[$middle - 1] + [double]$sorted[$middle]) / 2, 1)
}

function Get-SystemEvidence([string]$ApplicationPath, [string]$CacheToolPath) {
  $computer = Get-CimInstance Win32_ComputerSystem
  $processor = Get-CimInstance Win32_Processor | Select-Object -First 1
  $applicationDrive = [IO.Path]::GetPathRoot($ApplicationPath).Substring(0, 1)
  $disk = Get-Partition -DriveLetter $applicationDrive | Get-Disk
  $physicalDisk = Get-PhysicalDisk | Where-Object { [int]$_.DeviceId -eq $disk.Number } | Select-Object -First 1
  $defender = Get-MpComputerStatus

  return [ordered]@{
    manufacturer = $computer.Manufacturer
    model = $computer.Model
    memoryGb = [Math]::Round($computer.TotalPhysicalMemory / 1GB, 1)
    processor = $processor.Name.Trim()
    processorCores = $processor.NumberOfCores
    processorLogicalProcessors = $processor.NumberOfLogicalProcessors
    applicationDisk = $disk.FriendlyName
    applicationDiskBus = [string]$disk.BusType
    applicationDiskMediaType = if ($null -eq $physicalDisk) { "Unknown" } else { [string]$physicalDisk.MediaType }
    defenderAntivirusEnabled = $defender.AntivirusEnabled
    defenderRealTimeProtectionEnabled = $defender.RealTimeProtectionEnabled
    executableSha256 = (Get-FileHash -LiteralPath $ApplicationPath -Algorithm SHA256).Hash.ToLowerInvariant()
    ramMapSha256 = (Get-FileHash -LiteralPath $CacheToolPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

function Measure-StartupRun(
  [int]$RunNumber,
  [string]$ApplicationPath,
  [string]$CacheToolPath,
  [string]$ProfileRoot
) {
  Clear-StandbyFileCache $CacheToolPath

  $profilePath = Join-Path $ProfileRoot "run-$RunNumber"
  New-Item -ItemType Directory -Force -Path $profilePath | Out-Null
  $originalWebViewProfile = $env:WEBVIEW2_USER_DATA_FOLDER
  $env:WEBVIEW2_USER_DATA_FOLDER = $profilePath

  $process = $null
  $stopwatch = [Diagnostics.Stopwatch]::StartNew()
  $firstWindowMilliseconds = $null
  $readyMilliseconds = $null
  $loadingStateObserved = $false
  $projectActionsEnabledWhileResolving = $false
  $responsivenessFailures = 0
  $responsivenessProbeMilliseconds = [Collections.Generic.List[double]]::new()

  try {
    $process = Start-Process -FilePath $ApplicationPath -PassThru
    $deadline = [TimeSpan]::FromSeconds($RunTimeoutSeconds)

    while ($stopwatch.Elapsed -lt $deadline -and $null -eq $readyMilliseconds) {
      $process.Refresh()
      if ($process.HasExited) {
        throw "Packaged application exited with code $($process.ExitCode) during run $RunNumber"
      }

      $windowHandle = $process.MainWindowHandle
      if ($windowHandle -ne [IntPtr]::Zero -and
          [StartupBenchmarkNativeMethods]::IsWindowVisible($windowHandle)) {
        if ($null -eq $firstWindowMilliseconds) {
          $firstWindowMilliseconds = $stopwatch.Elapsed.TotalMilliseconds
        }

        $probeStopwatch = [Diagnostics.Stopwatch]::StartNew()
        $probeResult = [UIntPtr]::Zero
        $probeSucceeded = [StartupBenchmarkNativeMethods]::SendMessageTimeout(
          $windowHandle,
          $windowMessageNull,
          [UIntPtr]::Zero,
          [IntPtr]::Zero,
          $sendMessageAbortIfHung,
          $ResponsivenessProbeTimeoutMs,
          [ref]$probeResult
        ) -ne [IntPtr]::Zero
        $probeStopwatch.Stop()
        $responsivenessProbeMilliseconds.Add($probeStopwatch.Elapsed.TotalMilliseconds)
        if (-not $probeSucceeded) {
          $responsivenessFailures += 1
        }

        try {
          $root = [Windows.Automation.AutomationElement]::FromHandle($windowHandle)
          if (-not $loadingStateObserved) {
            $loading = Find-DescendantByName $root "Checking bundled media tools"
            if ($null -ne $loading) {
              $loadingStateObserved = $true
              $newProject = Find-DescendantByName $root "New project"
              $openProject = Find-DescendantByName $root "Open project"
              $projectActionsEnabledWhileResolving =
                $null -ne $newProject -and $newProject.Current.IsEnabled -and
                $null -ne $openProject -and $openProject.Current.IsEnabled
            }
          }

          $ready = Find-DescendantByName $root "Ready for video work"
          if ($null -ne $ready) {
            $readyMilliseconds = $stopwatch.Elapsed.TotalMilliseconds
          }
        }
        catch [Windows.Automation.ElementNotAvailableException] {
          # The webview accessibility tree can be replaced while it initializes.
        }
      }

      Start-Sleep -Milliseconds $pollIntervalMilliseconds
    }

    if ($null -eq $firstWindowMilliseconds) {
      throw "No visible application window appeared within $RunTimeoutSeconds seconds on run $RunNumber"
    }
    if ($null -eq $readyMilliseconds) {
      throw "Media-tool ready status did not appear within $RunTimeoutSeconds seconds on run $RunNumber"
    }

    $maxProbeMilliseconds = if ($responsivenessProbeMilliseconds.Count -eq 0) {
      0
    }
    else {
      ($responsivenessProbeMilliseconds | Measure-Object -Maximum).Maximum
    }

    return [ordered]@{
      run = $RunNumber
      firstVisibleWindowMs = [Math]::Round($firstWindowMilliseconds, 1)
      readyStatusMs = [Math]::Round($readyMilliseconds, 1)
      responsivenessProbeCount = $responsivenessProbeMilliseconds.Count
      responsivenessFailures = $responsivenessFailures
      maxResponsivenessProbeMs = [Math]::Round([double]$maxProbeMilliseconds, 1)
      loadingStateObserved = $loadingStateObserved
      projectActionsEnabledWhileResolving = $projectActionsEnabledWhileResolving
    }
  }
  finally {
    $stopwatch.Stop()
    if ($null -ne $process) {
      Stop-ProcessTree $process
      $process.Dispose()
    }
    if ($null -eq $originalWebViewProfile) {
      Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
    }
    else {
      $env:WEBVIEW2_USER_DATA_FOLDER = $originalWebViewProfile
    }
  }
}

Assert-Administrator
$executable = Resolve-RequiredFile $ExecutablePath "Packaged executable"
$ramMap = Resolve-RequiredFile $RamMapPath "RAMMap executable"
Assert-RamMapPublisher $ramMap

$existingApplication = @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($executable)) -ErrorAction SilentlyContinue)
if ($existingApplication.Count -ne 0) {
  throw "Close all running packaged application processes before benchmarking"
}

$profileRoot = Join-Path $env:TEMP "svp-startup-benchmark-$([Guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Force -Path $profileRoot | Out-Null
$runs = [Collections.Generic.List[object]]::new()

try {
  for ($run = 1; $run -le $Iterations; $run += 1) {
    $measurement = Measure-StartupRun $run $executable $ramMap $profileRoot
    $runs.Add($measurement)
    Write-Host (
      "Run {0}/{1}: visible={2} ms ready={3} ms responsiveFailures={4}" -f
      $run,
      $Iterations,
      $measurement.firstVisibleWindowMs,
      $measurement.readyStatusMs,
      $measurement.responsivenessFailures
    )
  }
}
finally {
  Remove-Item -LiteralPath $profileRoot -Recurse -Force -ErrorAction SilentlyContinue
}

$firstWindowValues = [double[]]@($runs | ForEach-Object { $_.firstVisibleWindowMs })
$readyValues = [double[]]@($runs | ForEach-Object { $_.readyStatusMs })
$totalResponsivenessFailures = (
  $runs | ForEach-Object { $_.responsivenessFailures } | Measure-Object -Sum
).Sum
$maxResponsivenessProbeMilliseconds = (
  $runs | ForEach-Object { $_.maxResponsivenessProbeMs } | Measure-Object -Maximum
).Maximum
$loadingStatePassed = @($runs | Where-Object { -not $_.loadingStateObserved }).Count -eq 0
$projectActionsPassed = @(
  $runs | Where-Object { -not $_.projectActionsEnabledWhileResolving }
).Count -eq 0

$summary = [ordered]@{
  firstVisibleWindowMedianMs = Measure-Median $firstWindowValues
  firstVisibleWindowP95Ms = Measure-Percentile $firstWindowValues 0.95
  readyStatusMedianMs = Measure-Median $readyValues
  readyStatusP95Ms = Measure-Percentile $readyValues 0.95
  responsivenessFailures = [int]$totalResponsivenessFailures
  maxResponsivenessProbeMs = [Math]::Round([double]$maxResponsivenessProbeMilliseconds, 1)
  loadingStateObservedEveryRun = $loadingStatePassed
  projectActionsEnabledWhileResolvingEveryRun = $projectActionsPassed
}

$evaluation = Get-StartupBenchmarkEvaluation `
  -Summary ([pscustomobject]$summary) `
  -FirstWindowBudgetMs $FirstWindowBudgetMs `
  -ReadyBudgetMs $ReadyBudgetMs `
  -ResponsivenessProbeTimeoutMs $ResponsivenessProbeTimeoutMs `
  -EnforcePerformanceBudgets (-not $AdvisoryPerformance)

$report = [ordered]@{
  schemaVersion = 2
  measuredAtUtc = [DateTime]::UtcNow.ToString("o")
  passed = $evaluation.passed
  correctnessPassed = $evaluation.correctnessPassed
  performancePassed = $evaluation.performancePassed
  performanceEnforced = $evaluation.performanceEnforced
  coldCacheMethod = "Fresh WebView2 user-data folder and Microsoft Sysinternals RAMMap -Et standby-list purge before every run"
  executable = $executable
  iterations = $Iterations
  thresholds = [ordered]@{
    firstVisibleWindowP95Ms = $FirstWindowBudgetMs
    readyStatusP95Ms = $ReadyBudgetMs
    responsivenessProbeTimeoutMs = $ResponsivenessProbeTimeoutMs
    requireLoadingStateEveryRun = $true
    requireProjectActionsEnabledWhileResolvingEveryRun = $true
  }
  system = Get-SystemEvidence $executable $ramMap
  summary = $summary
  runs = $runs
}

$json = $report | ConvertTo-Json -Depth 8
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
  $outputDirectory = Split-Path -Parent $OutputPath
  if (-not [string]::IsNullOrWhiteSpace($outputDirectory)) {
    New-Item -ItemType Directory -Force -Path $outputDirectory | Out-Null
  }
  $json | Set-Content -LiteralPath $OutputPath -Encoding utf8
}
$json

if (-not $evaluation.correctnessPassed) {
  throw "Packaged startup smoke correctness failed because required UI states were not observed"
}
if ($evaluation.performanceEnforced -and -not $evaluation.performancePassed) {
  throw "Packaged startup benchmark exceeded its strict performance budget"
}
if (-not $evaluation.performancePassed) {
  Write-Warning "Packaged startup performance exceeded its advisory budget"
}
