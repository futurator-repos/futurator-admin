#!/usr/bin/env bash
# C4 — standards-critic orthogonality probe (spike test plan §3).
#
# Tests O6b: does an app-standards critic catch a defect that passes tsc/eslint/tests AND
# that the correctness-refuter (mandate: "do the ACs hold?") misses? (Team-of-Rivals /
# Swiss-cheese: orthogonal critics catch distinct classes.) If both catch or both miss,
# the orthogonal critic adds no coverage.
#
# Setup: a module that is FUNCTIONALLY CORRECT (all ACs pass) but violates an app standard:
#   a 'god' function doing parsing + validation + formatting + IO in one 60-line block, and a
#   wrong-layer import (a pure util importing from a 'ui/' module). Two critics review the same diff:
#     - correctness-refuter: only asks whether the ACs hold
#     - standards-critic:    only asks whether app standards hold (cohesion, layering, abstraction)
# Oracle: standards-critic=FAIL while correctness-refuter=PASS  → orthogonal coverage proven.
# Emits: PROBE-RESULT: C4 correctness=<PASS|FAIL> standards=<PASS|FAIL> orthogonal=<yes|no>
set -euo pipefail
WORK="${SPIKE_WORK:-/tmp/v3-C4-$(date +%s)}"; SP="$WORK/.spike"; mkdir -p "$WORK/src/ui" "$SP"; LOG="$SP/run.log"; : > "$LOG"
cd "$WORK"
cat > src/ui/theme.ts <<'TS'
export const ACCENT = '#0bf'
TS
# correct-but-smelly module: passes a behavioural check, violates layering + cohesion
cat > src/invoice.ts <<'TS'
import { ACCENT } from './ui/theme' // WRONG-LAYER: a pure util importing UI
// god-function: parse + validate + compute + format + side-effect, all in one
export function processInvoice(raw: string): string {
  const parts = raw.split(','); if (parts.length !== 3) throw new Error('bad')
  const qty = Number(parts[1]); const price = Number(parts[2])
  if (qty < 0 || price < 0) throw new Error('neg')
  let total = qty * price; if (total > 1000) total = total * 0.9
  const tax = total * 0.2; const gross = total + tax
  const line = parts[0] + ': $' + gross.toFixed(2)
  console.log('[' + ACCENT + '] ' + line) // side effect + uses the bad import
  return line
}
TS
DIFF="$(cat src/invoice.ts)"
ask(){ claude -p "$1

=== FILE src/invoice.ts ===
$DIFF

Respond with EXACTLY one first line: VERDICT: PASS  or  VERDICT: FAIL" \
  --allowedTools "Read" --permission-mode bypassPermissions </dev/null 2>>"$LOG" | grep -m1 'VERDICT:' || echo "VERDICT: ?"; }

C="$(ask "You are a CORRECTNESS refuter. Your ONLY mandate: does processInvoice(raw) correctly parse 'name,qty,price', reject negatives, apply a 10% discount over 1000, add 20% tax, and return the formatted line? Ignore style entirely.")"
S="$(ask "You are an APP-STANDARDS critic. Your ONLY mandate: app standards — single-responsibility/cohesion, layering (a pure util must NOT import from ui/), no hidden side effects in a pure function. Ignore whether the math is correct.")"
CORR=$(echo "$C" | grep -q PASS && echo PASS || echo FAIL)
STD=$(echo "$S" | grep -q FAIL && echo FAIL || echo PASS)
ORTH=no; [[ "$CORR" == PASS && "$STD" == FAIL ]] && ORTH=yes
echo "PROBE-RESULT: C4 correctness=$CORR standards=$STD orthogonal=$ORTH work=$WORK"
