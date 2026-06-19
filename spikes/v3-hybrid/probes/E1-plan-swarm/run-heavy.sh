#!/usr/bin/env bash
# E1-heavy — PRODUCTION-rigor plan-decomposition: swarm (sliced docs + checkout) vs single-shot.
# The decisive scalability A/B: at heavy per-story output, does parallel epic decode beat one
# agent serially decoding the whole plan?
#
#   ./run-heavy.sh            → SWARM arm (workflow: breakdown + ∥ epics w/ sliced docs + checkout)
#   ./run-heavy.sh --single   → SINGLE-SHOT arm (one agent, all docs, whole enriched tree — = pm-plan)
#
# Fixes the E1 confound: cd "$WORK" before claude so the B1 harvester finds transcripts (real tokens).
# Checkout gate (bash): spec-coverage + cross-epic touchPoint collision + epic-DAG acyclicity +
# CONTRACT-CONFORMANCE (no epic used a domain-type name absent from the frozen contract surface).
# Emits: PROBE-RESULT: E1H arm=<swarm|single> ms=<n> epics=<n> stories=<n> acs=<n> coverage=<ok|GAP> collision=<n> acyclic=<y|n> conformance=<ok|DRIFT> tok=<n>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ARM=swarm; [[ "${1:-}" == "--single" ]] && ARM=single
WORK="${SPIKE_WORK:-/tmp/v3-E1H-$ARM-$(date +%s)}"; SP="$WORK/.spike"; mkdir -p "$SP"; LOG="$SP/run.log"; : > "$LOG"
now_ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
INTENT="A faithful single-player browser Pac-Man in TypeScript + HTML canvas, pure-logic core separated from rendering."
DOCS="$(cat "$HERE/docs/prd.md"; echo; echo '---'; cat "$HERE/docs/ux.md"; echo; echo '---'; cat "$HERE/docs/architecture.md")"
SPEC_IDS=$(grep -ohE '\b(FR[0-9]+|SCREEN-[A-Za-z]+|FLOW-[A-Za-z]+|MOD-[a-z-]+|DEC-[a-z-]+)\b' "$HERE"/docs/*.md | sort -u)
cd "$WORK"   # ← harvester fix: claude session project dir keyed by cwd

START=$(now_ms)
if [[ "$ARM" == swarm ]]; then
  cp "$HERE/epic-elicitation-heavy.workflow.js" "$SP/wf.js"
  ARGS=$(jq -nc --arg i "$INTENT" --arg d "$DOCS" '{intent:$i, docs:$d}')
  claude -p "Run the dynamic workflow at: $SP/wf.js
Use this JSON as args: $ARGS
Save its EXACT return value as JSON to: $SP/plan.json then output only DONE" \
    --allowedTools "Read,Grep,Glob,Edit,Write,Bash,Task,Workflow" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true
  [[ -s "$SP/plan.json" ]] || { echo "PROBE-RESULT: E1H arm=swarm ms=0 epics=0 stories=0 acs=0 coverage=GAP collision=ERR acyclic=n conformance=ERR tok=0 (no output)"; exit 1; }
  EPICS=$(jq '.epics|length' "$SP/plan.json" 2>/dev/null||echo 0)
  STORIES=$(jq '[.subtrees[].stories[]]|length' "$SP/plan.json" 2>/dev/null||echo 0)
  ACS=$(jq '[.subtrees[].stories[].criteria[]]|length' "$SP/plan.json" 2>/dev/null||echo 0)
  COVERED=$(jq -r '[.epics[].coversSpecIds[]]|unique[]' "$SP/plan.json" 2>/dev/null|sort -u)
  COLLISION=$(jq -r '[.subtrees[].stories[].touchPoints[]]|.[]' "$SP/plan.json" 2>/dev/null|sort|uniq -d|wc -l|tr -d ' ')
  ACYCLIC=$(jq -r '.epics' "$SP/plan.json" 2>/dev/null|python3 "$HERE/acyclic.py" 2>/dev/null||echo n)
  # contract-conformance: every Capitalized type token referenced in stories must appear in the surface
  CONFORMANCE=$(python3 "$HERE/conformance.py" "$SP/plan.json" 2>/dev/null||echo ERR)
else
  RIGOR='Production rigor: 10-20 stories, EACH with 4-6 acceptance criteria {id,text,needsBrowser,verify∈build|appearance|state|behavior|manual,+given/when/then}, a userStory{role,action,benefit}, technicalNotes, and tasks[]{id,text,acRefs} covering every AC.'
  claude -p "You are a planning PM. From the approved specs, output ONE JSON object:
{epics:[{epicId,title,goal,dependsOnEpics:[],coversSpecIds:[],stories:[{storyId,title,touchPoints:[],dependsOn:[],userStory:{role,action,benefit},technicalNotes,tasks:[{id,text,acRefs}],criteria:[{id,text,needsBrowser,verify,given,when,then}]}]}]}.
$RIGOR Cover every spec id (FR../SCREEN-../MOD-..). touchPoints are src/* (never *.test.*).
INTENT: $INTENT
SPECS:
$DOCS
Output ONLY the JSON." \
    --allowedTools "Read" --permission-mode bypassPermissions </dev/null > "$SP/raw.txt" 2>>"$LOG" || true
  python3 -c "import sys,re,json; t=open('$SP/raw.txt').read(); m=re.search(r'\{.*\}',t,re.S); open('$SP/plan.json','w').write(m.group(0) if m else '{}')" 2>/dev/null||echo '{}'>"$SP/plan.json"
  EPICS=$(jq '.epics|length' "$SP/plan.json" 2>/dev/null||echo 0)
  STORIES=$(jq '[.epics[].stories[]]|length' "$SP/plan.json" 2>/dev/null||echo 0)
  ACS=$(jq '[.epics[].stories[].criteria[]]|length' "$SP/plan.json" 2>/dev/null||echo 0)
  COVERED=$(jq -r '[.epics[].coversSpecIds[]]|unique[]' "$SP/plan.json" 2>/dev/null|sort -u)
  COLLISION=$(jq -r '[.epics[].stories[].touchPoints[]]|.[]' "$SP/plan.json" 2>/dev/null|sort|uniq -d|wc -l|tr -d ' ')
  ACYCLIC=$(jq -r '.epics' "$SP/plan.json" 2>/dev/null|python3 "$HERE/acyclic.py" 2>/dev/null||echo n)
  CONFORMANCE=na   # single-shot has no separate frozen surface to conform to
fi
END=$(now_ms); MS=$((END-START))
MISSING=$(comm -23 <(echo "$SPEC_IDS") <(echo "$COVERED")|grep -v '^$'||true)
COVERAGE=ok; [[ -n "$MISSING" ]] && COVERAGE="GAP[$(echo "$MISSING"|tr '\n' ','|sed 's/,$//')]"
TOK=$(node "$ROOT/probes/B1-harvester/harvest.mjs" "$WORK" --json 2>/dev/null|python3 -c 'import sys,json;d=json.load(sys.stdin);print(sum(e["inputTokens"]+e["outputTokens"] for e in d["agentEvents"]))' 2>/dev/null||echo 0)
echo "  arm=$ARM ms=$MS epics=$EPICS stories=$STORIES acs=$ACS coverage=$COVERAGE collision=$COLLISION acyclic=$ACYCLIC conformance=$CONFORMANCE tok=$TOK"
[[ -n "$MISSING" ]] && echo "  ⚠ uncovered: $(echo "$MISSING"|tr '\n' ' ')"
echo "PROBE-RESULT: E1H arm=$ARM ms=$MS epics=$EPICS stories=$STORIES acs=$ACS coverage=$COVERAGE collision=$COLLISION acyclic=$ACYCLIC conformance=$CONFORMANCE tok=$TOK work=$WORK"
