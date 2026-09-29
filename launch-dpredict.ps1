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

function Resolve-BrowserExe {
  # Prefer the executable behind the user's http association, then the common
  # Chromium/Gecko installs. Resolved paths are returned in that order.
  $found = @()
  $progId = (Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice' -ErrorAction SilentlyContinue).ProgId
  if ($progId) {
    foreach ($hive in @('HKCU:\Software\Classes', 'HKLM:\SOFTWARE\Classes')) {
      $command = (Get-ItemProperty "$hive\$progId\shell\open\command" -ErrorAction SilentlyContinue).'(default)'
      if ($command -and $command -match '"([^"]+\.exe)"') { $found += $Matches[1] }
    }
  }
  foreach ($path in @("$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe", "$env:ProgramFiles\Google\Chrome\Application\chrome.exe", "$env:ProgramFiles\Mozilla Firefox\firefox.exe")) {
    $found += $path
  }
  $found | Where-Object { $_ } | Select-Object -Unique
}

function Open-DashboardBrowser([string]$Url) {
  # Handing a URL to an already-running Edge/Chrome opens a tab in whichever
  # window that instance owns and the launched process exits at once, so a bare
  # Start-Process reports success while nothing becomes visible. --new-window
  # forces a window the user can actually see.
  foreach ($exe in (Resolve-BrowserExe)) {
    if (-not (Test-Path $exe)) { continue }
    try {
      Start-Process -FilePath $exe -ArgumentList @('--new-window', "`"$Url`"") -ErrorAction Stop
      Log "Opened $Url in a new $([IO.Path]::GetFileName($exe)) window."
      return
    } catch {
      Log "Launch attempt failed for ${exe}: $($_.Exception.Message)"
    }
  }
  try {
    Start-Process $Url
    Log "Opened $Url with the Windows default handler."
  } catch {
    Log "Default handler failed: $($_.Exception.Message)"
  }
  Log "If no window appeared, open $Url manually."
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

  Log 'Waiting for dashboard on ports 3000-3019 ...'
  $ready = $false
  $dashboardUrl = $null
  for ($i = 0; $i -lt 45; $i++) {
    foreach ($port in 3000..3019) {
      try {
        $url = "http://127.0.0.1:$port/"
        $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { $ready = $true; $dashboardUrl = $url; break }
      } catch { }
    }
    if ($ready) { break }
    Start-Sleep -Seconds 1
  }

  if (-not $ready) { throw 'Dashboard did not become available within 45 seconds. Check the launcher log.' }
  Log "Dashboard is ready at $dashboardUrl. Opening browser."
  try {
    $runtime = Invoke-RestMethod -Uri 'http://127.0.0.1:4100/ready' -TimeoutSec 3
    if ($runtime.ok -eq $true) {
      Log "Market data is ready: $($runtime.dailyBars) daily bars; latest market timestamp $($runtime.latestMarketTimestamp)."
    } else {
      Log "Services are running but market data is not ready yet: $($runtime.marketData). The collector may still be acquiring data."
    }
  } catch {
    Log 'Market readiness endpoint is not available yet; dashboard will still open.'
  }
  Open-DashboardBrowser $dashboardUrl
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
