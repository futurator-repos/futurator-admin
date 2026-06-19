#!/usr/bin/env bash
# E1 — plan-decomposition swarm (Intervention ①) vs single-shot baseline.
#
# Tests the bridge redesign: does an epic-breakdown → parallel per-epic swarm → deterministic
# assembly gate beat the current single-shot pm-plan (20m34s / $1.45) on the SAME approved docs,
# while producing an auditable, full-coverage plan?
#
#   ./run.sh            → SWARM arm (workflow + assembly gate)
#   ./run.sh --baseline → SINGLE-SHOT arm (one agent, all docs, whole tree — mimics pm-plan today)
#
# Deterministic assembly gate (bash, no LLM): spec-coverage, cross-epic touchPoint collision,
# epic-dependency acyclicity. Wall-time measured; v3 tokens via the B1 harvester.
# Emits: PROBE-RESULT: E1 arm=<swarm|baseline> ms=<n> epics=<n> stories=<n> coverage=<ok|GAP> collision=<none|N> acyclic=<yes|no> tok=<n>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ARM=swarm; [[ "${1:-}" == "--baseline" ]] && ARM=baseline
WORK="${SPIKE_WORK:-/tmp/v3-E1-$ARM-$(date +%s)}"; SP="$WORK/.spike"; mkdir -p "$SP"; LOG="$SP/run.log"; : > "$LOG"
now_ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
INTENT="A faithful single-player browser Pac-Man in TypeScript + HTML canvas, pure-logic core separated from rendering."
DOCS="$(cat "$HERE/docs/prd.md"; echo; echo '---'; cat "$HERE/docs/ux.md"; echo; echo '---'; cat "$HERE/docs/architecture.md")"
# spec ids the plan must cover (extracted from the docs deterministically)
SPEC_IDS=$(grep -ohE '\b(FR[0-9]+|SCREEN-[A-Za-z]+|FLOW-[A-Za-z]+|MOD-[a-z-]+|DEC-[a-z-]+)\b' "$HERE"/docs/*.md | sort -u)

START=$(now_ms)
if [[ "$ARM" == swarm ]]; then
  cp "$HERE/epic-elicitation.workflow.js" "$SP/wf.js"
  ARGS=$(jq -nc --arg i "$INTENT" --arg d "$DOCS" '{intent:$i, docs:$d}')
  claude -p "Run the dynamic workflow at: $SP/wf.js
Use this JSON as args: $ARGS
Save its EXACT return value as JSON to: $SP/plan.json then output only DONE" \
    --allowedTools "Read,Grep,Glob,Edit,Write,Bash,Task,Workflow" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true
  [[ -s "$SP/plan.json" ]] || { echo "PROBE-RESULT: E1 arm=swarm ms=0 epics=0 stories=0 coverage=GAP collision=ERR acyclic=no tok=0 (no output)"; exit 1; }
  EPICS=$(jq '.epics|length' "$SP/plan.json" 2>/dev/null || echo 0)
  STORIES=$(jq '[.subtrees[].stories[]]|length' "$SP/plan.json" 2>/dev/null || echo 0)
  COVERED=$(jq -r '[.epics[].coversSpecIds[]]|unique[]' "$SP/plan.json" 2>/dev/null | sort -u)
  COLLISION=$(jq -r '[.subtrees[].stories[].touchPoints[]]|.[]' "$SP/plan.json" 2>/dev/null | sort | uniq -d | wc -l | tr -d ' ')
  # acyclicity of epic DAG (Kahn)
  ACYCLIC=$(jq -r '.epics' "$SP/plan.json" 2>/dev/null | python3 "$HERE/acyclic.py" 2>/dev/null || echo no)
else
  # SINGLE-SHOT baseline: one agent, all docs, whole epic→story tree in one JSON (mimics pm-plan today)
  claude -p "You are a planning PM. From the approved specs, output ONE JSON object:
{epics:[{epicId,title,goal,dependsOnEpics:[],coversSpecIds:[],stories:[{storyId,title,touchPoints:[],dependsOn:[],acs:[]}]}]}.
Cover every spec id (FR../SCREEN-../MOD-..). Stories' touchPoints are src/* files (never *.test.*).
INTENT: $INTENT
SPECS:
$DOCS
Output ONLY the JSON." \
    --allowedTools "Read" --permission-mode bypassPermissions </dev/null > "$SP/raw.txt" 2>>"$LOG" || true
  python3 -c "import sys,re,json; t=open('$SP/raw.txt').read(); m=re.search(r'\{.*\}',t,re.S); open('$SP/plan.json','w').write(m.group(0) if m else '{}')" 2>/dev/null || echo '{}' > "$SP/plan.json"
  EPICS=$(jq '.epics|length' "$SP/plan.json" 2>/dev/null || echo 0)
  STORIES=$(jq '[.epics[].stories[]]|length' "$SP/plan.json" 2>/dev/null || echo 0)
  COVERED=$(jq -r '[.epics[].coversSpecIds[]]|unique[]' "$SP/plan.json" 2>/dev/null | sort -u)
  COLLISION=$(jq -r '[.epics[].stories[].touchPoints[]]|.[]' "$SP/plan.json" 2>/dev/null | sort | uniq -d | wc -l | tr -d ' ')
  ACYCLIC=$(jq -r '.epics' "$SP/plan.json" 2>/dev/null | python3 "$HERE/acyclic.py" 2>/dev/null || echo no)
fi
END=$(now_ms); MS=$((END-START))

# coverage gate: every spec id present in the plan's coversSpecIds?
MISSING=$(comm -23 <(echo "$SPEC_IDS") <(echo "$COVERED") | grep -v '^$' || true)
COVERAGE=ok; [[ -n "$MISSING" ]] && COVERAGE="GAP[$(echo "$MISSING" | tr '\n' ',' | sed 's/,$//')]"
TOK=0
[[ "$ARM" == swarm ]] && TOK=$(node "$ROOT/probes/B1-harvester/harvest.mjs" "$WORK" --json 2>/dev/null | python3 -c 'import sys,json;d=json.load(sys.stdin);print(sum(e["inputTokens"]+e["outputTokens"] for e in d["agentEvents"]))' 2>/dev/null || echo 0)

echo "  arm=$ARM ms=$MS epics=$EPICS stories=$STORIES coverage=$COVERAGE collision=$COLLISION acyclic=$ACYCLIC tok=$TOK"
[[ -n "$MISSING" ]] && echo "  ⚠ uncovered specs: $(echo "$MISSING" | tr '\n' ' ')"
echo "PROBE-RESULT: E1 arm=$ARM ms=$MS epics=$EPICS stories=$STORIES coverage=$COVERAGE collision=$COLLISION acyclic=$ACYCLIC tok=$TOK work=$WORK"
