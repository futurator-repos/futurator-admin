#!/usr/bin/env bash
# D5 — scale / concurrency-cap probe (spike test plan §4). HEAVY (spawns many agents).
#
# Tests M-SCALE + the central thesis "JS cannot disobey maxParallel" (vs v2.5's prompt-only
# maxParallel=4 that the LLM orchestrator disobeys). Launch a workflow that fans out K=24 trivial
# agents (> the 16 cap) and verify from the journal that NO MORE THAN the cap ran CONCURRENTLY,
# and that all K completed (no silent truncation).
#
# Oracle: parse the per-agent transcript start/end timestamps; compute max concurrency; assert
# maxConcurrent <= 16 AND completed == K.
# Emits: PROBE-RESULT: D5 requested=<K> completed=<n> maxConcurrent=<n> capHonored=<yes|no> noTruncation=<yes|no>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
K="${SPIKE_FANOUT:-24}"
WORK="/tmp/v3-D5-$(date +%s)"; SP="$WORK/.spike"; mkdir -p "$SP"; LOG="$SP/run.log"; : > "$LOG"
cat > "$SP/scale.workflow.js" <<JS
// @workflow-invariants: v1
// @plan: D5 scale — fan out > cap, verify the runtime caps concurrency
export const meta = { name: 'd5', description: 'K trivial agents > concurrency cap', phases: [{ title: 'Fan' }] }
phase('Fan')
const K = $K
const r = await parallel(Array.from({length:K}, (_,i) => () =>
  agent(\`Return {stepId:"a\${i}", i:\${i}} immediately. Do nothing else.\`,
    { label: \`a\${i}\`, phase: 'Fan', model: 'haiku',
      schema: { type:'object', required:['stepId','i'], properties:{ stepId:{type:'string'}, i:{type:'number'} } } })))
return { count: r.filter(Boolean).length }
JS
claude -p "Run the dynamic workflow at: $SP/scale.workflow.js with args {}. Save return JSON to $SP/out.json. Output DONE." \
  --allowedTools "Read,Grep,Glob,Write,Bash,Task,Workflow" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true

# compute max concurrency from per-agent transcript spans
PROJ="$HOME/.claude/projects/$(echo "/private$WORK" | sed 's#[/.]#-#g')"
node "$HERE/../B1-harvester/harvest.mjs" "$WORK" --json > "$SP/harvest.json" 2>/dev/null || true
COMPLETED=$(jq -r '.agentEvents|length' "$SP/harvest.json" 2>/dev/null || echo 0)
# max concurrency via timestamp sweep across all agent transcripts
MAXC=$(node -e '
const fs=require("fs"),path=require("path"),os=require("os");
const proj=process.argv[1];
function walk(d,acc){for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())walk(p,acc);else if(/^agent-.*\.jsonl$/.test(e.name)){const ts=fs.readFileSync(p,"utf8").split("\n").filter(Boolean).map(l=>{try{return Date.parse(JSON.parse(l).timestamp)}catch{return NaN}}).filter(x=>!isNaN(x)).sort((a,b)=>a-b);if(ts.length>=2)acc.push([ts[0],ts[ts.length-1]])}}}
const iv=[];try{walk(proj,iv)}catch{}; const ev=[];for(const[s,e]of iv){ev.push([s,1]);ev.push([e,-1])}ev.sort((a,b)=>a[0]-b[0]||a[1]-b[1]);let c=0,m=0;for(const[,d]of ev){c+=d;if(c>m)m=c}console.log(m)
' "$PROJ" 2>/dev/null || echo "?")
CAP=no; [[ "$MAXC" =~ ^[0-9]+$ ]] && [[ "$MAXC" -le 16 ]] && CAP=yes
NOTRUNC=no; [[ "$COMPLETED" == "$K" ]] && NOTRUNC=yes
echo "PROBE-RESULT: D5 requested=$K completed=$COMPLETED maxConcurrent=$MAXC capHonored=$CAP noTruncation=$NOTRUNC work=$WORK"
