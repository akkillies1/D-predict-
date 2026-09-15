$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA "D-Predict"
$Run = Join-Path $StateRoot ".run"
$EnvFile = Join-Path $Root ".env"

function Info($m) { Write-Host "[d-predict] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[d-predict] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[d-predict] $m" -ForegroundColor Red; exit 1 }
function Need($name) { if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Die "Missing '$name'. Run D-Predict Repair & Check." } }
function Ensure-RunDir { New-Item -ItemType Directory -Force $Run | Out-Null }
function Ensure-Env {
  if (Test-Path $EnvFile) { return }
  try {
    Copy-Item (Join-Path $Root ".env.example") $EnvFile -ErrorAction Stop
    Info "Created .env from .env.example"
  } catch {
    Warn "Install directory is not writable; using environment defaults without creating .env."
    $example = Join-Path $Root ".env.example"
    if (-not (Test-Path $example)) { Die "Missing .env.example." }
    Get-Content $example | ForEach-Object {
      $line = $_.Trim()
      if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
        $parts = $line.Split('=',2)
        [Environment]::SetEnvironmentVariable($parts[0], $parts[1], 'Process')
      }
    }
  }
}
function Ensure-DockerReady {
  docker info *> $null
  if ($LASTEXITCODE -eq 0) { return }
  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) {
    Info "Starting Docker Desktop..."
    Start-Process $desktop | Out-Null
  }
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 2
    docker info *> $null
    if ($LASTEXITCODE -eq 0) { return }
  }
  Die "Docker Desktop is installed but the Docker engine is not ready. Start Docker Desktop and try again."
}
function Start-Detached($name, $command) {
  Ensure-RunDir
  $p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command',$command -WorkingDirectory $Root -PassThru
  Set-Content -Path (Join-Path $Run "$name.pid") -Value $p.Id
  Info "$name started (PID $($p.Id))"
}
function Invoke-Init {
  Ensure-Env
  Need node; Need npm; Need python; Need docker
  Info "Installing backend dependencies..."
  npm --prefix backend install
  Info "Installing dashboard dependencies..."
  npm --prefix dashboard install --legacy-peer-deps
  $venv = Join-Path $Root "collector\.venv"
  if (-not (Test-Path (Join-Path $venv "Scripts\python.exe"))) { python -m venv $venv }
  & (Join-Path $venv "Scripts\python.exe") -m pip install --upgrade pip
  & (Join-Path $venv "Scripts\python.exe") -m pip install -r (Join-Path $Root "collector\requirements.txt")
  Info "Initialization complete."
}
function Invoke-Doctor {
  foreach ($c in @('node','npm','python','docker')) { if (Get-Command $c -ErrorAction SilentlyContinue) { Info "${c}: available" } else { Warn "${c}: missing" } }
  if (Test-Path $EnvFile) { Info ".env: present" } else { Warn ".env: using process defaults" }
  if (Test-Path (Join-Path $Root "backend\node_modules")) { Info "backend dependencies: installed" } else { Warn "backend dependencies: missing" }
  if (Test-Path (Join-Path $Root "dashboard\node_modules")) { Info "dashboard dependencies: installed" } else { Warn "dashboard dependencies: missing" }
  if (Test-Path (Join-Path $Root "collector\.venv\Scripts\python.exe")) { Info "collector Python environment: installed" } else { Warn "collector Python environment: missing" }
  if (Get-Command docker -ErrorAction SilentlyContinue) { docker compose version | Out-Host }
}
function Invoke-Start {
  Ensure-Env
  Need node; Need npm; Need python; Need docker
  Ensure-DockerReady
  Ensure-RunDir
  Info "Starting PostgreSQL..."
  docker compose up -d postgres
  if ($LASTEXITCODE -ne 0) { Die "PostgreSQL could not be started." }
  Info "Starting API..."
  Start-Detached "api" "npm --prefix backend run dev"
  Info "Starting research service..."
  Start-Detached "research" "npm --prefix backend exec -- tsx src/research-server.ts"
  Info "Starting dashboard..."
  Start-Detached "ui" "npm --prefix dashboard run dev"
  Info "Starting collector..."
  $python = Join-Path $Root "collector\.venv\Scripts\python.exe"
  if (-not (Test-Path $python)) { Die "Collector environment missing. Run D-Predict Repair & Check." }
  Start-Detached "collector" "& '$python' -m collector.main"
  Info "Local dashboard: http://127.0.0.1:3000"
  Info "Local API:       http://127.0.0.1:4100/health"
  Info "Research API:    http://127.0.0.1:4200/health"
}
function Invoke-Stop {
  foreach ($name in @('api','research','ui','collector')) {
    $pidFile = Join-Path $Run "$name.pid"
    if (Test-Path $pidFile) {
      $pidValue = Get-Content $pidFile | Select-Object -First 1
      try { Stop-Process -Id ([int]$pidValue) -Force -ErrorAction Stop; Info "$name stopped" } catch { }
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
  if (Get-Command docker -ErrorAction SilentlyContinue) { docker compose stop postgres | Out-Host }
}
function Invoke-Status {
  if (Get-Command docker -ErrorAction SilentlyContinue) { docker compose ps | Out-Host }
  foreach ($name in @('api','research','ui','collector')) {
    $pidFile = Join-Path $Run "$name.pid"
    if (Test-Path $pidFile) {
      $pidValue = Get-Content $pidFile | Select-Object -First 1
      $running = Get-Process -Id ([int]$pidValue) -ErrorAction SilentlyContinue
      Write-Host "$name`: " -NoNewline
      if ($running) { Write-Host "running (PID $pidValue)" -ForegroundColor Green } else { Write-Host "stopped" -ForegroundColor Yellow }
    }
  }
}
function Invoke-Test {
  Need npm
  npm --prefix backend test
  npm --prefix dashboard run check
  npm --prefix dashboard run build
}

Ensure-Env
$Command = if ($args.Count) { $args[0].ToLowerInvariant() } else { "help" }
switch ($Command) {
  "init" { Invoke-Init }
  "doctor" { Invoke-Doctor }
  "start" { Invoke-Start }
  "stop" { Invoke-Stop }
  "status" { Invoke-Status }
  "test" { Invoke-Test }
  "api" { Need npm; npm --prefix backend run dev }
  "research" { Need npm; npm --prefix backend exec -- tsx src/research-server.ts }
  "ui" { Need npm; npm --prefix dashboard run dev }
  "collect" { $python = Join-Path $Root "collector\.venv\Scripts\python.exe"; if (-not (Test-Path $python)) { Die "Run D-Predict Repair & Check first." }; & $python -m collector.main }
  default {
    Write-Host "D-Predict Windows launcher"
    Write-Host "Usage: .\dp.ps1 <command>"
    Write-Host "  init     Install dependencies and prepare local environment"
    Write-Host "  doctor   Check local prerequisites"
    Write-Host "  start    Start PostgreSQL, API, research, dashboard and collector"
    Write-Host "  stop     Stop local services"
    Write-Host "  status   Show service status"
    Write-Host "  test     Build and test backend/dashboard"
  }
}
