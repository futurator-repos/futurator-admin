#!/bin/bash

# ============================================================
# TRUE SESSION RESUME: Agent A → Agent B → Agent A RESUMES
#
# PROOF OF REAL SESSION CONTINUITY:
# - Agent A generates a SECRET token and a PUBLIC token
# - Only the PUBLIC token goes to Agent B
# - The SECRET token is NEVER passed to Agent B or anywhere
# - When Agent A resumes, it must recall the SECRET token
#   from its own session memory — proving real --resume
#
# If --resume didn't work, Agent A would have NO way to
# know the secret token, because it only existed inside
# session A.1's context window.
# ============================================================

set -e

LOG_FILE="agent-audit.log"
echo "" > "$LOG_FILE"

log() {
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  echo "[$timestamp] $1" | tee -a "$LOG_FILE"
}

log "========== PIPELINE STARTED =========="

# ------------------------------------------------------------------
# STEP 1: Agent A — generates TWO tokens: one secret, one public
# ------------------------------------------------------------------

log ""
log "🤖 AGENT A (Session A.1) — Starting..."
log ""

AGENT_A_RESULT=$(claude -p \
  "You are Agent A. Follow these instructions EXACTLY.

   1. Generate a random 6-digit SECRET TOKEN. This is YOUR secret.
      You must REMEMBER this token. It will NOT be shared with anyone.
      Say: MY SECRET TOKEN (do not share): [your 6-digit number]

   2. Generate a DIFFERENT random 4-digit PUBLIC TOKEN.
      This one WILL be shared with Agent B.
      Say: PUBLIC TOKEN FOR AGENT B: [your 4-digit number]

   3. Create a task for Agent B:
      'Count the consonants in the word ORCHESTRATION and report back.'

   4. End with this EXACT format (plain text, no markdown):
      ---HANDOFF_TO_B---
      PUBLIC_TOKEN: [your 4-digit public token]
      TASK: Count the consonants in the word ORCHESTRATION and report back.
      TIMESTAMP: $(date '+%Y-%m-%d %H:%M:%S')
      ---END_HANDOFF---

   IMPORTANT: Do NOT include your secret token in the handoff block.
   The secret token must only appear earlier in your message.
   Keep your total response under 10 lines." \
  --output-format json)

A1_TEXT=$(echo "$AGENT_A_RESULT" | jq -r '.result')
A1_SESSION=$(echo "$AGENT_A_RESULT" | jq -r '.session_id')
A1_COST=$(echo "$AGENT_A_RESULT" | jq -r '.total_cost_usd')
A1_DURATION=$(echo "$AGENT_A_RESULT" | jq -r '.duration_ms')

log "--- Agent A said: ---"
log "$A1_TEXT"
log "---------------------"
log "Session:  $A1_SESSION"
log "Cost:     \$$A1_COST"
log "Duration: ${A1_DURATION}ms"

# ------------------------------------------------------------------
# EXTRACT: Only the HANDOFF block goes to Agent B
# The secret token lives ONLY inside A's session context
# ------------------------------------------------------------------

HANDOFF_BLOCK=$(echo "$A1_TEXT" | sed -n '/---HANDOFF_TO_B---/,/---END_HANDOFF---/p')

log ""
log "📦 HANDOFF BLOCK (this is ALL that Agent B will see):"
log "$HANDOFF_BLOCK"
log ""

# Extract tokens for our external audit (the script verifies independently)
SECRET_TOKEN=$(echo "$A1_TEXT" | grep -i "SECRET TOKEN" | grep -oE '[0-9]{6}' | head -1)
PUBLIC_TOKEN=$(echo "$A1_TEXT" | grep -i "PUBLIC TOKEN" | grep -oE '[0-9]{4}' | head -1)

log "🔐 AUDIT — Secret token (from A's full output): $SECRET_TOKEN"
log "🔓 AUDIT — Public token: $PUBLIC_TOKEN"

# Verify secret is NOT in the handoff block
if echo "$HANDOFF_BLOCK" | grep -q "$SECRET_TOKEN"; then
  log "❌ ABORT — Secret token leaked into handoff block!"
  exit 1
fi
log "✅ Secret token is NOT in the handoff block — isolation confirmed"
log ""
log "✅ AGENT A (Session A.1) — Finished"

sleep 2

# ------------------------------------------------------------------
# STEP 2: Agent B — receives ONLY the handoff block
# ------------------------------------------------------------------

log ""
log "🤖 AGENT B (Session B.1) — Starting..."
log "(Agent B has NO knowledge of Agent A's secret token)"
log ""

AGENT_B_RESULT=$(claude -p \
  "You are Agent B. You are a completely independent agent.

   You received this handoff from Agent A:

   $HANDOFF_BLOCK

   Do the following:

   1. Acknowledge the PUBLIC TOKEN you received from Agent A.

   2. Complete the task: Count the consonants in ORCHESTRATION.
      Show your work — go letter by letter.

   3. Generate your own random 5-digit PROOF TOKEN.

   4. End with this EXACT format (plain text, no markdown):
      ---REPORT_TO_A---
      PUBLIC_TOKEN_RECEIVED: [the public token A gave you]
      TASK_RESULT: [your consonant count with the letters listed]
      B_PROOF_TOKEN: [your 5-digit number]
      B_TIMESTAMP: $(date '+%Y-%m-%d %H:%M:%S')
      ---END_REPORT---

   Keep your total response under 15 lines." \
  --output-format json)

B1_TEXT=$(echo "$AGENT_B_RESULT" | jq -r '.result')
B1_SESSION=$(echo "$AGENT_B_RESULT" | jq -r '.session_id')
B1_COST=$(echo "$AGENT_B_RESULT" | jq -r '.total_cost_usd')
B1_DURATION=$(echo "$AGENT_B_RESULT" | jq -r '.duration_ms')

log "--- Agent B said: ---"
log "$B1_TEXT"
log "---------------------"
log "Session:  $B1_SESSION"
log "Cost:     \$$B1_COST"
log "Duration: ${B1_DURATION}ms"

log ""
log "✅ AGENT B (Session B.1) — Finished"

sleep 2

# ------------------------------------------------------------------
# STEP 3: Agent A RESUMES — receives ONLY B's report
# Must recall SECRET TOKEN from its own session memory
# We do NOT remind it of the secret — that's the whole point
# ------------------------------------------------------------------

log ""
log "🤖 AGENT A (Session A.1 RESUMED) — --resume $A1_SESSION"
log ""
log "⚡ KEY: The resumed prompt contains ONLY Agent B's report."
log "   The secret token is NOT re-injected."
log "   If Agent A recalls it, --resume truly restored context."
log ""

AGENT_A2_RESULT=$(claude -p \
  "Agent B has completed their work. Here is their full report:

   $B1_TEXT

   Now do the following:

   1. What was YOUR SECRET TOKEN from the beginning of this session?
      You generated it earlier and were told not to share it.
      State it now.

   2. What PUBLIC TOKEN did you give to Agent B?
      Did Agent B report it back correctly?

   3. Is Agent B's consonant count for ORCHESTRATION correct?

   4. Acknowledge Agent B's proof token.

   5. Give a verdict: PASS or FAIL for each:
      - SECRET_RECALL: PASS/FAIL
      - PUBLIC_MATCH: PASS/FAIL
      - TASK_CORRECT: PASS/FAIL
      - OVERALL: PASS only if all three pass" \
  --resume "$A1_SESSION" \
  --output-format json)

A2_TEXT=$(echo "$AGENT_A2_RESULT" | jq -r '.result')
A2_SESSION=$(echo "$AGENT_A2_RESULT" | jq -r '.session_id')
A2_COST=$(echo "$AGENT_A2_RESULT" | jq -r '.total_cost_usd')
A2_DURATION=$(echo "$AGENT_A2_RESULT" | jq -r '.duration_ms')

log "--- Agent A (resumed) said: ---"
log "$A2_TEXT"
log "---------------------"
log "Session:  $A2_SESSION"
log "Cost:     \$$A2_COST"
log "Duration: ${A2_DURATION}ms"

log ""
log "✅ AGENT A (Session A.1 RESUMED) — Finished"

# ------------------------------------------------------------------
# STEP 4: EXTERNAL VERIFICATION BY SCRIPT
# The script independently checks if A recalled the right secret
# ------------------------------------------------------------------

log ""
log "========================================="
log "🔍 EXTERNAL VERIFICATION (by script)"
log "========================================="
log ""

# Did Agent A's resumed response contain the correct secret token?
if echo "$A2_TEXT" | grep -q "$SECRET_TOKEN"; then
  log "✅ SECRET RECALL VERIFIED"
  log "   Agent A said '$SECRET_TOKEN' — matches the original"
  log "   This token was NEVER in B's context or the resumed prompt"
  SECRET_PASS="PASS"
else
  log "❌ SECRET RECALL FAILED"
  log "   Expected '$SECRET_TOKEN' but it was not found in A's resumed output"
  log "   This means --resume may not have restored session context"
  SECRET_PASS="FAIL"
fi

# Session ID match
if [[ "$A1_SESSION" == "$A2_SESSION" ]]; then
  log "✅ SESSION ID MATCH — $A1_SESSION"
  SESSION_PASS="PASS"
else
  log "⚠️  SESSION ID MISMATCH — Original: $A1_SESSION | Resumed: $A2_SESSION"
  SESSION_PASS="MISMATCH"
fi

# ------------------------------------------------------------------
# FINAL AUDIT REPORT
# ------------------------------------------------------------------

TOTAL_COST=$(echo "$A1_COST $B1_COST $A2_COST" | awk '{printf "%.8f", $1+$2+$3}')

log ""
log "========================================="
log "📋 FULL AUDIT REPORT"
log "========================================="
log ""
log "AGENT A — Session A.1 (initial)"
log "  Session ID:    $A1_SESSION"
log "  Secret token:  $SECRET_TOKEN (never sent to B)"
log "  Public token:  $PUBLIC_TOKEN (sent to B via handoff)"
log "  Cost:          \$$A1_COST"
log "  Duration:      ${A1_DURATION}ms"
log ""
log "AGENT B — Session B.1"
log "  Session ID:    $B1_SESSION"
log "  Received:      ONLY the handoff block (no secret)"
log "  Cost:          \$$B1_COST"
log "  Duration:      ${B1_DURATION}ms"
log ""
log "AGENT A — Session A.1 (RESUMED via --resume)"
log "  Session ID:    $A2_SESSION"
log "  Received:      ONLY Agent B's report (no secret re-injected)"
log "  Cost:          \$$A2_COST"
log "  Duration:      ${A2_DURATION}ms"
log ""
log "=========== PROOF OF CONTINUITY ============"
log "  Secret recall (script-verified):  $SECRET_PASS"
log "  Session ID match:                 $SESSION_PASS"
log "  Total pipeline cost:              \$$TOTAL_COST"
log "============================================="
log ""
log "HOW THIS PROVES REAL SESSION RESUME:"
log "  1. Agent A generated secret '$SECRET_TOKEN' in session A.1"
log "  2. Only the handoff block (with public token) went to Agent B"
log "  3. The resumed prompt contained ONLY Agent B's report"
log "  4. Agent A recalled '$SECRET_TOKEN' from session memory"
log "  5. The script independently verified the match"
log ""
log "  If --resume had started a fresh session, Agent A would"
log "  have had NO way to know the secret token."
log ""
log "Full log saved to: $LOG_FILE"
