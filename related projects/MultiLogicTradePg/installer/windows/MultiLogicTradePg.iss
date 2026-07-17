; MultiLogicTradePg Windows installer.
; Build with installer/windows/build-installer.ps1 or Inno Setup Compiler (ISCC.exe).
#define MyAppName "MultiLogicTradePg"
#define MyAppPublisher "RobinZGit"
#define MyAppVersion "1.0.0"
#define MyAppExeName "MultiLogic_Trade_Progress_Start.bat"
#define MyAppId "{D8F3A59E-59FD-4A83-BC26-FD0A671E01A9}"
#define SourceRoot "..\.."

[Setup]
AppId={{D8F3A59E-59FD-4A83-BC26-FD0A671E01A9}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={autopf}\MultiLogicTradePg
DefaultGroupName=MultiLogic Trade
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=MultiLogicTradePgSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64
ArchitecturesInstallIn64BitMode=x64
PrivilegesRequired=admin
SetupLogging=yes
UninstallDisplayIcon={app}\web\{#MyAppExeName}

[Languages]
Name: "russian"; MessagesFile: "compiler:Languages\Russian.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "{cm:AdditionalIcons}"; Flags: checkedonce
Name: "resetdb"; Description: "Развернуть базу данных с нуля (00 -> 01 -> 02, пароль PostgreSQL 111)"; GroupDescription: "База данных:"; Flags: checkedonce

[Files]
Source: "{#SourceRoot}\00_create_database.sql"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\01_multilogictrade_tables_and_data.sql"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\02_multilogictrade_functions_and_procedures.sql"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\03_multilogictrade_examples.sql"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "{#SourceRoot}\docs\*"; DestDir: "{app}\docs"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "{#SourceRoot}\scripts\*"; DestDir: "{app}\scripts"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "_tmp_http_ext\*"
Source: "{#SourceRoot}\api\*"; DestDir: "{app}\api"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "node_modules\*,.env"
Source: "{#SourceRoot}\web\*"; DestDir: "{app}\web"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "node_modules\*,.angular\*,dist\*"
Source: "{#SourceRoot}\installer\windows\*"; DestDir: "{app}\installer\windows"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "dist\*"

[Icons]
Name: "{autoprograms}\MultiLogic Trade\MultiLogic Trade"; Filename: "{app}\web\{#MyAppExeName}"; WorkingDir: "{app}\web"; Comment: "Запустить MultiLogic Trade"
Name: "{autodesktop}\MultiLogic Trade"; Filename: "{app}\web\{#MyAppExeName}"; WorkingDir: "{app}\web"; Comment: "Запустить MultiLogic Trade"; Tasks: desktopicon

[Run]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\installer\windows\scripts\install.ps1"" -InstallDir ""{app}"" -PostgresPassword ""111"" -ResetDatabase:{code:GetResetDatabaseFlag}"; StatusMsg: "Установка Node.js/PostgreSQL, npm-зависимостей и базы MultiLogicTradePg..."; Flags: waituntilterminated

[Code]
function GetResetDatabaseFlag(Param: String): String;
begin
  if WizardIsTaskSelected('resetdb') then
    Result := '$true'
  else
    Result := '$false';
end;

function StripQuotes(Value: String): String;
begin
  Result := Value;
  if (Length(Result) >= 2) and (Copy(Result, 1, 1) = '"') and (Copy(Result, Length(Result), 1) = '"') then
    Result := Copy(Result, 2, Length(Result) - 2);
end;

function InitializeSetup(): Boolean;
var
  UninstallString: String;
  ResultCode: Integer;
  Answer: Integer;
begin
  Result := True;

  if RegQueryStringValue(HKLM, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1', 'UninstallString', UninstallString)
    or RegQueryStringValue(HKCU, 'Software\Microsoft\Windows\CurrentVersion\Uninstall\{#MyAppId}_is1', 'UninstallString', UninstallString) then
  begin
    Answer := MsgBox(
      'MultiLogicTradePg уже установлен.'#13#10#13#10 +
      'Да — удалить старую установку и поставить заново.'#13#10 +
      'Нет — продолжить установку поверх старой папки.'#13#10 +
      'Отмена — остановить установку.',
      mbConfirmation,
      MB_YESNOCANCEL
    );

    if Answer = IDYES then
    begin
      if not Exec(StripQuotes(UninstallString), '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART', '', SW_SHOW, ewWaitUntilTerminated, ResultCode) then
      begin
        MsgBox('Не удалось запустить деинсталлятор старой версии.', mbError, MB_OK);
        Result := False;
      end;
    end
    else if Answer = IDCANCEL then
      Result := False;
  end;
end;
