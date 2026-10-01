#!/usr/bin/env pwsh
# Symbiote — Windows PowerShell launcher
# Mirrors symbiote.sh: forwards all arguments to the CLI router (dist/index.js),
# which handles start/stop/restart/status/logs/configure/agent/etc.
#
# Usage:
#   .\symbiote.ps1 start
#   .\symbiote.ps1 status --config=mach6.json
#   .\symbiote.ps1                (interactive REPL)

$ErrorActionPreference = 'Stop'
$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$EntryPoint = Join-Path $Dir 'dist\index.js'

if (-not (Test-Path $EntryPoint)) {
  Write-Host "  ✗ $EntryPoint not found — run 'npm install && npm run build' first." -ForegroundColor Red
  exit 1
}

& node $EntryPoint @args
exit $LASTEXITCODE
