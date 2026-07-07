# Task brief for Fable 5 — rebuild the Pipeline-3 planner to ultracode-grade agency + parallelism-first, jcode-aware

You are Fable 5. Your mission is to **substantially upgrade the Pipeline-3 "quick-planspec"
planner** — the single LLM step that turns an operator's app idea into the story graph the
rest of the factory builds. The current planner produces _high-quality but nearly serial_
plans (a linear batch chain), which throws away the parallelism this system is built to
exploit. Fix that without losing the quality — and do it as an agent with real agency:
investigate, decide, implement, test, and justify.

This is not a "tweak the prompt" task. Treat it as designing the planner as a first-class
component: its reasoning, its output contract, the dependency derivation, and the
validation gates around it. Go beyond the levers listed here if you find something better —
you own the outcome, not a checklist.

---

## 0. Read these first (ground truth — do not skip)

- `docs/concepts/pipeline-v3/planner-parallelism-investigation.md` — the full root-cause
  analysis with hard evidence (READ THIS FIRST; it explains exactly why the plan went linear).
- `daemon/pipelines/lib/quick-planspec.mjs` — the planner core you will change:
  `buildQuickPlanspecPrompt` (the prompt), `parseQuickPlanspec` (parse→StoryNode coercion),
  `deriveDeps` / `classify` / `topoLevels` (the dependency + batching derivation),
  `buildStoryNodeRows` (Kahn layering → `cohortBatch` / `ready|blocked`).
- `daemon/pipelines/lib/__tests__/quick-planspec.test.mjs` — the tests you must keep green /
  extend.
- `daemon/lib/model-effort-policy.mjs` — planner runs `claude-opus-4-8` high (leave the model;
  this task is about the plan shape + derivation, not the tier).
- `daemon/pipelines/quick-planspec-runner.mjs` — how the planner job is spawned + ingested.
- `functions/shared/types/plan-spec.ts` — the canonical `StoryNode` / `PlanSpec` contract.
- The wave-merge coordinator + per-story worktree machinery in the daemon (search
  `_merge`, `worktrees/<appId>`, ready-frontier `P3_READY_FRONTIER`) — this is the jcode-style
  execution substrate your plan feeds. **Understand it before you plan for it.**

---

## 1. How the factory actually builds (the jcode substrate you must plan for)

Lab3's dev execution was built on **jcode logics**. Your plan is the input to that engine, so
the plan must be shaped to exploit it. The substrate:

- **Batches = parallel waves.** Stories with no unmet dependency form the _ready frontier_
  and run **concurrently**, each in **its own git worktree** off a shared bare repo, then
  **merge back** via the `_merge` coordinator. Wide batch = many workers in parallel = wall-clock
  saved. A single-story batch = one worker, everyone else idle.
- **Concurrent same-file edits are already handled** by wave-merge. So "two stories touch the
  same file" is NOT a real reason to serialize them — that is the exact false constraint that
  made the current plan linear (see the investigation). Do not encode file-sharing as a hard
  dependency.
- **Contracts freeze the interface between parallel workers.** The reason parallel stories don't
  clobber each other is that a foundation story establishes a **frozen contract** (state shape,
  action/event types, module signatures) and every parallel feature implements _against_ that
  contract. Your plan must make this explicit: define the contract early, then fan out.
- **Context management matters.** Each story is a bounded unit of work a single agent holds in
  context. Stories must be **self-describing and locally implementable** — a coder should be
  able to build one story from its title + intent + ACs + touches + the frozen contract, without
  needing the other in-flight stories' internals. Over-broad stories blow context; over-narrow
  stories create chatty chains.

**The plan's job:** hand this engine the _widest correct DAG_ — a small contract-defining
foundation, then as many mutually-independent feature stories as the idea supports running in
parallel, then a thin integration/assemble story that composes them and mounts the seam.

---

## 2. The problem you are solving (one sentence)

The current planner favors a single cohesive shared core (e.g. one `reducer.ts` every feature
edits), and the dependency derivation turns "shared file" into "hard dependency," so the whole
feature set collapses into a linear chain — **coherent but serial**. The old planner was the
opposite — **parallel but incoherent ("lame" apps)**. You must deliver **coherent AND parallel**.

North-star metric: **maximize ready-frontier WIDTH** (stories concurrently `ready`) while
preserving plan quality and coherence. Judge success by frontier width and critical-path
length, not story count.

---

## 3. Requirements (hard)

1. **Preserve the quality wins.** Keep: full fidelity (every capability the operator named is
   covered, no demo subset), the behavioral/interactivity ACs (`needsBrowser`, `verify:behavior`,
   `when`/`thenObservable` through `window.__harness.snapshot()`), and the seam-wiring rule (the
   assemble story routes live state through the scaffold seam hook or QA hard-fails with
   SEAM_NEVER_PUBLISHED). App-kind-agnostic (game | dashboard | editor | tool | sim | workflow) —
   never hardcode a genre.
2. **Design for width.** Feature stories that are logically independent MUST land in the same
   batch. A plan with a single-story batch for >2 consecutive batches is a failure of the planner,
   not a property of the idea.
3. **No god-files by construction.** No single non-foundation file should appear in more than one
   feature story's `touches`. Use per-feature slice modules against a frozen contract; compose them
   in the assemble story. (This is the concrete mechanism that makes width safe under wave-merge.)
4. **Be jcode-aware in the reasoning.** The plan must reflect the contract → parallel-fan-out →
   merge/assemble shape the substrate rewards. Make the contract explicit and freezable.
5. **Keep it buildable + testable.** Output must still parse into valid `StoryNode`s and ingest via
   `buildStoryNodeRows`. If you evolve the output contract or the derivation, update the parser,
   the layering, the tests, and the `StoryNode` type together — all green.
6. **Deterministic, testable core.** The prompt builder + parser + derivation stay pure `.mjs`
   (no I/O), unit-tested. Add tests that PROVE width (e.g. "N independent features → one batch of N,
   not a chain") and prove the no-god-file / linear-chain guards.

---

## 4. Design directions (start here, then use your judgment)

You may implement any subset/superset of these — whatever produces the widest correct DAG:

- **A. Contract-first decomposition (prompt).** Instruct the planner to (1) have the foundation
  story FREEZE the contract — state shape + action/event type union + the module signatures the
  features will implement; (2) give each feature its OWN slice files (e.g.
  `game/reducer/movement.ts`, `game/reducer/scoring.ts`) implemented against that frozen contract;
  (3) reserve one thin assemble story to combine slices (root combiner/dispatcher) + wire the seam.
  Add the explicit rule: _"Shared files serialize the build under naive derivation and cost you
  parallelism. Never plan one file every feature edits. Disjoint slices against a frozen foundation
  contract; combine only at assemble."_

- **B. Ownership-aware derivation (`deriveDeps`).** Stop treating a shared touch as a hard edge.
  Distinguish the file's **owner/creator** from **contributors**; a feature depends on the
  foundation that owns the CONTRACT it needs, not on every sibling that also writes a shared file.
  Let wave-merge resolve concurrent edits. Result: features depend on foundation only → one wide
  batch, then assemble.

- **C. Explicit DAG + width objective (ultracode-grade).** Let the planner emit its OWN
  `dependsOn` (real contract/data deps only) instead of relying on the regex-based derive, and give
  it an explicit optimization objective + self-check: _"maximize the number of stories with zero
  unmet deps per layer; a long chain of single-story batches is a smell — refactor toward parallel
  slices."_ Keep the derive as a fallback/normalizer when the model under-specifies.

- **D. A linear-chain / god-file validation gate.** After parse, compute `maxBatchWidth`,
  `criticalPathLength`, and the god-file set. If `maxBatchWidth == 1` across >2 consecutive
  non-terminal batches, or any non-foundation file is shared across features, either (a) auto-repair
  (split the god-file into slices, re-derive) or (b) flag it loudly. Log what it found (never
  silently ship a serial plan).

- **E. (optional) Two-pass planner.** Pass 1: enumerate capabilities + design the contract + the
  parallel decomposition (reasoning). Pass 2: emit the JSON. Opus 4.8's adaptive thinking supports
  this well; a short structured reasoning pass tends to produce a wider, cleaner DAG.

---

## 5. Deliverables

1. The upgraded planner in `daemon/pipelines/lib/quick-planspec.mjs` (prompt + parse + derive as
   needed), with the `StoryNode`/`PlanSpec` types and `quick-planspec-runner.mjs` updated if the
   contract evolves.
2. Tests proving: (a) N independent features → a batch of width N (not a chain); (b) no god-file
   survives; (c) the linear-chain gate fires on a bad plan; (d) fidelity + seam + behavioral ACs
   still enforced; (e) everything ingests via `buildStoryNodeRows`. `node --check` clean, full
   daemon test suite green.
3. A short design note appended to `docs/concepts/pipeline-v3/planner-parallelism-investigation.md`
   (or a sibling doc) explaining what you changed and the before/after DAG shape on the pacman-style
   idea used as the benchmark.
4. Do NOT deploy. Leave it committed on the working branch; the operator runs `rsync-daemon.sh`
   after review. Report the exact commit + what to deploy.

## 6. Acceptance criteria (how the operator will judge you)

- Re-plan the benchmark idea ("a full Pac-Man game …") and show the DAG is now **wide**:
  foundation batch → one wide parallel feature batch (or a shallow 2–3 level DAG) → assemble —
  instead of the 0→1→2→3→4→5→6 chain.
- `maxBatchWidth ≥ feature count` after foundation; `criticalPathLength` roughly halved or better.
- No single non-foundation file shared across feature stories.
- Quality preserved: fidelity, behavioral ACs, seam wiring — a reviewer reading the idea sees
  nothing missing and the assemble story proves each capability behaviorally.
- The reasoning is jcode-aware: the plan reflects contract → parallel fan-out → merge/assemble,
  and you can articulate why each parallel batch is safe under wave-merge.

Ship coherent AND parallel. That is the whole task.
