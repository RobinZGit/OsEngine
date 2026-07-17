@echo off
chcp 65001 >nul
color 0F
title MultiLogic_Trade_Progress_Start
setlocal EnableDelayedExpansion

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

where node >nul 2>&1
if errorlevel 1 (
  echo  [ОШИБКА] Node.js не найден. Установите Node.js 18+
  goto :end_pause
)

if "%PGPASSWORD%"=="" set "PGPASSWORD=111"

REM --- Снять старые процессы (можно запускать bat сколько угодно раз) ---
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
  call npm install
  if errorlevel 1 goto :fail
  popd
) else (
  echo  [2/5] api — OK
)

if not exist "%WEB%\node_modules\" (
  echo  [3/5] npm install в web...
  pushd "%WEB%"
  call npm install
  if errorlevel 1 goto :fail
  popd
) else (
  echo  [3/5] web — OK
)

echo  [4/5] Очистка кэша Angular (чтобы UI точно подхватил свежий код)...
pushd "%WEB%"
if exist ".angular\cache" (
  rmdir /s /q ".angular\cache" 2>nul
  echo       удален .angular\cache
) else (
  echo       .angular\cache отсутствует
)
call npx --yes ng cache clean >nul 2>&1
popd

echo  [5/5] Запуск в ЭТОМ окне...
echo.
echo  API:     http://localhost:3000  (фон)
echo  Angular: http://localhost:4200  (ниже, дождитесь сборки)
echo.
echo  Ctrl+C — остановить Angular и API
echo  --------------------------------------------------------
echo.

pushd "%API%"
start /b "" cmd /c "set PGPASSWORD=%PGPASSWORD%&& set PGHOST=localhost&& set PGDATABASE=multilogictrade&& set PGUSER=postgres&& set TRADE_RUNNER_INTERVAL_MS=15000&& node server.js"
popd

ping 127.0.0.1 -n 3 >nul

REM Cache-bust: query-параметр, чтобы браузер не взял старый бандл из HTTP-кэша.
set "CACHE_BUST=%RANDOM%"
start /b "" cmd /c "ping 127.0.0.1 -n 28 >nul && start http://localhost:4200/?v=%CACHE_BUST%"

pushd "%WEB%"
call npx ng serve --port 4200 --host localhost --open=false --configuration=development
set "NG_EXIT=!ERRORLEVEL!"
popd

echo.
echo  Остановка API...
call :FreePorts

if !NG_EXIT! neq 0 (
  echo  Angular завершился с кодом !NG_EXIT!
  goto :end_pause
)

echo  Готово.
ping 127.0.0.1 -n 3 >nul
exit /b 0

REM ============================================================
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

:fail
echo.
echo  [ОШИБКА] npm install не удался.
goto :end_pause

:end_pause
echo.
pause
exit /b 1
