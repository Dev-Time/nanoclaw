#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /home/whenke/nanoclaw/nanoclaw.pid)

set -euo pipefail

cd "/home/whenke/nanoclaw"

# Stop existing instance if running
if [ -f "/home/whenke/nanoclaw/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/home/whenke/nanoclaw/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/home/whenke/.nvm/versions/node/v22.22.2/bin/node" "/home/whenke/nanoclaw/dist/index.js" \
  >> "/home/whenke/nanoclaw/logs/nanoclaw.log" \
  2>> "/home/whenke/nanoclaw/logs/nanoclaw.error.log" &

echo $! > "/home/whenke/nanoclaw/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /home/whenke/nanoclaw/logs/nanoclaw.log"
