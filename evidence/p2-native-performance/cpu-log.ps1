# Whole-machine CPU logger for measurement runs. Appends one JSON line per sample to -Out
# (a new file only) until -StopFile exists or -MaxMinutes elapses. Read-only: no process is touched.
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [Parameter(Mandatory = $true)][string]$StopFile,
  [int]$IntervalSeconds = 10,
  [int]$MaxMinutes = 120
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $Out) { throw "Refusing to overwrite $Out" }
New-Item -ItemType File -Path $Out | Out-Null
$deadline = (Get-Date).AddMinutes($MaxMinutes)
while (-not (Test-Path -LiteralPath $StopFile) -and (Get-Date) -lt $deadline) {
  $cpu = (Get-CimInstance Win32_PerfFormattedData_PerfOS_Processor -Filter "Name='_Total'").PercentProcessorTime
  $top = Get-CimInstance Win32_PerfFormattedData_PerfProc_Process |
    Where-Object { $_.Name -notin '_Total', 'Idle' } |
    Sort-Object PercentProcessorTime -Descending | Select-Object -First 3 |
    ForEach-Object { @{ name = $_.Name; pct = $_.PercentProcessorTime } }
  $line = @{ utc = (Get-Date).ToUniversalTime().ToString('o'); cpu = $cpu; top = @($top) } |
    ConvertTo-Json -Compress -Depth 4
  Add-Content -LiteralPath $Out -Value $line
  Start-Sleep -Seconds $IntervalSeconds
}
