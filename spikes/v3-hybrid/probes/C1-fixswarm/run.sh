#!/usr/bin/env bash
# C1 — fix-swarm (WF-2) probe (spike test plan §3).
#
# Tests O7: is a parallel fix tournament actually faster than a serial single-fixer,
# and does the refuter reject a planted BAD fix? The replay study projected 26m→9m by
# DIVIDING serial time by 3 (perfect parallelism, ignoring the serial refuter loop).
# This measures both arms on real wall-clock and includes a negative control.
#
# Setup: a module with a KNOWN bug (off-by-one) and a failing test. Plus a HELD-OUT test
# the fixers never see (the refuter's oracle for a plausible-but-wrong fix).
#   arm serial   : one fixer, up to 3 sequential rounds.
#   arm swarm    : N=3 parallel fixers in scratch worktrees → refuter per candidate
#                  (must reject any that fails held-out) → vote → merge; escalate sonnet→opus.
#
# Emits: PROBE-RESULT: C1 arm=<serial|swarm> converged=<yes|no> ms=<n> badFixRejected=<yes|no|na>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ARM=swarm; [[ "${1:-}" == "--serial" ]] && ARM=serial
WORK="${SPIKE_WORK:-/tmp/v3-C1-$ARM-$(date +%s)}"; SP="$WORK/.spike"; mkdir -p "$WORK/src" "$SP"; LOG="$SP/run.log"; : > "$LOG"
now_ms(){ python3 -c 'import time;print(int(time.time()*1000))'; }
cd "$WORK"; git init -q; git config user.email c1@local; git config user.name c1
cat > package.json <<'J'
{ "name":"c1","type":"module","private":true,"devDependencies":{"vitest":"^2.1.0"} }
J
# buggy implementation (off-by-one in a range sum) + visible failing test + held-out test
cat > src/range.ts <<'TS'
export function sumTo(n: number): number { let s = 0; for (let i = 1; i < n; i++) s += i; return s } // BUG: i<n should be i<=n
TS
mkdir -p heldout
cat > src/range.test.ts <<'TS'
import { expect, it } from 'vitest'; import { sumTo } from './range'
it('sumTo(5)=15', () => expect(sumTo(5)).toBe(15))
TS
cat > heldout/range.holdout.test.ts <<'TS'
import { expect, it } from 'vitest'; import { sumTo } from '../src/range'
it('held-out sumTo(10)=55', () => expect(sumTo(10)).toBe(55))
it('held-out sumTo(1)=1', () => expect(sumTo(1)).toBe(1))
TS
echo node_modules > .gitignore; git add -A; git commit -qm base; git branch -f base HEAD
npm install --silent --no-audit --no-fund >>"$LOG" 2>&1 || true

START=$(now_ms); CONVERGED=no; BADREJ=na
if [[ "$ARM" == swarm ]]; then
  # the fix-swarm workflow: triage → 3 fixers in scratch worktrees → refuter (held-out) → vote
  run_workflow(){ claude -p "Run the dynamic workflow at: $1
Use this JSON as args: $3
Save its EXACT return value as JSON to: $2 then output only DONE" \
    --allowedTools "Read,Grep,Glob,Edit,Write,Bash,Task,Workflow" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true; }
  run_workflow "$ROOT/probes/C1-fixswarm/fixswarm.workflow.js" "$SP/swarm.json" \
    "$(jq -nc --arg w "$WORK" '{work:$w, file:"src/range.ts", failingTest:"src/range.test.ts", heldOut:"heldout/range.holdout.test.ts", n:3}')"
  # apply the chosen fix (the workflow returns the winning file content)
  jq -r '.result.fixedContent // .fixedContent // empty' "$SP/swarm.json" > /tmp/c1fix.ts 2>/dev/null || true
  [[ -s /tmp/c1fix.ts ]] && cp /tmp/c1fix.ts src/range.ts
  BADREJ=$(jq -r '.result.badFixRejected // .badFixRejected // "na"' "$SP/swarm.json" 2>/dev/null || echo na)
else
  # serial single-fixer, up to 3 rounds
  for r in 1 2 3; do
    claude -p "Fix the bug in $WORK/src/range.ts so that $WORK/src/range.test.ts passes. Edit only src/range.ts. Output DONE." \
      --allowedTools "Read,Write,Edit,Bash" --permission-mode bypassPermissions </dev/null >>"$LOG" 2>&1 || true
    npx vitest run src/range.test.ts --reporter=basic >>"$LOG" 2>&1 && break
  done
fi
END=$(now_ms); MS=$((END-START))
# final oracle: BOTH visible and held-out must pass (a fix that only passes visible is not converged)
npx vitest run src/range.test.ts heldout/range.holdout.test.ts --reporter=basic >>"$LOG" 2>&1 && CONVERGED=yes
echo "PROBE-RESULT: C1 arm=$ARM converged=$CONVERGED ms=$MS badFixRejected=$BADREJ work=$WORK"
