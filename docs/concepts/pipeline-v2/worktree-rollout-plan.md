# Worktree Rollout — Tracking Plan

**Date:** 2026-05-19
**Owner:** Richie
**Source proposal:** `pipeline-worktree-tiered-readiness-proposal.md` (Richie, 2026-05-19)
**Trigger incident:** `plan_snake-4_mpcdwkto` — commit subsumption race; 2/7 stories shipped with empty commits, work attributed to wrong commit.

This document is the executable plan derived from the proposal — what we
commit to now, what we conditionally commit to later, and what gates the
transition between phases. Update the checkboxes as work lands.

---

## Phase 0 — Immediate (this week)

**Goal:** close the silent-correctness hole and the snake-4-class subsumption
race without architectural change. Both items ship together; neither commits
us to the larger rollout.

### 0.1 — Honor `onFail.action: 'fail'` on `compile-commit-on-pass`

- [ ] Daemon respects the per-step `onFail.action` on `compile-commit-on-pass`,
      overriding the compile-phase "non-blocking" classification.
- [ ] Regression test: a story whose DEV produces no source changes must
      mark the JOB as `FAILED`, not `done` with a medium-severity attention.
- [ ] Attention item category remains `compile-failed` for visibility, but
      severity raised to `high` since the story is now blocked.

**Acceptance:** a synthetic story that writes nothing to `src/` produces a
FAILED job, no commit on the plan branch, and a high-severity attention
linked to the failing step.

**Estimated effort:** ~30 min code + tests.

---

### 0.2 — File-scoped commits via snapshot-diff (Option B from the proposal)

> **Decision deviation from the proposal:** I'm recommending Option B
> (snapshot-diff) over Option A (story spec) for Phase 0. Option A trusts
> the story spec to be exhaustive; in practice DEV legitimately writes
> outside the spec (helper files, sibling imports). Snapshot-diff is more
> code (~50 lines vs ~20) but strictly more correct and resilient to spec
> drift. Defer Option A as a fallback if Option B has perf issues.

- [ ] Before DEV runs, snapshot `git status --porcelain -uall` to capture
      the baseline.
- [ ] After DEV finishes, snapshot again. The diff = files this story
      actually changed.
- [ ] `compile-commit-on-pass` stages only the delta (`git add -- <delta>`).
- [ ] Concurrent-write detection: if any path in the delta was modified
      between the two snapshots by something OTHER than this story's DEV
      (i.e. its mtime/inode changed in a way inconsistent with our writes),
      log a warning. (Phase 1's worktrees will eliminate this; Phase 0
      just visibility.)

**Acceptance:** re-run a 7-story plan analogous to snake-4. Every story
that produces source changes commits its own files. No subsumption across
sibling commits. STORY_COMMIT_EMPTY only fires when a story legitimately
wrote nothing source-y.

**Estimated effort:** ~2 hours code + tests + deploy.

---

### 0.3 — Disk-space + framework probes (defensive, before Phase 1)

These don't fix anything in Phase 0 but unblock Phase 1 design choices.

- [x] Measure current `du -sh /home/ubuntu/projects/<app>/{,.git,node_modules}`
      across the 4 brownfield apps + 1 greenfield to establish per-worktree
      cost baseline.
- [x] Inventory framework types across active apps (Next/Vite/Python/static)
      so Phase 1's post-merge validation knows what `npm test` even means.
- [x] Verify `git worktree add` works as ubuntu inside the existing daemon
      worktrees (smoke test only — no production wiring yet).

#### Probe findings (captured 2026-05-19 via SSM)

**Per-project disk:**

| Project                 | Total | `.git`       | `node_modules` | `src` | `.next` |
| ----------------------- | ----- | ------------ | -------------- | ----- | ------- |
| snake-4                 | 684M  | 4K (pointer) | 672M           | 264K  | 6.8M    |
| brick-1                 | 619M  | 4K (pointer) | 462M           | 236K  | 153M    |
| dino1                   | 493M  | 4K (pointer) | 463M           | 204K  | 26M     |
| applicator (brownfield) | 129M  | 28M          | — (no install) | 19M   | —       |

**Framework inventory:** all 4 active projects are **Next.js**. (`sst`,
`vite`, `mobile` boilerplates are stubs per architecture.md §10 — no
active project uses them yet.)

**Free disk:** **4.0 GB / 19 GB total** on `/dev/root`. Currently **79%
used**. At ~500–680 MB per project worktree, 5+ parallel worktrees with
their own `node_modules` would run the disk out within a single plan.
**node_modules sharing is on the critical path for Phase 1 — not optional.**

**`git worktree add` smoke test:** SUCCESS.

- `git worktree add /home/ubuntu/worktrees-smoke/snake-4-probe main` worked
  as `ubuntu`. Resulting worktree was **4.6 MB** (working files only).
- `.git` inside the worktree is a 63-byte file pointer, confirming the
  shared object store is reused (Git's standard worktree behavior).
- Bare repo found at `/home/ubuntu/repos/snake-4.git` — the existing daemon
  setup is already worktree-friendly: `/home/ubuntu/projects/<app>/` is
  ALREADY a `git worktree` of `/home/ubuntu/repos/<app>.git`. This means
  Phase 1's `git worktree add` slots in naturally; we don't need to clone
  per story.

**Side observation (out of scope for P0):** 8 stale Epic 18 free-agent
worktrees at `/home/ubuntu/free-agent-worktrees/snake-4/<sessionId>/` —
the GC ticker (Story 18.2) is deferred. One of them references commit
`bac327b` which was force-pushed off main earlier; the commit is kept
alive in the bare repo by that worktree's ref. Harmless but reinforces
the orphan-reaper requirement for Phase 1.

**Implications for Phase 1 design gates:**

- node_modules sharing strategy MUST be decided before Phase 1 code
  starts. Symlink-from-store is the recommended default given current
  disk pressure (4.0 GB free) and uniform Next.js stack.
- Bare-repo + worktree topology is already in place — Phase 1 reuses
  rather than introduces it.
- Orphan reaper must coordinate with Epic 18's free-agent reaper (same
  filesystem root, different worktree namespaces).
- Framework matrix for post-merge validation: today it's universally
  `npm test`; matrix expansion is deferred until a non-Next.js
  brownfield is admitted.

---

## Phase 1 — Worktree-per-story foundation

**Goal:** every story runs in its own working directory on `wip/<storyId>`,
wave-merge consolidates into `plan/<slug>`. This is the architectural
commitment that enables everything downstream.

### Phase 1 entry gate (must hold before code starts)

These design decisions land first as a `worktree-rollout-design.md`
sibling doc, not during implementation:

- [ ] **`node_modules` strategy chosen.** Default: symlink from a shared
      `/home/ubuntu/.node_modules_store/<app>/` into each worktree. pnpm
      migration deferred to a separate project. Rejection criterion: if
      symlinks break under Next/Vite hot-reload or break a known build
      tool, fall back to per-worktree install + accept the disk cost.
- [ ] **Merge-conflict policy decided.** When `git merge --no-ff wip/<a>`
      conflicts with already-merged `wip/<b>`: wave fails, attention item
      `merge-conflict` raised with full file list, operator resolves
      manually (cannot auto-resolve in Phase 1). MERGER agent is Phase 2.
- [ ] **Reaper design specified.** Heartbeat interval, stale threshold
      (>10min no heartbeat AND no active claude subprocess for the
      worktree's jobId → reap), GitHub branch reaping on local reap (yes
      for unmerged-in-30-days, no for active plans), interaction with
      Epic 18 free-agent worktrees (separate reaper, separate threshold).
- [ ] **Brownfield framework matrix.** For each known brownfield boilerplate
      (`debatator`, `applicator`, `songster`, `futurator`), what's the
      post-merge validation command? (`npm test`, `pytest`, none, etc.)
      Encoded in `boilerplate-registry.ts` so wave-merge can dispatch.

### Phase 1 implementation

- [x] **1.1** Wire `worktree-paths.mjs` into the dispatcher. Each story
      starts in `/home/ubuntu/worktrees/<app>/<plan>/<storyId>/` on branch
      `wip/<storyId>` created off the plan branch's current tip.
- [x] **1.2** `node_modules` sharing: symlink-from-store implementation.
      (`daemon/lib/node-modules-store.mjs` with `.refcount.json` sidecar.)
- [x] **1.3** Wave-merge integration: after all stories in a wave reach
      terminal status (success), daemon checks out `plan/<slug>` in a
      coordinator worktree, runs `git merge --no-ff wip/<storyId>` per
      story in deterministic order, classifies via
      `classifyWaveMergeOutcome`, emits attention on conflict, halts wave.
      (`daemon/lib/wave-merge-runner.mjs` + new `'wave-merge'` jobType in
      job-router.)
- [x] **1.4** Post-merge validation gate: after merge, daemon runs the
      boilerplate's `postMergeValidationCmd` in the plan branch worktree.
      On failure, wave is `wave-build-failed`; operator decides to retry
      or roll back.
- [x] **1.5** Orphan reaper: daemon-internal hourly ticker, three reap
      loops (per-story / coordinator / store), namespace-isolated from
      Epic 18 free-agent reaper. (`daemon/lib/worktree-reaper.mjs`.)
- [x] **1.6** GitHub branch push: `wip/<storyId>` pushed to origin after
      every successful per-story `compile-push` (already wired by
      story-pipeline; verified it follows the per-worktree `HEAD`).
- [x] **1.7** Cleanup: on successful wave-merge, `git worktree remove
    <path>` + `git branch -D wip/<storyId>` locally; GitHub branch
      survives until plan-delete cascade. (Inside wave-merge-runner.)

**Code-complete 2026-05-19.** Lambda + cron + AdminSite shipped via
`sst deploy`. **Daemon-side changes pending `./scripts/rsync-daemon.sh`**
— without that, the pipeline-launcher will queue wave-merge jobs the
daemon doesn't yet know how to dispatch.

### Phase 1 acceptance

- [ ] One brownfield plan (snake-4 or equivalent) runs end-to-end with
      worktrees: 5+ stories across 2+ waves, all commits attributed to
      their own story, wave-merge clean, post-merge validation passes,
      plan reaches `review` with no STORY_COMMIT_EMPTY.
- [ ] One adversarial plan: two stories in the same wave touch the same
      file. Wave-merge produces a `merge-conflict` attention item with
      the conflicted file list. Operator resolves manually. Wave can
      then be marked done by operator.
- [ ] Reaper test: kill the daemon mid-story. Confirm the reaper cleans
      the orphaned worktree on the next scheduled tick without losing
      data from active sibling stories.
- [ ] Disk audit: 10 parallel stories across two plans. Total disk
      bounded under symlink-based `node_modules` sharing.

**Estimated effort:** ~1 week design + ~2 weeks implementation +
~1 week stabilization on real plans.

---

## Phase 2 — Merger agent improvements (CONDITIONAL)

**Gate:** start only if Phase 1 surfaces ≥5 merge conflicts across the
first 10 post-rollout plans that an operator had to resolve manually.

If conflict rate is low (e.g., PM touch-point allocation is already doing
its job), Phase 2 is premature. Skip and revisit later.

- [ ] **2.1** Define MERGER agent contract: input (conflict files, both
      sides' diffs, story specs), output (resolved file content or
      "cannot resolve").
- [ ] **2.2** Reuse REVIEWER agent at higher rigor vs dedicated MERGER —
      decide based on token cost trial.
- [ ] **2.3** Define rework policy: when MERGER fails, do we re-run the
      losing story's DEV with merge context, dispatch a patch-mini-story,
      or escalate to operator? Pick one and document.
- [ ] **2.4** Wave-merge retry-with-fix loop with bounded attempts (max 2).

### Phase 2 acceptance

- [ ] MERGER successfully resolves ≥70% of conflicts on a held-out test
      set. Operator-resolution rate drops materially.

---

## Phase 3 — Tiered readiness / speculative pipelining (CONDITIONAL)

**Gate:** start only if BOTH hold:

1. Phase 1 ran ≥10 plans cleanly.
2. **Measured** plan latency exceeds 2× the dependency-graph critical path
   (i.e. there's actual serialization-tax to recover). If plans finish in
   their critical-path time today, speculative pipelining buys nothing
   and adds rework risk.

> snake-4 ran 7 stories in 57 min for $9 on the current architecture.
> There's no current evidence this phase is needed.

- [ ] **3.1** Add `contract-stable` readiness signal (emitted after code
      review passes). Keep `fully-done` as the only other tier.
- [ ] **3.2** PM annotates dependency edges with required readiness level;
      default to `fully-done`.
- [ ] **3.3** Daemon dispatches dependents based on the annotated signal.
- [ ] **3.4** Instrumentation: track rework rate (downstream stories
      invalidated by contract drift), cascade depth, token cost per plan.
- [ ] **3.5** Define a kill-switch: if rework rate > threshold across N
      plans, default ALL edges back to `fully-done` automatically.

### Phase 3 acceptance

- [ ] Average plan latency drops materially against the Phase 1 baseline,
      AND rework rate stays below the kill-switch threshold, across ≥10
      consecutive plans.

---

## Phase 4 — Multi-machine dispatch (SPECULATIVE — not committed)

Listed for completeness; not on the active roadmap. Requires a real user
need (e.g., laptop wants to execute stories while EC2 is busy or asleep)
plus a trust model for cross-machine work that doesn't currently exist.

Re-open this section if/when that need surfaces. The Phase 1 + Phase 2
foundation is sufficient to enable it; we just don't need to scope it
ahead of time.

---

## Out-of-scope but worth tracking independently

These were raised in the proposal review but aren't part of this plan:

- **Tighter PM parallelism heuristics.** The current PM-touch-point
  allocation is doing the heavy lifting on race avoidance. Independent of
  worktrees, investing in PM's touch-point inference + conflict detection
  would reduce wave-merge conflict rate. Separate project.
- **Brownfield boilerplate framework parity.** `sst`, `vite`, `mobile`
  stubs need test-infrastructure scaffold before they can participate in
  worktree-style wave-merge with post-merge validation. Tracked in
  architecture.md §10 drift point #1.
- **Lambda-vs-daemon dispatch consolidation.** v3 entry-point question
  from architecture.md §11; not directly related to worktrees but the
  multi-machine future eventually forces this conversation.

---

## Decision log (append as decisions are made)

| Date       | Decision                                                           | Reason                                                     |
| ---------- | ------------------------------------------------------------------ | ---------------------------------------------------------- |
| 2026-05-19 | Phase 0 commits to BOTH onFail-fix AND file-scoped commits         | Cheap insurance regardless of Phase 1 timeline             |
| 2026-05-19 | Phase 0.2 uses snapshot-diff (Option B), not story-spec (Option A) | Spec trust fails when DEV legitimately writes outside spec |
| 2026-05-19 | Phase 2 conditional on real Phase 1 conflict rate                  | Premature complexity if PM allocation handles it           |
| 2026-05-19 | Phase 3 conditional on measured latency tax                        | snake-4 evidence does not yet justify rework risk          |
| 2026-05-19 | Phase 4 deferred indefinitely                                      | No current user need; revisit when one appears             |

---

## How to use this doc

- **Tracking:** check off acceptance items as they land. The phases
  themselves don't "complete" until their acceptance criteria all check.
- **Gating:** Phase 2 + Phase 3 each have explicit entry gates. Don't
  start the implementation work until the gate's data condition holds.
- **Drift:** if scope changes, update the relevant phase + add a Decision
  log row with the reason. Don't silently mutate items.
- **Pairing:** read alongside `pipeline-worktree-tiered-readiness-proposal.md`
  (Richie, 2026-05-19) for the full architectural rationale.
