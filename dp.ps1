$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$EnvFile = Join-Path $StateRoot '.env'
$DatabaseSetup = Join-Path $Root 'database-setup.ps1'
$ComposeFile = Join-Path $Root 'docker-compose.yml'
$Run = Join-Path $StateRoot '.run'
Set-Location $Root

function Info($m) { Write-Host "[d-predict] $m" -ForegroundColor Green }
function Warn($m) { Write-Host "[d-predict] $m" -ForegroundColor Yellow }
function Die($m) { Write-Host "[d-predict] $m" -ForegroundColor Red; exit 1 }
function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable('Path','Machine')
  $user = [Environment]::GetEnvironmentVariable('Path','User')
  $env:Path = "$machine;$user"
  foreach ($dir in @((Join-Path $env:ProgramFiles 'nodejs'),(Join-Path $env:LOCALAPPDATA 'Programs\nodejs'),(Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin'))) {
    if ($dir -and (Test-Path $dir) -and (($env:Path -split ';') -notcontains $dir)) { $env:Path = "$dir;$env:Path" }
  }
}
function Need($name) { Refresh-Path; if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Die "Missing '$name'. Run D-Predict Repair & Check." } }
function Import-EnvFile([string]$Path) {
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $parts = $line.Split('=',2)
      [Environment]::SetEnvironmentVariable($parts[0].Trim(), $parts[1].Trim(), 'Process')
    }
  }
}
function Ensure-DatabaseConfig {
  New-Item -ItemType Directory -Force $StateRoot | Out-Null
  if (-not (Test-Path $EnvFile)) {
    if (-not (Test-Path $DatabaseSetup)) { Die 'database-setup.ps1 is missing from the installation.' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $DatabaseSetup
    if ($LASTEXITCODE -ne 0) { Die 'Database setup was not completed.' }
  }
  Import-EnvFile $EnvFile
  if (-not $env:DATABASE_MODE) { Die 'DATABASE_MODE is missing. Run .\database-setup.ps1.' }
  if (-not $env:DATABASE_URL) { Die 'DATABASE_URL is missing. Run .\database-setup.ps1.' }
  if ($env:DATABASE_MODE -eq 'local_postgres' -and -not $env:D_PREDICT_DATA_DIR) { Die 'D_PREDICT_DATA_DIR is missing. Run .\database-setup.ps1.' }
}
function Ensure-ComposeFile { if (-not (Test-Path $ComposeFile)) { Die 'docker-compose.yml is missing.' } }
function Ensure-DockerReady {
  Refresh-Path
  Need docker
  $null = & docker info 2>&1
  if ($LASTEXITCODE -eq 0) { return }
  $desktop = Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'
  if (Test-Path $desktop) { Start-Process $desktop | Out-Null }
  for ($i=0; $i -lt 45; $i++) {
    Start-Sleep -Seconds 2
    $null = & docker info 2>&1
    if ($LASTEXITCODE -eq 0) { return }
  }
  Die 'Docker Desktop is installed but the engine is not ready.'
}
function Ensure-Tooling {
  Refresh-Path
  foreach ($name in @('node','npm','docker')) { Need $name }
  $python = Join-Path $Root 'collector\.venv\Scripts\python.exe'
  if (-not (Test-Path $python)) { Die 'Collector Python environment is missing. Run Repair & Check.' }
}
function Ensure-RunDir { New-Item -ItemType Directory -Force $Run | Out-Null }
function Invoke-Compose([string[]]$ComposeArgs) {
  Ensure-ComposeFile
  $dockerArgs = @('-f', $ComposeFile) + $ComposeArgs
  $composeOutput = @(& docker compose @dockerArgs 2>&1)
  $composeExitCode = $LASTEXITCODE
  $composeOutput | Out-Host
  if ($composeExitCode -ne 0) { Die "Docker Compose failed (exit code $composeExitCode)." }
}
function Compose([string[]]$ComposeArgs) { Invoke-Compose $ComposeArgs }
function Start-Detached($name,$command) {
  Ensure-RunDir
  $p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command',$command -WorkingDirectory $Root -PassThru
  Set-Content -Path (Join-Path $Run "$name.pid") -Value $p.Id
  Info "$name started (PID $($p.Id))"
}
function Invoke-Setup { & powershell -NoProfile -ExecutionPolicy Bypass -File $DatabaseSetup }
function Invoke-Start {
  Ensure-DatabaseConfig
  Ensure-Tooling
  Ensure-DockerReady
  Ensure-ComposeFile
  $profile = if ($env:DATABASE_MODE -eq 'local_postgres') { 'local' } else { 'remote' }
  $env:COMPOSE_DATABASE_URL = if ($profile -eq 'local') { 'postgresql://postgres:localdev@postgres:5432/nifty' } else { $env:DATABASE_URL }
  if ($profile -eq 'local') { Info "Starting local PostgreSQL at $($env:D_PREDICT_DATA_DIR)" } else { Info "Using user-owned $($env:DATABASE_MODE) database" }
  if ($profile -eq 'local') {
    Info 'Starting PostgreSQL...'
    Compose @('--profile','local','up','-d','postgres')
    $postgresReady = $false
    for ($i = 0; $i -lt 60; $i++) {
      $null = @(& docker compose -f $ComposeFile exec -T postgres pg_isready -U postgres -d nifty 2>&1)
      $postgresCheckExitCode = $LASTEXITCODE
      if ($postgresCheckExitCode -eq 0) { $postgresReady = $true; break }
      Start-Sleep -Seconds 1
    }
    if (-not $postgresReady) { Die 'PostgreSQL did not become ready. Check docker compose logs postgres --tail=100.' }
    Compose @('--profile','local','up','-d','--build','api','research','ml','collector','engine')
  } else {
    Compose @('--profile',$profile,'up','-d','--build')
  }
  Ensure-RunDir
  Info 'Starting dashboard...'
  Start-Detached 'ui' 'npm --prefix dashboard run dev'
  Info 'Local dashboard: http://127.0.0.1:3000'
  Info 'Local API:       http://127.0.0.1:4100/health'
  Info 'Research API:    http://127.0.0.1:4200/health'
  Info 'ML inference:    http://127.0.0.1:4300/health'
}
function Invoke-Stop {
  foreach ($name in @('ui')) {
    $pidFile = Join-Path $Run "$name.pid"
    if (Test-Path $pidFile) { try { Stop-Process -Id ([int](Get-Content $pidFile | Select-Object -First 1)) -Force -ErrorAction Stop } catch {}; Remove-Item $pidFile -Force -ErrorAction SilentlyContinue }
  }
  if (Get-Command docker -ErrorAction SilentlyContinue) { Ensure-ComposeFile; docker compose -f $ComposeFile --profile local --profile remote stop | Out-Host }
}
function Invoke-Status {
  Ensure-DatabaseConfig
  if (Get-Command docker -ErrorAction SilentlyContinue) { Ensure-ComposeFile; docker compose -f $ComposeFile --profile local --profile remote ps | Out-Host }
  Info "Database mode: $env:DATABASE_MODE"
  if ($env:D_PREDICT_DATA_DIR) { Info "Data root: $env:D_PREDICT_DATA_DIR" }
}
function Invoke-Doctor {
  Ensure-DatabaseConfig
  Refresh-Path
  foreach ($c in @('node','npm','docker')) { if (Get-Command $c -ErrorAction SilentlyContinue) { Info "${c}: available" } else { Warn "${c}: missing" } }
  Info "Database mode: $env:DATABASE_MODE"
  Info "Database config: $EnvFile"
  if ($env:D_PREDICT_DATA_DIR) { Info "Data root: $env:D_PREDICT_DATA_DIR" }
}
function Invoke-Test {
  Ensure-Tooling
  npm --prefix backend test
  npm --prefix dashboard run check
  npm --prefix dashboard run build
}

$Command = if ($args.Count) { $args[0].ToLowerInvariant() } else { 'help' }
if ($Command -eq 'setup-db' -or $Command -eq 'database') { Invoke-Setup; exit $LASTEXITCODE }
Ensure-DatabaseConfig
switch ($Command) {
  'start' { Invoke-Start }
  'stop' { Invoke-Stop }
  'restart' { Invoke-Stop; Invoke-Start }
  'status' { Invoke-Status }
  'doctor' { Invoke-Doctor }
  'test' { Invoke-Test }
  'init' { Invoke-Setup }
  'api' { Ensure-Tooling; npm --prefix backend run dev }
  'research' { Ensure-Tooling; npm --prefix backend exec -- tsx src/research-server.ts }
  'ui' { Ensure-Tooling; npm --prefix dashboard run dev }
  'collect' { Ensure-Tooling; & (Join-Path $Root 'collector\.venv\Scripts\python.exe') -m collector.main }
  default {
    Write-Host 'D-Predict Windows launcher'
    Write-Host 'Usage: .\dp.ps1 <command>'
    Write-Host '  start      Start D-Predict using the selected database mode'
    Write-Host '  setup-db   Change Local PostgreSQL / Supabase configuration'
    Write-Host '  status     Show database and service status'
    Write-Host '  doctor     Check local prerequisites'
    Write-Host '  stop       Stop D-Predict services'
    Write-Host '  restart    Restart D-Predict services'
    Write-Host '  test       Run backend/dashboard checks'
  }
}
