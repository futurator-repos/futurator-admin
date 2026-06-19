#!/usr/bin/env bash
# D4 — multi-model critic probe (spike test plan §4).
#
# Tests O9/O2b: does an OPUS refuter catch a defect that a SONNET refuter (same family as the
# sonnet dev) rubber-stamps? Same-model author+critic share blind spots (§9 honesty checkpoint).
# Defect class: a locale/timezone/rounding edge a sonnet pair tends to rationalise.
#
# Setup: a date-formatting function with a subtle off-by-one in month indexing (Date months are
# 0-based) that LOOKS right. Two refuters review the SAME code with the SAME mandate; only the
# model differs. Oracle: opus=FAIL while sonnet=PASS over N runs ⇒ measurable tier-diversity value.
# Emits: PROBE-RESULT: D4 sonnetRefuter=<PASS|FAIL> opusRefuter=<PASS|FAIL> diversityValue=<yes|no>
set -euo pipefail
WORK="/tmp/v3-D4-$(date +%s)"; mkdir -p "$WORK"; LOG="$WORK/log"; : > "$LOG"
cat > "$WORK/fmt.ts" <<'TS'
// Format a Date as "YYYY-MM-DD". MONTHS is 0-based in JS Date.
export function ymd(d: Date): string {
  const m = String(d.getMonth()).padStart(2, '0')   // BUG: getMonth() is 0-based; needs +1
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
TS
CODE="$(cat "$WORK/fmt.ts")"
ask(){ claude -p "You are an adversarial REFUTER. Find any correctness bug in this function. Consider edge cases
carefully (date/month indexing, off-by-one, locale). If it is fully correct say VERDICT: PASS, else VERDICT: FAIL.

$CODE

First line EXACTLY: VERDICT: PASS  or  VERDICT: FAIL" --model "$1" --allowedTools "Read" \
  --permission-mode bypassPermissions </dev/null 2>>"$LOG" | grep -m1 'VERDICT:' || echo "VERDICT: ?"; }
S="$(ask sonnet)"; O="$(ask opus)"
SR=$(echo "$S" | grep -q FAIL && echo FAIL || echo PASS)
OR=$(echo "$O" | grep -q FAIL && echo FAIL || echo PASS)
DIV=no; [[ "$SR" == PASS && "$OR" == FAIL ]] && DIV=yes
echo "PROBE-RESULT: D4 sonnetRefuter=$SR opusRefuter=$OR diversityValue=$DIV work=$WORK"
