# Get the directory of the script
$DIR = Split-Path -Parent $MyInvocation.MyCommand.Path

# Change to the script's directory
Set-Location $DIR

# Start the symbiote daemon as a background job
Start-Job -ScriptBlock { node dist/gateway/daemon.js --config=symbiote.json }
