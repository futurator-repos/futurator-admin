#!/usr/bin/env bash
# E2-S2 — pm-plan prompt trim probe (deterministic; no LLM, no daemon).
#
# Renders the REAL buildPmPlanPrompt at the current revision, counts instruction
# tokens, compares to the recorded pre-slim baseline, and verifies no per-story
# field instruction was dropped (FR-B1 reduction + FR-B2 field-preservation).
# Writes ../../results/E2-prompt-trim.json.
#
# Emits: PROBE-RESULT: E2 baselineChars=<n> postChars=<n> delta=<n> pct=<n> fieldsHeld=<bool> verdict=<PASS|FAIL>
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
cd "$REPO"
npx tsx "$HERE/measure.mjs" "$@"
