#!/bin/bash
# Symbiote Dashboard — Start Script
# Usage: ./start.sh [dev|prod]

set -e

MODE="${1:-prod}"

if [ "$MODE" = "dev" ]; then
    echo "🔧 Starting Symbiote Dashboard in development mode..."
    npm run dev
elif [ "$MODE" = "prod" ]; then
    echo "🚀 Building and starting Symbiote Dashboard in production mode..."
    npm run build
    echo "✅ Build complete. Starting server..."
    NODE_ENV=production node dist/server.cjs
else
    echo "Usage: ./start.sh [dev|prod]"
    exit 1
fi
