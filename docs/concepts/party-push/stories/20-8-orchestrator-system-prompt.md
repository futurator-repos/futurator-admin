# Story 20.8: Orchestrator system-prompt update — teach `[CHECKPOINT_SUMMARY]:` + `[ASK_HUMAN]:`

Status: DONE (2026-05-21) — Tasks 1-3, 5 ✅; Task 4 manual probe deferred to post-rsync
Depends on: 20.1 (extractor exists)

## Story

As the party-mode orchestrator agent,
I want my system prompt to explicitly teach the `[CHECKPOINT_SUMMARY]:` and `[ASK_HUMAN]:` marker conventions,
so that I emit them reliably and the daemon's commit composer + ASK_HUMAN flow get real signal — not the lenient-fallback "N files changed (auto)" titles that defeat the design.

## Acceptance Criteria

1. Find the party-mode system prompt assembly point (probably `daemon/pipelines/party-bootstrap.mjs` or a sibling prompt-builder). Append the block from `plan.md` §12.2.3:

   ```
   ## Saving your work to git

   The system handles all git operations. You do NOT run git commands. Edit and
   Write tools auto-approve; git mutation is hard-denied by the hook.

   When a round ends, if you produced files (Edit/Write/MultiEdit), the system
   auto-commits to this debate's git branch. To shape the commit's title and
   summary — what future readers (humans, other agents) will see in `git log` —
   emit ONE block at the end of your final round message:

       [CHECKPOINT_SUMMARY]: <conventional-commit-style title, ≤100 chars>
       <2-5 line summary describing what was decided and produced, ≤500 chars total>

   Example:
       [CHECKPOINT_SUMMARY]: feat: cohort module architecture v0.1
       Covers profile-maturity scoring, multitenancy model, DynamoDB schema,
       and dashboard wireframes per round. Open: comms channel + facilitator search.

   If you didn't produce files this round, OMIT the block — the system skips
   the commit silently.

   ## Asking the human for input

   If you need the operator to make a decision before continuing, emit:

       [ASK_HUMAN]: <one-sentence question>

   and stop tool calls in the same round. The system pauses the debate, surfaces
   your question in the UI, and resumes with the operator's reply as the next
   turn's input.

   Use sparingly — most rounds should not need this. Genuine clarifications
   ("commit message: 'feat:' or 'chore:'?") count; rhetorical questions don't.
   ```

2. The block is ALWAYS appended (no rigor gating) — even prototype-rigor sessions should commit cleanly with markers.
3. **Validation**: write a one-shot test that runs the bootstrap and inspects the final assembled prompt string — assert the marker explanation is present.
4. **Manual probe**: open a fresh party session post-deploy, ask "summarize the architecture and propose a doc edit," verify the agent emits a `[CHECKPOINT_SUMMARY]:` block in its final round message.
5. If the prompt assembly is in a TypeScript file (Lambda side), the change goes through `npm run typecheck` + Lambda redeploy. If it's in the daemon, it goes through rsync.

## Tasks / Subtasks

- [ ] Task 1: Locate the prompt assembly (AC: 1)
- [ ] Task 2: Append the marker block (AC: 1, 2)
- [ ] Task 3: Validation test (AC: 3)
- [ ] Task 4: Manual probe post-deploy (AC: 4)
- [ ] Task 5: Confirm deploy path (Lambda or daemon) (AC: 5)

## Dev Notes

- This story is small but load-bearing. The planner's §12.2.3 says it explicitly: "The orchestrator's effectiveness depends on it." If markers aren't emitted, `agent-commit-composer` falls back to lenient titles and `git log` becomes noise.
- Per Free Explorer §13.6, the fallback-rate metric tracks orchestrator effectiveness over time — if `party.checkpoint.fallback` fires frequently after this story ships, the prompt needs more reinforcement.
- The exact prompt wording can iterate; don't treat it as final. The acceptance is "markers emitted reliably," not "exactly this wording."
