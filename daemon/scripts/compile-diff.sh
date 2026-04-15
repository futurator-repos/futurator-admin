#!/usr/bin/env bash
# ──────────────────────────────────────────────────────────────────────────────
# compile-diff.sh — Diff extraction for Mycelium Story Compilation Pipeline
#
# Outputs changed files in STATUS\tFILENAME format for the Knowledge Compiler.
# Uses git diff when available, falls back to find with compile marker.
#
# Usage:
#   ./compile-diff.sh /path/to/project
#   cd /path/to/project && bash compile-diff.sh .
#
# Output format (one line per file):
#   A	src/components/auth.tsx
#   M	src/utils/api.ts
#   D	src/old-module.ts
#
# Exit codes:
#   0 — success (even if no files changed — empty output is valid)
#   1 — fatal error
# ──────────────────────────────────────────────────────────────────────────────

set -euo pipefail

WORKING_DIR="${1:-.}"

# Resolve absolute path
WORKING_DIR="$(cd "$WORKING_DIR" && pwd)"

# Ensure .mycelium directory exists for marker file
MYCELIUM_DIR="${WORKING_DIR}/.mycelium"
mkdir -p "$MYCELIUM_DIR"

MARKER_FILE="${MYCELIUM_DIR}/last-compile-marker"

# Directories to exclude from diff output
EXCLUDE_PATTERN='node_modules/|\.git/|knowledge/'

# ── Primary: git diff ──
diff_via_git() {
  cd "$WORKING_DIR" || return 1

  # Check if we're in a git repo with at least one commit
  if ! git rev-parse --is-inside-work-tree &>/dev/null; then
    return 1
  fi

  # Check if there's a parent commit to diff against
  if ! git rev-parse HEAD~1 &>/dev/null; then
    # No parent commit — treat all tracked files as Added
    git ls-files | grep -v -E "$EXCLUDE_PATTERN" | sed 's/^/A\t/' || true
    return 0
  fi

  # Standard diff against previous commit
  git diff --name-status HEAD~1 HEAD 2>/dev/null \
    | grep -v -E "$EXCLUDE_PATTERN" \
    || true  # empty diff is valid (exit 0)
}

# ── Fallback: find by timestamp ──
diff_via_find() {
  cd "$WORKING_DIR" || return 1

  if [ -f "$MARKER_FILE" ]; then
    # Find files newer than the marker
    find . -newer "$MARKER_FILE" -type f \
      -not -path './node_modules/*' \
      -not -path './.git/*' \
      -not -path './knowledge/*' \
      -not -path './.mycelium/*' \
      2>/dev/null \
      | sed 's|^\./||' \
      | sed 's/^/A\t/' \
      || true
  else
    # No marker file — first compilation, treat all files as new
    find . -type f \
      -not -path './node_modules/*' \
      -not -path './.git/*' \
      -not -path './knowledge/*' \
      -not -path './.mycelium/*' \
      2>/dev/null \
      | sed 's|^\./||' \
      | sed 's/^/A\t/' \
      || true
  fi
}

# ── Main ──

# Try git first, fall back to find
OUTPUT=$(diff_via_git 2>/dev/null) || OUTPUT=$(diff_via_find)

# Output the diff manifest (may be empty — that's OK)
if [ -n "$OUTPUT" ]; then
  echo "$OUTPUT"
fi

# Update the compile marker timestamp on success
touch "$MARKER_FILE"

exit 0
