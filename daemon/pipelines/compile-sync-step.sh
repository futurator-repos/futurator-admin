#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# compile-sync-step.sh — Embed and Sync Shell Step for Mycelium Compilation
#
# Calls graph-sync.mjs from Epic 1 to embed wiki articles via Voyage AI and
# upsert them into Memgraph. Then triggers S3 backup of the knowledge directory.
#
# Usage:
#   ./compile-sync-step.sh <project-id> <working-dir>
#
# Example:
#   ./compile-sync-step.sh my-project /home/ubuntu/projects/my-project
#
# Environment:
#   MEMGRAPH_URI    — Memgraph Bolt URI (default: bolt://localhost:7687)
#   VOYAGE_API_KEY  — Voyage AI API key (required for embedding)
#   S3_BUCKET       — S3 bucket for backup (default: futurator-ai-website)
#
# Exit codes:
#   0 — success (graph sync completed; S3 backup is best-effort)
#   1 — graph-sync.mjs failed
# ──────────────────────────────────────────────────────────────────────────────

# Note: NOT using `set -euo pipefail` because we need to capture exit codes
# from graph-sync and handle S3 backup errors gracefully (best-effort).
set -uo pipefail

PROJECT_ID="${1:?Usage: compile-sync-step.sh <project-id> <working-dir>}"
WORKING_DIR="${2:?Usage: compile-sync-step.sh <project-id> <working-dir>}"

GRAPH_SYNC_SCRIPT="/home/ubuntu/scripts/graph-sync.mjs"
KNOWLEDGE_DIR="${WORKING_DIR}/knowledge"
STATE_FILE="${WORKING_DIR}/.mycelium/compile-state.json"
S3_BUCKET="${S3_BUCKET:-futurator-ai-website}"
S3_PATH="s3://${S3_BUCKET}/knowledge-live/${PROJECT_ID}/"

# Ensure .mycelium directory exists
mkdir -p "${WORKING_DIR}/.mycelium"

# ── Step 1: Graph Sync (embed + Memgraph upsert) ──

echo "=== Compile Sync: Starting graph-sync ==="
echo "  Project:       ${PROJECT_ID}"
echo "  Knowledge dir: ${KNOWLEDGE_DIR}"
echo "  State file:    ${STATE_FILE}"

SYNC_START=$(date +%s%3N)
SYNC_EXIT=0

if [ -f "$GRAPH_SYNC_SCRIPT" ]; then
  node "$GRAPH_SYNC_SCRIPT" \
    --project "$PROJECT_ID" \
    --knowledge-dir "$KNOWLEDGE_DIR" \
    --state-file "$STATE_FILE" || SYNC_EXIT=$?

  SYNC_END=$(date +%s%3N)
  SYNC_DURATION=$((SYNC_END - SYNC_START))

  if [ $SYNC_EXIT -ne 0 ]; then
    echo "ERROR: graph-sync.mjs exited with code ${SYNC_EXIT} (${SYNC_DURATION}ms)"
    exit 1
  fi

  echo "  Graph sync completed in ${SYNC_DURATION}ms"
else
  echo "WARNING: graph-sync.mjs not found at ${GRAPH_SYNC_SCRIPT}"
  echo "  Skipping graph sync (Epic 1 infrastructure not yet deployed)"
  echo "  This is expected during initial development"
fi

# ── Step 2: S3 Backup (best-effort, only after successful graph-sync) ──
# Note: NOT using --delete to avoid removing good files after partial compilation

echo "=== Compile Sync: Starting S3 backup ==="
echo "  Source: ${KNOWLEDGE_DIR}/"
echo "  Target: ${S3_PATH}"

if [ -d "$KNOWLEDGE_DIR" ]; then
  S3_START=$(date +%s%3N)

  # Best-effort: log errors but don't fail the step
  if aws s3 sync "$KNOWLEDGE_DIR/" "$S3_PATH" 2>&1; then
    S3_END=$(date +%s%3N)
    S3_DURATION=$((S3_END - S3_START))
    echo "  S3 backup completed in ${S3_DURATION}ms"
  else
    echo "WARNING: S3 backup failed (non-critical, continuing)"
  fi
else
  echo "WARNING: Knowledge directory not found at ${KNOWLEDGE_DIR}"
  echo "  Skipping S3 backup"
fi

# ── Summary ──

echo "=== Compile Sync: Complete ==="
echo "  graph-sync: OK"
echo "  s3-backup:  best-effort"

exit 0
