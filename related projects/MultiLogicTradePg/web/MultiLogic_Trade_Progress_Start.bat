@echo off
setlocal EnableExtensions
cd /d "%~dp0"
set "LAUNCH_EXIT=1"

set "LAUNCH_PS=%~dp0..\scripts\launch_multilogictrade.ps1"
if not exist "%LAUNCH_PS%" (
  echo [ERROR] Launcher script not found:
  echo %LAUNCH_PS%
  goto end_pause
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%LAUNCH_PS%"
set "LAUNCH_EXIT=%ERRORLEVEL%"

:end_pause
echo.
echo --------------------------------------------------------
echo Window will stay open. Press any key to close.
echo --------------------------------------------------------
pause
endlocal & exit /b %LAUNCH_EXIT%
