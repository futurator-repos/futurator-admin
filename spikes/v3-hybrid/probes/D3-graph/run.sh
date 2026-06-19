#!/usr/bin/env bash
# D3 — brownfield graph-gate probe (spike test plan §4). ENV-GATED: Memgraph + brownfield clone.
#
# Tests O6: on a REAL repo with the Mycelium graph live, does (a) the scout brief measurably
# change the plan vs a no-graph arm, (b) the graph-gate WARN on a PLANTED cross-layer import,
# (c) the degradation path fail-open to advisory when Memgraph is killed mid-run?
#
# Usage: SPIKE_BROWNFIELD=/path/to/clone ./run.sh   (Memgraph must be on :7687)
# Emits: PROBE-RESULT: D3 graphUp=<yes|no> briefChangedPlan=<yes|no|untested> gateCaughtViolation=<yes|no|untested> degradedOk=<yes|no|untested>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BF="${SPIKE_BROWNFIELD:-}"
if ! { command -v nc >/dev/null && nc -z localhost 7687 2>/dev/null; }; then
  echo "PROBE-RESULT: D3 graphUp=no briefChangedPlan=untested gateCaughtViolation=untested degradedOk=untested  (ENV-GATE: Memgraph down on :7687 — start it, then re-run)"
  exit 0
fi
if [[ -z "$BF" || ! -d "$BF/.git" ]]; then
  echo "PROBE-RESULT: D3 graphUp=yes briefChangedPlan=untested gateCaughtViolation=untested degradedOk=untested  (ENV-GATE: set SPIKE_BROWNFIELD=/path/to/repo clone)"
  exit 0
fi
# arm A: graph-on plan brief ; arm B: graph-off plan brief — diff them
WORK="/tmp/v3-D3-$(date +%s)"; mkdir -p "$WORK"
( cd "$BF" && git branch -f base origin/main 2>/dev/null || git branch -f base HEAD )
SPIKE_WORK="$WORK/on"  SPIKE_FEATURE="add a small reporting helper consistent with this repo" "$ROOT/run-spike.sh" --with-graph >"$WORK/on.console" 2>&1 || true
SPIKE_WORK="$WORK/off" SPIKE_FEATURE="add a small reporting helper consistent with this repo" "$ROOT/run-spike.sh"              >"$WORK/off.console" 2>&1 || true
CHANGED=no
diff <(jq -S '.brief//""' "$WORK/on/.spike/plan.json" 2>/dev/null) <(jq -S '.brief//""' "$WORK/off/.spike/plan.json" 2>/dev/null) >/dev/null 2>&1 || CHANGED=yes
# the gate result (planted-violation injection + degradation are follow-ups documented in the brief)
GATE="$(grep -o 'GRAPH-GATE: [A-Z]*' "$WORK/on/.spike/graph-gate.txt" 2>/dev/null | head -1 || echo untested)"
echo "PROBE-RESULT: D3 graphUp=yes briefChangedPlan=$CHANGED gateResult=${GATE:-untested} gateCaughtViolation=untested degradedOk=untested work=$WORK"
echo "  (NEXT: plant a cross-layer import in $BF and assert GRAPH-GATE: WARN; kill Memgraph mid-run and assert advisory.)"
