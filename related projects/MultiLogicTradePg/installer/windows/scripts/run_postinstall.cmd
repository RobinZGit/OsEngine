@echo off
setlocal EnableExtensions

set "INSTALL_DIR=%~1"
set "PG_PASSWORD=%~2"
set "DB_MODE=%~3"
set "UPDATE_SSL=%~4"
set "SCRIPT_DIR=%~dp0"
set "PROTOCOL=%INSTALL_DIR%\INSTALL_PROTOCOL.txt"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
set "MODE_FILE=%INSTALL_DIR%\installer\windows\db-mode.txt"
set "SSL_FILE=%INSTALL_DIR%\installer\windows\update-ssl-certs.txt"

if "%INSTALL_DIR%"=="" (
  echo [ERROR] InstallDir argument is missing.
  exit /b 2
)

if "%PG_PASSWORD%"=="" set "PG_PASSWORD=111"

REM Prefer explicit 3rd arg; else read db-mode.txt written by Inno PreparePostInstall.
if "%DB_MODE%"=="" (
  if exist "%MODE_FILE%" (
    set /p DB_MODE=<"%MODE_FILE%"
  )
)
if "%DB_MODE%"=="" set "DB_MODE=wipe"

REM Prefer explicit 4th arg; else read update-ssl-certs.txt (1 = opt-in from Setup checkbox).
if "%UPDATE_SSL%"=="" (
  if exist "%SSL_FILE%" (
    set /p UPDATE_SSL=<"%SSL_FILE%"
  )
)
if "%UPDATE_SSL%"=="" set "UPDATE_SSL=0"

> "%PROTOCOL%" echo MultiLogicTradePg installation protocol
>> "%PROTOCOL%" echo Started: %DATE% %TIME%
>> "%PROTOCOL%" echo InstallDir: %INSTALL_DIR%
>> "%PROTOCOL%" echo DbMode: %DB_MODE%
>> "%PROTOCOL%" echo UpdateSslCerts: %UPDATE_SSL%
>> "%PROTOCOL%" echo Wrapper: %~f0
>> "%PROTOCOL%" echo PowerShell: %POWERSHELL%
if exist "%INSTALL_DIR%\VERSION.txt" (
  >> "%PROTOCOL%" echo.
  >> "%PROTOCOL%" echo ----- VERSION.txt -----
  type "%INSTALL_DIR%\VERSION.txt" >> "%PROTOCOL%"
  >> "%PROTOCOL%" echo ----- end VERSION.txt -----
) else (
  >> "%PROTOCOL%" echo VERSION.txt: MISSING (old or incomplete Setup.exe)
)
>> "%PROTOCOL%" echo.
>> "%PROTOCOL%" echo ================ POST-INSTALL OUTPUT ================

if not exist "%POWERSHELL%" (
  >> "%PROTOCOL%" echo [ERROR] powershell.exe was not found: %POWERSHELL%
  exit /b 3
)

set "MLTPG_PROTOCOL_CAPTURED=1"
REM install.ps1 must stay ASCII-safe (em-dash/UTF-8 breaks parse under some code pages).
set "SSL_SWITCH="
if "%UPDATE_SSL%"=="1" set "SSL_SWITCH=-UpdateSslCerts"
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" -InstallDir "%INSTALL_DIR%" -PostgresPassword "%PG_PASSWORD%" -DbMode "%DB_MODE%" %SSL_SWITCH% -SkipAppProtocol >> "%PROTOCOL%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

>> "%PROTOCOL%" echo.
>> "%PROTOCOL%" echo ================ POST-INSTALL EXIT ================
>> "%PROTOCOL%" echo Finished: %DATE% %TIME%
>> "%PROTOCOL%" echo ExitCode: %EXIT_CODE%

endlocal & exit /b %EXIT_CODE%
