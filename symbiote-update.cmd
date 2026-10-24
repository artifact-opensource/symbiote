@echo off
setlocal
set "ROOT=%~dp0"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%ROOT%scripts\windows\update-symbiote.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Symbiote update failed. Review the error above; local changes are never overwritten.
  pause
)
exit /b %EXIT_CODE%
