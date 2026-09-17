$ErrorActionPreference = "Continue"
Set-Location $PSScriptRoot

Write-Host "[D-Predict] Stopping dashboard..." -ForegroundColor Cyan
Get-CimInstance Win32_Process -Filter "Name = 'powershell.exe'" |
  Where-Object { $_.CommandLine -like "*dashboard; corepack pnpm dev*" -or $_.CommandLine -like "*dashboard\corepack pnpm dev*" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }

Write-Host "[D-Predict] Stopping local Docker services..." -ForegroundColor Cyan
docker compose --profile local --profile remote stop api research ml collector engine postgres

Write-Host "[D-Predict] Local D-Predict stack stopped." -ForegroundColor Green
