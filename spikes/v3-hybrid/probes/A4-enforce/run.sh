#!/usr/bin/env bash
# A4 — enforce-mode blocking probe (spike test plan §1).
#
# Tests O3c: is the control gate a real GATE or just a report? Runs the existing
# spike with SPIKE_ENFORCE_RULES=1 --inject-violation and asserts that (a) the run
# exits non-zero before merge and (b) NO spike/main branch (= no merge) was created.
#
# Emits:  PROBE-RESULT: A4 exit=<code> merged=<yes|no> blocked=<yes|no>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="/tmp/v3-A4-$(date +%s)"
set +e
SPIKE_WORK="$WORK" SPIKE_ENFORCE_RULES=1 "$ROOT/run-spike.sh" --inject-violation >/tmp/v3-A4.console 2>&1
EXIT=$?
set -e
# the merge step creates branch spike/main; if the gate blocked, it must not exist
if git -C "$WORK" rev-parse --verify spike/main >/dev/null 2>&1; then MERGED=yes; else MERGED=no; fi
BLOCKED=no; { [[ "$EXIT" != 0 ]] && [[ "$MERGED" == no ]]; } && BLOCKED=yes
echo "PROBE-RESULT: A4 exit=$EXIT merged=$MERGED blocked=$BLOCKED work=$WORK"
