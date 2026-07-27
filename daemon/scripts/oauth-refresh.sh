#!/bin/bash
# futurator-oauth-refresh.sh — re-fetch fresh Claude Code OAuth credentials from
# the admin relay so a long-lived fleet box keeps authenticating against the Max
# subscription instead of expiring.
#
# WHY (2026-07-27 incident): cloud-init fetches Claude creds ONCE at boot; a box
# up for days lets the token expire → every Claude step (planner, skill-scout,
# story-dev) fails "Claude Code OAuth expired". The legacy Mac `mac-oauth-sync.sh`
# only pushes to the dead old EC2 over SSM, so GCP/Hetzner/Oracle boxes never got
# refreshed. This timer re-pulls fresh tokens (served by the running Mac
# oauth-server via the admin relay) every few hours, no operator action needed.
#
# Runs as the daemon user (ubuntu) via futurator-oauth-refresh.timer.
set -uo pipefail

# shellcheck source=/dev/null
. /etc/futurator/daemon.env 2>/dev/null || { echo "[oauth-refresh] no /etc/futurator/daemon.env"; exit 0; }
: "${ENROLL_TOKEN:?enroll token missing}" "${ADMIN_API_URL:?admin api url missing}"

CRED="${HOME:-/home/ubuntu}/.claude/.credentials.json"
TMP="$(mktemp)"

if curl -fsS --max-time 30 -H "x-server-token: ${ENROLL_TOKEN}" \
     "${ADMIN_API_URL}/api/servers/agent-credentials" -o "${TMP}" \
   && jq -e '.claudeAiOauth.accessToken // .accessToken' "${TMP}" >/dev/null 2>&1; then
  # Only replace the live creds once we have VALID Claude OAuth JSON — a 200 that
  # returns SPA HTML (wrong URL) must never clobber working credentials.
  mv "${TMP}" "${CRED}"
  chmod 600 "${CRED}"
  echo "[oauth-refresh] refreshed OK"
else
  rm -f "${TMP}"
  echo "[oauth-refresh] fetch failed — keeping existing credentials"
fi
