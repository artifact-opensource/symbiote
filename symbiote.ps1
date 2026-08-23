$Dir = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $Dir
node dist/gateway/daemon.js --config=mach6.json
