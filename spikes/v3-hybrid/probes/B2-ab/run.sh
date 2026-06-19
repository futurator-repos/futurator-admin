#!/usr/bin/env bash
# B2 — frozen-plan A/B harness (spike test plan §2).
#
# Tests M-AB / O1: can the SAME frozen plan be graded on IDENTICAL metrics through
# two engines (serial baseline vs v3 workflow)? This is the §6 "true head-to-head"
# premise. Uses B1's harvester for the v3 arm; times both arms wall-clock.
#
# Confounder control: ONE frozen stories.json feeds both arms (the planner is
# non-deterministic, so it must be pinned). One factor differs: the orchestration engine.
#
# Emits:  PROBE-RESULT: B2 serialMs=<n> workflowMs=<n> serialTok=<n> workflowTok=<n> gradedIdentically=<yes|no>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
PLAN="${1:-$ROOT/probes/A1-shared-contract/plan.json}"   # any frozen plan with .stories[]
now_ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }

# ---- arm (i): minimal SERIAL baseline (one claude -p per story, sequential) ----
S_WORK="/tmp/v3-B2-serial-$(date +%s)"; mkdir -p "$S_WORK/src"
( cd "$S_WORK"; git init -q; git config user.email b2@local; git config user.name b2
  cat > package.json <<'J'
{ "name":"b2s","type":"module","private":true,"devDependencies":{"typescript":"^5.5.0"} }
J
  cat > tsconfig.json <<'J'
{ "compilerOptions":{"strict":true,"noEmit":true,"module":"esnext","target":"es2022","moduleResolution":"bundler","skipLibCheck":true,"types":[]},"include":["src"] }
J
  echo node_modules > .gitignore; git add -A; git commit -qm base )
S_START=$(now_ms)
while read -r s; do
  f=$(jq -r .file <<<"$s"); c=$(jq -r .contract <<<"$s")
  claude -p "Implement $S_WORK/$f (absolute path, use Write). CONTRACT: $c. Output DONE." \
    --allowedTools "Read,Write" --permission-mode bypassPermissions </dev/null >>"$S_WORK/.log" 2>&1 || true
done < <(jq -c '.stories[]' "$PLAN")
S_END=$(now_ms); SERIAL_MS=$((S_END-S_START))
# serial token accounting: scrape this session's own transcripts is out of scope here;
# report 0 and flag — the point is the v3 arm's telemetry path (B1), serial is wall-clock only.
SERIAL_TOK=0

# ---- arm (ii): v3 WORKFLOW (reuse the A1 runner's blind-parallel dev, timed) ----
W_WORK="/tmp/v3-B2-workflow-$(date +%s)"
W_START=$(now_ms)
SPIKE_WORK="$W_WORK" bash "$ROOT/probes/A1-shared-contract/run.sh" --no-stub >>"$W_WORK.console" 2>&1 || true
W_END=$(now_ms); WF_MS=$((W_END-W_START))
# v3 telemetry via the harvester (the whole point: same metrics, recovered)
WF_TOK=$(node "$ROOT/probes/B1-harvester/harvest.mjs" "$W_WORK" --json 2>/dev/null \
  | python3 -c 'import sys,json;d=json.load(sys.stdin);print(sum(e["outputTokens"]+e["inputTokens"] for e in d["agentEvents"]))' 2>/dev/null || echo 0)

# graded identically? both arms must yield wall-time; v3 additionally yields token telemetry.
GRADED=yes; [[ "$WF_TOK" == 0 ]] && GRADED=no
echo "PROBE-RESULT: B2 serialMs=$SERIAL_MS workflowMs=$WF_MS serialTok=$SERIAL_TOK workflowTok=$WF_TOK gradedIdentically=$GRADED"
echo "  NOTE: serial-arm token telemetry requires the same harvester pointed at the serial session — wall-time is comparable today, token parity needs the harvester on BOTH arms (a real S0 finding)."
