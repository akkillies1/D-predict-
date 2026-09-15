$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$LogDir = Join-Path $StateRoot 'logs'
$LogFile = Join-Path $LogDir 'launcher.log'
Set-Location $Root
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Log([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  $line | Tee-Object -FilePath $LogFile -Append
}

try {
  Log 'D-Predict launcher starting.'
  & (Join-Path $Root 'run.ps1') start *>&1 | Tee-Object -FilePath $LogFile -Append
  if ($LASTEXITCODE -ne 0) { throw "D-Predict services failed to start (exit code $LASTEXITCODE)." }

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
  Write-Host "Log: $LogFile" -ForegroundColor Yellow
  Write-Host $_.Exception.Message -ForegroundColor Red
  Read-Host 'Press Enter to close'
  exit 1
}
