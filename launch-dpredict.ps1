$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Root

Write-Host 'D-Predict launcher' -ForegroundColor Cyan
& (Join-Path $Root 'run.ps1') start
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Start-Sleep -Seconds 2
Start-Process 'http://127.0.0.1:3000'
