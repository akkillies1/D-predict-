param(
    [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'Programs\D-Predict'),
    [string]$SourceRef = 'main',
    [string]$AppVersion = '',
    [switch]$ElevatedChild
)

$ErrorActionPreference = 'Stop'
$stateRoot = Join-Path $env:LOCALAPPDATA 'D-Predict'
$logDir = Join-Path $stateRoot 'logs'
$logFile = Join-Path $logDir 'installer.log'
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

function Log([string]$Message) {
    $line = "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Message"
    $line | Tee-Object -FilePath $logFile -Append
}

# docker-compose starts the api container with `env_file: .env`, and that container
# has no host access, so the installed version reaches the update check only
# through this file.

function Ensure-InstallerElevation {
    if ($ElevatedChild) { return }
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { return }
    $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $PSCommandPath),
        '-InstallDir',('"{0}"' -f $InstallDir),'-SourceRef',('"{0}"' -f $SourceRef),
        '-AppVersion',('"{0}"' -f $AppVersion),'-ElevatedChild')
    $child = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -ArgumentList $args -WorkingDirectory (Split-Path -Parent $PSCommandPath) -Wait -PassThru
    exit $child.ExitCode
}

function Set-EnvValue([string]$Path, [string]$Key, [string]$Value) {
    $lines = @()
    if (Test-Path $Path) { $lines = @(Get-Content $Path -ErrorAction SilentlyContinue) }
    $pattern = "^\s*${Key}\s*="
    $found = @($lines | Where-Object { $_ -match $pattern }).Count -gt 0
    if ($found) {
        $lines = @($lines | ForEach-Object { if ($_ -match $pattern) { "${Key}=${Value}" } else { $_ } })
    } else {
        $lines = @($lines) + "${Key}=${Value}"
    }
    $lines | Set-Content -Path $Path -Encoding UTF8
}

# Lets the dashboard's "Update now" button hand off to the host updater without a
# resident watcher; the launcher exits once the dashboard is up.
function Register-UpdateProtocol([string]$UpdaterPath) {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $key = 'HKCU:\Software\Classes\dpredict-update'
    New-Item -Path "$key\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(Default)' -Value 'URL:D-Predict Update Protocol'
    Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path "$key\shell\open\command" -Name '(Default)' -Value `
        ('"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}" -Action Apply' -f $powershell, $UpdaterPath)
}


function Show-BootstrapInstaller {
    param([string]$BootstrapPath, [string]$InstallDirectory, [string]$ReleaseRef)
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $outFile = Join-Path $env:TEMP ("dpredict-install-" + [Guid]::NewGuid().ToString("N") + ".out")
    $errFile = Join-Path $env:TEMP ("dpredict-install-" + [Guid]::NewGuid().ToString("N") + ".err")
    $script:InstallCancel = $false
    $form = New-Object System.Windows.Forms.Form
    $form.Text = 'D-Predict Installation'; $form.ClientSize = New-Object System.Drawing.Size(680,430)
    $form.StartPosition = 'CenterScreen'; $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false; $form.MinimizeBox = $false; $form.BackColor = [System.Drawing.Color]::FromArgb(8,18,15); $form.TopMost = $true
    $title = New-Object System.Windows.Forms.Label
    $title.Text = 'D-PREDICT'; $title.Font = New-Object System.Drawing.Font('Segoe UI',14,[System.Drawing.FontStyle]::Bold); $title.ForeColor = [System.Drawing.Color]::FromArgb(200,241,105); $title.Location = New-Object System.Drawing.Point(28,24); $title.AutoSize = $true
    $subtitle = New-Object System.Windows.Forms.Label
    $subtitle.Text = 'Decision Intelligence Terminal'; $subtitle.Font = New-Object System.Drawing.Font('Segoe UI',9); $subtitle.ForeColor = [System.Drawing.Color]::FromArgb(120,144,135); $subtitle.Location = New-Object System.Drawing.Point(30,52); $subtitle.AutoSize = $true
    $status = New-Object System.Windows.Forms.Label
    $status.Text = 'Installing D-Predict'; $status.Font = New-Object System.Drawing.Font('Segoe UI',11,[System.Drawing.FontStyle]::Bold); $status.ForeColor = [System.Drawing.Color]::FromArgb(237,245,233); $status.Location = New-Object System.Drawing.Point(28,90); $status.Size = New-Object System.Drawing.Size(620,26)
    $detail = New-Object System.Windows.Forms.Label
    $detail.Text = 'Preparing prerequisites...'; $detail.Font = New-Object System.Drawing.Font('Segoe UI',9); $detail.ForeColor = [System.Drawing.Color]::FromArgb(159,180,168); $detail.Location = New-Object System.Drawing.Point(28,118); $detail.Size = New-Object System.Drawing.Size(620,40)
    $bar = New-Object System.Windows.Forms.ProgressBar
    $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee; $bar.Location = New-Object System.Drawing.Point(28,164); $bar.Size = New-Object System.Drawing.Size(620,18)
    $logBox = New-Object System.Windows.Forms.TextBox
    $logBox.Multiline = $true; $logBox.ReadOnly = $true; $logBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical; $logBox.Font = New-Object System.Drawing.Font('Consolas',8.5); $logBox.BackColor = [System.Drawing.Color]::FromArgb(13,26,22); $logBox.ForeColor = [System.Drawing.Color]::FromArgb(143,167,156); $logBox.BorderStyle = [System.Windows.Forms.BorderStyle]::None; $logBox.Location = New-Object System.Drawing.Point(28,198); $logBox.Size = New-Object System.Drawing.Size(620,165)
    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = 'Cancel installation'; $cancel.Location = New-Object System.Drawing.Point(510,378); $cancel.Size = New-Object System.Drawing.Size(138,32)
    $form.Controls.AddRange(@($title,$subtitle,$status,$detail,$bar,$logBox,$cancel))
    $proc = $null; $reader = $null; $errReader = $null

    function Set-Stage([string]$line) {
        $text = $line.Trim()
        if (-not $text) { return }
        $logBox.AppendText($text + [Environment]::NewLine); $logBox.SelectionStart = $logBox.TextLength; $logBox.ScrollToCaret()
        if ($text -match 'Docker') { $status.Text = 'Preparing Docker runtime' }
        elseif ($text -match 'Synchronizing D-Predict source|Downloading D-Predict source') { $status.Text = 'Synchronizing D-Predict source' }
        elseif ($text -match 'Python|collector') { $status.Text = 'Preparing Python environment' }
        elseif ($text -match 'backend dependencies') { $status.Text = 'Installing backend dependencies' }
        elseif ($text -match 'Corepack|pnpm') { $status.Text = 'Installing dashboard dependencies' }
        elseif ($text -match 'completed successfully') { $status.Text = 'Installation complete' }
        $detail.Text = if ($text.Length -gt 120) { $text.Substring(0,120) } else { $text }
    }

    $cancel.Add_Click({
        $script:InstallCancel = $true; $cancel.Enabled = $false; $status.Text = 'Cancelling installation...'; $detail.Text = 'Stopping the installer and prerequisite processes safely.'
        if ($proc -and -not $proc.HasExited) { try { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } catch { } }
    })
    $form.Add_FormClosing({
        if ($proc -and -not $proc.HasExited -and -not $script:InstallCancel) { $script:InstallCancel = $true; try { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } catch { } }
    })

    try {
        $args = @('-NoProfile','-ExecutionPolicy','Bypass','-File',('"{0}"' -f $BootstrapPath),'-InstallDir',('"{0}"' -f $InstallDirectory),'-InstallerMode','-ElevatedChild','-SkipChecks','-SourceRef',('"{0}"' -f $ReleaseRef))
        $proc = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList $args -WorkingDirectory $InstallDirectory -WindowStyle Hidden -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
        $reader = New-Object System.IO.StreamReader($outFile); $errReader = New-Object System.IO.StreamReader($errFile)
        while (-not $proc.HasExited -and -not $script:InstallCancel) {
            [System.Windows.Forms.Application]::DoEvents()
            foreach ($rdr in @($reader,$errReader)) {
                while (-not $rdr.EndOfStream) { $line = $rdr.ReadLine(); if ($line) { Log "bootstrap: $line"; Set-Stage $line } }
            }
            Start-Sleep -Milliseconds 150
        }
        if ($script:InstallCancel) {
            try { if ($proc -and -not $proc.HasExited) { & taskkill.exe /PID $proc.Id /T /F 2>&1 | Out-Null } } catch { }
            throw 'INSTALL_CANCELLED'
        }
        foreach ($rdr in @($reader,$errReader)) {
            while (-not $rdr.EndOfStream) { $line = $rdr.ReadLine(); if ($line) { Log "bootstrap: $line"; Set-Stage $line } }
        }
        if ($proc.ExitCode -ne 0) { throw "D-Predict prerequisite setup failed (exit code $($proc.ExitCode)). See $logFile" }
        $status.Text = 'D-Predict installation complete'; $detail.Text = 'All prerequisites and application dependencies were installed successfully.'; $bar.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous; $bar.Value = 100
        [System.Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 350
        return 0
    } finally {
        try { $reader.Dispose() } catch { }; try { $errReader.Dispose() } catch { }
        Remove-Item $outFile,$errFile -Force -ErrorAction SilentlyContinue; $form.Dispose()
    }
}
function Register-DatabaseProtocol([string]$SetupPath) {
    $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $key = 'HKCU:\Software\Classes\dpredict-database'
    New-Item -Path "$key\shell\open\command" -Force | Out-Null
    Set-ItemProperty -Path $key -Name '(Default)' -Value 'URL:D-Predict Database Setup Protocol'
    Set-ItemProperty -Path $key -Name 'URL Protocol' -Value ''
    Set-ItemProperty -Path "$key\shell\open\command" -Name '(Default)' -Value ('"{0}" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "{1}"' -f $powershell, $SetupPath)
}


try {
    Ensure-InstallerElevation
    Log "D-Predict installer starting. InstallDir=$InstallDir SourceRef=$SourceRef"
    if (-not (Test-Path $InstallDir)) {
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
    }

    # Configure the database BEFORE the heavyweight bootstrap. Inno Setup does not
    # provide a reliable interactive PowerShell console, so the database wizard
    # must own all first-run interaction through Windows dialogs.
    $databaseSetup = Join-Path $InstallDir 'database-setup.ps1'
    $stateEnvFile = Join-Path $stateRoot '.env'
    $projectEnvFile = Join-Path $InstallDir '.env'
    if (-not (Test-Path $databaseSetup)) {
        throw "Database setup script is missing: $databaseSetup"
    }
    # A previous install can leave the machine-level state file behind while the
    # application directory has been replaced. In that case the project itself
    # is not configured yet, so force the wizard instead of silently accepting
    # an incomplete configuration.
    if (-not (Test-Path $stateEnvFile) -or -not (Test-Path $projectEnvFile)) {
        Log 'Database configuration is missing; starting the first-run database setup wizard.'
        & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File $databaseSetup
        $databaseExitCode = $LASTEXITCODE
        if ($databaseExitCode -ne 0) {
            if ($databaseExitCode -eq 2) { throw 'Database configuration was cancelled by the user.' }
            throw "Database configuration was not completed (exit code $databaseExitCode). See $logFile"
        }
    }
    if (-not (Test-Path $stateEnvFile)) {
        throw "Database setup returned success without creating $stateEnvFile."
    }
    if (-not (Test-Path $projectEnvFile)) {
        throw "Database setup returned success without creating $projectEnvFile."
    }

    # The Inno Setup package contains the bootstrap entrypoint and the small
    # installer helpers. Do not download/unpack the repository here: doing so
    # can overwrite the script that is currently executing and can leave a
    # partially installed tree. bootstrap-windows.ps1 owns source sync,
    # prerequisite installation, and verification.
    $bootstrap = Join-Path $InstallDir 'bootstrap-windows.ps1'
    if (-not (Test-Path $bootstrap)) {
        throw "Installer bootstrap is missing: $bootstrap"
    }

    Log 'Starting the D-Predict bootstrap after database configuration.'
    $exitCode = Show-BootstrapInstaller -BootstrapPath $bootstrap -InstallDirectory $InstallDir -ReleaseRef $SourceRef
    if ($exitCode -ne 0) {
        if ($exitCode -eq 2) { throw 'INSTALL_CANCELLED' }
        throw "D-Predict prerequisite setup failed (exit code $exitCode). See $logFile"
    }

    New-Item -ItemType Directory -Force -Path $stateRoot | Out-Null
    $completeMarker = Join-Path $stateRoot '.install-complete'
    if (-not (Test-Path $completeMarker)) {
        Log "Bootstrap succeeded but the marker was not visible in this user context; writing $completeMarker."
        Set-Content -Path $completeMarker -Value (Get-Date -Format o) -Encoding UTF8
    }
    if (-not (Test-Path $completeMarker)) {
        throw "D-Predict bootstrap returned success but the completion marker could not be written: $completeMarker. See $logFile"
    }
    Set-Content -Path (Join-Path $stateRoot 'install-root.txt') -Value $InstallDir -Encoding UTF8
    if ($SourceRef) {
        Set-Content -Path (Join-Path $stateRoot 'source-ref.txt') -Value $SourceRef -Encoding UTF8
    }

    # Stamping the version is what makes the in-app update check possible. Neither
    # step can break a working install, so a failure here is logged and ignored.
    try {
        $version = $AppVersion -replace '^[vV]', ''
        if ($version -match '^\d+\.\d+\.\d+$') {
            Set-Content -Path (Join-Path $stateRoot 'version.txt') -Value $version -Encoding UTF8
            Set-EnvValue -Path $projectEnvFile -Key 'D_PREDICT_VERSION' -Value $version
            Log "Recorded installed version $version in $stateRoot\version.txt and $projectEnvFile."
        } else {
            Log "No usable version was supplied by the setup package (got '$AppVersion'); the update check will report the version as unknown."
        }
        $updater = Join-Path $InstallDir 'update-dpredict.ps1'
        if (Test-Path $updater) {
            Register-UpdateProtocol $updater
            Log 'Registered the dpredict-update: protocol handler.'
        } else {
            Log "Update handler was not registered because $updater is missing."
        }
        $databaseSetup = Join-Path $InstallDir 'database-setup.ps1'
        if (Test-Path $databaseSetup) {
            Register-DatabaseProtocol $databaseSetup
            Log 'Registered the dpredict-database: protocol handler.'
        } else {
            Log "Database protocol handler was not registered because $databaseSetup is missing."
        }
    } catch {
        Log "Update-check registration failed (the installation itself is unaffected): $($_.Exception.Message)"
    }

    Log 'D-Predict setup completed successfully.'
    exit 0
}
catch {
    if ($_.Exception.Message -eq 'INSTALL_CANCELLED') {
        Log 'D-Predict installation cancelled by the user.'
        exit 2
    }
    Log "ERROR: $($_.Exception.Message)"
    Write-Host "`nD-Predict setup failed." -ForegroundColor Red
    Write-Host "Reason: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "Installer log: $logFile" -ForegroundColor Yellow
    exit 1
}
