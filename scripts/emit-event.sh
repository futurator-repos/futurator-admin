#!/bin/bash
# emit-event.sh — observability spine shell emitter (contract §3)
#
# Usage:   /opt/futurator/emit-event.sh '<event JSON>'
# Effect:  appends one NDJSON line to $FUTURATOR_EVENT_LOG_DIR/<jobId>.ndjson
# Exits:   0 success, 2 invalid JSON / missing jobId, 3 missing required field,
#          non-zero otherwise (propagates write failure)
#
# Required fields in the JSON: jobId, epicId, waveNumber, role, eventType
# Per-event size budget: 4096 bytes (POSIX PIPE_BUF atomic append guarantee).

set -euo pipefail

if [ $# -lt 1 ]; then
  echo "emit-event: missing event JSON argument" >&2
  exit 2
fi

EVENT_JSON="$1"
EVENT_BYTES="${#EVENT_JSON}"
if [ "$EVENT_BYTES" -gt 4096 ]; then
  echo "emit-event: event exceeds 4096-byte PIPE_BUF budget (${EVENT_BYTES} bytes)" >&2
  exit 4
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "emit-event: jq not found on PATH" >&2
  exit 5
fi

if ! printf '%s' "$EVENT_JSON" | jq -e '.' >/dev/null 2>&1; then
  echo "emit-event: invalid JSON" >&2
  exit 2
fi

for field in jobId epicId waveNumber role eventType; do
  if ! printf '%s' "$EVENT_JSON" | jq -e "has(\"$field\") and (.${field} != null)" >/dev/null 2>&1; then
    echo "emit-event: missing required field .${field}" >&2
    exit 3
  fi
done

JOB_ID=$(printf '%s' "$EVENT_JSON" | jq -r '.jobId')

LOG_DIR="${FUTURATOR_EVENT_LOG_DIR:-/var/log/futurator/events}"
mkdir -p "$LOG_DIR"

printf '%s\n' "$EVENT_JSON" >> "${LOG_DIR}/${JOB_ID}.ndjson"
