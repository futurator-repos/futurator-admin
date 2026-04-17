#!/bin/bash
# Test harness for scripts/emit-event.sh (EO-2.2).
# Run manually: bash scripts/__tests__/emit-event.test.sh
# Exits 0 on all-pass, non-zero with a failure summary otherwise.

set -u

SCRIPT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
EMIT="${SCRIPT_DIR}/emit-event.sh"
TMP_ROOT="$(mktemp -d -t emit-event-test.XXXXXX)"
export FUTURATOR_EVENT_LOG_DIR="${TMP_ROOT}/events"

pass=0
fail=0
failures=()

assert() {
  local name="$1"
  local actual_exit="$2"
  local expected_exit="$3"
  if [ "$actual_exit" -eq "$expected_exit" ]; then
    pass=$((pass + 1))
    printf '  ✓ %s\n' "$name"
  else
    fail=$((fail + 1))
    failures+=("${name} (expected exit ${expected_exit}, got ${actual_exit})")
    printf '  ✗ %s (expected exit %s, got %s)\n' "$name" "$expected_exit" "$actual_exit"
  fi
}

cleanup() { rm -rf "$TMP_ROOT"; }
trap cleanup EXIT

echo "== emit-event.sh tests =="
echo "log dir: $FUTURATOR_EVENT_LOG_DIR"
echo

# Happy path
HAPPY='{"jobId":"job-test-1","epicId":"E-1","waveNumber":1,"role":"orchestrator","eventType":"wave_start","payload":{}}'
bash "$EMIT" "$HAPPY" >/dev/null 2>&1
assert "happy path — exit 0" $? 0
if [ -f "${FUTURATOR_EVENT_LOG_DIR}/job-test-1.ndjson" ]; then
  lines=$(wc -l < "${FUTURATOR_EVENT_LOG_DIR}/job-test-1.ndjson" | tr -d ' ')
  if [ "$lines" = "1" ]; then
    pass=$((pass + 1))
    printf '  ✓ happy path — exactly one line written\n'
  else
    fail=$((fail + 1))
    failures+=("expected 1 line, got $lines")
    printf '  ✗ happy path — expected 1 line, got %s\n' "$lines"
  fi
else
  fail=$((fail + 1))
  failures+=("ndjson file not created")
  printf '  ✗ happy path — ndjson file not created\n'
fi

# Append semantics
bash "$EMIT" "$HAPPY" >/dev/null 2>&1
bash "$EMIT" "$HAPPY" >/dev/null 2>&1
lines=$(wc -l < "${FUTURATOR_EVENT_LOG_DIR}/job-test-1.ndjson" | tr -d ' ')
if [ "$lines" = "3" ]; then
  pass=$((pass + 1))
  printf '  ✓ appends rather than truncates (3 lines)\n'
else
  fail=$((fail + 1))
  failures+=("appends: expected 3 lines, got $lines")
  printf '  ✗ appends — expected 3 lines, got %s\n' "$lines"
fi

# Invalid JSON
bash "$EMIT" 'not-a-json' >/dev/null 2>&1
assert "invalid JSON — exit 2" $? 2

# Missing jobId
bash "$EMIT" '{"epicId":"E","waveNumber":1,"role":"orchestrator","eventType":"wave_start"}' >/dev/null 2>&1
assert "missing jobId — exit 3" $? 3

# Missing epicId
bash "$EMIT" '{"jobId":"j","waveNumber":1,"role":"orchestrator","eventType":"wave_start"}' >/dev/null 2>&1
assert "missing epicId — exit 3" $? 3

# Missing waveNumber
bash "$EMIT" '{"jobId":"j","epicId":"E","role":"orchestrator","eventType":"wave_start"}' >/dev/null 2>&1
assert "missing waveNumber — exit 3" $? 3

# Missing role
bash "$EMIT" '{"jobId":"j","epicId":"E","waveNumber":1,"eventType":"wave_start"}' >/dev/null 2>&1
assert "missing role — exit 3" $? 3

# Missing eventType
bash "$EMIT" '{"jobId":"j","epicId":"E","waveNumber":1,"role":"orchestrator"}' >/dev/null 2>&1
assert "missing eventType — exit 3" $? 3

# No arg
bash "$EMIT" >/dev/null 2>&1
assert "no argument — exit 2" $? 2

# Auto-create log dir
rm -rf "${FUTURATOR_EVENT_LOG_DIR}"
bash "$EMIT" '{"jobId":"job-auto","epicId":"E","waveNumber":1,"role":"dev","eventType":"subagent_return"}' >/dev/null 2>&1
assert "auto-create log dir — exit 0" $? 0
if [ -f "${FUTURATOR_EVENT_LOG_DIR}/job-auto.ndjson" ]; then
  pass=$((pass + 1))
  printf '  ✓ auto-create log dir — file exists\n'
else
  fail=$((fail + 1))
  failures+=("auto-create: file missing")
  printf '  ✗ auto-create log dir — file missing\n'
fi

# Oversized event (> 4096 bytes)
BIG=$(printf '{"jobId":"big","epicId":"E","waveNumber":1,"role":"dev","eventType":"tool_use","payload":{"x":"%s"}}' "$(printf 'a%.0s' $(seq 1 5000))")
bash "$EMIT" "$BIG" >/dev/null 2>&1
assert "oversized event (>4KB) — exit 4" $? 4

echo
echo "passed: $pass"
echo "failed: $fail"

if [ "$fail" -gt 0 ]; then
  echo
  echo "failures:"
  for f in "${failures[@]}"; do echo "  - $f"; done
  exit 1
fi
