#!/bin/bash
set -e

echo "=== Initializing Naukri Automation Container ==="
echo "PORT: ${PORT:-3000}"

# Start Xvfb virtual frame buffer on display :99
echo "Starting virtual display (Xvfb)..."
Xvfb :99 -screen 0 1280x850x24 -nolisten tcp -ac &
export DISPLAY=:99

# Brief pause to ensure Xvfb socket is created
sleep 1

echo "Starting server.js (Web Dashboard & Hourly Auto-Refresh)..."
exec node server.js
