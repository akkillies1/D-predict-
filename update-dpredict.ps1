param(
  [ValidateSet('Check', 'Apply')]
  [string]$Action = 'Check',
  [switch]$NoWindow,
  # The dpredict-update: handler appends the invoked URL as a trailing argument.
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest
)

# Host-side updater for an installed D-Predict. The api container has no access
# to the host filesystem or process table, so it can only report that a newer
# release exists; this script is the piece that can actually fetch and run it.
#
# It never installs silently on its own: -Apply still requires the user to have
# clicked Update in the dashboard, which reaches here through the registered
# dpredict-update: protocol handler. The downloaded installer is checked against
# the SHA-256 digest GitHub publishes for the asset before it is allowed to run.

$ErrorActionPreference = 'Stop'
$ReleaseApi = 'https://api.github.com/repos/akkillies1/D-predict-/releases/latest'
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$VersionFile = Join-Path $StateRoot 'version.txt'
$InstallRootFile = Join-Path $StateRoot 'install-root.txt'
$UpdateDir = Join-Path $StateRoot 'updates'
$StatusFile = Join-Path $StateRoot 'update-status.json'
$LogDir = Join-Path $StateRoot 'logs'
$LogFile = Join-Path $LogDir 'updater.log'
$script:Window = $null

function Log([string]$Message) {
  if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Force -Path $LogDir | Out-Null }
  "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message" | Add-Content -Path $LogFile -Encoding UTF8
  if ($script:Window) {
    $box = $script:Window.Controls[1]
    $box.Text = $box.Text + $Message + [Environment]::NewLine
    $box.SelectionStart = $box.Text.Length
    $box.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
  }
}

function Read-CurrentVersion {
  if (-not (Test-Path $VersionFile)) { return $null }
  $raw = (Get-Content $VersionFile -TotalCount 1).Trim()
  if ($raw -match '^[vV]?(\d+)\.(\d+)\.(\d+)$') { return $raw -replace '^[vV]', '' }
  return $null
}

function Compare-Version([string]$Left, [string]$Right) {
  $a = @($Left -split '\.')
  $b = @($Right -split '\.')
  for ($i = 0; $i -lt 3; $i++) {
    $x = [int]$a[$i]
    $y = [int]$b[$i]
    if ($x -ne $y) { return $x - $y }
  }
  return 0
}

function Get-LatestRelease {
  [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  $request = [Net.HttpWebRequest]::Create($ReleaseApi)
  $request.UserAgent = 'D-Predict-local-updater'
  $request.Accept = 'application/vnd.github+json'
  $request.Timeout = 15000
  $response = $request.GetResponse()
  try {
    $stream = $response.GetResponseStream()
    $reader = New-Object System.IO.StreamReader $stream
    $text = $reader.ReadToEnd()
    $reader.Dispose()
  } finally {
    $response.Dispose()
  }
  $payload = $text | ConvertFrom-Json
  $tag = "$($payload.tag_name)" -replace '^[vV]', ''
  # A prerelease or oddly tagged release is not something this script can order
  # against the installed version, so report the check as failed rather than
  # guessing that it is newer.
  if ($tag -notmatch '^\d+\.\d+\.\d+$') { throw "The latest release tag '$($payload.tag_name)' is not a stable version." }
  $asset = $null
  foreach ($candidate in @($payload.assets)) {
    if ("$($candidate.name)" -match '^D-Predict-Setup-v\d+\.\d+\.\d+\.exe$') { $asset = $candidate; break }
  }
  if (-not $asset) {
    foreach ($candidate in @($payload.assets)) {
      if ("$($candidate.name)" -match '\.exe$') { $asset = $candidate; break }
    }
  }
  $digest = $null
  if ($asset -and $asset.digest) { $digest = ("$($asset.digest)" -replace '^sha256:', '').ToLowerInvariant() }
  return [pscustomobject]@{
    Version     = $tag
    Url         = "$($asset.browser_download_url)"
    Name        = "$($asset.name)"
    Size        = [int64]$asset.size
    Sha256      = $digest
    ReleaseUrl  = "$($payload.html_url)"
    PublishedAt = "$($payload.published_at)"
  }
}

function Show-StatusWindow {
  if ($NoWindow) { return }
  if (-not [Environment]::UserInteractive) { return }
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'D-Predict update'
  $form.Size = New-Object System.Drawing.Size 560, 300
  $form.StartPosition = 'CenterScreen'
  $form.TopMost = $true
  $title = New-Object System.Windows.Forms.Label
  $title.Text = "Checking for updates..."
  $title.SetBounds(14, 12, 520, 22)
  $title.Font = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
  $box = New-Object System.Windows.Forms.TextBox
  $box.Multiline = $true
  $box.ReadOnly = $true
  $box.ScrollBars = 'Vertical'
  $box.SetBounds(14, 40, 520, 170)
  $box.BackColor = [System.Drawing.Color]::FromArgb(12, 20, 30)
  $box.ForeColor = [System.Drawing.Color]::FromArgb(220, 235, 245)
  $close = New-Object System.Windows.Forms.Button
  $close.Text = 'Close'
  $close.SetBounds(449, 218, 85, 26)
  $close.Add_Click({ $form.Close() })
  $form.Controls.Add($title)
  $form.Controls.Add($box)
  $form.Controls.Add($close)
  $script:Window = $form
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
}

function Set-StatusTitle([string]$Text) {
  if (-not $script:Window) { return }
  $script:Window.Controls[0].Text = $Text
  [System.Windows.Forms.Application]::DoEvents()
}

function Write-StatusFile($Data) {
  if (-not (Test-Path $StateRoot)) { New-Item -ItemType Directory -Force -Path $StateRoot | Out-Null }
  $Data | ConvertTo-Json -Depth 5 | Set-Content -Path $StatusFile -Encoding UTF8
}

try {
  Show-StatusWindow
  $current = Read-CurrentVersion
  if (-not $current) {
    Log 'No version.txt found; this install does not record its own version.'
    Write-StatusFile ([ordered]@{ state = 'UNKNOWN_VERSION'; checkedAt = (Get-Date).ToString('o'); current = $null; latest = $null })
    Set-StatusTitle 'This installation cannot determine its own version.'
    Log 'Re-run "D-Predict Setup & Repair" once to stamp the installed version.'
    exit 4
  }
  Log "Checking for updates. Installed version is $current."
  $latest = Get-LatestRelease
  $ahead = Compare-Version $latest.Version $current
  $updateAvailable = $ahead -gt 0
  Log ("Latest published release is v{0}{1}." -f $latest.Version, $(if ($updateAvailable) { ' - an update is available' } else { ' - already up to date' }))

  if ($Action -eq 'Check') {
    Write-StatusFile ([ordered]@{
        state           = $(if ($updateAvailable) { 'UPDATE_AVAILABLE' } else { 'CURRENT' })
        checkedAt       = (Get-Date).ToString('o')
        current         = $current
        latest          = $latest.Version
        updateAvailable = $updateAvailable
        asset           = $latest.Name
        sizeBytes       = $latest.Size
        sha256          = $latest.Sha256
        releaseUrl      = $latest.ReleaseUrl
      })
    Set-StatusTitle $(if ($updateAvailable) { "Update v$($latest.Version) is available." } else { 'D-Predict is up to date.' })
    exit 0
  }

  if (-not $updateAvailable) {
    Set-StatusTitle "You are already on the newest release (v$current)."
    exit 0
  }
  if (-not $latest.Sha256) {
    Log 'Refusing to run an installer whose published digest is missing.'
    Set-StatusTitle 'The published release has no checksum to verify against, so nothing was installed.'
    Log "Open $($latest.ReleaseUrl) to download it manually."
    exit 5
  }

  if (-not (Test-Path $UpdateDir)) { New-Item -ItemType Directory -Force -Path $UpdateDir | Out-Null }
  foreach ($stale in @(Get-ChildItem $UpdateDir -Filter '*.exe' -ErrorAction SilentlyContinue)) {
    if ($stale.Name -ne $latest.Name) {
      try { Remove-Item $stale.FullName -Force -ErrorAction Stop } catch { Log "Could not remove $($_.Exception.Message)" }
    }
  }
  $target = Join-Path $UpdateDir $latest.Name
  $reuse = $false
  if (Test-Path $target) {
    $existing = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($existing -eq $latest.Sha256) { $reuse = $true } else { Remove-Item $target -Force }
  }
  if ($reuse) {
    Log "Reusing the verified installer already cached at $target."
  } else {
    Set-StatusTitle "Downloading v$($latest.Version)..."
    Log "Downloading $($latest.Url)"
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $latest.Url -OutFile $target -UseBasicParsing -TimeoutSec 600
  }
  $actual = (Get-FileHash $target -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -ne $latest.Sha256) {
    Remove-Item $target -Force
    Log "Digest mismatch: expected $($latest.Sha256), got $actual."
    Set-StatusTitle 'The download did not match the published checksum, so it was deleted and nothing was installed.'
    exit 3
  }
  Log "Digest verified ($actual)."
  Write-StatusFile ([ordered]@{
      state           = 'READY_TO_INSTALL'
      checkedAt       = (Get-Date).ToString('o')
      current         = $current
      latest          = $latest.Version
      updateAvailable = $true
      asset           = $latest.Name
      path            = $target
      sizeBytes       = $latest.Size
      sha256          = $actual
      releaseUrl      = $latest.ReleaseUrl
    })

  $installDir = $null
  if (Test-Path $InstallRootFile) { $installDir = (Get-Content $InstallRootFile -TotalCount 1).Trim() }
  Set-StatusTitle "Launching the v$($latest.Version) installer..."
  Log "Starting installer from $target (install dir: $installDir)."
  # The setup keeps its own branded wizard; it re-runs the provisioning chain,
  # which is what actually moves the installed source forward.
  Start-Process -FilePath $target -ArgumentList @('/SILENT') -WorkingDirectory $UpdateDir
  Log 'Installer launched. Relaunch D-Predict once it finishes to run the new version.'
  exit 0
} catch {
  $message = $_.Exception.Message
  Log "ERROR: $message"
  Write-StatusFile ([ordered]@{ state = 'CHECK_FAILED'; checkedAt = (Get-Date).ToString('o'); current = $current; error = $message })
  Set-StatusTitle 'The update check failed.'
  Log 'See the updater log for details.'
  exit 1
} finally {
  if ($script:Window) {
    $script:Window.Controls[2].Enabled = $true
    [System.Windows.Forms.Application]::Run($script:Window)
  }
}
