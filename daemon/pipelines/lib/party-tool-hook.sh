#!/usr/bin/env bash
# party-tool-hook.sh — Story 20.3 (party-push Epic 20).
#
# Claude Code PreToolUse hook for PARTY-MODE sessions. Referenced from the
# per-session worktree's `.claude/settings.json` (written by Story 20.6's
# bootstrap):
#
#   {
#     "hooks": {
#       "PreToolUse": [{
#         "matcher": "Bash",
#         "hooks": [{ "type": "command", "command": "<absolute path here>" }]
#       }]
#     }
#   }
#
# Contract (per Claude Code hook spec):
#   - exit 0  → allow the tool call to proceed
#   - exit 1+ → deny the tool call; stderr is shown to the agent
#
# Env vars provided by Claude Code:
#   CLAUDE_TOOL_NAME  — e.g. "Bash"
#   CLAUDE_TOOL_INPUT — JSON: { "command": "...", ... }
#
# ────────────────────────────────────────────────────────────────────────────
# DEFAULT-ALLOW POSTURE (Free Explorer §13.1, operator-accepted 2026-05-21)
# ────────────────────────────────────────────────────────────────────────────
#
# Three tiers, in order:
#
#   Tier 1 (HARD DENY)  — git mutations, gh mutations, secret reads,
#                         system-danger (rm -rf / chmod 777 / sudo / curl|bash).
#                         Exit 1 with `DENIED: <reason>` on stderr.
#
#   Tier 2 (AUTO ALLOW) — read-only git, read-only gh, common read-only fs
#                         and grep/find/cat/ls etc. Exit 0 silently.
#
#   Tier 3 (DEFAULT ALLOW) — everything else falls through to allow, BUT
#                         emits a single-line audit marker on stderr:
#                         `[party-tool-hook] default-allow cmd=<command>`.
#                         The daemon (Story 20.7) greps stderr for this
#                         prefix and converts it to a `party.tool.default-allow`
#                         row in `futurator-agent-events`.
#
# Why default-allow rather than default-deny: the load-bearing security
# layers are (a) IAM least-privilege on the spawned subprocess role and
# (b) Tier 1's explicit deny categories. Default-deny would break common
# read-only investigation patterns (`node -e "..."`, `python3 -c "..."`,
# `npm ls`, ad-hoc one-liners) and produce a maintenance-heavy whitelist
# with little additional security value. THIS IS A DELIBERATE TRADE-OFF
# accepting node-spawned-binary as an attack vector for low maintenance
# — see the CLAUDE.md amendment from Story 20.3.
#
# ────────────────────────────────────────────────────────────────────────────
# Generation source: daemon/lib/git-deny-list.json (Story 19.1)
# TODO: scripts/build-agent-hooks.mjs (deferred follow-up) will stamp the
# tier matchers below from the JSON deny list. Until then, this file is
# hand-maintained — the JSON deny-list is the canonical reference for
# audit and the hook MUST be kept in sync by hand.

set -o pipefail

# Pass-through for non-Bash tools. Edit/Write/Read/Glob/Grep auto-approve
# via `bypassPermissions` posture; their scope is the per-session worktree.
if [[ "${CLAUDE_TOOL_NAME:-}" != "Bash" ]]; then
  exit 0
fi

if [[ -z "${CLAUDE_TOOL_INPUT:-}" ]]; then
  exit 0
fi

# Extract command string. jq when available; sed fallback for portability.
if command -v jq >/dev/null 2>&1; then
  CMD=$(printf '%s' "$CLAUDE_TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null || true)
else
  CMD=$(printf '%s' "$CLAUDE_TOOL_INPUT" \
    | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)
fi

if [[ -z "$CMD" ]]; then
  exit 0
fi

# ── Tier 1: HARD DENY ─────────────────────────────────────────────────────

deny() {
  echo "DENIED: $1" >&2
  exit 1
}

# git -c <inline-config> — bypasses repo hooks, transport policy.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+-c[[:space:]]'; then
  deny "git -c <inline-config> is forbidden (bypass risk for hooks/transport)"
fi

# git push variants. force-push, --delete, -f, -d.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+push[[:space:]]+.*(--force|-f|--force-with-lease|--delete|-d)([[:space:]]|$)'; then
  deny "git push --force / --delete / -f / -d is forbidden"
fi
# Refspec rewrite — `git push origin foo:bar`.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+push[[:space:]]+[^[:space:]]+[[:space:]]+[^[:space:]]+:[^[:space:]]+'; then
  deny "git push <remote> <src>:<dst> refspec-rewrite is forbidden"
fi

# Generic git mutations. Excludes `remote` and `symbolic-ref` because their
# read forms (`git remote -v`, `git remote show`, `git symbolic-ref HEAD`)
# are legitimate read-only operations Tier 2 auto-allows. The mutating
# subcommands of remote/symbolic-ref are handled in separate matchers below.
GIT_MUTATIONS="push|commit|add|rm|reset|tag|stash|cherry-pick|rebase|merge|filter-branch|replace|update-ref|fast-import|config|worktree"
if printf '%s' "$CMD" | grep -qE "(^|[[:space:];&|])git[[:space:]]+(${GIT_MUTATIONS})([[:space:]]|$)"; then
  matched=$(printf '%s' "$CMD" | grep -oE "git[[:space:]]+(${GIT_MUTATIONS})" | head -1)
  deny "git mutation is forbidden ($matched)"
fi
# `git remote add|remove|rm|rename|set-url|set-head|prune` — mutating subcommands.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+remote[[:space:]]+(add|remove|rm|rename|set-url|set-head|prune|update)([[:space:]]|$)'; then
  deny "git remote mutating subcommand is forbidden"
fi
# `git symbolic-ref` with a target argument rewrites HEAD. Read form
# (`git symbolic-ref HEAD` or `git symbolic-ref --short HEAD`) is fine.
# Match: `git symbolic-ref <ref> <target>` (two non-flag args after subcommand).
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+symbolic-ref[[:space:]]+(-d[[:space:]]|--delete)'; then
  deny "git symbolic-ref --delete is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+symbolic-ref[[:space:]]+[^-][^[:space:]]*[[:space:]]+[^-][^[:space:]]'; then
  deny "git symbolic-ref <ref> <target> (rewrite HEAD) is forbidden"
fi

# checkout / switch destructive variants.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+(checkout|switch)[[:space:]]+(main|master|develop|release/[^[:space:]]+)([[:space:]]|$)'; then
  deny "git checkout/switch to a base branch is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+checkout[[:space:]]+-b([[:space:]]|$)'; then
  deny "git checkout -b (create new branch) is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])git[[:space:]]+branch[[:space:]]+-(D|d|m)([[:space:]]|$)'; then
  deny "git branch -D / -d / -m is forbidden"
fi

# gh mutations.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+pr[[:space:]]+(create|merge|close|edit)([[:space:]]|$)'; then
  deny "gh pr create/merge/close/edit is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+repo[[:space:]]+(create|delete|rename|transfer)([[:space:]]|$)'; then
  deny "gh repo create/delete/rename/transfer is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+release[[:space:]]+(create|delete)([[:space:]]|$)'; then
  deny "gh release create/delete is forbidden"
fi
# gh api with write methods.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])gh[[:space:]]+api[[:space:]]+.*-X[[:space:]]+(POST|PATCH|PUT|DELETE)([[:space:]]|$)'; then
  deny "gh api write methods (-X POST/PATCH/PUT/DELETE) are forbidden"
fi

# System-danger.
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])rm[[:space:]]+-rf([[:space:]]|$)'; then
  deny "rm -rf is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])chmod[[:space:]]+(777|-R)([[:space:]]|$)'; then
  deny "chmod 777 / chmod -R is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])chown([[:space:]]|$)'; then
  deny "chown is forbidden"
fi
if printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|])sudo([[:space:]]|$)'; then
  deny "sudo is forbidden"
fi
# curl|bash, wget|sh.
if printf '%s' "$CMD" | grep -qE '(curl|wget)[^|]*\|[[:space:]]*(bash|sh)([[:space:]]|$)'; then
  deny "curl|bash / wget|sh remote-execute is forbidden"
fi

# Secret-path reads.
SECRET_PATHS='\.env|\.env\.local|\.env\.production|\.git/config|\.ssh|\.aws|\.claude/\.credentials\.json|/secrets/|id_rsa|id_ed25519'
if printf '%s' "$CMD" | grep -qE "(cat|head|tail|less|more|xxd|hexdump|od|strings)[[:space:]]+[^|;&]*(${SECRET_PATHS})([[:space:]]|$|/)"; then
  deny "reading from a secret path is forbidden"
fi

# ── Tier 2: AUTO-APPROVE ──────────────────────────────────────────────────

is_readonly_command() {
  local cmd="$1"
  if printf '%s' "$cmd" | grep -qE '^[[:space:]]*git[[:space:]]+(status|diff|log|show|branch[[:space:]]*$|branch[[:space:]]+-(a|r|v|l|vv|av|rv)([[:space:]]|$)|fetch([[:space:]]|$)|ls-files|rev-parse|symbolic-ref([[:space:]]|$)|describe|blame|shortlog|remote([[:space:]]+(-v|show))?([[:space:]]|$))'; then
    return 0
  fi
  if printf '%s' "$cmd" | grep -qE '^[[:space:]]*(ls|cat|head|tail|find|rg|grep|wc|file|stat|tree|pwd|echo|which|type|whereis)([[:space:]]|$)'; then
    return 0
  fi
  if printf '%s' "$cmd" | grep -qE '^[[:space:]]*gh[[:space:]]+(pr[[:space:]]+(view|list|diff)|issue[[:space:]]+(view|list)|repo[[:space:]]+view)([[:space:]]|$)'; then
    return 0
  fi
  if printf '%s' "$cmd" | grep -qE '^[[:space:]]*gh[[:space:]]+api[[:space:]]+/repos'; then
    if ! printf '%s' "$cmd" | grep -qE '\-X[[:space:]]+(POST|PATCH|PUT|DELETE)'; then
      return 0
    fi
  fi
  return 1
}

if is_readonly_command "$CMD"; then
  exit 0
fi

# ── Tier 3: DEFAULT-ALLOW with audit ──────────────────────────────────────
# Format: single line on stderr, daemon greps for it (Story 20.7).
# Truncate command to 500 chars to keep audit rows bounded.
TRUNCATED="${CMD:0:500}"
echo "[party-tool-hook] default-allow cmd=$TRUNCATED" >&2
exit 0
