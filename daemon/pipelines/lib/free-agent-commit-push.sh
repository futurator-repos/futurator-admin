#!/usr/bin/env bash
# free-agent-commit-push.sh — 2026-05-27 PR B.d.
#
# Daemon-side script that finalizes a free-agent session's local commits and
# pushes the assist branch to GitHub. Invoked by the API Lambda's /open-pr
# endpoint via SSM. Mirror of party-checkpoint.sh §pushing logic — secrets
# scan, branch-mismatch check, classified push error keywords.
#
# Unlike party-checkpoint.sh, this script does NOT compose new commits; it
# operates on a worktree the agent has already committed to. The job is
# strictly:
#   1. Verify HEAD branch == expected assist/<proj>/<sid8>
#   2. Bail if there's nothing to push (empty diff vs origin)
#   3. Secrets scan against `git diff origin/main..HEAD` (everything the
#      push will add)
#   4. git push --set-upstream origin <branch>
#
# Invocation contract:
#   free-agent-commit-push.sh 'assist/<projectId>/<sid8>' <worktree-path>
#
#   $1 = expected branch name
#   $2 = worktree path (/home/ubuntu/worktrees/<proj>/_assist/<sid8>/)
#   stdin = (unused — no commit composition here)
#
# Exit codes (match party-checkpoint.sh shape):
#   0 — push succeeded (SHA on stdout)
#   1 — unexpected failure
#   2 — secrets-scan hit (SECRETS_HIT: pattern=...)
#   3 — branch mismatch (BRANCH_MISMATCH ...)
#   4 — worktree path missing / not a git repo
#   5 — push attempted but failed (SHA on stdout)
#   6 — nothing to push (NO_DIFF_VS_BASE)
#
# All git ops use `sudo -u ubuntu` (test override via FREE_AGENT_PUSH_SUDO="").

set -o pipefail

SUDO_PREFIX="${FREE_AGENT_PUSH_SUDO-sudo -u ubuntu}"

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
  echo "USAGE: free-agent-commit-push.sh <assist/proj/sid8> <worktree-path>" >&2
  exit 1
fi

if [[ ! -d "$WORKTREE_PATH" ]]; then
  echo "WORKTREE_MISSING: $WORKTREE_PATH" >&2
  exit 4
fi
cd "$WORKTREE_PATH" || { echo "WORKTREE_MISSING: cd $WORKTREE_PATH failed" >&2; exit 4; }

if ! run_git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "WORKTREE_MISSING: not a git repository" >&2
  exit 4
fi

CURRENT_BRANCH=$(run_git symbolic-ref --short HEAD 2>/dev/null || echo "")
if [[ "$CURRENT_BRANCH" != "$EXPECTED_BRANCH" ]]; then
  echo "BRANCH_MISMATCH: HEAD is '$CURRENT_BRANCH', expected '$EXPECTED_BRANCH'" >&2
  exit 3
fi

# Determine the base — usually origin/main. The worktree was created off the
# bare repo's `main`, so `git merge-base HEAD main` resolves the fork point.
BASE_REF="main"
if ! run_git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "BASE_MISSING: cannot resolve $BASE_REF in worktree" >&2
  exit 1
fi

# Reject when no commits exist on the assist branch above the base — there's
# nothing to push. Common when the operator hits "open PR" before the agent
# committed anything.
COMMITS_AHEAD=$(run_git rev-list --count "$BASE_REF..HEAD" 2>/dev/null || echo "0")
if [[ "$COMMITS_AHEAD" == "0" ]]; then
  echo "NO_DIFF_VS_BASE: assist branch has no commits above $BASE_REF" >&2
  exit 6
fi

# Secrets scan against the full diff that the push would introduce.
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DENY_LIST="$SCRIPT_DIR/../../lib/git-deny-list.json"

if [[ -f "$DENY_LIST" ]] && command -v jq >/dev/null 2>&1; then
  ASSIST_DIFF=$(run_git diff "$BASE_REF..HEAD" 2>/dev/null || true)
  while IFS= read -r pattern; do
    [[ -z "$pattern" ]] && continue
    if printf '%s' "$ASSIST_DIFF" | grep -qE "$pattern" 2>/dev/null; then
      echo "SECRETS_HIT: pattern=$pattern" >&2
      exit 2
    fi
  done < <(jq -r '.secret_regex_patterns[]?' "$DENY_LIST" 2>/dev/null)
fi

# Capture the SHA we're pushing — emit on stdout regardless of push outcome.
NEW_SHA=$(run_git rev-parse HEAD 2>/dev/null || echo "")

# Push with --set-upstream so subsequent pushes on the same branch don't
# need the flag.
PUSH_OUTPUT=$(run_git push --set-upstream origin "$EXPECTED_BRANCH" 2>&1)
PUSH_STATUS=$?

if [[ $PUSH_STATUS -ne 0 ]]; then
  if printf '%s' "$PUSH_OUTPUT" | grep -qE "(403|denied|Permission to)"; then
    echo "PUSH_FAILED: AUTH_DENIED (PAT may lack contents:write or be expired)" >&2
  elif printf '%s' "$PUSH_OUTPUT" | grep -qE "(could not resolve|no route|network)"; then
    echo "PUSH_FAILED: NETWORK" >&2
  elif printf '%s' "$PUSH_OUTPUT" | grep -qiE "(protected branch|protected_branch|main is protected)"; then
    echo "PUSH_FAILED: BRANCH_PROTECTED" >&2
  else
    echo "PUSH_FAILED: OTHER" >&2
  fi
  echo "$NEW_SHA"
  exit 5
fi

echo "PUSHED: origin $EXPECTED_BRANCH @ $NEW_SHA"
echo "$NEW_SHA"
exit 0
