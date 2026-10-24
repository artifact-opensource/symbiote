@echo off
setlocal
set "ROOT=%~dp0"

if not exist "%ROOT%symbiote.exe" (
  echo The Symbiote launcher is missing: "%ROOT%symbiote.exe"
  echo Rebuild it with scripts\windows\build-launcher.ps1.
  pause
  exit /b 1
)

start "" "%ROOT%symbiote.exe"
exit /b 0
