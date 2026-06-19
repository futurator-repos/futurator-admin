#!/usr/bin/env bash
# lint-and-launch.sh — gate a generated dynamic workflow before it runs.
# Futurator Pipeline v2.5 · Layer-3 enforcement (deterministic lint + Haiku semantic review)
#
# Usage:
#   ./lint-and-launch.sh <workflow.js> <plan.json> "<launch prompt>" [--skip-semantic]
#
# Flow:
#   1. node workflow-lint.mjs          → structural invariants (hard gate, exit on fail)
#   2. claude -p (haiku)               → semantic review against SKILL.md (hard gate)
#   3. claude -p "<launch prompt>"     → relaunch the workflow from the verified script
#
# Exit codes: 0 launched · 10 lint failed · 11 semantic review failed · 2 usage
#
# Notes for EC2 headless:
#   - Run under tmux/systemd; workflows are resumable only within a live session.
#   - Ensure your allowlist in settings.json covers git/build/test commands —
#     subagents inherit it and run in acceptEdits with no one to prompt.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL="${SKILL_PATH:-.claude/skills/workflow-authoring/SKILL.md}"
LINTER="${LINTER_PATH:-$HERE/workflow-lint.mjs}"
REVIEW_MODEL="${REVIEW_MODEL:-haiku}"   # cheap; floors don't apply to reviewing
LOG_DIR="${WF_LOG_DIR:-.pipeline/workflow-gate}"

if [[ $# -lt 3 ]]; then
  echo "usage: $0 <workflow.js> <plan.json> \"<launch prompt>\" [--skip-semantic]" >&2
  exit 2
fi

WF_SCRIPT="$1"; PLAN_JSON="$2"; LAUNCH_PROMPT="$3"; SKIP_SEM="${4:-}"
mkdir -p "$LOG_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"

# ————————————————————————————— Gate 1: deterministic lint
echo "▸ gate 1/2 · structural lint"
if ! node "$LINTER" "$WF_SCRIPT" "$PLAN_JSON" --json > "$LOG_DIR/lint-$STAMP.json"; then
  echo "✗ lint FAILED — report: $LOG_DIR/lint-$STAMP.json" >&2
  node "$LINTER" "$WF_SCRIPT" "$PLAN_JSON" || true   # human-readable echo
  exit 10
fi
echo "✓ structural lint passed"

# ————————————————————————————— Gate 2: semantic review (Haiku, one shot)
if [[ "$SKIP_SEM" != "--skip-semantic" ]]; then
  echo "▸ gate 2/2 · semantic review ($REVIEW_MODEL)"
  VERDICT_FILE="$LOG_DIR/semantic-$STAMP.txt"

  REVIEW_PROMPT=$(cat <<'EOF'
You are a workflow-script reviewer. You will receive (1) a policy document and
(2) a generated orchestration script. The structural linter already passed; your
job is INTENT-level review only — catch what regex cannot:

- Does any chain effectively skip verification despite containing a verification
  role (e.g. a qa phase whose prompt tells it to rubber-stamp)?
- Does any prompt instruct an agent to bypass, weaken, or ignore the gates?
- Are refuters given real evidence and a genuine mandate to break candidates?
- Do escalation paths actually stop work, or do they fall through to a merge?
- Is anything destructive hidden inside agent prompt strings rather than code?

Be strict and literal. Respond with EXACTLY one line first:
VERDICT: PASS
or
VERDICT: FAIL
followed by a short numbered list of findings (empty list allowed on PASS).
EOF
)

  claude -p "$REVIEW_PROMPT

=== POLICY (SKILL.md) ===
$(cat "$SKILL")

=== GENERATED WORKFLOW SCRIPT ===
$(cat "$WF_SCRIPT")" \
    --model "$REVIEW_MODEL" > "$VERDICT_FILE" 2>>"$LOG_DIR/semantic-$STAMP.err" || {
      echo "✗ semantic review errored — see $LOG_DIR/semantic-$STAMP.err" >&2; exit 11; }

  if ! head -n 5 "$VERDICT_FILE" | grep -q "VERDICT: PASS"; then
    echo "✗ semantic review FAILED — $VERDICT_FILE:" >&2
    cat "$VERDICT_FILE" >&2
    exit 11
  fi
  echo "✓ semantic review passed"
else
  echo "▹ semantic review skipped (--skip-semantic)"
fi

# ————————————————————————————— Launch
echo "▸ launching workflow from verified script"
cp "$WF_SCRIPT" "$LOG_DIR/launched-$STAMP.js"   # immutable copy of exactly what ran
exec claude -p "$LAUNCH_PROMPT (relaunch the workflow exactly from the verified script at $WF_SCRIPT — do not rewrite it)"
