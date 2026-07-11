#!/usr/bin/env bash
#
# Rsync the local daemon/ tree to the EC2 instance running futurator-daemon,
# verify the new code landed, and restart the systemd service so the running
# process actually picks up the new code.
#
# Preserves /opt/futurator-daemon/.env and /opt/futurator-daemon/node_modules
# on the remote side; everything else under /opt/futurator-daemon/ is
# replaced with the local tree.
#
# Usage:
#   ./scripts/rsync-daemon.sh [--dry-run] [--no-restart]
#
# Flags:
#   --dry-run     Pass -n to rsync — shows what WOULD change, touches nothing.
#   --no-restart  Push files but do not restart the systemd service. Useful
#                 when the daemon is mid-job and you want to defer the restart.
#                 NOTE: until you restart, the running process keeps the OLD
#                 code in memory — none of your changes take effect.
#
# 2026-05-02 incident: PR-11/12/13 rsyncs claimed success but the EC2 file
# was 2 weeks stale because (a) earlier rsync attempts didn't actually push
# the updated file, and (b) the script never restarted systemd, so even if
# files had landed the running process kept old in-memory code. This script
# now (1) hashes the local + remote agent-daemon.mjs after rsync to confirm
# the bytes match, and (2) restarts the systemd unit by default.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
LOCAL_DAEMON="$REPO_ROOT/daemon/"
REMOTE_HOST="ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com"
REMOTE_PATH="/opt/futurator-daemon/"
SSH_KEY="$HOME/.ssh/debatator-memgraph.pem"

DRY_FLAG=""
RESTART=1
for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_FLAG="-n"
      echo ">>> DRY RUN — no files will change on the remote"
      ;;
    --no-restart)
      RESTART=0
      echo ">>> --no-restart given: will NOT restart systemd after rsync"
      ;;
  esac
done

if [[ ! -d "$LOCAL_DAEMON" ]]; then
  echo "error: local daemon dir not found at $LOCAL_DAEMON" >&2
  exit 1
fi
if [[ ! -f "$SSH_KEY" ]]; then
  echo "error: SSH key not found at $SSH_KEY" >&2
  exit 1
fi

SSH="ssh -i $SSH_KEY -o StrictHostKeyChecking=no"

# Pipeline v2.0 PR-8f #1 — build CJS bundles consumed by shell-step
# `node -e` calls. qa-aggregate requires
# daemon/lib/visual-test-classifier-bundle.cjs at runtime; without this
# the QA stage breaks at module-resolve time on EC2.
echo ">>> Building daemon CJS bundles"
node "$REPO_ROOT/scripts/build-daemon-bundles.mjs"

echo ">>> Pushing $LOCAL_DAEMON -> $REMOTE_HOST:$REMOTE_PATH"

rsync -av --delete $DRY_FLAG \
  --exclude node_modules \
  --exclude .env \
  --exclude sst-env.d.ts \
  --exclude '*.log' \
  -e "$SSH" \
  "$LOCAL_DAEMON" \
  "$REMOTE_HOST:$REMOTE_PATH"

echo ">>> rsync complete"

if [[ -n "$DRY_FLAG" ]]; then
  echo ">>> dry-run: skipping verification + restart"
  exit 0
fi

# ── Verify: local and remote agent-daemon.mjs hashes must match ──
LOCAL_HASH=$(shasum -a 256 "$LOCAL_DAEMON/agent-daemon.mjs" | awk '{print $1}')
REMOTE_HASH=$($SSH "$REMOTE_HOST" "sha256sum /opt/futurator-daemon/agent-daemon.mjs | awk '{print \$1}'")
if [[ "$LOCAL_HASH" != "$REMOTE_HASH" ]]; then
  echo "error: agent-daemon.mjs hash mismatch after rsync" >&2
  echo "  local:  $LOCAL_HASH" >&2
  echo "  remote: $REMOTE_HASH" >&2
  echo "  this means the file did not land — investigate before declaring deploy done." >&2
  exit 1
fi
echo ">>> verified agent-daemon.mjs hash matches ($LOCAL_HASH)"

if [[ "$RESTART" -eq 0 ]]; then
  echo ">>> --no-restart: NOT restarting systemd (running process still has OLD code in memory)"
  exit 0
fi

# ── Ensure Playwright's Chromium is installed (idempotent) ──
# Visual QA (qa-prepare + L2 judges) shells out to `npx playwright screenshot`.
# Without the browser binary, screenshot capture silently yields 0/N and the
# VQA gate passes on nothing (dino1 2026-06-01). `playwright install chromium`
# is a no-op when the matching build is already cached.
# CHROMIUM ONLY: the pipeline is Chromium-only (see CLAUDE.md "Playwright:
# Chromium only"). Never run bare `playwright install` — it pulls firefox +
# webkit too (~0.8G of unused browsers that filled the 19G root fs).
echo ">>> Ensuring Playwright Chromium is installed on the daemon host"
$SSH "$REMOTE_HOST" "ls ~/.cache/ms-playwright/chromium_headless_shell-* >/dev/null 2>&1 && echo 'chromium present' || (cd /home/ubuntu && npx -y playwright install chromium 2>&1 | tail -2)" || \
  echo ">>> WARN: playwright install step failed (non-fatal) — visual QA may not capture screenshots"

# snake3 (2026-06-10) — the L2 flow executor imports the playwright LIBRARY
# (not just the CLI); keep daemon node_modules current so
# /opt/futurator-daemon/node_modules/playwright is importable from QA steps.
# CHROMIUM ONLY: PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD stops playwright's npm
# postinstall from auto-fetching ALL browsers (firefox + webkit). The
# explicit `playwright install chromium` step above is the sole browser source.
echo ">>> Ensuring daemon node_modules are current (playwright lib for L2 flow executor)"
$SSH "$REMOTE_HOST" "cd /opt/futurator-daemon && sudo env PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --omit=dev --no-audit --no-fund 2>&1 | tail -2" || \
  echo ">>> WARN: daemon npm install failed (non-fatal) — L2 flow tests fall back to idle screenshots"

# ── Ensure DAEMON_SOURCE=ec2 in the remote .env (Queues module) ──
# The daemon defaults DAEMON_SOURCE to 'local' (agent-daemon.mjs). On the EC2
# host it MUST be 'ec2' so it (a) reads the correct per-source concurrency cap
# flag (`concurrency.maxConcurrent.ec2`, set from the EC2 Monitor) and (b)
# enforces Local/EC2 queue-request target routing. `.env` is rsync-excluded, so
# this self-heals the value on every deploy and survives instance replacement
# where a fresh .env would otherwise omit it. Idempotent.
echo ">>> Ensuring DAEMON_SOURCE=ec2 in remote .env"
$SSH "$REMOTE_HOST" "grep -q '^DAEMON_SOURCE=' /opt/futurator-daemon/.env && sudo sed -i 's/^DAEMON_SOURCE=.*/DAEMON_SOURCE=ec2/' /opt/futurator-daemon/.env || echo 'DAEMON_SOURCE=ec2' | sudo tee -a /opt/futurator-daemon/.env >/dev/null"

# ── Restart systemd so the running process picks up new code ──
echo ">>> Restarting futurator-daemon systemd unit"
$SSH "$REMOTE_HOST" "sudo systemctl restart futurator-daemon"
sleep 3

# Confirm the unit is active and the new process started recently
STATUS=$($SSH "$REMOTE_HOST" "systemctl is-active futurator-daemon")
if [[ "$STATUS" != "active" ]]; then
  echo "error: futurator-daemon is not active after restart (status=$STATUS)" >&2
  $SSH "$REMOTE_HOST" "journalctl -u futurator-daemon -n 30 --no-pager" >&2
  exit 1
fi
PROC=$($SSH "$REMOTE_HOST" "ps -eo pid,etime,cmd | grep agent-daemon.mjs | grep -v grep | head -1")
echo ">>> daemon active: $PROC"
echo ">>> deploy complete"
