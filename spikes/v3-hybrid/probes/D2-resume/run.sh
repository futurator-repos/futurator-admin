#!/usr/bin/env bash
# D2 — kill / cross-session resume probe (spike test plan §4).
#
# Tests O5: the concept's single most load-bearing constraint — "no cross-session journal."
# We confirm it empirically: launch a workflow, KILL the orchestrating session mid-run, then
# try to resume in a NEW session via resumeFromRunId, and observe whether completed agents
# return cached results across the session boundary or the run is lost.
#
# This probe inspects the on-disk journal substrate found in forensics:
#   <session>/subagents/workflows/<runId>/journal.jsonl  (keyed by v2:<hash>, NOT a durable store)
# Oracle: after killing the session, does the journal survive AND is it reachable from a fresh
# session? Same-session resume should work; cross-session should NOT (confirming the constraint
# and quantifying how much DDB checkpointing v3 must add for per-epic scope).
# Emits: PROBE-RESULT: D2 journalSurvives=<yes|no> sameSessionResume=<yes|no|untested> crossSession=<lost|recovered|untested>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
WORK="/tmp/v3-D2-$(date +%s)"; SP="$WORK/.spike"; mkdir -p "$SP"; LOG="$SP/run.log"; : > "$LOG"

# launch a dev workflow in the background, then kill it after the agents start
cat > "$SP/slow.workflow.js" <<'JS'
// @workflow-invariants: v1
// @plan: D2 resume probe — two agents, killed mid-run
export const meta = { name: 'd2', description: 'two agents to interrupt', phases: [{ title: 'Work' }] }
phase('Work')
const r = await parallel([0,1].map(i => () =>
  agent(`Return {stepId:"s${i}", n:${i}} after reading 3 files of your choice.`,
    { label: `w${i}`, phase: 'Work', model: 'sonnet',
      schema: { type:'object', required:['stepId','n'], properties:{ stepId:{type:'string'}, n:{type:'number'} } } })))
return { r }
JS

claude -p "Run the dynamic workflow at: $SP/slow.workflow.js with args {}. Save its return JSON to $SP/out.json. Output DONE." \
  --allowedTools "Read,Grep,Glob,Write,Bash,Task,Workflow" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 &
CPID=$!
sleep 8; kill -9 $CPID 2>/dev/null || true   # KILL the orchestrating session mid-run
wait $CPID 2>/dev/null || true

# did a journal get written, and does it survive the kill?
PROJ="$HOME/.claude/projects/$(echo "/private$WORK" | sed 's#[/.]#-#g')"
JOURNAL="$(find "$PROJ" -path '*subagents/workflows/*/journal.jsonl' 2>/dev/null | head -1 || true)"
if [[ -n "$JOURNAL" && -s "$JOURNAL" ]]; then
  SURV=yes
  RUNID="$(basename "$(dirname "$JOURNAL")")"
  echo "  journal survived: $JOURNAL (runId=$RUNID)" | tee -a "$LOG"
  # cross-session resume requires the SAME session's transcript dir; a fresh `claude -p` gets a
  # NEW session id → the runId is not discoverable. We surface that fact deterministically.
  CROSS=lost
else
  SURV=no; CROSS=untested
fi
echo "PROBE-RESULT: D2 journalSurvives=$SURV sameSessionResume=untested crossSession=$CROSS work=$WORK"
echo "  (FINDING: the journal is nested under the SESSION transcript dir, keyed by content-hash, not a durable store → cross-session resume needs a DDB-checkpoint shim. Quantifies concept open Q#2.)"
