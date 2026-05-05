#!/bin/bash
# Install the Futurator OAuth helper on your Mac. Two pieces:
#
#   1. mac-oauth-server.mjs — long-lived process listening on 127.0.0.1:9876.
#      The admin UI POSTs /sync to it when you click Re-authorize EC2.
#      Auto-syncs every 5 minutes too, so EC2 stays fresh hands-off.
#
#   2. mac-oauth-sync.sh — the actual Keychain → SSM push, callable directly
#      from a terminal too if you ever need to debug.
#
# Installs as a launchd KeepAlive=true agent so it auto-restarts on crash and
# starts at every login.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SYNC_SCRIPT="$SCRIPT_DIR/mac-oauth-sync.sh"
SERVER_SCRIPT="$SCRIPT_DIR/mac-oauth-server.mjs"
LABEL="ai.futurator.oauth-server"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [ ! -f "$SYNC_SCRIPT" ] || [ ! -f "$SERVER_SCRIPT" ]; then
  echo "ERROR: helper scripts not found in $SCRIPT_DIR" >&2
  exit 1
fi
chmod +x "$SYNC_SCRIPT" "$SERVER_SCRIPT"

# Find Node — prefer the project's Node, fall back to PATH.
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: 'node' not found on PATH. Install Node.js first." >&2
  exit 1
fi

# Stop any previous version (server or older 4-hourly script).
launchctl unload "$HOME/Library/LaunchAgents/ai.futurator.oauth-sync.plist" 2>/dev/null || true
launchctl unload "$PLIST" 2>/dev/null || true

mkdir -p "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$SERVER_SCRIPT</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>/tmp/futurator-oauth-server.log</string>
  <key>StandardErrorPath</key><string>/tmp/futurator-oauth-server.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
EOF

launchctl load "$PLIST"

echo "✓ Installed $LABEL"
echo "  - listens on http://127.0.0.1:9876 (POST /sync, GET /status)"
echo "  - auto-syncs Keychain → EC2 every 5 minutes"
echo "  - log: /tmp/futurator-oauth-server.log"
echo
echo "Verify it's healthy:"
echo "  curl -s http://127.0.0.1:9876/status | python3 -m json.tool"
echo
echo "In the admin UI: click the 🔁 Re-authorize EC2 button when auth fails."
