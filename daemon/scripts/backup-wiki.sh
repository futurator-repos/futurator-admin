#!/usr/bin/env bash
# S3 Wiki Backup Script
# Story MY-1.6
#
# Syncs the wiki knowledge/ directory to S3 for durable backup.
# Uses aws s3 sync --delete for differential uploads.
# Best-effort: errors are logged but do not fail the pipeline.
#
# Usage:
#   bash backup-wiki.sh <projectId> <knowledgeDir>
#   bash backup-wiki.sh spyhunter /home/ubuntu/projects/spyhunter/knowledge

set -uo pipefail
# Note: NOT using -e because this is best-effort — we handle errors ourselves

S3_BUCKET="futurator-ai-website"
S3_PREFIX="knowledge-live"
TIMEOUT_SECONDS=30

# ── Argument parsing ──────────────────────────────────────────────────

if [ $# -lt 2 ]; then
  echo "Usage: $(basename "$0") <projectId> <knowledgeDir>"
  echo ""
  echo "Arguments:"
  echo "  projectId     Project identifier (e.g., spyhunter)"
  echo "  knowledgeDir  Path to the knowledge/ directory"
  exit 1
fi

PROJECT_ID="$1"
KNOWLEDGE_DIR="$2"
S3_PATH="s3://${S3_BUCKET}/${S3_PREFIX}/${PROJECT_ID}/"

# ── Validate inputs ──────────────────────────────────────────────────

if [ ! -d "${KNOWLEDGE_DIR}" ]; then
  echo "[backup-wiki] ERROR: Knowledge directory does not exist: ${KNOWLEDGE_DIR}" >&2
  exit 0  # Exit 0 — backup failure should not fail the pipeline
fi

# ── Check AWS CLI availability ────────────────────────────────────────

if ! command -v aws &>/dev/null; then
  echo "[backup-wiki] ERROR: AWS CLI not found in PATH" >&2
  exit 0
fi

# ── Run S3 sync ──────────────────────────────────────────────────────

echo "[backup-wiki] Syncing ${KNOWLEDGE_DIR} -> ${S3_PATH}"

START_TIME=$(date +%s)

# Run with timeout to prevent hanging
if command -v timeout &>/dev/null; then
  SYNC_OUTPUT=$(timeout "${TIMEOUT_SECONDS}" aws s3 sync "${KNOWLEDGE_DIR}" "${S3_PATH}" --delete 2>&1) || {
    EXIT_CODE=$?
    ELAPSED=$(($(date +%s) - START_TIME))
    if [ "${EXIT_CODE}" -eq 124 ]; then
      echo "[backup-wiki] WARNING: S3 sync timed out after ${TIMEOUT_SECONDS}s for ${PROJECT_ID}" >&2
    else
      echo "[backup-wiki] ERROR: S3 sync failed for ${PROJECT_ID} (exit code ${EXIT_CODE}): ${SYNC_OUTPUT}" >&2
    fi
    exit 0  # Best-effort — don't fail pipeline
  }
else
  # No timeout command available — run without timeout
  SYNC_OUTPUT=$(aws s3 sync "${KNOWLEDGE_DIR}" "${S3_PATH}" --delete 2>&1) || {
    EXIT_CODE=$?
    echo "[backup-wiki] ERROR: S3 sync failed for ${PROJECT_ID} (exit code ${EXIT_CODE}): ${SYNC_OUTPUT}" >&2
    exit 0  # Best-effort — don't fail pipeline
  }
fi

ELAPSED=$(($(date +%s) - START_TIME))

# Count uploaded/deleted files from sync output
FILE_COUNT=$(echo "${SYNC_OUTPUT}" | grep -c -E '^(upload|delete):' 2>/dev/null || echo "0")

echo "[backup-wiki] Synced ${PROJECT_ID} knowledge to S3 (${FILE_COUNT} files changed, ${ELAPSED}s)"
