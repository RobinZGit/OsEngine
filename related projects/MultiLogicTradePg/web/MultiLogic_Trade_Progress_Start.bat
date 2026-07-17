@echo off
setlocal EnableExtensions EnableDelayedExpansion
chcp 65001 >nul
color 0F
title MultiLogic Trade — API + Angular

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
echo   Одно окно: API :3000 + Angular :4200 + PostgreSQL
echo  ========================================================
echo.
echo  WEB: %WEB%
echo  API: %API%
echo.

REM --- Refresh PATH (Node/npm installed by Setup are invisible to Explorer until re-login) ---
call :RefreshPath
if exist "%ProgramFiles%\nodejs\node.exe" set "PATH=%ProgramFiles%\nodejs;%PATH%"
if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "PATH=%ProgramFiles(x86)%\nodejs;%PATH%"
if exist "%LocalAppData%\Programs\node\node.exe" set "PATH=%LocalAppData%\Programs\node;%PATH%"

where node >nul 2>&1
if errorlevel 1 (
  echo  [ОШИБКА] Node.js не найден в PATH.
  echo           Перезайдите в Windows после установки или переустановите Node.js 18+.
  goto :end_pause
)
for /f "delims=" %%V in ('node -v 2^>nul') do echo  Node: %%V

where npm >nul 2>&1
if errorlevel 1 (
  echo  [ОШИБКА] npm не найден. Проверьте установку Node.js.
  goto :end_pause
)

REM Default DB password from installer; override from api\.env if present
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

if not exist "%API%\server.js" (
  echo  [ОШИБКА] Не найден API: %API%\server.js
  goto :end_pause
)
if not exist "%WEB%\package.json" (
  echo  [ОШИБКА] Не найден web\package.json
  goto :end_pause
)

REM --- Free old processes (can relaunch this bat anytime) ---
echo  [1/5] Освобождение портов 3000 и 4200...
call :FreePorts
if errorlevel 1 (
  echo  [ПРЕДУПРЕЖДЕНИЕ] Порт всё ещё занят. Повторная попытка...
  call :FreePorts
)
echo.

if not exist "%API%\node_modules\" (
  echo  [2/5] npm install в api...
  pushd "%API%"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    popd
    goto :fail_npm
  )
  popd
) else (
  echo  [2/5] api — OK ^(node_modules есть^)
)

if not exist "%WEB%\node_modules\" (
  echo  [3/5] npm install в web...
  pushd "%WEB%"
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    popd
    goto :fail_npm
  )
  popd
) else (
  echo  [3/5] web — OK ^(node_modules есть^)
)

echo  [4/5] Очистка кэша Angular...
pushd "%WEB%"
if exist ".angular\cache" (
  rmdir /s /q ".angular\cache" 2>nul
  echo       удалён .angular\cache
) else (
  echo       .angular\cache отсутствует
)
call npx --yes ng cache clean >nul 2>&1
popd

echo  [5/5] Запуск в ЭТОМ окне ^(окно не закрывать^)...
echo.
echo  API:     http://localhost:%PORT%  ^(фон^)
echo  Angular: http://localhost:4200  ^(ниже, дождитесь сборки^)
echo.
echo  Ctrl+C — остановить Angular и API
echo  --------------------------------------------------------
echo.

set "CORS_ORIGIN=http://localhost:4200"
set "TRADE_RUNNER_INTERVAL_MS=15000"

pushd "%API%"
start "MultiLogic API" /b cmd /c node server.js
popd

REM Give API a moment to bind the port
ping 127.0.0.1 -n 3 >nul

REM Open browser after Angular has time to compile
set "CACHE_BUST=%RANDOM%"
start /b "" cmd /c "ping 127.0.0.1 -n 28 >nul && start \"\" \"http://localhost:4200/?v=%CACHE_BUST%\""

pushd "%WEB%"
echo  Запуск: npx ng serve --port 4200 ...
call npx ng serve --port 4200 --host localhost --open=false --configuration=development
set "NG_EXIT=!ERRORLEVEL!"
popd

echo.
echo  Остановка API и освобождение портов...
call :FreePorts

if not "!NG_EXIT!"=="0" (
  echo  [ОШИБКА] Angular завершился с кодом !NG_EXIT!
  goto :end_pause
)

echo  Angular остановлен. Готово.
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
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$p=%FP%; for($i=0;$i -lt 5;$i++){" ^
  "  $c=Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue;" ^
  "  if(-not $c){ exit 0 };" ^
  "  $c | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object {" ^
  "    Write-Host ('       PID '+$_+' port '+$p);" ^
  "    Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue;" ^
  "    cmd /c taskkill /F /T /PID $_ 2>nul | Out-Null" ^
  "  };" ^
  "  Start-Sleep -Milliseconds 800" ^
  "};" ^
  "if(Get-NetTCPConnection -LocalPort $p -State Listen -EA SilentlyContinue){ exit 1 } else { exit 0 }"
exit /b !ERRORLEVEL!

:fail_npm
echo.
echo  [ОШИБКА] npm install не удался.
goto :end_pause

:end_pause
echo.
echo  --------------------------------------------------------
echo  Окно останется открытым. Нажмите любую клавишу, чтобы закрыть.
echo  --------------------------------------------------------
pause
endlocal
exit /b 1
