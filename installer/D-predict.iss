#define MyAppName "D-Predict"
#ifndef MyAppVersion
#define MyAppVersion "2.1.7"
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
DisableWelcomePage=no
SetupIconFile=assets\dpredict-icon.ico
WizardImageFile=assets\wizard-image.png
WizardSmallImageFile=assets\wizard-small.png
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={uninstallexe}
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
Source: "..\update-dpredict.ps1";    DestDir: "{app}"; Flags: ignoreversion
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
; The setup icon doubles as the shortcut icon, so the app is recognisable on the
; desktop and in Add/Remove Programs.
Source: "assets\dpredict-icon.ico";  DestDir: "{app}\assets"; Flags: ignoreversion

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-dpredict.ps1"" -InstallDir ""{app}"" -SourceRef ""{#MyAppSourceRef}"" -AppVersion ""{#MyAppVersion}"""; WorkingDir: "{app}"; StatusMsg: "Opening D-Predict installer..."; Flags: waituntilterminated runhidden
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; StatusMsg: "Starting D-Predict..."; Flags: postinstall nowait runhidden runasoriginaluser; Check: IsDpredictReady

[Icons]
Name: "{group}\D-Predict Setup & Repair"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\install-dpredict.ps1"" -InstallDir ""{app}"" -SourceRef ""{#MyAppSourceRef}"" -AppVersion ""{#MyAppVersion}"""; WorkingDir: "{app}"; Comment: "Install or repair D-Predict prerequisites"; IconFilename: "{app}\assets\dpredict-icon.ico"
Name: "{group}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"; IconFilename: "{app}\assets\dpredict-icon.ico"
Name: "{group}\D-Predict Repair & Check"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" doctor"; WorkingDir: "{app}"; Comment: "Check D-Predict installation"; IconFilename: "{app}\assets\dpredict-icon.ico"
Name: "{userdesktop}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"; Tasks: desktopicon; IconFilename: "{app}\assets\dpredict-icon.ico"

[Messages]
WelcomeLabel1=Welcome to {#MyAppName} v{#MyAppVersion}
WelcomeLabel2={#MyAppName} is a local-first Decision Intelligence Terminal for Indian equities and NIFTY/BANKNIFTY derivatives.%n%nThis installer will:%n  - Check for required prerequisites (Docker Desktop, WSL 2, Git)%n  - Download and configure the {#MyAppName} runtime%n  - Set up your local database and services%n%nNo cloud account or paid subscription is required, and your data stays on this machine.
SelectDirLabel3=Choose where to install {#MyAppName}. Application data (database, models, logs) will be stored separately in %LOCALAPPDATA%\D-Predict\.
SelectTasksLabel2=Select additional shortcuts to create:
PreparingDesc=Verifying prerequisites and extracting application files...
FinishedHeadingLabel={#MyAppName} v{#MyAppVersion} installed
FinishedLabel={#MyAppName} has been installed successfully.%n%nUse the {#MyAppName} shortcut in the Start Menu to launch the application. The dashboard opens automatically at http://127.0.0.1:3000
FinishedLabelNoIcons={#MyAppName} v{#MyAppVersion} installed. Run launch-dpredict.ps1 from the installation folder to start.

[Code]
function IsDpredictInstalled(): Boolean;
var
  Marker: String;
begin
  Marker := ExpandConstant('{localappdata}\D-Predict\.install-complete');
  Result := FileExists(Marker);
end;

function IsDpredictReady(): Boolean;
var
  Marker: String;
  EnvFile: String;
begin
  Marker := ExpandConstant('{localappdata}\D-Predict\.install-complete');
  EnvFile := ExpandConstant('{localappdata}\D-Predict\.env');
  Result := FileExists(Marker) and FileExists(EnvFile);
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not IsWin64 then begin
    MsgBox('{#MyAppName} v{#MyAppVersion} requires a 64-bit version of Windows 10 or Windows 11.' + #13#10 +
           'This machine is running a 32-bit OS. Installation cannot continue.',
           mbError, MB_OK);
    Result := False;
  end;
end;

function RecordedDataRoot(): String;
var
  Lines: TArrayOfString;
  Index: Integer;
  Line: String;
begin
  Result := '';
  if not LoadStringsFromFile(ExpandConstant('{localappdata}\D-Predict\.env'), Lines) then Exit;
  for Index := 0 to GetArrayLength(Lines) - 1 do begin
    Line := Trim(Lines[Index]);
    if Copy(Line, 1, 18) = 'D_PREDICT_DATA_DIR=' then begin
      Result := RemoveQuotes(Trim(Copy(Line, 19, Length(Line))));
      if Result <> '' then Exit;
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  StateRoot, DatabaseRoot, Message, Question: String;
  Answer, ExecResult: Integer;
begin
  if CurUninstallStep <> usUninstall then Exit;

  // The application runs as a Docker stack, so files can be removed while its
  // containers keep serving the dashboard: an install that works until the next
  // reboot and then has no launcher left. Ask the host to stop it first, and only
  // when the saved configuration is intact, because the launcher would otherwise
  // open the database wizard in the middle of an uninstall.
  if FileExists(ExpandConstant('{app}\run.ps1')) and
     FileExists(ExpandConstant('{localappdata}\D-Predict\.env')) then
    Exec('powershell.exe',
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\run.ps1') + '" stop',
      ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, ExecResult);

  StateRoot := ExpandConstant('{localappdata}\D-Predict');
  if not DirExists(StateRoot) then Exit;

  DatabaseRoot := RecordedDataRoot();
  if DatabaseRoot <> '' then
    Message := 'Your database and model data live in:' + #13#10 + DatabaseRoot + #13#10 + 'This uninstall does not delete that folder.'
  else
    Message := 'The database folder you chose during setup is not deleted here.';
  Question := 'D-Predict keeps its configuration and logs in:' + #13#10 + StateRoot + #13#10#13#10 + Message + #13#10#13#10;
  Question := Question + 'Delete the configuration and logs listed above?' + #13#10 +
    'Choose No to keep them so a reinstall reuses them.';
  Answer := MsgBox(Question, mbConfirmation, MB_YESNO or MB_DEFBUTTON2);
  if Answer = IDYES then
    DelTree(StateRoot, True, True, True);
end;

[Registry]
; install-dpredict.ps1 writes this handler so the dashboard can hand an "Update now"
; click back to the host. The key is only listed here so uninstalling removes it.
Root: HKA; Subkey: "Software\Classes\dpredict-update"; ValueType: none; Flags: uninsdeletekey
Root: HKA; Subkey: "Software\Classes\dpredict-database"; ValueType: none; Flags: uninsdeletekey

[UninstallDelete]
Type: filesandordirs; Name: "{app}\.run"
Type: files;          Name: "{app}\.env"
Type: filesandordirs; Name: "{app}\data"
