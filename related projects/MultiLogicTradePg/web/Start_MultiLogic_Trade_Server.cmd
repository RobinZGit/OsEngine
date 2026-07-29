@echo off
REM Desktop/Start Menu: API-only server (headless live trading).
cd /d "%~dp0"
title MultiLogic Trade Server
call "%~dp0MultiLogic_Trade_Server_Start.bat"
echo.
pause
