# Pipeline v3 — Root-Cause Remediation Plan

Status: **IMPLEMENTED — Waves A–D + deferred follow-ons (2026-06-22)**. Authored after the pacmanv3
end-to-end run. Fixes the _origins_, not the per-incident patches. Auth/OAuth lifetime is **explicitly
out of scope** per operator decision. Two items remain genuinely open: §6 (needs EC2 session logs) and
the _true_ per-epic decomposition + mid-plan re-serialize consumers (need daemon dynamic-fan-out /
wave-recompute orchestration) — both noted in the ledger.

## Implementation status (2026-06-22)

| Item                                           | What shipped                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Tests                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| **D2-1** delete export heuristic               | Removed Signal 2 (AC-prose export check) from `prework-gate.mjs`; deleted `ac-export-detector.mjs`. Gate = recent commits + whole-project tsc.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `prework-gate.test.mjs` (11) ✅                                                                 |
| **D3-1** dev-scope gate                        | New `capture-predev-baseline` + `dev-scope-check` steps in `story-pipeline.ts`: post-DEV delta vs declared touchPoints → fails out-of-scope source edits pre-merge (mirrors tamper-check). `DEV_SCOPE_ENFORCE=0` warns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | bash-validated + baseline suite ✅                                                              |
| **D5** stale live-log                          | `use-agent-events.ts`: reset fetch cursor on jobId change + return-time scope to current job (no dead-job events).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `use-agent-events.test.ts` ✅                                                                   |
| **D1-A1..A4,A10** de-game prompt               | `wiring` capability flag + per-boilerplate example fields in the registry; `pm-plan-prompt.ts` renders feature-registry **or** route-mounting, data-driven browser-AC/domain-type/coupled-sibling examples. Game few-shots moved into the canvas-game registry entry as data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `pm-plan-prompt.test.ts` (38) ✅                                                                |
| **D2-2** moduleDir inference                   | Wired `inferModuleDirFromTouchPoints` into `story-pipeline.ts` (contract lands at the story's real module dir).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | baseline suite ✅                                                                               |
| **D2-3** re-harden contract-freeze             | Whole-project `tsc --noEmit`; blocks ONLY when the contract file itself is in the errors, else warns.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | baseline suite ✅                                                                               |
| **D1-A5** non-game dev probe                   | Route-based worked L2 probe (click→screenshot→judge) for seam-less apps.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | render-checked                                                                                  |
| **D1-A9** route-based QA capture               | `wave-vqa-runner.mjs` evidence prompt adapts: `?feature=` only when slugs exist, else navigate to the AC's route.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `wave-vqa-runner.test.mjs` (13) ✅                                                              |
| **D4(b)** compact-retry                        | `compact` flag threaded prompt→pipeline→`concept-driver`; an overflowed (terminal-empty) pm-plan re-fires with tighter ceilings + brevity banner.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `concept-driver.test.ts` (9) ✅                                                                 |
| **D1-A6/A7** seam + non-game scaffold contract | `nextjs-dashboard` is now a real non-game starter: generic app-state `__harness` seam (route/authStatus/lastMutation/ready) shipped as a **compiling** `src/lib/app-harness.tsx` augment (typecheck-verified), route-based `scaffoldContract`, `testHarness` registry entry, non-game `pmContext`, `wiring:'route'`. Kept `status:'stub'` until EC2 e2e of the clone, then flip to `'wired'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `registry.test.ts` (+5) ✅                                                                      |
| **D4(a)** budget-aware plan-gen                | **Proactive guard shipped + sharpened**: `daemon/lib/plan-budget.mjs` estimates the rendered pm-plan prompt size post-artifact-inline and, when large, prepends a compact directive carrying a **concrete story ceiling sized to the real `CLAUDE_CODE_MAX_OUTPUT_TOKENS` cap** (`estimateStoryBudget`) so the first attempt aims at a hard number (composes with D4(b)'s reactive re-fire). **Feasibility note**: TRUE per-epic decomposition (skeleton → per-epic story-gen fan-out → deterministic assembly) requires **driver-level multi-job orchestration** (new job kinds + assembler, like `concept-driver`) — the daemon's pipelines are static (no dynamic mid-pipeline fan-out) and `loopTo` retry on the critical generation path can't be verified without deploy. The observed overflow is fully covered by the proactive + reactive guards; decomposition is a scale optimization for specs too large for even a compact single generation. | `plan-budget.test.mjs` (12) ✅                                                                  |
| **D3-2** re-declare edits on retry             | **Full loop shipped & wired**: MEASURE (`dev-scope-check` emits `__DEV_SCOPE_ACTUAL__`) → PERSIST (`updateStoryActualTouchPoints`, union/monotonic; daemon writes after the gate) → CONSUME (`launchPipelineWave` calls `recomputePendingStoryWaves` — gated on measured data so fresh plans are byte-identical no-ops, forward-only + reassignable-only so running/done stories never move; a pending sibling colliding on a measured-but-undeclared file is **deferred out of the launching wave** and its new wave persists). Daemon collision core (`glob-intersect.detectCollisions`) + `touch-point-inference` waveInput also union `actualTouchPoints`.                                                                                                                                                                                                                                                                                             | `story-waves.test.ts` (+6), `glob-intersect.test.mjs` (+7), `pipeline-launcher.test.ts` (+2) ✅ |
| **§6** pin true E5 cause                       | **OPEN** — still requires pulling the review→retry raw session (needs deploy/EC2).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

> **Framing.** The pacmanv3 run proved the architecture works end-to-end (parallel swarm, LLM merge
> resolution, wave advancement, the new gates) — but it required hand-holding past ~5 recurring failure
> modes. Several would recur on a fresh run. This plan separates **cured** (won't recur) from **patched**
> (would recur), and replaces every patch with a fix at the layer that _generates_ the behavior.

> **Honesty correction (supersedes an earlier in-session claim).** I earlier told the operator the E5
> "Complete Game Assembly" story was blocked by the prework-gate's `drawOverlays` "candidate export not
> found" message. That was **wrong**: the prework-gate's candidate-export check is **fail-safe** — when it
> "fails" it still spawns dev (it only _skips_ dev when the check _passes_, `daemon/lib/prework-gate.mjs`).
> So `drawOverlays` was misleading log noise, not the blocker. The true E5 terminal cause is at the
> **review→retry→test-author** boundary (review emitted no verdict; the retry died) and is **not yet
> pinned** — see §6.

---

## The patched-vs-cured ledger (from the pacmanv3 run)

| Issue                                           | This-session action                     | Re-run outcome                                          |
| ----------------------------------------------- | --------------------------------------- | ------------------------------------------------------- |
| Plan stranding (COMPLETED-empty → driver no-op) | root fix in `concept-driver` dedup      | ✅ cured                                                |
| Plan-gen 32K output overflow                    | raised cap 32K→64K + compact-prompt ask | ⚠️ mitigated, not cured (Disease D4)                    |
| `api-contract-freeze` wedge                     | made report-only                        | ⚠️ patched by neutering (Disease D2)                    |
| prework-gate `drawOverlays`                     | (diagnosed only)                        | ⚪ fail-safe noise — fix is cleanup, not a blocker (D2) |
| coupled-sibling merge collision (`pacman.ts`)   | LLM resolver luckily fixed              | 🔴 would recur — root unaddressed (Disease D3)          |
| toy-game bias in prompts                        | (none)                                  | 🔴 would corrupt any non-game app (Disease D1)          |
| stale live-log UI                               | (none)                                  | 🔴 would mislead again (Disease D5)                     |
| OAuth expiry mid-run                            | manual re-auth                          | ⛔ out of scope (operator decision)                     |

---

## Disease D1 — Toy-game / single-page bias hardcoded as universal law **[the dynamism problem]**

**Origin.** `pm-plan-prompt.ts` is otherwise excellently _data-driven_ — paths, build commands, AC voice
all come from `BOILERPLATE_REGISTRY[type].pmContext`. But **four blocks bypass that design and hardcode
the canvas-game / single-page model as universal law**, emitted on every plan regardless of app kind. A
serious multi-route app (SaaS dashboard, API admin, multi-page product) inherits game/single-page
assumptions that are at best meaningless and at worst corrupt the plan's file layout and dependency graph.

### Critical (fire on every UI plan, app-agnostic)

- **D1-A1 — feature-registration block as universal law.** `pm-plan-prompt.ts:441-454` emits the
  `src/features/<slug>.feature.tsx` + `primary: true` + "render ONLY the real app at `/`" wiring
  unconditionally. That wiring exists **only in `nextjs-*` starters** (`registry.ts` `FEATURE_WIRING_AUGMENTS`).
  For a real app where `/` is a marketing/login page and features live at `/dashboard`, `/billing`, this
  is nonsense — the PM invents fake feature-registration touch points and a fake "assembly story that marks
  the app primary."
  **Fix:** gate behind a registry capability flag (`meta.wiring === 'feature-registry'`); for route-based
  apps replace with the abstract rule "every UI story mounts its deliverable on a real route so visual QA
  can reach it." Source slug/paths from `pmContext`.

- **D1-A2 — visual-coverage examples hardcode canvas/sprite/HUD.** `pm-plan-prompt.ts:431-439`. The rule
  (UI app needs browser ACs) is general; the _examples_ ("dragon sprite on the ground band", "HUD reads
  'Score: 0'") are pure game → few-shot bias drags every app's ACs toward sprite/HUD framing.
  **Fix:** data-drive the examples from a new `pmContext.exampleBrowserAc` per boilerplate, or list 2-3
  spanning kinds (dashboard chart, form field, nav header) so no domain dominates.

- **D1-A3 — appearance-floor assumes the load frame at `/` is the whole app.** `pm-plan-prompt.ts:399-429`.
  "`verify:'appearance'` MUST be idle-visible at the INITIAL load frame" assumes the feature is visible at
  `/` with no navigation. A real feature sits behind auth + routing; its idle frame at `/` is a login page,
  so an appearance AC about the feature is unsatisfiable. The single-page-canvas assumption is baked into
  "appearance" semantics. Worked example (`:405-407`) is again the game sprite.
  **Fix:** define "idle frame" relative to _the route the feature lives on_ (post-navigation,
  pre-interaction), not literally `/`. De-game the example.

- **D1-A4 — example story injects `DinoState/Obstacle/GameState` + a types-barrel-first shape.**
  `pm-plan-prompt.ts:79, 102-107, 502-517`. The _path_ is boilerplate-driven (good) but the entity names
  are hardcoded into every plan's example → the PM tends to open _every_ plan with a "Define core domain
  types (DinoState…)" wave-0 story, even for an API service where a single barrel of domain types is not
  the natural contract.
  **Fix:** replace hardcoded names with a neutral placeholder ("define the 2-3 core domain types the intent
  implies"). Keep the AC text sourced from `ctx.exampleAcceptanceCriteria`.

### High (capability gaps real apps need — not prompt-string bugs)

- **D1-A5 — dev prompt's only worked probe is canvas-game.** `story-pipeline.ts:823-838, 901-903`. The
  five-example `judge:` list spans domains (good) but the single end-to-end _worked_ probe is a game
  (`press Space`, `runFor 5000`, `snapshot.status`). A SaaS flow has no worked "log in → navigate → assert
  a table row" example to imitate.
  **Fix:** add a non-game worked L2 probe (fill form → submit → assert toast); select by boilerplate domain.

- **D1-A6 — no generic app-state seam.** `story-pipeline.ts:800-838`. The `__harness`/`snapshot.status`
  state oracle is correctly gated to `nextjs-canvas-game` (only boilerplate with `testHarness`). So non-game
  apps get **no deterministic state oracle** and fall back to screenshot-only judging — a capability gap.
  **Fix:** define a generic app-state seam (current route, auth status, last-mutation result) in a non-game
  boilerplate before `verify:'state'/'behavior'` ACs are meaningful for real apps.

- **D1-A7 — no non-game scaffold contract.** `registry.ts:171-238`. The game's `scaffoldContract`
  (required/forbidden story patterns) is correctly game-only, so it doesn't leak — but dashboard/form/SaaS
  starters are `status:'stub'` with **no** contract, so a real app gets none of the structural guardrails.
  **Fix:** author a non-game `scaffoldContract` (route/page/API-shaped required+forbidden patterns) when
  wiring the first production starter. No prompt-builder change — it's already data-driven.

### Medium

- **D1-A9 — visual-QA capture assumes "primary feature at `/`".** `visual-qa-pipeline.ts:715-730`. Judge
  _text_ is data-driven (good) but the capture _topology_ is single-page (`/` + `?feature=<slug>`). For a
  multi-route app it screenshots the wrong surface.
  **Fix:** drive capture from each test's `setup:`/`flow:` navigation (visit the route the AC names); gate
  the `?feature=` isolation behind the same `wiring === 'feature-registry'` flag as A1.

- **D1-A10 — coupled-sibling example is Pacman.** `pm-plan-prompt.ts:282-289`. Principle is general; swap
  one example for a SaaS/CRUD one ("story A builds the invoice list; sibling B 'mark paid updates the
  total'").

**Clean (confirmed, do not touch):** `prd-gen`, `ux-gen`, `arch-gen`, `convergence`, `api-author` prompts;
the base boilerplate ACs; the page-state classifier. These are the models of how to generalize.

---

## Disease D2 — The export-gate disease (validate names by heuristic, never against the real import graph)

**Origin.** Two gates assert an _expected export-name surface_ inferred from **prose regex or a hardcoded
filename**, then validate it by **string-match / isolated-tsc against individual files** — never against
the actual resolved import graph. Code that correctly imports the real names is _provably correct_, but
neither gate can see that.

- **D2-1 — prework-gate candidate-export check (heuristic noise).** `daemon/lib/prework-gate.mjs:93-115` →
  `extractCandidateExports(acText)` (`daemon/lib/ac-export-detector.mjs:35-73`) scrapes identifiers from the
  story _description_ via 5 regexes (incl. call-shape `name(`), then `checkExportsPresent` (`:93-153`)
  regex-matches `^\s*export` against the raw text of the declared touchPoint files. `drawOverlays` became a
  candidate (it's the file/module name in the prose) but the file exports `drawTitleScreen…`, so the regex
  missed → "candidate export not found". **Fail-safe** (still spawns dev), so it's pure misleading noise.
  **Fix:** delete the candidate-export signal entirely. Signal 3 (`runCachedTypecheck`,
  `prework-gate.mjs:117-129`) is the authoritative AST-grounded check — the build/typecheck already proves
  exports resolve. Reduces the gate to "recent commits in scope AND tsc clean", deleting the whole
  `ac-export-detector.mjs` name-heuristic surface.

- **D2-2 — api-author `moduleDir:'src'` hardcoded placeholder.** `story-pipeline.ts:328` hardcodes
  `moduleDir:'src'` (inference `inferModuleDirFromTouchPoints` exists in `api-author-pipeline.ts:103-147`
  but is **never called**). So api-author is told to write `src/index.d.ts` (a top-level barrel) regardless
  of where the story's module lives.
  **Fix:** wire `inferModuleDirFromTouchPoints` into `story-pipeline.ts:328`/`:361` to replace the
  hardcoded `src/`.

- **D2-3 — `api-contract-freeze` isolated-`.d.ts` tsc.** `story-pipeline.ts:356-376` (now report-only after
  the in-session patch). Shares the `src/index.d.ts` filename assumption; an isolated single-`.d.ts`
  typecheck mis-resolves relative imports.
  **Fix:** keep report-only until D2-2 lands, then validate the contract via a **whole-project**
  `tsc --noEmit` (resolves real imports), not an isolated file. This is the _proper re-hardening_ of the
  feature I had to neuter — it does the job without the false positives.

**Net:** validate exports/contracts against the **resolved import graph / whole-project tsc**, never against
names mined from prose or filenames.

---

## Disease D3 — Touch-point honesty gap (the swarm trusts declarations nothing enforces)

**Origin.** The wave scheduler (`computeStoryWavesWithTouchPoints`, `story-waves.ts:62-117`) serializes
same-wave stories **only when they DECLARE the same file**. Nothing downstream verifies the dev _obeyed_
its declared `touchPoints`: the commit step (`story-pipeline.ts:1771-1797`) stages whatever the dev
actually edited (snapshot `comm -23` delta), with no filter against the declared set. So two stories that
both edit an _undeclared_ `pacman.ts` look disjoint to the scheduler, stay in one wave, and collide at
wave-merge — where the **LLM auto-resolver** (`daemon/lib/wave-merge-runner.mjs`, opt-in,
`agent-daemon.mjs:4323`) is the _probabilistic_ safety net. The PM prompt's promise ("dishonest touch
points cost a failed gate", `pm-plan-prompt.ts:315`) is currently false — the cost is silently deferred.

**Fix (highest leverage first):**

1. **Dev-scope enforcement gate — mirror `tamper-check`, but for source.** After dev, diff the actually-
   edited source files (the snapshot delta already computed at `story-pipeline.ts:1771`) against the
   declared `touchPoints` (`TOUCH_POINTS` in scope at `:215`). Any edited source file outside the declared
   set (and not an earlier-wave contract / scaffold-owned path) fails the story with an `out-of-scope-edit`
   attention card — converting the merge-time conflict into a **deterministic pre-merge gate at the exact
   point the collision is introduced.** Makes the PM prompt's promise true.
2. **Re-declare actual edits to the scheduler on retry (defense in depth).** Feed the real edited-file set
   back into `computeStoryWavesWithTouchPoints` so a story that genuinely needed `pacman.ts` gets serialized
   next run instead of re-colliding. Turns the scheduler's input from "what the PM promised" into "what the
   code actually touched."

---

## Disease D4 — Plan-gen budget is a polite ask, not enforcement

**Origin.** The 32K→64K cap raise + the prompt's "stay under N stories / close the fence" are _mitigations_
— a sufficiently complex spec can still overflow 64K, and nothing _counts_ tokens or _splits_ the work.

**Fix (root):** make the plan generation budget-aware and _enforced_, not hoped: (a) deterministically
estimate the rendered-plan size and, when a spec is large, **decompose plan generation itself** (per-epic
generation + deterministic assembly — the E1 planning-swarm spike already prototyped this), so no single
generation must emit the whole tree; (b) on a truncated/unfenced output, **retry-compact deterministically**
rather than failing. This is the durable form of the in-session patch.

---

## Disease D5 — Stale live-log (trust, not correctness)

**Origin.** The live-log panel keys events by _story_ and merges every job that story ever had, so a dead
prior job's failures render alongside the live run. Misled the operator 4× this session (every retry looked
like "failing again").

**Fix:** scope the live-log to the current (latest) job for the story, or visually mark superseded-run
events. Small frontend change, high trust payoff.

---

## §6 — Outstanding: re-pin the true E5 terminal cause

The `drawOverlays` message was fail-safe noise (above). The assembly dev actually **succeeded at the hard
work** (full game wired, all functional gates green to review). The real failure is at review→retry: review
started (`08:12:13`) and emitted **no verdict**, a retry began (`08:12:44`), the retry's test-author started
(`08:13:03`) and the job then died → FAILED. **Action:** pull the review step's raw session + the daemon
retry-exhaustion path to pin whether review errored (no parseable VERDICT), hit a cap, or the retry's
test-author failed silently. This is a prerequisite to knowing if a _third_ disease hides here.

---

## Suggested sequencing

- **Wave A (deterministic, highest leverage, no app-shape risk):** D2-1 (delete candidate-export heuristic),
  D3-1 (dev-scope gate), D5 (live-log scoping). All pure wins, unit-testable, no behavior-shape change.
- **Wave B (dynamism — the headline):** D1-A1..A4 (de-game `pm-plan-prompt`), D1-A10. Make the four blocks
  data-driven/abstract. Validate the rendered prompt for a _non-game_ boilerplate.
- **Wave C (capability for real apps):** D1-A6/A7 (generic app-state seam + non-game scaffold contract),
  D1-A9 (route-based QA capture), D2-2/D2-3 (wire moduleDir inference, re-harden contract-freeze via
  whole-project tsc).
- **Wave D:** D4 (budget-enforced/decomposed plan-gen), D3-2 (re-declare edits on retry).
- **Prereq throughout:** §6 (pin the true E5 cause).
