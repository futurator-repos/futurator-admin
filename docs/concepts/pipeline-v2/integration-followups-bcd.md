# Agentic Integration — Follow-up Stories B / C / D

> **Status:** Scoped follow-ups, ready for story creation.
> **Date:** 2026-05-29.
> **Companion to:** `agentic-integration-branching.md` (brainstorm),
> `worktree-rollout-design.md` (the 2026-05-19 decision + 2026-05-29 §2
> reaffirmation), and the downloads-side action plan that this implements.
> **Context:** Decision **A** (roll back the self-healing wave-merge resolver to
> operator-resolve-only) shipped as commit `0c61f67` (2026-05-29). This doc
> scopes the remaining three decisions. **A only removed the silent-corruption
> path; the pacman-2 race itself is still live until Story B ships.**
> **Note on citations:** `file:line` references come from the 2026-05-29 code
> investigation. Re-verify against current `HEAD` before implementing — drift is
> expected.

---

## Implementation status (2026-05-29)

All three shipped in one commit (alongside Story A, `0c61f67`). Summary of
what landed; details per-story below.

- **B — DONE.** `daemon/lib/integration-lock.mjs` (per-app FIFO mutex, wired
  into `executeWaveMergeJob`); `daemon/lib/wave-merge-runner.mjs` rewritten to
  merge in an ephemeral `_cand/<jobId>` worktree detached at the green tip and
  advance `plan/<slug>` atomically via `git update-ref <new> <old>` only after
  the gate passes; reaper + `listStoryWorktrees` skip `_cand`. Tests:
  `integration-lock.test.mjs` (6), `wave-merge-candidate.test.mjs` (real-git
  pacman-2 replay — conflict halts, green untouched, candidate kept), plus
  `candidateWorktreeDir` coverage.
- **C — DONE.** New `futurator-wave-conflicts` DDB table (`sst.config.ts`);
  `daemon/lib/wave-conflict-recorder.mjs` writes a durable row on every
  conflict; the runner captures the marker'd blobs _before_ `git merge
--abort` into the attention context; read side at
  `functions/shared/repositories/wave-conflict-repository.ts` +
  `GET /api/plans/:id/conflicts` and `GET /api/apps/:appId/conflicts`. Commit
  trailers were already satisfied by `buildWaveMergeCommand`'s WAVE-MERGE
  metadata flags. Tests: `wave-conflict-recorder.test.mjs` (4).
- **D — DONE (minimal, in-repo).** `functions/shared/codegen/feature-wiring.ts`
  (pure `generatePageSource` + the self-contained generator script shipped as
  an augment); wired into `NEXTJS_BASE_PACK.augmentFiles` (inherited by all
  `nextjs-*` packs) as `scripts/generate-wiring.mjs`, `src/features/README.md`,
  `.gitattributes`; the post-merge gate (registry + daemon fallback) now runs
  the generator before `next build`; canvas-game scaffold contract updated to
  forbid hand-editing `page.tsx`. Tests: `feature-wiring.test.ts` (7, incl. a
  no-drift end-to-end run of the shipped script), registry assertions (6).

**Two deliberate carve-outs, tracked here so they aren't forgotten:**

1. **B-item-4 `.gitattributes merge=union`** — deferred into D. The current
   base scaffold has no newline-delimited append-only file to apply it to; D's
   directory-of-feature-files model is strictly better (additive _by
   construction_, no shared file), so union isn't needed yet. Revisit only if a
   genuine append-only manifest appears.
2. **Full D conflict-elimination needs one external-scaffold change.** In this
   repo, `page.tsx` is _regenerated at the gate_ from the union of merged
   features — so the candidate always builds the correct page even if a story
   touched `page.tsx`. To make conflicts on it _structurally impossible_, the
   external base-scaffold repo (cloned at bootstrap) must additionally:
   (a) add `"prebuild": "node scripts/generate-wiring.mjs"` to `package.json`
   (regenerate on every local build), and (b) `.gitignore` `src/app/page.tsx`
   - `git rm --cached` it (so stories never commit it → never conflict on it).
     Until then, the contract instructs agents not to touch it and the gate
     regenerates it; residual hand-edits would still conflict at merge time and
     halt per Story A.

---

## Story B — Serialized integration: per-app lock + ephemeral candidate worktree + advance-on-green

**This is the actual pacman-2 fix.**

### Problem

`coordinatorWorktreeDir({appId, planSlug})` returns one shared
`${root}/${appId}/${planSlug}/_merge` on the single `plan/<slug>` branch
(`wave-merge-runner.mjs:84-86`), and there is **no serialization** on the
wave-merge dispatch path. With `MAX_CONCURRENT=2` (`agent-daemon.mjs:444`), two
epics in the same plan-wave run two wave-merge jobs that mutate the same worktree
and branch concurrently — exactly the pacman-2 interleave. `plan/<slug>` is also
mutated **before** the build gate passes, so it is observably half-merged.

### Scope (in)

1. **Per-app integration lock** — wave-merge for a given `appId` is mutually
   exclusive. Because one-plan-per-app is hard-enforced (`PLAN_ALREADY_ACTIVE`,
   `plan-repository.ts:155-163`), per-app == per-plan today, so a per-`appId`
   lock is sufficient and simplest.
2. **Ephemeral per-candidate worktree** — merge in a throwaway worktree created
   from the **current green tip**, never the shared `_merge`. Name it
   job-addressably (e.g. `_cand/<jobId>`); reap on exit (the worktree-reaper
   already owns this namespace family).
3. **Advance `plan/<slug>` only on green** — new sequence: acquire lock → fetch
   green tip → create candidate worktree from green → `--no-ff` merge the wip
   branches → materialize `node_modules` + run `postMergeValidationCmd` → **only
   if green**, advance the `plan/<slug>` ref to the candidate SHA (atomic) and
   push → release lock. A crash leaves `plan/<slug>` untouched.
4. **`.gitattributes merge=union`** for newline-delimited, append-only files
   **only** (e.g. barrels of `export * from './x'`). **Never** JSON/structured
   config — union is line-based and silently corrupts structure. Until Story D
   introduces a manifest, the scaffold may have no such file — verify before
   adding the attribute.

### Open decisions to resolve in the story

- **Lock substrate.** Recommend an in-daemon `Map<appId, Promise>` mutex for now
  (single host, concurrency 2), with an explicit `// DISTRIBUTED SEAM` comment
  where it must become a DDB lease / git ref-CAS once agents span machines. Do
  **not** build the distributed version now.
- **Green-advance mechanism.** Because the per-app lock means green cannot move
  underneath a candidate within the lock, a simple
  `git update-ref refs/heads/plan/<slug> <candidateSHA>` (fast-forward from
  green) is safe — no re-merge-on-stale-tip loop needed yet. Document that the
  re-merge loop is the multi-worker generalization, deferred.
- **Reuse vs. replace `setupCoordinatorWorktree`.** Decide whether to retire
  `_merge` entirely or keep it as the green checkout and add `_cand/*` alongside.

### Acceptance criteria

- Two epics in one plan-wave cannot mutate the same branch/worktree concurrently
  (enforced by lock; test that two overlapping wave-merge jobs for one app
  serialize).
- `plan/<slug>` is never observed in a half-merged state (advance is atomic,
  post-gate).
- The pacman-2 scenario (fixture: two epics, shared `page.tsx`) completes without
  a permanent `fixing` wedge — the second candidate either lands cleanly on the
  new green or surfaces a **real** git conflict that halts per Story A.
- Existing 14 `wave-merge-runner` tests still pass; new tests for lock
  serialization + advance-on-green.

### Risk / size

Medium. Touches the core wave-merge path. Independent of A and C. **No
dependency — start now.**

---

## Story C — Conflict telemetry (durability mechanism + the "data" precondition)

### Problem

On the halt path the only record is an attention item
(`buildMergeConflictAttention` + `writeAttention`,
`wave-merge-runner.mjs:~313-328`), which is transient and gets resolved away.
There is **no durable conflict-event record**, so the conflict _rate_ — the exact
precondition the 2026-05-19 decision named for ever revisiting auto-resolution —
remains unmeasurable. And the conflicted blobs are destroyed by
`git merge --abort`, so a conflict cannot be judged after the fact.

### Scope (in)

1. **Durable DDB conflict-event record** on every wave-merge conflict (and, if
   auto-resolution ever returns, every resolution):
   `{ planId, epicId, waveNumber, conflictedAtStoryId, files[], mode:
'halted' | 'operator-resolved' | 'auto-resolved', timestamp }`. Follow the
   one-table-per-concern repository pattern (`functions/shared/repositories/`);
   new table in `sst.config.ts`. Surface a "conflicts by plan / conflict rate"
   operator query.
2. **Capture the conflict before discarding it** — before `git merge --abort`,
   persist the conflicted file blobs (with markers) into the attention item's
   `context` or a `.context/` sidecar, so the operator (or a future MERGER agent)
   can see _what_ collided.
3. **Self-describing merge commits** — replace `--no-edit` with `git commit -m`
   carrying a trailer (e.g. `[operator-resolved: <files>]`) on the operator
   re-attempt path, so `git log` is auditable.

### Open decisions

- **New table vs. extend an existing one.** A dedicated `futurator-wave-conflicts`
  table is cleanest given the repo's strict one-table-per-concern rule — but heed
  the CLAUDE.md note on hardcoded table names + stage namespacing (the
  decommissioned-stages incident). Confirm naming / PITR.
- **Blob capture location** — attention `context` (queryable, but size limits)
  vs. `.context/` sidecar in the worktree (no size limit, but ephemeral unless
  persisted to S3). Lean sidecar + S3 if blobs are large.

### Acceptance criteria

- Every wave-merge conflict produces a durable DDB row queryable by plan.
- An operator can answer "how often do conflicts happen, and on which files"
  without reading daemon logs — this **is** the data the Story A precondition
  requires.
- A merge commit produced by operator resolution is self-describing in `git log`.

### Risk / size

Small–Medium. Independent of A and B. The institutional-memory piece that keeps
Decision A from being silently re-reversed under the next incident.

---

## Story D — Registry / generated wiring for hot integration files (the real bet)

### Problem

F1 showed the conflict is structural and concentrated on one file: every render
story hand-edits `src/app/page.tsx` to mount its component. `touchPoints`
wave-spreading (`glob-intersect.mjs:100-166`) reduces but cannot eliminate this
— it is a pre-hoc LLM guess. The only durable fix is to make the hot file
**generated**, never hand-edited.

### Scope (in)

- Scaffold apps so features **register themselves** — each feature drops a file
  into a manifest directory (e.g. `src/features/<feature>.tsx` exporting a
  descriptor) rather than editing a shared file. Directory-of-files is additive
  **by construction** → no shared file → no conflict, strictly better than
  `merge=union` on one file.
- A **codegen step** (prebuild) generates `src/app/page.tsx` (and equivalents)
  from the manifest directory. The generated file is git-ignored or clearly
  marked generated; no story touches it.
- Update the boilerplate registry (`functions/shared/boilerplates/registry.ts`,
  `nextjs-base` and derived packs) and the DEV agent's story instructions so
  stories add a feature file, never wire the mount point.

### Known limit (carry into the story, do not try to solve)

The registry handles **additive** features (new route/component/entity) cleanly.
It does **nothing** for **cross-cutting** changes (shared-type edits, game-loop
refactors), which remain genuine conflicts — correctly operator-gated under Story
A. The line to hold: "additive by design, operator-gated for the rest." Do not
make the scaffold so rigid agents cannot do cross-cutting work.

### Open decisions

- **Registry shape** — directory-of-descriptor-files (recommended: additive, no
  shared file) vs. a single `registry.ts` with `registerFeature()` calls (still a
  shared file → still conflicts). Pick the directory model.
- **How far to push it** — start minimal (generate _only_ `page.tsx` from a
  render registry) and let Story C's telemetry show which _other_ files actually
  conflict before generalizing. Do not over-rigidify up front.
- **Greenfield-only vs. brownfield** — this changes the scaffold contract; decide
  whether it applies only to newly-scaffolded apps or gets retrofitted.

### Acceptance criteria

- No story hand-edits the generated wiring file (enforced — e.g. a DEV-agent
  guard or a CI check).
- A multi-story plan that previously collided on `page.tsx` produces **zero git
  conflicts** on it.

### Risk / size

Large; highest leverage. **Start the minimal version now** (F1 makes it urgent),
but gate the full generalization on Story C telemetry. When the conflict rate on
registry-covered files reaches ~zero, operator-resolve-only (A) becomes
operationally equivalent to full autonomy.

---

## Sequencing & the one coupling to remember

| Order                         | Story                                                   | Gate                                                      | Why this order                                                                   |
| ----------------------------- | ------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------------- |
| now                           | **B**                                                   | none                                                      | The real pacman-2 fix; A without B leaves the race live                          |
| now (parallel)                | **C**                                                   | none                                                      | Independent; produces the data that makes A durable and D-scoping evidence-based |
| now (minimal), then gated     | **D**                                                   | full generalization gated on C telemetry                  | Drives conflict rate → 0; minimal `page.tsx` codegen first                       |
| later, only if data justifies | Phase-2 MERGER agent                                    | C shows frequent conflicts on files D can't make additive | pinned model + temp 0, captured inputs, gated on **real tests**                  |
| later, only at scale          | speculative merge trains                                | builds slow enough OR one-plan-per-app lifted             | —                                                                                |
| later, own project            | distributed coordination (remote-as-truth, DDB/ref-CAS) | agents span machines                                      | B's "distributed seam" comment marks the entry point                             |

**The coupling:** "strengthen the gate to real tests" and "speculation is
optional" are **not** independent. Real test suites turn the ~7s gate into
multi-minute, which collapses the serialized-gate headroom and makes speculation
load-bearing. The 155s build tail-spikes are the early warning. If/when real
tests land, expect to need **bounded** speculation (depth 2–3) before unbounded
trains.

---

## Invariant (the target, unchanged)

> A branch readers/deployers/agents trust is **never** half-merged. It advances
> atomically to validated commits only, through **one gate per repo.**

Story B is the minimal implementation of this invariant. Story A keeps the one
model-dependent step **out** of that gate until the gate can validate it. Story D
removes most of what the gate has to defend against. The brainstorm's
writer / candidate / green-truth role separation (`agentic-integration-branching.md`
§5.2) stands as the north star; these stories are the safe path to it.
