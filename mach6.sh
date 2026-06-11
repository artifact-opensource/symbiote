#!/bin/bash
# Get the directory of the script
DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"

# Change to the script's directory
cd "$DIR"

# Start the symbiote daemon in the background
node dist/gateway/daemon.js --config=symbiote.json &
