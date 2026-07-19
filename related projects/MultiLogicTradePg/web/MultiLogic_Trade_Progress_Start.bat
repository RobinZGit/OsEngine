@echo off
setlocal EnableExtensions EnableDelayedExpansion
color 0F
title MultiLogic Trade - API + Angular
set "EXIT_CODE=1"

REM Always start from this script's folder (web\)
cd /d "%~dp0"

set "WEB=%~dp0"
set "WEB=%WEB:~0,-1%"
set "API=%WEB%\..\api"
for %%I in ("%API%") do set "API=%%~fI"
for %%I in ("%WEB%") do set "WEB=%%~fI"

echo.
echo  ========================================================
echo   MultiLogic Trade Progress Start
echo   One window: API :3000 + Angular :4200 + PostgreSQL
echo  ========================================================
echo.
echo  WEB: %WEB%
echo  API: %API%
echo.

REM Refresh PATH (Node from Setup is invisible to Explorer until re-login).
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

REM Default DB password from installer; override from api\.env if present.
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
set "CORS_ORIGIN=http://localhost:4200,http://127.0.0.1:4200"
set "TRADE_RUNNER_INTERVAL_MS=15000"

if not exist "%API%\server.js" (
  echo  [ERROR] API server.js was not found: %API%\server.js
  goto :end_pause
)
if not exist "%WEB%\package.json" (
  echo  [ERROR] web package.json was not found: %WEB%\package.json
  goto :end_pause
)

echo  [1/5] Free ports 3000 and 4200...
call :FreePorts
if errorlevel 1 (
  echo  [WARN] Port is still busy. Retrying...
  call :FreePorts
)
echo.

if not exist "%API%\node_modules\" (
  echo  [ERROR] api\node_modules was not found.
  echo          Reinstall MultiLogicTradePgSetup.exe as Administrator.
  goto :missing_node_modules
)
echo  [2/5] api - OK (node_modules exists)

if not exist "%WEB%\node_modules\" (
  echo  [ERROR] web\node_modules was not found.
  echo          Reinstall MultiLogicTradePgSetup.exe as Administrator.
  goto :missing_node_modules
)
if not exist "%WEB%\node_modules\@angular\cli\bin\ng.js" (
  echo  [ERROR] Angular CLI was not found in web\node_modules.
  echo          Reinstall MultiLogicTradePgSetup.exe as Administrator.
  goto :missing_node_modules
)
echo  [3/5] web - OK (node_modules exists)

echo  [4/5] Angular cache cleanup...
pushd "%WEB%"
if exist ".angular\cache" (
  rmdir /s /q ".angular\cache" 2>nul
  echo       removed .angular\cache
) else (
  echo       .angular\cache not found
)
REM Program Files is read-only for normal users unless installer granted Users modify.
mkdir ".angular\cache" 2>nul
if not exist ".angular\cache\" (
  echo  [ERROR] Cannot create web\.angular\cache under Program Files ^(EPERM^).
  echo          Reinstall MultiLogicTradePgSetup.exe as Administrator
  echo          ^(post-install grants Users write access for Angular/Vite cache^).
  popd
  goto :end_pause
)
call node "%WEB%\node_modules\@angular\cli\bin\ng.js" cache clean >nul 2>&1
popd

echo  [5/5] Start in THIS window (do not close it)...
echo.
echo  API:     http://localhost:%PORT%  (background)
echo  Angular: http://localhost:4200  (below; wait for compilation)
echo.
echo  Ctrl+C - stop Angular and API
echo  --------------------------------------------------------
echo.

pushd "%API%"
if not exist "logs" mkdir "logs" 2>nul
echo.>> "logs\api.log"
echo ===== API start %DATE% %TIME% =====>> "logs\api.log"
start "MultiLogic API" /b cmd /c "node server.js >> logs\api.log 2>&1"
popd

REM Give API a moment to bind the port.
ping 127.0.0.1 -n 3 >nul

REM Open browser after Angular has time to compile. Do not nest cmd/start quotes here.
set "CACHE_BUST=%RANDOM%"
start "MultiLogic Browser Opener" /min powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Sleep -Seconds 27; Start-Process 'http://localhost:4200/?v=%CACHE_BUST%'"

pushd "%WEB%"
echo  Launch: ng serve --port 4200 ...
call node "%WEB%\node_modules\@angular\cli\bin\ng.js" serve --port 4200 --host localhost --open=false --configuration=development
set "NG_EXIT=!ERRORLEVEL!"
popd

echo.
echo  Stopping API and freeing ports...
call :FreePorts

if not "!NG_EXIT!"=="0" (
  set "EXIT_CODE=!NG_EXIT!"
  echo  [ERROR] Angular exited with code !NG_EXIT!
  goto :end_pause
)

set "EXIT_CODE=0"
echo  Angular stopped. Done.
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

:FreePorts
call :FreeOnePort 3000
call :FreeOnePort 4200
exit /b 0

:FreeOnePort
set "FP=%~1"
REM Use PowerShell 2>$null (not cmd 2>nul) — otherwise Out-File fails on "nul" device.
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
