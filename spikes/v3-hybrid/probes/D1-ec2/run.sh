#!/usr/bin/env bash
# D1 — EC2 headless durability probe (spike test plan §4). ENV-GATED: EC2 + daemon.
#
# Tests O3b: headless workflow execution is async/background + completion-notification driven
# (forensics: the Workflow tool returns "launched in background" + the session uses ScheduleWakeup
# to bridge the wait). Does that await survive on a bare daemon `claude -p </dev/null` with NO
# interactive loop, and survive a mid-run instance SLEEP (SIGSTOP)?
#
# Run this ON the EC2 host under the daemon. It (1) runs the spike headless, (2) mid-run SIGSTOPs
# the claude process tree for 30s then SIGCONTs (simulating laptop-lid/instance sleep), (3) checks
# the run still completes and writes its result.
# Emits: PROBE-RESULT: D1 headlessComplete=<yes|no> survivedSleep=<yes|no|untested>
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# env gate
if [[ "${SPIKE_ALLOW_EC2:-0}" != 1 ]] && ! curl -s --max-time 1 http://169.254.169.254/latest/meta-data/instance-id >/dev/null 2>&1; then
  echo "PROBE-RESULT: D1 headlessComplete=untested survivedSleep=untested  (ENV-GATE: not on EC2; set SPIKE_ALLOW_EC2=1 to force)"
  exit 0
fi
WORK="/tmp/v3-D1-$(date +%s)"
SPIKE_WORK="$WORK" "$ROOT/run-spike.sh" </dev/null >/tmp/v3-D1.console 2>&1 &
RUN=$!
# wait for the dev phase to start, then sleep/resume the process tree
sleep 25
PIDS=$(pgrep -P $RUN; echo $RUN)
echo "  SIGSTOP $PIDS (simulating sleep)"; kill -STOP $PIDS 2>/dev/null || true
sleep 30
echo "  SIGCONT"; kill -CONT $PIDS 2>/dev/null || true
wait $RUN; EXIT=$?
COMPLETE=no; grep -q 'DONE — control=' /tmp/v3-D1.console && COMPLETE=yes
SLEPT=yes; [[ "$COMPLETE" == no ]] && SLEPT=no
echo "PROBE-RESULT: D1 headlessComplete=$COMPLETE survivedSleep=$SLEPT work=$WORK"
