@echo off
set SCRIPT_DIR=%~dp0
where pwsh >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  pwsh -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" -Mode ui
) else (
  powershell -ExecutionPolicy Bypass -File "%SCRIPT_DIR%install.ps1" -Mode ui
)
