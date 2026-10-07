$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$EnvFile = Join-Path $StateRoot '.env'
$DatabaseSetup = Join-Path $Root 'database-setup.ps1'
$ComposeFile = Join-Path $Root 'docker-compose.yml'
# The dev checkout and the installed app share %LOCALAPPDATA%\D-Predict. A single
# .run folder would mean one start/stop kills the other's dashboard through its
# pid file, so each keeps its own.
$Run = Join-Path $StateRoot $(if (Test-Path (Join-Path $Root '.git')) { '.run-dev' } else { '.run' })
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
  foreach ($dir in @((Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\resources\bin'))) {
    if ($dir -and (Test-Path $dir) -and (($env:Path -split ';') -notcontains $dir)) { $env:Path = "$dir;$env:Path" }
  }
}
function Need($name) { Refresh-Path; if (-not (Get-Command $name -ErrorAction SilentlyContinue)) { Die "Missing '$name'. Run D-Predict Repair & Check." } }
function Test-DevCheckout { Test-Path (Join-Path $Root '.git') }
function Get-ProjectEnvKeySet {
  $ProjectEnv = Join-Path $Root '.env'
  if (-not (Test-Path $ProjectEnv)) { return @() }
  $keys = @()
  Get-Content $ProjectEnv | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) { $keys += $line.Split('=',2)[0].Trim() }
  }
  return $keys
}
function Import-EnvFile([string]$Path, [string[]]$SkipKeys = @()) {
  if (-not (Test-Path $Path)) { return }
  Get-Content $Path | ForEach-Object {
    $line = $_.Trim()
    if ($line -and -not $line.StartsWith('#') -and $line.Contains('=')) {
      $parts = $line.Split('=',2)
      $key = $parts[0].Trim()
      if ($SkipKeys -contains $key) { return }
      [Environment]::SetEnvironmentVariable($key, $parts[1].Trim(), 'Process')
    }
  }
}
function Get-ComposeProject {
  if ($env:COMPOSE_PROJECT_NAME) { return $env:COMPOSE_PROJECT_NAME }
  return (Split-Path -Leaf $Root)
}
function PortOf($value, $fallback) { if ($value) { return $value } return $fallback }
function Ensure-DatabaseConfig {
  New-Item -ItemType Directory -Force $StateRoot | Out-Null
  if (-not (Test-Path $EnvFile)) {
    if (-not (Test-Path $DatabaseSetup)) { Die 'database-setup.ps1 is missing from the installation.' }
    & powershell -NoProfile -ExecutionPolicy Bypass -File $DatabaseSetup
    if ($LASTEXITCODE -ne 0) { Die 'Database setup was not completed.' }
  }
  if (Test-DevCheckout) {
    # A source checkout pins its own host ports, Compose project name and data
    # directory in the Git-ignored root .env so it can coexist with the installed
    # app. Process environment beats the project .env for Compose interpolation,
    # so importing every state value here would silently drag dev back onto the
    # installed app's ports and, worse, its Postgres data directory.
    Import-EnvFile $EnvFile (Get-ProjectEnvKeySet)
    Import-EnvFile (Join-Path $Root '.env')
  } else {
    Import-EnvFile $EnvFile
  }
  if (-not $env:DATABASE_MODE) { Die 'DATABASE_MODE is missing. Run .\database-setup.ps1.' }
  if (-not $env:DATABASE_URL) { Die 'DATABASE_URL is missing. Run .\database-setup.ps1.' }
  if ($env:DATABASE_MODE -eq 'local_postgres' -and -not $env:D_PREDICT_DATA_DIR) { Die 'D_PREDICT_DATA_DIR is missing. Run .\database-setup.ps1.' }
}
function Ensure-ComposeFile { if (-not (Test-Path $ComposeFile)) { Die 'docker-compose.yml is missing.' } }
function Ensure-ProjectEnvFile {
  # docker-compose.yml feeds service config from a project-level .env, but a
  # fresh install keeps the user's real settings in $StateRoot instead. Seed
  # (never overwrite) the project copy so containers receive the configuration
  # the user chose at setup time.
  $ProjectEnv = Join-Path $Root '.env'
  if (Test-Path $ProjectEnv) { return }
  $seed = @($EnvFile, (Join-Path $Root '.env.example')) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $seed) { return }
  Copy-Item $seed $ProjectEnv
  Info "Created .env for Docker Compose from $(Split-Path -Leaf $seed)"
}
function Find-DockerDesktop {
  @(
    (Join-Path $env:ProgramFiles 'Docker\Docker\Docker Desktop.exe'),
    (Join-Path $env:LOCALAPPDATA 'Programs\DockerDesktop\Docker Desktop.exe')
  ) | Where-Object { Test-Path $_ } | Select-Object -First 1
}
function Test-DockerEngine {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return $false }
  # Windows PowerShell 5.1 promotes native stderr to ErrorRecord objects. Run
  # through cmd so a missing npipe is a normal readiness result, not a fatal
  # NativeCommandError that stops the launcher before it can wait or diagnose.
  $null = & cmd.exe /c 'docker info >nul 2>&1'
  return ($LASTEXITCODE -eq 0)
}
function Get-DockerDiagnostic {
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { return 'Docker CLI is not available on PATH.' }
  $lines = @(& cmd.exe /c 'docker context show 2>&1'; & cmd.exe /c 'docker info 2>&1' | Select-Object -First 1)
  ($lines | Where-Object { $_ -and $_.ToString().Trim() } | ForEach-Object { $_.ToString().Trim() }) -join ' | '
}
function Ensure-DockerReady {
  Refresh-Path
  Need docker
  if (Test-DockerEngine) { return }
  $desktop = Find-DockerDesktop
  if ($desktop) { Start-Process -FilePath $desktop -WorkingDirectory (Split-Path -Parent $desktop) | Out-Null }
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 2
    if (Test-DockerEngine) { return }
  }
  $diagnostic = Get-DockerDiagnostic
  Die "Docker Desktop Linux engine is not ready. Docker could not open its Linux engine pipe. Open Docker Desktop, wait until it says Running, confirm Linux containers / WSL 2 mode is enabled, then run D-Predict Setup & Repair again. Diagnostic: $diagnostic"
}
function Ensure-Tooling {
  Refresh-Path
  foreach ($name in @('node','npm','docker')) { Need $name }
  $python = Join-Path $Root 'collector\.venv\Scripts\python.exe'
  if (-not (Test-Path $python)) { Die 'Collector Python environment is missing. Run Repair & Check.' }
}
function Ensure-RunDir { New-Item -ItemType Directory -Force $Run | Out-Null }
function Invoke-ComposeNative([string[]]$ComposeArgs) {
  Ensure-ComposeFile
  Refresh-Path
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    # Windows PowerShell 5.1 promotes native stderr to ErrorRecord objects.
    # Docker Compose writes normal progress/status messages to stderr, so keep
    # those messages visible without letting them abort a successful command.
    $ErrorActionPreference = 'Continue'
    & docker compose -f $ComposeFile @ComposeArgs 2>&1 | ForEach-Object { $_ | Out-Host }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}
function Invoke-Compose([string[]]$ComposeArgs) {
  $code = Invoke-ComposeNative $ComposeArgs
  if ($code -ne 0) { Die "Docker Compose failed (exit code $code)." }
}
function Compose([string[]]$ComposeArgs) { Invoke-Compose $ComposeArgs }
function Start-Detached($name,$command) {
  Ensure-RunDir
  $p = Start-Process powershell -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$command -WorkingDirectory $Root -WindowStyle Hidden -PassThru
  Set-Content -Path (Join-Path $Run "$name.pid") -Value $p.Id
  Info "$name started (PID $($p.Id))"
}
function Test-PortAnswering([string]$Port) {
  if (-not $Port) { return $false }
  try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/" -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch { return $false }
}
function Get-LiveDashboardPid {
  $pidFile = Join-Path $Run 'ui.pid'
  if (-not (Test-Path $pidFile)) { return $null }
  try { $processId = [int](Get-Content $pidFile | Select-Object -First 1) } catch { return $null }
  if (Get-Process -Id $processId -ErrorAction SilentlyContinue) { return $processId }
  return $null
}
function Find-DashboardUrl {
  $ports = @()
  if ($env:PORT) {
    $ports += [int]$env:PORT
    # The 3000-3019 scan exists so an install can follow Vite when it hops to a
    # free port. A dev checkout owns an explicit offset port, and scanning that
    # range would report the installed app's dashboard instead of this one.
    if (-not (Test-DevCheckout)) { $ports += (3000..3019) }
  } else {
    $ports += (3000..3019)
  }
  for ($i = 0; $i -lt 45; $i++) {
    foreach ($port in $ports) {
      try {
        $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 2
        if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return "http://127.0.0.1:$port/" }
      } catch {}
    }
    Start-Sleep -Seconds 1
  }
  return $null
}
function Assert-DevIsolation {
  if (-not (Test-DevCheckout)) { return }
  $installedData = (($env:LOCALAPPDATA -replace '\\','/') + '/D-PredictData').TrimEnd('/')
  $devData = ($env:D_PREDICT_DATA_DIR -replace '\\','/').TrimEnd('/')
  # Absolute only: './data/runtime' resolves under this checkout, so it cannot collide.
  if ($devData.StartsWith('/') -or $devData -match '^[A-Za-z]:/') {
    if ($devData -eq $installedData) { Die "Refusing to start: this checkout mounts the installed app's database directory ($installedData). Two Postgres servers on one data directory corrupts it. Point D_PREDICT_DATA_DIR in the repository .env at a dev-only path." }
  }
  $project = Get-ComposeProject
  $wanted = @($env:API_PORT, $env:RESEARCH_PORT, $env:ML_PORT, $env:POSTGRES_PORT, $env:PORT) | Where-Object { $_ }
  $clash = @()
  $rows = @(& docker ps --format '{{.Names}}|{{.Ports}}' 2>$null)
  foreach ($row in $rows) {
    $text = "$row"
    if (-not $text.Contains('|')) { continue }
    $parts = $text.Split('|', 2)
    if ($parts[0].StartsWith("$project-")) { continue }
    foreach ($p in $wanted) { if ($parts[1] -match "0\.0\.0\.0:$p->") { $clash += "$($parts[0]) already publishes host port $p" } }
  }
  if ($clash.Count) { Die ("A running stack already holds this checkout's ports:`n  " + ($clash -join "`n  ") + "`nGive the dev stack its own port block in the repository .env instead of sharing.") }
}
function Repair-NetworklessContainers {
  # A container started while the Docker daemon was starved of memory comes up
  # "running" with no network attachment at all, and then reports the failure as
  # `getaddrinfo ENOTFOUND postgres` - indistinguishable from an upstream outage.
  # `docker network connect` gives it an address but not its service alias, so
  # the only repair is a recreate.
  $project = Get-ComposeProject
  $broken = @()
  $rows = @(& docker ps --format '{{.Names}}' 2>$null)
  foreach ($name in $rows) {
    $text = "$name"
    if (-not $text.StartsWith("$project-")) { continue }
    $count = "$(@(& docker inspect -f '{{len .NetworkSettings.Networks}}' $text 2>$null))"
    if ($count -eq '0') {
      $service = "$(@(& docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' $text 2>$null))"
      if ($service) { $broken += $service }
    }
  }
  if (-not $broken.Count) { return }
  Warn "Recreating containers that came up without a network: $($broken -join ', ')"
  Compose (@('--profile','local','--profile','remote','up','-d','--force-recreate') + $broken)
}
function Get-PostgresVersionMarker {
  # Compose resolves a relative D_PREDICT_DATA_DIR against this checkout, so the
  # marker has to be resolved the same way before Postgres claims the volume.
  $dataDir = "$($env:D_PREDICT_DATA_DIR)".Trim().Trim('"')
  if (-not $dataDir) { return $null }
  if ($dataDir -match '^[A-Za-z]:' -or $dataDir.StartsWith('\\') -or $dataDir.StartsWith('/')) { return (Join-Path ($dataDir -replace '/', '\') 'postgres\PG_VERSION') }
  return (Join-Path (Join-Path $Root ($dataDir -replace '/', '\')) 'postgres\PG_VERSION')
}
function Invoke-Setup { & powershell -NoProfile -ExecutionPolicy Bypass -File $DatabaseSetup }
function Probe-PostgresQuery([string]$Sql) {
  $previousErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $null = & docker compose -f $ComposeFile --profile local exec -T postgres psql -q -v ON_ERROR_STOP=1 -U postgres -d nifty -Atc $Sql 2>$null
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
}
function Test-PostgresAccepting {
  for ($i = 0; $i -lt 90; $i++) {
    $code = Probe-PostgresQuery 'select 1'
    if ($code -eq 0) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Test-PostgresInitialised {
  # pg_isready is not a safe gate on a first run: while a brand-new cluster is
  # still applying its docker-entrypoint-initdb.d migrations the temporary server
  # already answers "accepting connections" while the database and its tables do
  # not exist yet. Waiting on a table from the LAST mounted migration proves
  # initialisation finished and surfaces an init that aborted halfway - the image
  # never re-runs those scripts over an existing data directory, so a silent
  # failure ships as a "healthy" database missing its newest tables. Nothing else
  # can create it this early: the API that self-heals schema has not started yet.
  # Only valid for a cluster created on this very start - see Invoke-Start.
  for ($i = 0; $i -lt 120; $i++) {
    if ((Probe-PostgresQuery 'select 1 from ai_settings limit 1') -eq 0) { return $true }
    Start-Sleep -Seconds 1
  }
  return $false
}
function Invoke-Start {
  Ensure-DatabaseConfig
  Assert-DevIsolation
  Ensure-Tooling
  Ensure-DockerReady
  Ensure-ComposeFile
  $profile = if ($env:DATABASE_MODE -eq 'local_postgres') { 'local' } else { 'remote' }
  $env:COMPOSE_DATABASE_URL = if ($profile -eq 'local') { 'postgresql://postgres:localdev@postgres:5432/nifty' } else { $env:DATABASE_URL }
  if ($profile -eq 'local') { Info "Starting local PostgreSQL at $($env:D_PREDICT_DATA_DIR)" } else { Info "Using user-owned $($env:DATABASE_MODE) database" }
  if ($profile -eq 'local') {
    # Whether the cluster is created on this start decides what "ready" means: a
    # new one must prove every mounted migration applied, an existing one only has
    # to answer - Postgres deliberately skips the init scripts over a populated
    # data directory, and the API self-heals schema gaps at boot. Requiring the
    # newest table from an existing cluster would refuse to start an app that is
    # mid-upgrade and about to create that table itself.
    $freshCluster = -not (Test-Path (Get-PostgresVersionMarker))
    Info 'Starting PostgreSQL...'
    Compose @('--profile','local','up','-d','postgres')
    if ($freshCluster) {
      Info 'Initialising a new cluster from the mounted migrations...'
      if (-not (Test-PostgresInitialised)) { Die 'PostgreSQL initialisation did not complete: a migration mounted into the data directory failed, and Postgres never re-runs init scripts over a half-built cluster. Check the postgres container logs for the psql error, fix the migration, then remove this data directory and start again.' }
    } elseif (-not (Test-PostgresAccepting)) {
      Die 'PostgreSQL did not become ready. Check docker compose logs postgres --tail=100.'
    }
    Info 'Applying local database migrations...'
    Compose @('--profile','local','exec','-T','postgres','psql','-U','postgres','-d','nifty','-f','/docker-entrypoint-initdb.d/010-dpredict-20.sql')
    Compose @('--profile','local','up','-d','--build','api','research','ml','collector','engine')
  } else {
    Compose @('--profile',$profile,'up','-d','--build')
  }
  Ensure-RunDir
  Repair-NetworklessContainers
  # Running start twice used to stack a second Vite on the next free port while
  # only the newest pid was tracked, leaving the first orphaned and holding the
  # configured port. Reuse the live dashboard when it still answers.
  $trackedPid = Get-LiveDashboardPid
  if ($trackedPid -and (Test-PortAnswering $env:PORT)) {
    Info "Reusing the dashboard already running as PID $trackedPid"
  } else {
    Info 'Starting dashboard...'
    Start-Detached 'ui' 'npm --prefix dashboard run dev'
  }
  $dashboardUrl = Find-DashboardUrl
  if ($dashboardUrl) {
    Set-Content -Path (Join-Path $Run 'dashboard.url') -Value $dashboardUrl
    Info "Local dashboard: $dashboardUrl"
  } else {
    Warn 'Dashboard process started but no HTTP port responded within 45 seconds. Check the UI log/process.'
  }
  Info "Local API:       http://127.0.0.1:$(PortOf $env:API_PORT 4100)/health"
  Info "Research API:    http://127.0.0.1:$(PortOf $env:RESEARCH_PORT 4200)/health"
  Info "ML inference:    http://127.0.0.1:$(PortOf $env:ML_PORT 4300)/health"
}
function Invoke-Stop {
  foreach ($name in @('ui')) {
    $pidFile = Join-Path $Run "$name.pid"
    if (Test-Path $pidFile) {
      try {
        $processId = [int](Get-Content $pidFile | Select-Object -First 1)
        # Stop-Process takes out only the wrapper: Vite and its node children
        # survive it and keep holding the port, so the whole tree has to go.
        & taskkill /PID $processId /T /F 2>&1 | Out-Null
      } catch {}
      Remove-Item $pidFile -Force -ErrorAction SilentlyContinue
    }
  }
  if (Get-Command docker -ErrorAction SilentlyContinue) { Invoke-Compose @('--profile','local','--profile','remote','stop') }
}
function Invoke-Status {
  Ensure-DatabaseConfig
  if (Get-Command docker -ErrorAction SilentlyContinue) { Invoke-Compose @('--profile','local','--profile','remote','ps') }
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
function Invoke-Train {
  $python = Join-Path $Root 'collector\.venv\Scripts\python.exe'
  if (-not (Test-Path $python)) { Die 'Collector Python environment is missing. Run Repair & Check.' }
  & $python -m training.run_full_validation
  exit $LASTEXITCODE
}

$Command = if ($args.Count) { $args[0].ToLowerInvariant() } else { 'help' }
if ($Command -eq 'setup-db' -or $Command -eq 'database') { Invoke-Setup; exit $LASTEXITCODE }
Ensure-DatabaseConfig
Ensure-ProjectEnvFile
switch ($Command) {
  'start' { Invoke-Start }
  'stop' { Invoke-Stop }
  'restart' { Invoke-Stop; Invoke-Start }
  'status' { Invoke-Status }
  'doctor' { Invoke-Doctor }
  'test' { Invoke-Test }
  'train' { Invoke-Train }
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
