param([switch]$NonInteractive)
$ErrorActionPreference = 'Stop'
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$StateFile = Join-Path $StateRoot 'database.json'
$EnvFile = Join-Path $StateRoot '.env'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ComposeEnvFile = Join-Path $Root '.env'
New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null

function Write-Env([hashtable]$Values) {
  $lines = foreach ($item in $Values.GetEnumerator()) { '{0}={1}' -f $item.Key, $item.Value }
  $lines | Set-Content -Path $EnvFile -Encoding UTF8
  $lines | Set-Content -Path $ComposeEnvFile -Encoding UTF8
}
function Save-State([hashtable]$State) {
  $State | ConvertTo-Json -Depth 5 | Set-Content -Path $StateFile -Encoding UTF8
}
function Read-State {
  if (Test-Path $StateFile) { return (Get-Content $StateFile -Raw | ConvertFrom-Json) }
  return $null
}

$existing = Read-State
if ($existing -and -not $NonInteractive) {
  Write-Host "`nD-Predict database configuration" -ForegroundColor Cyan
  Write-Host "Current mode: $($existing.mode)"
  if ($existing.mode -eq 'local_postgres') { Write-Host "Data root:    $($existing.dataRoot)" }
  $answer = Read-Host 'Keep this configuration? [Y/n]'
  if ($answer -notmatch '^[Nn]') { exit 0 }
}

if ($NonInteractive) {
  $mode = if ($existing) { $existing.mode } else { 'local_postgres' }
} else {
  Write-Host "`nHow should D-Predict store its database?" -ForegroundColor Cyan
  Write-Host '  1. Local PostgreSQL - database stored on a drive you choose'
  Write-Host '  2. Supabase Cloud - connect to your own Supabase project'
  Write-Host '  3. Self-hosted Supabase - connect to your own instance'
  $choice = Read-Host 'Choose [1-3]'
  $mode = switch ($choice) { '2' { 'supabase_cloud'; break } '3' { 'supabase_self_hosted'; break } default { 'local_postgres' } }
}

$common = @{
  DATABASE_MODE = $mode
  POSTGRES_PASSWORD = 'localdev'
  NIFTY_DB_PORT = '5433'
  POSTGRES_PORT = '5433'
  API_PORT = '4100'
  RESEARCH_PORT = '4200'
  PORT = '3000'
  CORS_ORIGIN = 'http://127.0.0.1:3000,http://localhost:3000'
  VITE_API_BASE_URL = 'http://127.0.0.1:4100'
  VITE_RESEARCH_BASE_URL = 'http://127.0.0.1:4200'
  OPTION_CHAIN_POLL_SECONDS = '15'
  PRICE_BAR_POLL_SECONDS = '15'
  ENGINE_POLL_SECONDS = '60'
  COLLECTOR_INSTRUMENTS = 'NIFTY,BANKNIFTY'
  RESEARCH_NEWS_ENABLED = 'true'
  RESEARCH_CACHE_SECONDS = '60'
  GDELT_TIMESPAN = '3d'
  RESEARCH_MAX_ARTICLES = '30'
  EMBEDDING_MODEL = 'all-MiniLM-L6-v2'
  FEATURE_SET_VERSION = 'v1'
  STRATEGY_VERSION = 'v1'
  MODEL_VERSION = 'phase1-rule-engine-v1'
  AI_MODE = 'disabled'
  AI_PROVIDER = ''
  AI_BASE_URL = ''
  AI_API_KEY = ''
  AI_MODEL = ''
}

if ($mode -eq 'local_postgres') {
  if ($NonInteractive) {
    $dataRoot = if ($existing -and $existing.dataRoot) { $existing.dataRoot } else { Join-Path $env:USERPROFILE 'D-PredictData' }
  } else {
    $default = if ($existing -and $existing.dataRoot) { $existing.dataRoot } else { 'D:\D-PredictData' }
    $dataRoot = Read-Host "Data folder [$default]"
    if (-not $dataRoot) { $dataRoot = $default }
  }
  $dataRoot = [IO.Path]::GetFullPath($dataRoot)
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  $common.D_PREDICT_DATA_DIR = $dataRoot.Replace('\','/')
  $common.DATABASE_URL = 'postgresql://postgres:localdev@localhost:5433/nifty'
  $common.COMPOSE_DATABASE_URL = 'postgresql://postgres:localdev@postgres:5432/nifty'
  $state = @{ mode=$mode; dataRoot=$dataRoot; configuredAt=(Get-Date).ToString('o') }
} else {
  if ($NonInteractive) { throw 'Supabase configuration requires interactive credentials/URL setup.' }
  $url = Read-Host 'PostgreSQL DATABASE_URL for your Supabase project/instance'
  if (-not $url) { throw 'DATABASE_URL is required.' }
  $common.DATABASE_URL = $url
  $common.COMPOSE_DATABASE_URL = $url
  $supabaseUrl = Read-Host 'Supabase project URL (optional; press Enter to skip)'
  $anon = Read-Host 'Supabase anon key (optional; press Enter to skip)'
  $common.SUPABASE_URL = $supabaseUrl
  $common.SUPABASE_ANON_KEY = $anon
  $common.SUPABASE_SERVICE_ROLE_KEY = ''
  $state = @{ mode=$mode; configuredAt=(Get-Date).ToString('o'); databaseHost=$url }
}

Write-Env $common
Save-State $state
Write-Host "`nDatabase configuration saved." -ForegroundColor Green
Write-Host "Mode: $mode"
if ($mode -eq 'local_postgres') { Write-Host "Data root: $dataRoot" }
Write-Host "Configuration: $StateFile"
