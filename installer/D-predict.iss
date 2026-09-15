#define MyAppName "D-Predict"
#ifndef MyAppVersion
#define MyAppVersion "0.1.4"
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
Name: "historicaldata"; Description: "Set up market data for research (recommended)"; GroupDescription: "Set up market data:"; Flags: unchecked

[Files]
Source: "..\bootstrap-windows.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\dp.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\run.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\launch-dpredict.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\.env.example"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{group}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Comment: "Start D-Predict"
Name: "{group}\D-Predict Repair & Check"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" doctor"; WorkingDir: "{app}"; Comment: "Check and repair D-Predict"
Name: "{commondesktop}\D-Predict"; Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\launch-dpredict.ps1"""; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\run.ps1"" bootstrap"; WorkingDir: "{app}"; StatusMsg: "Setting up market data for research..."; Flags: waituntilterminated; Tasks: historicaldata

[Code]
var
  BootstrapSucceeded: Boolean;

function IsBootstrapSucceeded: Boolean;
begin
  Result := BootstrapSucceeded;
end;

procedure RunBootstrap;
var
  ResultCode: Integer;
  Params: String;
begin
  BootstrapSucceeded := False;
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\bootstrap-windows.ps1') + '" -InstallDir "' + ExpandConstant('{app}') + '" -InstallerMode';
  WizardForm.StatusLabel.Caption := 'Preparing your computer and installing D-Predict...';
  Log('Starting D-Predict prerequisite bootstrap.');
  if Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, ExpandConstant('{app}'), SW_SHOWNORMAL, ewWaitUntilTerminated, ResultCode) then begin
    Log('D-Predict bootstrap exited with code ' + IntToStr(ResultCode) + '.');
    if ResultCode = 0 then begin
      BootstrapSucceeded := True;
      exit;
    end;
  end else begin
    Log('D-Predict bootstrap could not be started. Error code ' + IntToStr(ResultCode) + '.');
  end;
  MsgBox('D-Predict could not finish installing its required components.' + #13#10#13#10 + 'The installer will finish without launching D-Predict. Use "D-Predict Repair & Check" after fixing the prerequisite problem.', mbError, MB_OK);
end;

procedure LaunchDpredict;
var
  ResultCode: Integer;
  Params: String;
begin
  Params := '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\launch-dpredict.ps1') + '"';
  Log('Launching D-Predict as the original Windows user.');
  if not ExecAsOriginalUser(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'), Params, ExpandConstant('{app}'), SW_SHOWNORMAL, ewNoWait, ResultCode) then begin
    Log('D-Predict launch failed. Error code ' + IntToStr(ResultCode) + '.');
    MsgBox('D-Predict was installed, but Windows could not start it automatically.' + #13#10#13#10 + 'Use the D-Predict shortcut in the Start Menu to launch it.', mbError, MB_OK);
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then begin
    RunBootstrap;
  end;
  if CurStep = ssDone then begin
    if BootstrapSucceeded then begin
      LaunchDpredict;
    end;
  end;
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
