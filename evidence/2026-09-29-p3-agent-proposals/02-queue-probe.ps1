# Probe the app's native event-loop target window: can a message still be posted to it?
# Usage: powershell -NoProfile -File 02-queue-probe.ps1 -ProcessId <pid>
# Prints one JSON line: each top-level window of the process with class, PostMessage(WM_NULL)
# result and the Win32 error code (1816 = ERROR_NOT_ENOUGH_QUOTA, i.e. the thread's queue is full).
param([Parameter(Mandatory = $true)][int]$ProcessId)

Add-Type -Namespace Probe -Name U -MemberDefinition @'
public delegate bool EnumProc(System.IntPtr h, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h, out uint pid);
[System.Runtime.InteropServices.DllImport("user32.dll", CharSet = System.Runtime.InteropServices.CharSet.Unicode)] public static extern int GetClassName(System.IntPtr h, System.Text.StringBuilder s, int n);
[System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
'@

$found = New-Object System.Collections.ArrayList
$cb = [Probe.U+EnumProc] {
  param($h, $l)
  $owner = [uint32]0
  $thread = [Probe.U]::GetWindowThreadProcessId($h, [ref]$owner)
  if ($owner -eq $ProcessId) {
    $c = New-Object System.Text.StringBuilder 256
    [void][Probe.U]::GetClassName($h, $c, 256)
    [void]$found.Add([pscustomobject]@{ handle = [int64]$h; thread = $thread; class = $c.ToString() })
  }
  return $true
}
[void][Probe.U]::EnumWindows($cb, [System.IntPtr]::Zero)

$results = foreach ($w in $found) {
  if ($w.class -ne 'Tao Thread Event Target') { $w; continue }
  $ok = [Probe.U]::PostMessage([System.IntPtr]$w.handle, 0, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
  $err = [System.Runtime.InteropServices.Marshal]::GetLastWin32Error()
  $w | Add-Member -PassThru posted $ok | Add-Member -PassThru win32Error $(if ($ok) { 0 } else { $err })
}
$p = Get-Process -Id $ProcessId
[pscustomobject]@{
  windows = @($results)
  cpuSeconds = [math]::Round($p.CPU, 2)
  handles = $p.HandleCount
  threads = $p.Threads.Count
  workingSetMiB = [math]::Round($p.WorkingSet64 / 1MB, 1)
} | ConvertTo-Json -Compress -Depth 4
