#define MyAppName "D-Predict"
#define MyAppVersion "0.1.0"
#define MyAppPublisher "D-Predict"

[Setup]
AppId={{8A8A0F2E-9A1C-4C4B-8E9C-4F7F8C1D2A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\D-Predict
DefaultGroupName=D-Predict
DisableProgramGroupPage=no
OutputDir=dist
OutputBaseFilename=D-Predict-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\D-Predict Launcher.lnk

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "..\bootstrap-windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dp.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launch-dpredict.ps1"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"
Name: "{group}\D-Predict Setup / Doctor"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" doctor"; WorkingDir: "{app}"; Comment: "Check D-Predict installation"
Name: "{commondesktop}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\bootstrap-windows.ps1"" -InstallDir ""{app}"" -InstallerMode"; WorkingDir: "{app}"; StatusMsg: "Installing D-Predict and verifying the local environment..."; Flags: waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Description: "Launch D-Predict now"; Flags: nowait postinstall skipifsilent

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.run"
Type: files; Name: "{app}\.env"
Type: filesandordirs; Name: "{app}\data"
