#!/usr/bin/env bash
# Story 1.1.3 — Configure daemon's git identity using PAT from SSM.
#
# Idempotent: re-running is a no-op.
# Reads the GitHub PAT from SST-managed SSM (path resolves at runtime), then
# configures git globally so `git clone`, `git fetch`, and `git push` against
# https://github.com/futurator-repos/* authenticate transparently.
#
# Called by daemon/agent-daemon.mjs once at startup before the main poll loop.

set -euo pipefail

# Quiet around the credential — never echo the token.
set +x

REGION="${AWS_REGION:-${AWS_DEFAULT_REGION:-us-east-1}}"
STAGE="${SST_STAGE:-production}"

# SST stores Secret('GithubPat') at a stage-namespaced SSM path. Resolve from
# the most likely SST conventions in order; fall back to the custom rotation
# path written by Settings → GitHub (Story 1.7.1).
SSM_PATHS=(
  "/sst/futurator-admin/${STAGE}/Secret/GithubPat/value"
  "/sst/Futurator-Admin/${STAGE}/Secret/GithubPat/value"
  "/futurator/_pipeline/github-pat"
)

PAT=""
for path in "${SSM_PATHS[@]}"; do
  if PAT=$(aws ssm get-parameter \
    --name "$path" \
    --with-decryption \
    --region "$REGION" \
    --query 'Parameter.Value' \
    --output text 2>/dev/null); then
    if [ -n "$PAT" ] && [ "$PAT" != "None" ]; then
      echo "[configure-git-identity] PAT loaded from $path"
      break
    fi
  fi
done

if [ -z "$PAT" ] || [ "$PAT" = "None" ]; then
  echo "[configure-git-identity] ERROR: no PAT found in any SSM path" >&2
  echo "[configure-git-identity] Tried:" >&2
  for path in "${SSM_PATHS[@]}"; do
    echo "[configure-git-identity]   $path" >&2
  done
  exit 1
fi

# Configure git auth via insteadOf rewrite. Daemon's git ops use HTTPS URLs;
# this rewrites them transparently to include the bearer token.
git config --global \
  "url.https://x-access-token:${PAT}@github.com/.insteadOf" \
  "https://github.com/"

# Set committer identity for daemon-driven commits (post-create scaffold,
# wave merges, etc).
git config --global user.email "daemon@futurator.ai"
git config --global user.name  "Futurator Daemon"

# Smoke-test: ls-remote against any futurator-repos repo. If this fails, the PAT
# scope or rate-limit is wrong — surface clearly so the daemon doesn't start
# silently broken.
#
# Default points at `template-nextjs.git` — Phase 1 PR-4 guarantees this repo
# exists for the boilerplate scaffolding flow. Earlier default `futurator-
# core.git` was a placeholder that was never created; 2026-05-16 incident
# (PAT valid, ls-remote against missing repo failed) burned down to this fix.
SMOKE_REPO="${FUTURATOR_GIT_SMOKE_REPO:-https://github.com/futurator-repos/template-nextjs.git}"
if ! git ls-remote "$SMOKE_REPO" HEAD >/dev/null 2>&1; then
  echo "[configure-git-identity] ERROR: smoke-test ls-remote failed against $SMOKE_REPO" >&2
  echo "[configure-git-identity] Likely causes: PAT lacks Contents:read on the org, PAT expired, or repo URL changed." >&2
  exit 2
fi

# Don't echo the PAT, the rewrite rule (which contains it), or even the
# rewrite line in any subsequent log.
unset PAT

echo "[configure-git-identity] OK — git identity configured for daemon@futurator.ai"
