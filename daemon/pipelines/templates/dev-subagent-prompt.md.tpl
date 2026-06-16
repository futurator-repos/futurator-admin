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
Worked example (drive, advance time deterministically, then assert state):
  flow:
    - { action: press, key: "Space" }            # start the game
    - { action: clock, clockMode: runFor, ms: 5000 }   # advance 5s WITHOUT a real wait
    - { action: screenshot, label: "mid-play" }
    - { action: assert, expr: "snapshot.gameState", op: eq, expected: "playing" }
Use `clock` for time-dependent UI — never a real `wait` for synchronization.
Your code must expose the state the `assert` reads via the test-only `window.__harness` seam.
</probe_grammar>

<run_command>
{{runCommand}}
</run_command>

Implement this story per your spec. Remember: declare blockers BEFORE editing, not after.

Return <DEV_RESULT> block when done.
