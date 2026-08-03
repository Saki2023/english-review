@echo off
chcp 65001 >nul
set "ROOT=%~dp0..\.."
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\学习同步\启动同步中心.ps1" %*
if errorlevel 1 pause
