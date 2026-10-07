param(
  [switch]$Headless,
  [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$StateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$LogDir = Join-Path $StateRoot 'logs'
$LogFile = Join-Path $LogDir 'launcher.log'
$BootstrapLog = Join-Path $LogDir 'bootstrap.log'
$CompleteMarker = Join-Path $StateRoot '.install-complete'
$ConfigFile = Join-Path $StateRoot '.env'
$DashboardUrlFile = Join-Path $Root '.run\dashboard.url'
$script:StartedAt = Get-Date
Set-Location $Root
New-Item -ItemType Directory -Force $LogDir | Out-Null

function Read-DotEnv([string]$Path) {
  $values = @{}
  if (-not (Test-Path $Path)) { return $values }
  foreach ($line in (Get-Content $Path)) {
    $text = "$line".Trim()
    if (-not $text -or $text.StartsWith('#') -or -not $text.Contains('=')) { continue }
    $parts = $text.Split('=', 2)
    $values[$parts[0].Trim()] = $parts[1].Trim()
  }
  return $values
}
$script:ProjectEnvValues = Read-DotEnv (Join-Path $Root '.env')
$script:StateEnvValues = Read-DotEnv $ConfigFile
function ConfigValue([string]$Key, [string]$Fallback) {
  # A source checkout pins its own host ports in the Git-ignored project .env so
  # it can run beside the installed app; those values must win here or the splash
  # window polls a port the dev stack never binds. An install keeps identical
  # values in both files, so precedence changes nothing for it.
  if ($script:ProjectEnvValues.ContainsKey($Key)) { return $script:ProjectEnvValues[$Key] }
  if ($script:StateEnvValues.ContainsKey($Key)) { return $script:StateEnvValues[$Key] }
  return $Fallback
}
$ApiPort = ConfigValue 'API_PORT' '4100'
$PreferredDashboardPort = ConfigValue 'PORT' '3000'
$PortRange = @([int]$PreferredDashboardPort) + (3000..3019)

function Test-SplashSupported {
  if ($Headless) { return $false }
  # A service session has no desktop to draw on; WinForms would throw on Show.
  if (-not [Environment]::UserInteractive) { return $false }
  try {
    Add-Type -AssemblyName System.Windows.Forms | Out-Null
    Add-Type -AssemblyName System.Drawing | Out-Null
    return $true
  } catch {
    return $false
  }
}

$script:UseSplash = Test-SplashSupported

function Log([string]$Message) {
  $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
  Add-Content -Path $LogFile -Value $line
  if (-not $script:UseSplash) { Write-Host $line }
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
      $fileName = [IO.Path]::GetFileName($exe).ToLowerInvariant()
      if ($fileName -eq 'msedge.exe' -or $fileName -eq 'chrome.exe') {
        Start-Process -FilePath $exe -ArgumentList @('--app', "`"$Url`"") -ErrorAction Stop
        Log "Opened $Url as a standalone D-Predict app window using $fileName."
      } else {
        Start-Process -FilePath $exe -ArgumentList @('--new-window', "`"$Url`"") -ErrorAction Stop
        Log "Opened $Url in a new $fileName window."
      }
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

function Resolve-DashboardUrl([string[]]$CapturedLines) {
  # dp.ps1 prints and stores the URL once a port answers, so trust this run's own
  # output first, then a url file written after launch, then a live probe.
  foreach ($line in $CapturedLines) {
    if ($line -match 'Local dashboard:\s*(http://127\.0\.0\.1:\d+/?)') { return $Matches[1] }
  }
  if (Test-Path $DashboardUrlFile) {
    if ((Get-Item $DashboardUrlFile).LastWriteTime -ge $script:StartedAt) {
      $stored = (Get-Content $DashboardUrlFile -First 1).Trim()
      if ($stored -match '^http://127\.0\.0\.1:\d+') { return $stored }
    }
  }
  foreach ($port in $PortRange) {
    try {
      $response = Invoke-WebRequest -Uri "http://127.0.0.1:$port/" -UseBasicParsing -TimeoutSec 1
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { return "http://127.0.0.1:$port/" }
    } catch { }
  }
  return $null
}

function Get-MarketReadiness {
  try {
    $runtime = Invoke-RestMethod -Uri "http://127.0.0.1:$ApiPort/ready" -TimeoutSec 3
    if ($runtime.ok -eq $true) { return "Market data ready: $($runtime.dailyBars) daily bars; latest $($runtime.latestMarketTimestamp)." }
    return "Services are running; market data is still being acquired ($($runtime.marketData))."
  } catch {
    return 'Market readiness endpoint is not answering yet; the dashboard still works.'
  }
}

function New-BrandBitmap([int]$Size) {
  # Purely cosmetic: return $null instead of throwing so a GDI+ failure on an
  # unusual desktop cannot stop the splash window from appearing.
  try {
    $bmp = New-Object System.Drawing.Bitmap $Size, $Size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.Clear([System.Drawing.Color]::Transparent)
    $pad = [Math]::Max(1, [int]($Size * 0.04))
    $rect = New-Object System.Drawing.Rectangle $pad, $pad, ($Size - 2 * $pad), ($Size - 2 * $pad)
    $arc = [Math]::Max(4, [int]($Size * 0.36))
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $path.AddArc($rect.X, $rect.Y, $arc, $arc, 180, 90)
    $path.AddArc(($rect.Right - $arc), $rect.Y, $arc, $arc, 270, 90)
    $path.AddArc(($rect.Right - $arc), ($rect.Bottom - $arc), $arc, $arc, 0, 90)
    $path.AddArc($rect.X, ($rect.Bottom - $arc), $arc, $arc, 90, 90)
    $path.CloseFigure()
    $fill = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
      [System.Drawing.Color]::FromArgb(200, 241, 105),
      [System.Drawing.Color]::FromArgb(113, 180, 145), 45)
    $g.FillPath($fill, $path)
    # Three rising candlesticks in the ink colour of the terminal background.
    $ink = [System.Drawing.Color]::FromArgb(8, 18, 15)
    $wick = New-Object System.Drawing.Pen $ink, ([Math]::Max(1.0, $Size * 0.045))
    $body = New-Object System.Drawing.SolidBrush $ink
    $bodyWidth = [Math]::Max(2.0, $Size * 0.13)
    for ($i = 0; $i -lt 3; $i++) {
      $cx = [int]($Size * (0.31 + $i * 0.19))
      $top = [int]($Size * (0.30 - $i * 0.04))
      $bottom = [int]($Size * (0.72 - $i * 0.06))
      $g.DrawLine($wick, $cx, $top, $cx, $bottom)
      $bodyTop = [int]($Size * (0.42 - $i * 0.05))
      $bodyBottom = [int]($Size * (0.63 - $i * 0.04))
      $g.FillRectangle($body, ($cx - $bodyWidth / 2), $bodyTop, $bodyWidth, [Math]::Max(2, ($bodyBottom - $bodyTop)))
    }
    $g.Dispose()
    return $bmp
  } catch {
    return $null
  }
}

function Hide-OwnConsoleWindow {
  # The Start Menu shortcut runs powershell.exe, so a black console would sit
  # behind the splash window. Hide it only when this process owns the console by
  # itself; a console shared with the caller's terminal must stay visible.
  try {
    if (-not ('DPredictLaunch.Win32' -as [type])) {
      Add-Type -Namespace DPredictLaunch -Name Win32 -MemberDefinition @'
[DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
[DllImport("kernel32.dll")] public static extern uint GetConsoleProcessList(uint[] processList, uint processListSize);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
'@
    }
    $list = New-Object 'uint[]' 16
    $attached = [DPredictLaunch.Win32]::GetConsoleProcessList($list, [uint32]$list.Length)
    if ($attached -ne 1) { return }
    $hwnd = [DPredictLaunch.Win32]::GetConsoleWindow()
    if ($hwnd -ne [IntPtr]::Zero) { $null = [DPredictLaunch.Win32]::ShowWindow($hwnd, 0) }
  } catch {
    # Cosmetic only: the splash still works with the console left open.
  }
}

function New-SplashFont([string]$Family, [double]$Size, [bool]$Bold) {
  $style = [System.Drawing.FontStyle]::Regular
  if ($Bold) { $style = [System.Drawing.FontStyle]::Bold }
  New-Object System.Drawing.Font $Family, $Size, $style
}

# WinForms event script blocks run in the script scope rather than in the scope
# that registered them, so the window, its controls and its state are kept in
# $script:Splash for every handler to reach.
function Add-SplashLine([string]$Text) {
  if ($null -eq $Text) { return }
  $Text = $Text.TrimEnd()
  if (-not $Text.Length) { return }
  $state = $script:Splash
  $state.Captured += $Text
  if ($state.Captured.Count -gt 400) {
    $state.Captured = @($state.Captured | Select-Object -Skip ($state.Captured.Count - 400))
  }
  $box = $state.Controls.Log
  if ($box.TextLength -gt 24000) { $box.Select(0, 10000); $box.SelectedText = '' }
  $box.AppendText($Text + "`r`n")
  $box.SelectionStart = $box.TextLength
  $box.ScrollToCaret()
  if ($state.Phase -eq 'starting') {
    if ($Text.Length -gt 150) { $state.Controls.Detail.Text = $Text.Substring(0, 150) } else { $state.Controls.Detail.Text = $Text }
  }
  Log "startup output: $Text"
}

function Set-SplashFailure([string]$Message) {
  $state = $script:Splash
  $state.Phase = 'failed'
  $state.Controls.Bar.Visible = $false
  $state.Controls.Status.Text = 'D-Predict could not start'
  $state.Controls.Status.ForeColor = [System.Drawing.Color]::FromArgb(240, 119, 107)
  $state.Controls.Detail.Text = $Message
  $state.Controls.Close.Text = 'Close'
  $state.Timer.Stop()
  Log "ERROR: $Message"
}

function Set-SplashReady([string]$Url) {
  $state = $script:Splash
  $state.Phase = 'ready'
  $state.Url = $Url
  $state.Controls.Bar.Visible = $false
  $state.Controls.Status.Text = 'D-Predict is ready'
  $state.Controls.Status.ForeColor = [System.Drawing.Color]::FromArgb(200, 241, 105)
  $state.Controls.Detail.Text = "Dashboard: $Url"
  $state.Controls.Open.Visible = $true
  $state.Controls.Close.Text = 'Close'
  $state.Timer.Stop()
  Log "Dashboard is ready at $Url."
  Add-SplashLine (Get-MarketReadiness)
  if ($NoBrowser) { return }
  Open-DashboardBrowser $Url
  $state.BrowserOpened = $true
}

function Invoke-SplashTick {
  try {
    $state = $script:Splash
    if ($state.Phase -ne 'starting') { return }
    Read-SplashOutput
    if ($null -ne $state.ExitCode) { Complete-SplashStart; return }
    if (-not $state.Child -or -not $state.Child.HasExited) { return }
    # The child can exit between two ticks, so drain its last lines first.
    Read-SplashOutput
    if ($null -ne $state.ExitCode) { Complete-SplashStart; return }
    Set-SplashFailure 'The launcher process ended without reporting a status. Try D-Predict Setup & Repair.'
  } catch {
    Set-SplashFailure "Startup failed: $($_.Exception.Message)"
  }
}

function Read-SplashOutput {
  # Tails both child streams. The exit marker is consumed instead of displayed.
  $state = $script:Splash
  foreach ($entry in @(@($state.OutFile, 'Reader'), @($state.ErrFile, 'ErrReader'))) {
    $path = $entry[0]
    $key = $entry[1]
    if (-not $state.$key) {
      if (-not (Test-Path $path)) { continue }
      try {
        $stream = [System.IO.File]::Open($path, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
        $state.$key = New-Object System.IO.StreamReader $stream
      } catch { continue }
    }
    while ($true) {
      try {
        $line = $state.$key.ReadLine()
      } catch {
        # The child still owns the file and the OS can deny a read mid-flush;
        # drop the handle and reopen it on the next tick.
        try { $state.$key.Dispose() } catch { }
        $state.$key = $null
        break
      }
      if ($null -eq $line) { break }
      $text = [string]$line
      if ($text -match '^###EXIT:(-?\d+)###$') { $state.ExitCode = [int]$Matches[1]; continue }
      Add-SplashLine $text
    }
  }
}

function Complete-SplashStart {
  $state = $script:Splash
  if ($state.ExitCode -ne 0) {
    $hintText = "See $LogFile"
    if (Test-Path $BootstrapLog) { $hintText = "See $BootstrapLog" }
    Set-SplashFailure "Services failed to start (exit code $($state.ExitCode)). $hintText"
    return
  }
  $url = Resolve-DashboardUrl $state.Captured
  if ($url) { Set-SplashReady $url; return }
  if (-not $state.WaitingSince) { $state.WaitingSince = Get-Date }
  $waited = [int]((Get-Date) - $state.WaitingSince).TotalSeconds
  if ($waited -ge 45) {
    Set-SplashFailure 'The dashboard did not answer on ports 3000-3019 within 45 seconds. Try D-Predict Setup & Repair.'
    return
  }
  $state.Controls.Status.Text = "Waiting for the dashboard ($waited s of 45)"
}

function Start-SplashRunner {
  $state = $script:Splash
  Log 'D-Predict launcher starting (splash window).'
  if (-not (Test-Path $CompleteMarker)) {
    Set-SplashFailure "Installation is incomplete. Run 'D-Predict Setup & Repair' first. See $BootstrapLog"
    return
  }
  # The child runs hidden, and dp.ps1 asks questions when the database config is
  # missing, so refuse the splash path instead of hanging on an invisible prompt.
  if (-not (Test-Path $ConfigFile)) {
    Set-SplashFailure "D-Predict has no database configuration yet. Run 'D-Predict Setup & Repair' to create it."
    return
  }
  try {
    # Start-Process -PassThru cannot read ExitCode once the child is gone, so the
    # child reports its own status as the last line it writes.
    $command = "& '$Root\run.ps1' start; Write-Output ('###EXIT:' + `$LASTEXITCODE + '###')"
    $state.Child = Start-Process -FilePath 'powershell.exe' `
      -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', "`"$command`"") `
      -WorkingDirectory $Root -WindowStyle Hidden -PassThru `
      -RedirectStandardOutput $state.OutFile -RedirectStandardError $state.ErrFile
  } catch {
    Set-SplashFailure "Could not start the launcher process: $($_.Exception.Message)"
  }
}

function Close-SplashResources {
  $state = $script:Splash
  if (-not $state) { return }
  $state.Timer.Stop()
  if ($state.Child -and -not $state.Child.HasExited) {
    try { $state.Child.Kill() } catch { }
    Log 'Launcher window closed while services were still starting.'
  }
  foreach ($key in @('Reader', 'ErrReader')) {
    if ($state.$key) { try { $state.$key.Dispose() } catch { } }
  }
  foreach ($path in @($state.OutFile, $state.ErrFile)) {
    Remove-Item $path -Force -ErrorAction SilentlyContinue
  }
}

function Show-SplashWindow {
  Hide-OwnConsoleWindow

  $lime = [System.Drawing.Color]::FromArgb(200, 241, 105)
  $ink = [System.Drawing.Color]::FromArgb(8, 18, 15)
  $muted = [System.Drawing.Color]::FromArgb(120, 144, 135)
  $soft = [System.Drawing.Color]::FromArgb(159, 180, 168)
  $bright = [System.Drawing.Color]::FromArgb(215, 232, 217)

  $brand = New-Object System.Windows.Forms.PictureBox
  $brand.Location = New-Object System.Drawing.Point 24, 22
  $brand.Size = New-Object System.Drawing.Size 52, 52
  $brand.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
  $brand.Image = (New-BrandBitmap 52)

  $title = New-Object System.Windows.Forms.Label
  $title.Text = 'D-PREDICT'
  $title.Font = New-SplashFont 'Segoe UI' 13 $true
  $title.ForeColor = $lime
  $title.Location = New-Object System.Drawing.Point 86, 22
  $title.AutoSize = $true

  $subtitle = New-Object System.Windows.Forms.Label
  $subtitle.Text = 'Decision Intelligence Terminal'
  $subtitle.Font = New-SplashFont 'Segoe UI' 8.5 $false
  $subtitle.ForeColor = $muted
  $subtitle.Location = New-Object System.Drawing.Point 88, 53
  $subtitle.AutoSize = $true

  $status = New-Object System.Windows.Forms.Label
  $status.Text = 'Starting D-Predict services'
  $status.Font = New-SplashFont 'Segoe UI' 10 $true
  $status.ForeColor = $bright
  $status.Location = New-Object System.Drawing.Point 24, 92
  $status.Size = New-Object System.Drawing.Size 572, 22

  $detail = New-Object System.Windows.Forms.Label
  $detail.Text = 'Bringing up the database, APIs and collector.'
  $detail.Font = New-SplashFont 'Segoe UI' 8.5 $false
  $detail.ForeColor = $soft
  $detail.Location = New-Object System.Drawing.Point 24, 116
  $detail.Size = New-Object System.Drawing.Size 572, 34

  $bar = New-Object System.Windows.Forms.ProgressBar
  $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
  $bar.Location = New-Object System.Drawing.Point 24, 156
  $bar.Size = New-Object System.Drawing.Size 572, 16

  $logCaption = New-Object System.Windows.Forms.Label
  $logCaption.Text = 'STARTUP LOG'
  $logCaption.Font = New-SplashFont 'Segoe UI' 7.5 $false
  $logCaption.ForeColor = $muted
  $logCaption.Location = New-Object System.Drawing.Point 24, 182
  $logCaption.AutoSize = $true

  $log = New-Object System.Windows.Forms.TextBox
  $log.Multiline = $true
  $log.ReadOnly = $true
  $log.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $log.BorderStyle = [System.Windows.Forms.BorderStyle]::None
  $log.Font = New-SplashFont 'Consolas' 8.25 $false
  $log.BackColor = [System.Drawing.Color]::FromArgb(13, 26, 22)
  $log.ForeColor = [System.Drawing.Color]::FromArgb(143, 167, 156)
  $log.Location = New-Object System.Drawing.Point 24, 200
  $log.Size = New-Object System.Drawing.Size 572, 168
  $log.TabStop = $false

  $logs = New-Object System.Windows.Forms.Button
  $logs.Text = 'Open Log Folder'
  $logs.Location = New-Object System.Drawing.Point 24, 380
  $logs.Size = New-Object System.Drawing.Size 130, 30

  $open = New-Object System.Windows.Forms.Button
  $open.Text = 'Open Dashboard'
  $open.Location = New-Object System.Drawing.Point 296, 380
  $open.Size = New-Object System.Drawing.Size 150, 30
  $open.Visible = $false

  $close = New-Object System.Windows.Forms.Button
  $close.Text = 'Cancel'
  $close.Location = New-Object System.Drawing.Point 460, 380
  $close.Size = New-Object System.Drawing.Size 136, 30

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = "Logs: $LogDir"
  $hint.Font = New-SplashFont 'Segoe UI' 7.5 $false
  $hint.ForeColor = [System.Drawing.Color]::FromArgb(104, 128, 119)
  $hint.Location = New-Object System.Drawing.Point 24, 415
  $hint.AutoSize = $true

  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'D-Predict'
  $form.ClientSize = New-Object System.Drawing.Size 620, 440
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
  $form.MaximizeBox = $false
  $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
  $form.BackColor = $ink
  $form.TopMost = $true
  $form.ShowInTaskbar = $true
  $iconBitmap = New-BrandBitmap 32
  if ($iconBitmap) { $form.Icon = [System.Drawing.Icon]::FromHandle($iconBitmap.GetHicon()) }
  $form.Controls.AddRange([System.Windows.Forms.Control[]]@($brand, $title, $subtitle, $status, $detail, $bar, $logCaption, $log, $logs, $open, $close, $hint))

  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 200

  $script:Splash = @{
    Phase         = 'starting'
    Child         = $null
    OutFile       = (Join-Path $env:TEMP ('dpredict-launch-' + [Guid]::NewGuid().ToString('N') + '.out'))
    ErrFile       = (Join-Path $env:TEMP ('dpredict-launch-' + [Guid]::NewGuid().ToString('N') + '.err'))
    Reader        = $null
    ErrReader     = $null
    Captured      = @()
    Url           = $null
    ExitCode      = $null
    WaitingSince  = $null
    BrowserOpened = $false
    Timer         = $timer
    Form          = $form
    Controls      = @{ Status = $status; Detail = $detail; Bar = $bar; Log = $log; Open = $open; Close = $close }
  }

  $timer.Add_Tick({ Invoke-SplashTick })
  $timer.Start()
  $logs.Add_Click({ Start-Process explorer.exe "`"$LogDir`"" | Out-Null })
  $open.Add_Click({
    Open-DashboardBrowser $script:Splash.Url
    $script:Splash.BrowserOpened = $true
    $script:Splash.Form.Close()
  })
  $close.Add_Click({ $script:Splash.Form.Close() })
  $form.Add_FormClosing({ Close-SplashResources })
  $form.Add_Shown({ Start-SplashRunner })

  [System.Windows.Forms.Application]::Run($form)
}

function Show-HeadlessConsole {
  try {
    Log 'D-Predict launcher starting.'

    if (-not (Test-Path $CompleteMarker)) {
      throw "D-Predict installation is incomplete. Run 'D-Predict Setup & Repair' first. See $BootstrapLog"
    }

    # A stray Write-Error from the startup chain (an npm warning, a docker notice)
    # must not abort the launch, so the merged stream runs with the preference the
    # splash child gets by default.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & (Join-Path $Root 'run.ps1') start *>&1 | Tee-Object -FilePath $LogFile -Append
    } finally {
      $ErrorActionPreference = $previousPreference
    }
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
      if (Test-Path $BootstrapLog) {
        $dockerFailure = Get-Content $BootstrapLog -Tail 40 | Where-Object { $_ -match 'Docker|docker' } | Select-Object -Last 1
        if ($dockerFailure) { throw "D-Predict prerequisites could not start. $dockerFailure`nSee: $BootstrapLog" }
      }
      throw "D-Predict services failed to start (exit code $exitCode). See $LogFile"
    }

    Log 'Waiting for dashboard on ports 3000-3019 ...'
    $dashboardUrl = $null
    for ($i = 0; $i -lt 45; $i++) {
      $dashboardUrl = Resolve-DashboardUrl @()
      if ($dashboardUrl) { break }
      Start-Sleep -Seconds 1
    }

    if (-not $dashboardUrl) { throw 'Dashboard did not become available within 45 seconds. Check the launcher log.' }
    Log "Dashboard is ready at $dashboardUrl. Opening browser."
    Log (Get-MarketReadiness)
    if ($NoBrowser) { Log 'Browser opening was skipped on request.'; return }
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
}

if ($script:UseSplash) { Show-SplashWindow } else { Show-HeadlessConsole }
