param([int]$OwnerId, [string]$Creation, [string]$FilePath, [string]$AllowedRoot)
# Answers one owned native file/folder picker for the release smoke harness.
# Derived from evidence/2026-09-28-p3-transcription-audio/13-native-dialog.ps1: same owner-PID +
# creation-token + readback checks, with the allowlist narrowed to one temp run directory.
# Answers both native file pickers and IFileDialog FOS_PICKFOLDERS folder pickers (same #32770 filename host).
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
# Allowlist: only paths inside one fresh %TEMP%\supa-release-smoke-* run directory.
$sep = [IO.Path]::DirectorySeparatorChar
$tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd($sep) + $sep + 'supa-release-smoke-'
$root = [IO.Path]::GetFullPath($AllowedRoot).TrimEnd($sep) + $sep
if (!$root.StartsWith($tempRoot,[StringComparison]::OrdinalIgnoreCase)) { throw 'Allowed root must be a supa-release-smoke temp directory' }
if (!($full + $sep).StartsWith($root,[StringComparison]::OrdinalIgnoreCase)) { throw 'Not an authorized smoke path' }
$owner = Get-Process -Id $OwnerId
if ($owner.StartTime.ToFileTimeUtc().ToString() -ne $Creation) { throw 'Owned process identity changed' }
$condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty,$OwnerId)
$deadline = [DateTime]::UtcNow.AddSeconds(15)
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
 if (!$input) {
  # FOS_PICKFOLDERS dialogs host the "Folder:" edit as control id 1152 instead of FileNameControlHost/1001.
  $folderId = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1152')
  $input = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,(New-Object System.Windows.Automation.AndCondition($folderId,$editClass)))
 }
 if (!$input) { [Threading.Thread]::Sleep(20) }
}
if (!$input -or !$input.Current.NativeWindowHandle) {
 $edits = $dialog.FindAll([System.Windows.Automation.TreeScope]::Descendants,$editClass)
 Write-Output ('OWNED_DIALOG_EDITS=' + (($edits | ForEach-Object { $_.Current.AutomationId + '|' + $_.Current.Name + '|' + $_.Current.NativeWindowHandle }) -join ';'))
 throw 'No native filename input'
}
[uint32]$actual = 0
$handle = [IntPtr]$input.Current.NativeWindowHandle
[void][DialogInterop]::GetWindowThreadProcessId($handle,[ref]$actual)
if ($actual -ne $OwnerId) { throw 'Filename input owner mismatch' }
$result = [IntPtr]::Zero
if ([DialogInterop]::SendMessageTimeout($handle,12,[IntPtr]::Zero,$full,2,2000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Filename update timed out' }
$text = New-Object Text.StringBuilder 32768
if ([DialogInterop]::ReadText($handle,13,[IntPtr]$text.Capacity,$text,2,2000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Filename readback timed out' }
if ($text.ToString() -ne $full) { throw 'Filename readback mismatch; refusing submit' }
$dialogHandle = [IntPtr]$dialog.Current.NativeWindowHandle
if (![DialogInterop]::PostMessage($dialogHandle,273,[IntPtr]1,[IntPtr]::Zero)) { throw 'Native dialog submit failed' }
# Folder pickers: OK on a typed folder path only NAVIGATES into that folder and the
# dialog stays open. Confirm the address bar shows exactly the verified folder and
# the Folder field is empty, then OK again ("Select Folder") returns that folder.
if ([IO.Directory]::Exists($full)) {
 $addressCondition = New-Object System.Windows.Automation.AndCondition(
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,'1001')),
  (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty,'ToolbarWindow32')))
 $selectDeadline = [DateTime]::UtcNow.AddSeconds(10)
 $selected = $false
 $lastSeen = 'address not found'
 while (!$selected -and [DateTime]::UtcNow -lt $selectDeadline) {
  [Threading.Thread]::Sleep(200)
  try { $address = $dialog.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$addressCondition) } catch { break }
  if (!$address) { continue }
  # Localised label, e.g. "Address: E:\x" or "Dirección: E:\x": compare the path after ": ".
  $name = $address.Current.Name
  $shown = $name.Substring($name.IndexOf(': ') + 2)
  $lastSeen = 'address=' + $name
  if ($shown -ne $full.TrimEnd('\')) { continue }
  # When the dialog already opened in this folder (Windows remembers the last one),
  # OK does not navigate and the field keeps the folder's name, which would select a
  # child of that name. Clear the field explicitly so OK selects the verified folder.
  if ([DialogInterop]::SendMessageTimeout($handle,12,[IntPtr]::Zero,'',2,2000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Folder field clear timed out' }
  $current = New-Object Text.StringBuilder 32768
  if ([DialogInterop]::ReadText($handle,13,[IntPtr]$current.Capacity,$current,2,2000,[ref]$result) -eq [IntPtr]::Zero) { throw 'Folder field readback timed out' }
  $lastSeen = $lastSeen + '; field=' + $current.ToString()
  if ($current.ToString() -ne '') { continue }
  if (![DialogInterop]::PostMessage($dialogHandle,273,[IntPtr]1,[IntPtr]::Zero)) { throw 'Select Folder submit failed' }
  $selected = $true
 }
 if (!$selected) { throw ('Folder picker did not navigate to the verified folder (' + $lastSeen + ')') }
 Write-Output 'OWNED_FOLDER_NAVIGATED_VERIFIED_AND_SELECTED'
}
Write-Output 'OWNED_FILENAME_VERIFIED_AND_SUBMITTED'
