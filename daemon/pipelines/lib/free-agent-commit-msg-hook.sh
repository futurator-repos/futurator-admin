#!/usr/bin/env bash
# free-agent-commit-msg-hook.sh — Story 18.3 (Epic 18: Free Claude Code Agent)
#
# Git `prepare-commit-msg` hook installed into per-session free-agent worktrees
# at <worktreePath>/.git/hooks/prepare-commit-msg by `installCommitMsgHook` in
# daemon/pipelines/lib/free-agent-worktree.mjs.
#
# Contract:
#   - Git invokes us with: $1 = path to the commit-msg file, $2 = source (template, message, etc), $3 = SHA (during amend)
#   - We read $FREE_AGENT_SESSION_ID from the env (injected by the daemon when spawning the Claude CLI)
#   - If the trailer is already present, no-op (idempotent)
#   - Otherwise, append the trailer with a leading blank line if needed
#   - ALWAYS exit 0 — a hook error must NEVER block a commit
#
# Why we never block commits:
#   - The Free Agent runs at the operator's behest; failing to add a trailer is
#     cosmetic, not load-bearing. The agent gets blocked from doing useful work
#     if the hook becomes a failure point. So: best-effort, log to stderr (which
#     git surfaces during the commit), proceed regardless.
#
# Story 18.3 AC #1 / AC #2.

set -o pipefail

MSG_FILE="${1:-}"
SESSION_ID="${FREE_AGENT_SESSION_ID:-unknown}"
TRAILER="Agent: FREE-AGENT-${SESSION_ID}"

if [[ -z "$MSG_FILE" ]] || [[ ! -f "$MSG_FILE" ]]; then
  # No commit-msg file (hook invoked with bad args); skip silently.
  exit 0
fi

# Idempotent: if our exact trailer is already present, no-op.
if grep -qF "$TRAILER" "$MSG_FILE" 2>/dev/null; then
  exit 0
fi

# Strip comment-only lines + trailing blank lines to find the real last line,
# then check whether we need a leading blank to separate the trailer from
# existing prose. Simpler than parsing git's full message format.
LAST_NON_COMMENT_NON_BLANK=$(
  grep -v '^#' "$MSG_FILE" 2>/dev/null \
    | sed -e 's/[[:space:]]*$//' \
    | sed '/^$/d' \
    | tail -n 1
)

# Append the trailer. Use a leading blank line unless the file is empty.
{
  if [[ -n "$LAST_NON_COMMENT_NON_BLANK" ]]; then
    echo ""
  fi
  echo "$TRAILER"
} >> "$MSG_FILE" 2>/dev/null || {
  # If the append fails for any reason (read-only fs, etc), log and proceed.
  echo "free-agent commit-msg hook: failed to append trailer (continuing without)" >&2
}

exit 0
