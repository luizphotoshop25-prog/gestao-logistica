@echo off
cd /d "%~dp0"
start "Gestao Logistica" /min cmd.exe /c npm.cmd run dev
exit /b 0
