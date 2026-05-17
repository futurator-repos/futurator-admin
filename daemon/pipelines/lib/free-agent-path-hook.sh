#!/usr/bin/env bash
# free-agent-path-hook.sh — Story 18.1 (Epic 18: Free Claude Code Agent)
#
# Claude Code PreToolUse hook that enforces path confinement for free-agent
# sessions. Referenced from per-session .claude/settings.json:
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
# Env var provided by the daemon when spawning the Claude CLI subprocess:
#   FREE_AGENT_CONFINEMENT_ROOT — absolute path the agent must stay within
#                                 (e.g. /home/ubuntu/free-agent-worktrees/<p>/<s>/)
#
# Hook behavior:
#   - Only inspects Bash invocations. Other tools (Read, Edit, Write, Grep, etc.)
#     pass through unchanged — their filesystem scope is enforced by IAM and by
#     Claude Code's own working-directory awareness, not by this hook.
#   - For Bash: parses the command, extracts each `cd <path>` argument and any
#     absolute-path token. Resolves each relative to $PWD. If any resolved path
#     is OUTSIDE $FREE_AGENT_CONFINEMENT_ROOT, denies with informative stderr.
#
# Design notes:
#   - Pure bash + standard utilities (jq, realpath). No heavy deps.
#   - The parser is intentionally simple: it catches the common escape forms
#     (cd /etc, cat /etc/passwd, etc.) without trying to be a full shell parser.
#     A sophisticated attacker could likely bypass it; the goal is to prevent
#     accidental escapes by the agent during normal operation. Deeper defense
#     comes from the IAM role (no iam:*, no secretsmanager:*) and the read-only
#     S3 prefix scope.
#
# Story 18.1 AC #5 / AC #8 k-n.

# NOTE: we intentionally do NOT use `set -u` because empty bash arrays trip it
# on older bash builds (macOS 3.2). Missing env vars are checked explicitly
# below — fail-closed semantics are preserved.
set -o pipefail

# Pass-through for non-Bash tools.
if [[ "${CLAUDE_TOOL_NAME:-}" != "Bash" ]]; then
  exit 0
fi

if [[ -z "${FREE_AGENT_CONFINEMENT_ROOT:-}" ]]; then
  # No confinement configured → policy failure. Better to deny than to leak.
  echo "free-agent-path-hook: FREE_AGENT_CONFINEMENT_ROOT not set; denying for safety" >&2
  exit 1
fi

if [[ -z "${CLAUDE_TOOL_INPUT:-}" ]]; then
  # Nothing to inspect → allow (no command to escape with).
  exit 0
fi

# Extract the command string from the JSON payload.
# Falls back to grep-based extraction if jq is unavailable, for portability.
if command -v jq >/dev/null 2>&1; then
  COMMAND_STR=$(printf '%s' "$CLAUDE_TOOL_INPUT" | jq -r '.command // empty' 2>/dev/null || true)
else
  # Best-effort: extract the value of "command" assuming a simple JSON shape.
  COMMAND_STR=$(printf '%s' "$CLAUDE_TOOL_INPUT" \
    | sed -n 's/.*"command"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | head -n 1)
fi

if [[ -z "$COMMAND_STR" ]]; then
  exit 0
fi

# Normalize the confinement root (strip trailing slash, resolve symlinks).
ROOT_RESOLVED=$(realpath -m "$FREE_AGENT_CONFINEMENT_ROOT" 2>/dev/null || echo "$FREE_AGENT_CONFINEMENT_ROOT")
ROOT_RESOLVED="${ROOT_RESOLVED%/}"

# Resolve $PWD too — caller may not have given us an absolute one.
PWD_RESOLVED=$(realpath -m "${PWD:-.}" 2>/dev/null || echo "${PWD:-.}")

# Collect candidate paths to inspect. Two sources:
#  (1) every `cd <path>` argument in the command
#  (2) every token that starts with `/` (absolute path)
declare -a candidates=()

# (1) cd targets. Match `cd <token>` allowing for leading semicolons / &&.
while IFS= read -r cd_target; do
  [[ -n "$cd_target" ]] && candidates+=("$cd_target")
done < <(printf '%s' "$COMMAND_STR" | grep -oE 'cd[[:space:]]+[^[:space:];&|]+' \
  | sed -E 's/^cd[[:space:]]+//')

# (2) absolute-path tokens. Naive tokenization on whitespace.
for tok in $COMMAND_STR; do
  case "$tok" in
    /*) candidates+=("$tok") ;;
  esac
done

# Validate each candidate.
for candidate in "${candidates[@]}"; do
  # Resolve relative paths against PWD.
  case "$candidate" in
    /*) resolved=$(realpath -m "$candidate" 2>/dev/null || echo "$candidate") ;;
    *)  resolved=$(realpath -m "${PWD_RESOLVED}/${candidate}" 2>/dev/null || echo "${PWD_RESOLVED}/${candidate}") ;;
  esac
  resolved="${resolved%/}"

  # Allow if the resolved path is the root itself or a descendant.
  if [[ "$resolved" == "$ROOT_RESOLVED" ]] || [[ "$resolved" == "$ROOT_RESOLVED"/* ]]; then
    continue
  fi

  echo "free-agent-path-hook: rejected — '$candidate' resolves to '$resolved' which escapes confinement root '$ROOT_RESOLVED'" >&2
  exit 1
done

exit 0
