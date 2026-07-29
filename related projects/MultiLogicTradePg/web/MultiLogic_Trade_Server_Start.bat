@echo off
setlocal EnableExtensions EnableDelayedExpansion
color 0F
title MultiLogic Trade - API Server (headless)
set "EXIT_CODE=1"

REM API-only launcher for servers: trade runner works without Angular.
REM Keep this window open — closing it stops the API and live trading.

cd /d "%~dp0"

set "WEB=%~dp0"
set "WEB=%WEB:~0,-1%"
set "API=%WEB%\..\api"
for %%I in ("%API%") do set "API=%%~fI"
for %%I in ("%WEB%") do set "WEB=%%~fI"

echo.
echo  ========================================================
echo   MultiLogic Trade Server Start
echo   API :3000 only - live trading without Angular UI
echo  ========================================================
echo.
echo  WEB: %WEB%
echo  API: %API%
echo.

call :RefreshPath
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\node\node.exe" set "PATH=%LocalAppData%\Programs\node;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo  [ERROR] Node.js was not found in PATH.
  echo          Re-login to Windows after setup or reinstall Node.js 18+.
  goto :end_pause
)
for /f "delims=" %%V in ('node -v 2^>nul') do echo  Node: %%V

if "%PGPASSWORD%"=="" set "PGPASSWORD=111"
if exist "%API%\.env" (
  for /f "usebackq tokens=1,* delims==" %%A in ("%API%\.env") do (
    set "K=%%A"
    set "V=%%B"
    if /i "!K!"=="PGPASSWORD" if not "!V!"=="" set "PGPASSWORD=!V!"
    if /i "!K!"=="PGHOST" if not "!V!"=="" set "PGHOST=!V!"
    if /i "!K!"=="PGDATABASE" if not "!V!"=="" set "PGDATABASE=!V!"
    if /i "!K!"=="PGUSER" if not "!V!"=="" set "PGUSER=!V!"
    if /i "!K!"=="PORT" if not "!V!"=="" set "PORT=!V!"
  )
)
if "%PGHOST%"=="" set "PGHOST=localhost"
if "%PGDATABASE%"=="" set "PGDATABASE=multilogictrade"
if "%PGUSER%"=="" set "PGUSER=postgres"
if "%PORT%"=="" set "PORT=3000"
set "CORS_ORIGIN=http://localhost:4200"
set "TRADE_RUNNER_INTERVAL_MS=15000"
REM Headless: enabled logics trade while API is up (no Angular required).
set "TRADE_RUNNER_REQUIRE_UI=0"

if not exist "%API%\server.js" (
  echo  [ERROR] API server.js was not found: %API%\server.js
  goto :end_pause
)

echo  [1/3] Free port %PORT%...
call :FreeOnePort %PORT%
if errorlevel 1 (
  echo  [WARN] Port is still busy. Retrying...
  call :FreeOnePort %PORT%
)
echo.

if not exist "%API%\node_modules\" (
  echo  [ERROR] api\node_modules was not found.
  echo          Reinstall MultiLogicTradePgSetup.exe as Administrator.
  goto :missing_node_modules
)
echo  [2/3] api - OK (node_modules exists)

echo  [3/3] Start API in THIS window (do not close it)...
echo.
echo  API:     http://localhost:%PORT%
echo  Trading: headless (TRADE_RUNNER_REQUIRE_UI=0)
echo  UI:      optional - run MultiLogic_Trade_Progress_Start.bat when needed
echo.
echo  Ctrl+C - stop API and live trading
echo  Keep this window open. Every ~15s a "Trade cycle:" line should appear.
echo  --------------------------------------------------------
echo.

pushd "%API%"
node server.js
set "EXIT_CODE=!ERRORLEVEL!"
popd

echo.
echo  API stopped.
goto :end_pause

REM ============================================================
:RefreshPath
for /f "skip=2 tokens=1,2*" %%A in ('reg query "HKLM\SYSTEM\CurrentControlSet\Control\Session Manager\Environment" /v Path 2^>nul') do (
  if /i "%%A"=="Path" set "SYS_PATH=%%C"
)
for /f "skip=2 tokens=1,2*" %%A in ('reg query "HKCU\Environment" /v Path 2^>nul') do (
  if /i "%%A"=="Path" set "USR_PATH=%%C"
)
if defined SYS_PATH set "PATH=%SYS_PATH%;%PATH%"
if defined USR_PATH set "PATH=%USR_PATH%;%PATH%"
exit /b 0

:FreeOnePort
set "FP=%~1"
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=%FP%; for($i=0;$i -lt 5;$i++){" ^
  "  $c=@(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue);" ^
  "  if($c.Count -eq 0){ exit 0 };" ^
  "  $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {" ^
  "    $procId=$_; Write-Host ('       PID '+$procId+' port '+$p);" ^
  "    Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue;" ^
  "    & taskkill.exe /F /T /PID $procId 2>$null | Out-Null" ^
  "  };" ^
  "  Start-Sleep -Milliseconds 800" ^
  "};" ^
  "if(Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue){ exit 1 } else { exit 0 }"
exit /b !ERRORLEVEL!

:missing_node_modules
echo.
set "EXIT_CODE=1"
echo  [ERROR] Packages must be prepared by the installer, not by this launcher.
goto :end_pause

:end_pause
echo.
echo  --------------------------------------------------------
echo  Window will stay open. Press any key to close.
echo  --------------------------------------------------------
pause
endlocal & exit /b %EXIT_CODE%
