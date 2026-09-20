$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

function Write-Step($message) { Write-Host "[D-Predict] $message" -ForegroundColor Cyan }
function Test-TcpPort($hostName, $port) {
  try {
    $client = [System.Net.Sockets.TcpClient]::new()
    $task = $client.ConnectAsync($hostName, $port)
    if (-not $task.Wait(500)) { $client.Dispose(); return $false }
    $ok = $client.Connected
    $client.Dispose()
    return $ok
  } catch { return $false }
}

Write-Step "Starting local D-Predict stack..."

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw "Docker is required. Install/start Docker Desktop, then run .\d-predict.ps1 again."
}
if (-not (docker info 2>$null)) {
  throw "Docker Desktop is not running. Start Docker Desktop, then run .\d-predict.ps1 again."
}

if (-not (Test-Path ".env")) {
  Write-Step "Creating local .env from .env.example"
  Copy-Item ".env.example" ".env"
}

Write-Step "Starting PostgreSQL, market API, research, ML, collector and engine in background..."
docker compose --profile local --profile remote up -d

Write-Step "Waiting for PostgreSQL..."
for ($i = 0; $i -lt 60; $i++) {
  try {
    docker compose exec -T postgres pg_isready -U postgres -d nifty | Out-Null
    break
  } catch {}
  if ($i -eq 59) { docker compose ps; throw "PostgreSQL did not become ready." }
  Start-Sleep -Seconds 1
}

Write-Step "Applying idempotent shadow trading migration..."
for ($j=0; $j -lt 30; $j++) { try { docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/008-shadow-trading.sql 2>$null; if ($LASTEXITCODE -eq 0) { break } } catch {}; Start-Sleep -Seconds 2 }

Write-Step "Applying idempotent option paper trading migration..."
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/009-option-paper-trading.sql

Write-Step "Applying idempotent D-Predict 2.0 migration..."
docker compose exec -T postgres psql -U postgres -d nifty -f /docker-entrypoint-initdb.d/010-dpredict-20.sql

Write-Step "Waiting for market API health..."
$healthy = $false
for ($i = 0; $i -lt 60; $i++) {
  if (Test-TcpPort "127.0.0.1" 4100) {
    try {
      $health = Invoke-RestMethod "http://127.0.0.1:4100/health" -TimeoutSec 2
      if ($health.ok -eq $true) { $healthy = $true; break }
    } catch {}
  }
  Start-Sleep -Seconds 1
}
if (-not $healthy) {
  docker compose ps
  throw "Market API did not become healthy on port 4100. Check: docker compose logs api --tail=100"
}

try {
  $runtime = Invoke-RestMethod "http://127.0.0.1:4100/ready" -TimeoutSec 3
  if ($runtime.ok -eq $true) {
    Write-Step "Market data ready: $($runtime.dailyBars) daily bars; latest $($runtime.latestMarketTimestamp)."
  } else {
    Write-Step "Services are healthy; market data is still $($runtime.marketData). The collector may still be acquiring data."
  }
} catch {
  Write-Step "Services are healthy; market readiness is not available yet. Continuing startup."
}

Write-Step "Waiting for research API health..."
$researchHealthy = $false
for ($i = 0; $i -lt 60; $i++) {
  if (Test-TcpPort "127.0.0.1" 4200) {
    try {
      $researchHealth = Invoke-RestMethod "http://127.0.0.1:4200/health" -TimeoutSec 2
      if ($researchHealth.ok -eq $true) { $researchHealthy = $true; break }
    } catch {}
  }
  Start-Sleep -Seconds 1
}
if (-not $researchHealthy) {
  docker compose ps
  throw "Research API did not become healthy on port 4200. Check: docker compose logs research --tail=100"
}

Write-Step "Waiting for ML inference health..."
$mlHealthy = $false
for ($i = 0; $i -lt 60; $i++) {
  if (Test-TcpPort "127.0.0.1" 4300) {
    try {
      $mlHealth = Invoke-RestMethod "http://127.0.0.1:4300/health" -TimeoutSec 2
      if ($mlHealth.ok -eq $true) { $mlHealthy = $true; break }
    } catch {}
  }
  Start-Sleep -Seconds 1
}
if (-not $mlHealthy) {
  docker compose ps
  throw "ML inference service did not become healthy on port 4300. Check: docker compose logs ml --tail=100"
}

if (-not (Get-Command corepack -ErrorAction SilentlyContinue)) {
  throw "Node.js/Corepack is required to run the dashboard. Install Node.js 20+ and retry."
}

Write-Step "Preparing dashboard dependencies..."
Push-Location "dashboard"
try {
  corepack pnpm install --frozen-lockfile
} finally {
  Pop-Location
}

Write-Step "Starting dashboard in background..."
$dashboardLog = Join-Path $PSScriptRoot "dashboard-local.log"
$dashboard = Start-Process -FilePath "powershell.exe" -ArgumentList @(
  "-NoProfile",
  "-ExecutionPolicy", "Bypass",
  "-Command", "Set-Location '$PSScriptRoot\dashboard'; corepack pnpm dev *> '$dashboardLog'"
) -PassThru -WindowStyle Minimized

Write-Step "Waiting for dashboard..."
$dashboardUrl = $null
for ($i = 0; $i -lt 60; $i++) {
  foreach ($port in 3000..3019) {
    if (Test-TcpPort "127.0.0.1" $port) {
      $dashboardUrl = "http://127.0.0.1:$port/"
      break
    }
  }
  if ($dashboardUrl) { break }
  Start-Sleep -Seconds 1
}

if (-not $dashboardUrl) {
  Get-Content $dashboardLog -Tail 100 -ErrorAction SilentlyContinue
  throw "Dashboard did not start. Check dashboard-local.log."
}

Write-Step "D-Predict is ready."
Write-Host ""
Write-Host "  Dashboard : $dashboardUrl" -ForegroundColor Green
Write-Host "  Market API: http://127.0.0.1:4100/health" -ForegroundColor Green
Write-Host "  Shadow API: http://127.0.0.1:4100/api/shadow/portfolio" -ForegroundColor Green
Write-Host "  Research  : http://127.0.0.1:4200/health" -ForegroundColor Green
Write-Host "  ML model  : http://127.0.0.1:4300/health" -ForegroundColor Green
Write-Host "  PostgreSQL: localhost:5433" -ForegroundColor Green
Write-Host ""
Write-Step "Opening browser..."
Start-Process $dashboardUrl
Write-Host ""
Write-Host "Use .\stop-d-predict.ps1 to stop the local stack." -ForegroundColor DarkGray
