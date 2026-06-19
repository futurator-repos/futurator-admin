#!/usr/bin/env bash
# sweep.sh — run every Mac-runnable probe once, collect PROBE-RESULT lines.
# Each probe gets a watchdog (no `timeout` binary on stock macOS). Env-gated probes
# (D1 EC2, D3 Memgraph) self-skip and report their gate. Results → results/sweep-<ts>.md
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$HERE/results/sweep-$TS.md"
WATCH="${SWEEP_WATCHDOG:-720}"   # seconds per probe
: > "$OUT"
echo "# v3-hybrid probe sweep — $TS (CLI $(claude --version 2>/dev/null | head -1))" >> "$OUT"
echo "" >> "$OUT"

run_probe(){ # $1 label  $2.. command
  local label="$1"; shift
  echo "▸ $label ..."
  local tmp; tmp="$(mktemp)"
  ( "$@" >"$tmp" 2>&1 ) &
  local pid=$!
  local w=0
  while kill -0 $pid 2>/dev/null; do
    sleep 5; w=$((w+5))
    if [[ $w -ge $WATCH ]]; then
      echo "  ⏱ watchdog killed $label after ${WATCH}s"
      pkill -P $pid 2>/dev/null; kill -9 $pid 2>/dev/null
      break
    fi
  done
  wait $pid 2>/dev/null
  local line; line="$(grep -h '^PROBE-RESULT:' "$tmp" | head -1)"
  [[ -z "$line" ]] && line="PROBE-RESULT: $label (no result — see transcript; watchdog=${w}s)"
  echo "  $line"
  echo "- \`$line\`" >> "$OUT"
  rm -f "$tmp"
}

# ---- Round A (remaining) ----
run_probe A1-stub      bash "$HERE/A1-shared-contract/run.sh" --stub
run_probe A2-blind     bash "$HERE/A2-anticheat/run.sh"
run_probe A2-readable  bash "$HERE/A2-anticheat/run.sh" --readable
run_probe A4-enforce   bash "$HERE/A4-enforce/run.sh"
run_probe A5-capability bash "$HERE/A5-capability/run.sh"
# ---- Round B ----
run_probe B2-ab        bash "$HERE/B2-ab/run.sh"
# ---- Round C ----
run_probe C1-swarm     bash "$HERE/C1-fixswarm/run.sh"
run_probe C1-serial    bash "$HERE/C1-fixswarm/run.sh" --serial
run_probe C2-cascade   bash "$HERE/C2-cascade/run.sh"
run_probe C3-collision bash "$HERE/C3-collision/run.sh"
run_probe C4-standards bash "$HERE/C4-standards/run.sh"
# ---- Round D (Mac-runnable + env-gated self-skip) ----
run_probe D1-ec2       bash "$HERE/D1-ec2/run.sh"
run_probe D2-resume    bash "$HERE/D2-resume/run.sh"
run_probe D3-graph     bash "$HERE/D3-graph/run.sh"
run_probe D4-multimodel bash "$HERE/D4-multimodel/run.sh"
run_probe D5-scale     bash "$HERE/D5-scale/run.sh"

echo "" >> "$OUT"
echo "▸ sweep complete → $OUT"
cat "$OUT"
