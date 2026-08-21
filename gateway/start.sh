#!/bin/sh
# Start Tor, wait for its SOCKS port, then launch the gateway. Busybox-ash safe.
set -e

tor --SocksPort 9050 --Log "notice stdout" &
TOR_PID=$!

echo "waiting for Tor SOCKS on 9050..."
i=0
while [ "$i" -lt 60 ]; do
  if nc -z 127.0.0.1 9050 2>/dev/null; then
    echo "Tor SOCKS up; giving circuits a moment..."
    sleep 5
    break
  fi
  i=$((i + 1))
  sleep 1
done

node server.mjs &
APP_PID=$!

# If either process exits, stop the container so the orchestrator restarts it.
while kill -0 "$TOR_PID" 2>/dev/null && kill -0 "$APP_PID" 2>/dev/null; do
  sleep 5
done
echo "a process exited; shutting down"
kill "$TOR_PID" "$APP_PID" 2>/dev/null || true
exit 1
