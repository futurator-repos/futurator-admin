# Planner parallelism investigation — brief for the Fable 5 "ultracode-grade" planner

**Date:** 2026-07-07
**Context:** After upgrading the quick-planspec planner (Sonnet 5 → Opus 4.8 + a
"fidelity/interactivity" prompt rewrite, commit `0deeb60`), the **plan quality went
up but the build parallelism collapsed**. pacman5 planned 8 well-decomposed stories
but they form a near-linear chain (batch 0→1→2→3→4→5→6); only batch 0 runs 2-wide.
The operator explicitly values parallelism ("it helped us earn time while we use
jcode logics to develop"). This document is the evidence + root cause + the design
brief for a next-gen planner.

**North-star metric:** maximize the **ready-frontier WIDTH** (how many stories are
concurrently `ready`), NOT the story count. A good plan is a wide DAG, not a long line.

---

## 1. What changed (before → after)

Both prompts have the **same structural rule**: `foundation → features → assemble`,
"1 foundation story, feature stories, 1 assemble story last." The dependency-derivation
code (`deriveDeps` in `daemon/pipelines/lib/quick-planspec.mjs`) was **NOT touched**.

|                        | BEFORE (Sonnet 5)                                           | AFTER (Opus 4.8, `0deeb60`)                                                                                                                        |
| ---------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model                  | `claude-sonnet-5` high                                      | `claude-opus-4-8` high                                                                                                                             |
| Decomposition guidance | "Split the work: 1 foundation, feature stories, 1 assemble" | "**one story PER core capability**", "foundation defines **the state model** `snapshot()` exposes", FIDELITY rule ("cover every named capability") |
| Effect on files        | fewer / broader / more self-contained stories               | more granular capability stories that **all edit a central `reducer.ts`**                                                                          |
| Effect on DAG          | wider (more disjoint touches → fewer serializing edges)     | **linear** (shared `reducer.ts` → serializing chain)                                                                                               |

The new prompt's push toward a **single cohesive state core** (good for coherence and
for the seam/`snapshot()` contract — it is _why_ pacman5 is a better game plan) is the
exact thing that triggers the serialization below. This is a real tension, not a bug in
either half.

---

## 2. The mechanism (unchanged code, now bites)

`deriveDeps` assigns each story a layer (`foundation=0 / feature=1 / integration=2`,
by title regex) then adds edges:

```
for story i:
  for story j != i:
    if layer[j] < layer[i]:                         deps += j   // cross-layer
    else if layer[j] == layer[i] and j < i
            and touches[i] ∩ touches[j] != ∅:        deps += j   // SAME-LAYER SHARED-TOUCH  ← the killer
```

The "same-layer shared-touch" edge means: **any file two feature stories both touch
serializes them.** In pacman5 nearly every feature classifies as `feature` (layer 1)
and every one edits `src/game/reducer.ts`, so story i depends on _all_ earlier feature
stories → a strict chain.

Note the classifier is also weak: "Define … reducer core" and "Render … maze" both
failed the `FOUNDATION_RE` regex (no `types|constants|setup|…` keyword) so BOTH landed
in layer 1 — the layering barely participates; the chain is purely same-layer
shared-touch edges.

---

## 3. Evidence — pacman5 (`1ab4c550…`), touches + derived dep count

```
B0  deps=0  Render the pixel-art maze, pellets, Pac-Man     → canvas/*Render.tsx, pacman-preview.feature.tsx
B0  deps=0  Define domain state, maze layouts, reducer core → game/{types,constants,reducer}.ts, entities/*
B1  deps=2  Grid-based movement + wall collision            → game/reducer.ts, movement.ts, pacman-preview.feature.tsx
B2  deps=2  Coin eating, scoring, frightened mode           → game/reducer.ts, scoring.ts
B3  deps=3  Coloured ghosts, vault release, chase AI        → game/reducer.ts, ai/ghostAI.ts, GhostRender.tsx
B4  deps=4  Ghost collisions, eating, lives, game over      → game/reducer.ts, collision.ts
B5  deps=5  Two-stage progression + win condition           → game/reducer.ts, stages.ts
B6  deps=7  Assemble the complete app                       → features/pacman.feature.tsx, PacmanGame.tsx, HUD.tsx
```

Dep count climbs 2→2→3→4→5→7 in lockstep with "how many prior stories also touch
`reducer.ts`." **`reducer.ts` (and `pacman-preview.feature.tsx`) are god-files; the
shared-touch rule turns each into a total order.** Every B*n* is `blocked` until B*n-1*
is `done`. Result: 6 wasted parallel slots, ~6× the wall-clock of a wide plan.

**Key insight:** the wave-merge coordinator + per-story worktrees ALREADY support
concurrent edits to the same file (pipeline-v2 waves do this). So the reducer chain is
an **artifact of plan-time derivation, not a real build constraint.** The parallelism
was thrown away by a heuristic, not required by anything downstream.

---

## 4. Why pacman4 (old planner) felt more parallel

Hypothesis (consistent with the data): the Sonnet-era planner produced **fewer, more
self-contained stories with disjoint touch sets** — each feature owned its own logic
files, so the shared-touch rule fired rarely and the frontier stayed wide. The cost was
exactly the "lame app" symptom: scattered, less-cohesive logic that never integrated
into a working whole. So the two eras sit at opposite ends of one axis:

```
scattered / disjoint files  ──────────────────────────  cohesive / shared core
   WIDE frontier, fast                                     LINEAR frontier, slow
   incoherent app ("lame")                                 coherent app (better)
        ← pacman4                                             pacman5 →
```

The next planner must **break this axis** — get cohesion AND width at once.

---

## 5. Design brief for the Fable 5 planner (three independent levers)

### Lever A — Contract-first decomposition (prompt-level, ships parallelism now)

Instruct the planner to make feature stories touch **disjoint files** by construction:

- The **foundation** story freezes the **contract**: the state shape + the action/event
  type union (e.g. `game/types.ts`, `game/actions.ts`) — the surface `snapshot()` exposes.
- Each **feature** implements its own **slice module** against that frozen contract
  (`reducer/movement.ts`, `reducer/scoring.ts`, `reducer/ghostAI.ts`, …) — NOT edits to
  one shared `reducer.ts`.
- The **assemble** story combines slices (a root `combineReducers`/dispatcher) and wires
  the seam.
- Explicit rule to add: _"Shared files serialize the build. Never plan one file that
  every feature edits (a god-reducer/god-store). Give each feature its own module against
  the frozen foundation contract; combine them only in the assemble story."_

This keeps full cohesion (contract-enforced, combined at assemble) while making the
feature stories genuinely independent → wide batch-1 fan-out.

### Lever B — Ownership-aware derivation (structural, the real fix)

Change `deriveDeps` so a shared touch is **not automatically a hard edge**:

- Distinguish the **owner/creator** of a file from **contributors** that append to it.
- A feature should depend on the foundation that owns the **contract**, NOT on every
  sibling that also appends to a shared file.
- Delegate concurrent same-file edits to the wave-merge coordinator (already exists).
- Net: features depend only on foundation → one wide parallel batch, then assemble.

### Lever C — Explicit DAG + width objective (ultracode-grade)

Let the planner **emit its own dependency graph** (stop relying on the naive derive) and
optimize it for frontier width:

- The planner reasons: "which stories are truly independent given the contract?" and
  emits `dependsOn` explicitly (only real contract/data deps).
- Add a planning objective/self-check: _"maximize the number of stories with zero
  unmet deps in each layer; a chain longer than N with single-story batches is a
  smell — re-factor toward parallel slices."_
- Validation gate: reject/flag a plan whose max batch width is 1 for >2 consecutive
  batches (a linear-chain detector), analogous to how ultracode fans out and then
  verifies.

### Success criteria for the new planner

1. **Frontier width ≥ (feature count)** after the foundation batch (features fan out in
   parallel, not a chain).
2. **No god-file**: no single non-foundation file appears in >1 feature story's touches.
3. Cohesion preserved: a frozen foundation contract + an assemble story that integrates
   the slices and mounts the seam (per-capability behavioral ACs retained).
4. Measured: `maxBatchWidth` up, `criticalPathLength` down, same or better QA verdict.

---

## 6. Immediate mitigation available now (optional, prompt-only)

Lever A is a pure prompt edit to `buildQuickPlanspecPrompt` — no derive/code change — and
would restore most of the width on the next plan while Fable 5 builds the full
ownership-aware planner. Offered but not yet applied (holding for the Fable 5 design so we
don't fork the prompt mid-investigation).

---

## 7. What shipped (Fable 5 planner, 2026-07-07)

Implemented in `daemon/pipelines/lib/quick-planspec.mjs` + `quick-planspec-runner.mjs`.
One deliberate deviation from the original brief, forced by substrate evidence:

**The brief's "wave-merge absorbs concurrent same-file edits" claim is FALSE for the
frontier.** Under `P3_READY_FRONTIER` there is NO merge: all concurrent stories share
ONE working tree (`story-integrate.mjs` — per-story commit under a lock, siblings'
`touches` become each story's gate-enforced `forbiddenAreas`). Safety comes from
**disjoint scope by construction**, so Lever B ("drop the shared-touch edge, let
wave-merge resolve") would have been unsafe. The shared-touch rule is kept as a
_safety net_; the fix removes the reason it fires.

What changed (Levers A + C + D, substrate-corrected):

1. **Prompt v3 — contract-first + substrate-aware.** The prompt now teaches the real
   execution model (parallel agents, one shared tree, no merge, critical path =
   wall-clock, each agent sees only its own story) and mandates: CAPABILITIES →
   CONTRACT (foundation freezes contract files nobody else edits) → SLICES (each
   capability OWNS disjoint files; god reducer/store banned) → GRAPH (model emits its
   own `dependsOn` via story-local slug `id`s; slices depend only on the foundation) →
   SELF-CHECK (chain / god-file / behavioral-AC / seam). Fidelity, interactivity and
   seam-wiring rules preserved verbatim.
2. **Model-authored DAG + normalizer.** `parseQuickPlanspec` maps slug `dependsOn` →
   minted storyIds, then `normalizeDeps`: cycle-break (deterministic, first-emitted
   edge wins — a cycle would deadlock the frontier), zero-dep slices anchored on the
   foundation (the contract must exist before a slice builds against it), the final
   assemble story forced to depend on all, and `enforceScopeSafety` — co-eligible
   stories sharing a concrete touch get a serializing edge (correct under the
   no-merge shared tree) counted as lost width. `deriveDeps` remains the no-deps
   fallback, unchanged.
3. **`auditPlanGraph` + repair loop (the ultracode move).** Pure audit: width per
   topo level, `maxWidth`, `criticalPath`, god-files (a concrete path touched by ≥2
   _feature_ stories), linear-chain (>2 consecutive width-1 levels before the final
   level). On violation the runner fires ONE repair spawn with the failed plan + the
   audit findings; keeps whichever plan audits better; if violations survive it
   ingests anyway (safety edges keep it correct) and writes a
   `quick-planspec-serial-plan` attention item — a serial plan is never shipped
   silently. Ingest log now carries `width/path/safety-edge` metrics.

Before/after on the pacman5 shape (encoded as tests): the god-reducer plan (5 stories,
every feature touching `reducer.ts`) audits to levels `[1,1,1,1,1]`, chainRun 4, and
both violations fire; the contract-first equivalent (disjoint `src/slices/*`) audits
to levels `[1,3,1]`, maxWidth 3, criticalPath 3, zero violations — foundation → wide
slice layer → assemble. 23 tests green (`quick-planspec.test.mjs`,
`quick-planspec-runner.test.mjs`).

**Live acceptance benchmark (2026-07-07, real Opus 4.8 one-shot with the new prompt,
same Pac-Man intent, audited by the shipped `parseQuickPlanspec`+`auditPlanGraph`):**

```
pacman5 (old prompt): levels [2,1,1,1,1,1,1]  maxWidth 2  criticalPath 7  god-file reducer.ts
pacman6 (new prompt): levels [1,6,1]          maxWidth 6  criticalPath 3  0 violations, 0 safety edges

B0  Define game contract: state, types, maze, constants   (foundation — contract files)
B1  movement.ts · pellets.ts · ghosts.ts · collisions.ts · progression.ts · GameCanvas+Hud
    (6 disjoint slice stories, ALL depending only on the contract — model-authored DAG)
B2  Assemble the complete app (page.tsx + seam hook + loop; depends on all 7)
```

Quality held: 33 ACs, 8 behavioral, 16 with `thenObservable`, every named capability
covered, and the assemble story carries 8 ACs proving each capability through
`window.__harness.snapshot()` with the seam-mount AC first. Critical path 7 → 3
(better than halved); width 2 → 6 (= feature count). The repair pass never fired —
the prompt alone produced a clean wide plan.

Not deployed — operator runs `rsync-daemon.sh` after review.

---

## Appendix — verbatim prompts

- BEFORE: `git show 0deeb60^:daemon/pipelines/lib/quick-planspec.mjs`
- AFTER: `git show 0deeb60:daemon/pipelines/lib/quick-planspec.mjs`
- Derive: `deriveDeps` / `classify` / `topoLevels` in the same file (unchanged across the upgrade).
