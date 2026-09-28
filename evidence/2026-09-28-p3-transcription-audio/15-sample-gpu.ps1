# Samples total GPU memory and the running ffmpeg / nemo-speech processes every 250 ms,
# so a production-path run can be split into extraction, per-piece and speaker-pass spans.
# usage: powershell -File 15-sample-gpu.ps1 <out.csv>   (stop by creating <out.csv>.stop)
param([string]$Out)
"t_ms,vram_mib,procs" | Set-Content -Encoding ascii $Out
$start = [DateTime]::UtcNow
while (-not (Test-Path "$Out.stop")) {
  $vram = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits).Trim()
  $procs = Get-CimInstance Win32_Process -Filter "Name='nemo-speech.exe' OR Name='ffmpeg.exe'" |
    ForEach-Object {
      $cl = $_.CommandLine
      if ($_.Name -eq 'ffmpeg.exe') { 'ffmpeg' }
      elseif ($cl -match ' diarize ') { 'diarize' }
      elseif ($cl -match '(piece-\d+)\.wav') { $Matches[1] }
      else { 'nemo' }
    }
  $ms = [int]([DateTime]::UtcNow - $start).TotalMilliseconds
  "$ms,$vram,$(($procs | Sort-Object) -join ' ')" | Add-Content -Encoding ascii $Out
  Start-Sleep -Milliseconds 250
}
