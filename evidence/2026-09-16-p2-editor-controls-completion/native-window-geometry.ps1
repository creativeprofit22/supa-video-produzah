param([Parameter(Mandatory=$true)][long]$Handle,
      [Parameter(Mandatory=$true)][int]$OwnerId,
      [Parameter(Mandatory=$true)][long]$Creation,
      [Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class NativeTimingGeometry {
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left,top,right,bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Point { public int x,y; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd,out Rect rect);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
 [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr hwnd);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd,StringBuilder text,int count);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out Rect rect,int size);
}
'@
$process = [System.Diagnostics.Process]::GetProcessById($OwnerId)
try {
 if ($process.StartTime.ToUniversalTime().ToFileTimeUtc() -ne $Creation -or
     -not [String]::Equals($process.MainModule.FileName,$Executable,[StringComparison]::OrdinalIgnoreCase)) { throw 'Root identity mismatch' }
 $hwnd = [IntPtr]$Handle
 $old = [NativeTimingGeometry]::SetThreadDpiAwarenessContext([IntPtr](-4))
 if ($old -eq [IntPtr]::Zero) { throw 'Physical DPI context unavailable' }
 try {
  [uint32]$actual = 0
  [void][NativeTimingGeometry]::GetWindowThreadProcessId($hwnd,[ref]$actual)
  $title = New-Object System.Text.StringBuilder 512
  [void][NativeTimingGeometry]::GetWindowText($hwnd,$title,512)
  if ($actual -ne $OwnerId -or -not [NativeTimingGeometry]::IsWindowVisible($hwnd) -or [NativeTimingGeometry]::IsIconic($hwnd) -or $title.ToString() -ne 'SUPA_LOOPBACK_PRIVATE_TEST Native editor step 9') { throw 'Exact owned window predicate failed' }
  $frame = New-Object NativeTimingGeometry+Rect
  $client = New-Object NativeTimingGeometry+Rect
  $origin = New-Object NativeTimingGeometry+Point
  if ([NativeTimingGeometry]::DwmGetWindowAttribute($hwnd,9,[ref]$frame,16) -ne 0 -or
      -not [NativeTimingGeometry]::GetClientRect($hwnd,[ref]$client) -or
      -not [NativeTimingGeometry]::ClientToScreen($hwnd,[ref]$origin)) { throw 'Physical geometry unavailable' }
  @{ handle="$Handle"; pid=$OwnerId; creation="$Creation"; title=$title.ToString(); dpi=[NativeTimingGeometry]::GetDpiForWindow($hwnd);
     frame=@{left=$frame.left;top=$frame.top;width=$frame.right-$frame.left;height=$frame.bottom-$frame.top};
     client=@{left=$origin.x;top=$origin.y;width=$client.right-$client.left;height=$client.bottom-$client.top} } | ConvertTo-Json -Depth 4 -Compress
 } finally { [void][NativeTimingGeometry]::SetThreadDpiAwarenessContext($old) }
} finally { $process.Dispose() }
