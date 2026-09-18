#define MyAppName "D-Predict"
#ifndef MyAppVersion
#define MyAppVersion "2.0.0"
#endif
#ifndef MyAppSourceRef
#define MyAppSourceRef "main"
#endif
#define MyAppPublisher "Dcode Private Limited"
#define MyAppURL "https://github.com/akkillies1/D-predict-"

[Setup]
AppId={{8A8A0F2E-9A1C-4C4B-8E9C-4F7F8C1D2A11}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppVerName={#MyAppName} v{#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}/issues
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={localappdata}\Programs\D-Predict
DisableDirPage=no
DirExistsWarning=yes
DefaultGroupName=D-Predict
AllowNoIcons=yes
DisableProgramGroupPage=no
OutputDir=dist
OutputBaseFilename=D-Predict-Setup-v{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={sys}\WindowsPowerShell\v1.0\powershell.exe
VersionInfoVersion={#MyAppVersion}
VersionInfoCompany={#MyAppPublisher}
VersionInfoDescription=D-Predict — Decision Intelligence Terminal for Indian Markets
VersionInfoProductName={#MyAppName}
VersionInfoProductVersion={#MyAppVersion}
MinVersion=10.0
ShowLanguageDialog=no

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "Create a &desktop shortcut"; GroupDescription: "Shortcuts:"; Flags: unchecked
Name: "startmenu";  Description: "Create a &Start Menu group";  GroupDescription: "Shortcuts:"; Flags: checkedonce

[Files]
Source: "..\install-dpredict.ps1";   DestDir: "{app}"; Flags: ignoreversion
Source: "..\bootstrap-windows.ps1";  DestDir: "{app}"; Flags: ignoreversion
Source: "..\dp.ps1";                 DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.ps1";                DestDir: "{app}"; Flags: ignoreversion
Source: "..\launch-dpredict.ps1";    DestDir: "{app}"; Flags: ignoreversion
Source: "..\stop-d-predict.ps1";     DestDir: "{app}"; Flags: ignoreversion
Source: "..\database-setup.ps1";     DestDir: "{app}"; Flags: ignoreversion
Source: "..\d-predict.ps1";          DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example";           DestDir: "{app}"; Flags: ignoreversion
Source: "..\docker-compose.yml";     DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md";              DestDir: "{app}"; Flags: ignoreversion isreadme
Source: "..\LOCAL_INSTALL_GUIDE.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\WINDOWS.md";             DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-dpredict.ps1"" -InstallDir ""{app}"" -SourceRef ""{#MyAppSourceRef}"""; WorkingDir: "{app}"; StatusMsg: "Installing D-Predict prerequisites and runtime..."; Flags: waituntilterminated
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; StatusMsg: "Starting D-Predict..."; Flags: postinstall nowait; Check: IsDpredictInstalled

[Icons]
Name: "{group}\D-Predict Setup & Repair"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-dpredict.ps1"" -InstallDir ""{app}"" -SourceRef ""{#MyAppSourceRef}"""; WorkingDir: "{app}"; Comment: "Install or repair D-Predict prerequisites"
Name: "{group}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"
Name: "{group}\D-Predict Repair & Check"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" doctor"; WorkingDir: "{app}"; Comment: "Check D-Predict installation"
Name: "{userdesktop}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"; Tasks: desktopicon

[Messages]
WelcomeLabel1=Welcome to D-Predict v2.0
WelcomeLabel2=D-Predict is a local-first Decision Intelligence Terminal for Indian equities and NIFTY/BANKNIFTY derivatives.%n%nThis installer will:%n  - Check for required prerequisites (Docker Desktop, WSL 2, Git)%n  - Download and configure the D-Predict runtime%n  - Set up your local database and services%n%nNo cloud account or paid subscription is required.
SelectDirLabel3=Choose where to install D-Predict. Application data (database, models, logs) will be stored separately in %LOCALAPPDATA%\D-Predict\.
SelectTasksLabel2=Select additional shortcuts to create:
PreparingDesc=Verifying prerequisites and extracting application files...
FinishedHeadingLabel=D-Predict v2.0 installed
FinishedLabel=D-Predict has been installed successfully.%n%nUse the D-Predict shortcut in the Start Menu to launch the application. The dashboard opens automatically at http://127.0.0.1:3000
FinishedLabelNoIcons=D-Predict v2.0 installed. Run launch-dpredict.ps1 from the installation folder to start.

[Code]
function IsDpredictInstalled(): Boolean;
var
  Marker: String;
begin
  Marker := ExpandConstant('{localappdata}\D-Predict\.install-complete');
  Result := FileExists(Marker);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not IsWin64 then begin
    MsgBox('D-Predict v2.0 requires a 64-bit version of Windows 10 or Windows 11.' + #13#10 +
           'This machine is running a 32-bit OS. Installation cannot continue.',
           mbError, MB_OK);
    Result := False;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  DataDir: String;
  Answer: Integer;
begin
  if CurUninstallStep = usUninstall then begin
    DataDir := ExpandConstant('{localappdata}\D-Predict');
    if DirExists(DataDir) then begin
      Answer := MsgBox(
        'D-Predict stores your local database and model data in:' + #13#10 +
        DataDir + #13#10#13#10 +
        'Do you want to DELETE this data?' + #13#10 +
        'Choose No to keep your data for a future reinstall.',
        mbConfirmation, MB_YESNO);
      if Answer = IDYES then
        DelTree(DataDir, True, True, True);
    end;
  end;
end;

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.run"
Type: files;          Name: "{app}\.env"
Type: filesandordirs; Name: "{app}\data"
