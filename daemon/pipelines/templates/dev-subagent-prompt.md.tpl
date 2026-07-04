Story: {{storyId}} — {{title}}
Acceptance criteria:
{{bulletedList}}

Touch points (edit only these):
{{globs}}

Sibling stories in this wave are editing the following paths — do NOT touch:
{{siblingGlobs}}

Context (pre-digested):
{{contextDigest}}

Rubric highlights relevant to this story:
{{rubricExcerpt}}

Effort: {{effortKeyword}}

DISCOVERY:
- The context digest above contains the project tree, plan summary, and adjacent files. You do NOT need to re-discover.
- Do NOT run `ls`, `find`, `tree`, or `Bash cat` on the project directory.
- Read at most the files you intend to modify. Do them in ONE message with parallel Read calls.

VERIFICATION (Story A.6):
- Do NOT Read a file you just Wrote or Edited — those tools error when they fail; their silent return IS the verification.
- Do NOT run `npm run dev` / `node --check` / `node --input-type=module` for ad-hoc syntax checks. The project's runtime command is in <run_command> below; downstream test/build gates catch real regressions.
- Visual tests at `<projectDir>/visual-tests.md` are the contract — your code must make each entry pass at runtime.

<probe_grammar>
A visual test may carry a `flow:` — an ordered probe that reaches → acts → observes
before the frame is captured. Available step actions:
  navigate · click · fill · select · wait · screenshot   (basic)
  press(key) · hold(key,ms) · tap/pointer(x,y) · drag · clock(clockMode,ms)   (interaction + deterministic time)
  assert(expr,op,expected) — read window.__harness.snapshot() for a deterministic verdict

AUTHOR EACH AC BY ITS [verify=…] TAG (shown next to the AC above):
  - verify=build      → no visual test (a unit/typecheck covers it).
  - verify=appearance → ONE screenshot of the relevant surface; no flow needed.
  - verify=state      → a `flow` that reaches the state, then `assert`s it against
                        window.__harness.snapshot(). Deterministic — no idle frame.
  - verify=behavior   → a `flow` that drives the interaction (press/click/clock),
                        then `assert`s the resulting state AND takes a screenshot.
  - verify=manual     → no auto test; the operator verifies it.
NEVER author a single idle screenshot for a state/behavior AC — it cannot observe
post-interaction state and will fail or come back UNVERIFIABLE.

The `window.__harness` seam is PRE-BAKED by the scaffold (see SCAFFOLD.md) — do NOT
author or edit it. For canvas games it exposes `snapshot()` →
`{ status, score, tick, entities, gameOver }` plus any fields you add to
`GameState` (e.g. `lives`).

SEAM WIRING — a MUST, not a suggestion: the seam only publishes when the game's
live state flows through the scaffold hook `useGameStateMachine(reducer,
initialState)` (src/game/state-machine.ts). Do NOT hand-roll `useReducer` for
game state — that bypasses the publisher, `window.__harness` never mounts, and
deployed-app QA hard-fails every probe with SEAM_NEVER_PUBLISHED (the pacman3
post-mortem). Same reducer, same initial state — just call it through the hook.

Worked example (start, advance time deterministically, then assert + observe):
  flow:
    - { action: press, key: "Space" }                  # start the game
    - { action: clock, clockMode: runFor, ms: 5000 }   # advance 5s WITHOUT a real wait
    - { action: screenshot, label: "mid-play" }
    - { action: assert, expr: "snapshot.status", op: eq, expected: "running" }
Use `clock` for time-dependent UI — never a real `wait` for synchronization.
</probe_grammar>

<run_command>
{{runCommand}}
</run_command>

Implement this story per your spec. Remember: declare blockers BEFORE editing, not after.

Return <DEV_RESULT> block when done.
