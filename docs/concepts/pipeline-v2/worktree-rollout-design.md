# Worktree Rollout — Phase 1 Design

**Date:** 2026-05-19
**Status:** Decision document — review + sign-off required before code
**Parent:** `worktree-rollout-plan.md`
**Probe data:** `worktree-rollout-plan.md` §0.3 findings

This doc resolves the 4 Phase 1 entry-gate decisions so implementation
can start with a fixed contract. Each section ends with a concrete
**Decision** line + a **Why** anchor that's grep-friendly for future
spelunking.

---

## 1. `node_modules` strategy

### Constraints (from probe data)

- 4.0 GB free on `/dev/root` (19 GB total, 79% used). Tight.
- All 4 active projects are Next.js with ~460–670 MB `node_modules`.
- The bare repo at `/home/ubuntu/repos/<app>.git` already serves multiple
  worktrees with a shared object store — node_modules sharing is the
  remaining bottleneck.

### Options considered

| Option                                                    | Per-worktree cost   | Setup time               | Risk                                                                |
| --------------------------------------------------------- | ------------------- | ------------------------ | ------------------------------------------------------------------- |
| Per-worktree `npm install`                                | 460–670 MB          | 30–60s                   | OOM disk after 5 worktrees                                          |
| Symlink to shared `node_modules`                          | ~4.6 MB (file only) | ~0 (after first install) | Build tools that resolve via realpath may behave subtly differently |
| pnpm migration (content-addressable store)                | ~25 MB hardlinks    | 30s first time, ~0 after | Migration cost across 4 brownfield repos + lockfile rewrite         |
| Per-worktree `npm install --offline` against shared cache | ~460 MB             | ~10s after first         | Doesn't actually save disk; only saves time                         |

### Decision

**Symlink-from-store.** Concrete shape:

- Store layout: `/home/ubuntu/.node_modules_store/<appId>/<lockfileSha>/`
  contains a fully-installed `node_modules/` tree.
- Lockfile fingerprint: `sha256` of `package-lock.json` content (or
  `pnpm-lock.yaml` / `yarn.lock` if present). Different lockfiles =
  different store entries; same lockfile = full reuse across worktrees.
- Worktree setup: `ln -s /home/ubuntu/.node_modules_store/<app>/<sha>
<worktree>/node_modules`.
- First worktree on a new lockfile: install into the store, then symlink.
  Subsequent worktrees: symlink only (zero install time).
- Eviction: when a new lockfile hash appears, retain the prior store
  entry until no active worktree symlinks to it. Garbage-collect via the
  reaper (see §3).

**Why:** Disk math (5 parallel worktrees × 670 MB ≈ 3.3 GB) exceeds free
space; symlinks are the only viable strategy given current disk pressure.
pnpm migration is correct long-term but requires lockfile rewrites on
brownfield repos we don't own — defer to a separate project.

**Caveat:** Next.js `next.config.ts` + esbuild generally tolerate
symlinked `node_modules`. Smoke-test on snake-4 before declaring this
universally safe; if it breaks, fall back to per-worktree install +
accept the disk cost (eviction policy then becomes load-bearing).

**Symlink-target reference counting:** store entries track refcount via
a sidecar `.refcount.json` file (incremented on worktree setup,
decremented on teardown). Reaper deletes entries with refcount=0 AND no
filesystem symlink found after a full scan.

---

## 2. Merge-conflict policy

### Decision

**Phase 1 is operator-resolve only. No auto-merge attempts.**

Wave-merge sequence (per the existing `wave-merge.mjs` helper):

1. Daemon checks out `plan/<slug>` in a **coordinator worktree** at
   `/home/ubuntu/worktrees/<app>/<plan>/_merge/`.
2. For each `wip/<storyId>` in deterministic order (sorted by storyId
   ascending; tie-break stable), run
   `git merge --no-ff wip/<storyId> -m "merge story <storyId> into wave"`.
3. **On clean merge** of all stories → proceed to post-merge validation
   (§4).
4. **On the first conflict**:
   - `git merge --abort` to leave the coordinator worktree clean.
   - Emit `merge-conflict` attention via the existing
     `buildMergeConflictAttention` helper.
   - Mark the wave's status as `fixing` (existing wave-reducer code path).
   - **Halt** — do not attempt the remaining stories' merges.
5. **Resolution flow (operator):**
   - Operator resolves the conflict manually on their laptop or directly
     on the coordinator worktree.
   - Operator clicks **"Re-attempt wave merge"** in the UI (new action;
     defaults to merging from where it stopped).
   - Daemon retries the merge sequence from the failed story onwards.

**Why:** Auto-merging the second conflict on top of an unresolved first
conflict produces a snowball of issues. Halting after first conflict
preserves diagnostic clarity. MERGER agent (Phase 2) handles the
auto-resolution case once we have data on how common conflicts are.

**Out of scope:** retry-with-fix loops, semantic-conflict detection,
agent-assisted resolution.

> **2026-05-29 — this decision is in force again (reaffirmed).** Commit
> `3fa8713` (2026-05-28) had temporarily reversed it with an LLM-backed
> self-healing resolver (`resolveWaveMergeConflict` + a `resolveConflict`
> hook in `wave-merge-runner.mjs`) wired into the merge path under incident
> pressure (pacman-1 E2). That hotfix has been **rolled back** to restore the
> halt-on-first-conflict behavior described above. Rationale (2026-05-29
> code investigation, recorded in `agentic-integration-branching.md` and the
> companion action plan):
>
> 1. The only post-merge gate is compile-only (`npm run build && npm run
test --if-present`, and the scaffold ships no tests), so it cannot
>    validate a semantically-wrong-but-compiling resolution.
> 2. The resolver was non-deterministic (unpinned `sonnet` alias, no
>    temperature/seed, single-shot), so a "resolved candidate" was not a
>    reproducible function of its inputs.
> 3. Successful auto-resolutions landed silently — `git commit --no-edit`
>    with no trailer, resolver stdout discarded, conflict blobs destroyed by
>    in-place edits + `git add -A`, and **no DDB record** (attention items
>    were written only on the halt path) — so a bad merge could ship on the
>    deploy branch with no audit trail.
> 4. The hotfix shipped the explicitly out-of-scope "agent-assisted
>    resolution" path **before** this decision's own precondition — _data on
>    how common conflicts are_ — was met.
>
> **Precondition for revisiting auto-resolution:** conflict-rate telemetry
> (a durable per-conflict DDB record + self-describing commit trailer +
> captured pre-resolution blobs) showing a measured, non-trivial conflict
> rate on files that the registry/generated-wiring refactor cannot make
> additive — _and_ a proper Phase-2 MERGER agent that is pinned (model +
> temperature 0), captures its inputs, is fully audited, and is gated on
> **real behavioral tests**, not a compile-only gate. The actual race that
> motivated the hotfix (two epics in one plan-wave mutating the shared
> `_merge` worktree on `plan/<slug>` concurrently) is addressed separately
> and correctly by the per-app integration lock + ephemeral per-candidate
> worktree + advance-on-green (brainstorm doc §6 "Now"), not by
> auto-resolution.

---

## 3. Reaper specification

### Goals

- Reap worktrees whose owning job is terminal AND stale.
- Reap `node_modules` store entries with refcount 0.
- Coexist with Epic 18's free-agent reaper without stepping on its
  worktree namespace.
- Idempotent (safe to run multiple times back-to-back).

### Decision

**Daemon-internal ticker, NOT an SST cron.** (Cron Lambdas can't reach
EC2 disk; CLAUDE.md already documents this constraint for Story 18.1.)

**Worktree namespace boundaries:**

| Namespace                                              | Used by                                           | Reaper                            |
| ------------------------------------------------------ | ------------------------------------------------- | --------------------------------- |
| `/home/ubuntu/projects/<app>/`                         | Legacy pre-Phase-1 shared worktree (still exists) | NOT reaped — operator-owned       |
| `/home/ubuntu/worktrees/<app>/<plan>/<storyId>/`       | Phase 1 per-story worktrees                       | New reaper                        |
| `/home/ubuntu/worktrees/<app>/<plan>/_merge/`          | Phase 1 wave-merge coordinator                    | New reaper                        |
| `/home/ubuntu/free-agent-worktrees/<app>/<sessionId>/` | Epic 18 free-agent sessions                       | Epic 18's own reaper (Story 18.2) |
| `/home/ubuntu/.node_modules_store/<app>/<sha>/`        | Phase 1 store                                     | New reaper                        |

The new reaper **never touches** the free-agent namespace and vice versa.

**Reap conditions for per-story worktrees:**

- Worktree's owning jobId resolves and `job.status IN (COMPLETED,
COMPLETED_VIA_SALVAGE, COMPLETED_VIA_PREWORK, COMPLETE_WITH_BLOCKED_STORIES,
MANUALLY_SKIPPED, FAILED, STALE, ORPHANED)` AND
  `now - job.updatedAt > 24h`, OR
- Worktree's owning jobId does not exist (job row deleted by plan-delete
  cascade), OR
- Worktree directory exists but `git worktree list` doesn't reference it
  (orphan from a process crash).

**Reap conditions for `_merge` coordinator worktrees:**

- Plan status is `delivered` OR `abandoned` OR `archived`, OR
- Plan row deleted.

**Reap conditions for `.node_modules_store/<app>/<sha>/`:**

- `.refcount.json` reads 0 AND no symlink found pointing to this store
  entry across a full scan of `/home/ubuntu/worktrees/` + the legacy
  `/home/ubuntu/projects/<app>/`.

**Cadence:** 1 hour. Disk pressure isn't real-time-critical and the
ticker should avoid contending with active plans.

**GitHub branch reaping:** **Out of scope for Phase 1.** `wip/<storyId>`
branches on GitHub persist until plan-delete cascade removes them. The
proposal mentioned "unmerged-in-30-days" expiry; that's a real but
separate retention policy and we defer it.

**Coordination with Epic 18 reaper:** documented as namespace separation
above. No shared state; no inter-reaper protocol. If Epic 18's reaper
(Story 18.2) ever lands, both run independently.

### Heartbeat semantics (existing daemon already has this)

- Daemon writes `job.lastHeartbeatAt` every 30s during RUNNING.
- An existing cron reaper (different path) detects stale heartbeats and
  marks jobs `STALE`. The new worktree reaper consumes the resulting
  terminal-status job rows; it does NOT re-implement heartbeat logic.

---

## 4. Brownfield framework matrix

### Constraints (from probe data)

All 4 active projects are Next.js. `sst`, `vite`, `mobile` boilerplates
are stubs with no live consumers. (`architecture.md` §10 drift point #1.)

### Decision

**Uniform `npm test` for Phase 1.** Encoded as a new optional method on
the boilerplate registry:

```typescript
// functions/shared/boilerplates/types.ts
interface BoilerplateConfig {
  // ... existing fields
  /**
   * Phase 1 — post-merge validation command run after wave-merge.
   * If null, post-merge validation is skipped (with a logged note).
   * Run in the coordinator worktree's working dir; non-zero exit fails
   * the wave and triggers wave-build-failed attention.
   */
  postMergeValidationCmd?: string | null;
}
```

Registry values for current boilerplates:

| Boilerplate   | `postMergeValidationCmd` | Reason                                           |
| ------------- | ------------------------ | ------------------------------------------------ |
| `nextjs-base` | `"npm test"`             | Default; covers all 4 active brownfield projects |
| `sst`         | `null`                   | Stub; no test infra                              |
| `vite`        | `null`                   | Stub; no test infra                              |
| `mobile`      | `null`                   | Stub; no test infra                              |

**Why:** Defer the framework matrix until a non-Next.js brownfield gets
admitted. Build the plumbing (the field + the reader) now so adding new
commands is a one-line registry change; don't pre-design for hypothetical
frameworks.

**Failure semantics:** wave-merge clean + `npm test` exit non-zero →
emit `wave-build-failed` attention via the existing
`buildWaveBuildFailedAttention` helper. Wave status → `fixing`. Operator
decides whether to re-dispatch DEV / mark stories failed / accept the
test-fail and override.

---

## 5. Implementation order

Once the decisions above are accepted, the work lands in this order:

1. **Boilerplate registry field** (~10 min) — adds
   `postMergeValidationCmd` to `nextjs-base`. Required by 5.
2. **node_modules store helper** (~1 hour) — `setupNodeModulesSymlink`,
   `teardownNodeModulesSymlink`, refcount sidecar. Pure functions +
   smoke test.
3. **Per-story worktree helper** (~30 min) — wraps
   `worktree-paths.mjs` + `git worktree add` + node_modules symlink.
   Pure helper that the dispatcher will call.
4. **Dispatcher integration** (~1 hour) — daemon job runner sets the
   PENDING job's `workingDir` to the per-story worktree before spawning
   any pipeline step. Bootstrap: if the worktree doesn't exist, create
   it; if a prior orphan exists at the same path, reap-then-recreate.
5. **Wave-merge service** (~1.5 hours) — runs the merge sequence in
   the coordinator worktree, calls existing classifier, handles the
   halt-on-first-conflict path, runs post-merge validation, returns
   structured result.
6. **Wave-reducer wiring** (~30 min) — when reducer says
   `wave-completed`, call the new wave-merge service instead of the
   current no-op.
7. **Cleanup-on-success** (~30 min) — `git worktree remove` + local
   `git branch -D` for each merged wip branch. GitHub branch survives.
8. **Reaper ticker** (~1.5 hours) — runs every hour inside the daemon.
   Three reap loops (per-story, coordinator, node_modules store).
9. **Tests** (~2 hours) — unit-test the wave-merge service, the
   reaper's reap conditions, the node_modules refcount sidecar, the
   dispatcher's worktree-resolution logic. Bash syntax tests for new
   shell.

**Estimated total:** ~9 hours of focused work. ~2-3 calendar days
allowing for review + iteration.

---

## 6. Phase 1 acceptance gate

Already specified in the parent rollout plan. Repeating here so this
doc is self-contained:

- [ ] One brownfield plan (snake-4 or equivalent) runs end-to-end with
      per-story worktrees: 5+ stories across 2+ waves, every commit
      attributed to its own story, wave-merge clean, post-merge validation
      passes, plan reaches `review` with no STORY_COMMIT_EMPTY.
- [ ] One adversarial plan: two stories in the same wave touch the same
      file. Wave-merge produces a `merge-conflict` attention with the
      conflicted file list. Operator resolves manually; wave then closes.
- [ ] Reaper test: kill the daemon mid-story. Reaper cleans the orphaned
      worktree on the next tick without losing data from active sibling
      stories.
- [ ] Disk audit: 10 parallel stories across two plans. Total disk
      bounded under symlink-based `node_modules` sharing.

---

## 7. Open questions (NOT blockers for code start)

These don't need answers before Phase 1 implementation but should be
resolved before declaring Phase 1 acceptance:

- **Re-attempt-wave-merge UI surface.** What's the API path? Probably
  `POST /api/epic-workflows/:id/waves/:n/retry-merge`. Where does the
  button live in the dashboard?
- **Symlink-vs-realpath subtleties for Next.js.** Confirm via smoke
  test that `next build` / `next dev` work against a symlinked
  `node_modules`. Known sharp edges around `next-transpile-modules` and
  `webpack.resolve.symlinks`.
- **Lockfile drift.** If a brownfield repo's `package-lock.json` changes
  mid-plan (operator pushed a dep bump from their laptop), the next
  story's worktree creates a NEW store entry. Old entry's refcount
  drops as in-flight worktrees teardown. Acceptable; document in
  release notes.

---

## 8. Decision summary (sign-off table)

| #   | Decision                                                                                                            | Status                                                                                                             |
| --- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| §1  | node_modules: symlink-from-store with refcounted entries at `/home/ubuntu/.node_modules_store/<app>/<lockfileSha>/` | **approved 2026-05-19**                                                                                            |
| §2  | Merge-conflict: halt-on-first; operator resolves manually; re-attempt-wave action retries                           | **approved 2026-05-19**; reversed by `3fa8713` (2026-05-28); **rolled back / reaffirmed 2026-05-29** (see §2 note) |
| §3  | Reaper: daemon-internal hourly ticker; per-story + coordinator + store; never touches free-agent namespace          | **approved 2026-05-19**                                                                                            |
| §4  | Framework matrix: `postMergeValidationCmd` on boilerplate registry; Next.js → `npm test`; stubs → `null`            | **approved 2026-05-19**                                                                                            |

**Action required:** approve / amend / reject the four decisions, then
implementation begins.
