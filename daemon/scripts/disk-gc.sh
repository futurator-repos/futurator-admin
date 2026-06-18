#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# disk-gc.sh — Idempotent host disk garbage-collection for the Futurator daemon
#
# Encodes the hand-validated cleanup that recovered the EC2 root fs from
# 71% → 53% (i-0826d68c316ae97dd, 19G root). Targets the recurring offenders:
# unpruned npm cache, non-Chromium Playwright browsers (pipeline is
# Chromium-only per CLAUDE.md), node compile cache, stale VQA/QA /tmp scratch,
# and uncapped journald.
#
# SAFE by design:
#   - set +e: a single failing step never aborts the rest of the run.
#   - /tmp scratch is only removed when older than 120 min (protects active runs).
#   - NEVER touches: /home/ubuntu/projects, /opt/futurator-daemon,
#     /var/lib/memgraph, /var/lib/amazon.
#
# Usage:
#   bash disk-gc.sh           # run as user ubuntu (uses sudo for root-owned bits)
#
# Scheduled weekly by daemon/systemd/futurator-disk-gc.{service,timer}.
#
# Exit codes:
#   0 — always (best-effort cleanup; failures of individual steps are tolerated)
# ──────────────────────────────────────────────────────────────────────────────

set +e

echo "── disk-gc starting $(date -u +%Y-%m-%dT%H:%M:%SZ) ──"
echo "── df / BEFORE ──"
df -h /

BEFORE_KB=$(df -P / | awk 'NR==2 {print $4}')

# ── 1. npm cache (user + root) ──
echo "── npm cache clean ──"
npm cache clean --force
sudo npm cache clean --force

# ── 2. Playwright: drop non-Chromium browsers (Chromium-only pipeline) ──
echo "── prune ~/.cache/ms-playwright (keep chromium*/ffmpeg*) ──"
PW_DIR="${HOME}/.cache/ms-playwright"
if [ -d "$PW_DIR" ]; then
  for d in "$PW_DIR"/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    case "$name" in
      chromium*|ffmpeg*) : ;;            # keep
      *) echo "  removing $name"; rm -rf "$d" ;;
    esac
  done
fi

# ── 3. node compile cache ──
echo "── clear /tmp/node-compile-cache ──"
rm -rf /tmp/node-compile-cache

# ── 4. stale pipeline scratch in /tmp (only if idle > 120 min) ──
echo "── delete stale /tmp pipeline scratch (mmin +120) ──"
find /tmp -maxdepth 1 -mmin +120 \
  \( -name 'qa-*' \
     -o -name 'wave-vqa-*' \
     -o -name 'playwright_chromiumdev_profile-*' \
     -o -name 'playwright-artifacts-*' \) \
  -exec rm -rf {} +

# ── 5. journald + apt ──
echo "── journald vacuum + apt clean/autoremove ──"
sudo journalctl --vacuum-size=100M
sudo apt-get clean
sudo DEBIAN_FRONTEND=noninteractive apt-get autoremove --purge -y

# ── Summary ──
echo "── df / AFTER ──"
df -h /

AFTER_KB=$(df -P / | awk 'NR==2 {print $4}')
FREED_KB=$(( AFTER_KB - BEFORE_KB ))
echo "── freed: $(( FREED_KB / 1024 )) MiB (avail ${BEFORE_KB}K → ${AFTER_KB}K) ──"
echo "── disk-gc done $(date -u +%Y-%m-%dT%H:%M:%SZ) ──"

exit 0
