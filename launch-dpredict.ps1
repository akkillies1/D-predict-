$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$LogDir = Join-Path $StateRoot 'logs'
$LogFile = Join-Path $LogDir 'launcher.log'
$BootstrapLog = Join-Path $LogDir 'bootstrap.log'
$CompleteMarker = Join-Path $StateRoot '.install-complete'
Set-Location $Root
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Log([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  $line | Tee-Object -FilePath $LogFile -Append
}

try {
  Log 'D-Predict launcher starting.'

  if (-not (Test-Path $CompleteMarker)) {
    throw "D-Predict installation is incomplete. Run 'D-Predict Setup & Repair' first. See $BootstrapLog"
  }

  & (Join-Path $Root 'run.ps1') start *>&1 | Tee-Object -FilePath $LogFile -Append
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    if (Test-Path $BootstrapLog) {
      $dockerFailure = Get-Content $BootstrapLog -Tail 40 | Where-Object { $_ -match 'Docker|docker' } | Select-Object -Last 1
      if ($dockerFailure) { throw "D-Predict prerequisites could not start. $dockerFailure`nSee: $BootstrapLog" }
    }
    throw "D-Predict services failed to start (exit code $exitCode). See $LogFile"
  }

  Log 'Waiting for dashboard on http://127.0.0.1:3000 ...'
  $ready = $false
  for ($i = 0; $i -lt 45; $i++) {
    try {
      $response = Invoke-WebRequest -Uri 'http://127.0.0.1:3000' -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ready = $true; break }
    } catch { }
    Start-Sleep -Seconds 1
  }

  if (-not $ready) { throw 'Dashboard did not become available within 45 seconds. Check the launcher log.' }
  Log 'Dashboard is ready. Opening browser.'
  Start-Process 'http://127.0.0.1:3000'
  Log 'D-Predict launched successfully.'
} catch {
  Log "ERROR: $($_.Exception.Message)"
  Write-Host "`nD-Predict could not start." -ForegroundColor Red
  Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
  Write-Host "`nLauncher log: $LogFile" -ForegroundColor Yellow
  if (Test-Path $BootstrapLog) { Write-Host "Bootstrap log: $BootstrapLog" -ForegroundColor Yellow }
  Read-Host 'Press Enter to close'
  exit 1
}
