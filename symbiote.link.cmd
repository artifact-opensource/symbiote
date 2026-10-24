@echo off
setlocal
set "ROOT=%~dp0"

where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required to start Symbiote.
  echo Install Node.js, then double-click this launcher again.
  pause
  exit /b 1
)

node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)" >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required to start Symbiote.
  echo Install Node.js, then double-click this launcher again.
  pause
  exit /b 1
)

pushd "%ROOT%" || (
  echo Could not open the Symbiote repository folder.
  pause
  exit /b 1
)

node "%ROOT%scripts\start-desktop.mjs"
set "EXIT_CODE=%ERRORLEVEL%"
popd

if not "%EXIT_CODE%"=="0" (
  echo.
  echo Symbiote could not start. See .session\desktop-launch.log for diagnostics.
  pause
)
exit /b %EXIT_CODE%
