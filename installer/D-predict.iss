#define MyAppName "D-Predict"
#ifndef MyAppVersion
#define MyAppVersion "0.1.6"
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
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={sys}\WindowsPowerShell\v1.0\powershell.exe

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "historicaldata"; Description: "Set up market data for research (recommended)"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "..\bootstrap-windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dp.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launch-dpredict.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\docker-compose.yml"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"
Name: "{group}\D-Predict Repair & Check"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" doctor"; WorkingDir: "{app}"; Comment: "Check and repair D-Predict"
Name: "{commondesktop}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\bootstrap-windows.ps1"" -InstallDir ""{app}"" -InstallerMode -SkipChecks -SourceRef ""v{#MyAppVersion}"""; WorkingDir: "{app}"; StatusMsg: "Preparing D-Predict and installing required components..."; Flags: waituntilterminated runasoriginaluser postinstall
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" bootstrap"; WorkingDir: "{app}"; StatusMsg: "Setting up market data for research..."; Flags: waituntilterminated runasoriginaluser postinstall; Tasks: historicaldata
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Description: "Launch D-Predict now"; Flags: nowait runasoriginaluser postinstall; Check: IsBootstrapComplete

[Code]
function IsBootstrapComplete: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\D-Predict\.install-complete'));
end;

[Messages]
WelcomeLabel1=Welcome to D-Predict
WelcomeLabel2=Let’s get D-Predict ready on your computer.
SelectDirLabel3=Choose where to install D-Predict
SelectTasksLabel2=Choose any additional setup you want D-Predict to do.
PreparingDesc=Preparing your computer
FinishedLabel=D-Predict is ready
FinishedHeadingLabel=D-Predict is ready
FinishedLabelNoIcons=D-Predict is ready

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.run"
Type: files; Name: "{app}\.env"
Type: filesandordirs; Name: "{app}\data"
