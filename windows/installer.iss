; Pixberry ERP — Windows installer (Inno Setup).
; Built by .github/workflows/windows-app.yml on a Windows runner, not by hand: that workflow
; downloads Node.js and NSSM and assembles the "payload" folder this script expects, then runs
;   iscc windows\installer.iss
; to produce PixberrySetup.exe. See windows/README.md for what it does and how to build it yourself.
;
; What it installs:
;   - The app, a private copy of Node.js, and NSSM (a Windows service wrapper) under {app}.
;   - A database and backups folder, and a small config.json holding the admin password and data
;     paths, under %ProgramData%\Pixberry — kept there, separate from the program files, so an
;     upgrade or reinstall never touches them.
;   - A Windows service ("Pixberry") that starts the app automatically at boot and restarts it if
;     it crashes, so staff only need to turn the PC on — nobody has to open an app or sign in to
;     Windows for the café to be able to take orders.
;   - A Scheduled Task that runs every 15 minutes. While the café is open it does nothing. The
;     first time it finds the café closed for the day it makes an extra backup, and — only if
;     chosen during setup — tells the PC to shut down 60 seconds later. Because the PC is meant to
;     be off outside opening hours, in practice this only ever runs once a day, right at closing.
;   - A Windows Firewall rule opening the app's port, so the counter display, staff phones and
;     Signal Cubes on the café's own network can reach it.
;
; What it does NOT do: give the café a public https address. That needs a tunnel (Cloudflare
; Tunnel is free) or a reverse proxy, set up separately — see windows/README.md.

#define MyAppName "Pixberry ERP"
#define MyAppPublisher "Pixberry"
#define MyAppExeDesc "Café management software"
#ifndef MyAppVersion
  #define MyAppVersion "1.0.0"
#endif
#define MyAppAdminURL "http://localhost:3000/admin"
#define ServiceName "Pixberry"
#define TaskName "Pixberry Closing Watch"

[Setup]
AppId={{F3FFC91D-8840-4324-822C-7AAE4DA3CFDF}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\Pixberry
DefaultGroupName=Pixberry
DisableProgramGroupPage=yes
PrivilegesRequired=admin
OutputBaseFilename=PixberrySetup
OutputDir=dist
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName={#MyAppName}
ArchitecturesInstallIn64BitMode=x64compatible
; No code-signing certificate yet: Windows SmartScreen will warn on first run until this is signed.
; See windows/README.md for notes on getting a certificate once you're ready to distribute this widely.

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
; The whole payload the workflow assembled: app code + node_modules, a private Node.js, and NSSM.
Source: "payload\app\*"; DestDir: "{app}\app"; Flags: recursesubdirs ignoreversion
Source: "payload\node\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion
Source: "payload\nssm\nssm.exe"; DestDir: "{app}\nssm"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "README.md"; DestDir: "{app}"; DestName: "WINDOWS-SETUP.md"; Flags: ignoreversion
Source: "closing-watch.cmd"; DestDir: "{app}"; Flags: ignoreversion

[Dirs]
; Data lives outside {app} so an upgrade/reinstall (which replaces {app}\app) never touches it.
Name: "{commonappdata}\Pixberry"
Name: "{commonappdata}\Pixberry\data"
Name: "{commonappdata}\Pixberry\backups"
Name: "{commonappdata}\Pixberry\logs"

[Icons]
Name: "{group}\Pixberry (open in browser)"; Filename: "{#MyAppAdminURL}"
Name: "{group}\Pixberry status / logs"; Filename: "{commonappdata}\Pixberry\logs"
Name: "{group}\Uninstall Pixberry"; Filename: "{uninstallexe}"

[Run]
Filename: "{#MyAppAdminURL}"; Description: "Open Pixberry now"; Flags: postinstall shellexec skipifsilent

[Code]
var
  PasswordPage: TInputQueryWizardPage;
  OptionsPage: TInputOptionWizardPage;

procedure InitializeWizard;
begin
  PasswordPage := CreateInputQueryPage(wpSelectDir,
    'Admin account', 'Set the password for the first sign-in',
    'This only matters the very first time Pixberry starts. You can change it afterwards from ' +
    'Settings once signed in. Use at least 8 characters.');
  PasswordPage.Add('Admin password:', True);
  PasswordPage.Add('Confirm password:', True);

  OptionsPage := CreateInputOptionPage(PasswordPage.ID,
    'When the café closes', 'What should happen at closing time?',
    'Pixberry already makes a backup every day. If you also want it to shut this PC down once ' +
    'the café''s opening hours (set later under Settings) have ended, turn this on. It can always ' +
    'be changed later — see WINDOWS-SETUP.md in the install folder.',
    False, False);
  OptionsPage.Add('Shut this PC down automatically after closing time');
  OptionsPage.Values[0] := False;
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if CurPageID = PasswordPage.ID then
  begin
    if Length(PasswordPage.Values[0]) < 8 then
    begin
      MsgBox('The admin password needs to be at least 8 characters.', mbError, MB_OK);
      Result := False;
    end
    else if PasswordPage.Values[0] <> PasswordPage.Values[1] then
    begin
      MsgBox('Those two passwords don''t match.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

function JsonEscape(const S: String): String;
begin
  Result := S;
  StringChangeEx(Result, '\', '\\', True);
  StringChangeEx(Result, '"', '\"', True);
end;

procedure WriteConfig;
var
  AppDataDir, ConfigPath, Json: String;
begin
  AppDataDir := ExpandConstant('{commonappdata}\Pixberry');
  ConfigPath := AppDataDir + '\config.json';
  Json := '{' + #13#10 +
    '  "ADMIN_PASSWORD": "' + JsonEscape(PasswordPage.Values[0]) + '",' + #13#10 +
    '  "PIXBERRY_DB": "' + JsonEscape(AppDataDir + '\data\pixberry.db') + '",' + #13#10 +
    '  "PIXBERRY_BACKUP_DIR": "' + JsonEscape(AppDataDir + '\backups') + '",' + #13#10 +
    '  "PORT": "3000"' + #13#10 +
    '}' + #13#10;
  SaveStringToFile(ConfigPath, Json, False);
end;

procedure InstallServiceAndTask;
var
  ResultCode: Integer;
  Nssm, Node, Run, Log, CmdPath, Args: String;
begin
  Nssm := ExpandConstant('{app}\nssm\nssm.exe');
  Node := ExpandConstant('{app}\node\node.exe');
  Run := ExpandConstant('{app}\app\scripts\run-with-config.js');
  Log := ExpandConstant('{commonappdata}\Pixberry\logs\service.log');

  // Register the service. Each "nssm set" fails harmlessly (exit code ignored) if run twice, so
  // this installer can also be used to repair or upgrade an existing install.
  Exec(Nssm, 'stop ' + '{#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'remove ' + '{#ServiceName} confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'install {#ServiceName} "' + Node + '" "' + Run + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppDirectory "' + ExpandConstant('{app}\app') + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} DisplayName "Pixberry ERP"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} Description "Cafe management software (POS, KDS, Signal). Stop this and the whole cafe system stops."', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} Start SERVICE_AUTO_START', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppExit Default Restart', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppRestartDelay 3000', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppStdout "' + Log + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppStderr "' + Log + '"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppRotateFiles 1', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'set {#ServiceName} AppRotateBytes 5242880', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(Nssm, 'start {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // Firewall: let other devices on the café's own network reach it (counter display, phones, cubes).
  Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Pixberry ERP"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall add rule name="Pixberry ERP" dir=in action=allow protocol=TCP localport=3000', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // Closing-time task: every 15 minutes, as SYSTEM (no stored password, and it runs even if nobody
  // is signed in to Windows). closing-watch.js itself checks the café's actual hours and only acts
  // once a day — see scripts/closing-watch.js. It runs through closing-watch.cmd (a one-line
  // wrapper) so /tr only ever has to quote a single path, even though "Program Files" has a space.
  Exec(ExpandConstant('{sys}\schtasks.exe'), 'delete /tn "{#TaskName}" /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  CmdPath := ExpandConstant('{app}\closing-watch.cmd');
  if OptionsPage.Values[0] then
    Args := '/create /tn "{#TaskName}" /tr "\"' + CmdPath + '\" --shutdown" /sc minute /mo 15 /ru SYSTEM /rl highest /f'
  else
    Args := '/create /tn "{#TaskName}" /tr "\"' + CmdPath + '\"" /sc minute /mo 15 /ru SYSTEM /rl highest /f';
  Exec(ExpandConstant('{sys}\schtasks.exe'), Args, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssPostInstall then
  begin
    WriteConfig;
    InstallServiceAndTask;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
var
  ResultCode: Integer;
begin
  if CurUninstallStep = usUninstall then
  begin
    Exec(ExpandConstant('{app}\nssm\nssm.exe'), 'stop {#ServiceName}', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{app}\nssm\nssm.exe'), 'remove {#ServiceName} confirm', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{sys}\schtasks.exe'), 'delete /tn "{#TaskName}" /f', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    Exec(ExpandConstant('{sys}\netsh.exe'), 'advfirewall firewall delete rule name="Pixberry ERP"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

function InitializeUninstall(): Boolean;
begin
  Result := True;
  MsgBox('Your café''s data (database and backups) is kept in %ProgramData%\Pixberry and will ' +
    'NOT be deleted. Remove that folder yourself if you really want to erase it.', mbInformation, MB_OK);
end;
