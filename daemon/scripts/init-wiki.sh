#!/usr/bin/env bash
# Wiki Directory Structure Initialization
# Story MY-1.3
#
# Creates the wiki knowledge directory structure for a project workspace.
# Idempotent — safe to re-run; never overwrites existing content.
#
# Usage:
#   bash init-wiki.sh <projectId> <workingDir>
#   bash init-wiki.sh spyhunter /home/ubuntu/projects/spyhunter
#
# Creates:
#   <workingDir>/knowledge/          — wiki root with phase directories
#   <workingDir>/.mycelium/          — graph sync metadata

set -euo pipefail

# ── Argument parsing ──────────────────────────────────────────────────

if [ $# -lt 2 ]; then
  echo "Usage: $(basename "$0") <projectId> <workingDir>"
  echo ""
  echo "Arguments:"
  echo "  projectId   Project identifier (e.g., spyhunter)"
  echo "  workingDir  Project workspace root (e.g., /home/ubuntu/projects/spyhunter)"
  exit 1
fi

PROJECT_ID="$1"
WORKING_DIR="$2"
KNOWLEDGE_DIR="${WORKING_DIR}/knowledge"
MYCELIUM_DIR="${WORKING_DIR}/.mycelium"
TODAY=$(date +%Y-%m-%d)

echo "[init-wiki] Initializing wiki for project '${PROJECT_ID}'"
echo "[init-wiki] Working directory: ${WORKING_DIR}"
echo ""

# ── Task 1: Create directory structure ────────────────────────────────

echo "[init-wiki] Creating directory structure..."

PHASE_DIRS=(
  "code"
  "decisions"
  "requirements"
  "discovery"
  "planning"
  "solutioning"
  "qa"
  "system"
  "archive"
)

for dir in "${PHASE_DIRS[@]}"; do
  mkdir -p "${KNOWLEDGE_DIR}/${dir}"
done

mkdir -p "${MYCELIUM_DIR}"

echo "[init-wiki] Directories created: ${PHASE_DIRS[*]}"

# ── Task 2: Initialize index.md ──────────────────────────────────────

INDEX_FILE="${KNOWLEDGE_DIR}/index.md"

if [ ! -f "${INDEX_FILE}" ]; then
  cat > "${INDEX_FILE}" << INDEXEOF
---
title: ${PROJECT_ID} Knowledge Index
type: system
phase: system
status: active
maturity: 0.1
created: ${TODAY}
updated: ${TODAY}
tags: [index, catalog]
---

# ${PROJECT_ID} — Knowledge Index

Master catalog of all compiled knowledge for the **${PROJECT_ID}** project.

## Discovery

_No articles yet._

## Planning

_No articles yet._

## Solutioning

_No articles yet._

## Implementation

_No articles yet._

## QA

_No articles yet._

## Release

_No articles yet._

## Support

_No articles yet._

## System

- [dependency-map](system/dependency-map.md) — Cross-cutting dependency relationships
- [deployment-manifest](system/deployment-manifest.md) — Deployed artifact registry
- [debt-registry](system/debt-registry.md) — Technical debt tracking
- [pending-work](system/pending-work.md) — Outstanding work items
INDEXEOF
  echo "[init-wiki] Created index.md"
else
  echo "[init-wiki] index.md already exists (skipped)"
fi

# ── Task 3: Initialize log.md ────────────────────────────────────────

LOG_FILE="${KNOWLEDGE_DIR}/log.md"

if [ ! -f "${LOG_FILE}" ]; then
  cat > "${LOG_FILE}" << LOGEOF
---
title: ${PROJECT_ID} Operations Log
type: system
phase: system
status: active
maturity: 0.1
created: ${TODAY}
updated: ${TODAY}
tags: [log, operations]
---

# ${PROJECT_ID} — Operations Log

Append-only log of all knowledge graph operations.

| Date | Operation | Agent |
|------|-----------|-------|
| ${TODAY} | Wiki initialized for ${PROJECT_ID} | init-wiki.sh |
LOGEOF
  echo "[init-wiki] Created log.md"
else
  echo "[init-wiki] log.md already exists (skipped)"
fi

# ── Task 4: Create system articles ───────────────────────────────────

create_system_article() {
  local filename="$1"
  local title="$2"
  local summary="$3"
  local filepath="${KNOWLEDGE_DIR}/system/${filename}"

  if [ ! -f "${filepath}" ]; then
    cat > "${filepath}" << SYSEOF
---
title: ${title}
type: system
phase: system
status: active
maturity: 0.1
created: ${TODAY}
updated: ${TODAY}
createdByEpic: MY-1
createdByStory: MY-1.3
lastMutatedByStory: MY-1.3
tags: [system]
---

## Purpose

${summary}

## Dependencies

_None yet._

## Dependents

_None yet._

## Notes

Initialized by init-wiki.sh on ${TODAY}.
SYSEOF
    echo "[init-wiki] Created system/${filename}"
  else
    echo "[init-wiki] system/${filename} already exists (skipped)"
  fi
}

create_system_article "dependency-map.md" \
  "Dependency Map" \
  "Cross-cutting dependency relationships across the entire ${PROJECT_ID} codebase. Updated by compilation steps after each story."

create_system_article "deployment-manifest.md" \
  "Deployment Manifest" \
  "Registry of deployed artifacts, deploy URLs, and deployment history for ${PROJECT_ID}."

create_system_article "debt-registry.md" \
  "Technical Debt Registry" \
  "Tracked technical debt items for ${PROJECT_ID}. Each entry includes severity, affected nodes, and remediation plan."

create_system_article "pending-work.md" \
  "Pending Work" \
  "Outstanding work items for ${PROJECT_ID}. Updated after each epic compilation with incomplete tasks and flagged nodes."

# ── Task 5: Create .mycelium metadata files ──────────────────────────

COMPILE_STATE="${MYCELIUM_DIR}/compile-state.json"
EMBED_QUEUE="${MYCELIUM_DIR}/embeddings-queue.json"

if [ ! -f "${COMPILE_STATE}" ]; then
  echo '{}' > "${COMPILE_STATE}"
  echo "[init-wiki] Created .mycelium/compile-state.json"
else
  echo "[init-wiki] .mycelium/compile-state.json already exists (skipped)"
fi

if [ ! -f "${EMBED_QUEUE}" ]; then
  echo '[]' > "${EMBED_QUEUE}"
  echo "[init-wiki] Created .mycelium/embeddings-queue.json"
else
  echo "[init-wiki] .mycelium/embeddings-queue.json already exists (skipped)"
fi

# ── Summary ───────────────────────────────────────────────────────────

echo ""
echo "=== Wiki Initialization Complete ==="
echo "Project:    ${PROJECT_ID}"
echo "Knowledge:  ${KNOWLEDGE_DIR}/"
echo "Metadata:   ${MYCELIUM_DIR}/"
echo ""
echo "Directory structure:"
for dir in "${PHASE_DIRS[@]}"; do
  count=$(find "${KNOWLEDGE_DIR}/${dir}" -name "*.md" 2>/dev/null | wc -l | tr -d ' ')
  echo "  knowledge/${dir}/  (${count} articles)"
done
echo ""
echo "Next steps:"
echo "  - Run graph-sync.mjs to embed system articles into Memgraph"
echo "  - Pipeline compilation steps will auto-populate articles"
