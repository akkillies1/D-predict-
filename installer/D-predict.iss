#define MyAppName "D-Predict"
#ifndef MyAppVersion
#define MyAppVersion "0.1.8.1"
#endif
#define MyAppPublisher "D-Predict"

[Setup]
AppId={{8A8A0F2E-9A1C-4C4B-8E9C-4F7F8C1D2A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\Programs\D-Predict
DefaultGroupName=D-Predict
DisableProgramGroupPage=no
OutputDir=dist
OutputBaseFilename=D-Predict-Setup-v{#MyAppVersion}
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={sys}\WindowsPowerShell\v1.0\powershell.exe

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "..\install-dpredict.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\bootstrap-windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dp.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launch-dpredict.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\database-setup.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docker-compose.yml"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-dpredict.ps1"" -InstallDir ""{app}"" -SourceRef ""v{#MyAppVersion}"""; WorkingDir: "{app}"; StatusMsg: "Installing D-Predict prerequisites and runtime..."; Flags: waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; StatusMsg: "Starting D-Predict..."; Flags: postinstall nowait skipifsilent

[Icons]
Name: "{group}\D-Predict Setup & Repair"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-dpredict.ps1"" -InstallDir ""{app}"" -SourceRef ""v{#MyAppVersion}"""; WorkingDir: "{app}"; Comment: "Install or repair D-Predict prerequisites"
Name: "{group}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"
Name: "{group}\D-Predict Repair & Check"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" doctor"; WorkingDir: "{app}"; Comment: "Check D-Predict installation"
Name: "{userdesktop}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Tasks: desktopicon

[Messages]
WelcomeLabel1=Welcome to D-Predict
WelcomeLabel2=This installer installs D-Predict, its runtime prerequisites, and database deployment setup. Database location is chosen on first launch or from the dashboard.
SelectDirLabel3=Choose where to install D-Predict
SelectTasksLabel2=Choose any additional setup you want D-Predict to do.
PreparingDesc=Installing application files and runtime prerequisites
FinishedLabel=D-Predict installed and started
FinishedHeadingLabel=D-Predict installed and started
FinishedLabelNoIcons=D-Predict installed and started

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.run"
Type: files; Name: "{app}\.env"
Type: filesandordirs; Name: "{app}\data"
