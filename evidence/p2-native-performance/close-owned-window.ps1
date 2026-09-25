param([Parameter(Mandatory=$true)][int]$OwnedPid,[Parameter(Mandatory=$true)][ValidatePattern('^[0-9]+$')][string]$Creation)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$p = [Diagnostics.Process]::GetProcessById($OwnedPid)
if ($p.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $Creation) { throw 'Owned window identity mismatch' }
if (-not $p.CloseMainWindow()) { throw 'Owned application has no closable main window' }
if (-not $p.WaitForExit(15000)) { throw 'Owned application did not close normally' }
@{ closedNormally = $true; exitCode = $p.ExitCode } | ConvertTo-Json -Compress
