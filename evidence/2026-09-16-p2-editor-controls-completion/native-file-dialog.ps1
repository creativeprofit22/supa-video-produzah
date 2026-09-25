param([int]$OwnerId, [string]$Creation, [string]$FilePath)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DialogInterop {
 [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, string text, uint flags, uint timeout, out IntPtr result);
 [DllImport("user32.dll", EntryPoint="SendMessageTimeoutW", CharSet=CharSet.Unicode, SetLastError=true)]
 public static extern IntPtr ReadText(IntPtr h,uint msg,IntPtr count,StringBuilder text,uint flags,uint timeout,out IntPtr result);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool PostMessage(IntPtr h,uint msg,IntPtr w,IntPtr l);
}
'@
$full = [IO.Path]::GetFullPath($FilePath)
$testRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\supa-controls-native-'
$media = [IO.Path]::GetFullPath('apps/desktop/browser-tests/completion-layer-red.mp4')
if (!$full.StartsWith($testRoot,[StringComparison]::OrdinalIgnoreCase) -and $full -ne $media) { throw 'Not an authorized disposable fixture path' }
$owner = Get-Process -Id $OwnerId
if ($owner.StartTime.ToFileTimeUtc().ToString() -ne $Creation) { throw 'Owned process identity changed' }
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$OwnerId)
$deadline = [DateTime]::UtcNow.AddSeconds(5)
$dialog = $null
while (!$dialog -and [DateTime]::UtcNow -lt $deadline) {
 $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll([System.Windows.Automation.TreeScope]::Children,$condition)
 foreach ($window in $windows) {
  $matches = $window.FindAll([System.Windows.Automation.TreeScope]::Subtree,(New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'#32770')))
  foreach ($candidate in $matches) { if ($candidate.Current.ProcessId -eq $OwnerId) { if ($dialog) { throw 'Ambiguous owned dialogs' }; $dialog=$candidate } }
 }
 if (!$dialog) { [Threading.Thread]::Sleep(20) }
}
if (!$dialog) { Write-Output ('OWNED_ROOT_CLASSES=' + (($windows | ForEach-Object { $_.Current.ClassName }) -join ',')); throw 'No owned native file dialog' }
$hostCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'FileNameControlHost')
$inputCondition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1001')
$legacyId = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1148')
$editClass = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'Edit')
$legacyInput = New-Object System.Windows.Automation.AndCondition($legacyId,$editClass)
$input = $null
while (!$input -and [DateTime]::UtcNow -lt $deadline) {
 $fileHost = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$hostCondition)
 if ($fileHost) { $input = $fileHost.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$inputCondition) }
 else { $input = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$legacyInput) }
 if (!$input) { [Threading.Thread]::Sleep(20) }
}
if (!$input -or !$input.Current.NativeWindowHandle) { throw 'No native filename input' }
[uint32]$actual = 0
$handle = [IntPtr]$input.Current.NativeWindowHandle
[void][DialogInterop]::GetWindowThreadProcessId($handle,[ref]$actual)
if ($actual -ne $OwnerId) { throw 'Filename input owner mismatch' }
$result = [IntPtr]::Zero
if ([DialogInterop]::SendMessageTimeout($handle,12,[IntPtr]::Zero,$full,2,2000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Filename update timed out' }
$text = New-Object Text.StringBuilder 32768
if ([DialogInterop]::ReadText($handle,13,[IntPtr]$text.Capacity,$text,2,2000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Filename readback timed out' }
if ($text.ToString() -ne $full) { throw 'Filename readback mismatch; refusing submit' }
if (![DialogInterop]::PostMessage([IntPtr]$dialog.Current.NativeWindowHandle,273,[IntPtr]1,[IntPtr]::Zero)) { throw 'Native dialog submit failed' }
Write-Output 'OWNED_FILENAME_VERIFIED_AND_SUBMITTED'
