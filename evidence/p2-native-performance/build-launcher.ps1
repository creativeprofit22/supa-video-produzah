Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
$vs = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if ($LASTEXITCODE -ne 0 -or -not $vs) { throw "Installed C++ build tools required" }
$version = (Get-Content -LiteralPath (Join-Path $vs 'VC/Auxiliary/Build/Microsoft.VCToolsVersion.default.txt') -Raw).Trim()
$vc = Join-Path $vs "VC/Tools/MSVC/$version"
$kit = (Get-ItemProperty 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows Kits\Installed Roots').KitsRoot10
$sdk = Get-ChildItem (Join-Path $kit 'Include') -Directory | Where-Object { Test-Path (Join-Path $_.FullName 'um/Windows.h') } | Sort-Object Name -Descending | Select-Object -First 1
if (-not $sdk) { throw "Installed Windows SDK required" }
$run = Join-Path $PSScriptRoot ('runs/launcher-' + [Guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $run
$exe = Join-Path $run 'OwnedRun.exe'
$source = Join-Path $PSScriptRoot 'OwnedRun.cpp'
$args = @('/nologo', '/EHsc', '/std:c++17', '/W4', ('/I' + (Join-Path $vc 'include')), ('/I' + (Join-Path $sdk.FullName 'ucrt')), ('/I' + (Join-Path $sdk.FullName 'shared')), ('/I' + (Join-Path $sdk.FullName 'um')), ('/Fe:' + $exe), ('/Fo:' + (Join-Path $run 'OwnedRun.obj')), $source, '/link', ('/LIBPATH:' + (Join-Path $vc 'lib/x64')), ('/LIBPATH:' + (Join-Path $kit ('Lib/' + $sdk.Name + '/ucrt/x64'))), ('/LIBPATH:' + (Join-Path $kit ('Lib/' + $sdk.Name + '/um/x64'))), 'kernel32.lib')
& (Join-Path $vc 'bin/Hostx64/x64/cl.exe') @args
if ($LASTEXITCODE -ne 0) { throw "Launcher compilation failed" }
$receipt = [ordered]@{ utc = [DateTime]::UtcNow.ToString('o'); executable = $exe; sourceSha256 = (Get-FileHash $source -Algorithm SHA256).Hash.ToLowerInvariant(); executableSha256 = (Get-FileHash $exe -Algorithm SHA256).Hash.ToLowerInvariant(); argv = $args; compiler = (Join-Path $vc 'bin/Hostx64/x64/cl.exe'); exitCode = 0 }
$receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $run 'receipt.json') -Encoding UTF8
$receipt | ConvertTo-Json -Depth 4
