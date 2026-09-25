[CmdletBinding()]
param([Parameter(Mandatory=$true)][int]$OwnedPid, [Parameter(Mandatory=$true)][ValidatePattern('^[0-9]+$')][string]$Creation, [int]$Port = 0)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$handle = [Diagnostics.Process]::GetProcessById($OwnedPid)
if ($handle.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -cne $Creation) { throw 'Root creation identity mismatch' }
$all = @(Get-CimInstance Win32_Process)
$root = $all | Where-Object { $_.ProcessId -eq $OwnedPid }
if (-not $root) { throw 'Owned root exited' }
$members = @{}; $members[[string]$OwnedPid] = $root
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $all) {
    $parent = $members[[string]$p.ParentProcessId]
    if ($null -ne $parent -and -not $members.ContainsKey([string]$p.ProcessId) -and $p.CreationDate -ge $parent.CreationDate) { $members[[string]$p.ProcessId] = $p; $changed = $true }
  }
  if ($members.Count -gt 256) { throw 'Owned tree size cap exceeded' }
}
$descendants = @($members.Values | ForEach-Object { @{ pid = $_.ProcessId; creationUtc = $_.CreationDate.ToUniversalTime().ToString('o'); commandLineArguments = @([regex]::Matches([string]$_.CommandLine, '--remote-debugging-port=[0-9]+') | ForEach-Object { $_.Value }) } })
$connection = $null
if ($Port -ne 0) {
  $connections = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
  if ($connections.Count -ne 1 -or $connections[0].LocalAddress -cne '127.0.0.1' -or -not $members.ContainsKey([string]$connections[0].OwningProcess)) { throw 'Refusing unowned CDP listener' }
  $connection = $connections[0]
}
@{ pid = $OwnedPid; executable = $root.ExecutablePath; creationUtc = $root.CreationDate.ToUniversalTime().ToString('o'); port = $Port; address = $(if ($connection) { $connection.LocalAddress } else { $null }); portOwnerPid = $(if ($connection) { $connection.OwningProcess } else { $null }); descendants = $descendants } | ConvertTo-Json -Depth 5 -Compress
