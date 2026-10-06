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

function Add-WinForms {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
}

function Show-ChoiceDialog([object]$Existing) {
  Add-WinForms
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'D-Predict Database Configuration'
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(520, 230)
  $title = New-Object System.Windows.Forms.Label
  $title.Text = 'How should D-Predict store its database?'
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 11, [System.Drawing.FontStyle]::Bold)
  $title.Location = New-Object System.Drawing.Point(20, 18)
  $title.AutoSize = $true
  $description = New-Object System.Windows.Forms.Label
  $description.Text = 'Choose where D-Predict will store or access its PostgreSQL database.'
  $description.Location = New-Object System.Drawing.Point(20, 52)
  $description.Size = New-Object System.Drawing.Size(470, 36)
  $combo = New-Object System.Windows.Forms.ComboBox
  $combo.DropDownStyle = [System.Windows.Forms.ComboBoxStyle]::DropDownList
  [void]$combo.Items.Add('Local PostgreSQL - database stored on a drive you choose')
  [void]$combo.Items.Add('Supabase Cloud - connect to your Supabase project')
  [void]$combo.Items.Add('Self-hosted Supabase - connect to your own instance')
  $combo.Location = New-Object System.Drawing.Point(20, 95)
  $combo.Size = New-Object System.Drawing.Size(470, 28)
  if ($Existing -and $Existing.mode) {
    switch ($Existing.mode) {
      'supabase_cloud' { $combo.SelectedIndex = 1 }
      'supabase_self_hosted' { $combo.SelectedIndex = 2 }
      default { $combo.SelectedIndex = 0 }
    }
  } else { $combo.SelectedIndex = 0 }
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'Continue'
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(304, 165)
  $ok.Size = New-Object System.Drawing.Size(90, 30)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancel'
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(400, 165)
  $cancel.Size = New-Object System.Drawing.Size(90, 30)
  $form.Controls.AddRange(@($title,$description,$combo,$ok,$cancel))
  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { throw 'USER_CANCELLED' }
  switch ($combo.SelectedIndex) {
    1 { return 'supabase_cloud' }
    2 { return 'supabase_self_hosted' }
    default { return 'local_postgres' }
  }
}

function Select-DataFolder([string]$InitialPath) {
  Add-WinForms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Choose the folder where D-Predict will store its local PostgreSQL data.'
  $dialog.ShowNewFolderButton = $true
  if ($InitialPath -and (Test-Path $InitialPath)) { $dialog.SelectedPath = $InitialPath }
  $result = $dialog.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK -or [string]::IsNullOrWhiteSpace($dialog.SelectedPath)) {
    throw 'USER_CANCELLED'
  }
  return [IO.Path]::GetFullPath($dialog.SelectedPath)
}

function Read-TextDialog([string]$Title, [string]$Prompt, [string]$DefaultValue, [switch]$Password) {
  Add-WinForms
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $Title
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ClientSize = New-Object System.Drawing.Size(620, 180)
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Prompt
  $label.Location = New-Object System.Drawing.Point(20, 18)
  $label.Size = New-Object System.Drawing.Size(575, 42)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Text = if ($null -eq $DefaultValue) { '' } else { $DefaultValue }
  $box.Location = New-Object System.Drawing.Point(20, 65)
  $box.Size = New-Object System.Drawing.Size(575, 25)
  if ($Password) { $box.UseSystemPasswordChar = $true }
  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = 'OK'
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Location = New-Object System.Drawing.Point(410, 115)
  $ok.Size = New-Object System.Drawing.Size(85, 30)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = 'Cancel'
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $cancel.Location = New-Object System.Drawing.Point(510, 115)
  $cancel.Size = New-Object System.Drawing.Size(85, 30)
  $form.Controls.AddRange(@($label,$box,$ok,$cancel))
  $form.AcceptButton = $ok
  $form.CancelButton = $cancel
  $form.Add_Shown({ $box.SelectAll(); $box.Focus() })
  $result = $form.ShowDialog()
  if ($result -ne [System.Windows.Forms.DialogResult]::OK) { throw 'USER_CANCELLED' }
  return $box.Text.Trim()
}

$existing = Read-State

try {
  if ($existing -and -not $NonInteractive) {
    Add-WinForms
    $message = "D-Predict already has a database configuration. Mode: $($existing.mode)"
    if ($existing.mode -eq 'local_postgres') { $message += " Data root: $($existing.dataRoot)" }
    $message += " Keep this configuration?"
    $keep = [System.Windows.Forms.MessageBox]::Show($message, 'D-Predict Database Configuration',
      [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Question)
    if ($keep -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 }
  }
  if ($NonInteractive) {
    $mode = if ($existing) { $existing.mode } else { 'local_postgres' }
  } else {
    $mode = Show-ChoiceDialog $existing
  }

$common = @{
  DATABASE_MODE = $mode
  POSTGRES_PASSWORD = 'localdev'
  NIFTY_DB_PORT = '5433'
  POSTGRES_PORT = '5433'
  API_PORT = '4100'
  RESEARCH_PORT = '4200'
  ML_PORT = '4300'
  ML_INFERENCE_URL = 'http://ml:4300'
  ML_INFERENCE_TIMEOUT_MS = '15000'
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
  MODEL_VERSION = 'validated-python-ml-v1'
  NVIDIA_API_KEY = ''
  NVIDIA_API_BASE_URL = 'https://integrate.api.nvidia.com/v1'
  NVIDIA_MODEL = ''
  AI_TIMEOUT_MS = '90000'
}

if ($mode -eq 'local_postgres') {
  if ($NonInteractive) {
    $dataRoot = if ($existing -and $existing.dataRoot) { $existing.dataRoot } else { Join-Path $env:USERPROFILE 'D-PredictData' }
  } else {
    $default = if ($existing -and $existing.dataRoot) { $existing.dataRoot } else { Join-Path $env:USERPROFILE 'D-PredictData' }
    $dataRoot = Select-DataFolder $default
  }
  if ([string]::IsNullOrWhiteSpace($dataRoot)) { throw 'A local PostgreSQL data folder is required.' }
  $dataRoot = [IO.Path]::GetFullPath($dataRoot)
  New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null
  $common.D_PREDICT_DATA_DIR = $dataRoot.Replace('\','/')
  $common.DATABASE_URL = 'postgresql://postgres:localdev@localhost:5433/nifty'
  $common.COMPOSE_DATABASE_URL = 'postgresql://postgres:localdev@postgres:5432/nifty'
  $state = @{ mode=$mode; dataRoot=$dataRoot; configuredAt=(Get-Date).ToString('o') }
} else {
  if ($NonInteractive) { throw 'Supabase configuration requires interactive credentials/URL setup.' }
  $url = Read-TextDialog 'D-Predict Database URL' 'PostgreSQL DATABASE_URL for your Supabase project or self-hosted instance:' ''
  if ([string]::IsNullOrWhiteSpace($url)) { throw 'DATABASE_URL is required.' }
  $supabaseUrl = Read-TextDialog 'D-Predict Supabase URL' 'Supabase project URL (optional; leave blank to skip):' ''
  $anon = Read-TextDialog 'D-Predict Supabase Key' 'Supabase anon key (optional; leave blank to skip):' '' -Password
  $common.DATABASE_URL = $url
  $common.COMPOSE_DATABASE_URL = $url
  $common.SUPABASE_URL = $supabaseUrl
  $common.SUPABASE_ANON_KEY = $anon
  $common.SUPABASE_SERVICE_ROLE_KEY = ''
  $state = @{ mode=$mode; configuredAt=(Get-Date).ToString('o'); databaseHost=$url }
}

Write-Env $common
Save-State $state
Write-Host "Database configuration saved." -ForegroundColor Green
Write-Host "Mode: $mode"
if ($mode -eq 'local_postgres') { Write-Host "Data root: $dataRoot" }
Write-Host "Configuration: $StateFile"
exit 0
}
catch {
  if ($_.Exception.Message -eq 'USER_CANCELLED') {
    Write-Host 'Database configuration cancelled by the user.' -ForegroundColor Yellow
    exit 2
  }
  Write-Host "Database configuration failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
