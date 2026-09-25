param([Parameter(Mandatory=$true)][string]$Executable)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
Get-AuthenticodeSignature -LiteralPath $Executable | Select-Object Status,StatusMessage | ConvertTo-Json -Compress
