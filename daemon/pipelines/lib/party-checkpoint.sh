#!/usr/bin/env bash
# party-checkpoint.sh — Story 20.2 (party-push Epic 20).
#
# Daemon post-round hook for party-mode sessions. Runs the system-driven
# commit (verify branch → empty-porcelain check → secrets scan → add →
# commit-from-stdin) inside the per-session party worktree.
#
# Push is DEFERRED to Epic 21 — this story ships the commit half only.
# Keeping the push step removed (not gated behind a flag) prevents
# accidental re-enablement before the PAT scope upgrades to contents:write.
#
# Invocation contract (called from party-turn.mjs post-round hook):
#
#   echo "<commit-message>" | party-checkpoint.sh \
#       'party/<projectId>/<sessionIdShort>'  /home/ubuntu/worktrees/<app>/_party/<sid>/
#
#   $1 = expected branch name (e.g. party/applicator/c6b86fee)
#   $2 = worktree path
#   stdin = commit message body (composed by agent-commit-composer; piped by daemon)
#
# Exit codes:
#   0 — committed successfully (SHA echoed on stdout); OR clean porcelain (no commit, no SHA)
#   1 — unexpected failure (stderr carries context)
#   2 — secrets-scan hit (stderr: SECRETS_HIT: <regex-name>)
#   3 — branch mismatch (HEAD ≠ expected; stderr: BRANCH_MISMATCH ...)
#   4 — worktree path missing / not a git repo (stderr: WORKTREE_MISSING)
#
# All git operations use `sudo -u ubuntu` because:
#   - The daemon runs as a systemd service (root or different user).
#   - Git's safe.directory protection rejects operations from a uid
#     different from the worktree owner; the worktree is owned by ubuntu.
#   - This was verified during pipeline-v2 worktree rollout.

set -o pipefail

# Test-mode sudo override. Default is the production `sudo -u ubuntu` prefix
# the EC2 daemon needs (safe.directory protection). Tests on macOS / CI
# without sudo set `PARTY_CHECKPOINT_SUDO=""` so git runs as the current
# user against an ephemeral fixture repo.
SUDO_PREFIX="${PARTY_CHECKPOINT_SUDO-sudo -u ubuntu}"

# Helper that prepends SUDO_PREFIX iff non-empty. Avoids
# `run_git ...` failing on macOS while keeping the production
# invocation identical.
run_git() {
  if [[ -n "$SUDO_PREFIX" ]]; then
    # shellcheck disable=SC2086
    $SUDO_PREFIX git "$@"
  else
    git "$@"
  fi
}

EXPECTED_BRANCH="${1:-}"
WORKTREE_PATH="${2:-}"

if [[ -z "$EXPECTED_BRANCH" || -z "$WORKTREE_PATH" ]]; then
  echo "USAGE: party-checkpoint.sh <expected-branch> <worktree-path> < commit-message" >&2
  exit 1
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "WORKTREE_MISSING: $WORKTREE_PATH" >&2
  exit 4
fi

cd "$WORKTREE_PATH" || { echo "WORKTREE_MISSING: cd $WORKTREE_PATH failed" >&2; exit 4; }

# Verify the worktree IS a git repo. `git rev-parse --is-inside-work-tree`
# returns non-zero (and ungracefully) outside one.
if ! run_git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "WORKTREE_MISSING: not a git repository" >&2
  exit 4
fi

# Verify HEAD matches the expected party branch. Defense-in-depth: the
# worktree's branch SHOULD always be the party branch, but a bug in
# bootstrap or operator interference could leave it elsewhere. Refuse
# to commit until the operator inspects.
CURRENT_BRANCH=$(run_git symbolic-ref --short HEAD 2>/dev/null || echo "")
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "BRANCH_MISMATCH: HEAD is '$CURRENT_BRANCH', expected '$EXPECTED_BRANCH'" >&2
  exit 3
fi

# Empty-porcelain short-circuit: nothing to commit, exit silently.
PORCELAIN=$(run_git status --porcelain 2>/dev/null || true)
if [[ -z "$PORCELAIN" ]]; then
  echo "STATUS_PORCELAIN_EMPTY"
  exit 0
fi

# Read the commit message from stdin into a tempfile (we'll pass it to
# `git commit -F`). Strip trailing newlines but keep internal ones intact.
COMMIT_MSG_FILE=$(mktemp)
cleanup() { rm -f "$COMMIT_MSG_FILE"; }
trap cleanup EXIT

cat > "$COMMIT_MSG_FILE"
if [[ ! -s "$COMMIT_MSG_FILE" ]]; then
  echo "EMPTY_COMMIT_MESSAGE: stdin produced no message" >&2
  exit 1
fi

# Stage everything BEFORE the secrets scan — the scan must run against
# the staged diff (`git diff --cached`), not the working tree, because
# untracked files don't appear in the working-tree diff at all.
run_git add -A 2>&1 >/dev/null || {
  echo "GIT_ADD_FAILED" >&2
  exit 1
}

# Secrets scan: pull patterns from daemon/lib/git-deny-list.json and
# grep the staged diff. Any hit blocks the commit.
#
# Resolve the deny-list path relative to this script so the daemon's
# rsync layout works (script ships in daemon/pipelines/lib/, JSON in
# daemon/lib/).
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DENY_LIST="$SCRIPT_DIR/../../lib/git-deny-list.json"

if [[ -f "$DENY_LIST" ]] && command -v jq >/dev/null 2>&1; then
  STAGED_DIFF=$(run_git diff --cached 2>/dev/null || true)
  # secret_regex_patterns is a JSON array; iterate.
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    if printf '%s' "$STAGED_DIFF" | grep -qE "$pattern" 2>/dev/null; then
      # Don't echo the matching content to stderr — that would re-expose
      # the secret in daemon logs. Just identify the pattern.
      echo "SECRETS_HIT: pattern=$pattern" >&2
      # Unstage so a subsequent run starts clean.
      run_git reset HEAD -- . >/dev/null 2>&1 || true
      exit 2
    fi
  done < <(jq -r '.secret_regex_patterns[]?' "$DENY_LIST" 2>/dev/null)
fi

# Commit. `git commit -F <file>` reads the message body from the file —
# safer than `-m` for messages with backticks / quotes / newlines.
if ! run_git commit -F "$COMMIT_MSG_FILE" 2>&1; then
  echo "GIT_COMMIT_FAILED" >&2
  exit 1
fi

# Push is REMOVED in this story. Epic 21 re-adds it once the PAT scope
# upgrades to contents:write.
echo "PUSH_DEFERRED: Epic 21 enables push when PAT scope upgrades to contents:write"

# Echo the new HEAD SHA so the daemon can capture it for the event payload.
NEW_SHA=$(run_git rev-parse HEAD 2>/dev/null || echo "")
echo "$NEW_SHA"
exit 0
