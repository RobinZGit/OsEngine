@echo off
setlocal EnableExtensions

set "INSTALL_DIR=%~1"
set "PG_PASSWORD=%~2"
set "SCRIPT_DIR=%~dp0"
set "PROTOCOL=%INSTALL_DIR%\INSTALL_PROTOCOL.txt"
set "POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"

if "%INSTALL_DIR%"=="" (
  echo [ERROR] InstallDir argument is missing.
  exit /b 2
)

if "%PG_PASSWORD%"=="" set "PG_PASSWORD=111"

> "%PROTOCOL%" echo MultiLogicTradePg installation protocol
>> "%PROTOCOL%" echo Started: %DATE% %TIME%
>> "%PROTOCOL%" echo InstallDir: %INSTALL_DIR%
>> "%PROTOCOL%" echo Wrapper: %~f0
>> "%PROTOCOL%" echo PowerShell: %POWERSHELL%
>> "%PROTOCOL%" echo.
>> "%PROTOCOL%" echo ================ POST-INSTALL OUTPUT ================

if not exist "%POWERSHELL%" (
  >> "%PROTOCOL%" echo [ERROR] powershell.exe was not found: %POWERSHELL%
  exit /b 3
)

set "MLTPG_PROTOCOL_CAPTURED=1"
"%POWERSHELL%" -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" -InstallDir "%INSTALL_DIR%" -PostgresPassword "%PG_PASSWORD%" -SkipAppProtocol >> "%PROTOCOL%" 2>&1
set "EXIT_CODE=%ERRORLEVEL%"

>> "%PROTOCOL%" echo.
>> "%PROTOCOL%" echo ================ POST-INSTALL EXIT ================
>> "%PROTOCOL%" echo Finished: %DATE% %TIME%
>> "%PROTOCOL%" echo ExitCode: %EXIT_CODE%

endlocal & exit /b %EXIT_CODE%
