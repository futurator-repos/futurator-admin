#!/usr/bin/env bash
# A3 — statistical harness (spike test plan §1).
#
# Tests M-STAT: turns n=1 anecdotes into pass-rate distributions against a runtime
# that demonstrably varies run-to-run. Wraps ANY probe that emits a `PROBE-RESULT:` line.
#
# Usage:  ./run-n.sh <N> <probe-command...>
#   e.g.  ./run-n.sh 10 bash probes/A1-shared-contract/run.sh --no-stub
#
# Acceptance discipline (from the plan): deterministic gates MUST be N/N; agent
# behaviours get a published pass-rate + variance. Stamps CLI version per run.
set -euo pipefail
N="${1:?usage: run-n.sh <N> <probe-command...>}"; shift
CMD=("$@")
CLI="$(claude --version 2>/dev/null | head -1 || echo unknown)"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="$HERE/../results/$(echo "${CMD[*]}" | tr ' /' '__')-$(date +%s).csv"
echo "run,cli,result_line" > "$OUT"
echo "▸ A3: $N runs of: ${CMD[*]}"
echo "  cli: $CLI"
echo "  csv: $OUT"
for i in $(seq 1 "$N"); do
  line="$("${CMD[@]}" 2>/dev/null | grep '^PROBE-RESULT:' | head -1 || echo 'PROBE-RESULT: (none)')"
  printf '%s,%s,"%s"\n' "$i" "$CLI" "$line" >> "$OUT"
  echo "  run $i/$N → $line"
done
echo; echo "▸ distribution over $N runs (bash-3.2 portable, tallied from CSV):"
# tally the first salient key=value (drift|cheated|converged|blocked|refused|orthogonal|rework)
grep -oE '(drift|cheated|converged|blocked|refused|orthogonal|rework|collisionDetected)=[a-zA-Z]+' "$OUT" \
  | sort | uniq -c | awk -v n="$N" '{printf "  %-26s %d/%d\n",$2,$1,n}'
echo "  (full rows: $OUT)"
