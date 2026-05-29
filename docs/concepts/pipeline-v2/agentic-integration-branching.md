# Agentic Integration & Branching — Design Brainstorm

> **Status:** Discussion draft for a dedicated brainstorming session.
> **Author:** drafted with Claude (Opus 4.7), 2026-05-28, after the pacman-2
> wave-merge wedge.
> **Purpose:** Frame the branching/integration problem for autonomous,
> multi-agent, multi-machine development; record the current logic, the
> concrete failure we just hit, the future we're building toward, and an
> opinionated proposed solution — so we can debate it, not so it's decided.

---

## 0. TL;DR

We currently treat one branch (`plan/<slug>`) as **both** the scratchpad that
agents merge into **and** the truth that everyone reads. That conflation is the
root of the pacman-2 wedge and will get exponentially worse as we add agents,
machines, and concurrent readers (debates, planning, deploys).

The proposed fix is a single, well-understood invariant:

> **A branch that anyone trusts is NEVER in a half-merged state. It advances
> atomically, one validated commit at a time, through exactly one gate per
> repository.**

That invariant is the "Not Rocket Science Rule of Software Engineering"
(Graydon Hoare): _automatically maintain a branch that always builds and passes
its tests._ The mechanism is a **merge queue** feeding an **always-green
trunk**. Everything else in this doc is layering and sequencing on top of that
one idea.

This document is intentionally opinionated to give the brainstorm something to
push against. Nothing here is final.

---

## 1. The dilemma in one sentence

**Git represents a branch as a single linear pointer, and a worktree can check
out only one branch — but autonomous agents are inherently concurrent writers
_and_ concurrent readers of the same logical line of code.**

Reconciling "many concurrent actors" with "one linear pointer" forces a choice:

1. **Serialize** — put a lock/queue in front of the shared branch, or
2. **Isolate** — give each actor its own branch and define an explicit
   integration/reconciliation step.

Every real-world system that has solved this (Bors, GitHub Merge Queue, Zuul,
GitLab Merge Trains, Google/Meta submit queues) ends up doing **both**: isolate
while working, then integrate through a serialized-but-pipelined gate. The
question for us is not _whether_ to adopt that shape, but _how_ to adopt it in a
way that fits our serverless, multi-machine, model-improving future.

---

## 2. Current logic (what we have today)

### 2.1 Object store & worktree topology

- **One bare repo per app:** `/home/ubuntu/repos/<app>.git` — the shared object
  store across all agent classes (pipeline, party, free-agent).
- **Worktrees** live under `/home/ubuntu/worktrees/<app>/<plan>/`:
  - **Per-story:** `<storyId>/` checked out on `wip/<storyId>`.
  - **Coordinator:** `_merge/` checked out on `plan/<slug>`.
  - **Party:** `_party/`.
  - **Free-agent:** `_assist/<sidShort>/` on `assist/<projectId>/<sidShort>`.

### 2.2 Branch roles

| Branch          | Created by              | Purpose                                                                        |
| --------------- | ----------------------- | ------------------------------------------------------------------------------ |
| `main`          | template/scaffold       | base everything forks from                                                     |
| `wip/<storyId>` | per-story dev           | one story's work, isolated                                                     |
| `plan/<slug>`   | wave-merge (first wave) | **single accumulator** for the whole plan; pushed to GitHub; what deploy reads |

### 2.3 The wave-merge sequence (`daemon/lib/wave-merge-runner.mjs`)

When all stories in a wave reach terminal-success, a `wave-merge` job runs:

1. **`setupCoordinatorWorktree`** — materializes `_merge/` on `plan/<slug>`.
   Creates `plan/<slug>` from `main` on the first wave; **reuses** the existing
   `_merge` worktree if it's already on `plan/<slug>` (just `git fetch origin`).
2. **Sequential `--no-ff` merges** of each `wip/<storyId>` into `plan/<slug>`,
   in deterministic storyId order.
3. **Halt on conflict** (current behavior): if a `git merge` reports a
   conflict, the merge aborts (`git merge --abort`), the wave halts, and a
   `wave-merge-conflict` attention item is written for operator resolution.
   (An LLM-backed self-heal resolver was added 2026-05-28 in `3fa8713` and
   **rolled back 2026-05-29** — see `worktree-rollout-design.md §2`; the
   compile-only gate could not validate a non-deterministic resolution and
   it landed silently. Auto-resolution returns only with telemetry + a
   real-test-gated Phase-2 MERGER agent.)
4. **Post-merge build gate** — materializes `node_modules`, runs the
   boilerplate's `postMergeValidationCmd` (e.g. `next build` / `npm test`) inside
   `_merge/`. Non-zero (and not a no-op test) → `wave-build-failed`.
5. **Push** `plan/<slug>` to origin; **tear down** per-story worktrees + local
   `wip/*` branches.

### 2.4 The epic/plan reducers

- **wave-reducer** (epic-level): when a wave's stories all succeed → trigger
  wave-merge; on `wave-build-failed`/story-failure → set **epic → `fixing`** and
  halt (no auto-retry).
- **plan-reducer** (plan-level): if any epic is `fixing` → plan → `fixing`. Plan
  advances plan-wave N+1 only when all plan-wave N epics are `completed`.
  (2026-05-28: added a stale-`fixing` → `developing` reset at the plan level.)

### 2.5 The structural weakness

`plan/<slug>` is **simultaneously**:

- the **integration scratchpad** that wave-merge jobs mutate, and
- the **published truth** (pushed to GitHub, read by deploy).

And the `_merge` worktree is keyed by `(appId, planSlug)` — **one shared
directory + one shared branch for the entire plan**, reused across every epic's
wave-merge job. There is **no serialization** between concurrent wave-merge
jobs. With concurrency ≥ 2, two epics in the same plan-wave can be merging into
the same branch in the same directory at the same time.

---

## 3. The problem we hit (pacman-2, 2026-05-28)

### 3.1 Symptoms

- Plan `plan_pacman-2_mppnl7lv`, 9/12 stories done, stuck "developing —
  recovering".
- **E2 (Rendering)** marked `fixing` despite all 3 of its stories `done` (3/3).
- **E4 (Assembly)** stuck `draft` — it depends on E2 + E3, and E2 never reached
  `completed`.
- **0 jobs** PENDING/RUNNING/CLAIMED. Permanently wedged, no human-free path
  forward.

### 3.2 Root cause — a shared-worktree race

E2 (Rendering) and E3 (Game Logic) both depend only on E1, so they're in the
**same plan-wave** and ran in parallel (concurrency = 2). Their wave-merge jobs
both targeted the **same** `_merge` worktree on the **same** `plan/pacman-2-initial`
branch:

```
1e55762 merge story 4e397c89  ← E3 scoring
d810e3c merge story f063d3d7  ← E3 ghost AI
aec93aa merge story 3e2f1d74  ← E3 collision
323e1f7 merge story 0fadcc49  ← E3 movement
237b514 merge story c68176ec  ← E2 render
b43cabe merge story 87b860b0  ← E2 render
306a852 merge story 1503f640  ← E2 render
```

All seven story merges from **both epics** are interleaved on one branch.

Timeline (from the daemon log):

- **16:13:06–16:13:24** — E2's job merged its 3 render stories into
  `plan/pacman-2-initial`. All touch `src/app/page.tsx`.
- **16:14:51** — E3's job merged game-logic stories (`GameCanvas`,
  `useGameLoop`, `movePacman`) into the **same branch/worktree**, leaving a
  `<<<<<<< HEAD` marker in `page.tsx`.
- **16:15:06** — E2's post-merge `next build` ran against that now-contaminated
  tree → `Type error: Merge conflict marker encountered` → `wave-build-failed`
  → **E2 → `fixing`**.
- E3's subsequent merges resolved/overwrote `page.tsx` (HEAD ended up clean →
  E3 → `completed`), but E2's build job had already failed and **nothing
  re-runs it**.

### 3.3 Why the self-heal resolver didn't save us

The outcome was `wave-build-failed`, **not** `merge-conflict`. Git never
reported a conflict _during_ either job's merges — each job's `--no-ff` merges
applied cleanly _in isolation_. The conflict markers entered because **two
independent jobs mutated the same branch/tree concurrently**, and the marker was
only caught later, at the build gate, against a tree a _sibling job_ had
modified. The resolver only fires on a git-level merge conflict, which never
happened within a single job's view.

### 3.4 The key lesson

The integrated code was actually **fine** afterward (clean `page.tsx`, all 7
merges present). This was **not corrupted code** — it was a **state-machine +
isolation failure**: a transient build error, caused by a race, that left an
epic permanently parked in `fixing` with no recovery path. The damage is the
_wedge_, not the _bytes_. An autonomous system must make this class of wedge
**structurally impossible**, because there is no human in the loop to unstick it.

---

## 4. The future we're designing for

This is the important part: the fix must be chosen for where we're going, not
just for one EC2 box.

1. **A dispatching system: 10+ agents across many servers _and_ local
   computers**, all working autonomously in the pipeline simultaneously.
2. **Multiple concurrent projects/apps** — the operator may run several apps at
   once, plus the pipeline.
3. **Debates / Q&A / document generation** that want the **latest minute-to-
   minute real code** to reason against.
4. **Planning conversations** that initiate against the **latest status** of the
   repo, even while features are mid-deploy.
5. **Deploys happening continuously**, which must always ship something
   buildable.
6. **Models keep improving** (planning + coding), and **won't be Claude-only**
   forever (Claude for now).

Implications:

- The local filesystem **cannot** be the coordination plane — actors live on
  different machines. Coordination must use substrates reachable from anywhere
  (a central git remote + an API/DB).
- "Latest code" for readers must mean **latest _coherent, buildable_ code**, not
  "whatever a branch happens to contain mid-merge." A broken latest is useless
  to a debate or a deploy.
- The one model-dependent step (semantic conflict resolution) must be isolated
  behind a validated gate and a swappable interface, so improving/alternative
  models are a drop-in upgrade, never a rewrite.
- Throughput matters: a naive global lock that serializes 10 agents' builds
  end-to-end will not scale.

---

## 5. The proposed solution

### 5.1 The invariant (restated)

> A branch readers/deployers/agents trust is **never** half-merged. It advances
> atomically to validated commits only, through **one gate per repo**.

### 5.2 Three branch _roles_, never conflated

| Role            | Branch                       | Mutability                         | Who reads it       |
| --------------- | ---------------------------- | ---------------------------------- | ------------------ |
| **Writer**      | `wip/<storyId>`              | append-only, then frozen           | only its own agent |
| **Candidate**   | ephemeral, content-addressed | disposable                         | the gate only      |
| **Green truth** | `plan/<slug>`, then `main`   | advances only to validated commits | **everyone**       |

Merges happen in **throwaway candidate worktrees**. The green branch only ever
receives an **atomic pointer-advance to an already-built commit**. A crash can
never leave green half-merged.

### 5.3 The five components

**1) The merge queue (the gate).**
Completed `wip/*` branches enter an ordered, per-repo queue. The gate pops a
candidate, merges it onto the _current green tip_ in a fresh ephemeral worktree,
resolves conflicts, runs the build/test gate, and **only on green** advances the
trunk via an atomic compare-and-swap (`set green = candidateSHA if green ==
expectedParent`). If green moved underneath, the candidate is re-merged onto the
new tip and re-tested. (Bors / GitHub Merge Queue / Zuul.)

**2) Speculative parallelism (scale layer — not MVP).**
A serialized gate with one worker is _correct_ but throughput-bound when many
agents finish at once and each build takes minutes. The fix is a **merge train**:
test candidate _N_ speculatively assuming 1..*N*−1 land, all in parallel across
machines; if an early one fails, rebuild the tail. (GitLab Merge Trains / Zuul
speculative execution.) **This is a drop-in optimization of (1) — same contract,
more workers — so the MVP is not throwaway.**

**3) LLM conflict resolution as a _validated, pluggable_ step — never trusted
blind.**
On conflict, an LLM emits the integrated file; the build/test gate is the
always-on backstop — a bad resolution simply fails and the candidate is
rejected, never landed. This is the right place to bet on improving models:
quality rises automatically and the interface is model-agnostic ("given base +
two diffs, emit a file that compiles"). Our existing `resolveConflict` hook is
already this shape; it just needs to run **inside the queue**, not inside a
racing per-job merge.

**4) Distribution-ready coordination.**
Two sources of truth, both reachable from any machine:

- **Objects + refs → the central remote** (GitHub today, or self-hosted git).
  Local bare repos become _caches_, not truth. (Flips today's model where EC2's
  bare repo is truth.)
- **Queue + lock → the API/DB** (we already have DynamoDB). The "advance green"
  CAS is a conditional write — _or_, more elegantly, **git's own atomic ref
  update as the distributed lock** (`push --force-with-lease`, expected old
  value); no separate lock service, no added cost.
- **Workers are stateless and location-independent.** Any node claims a
  candidate (leased + heartbeated — we already have the reaper), fetches the
  needed SHAs, builds locally, pushes candidate _objects_ (not the green ref),
  and reports a verdict. Only the gate flips the ref. A candidate is a pure
  function of `(greenSHA, [wipSHAs])` — fully reproducible, so a crashed
  worker's candidate is simply re-claimed.
- **Zero-cost-friendly:** the "controller" is a _logical role_ — a DDB queue + a
  Lambda/daemon tick + the workers we already run. No always-on integration
  server, no Fargate.

**5) The reader contract (debates, planning, deploys).**
They read **green** = the latest _trustworthy_ checkout. For long sessions,
snapshot the green SHA at session start (stable reasoning), with an explicit
**"sync to latest green"** action. Deploys build from green → never ship a
half-merge again.

### 5.4 Highest-leverage lever: stop _generating_ conflicts

No integration system makes conflicts free — it makes them _safe_. Throughput is
inversely proportional to conflict rate, so attack the rate at its source.
Ranked by leverage:

1. **Make integration points additive, not edited.** The recurring villain is
   that _every_ story edits the single wiring file (`src/app/page.tsx`). Scaffold
   apps so features **register themselves** (a registry/manifest modules append
   to) and the wiring file is **generated** from that registry post-merge. No
   story hand-edits the hot file → the single biggest conflict source vanishes.
2. **`.gitattributes merge=union`** for unavoidable barrel/manifest/registry
   files — git auto-concatenates both sides instead of conflicting. Near-free.
3. **Planner file-ownership hints (soft):** when the planner _can_ avoid
   scheduling two same-file stories in one wave, it should. A soft constraint,
   never a parallelism cap.
4. **Prefer many small additive commits, integrated continuously, over big-bang
   wave merges.** Treat **waves as ordering hints to the queue, not as the
   integration unit** — decoupling integration mechanics from the (evolving)
   planning model.

Do #1 and #2 and the conflict rate on a Pac-Man-sized app likely approaches
zero, at which point the gate mostly fast-forwards green and parallelism runs
wide open.

### 5.5 Why this satisfies each future requirement

| Future need (§4)              | How the design serves it                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 10+ agents, many machines     | Writers fully parallel; integration is a pipelined queue + speculative parallel testing; the only serialized op is a millisecond ref-CAS. |
| Concurrent projects           | Each repo has its own green trunk + queue; already isolated by separate bare repos.                                                       |
| Debates on live code          | Read green = latest coherent buildable state, with session pinning + sync.                                                                |
| Planning on latest status     | Same green contract — reasoning always starts from a known-good snapshot.                                                                 |
| Continuous deploys            | Deploy from green — guaranteed buildable.                                                                                                 |
| Improving / non-Claude models | The only model-dependent step is isolated behind a validated gate + swappable interface.                                                  |

### 5.6 How it would have prevented pacman-2

E2 and E3 each become a candidate. The queue lands E2 → green advances (now
contains E2's `page.tsx`). E3's candidate was built on _old_ green, so the gate
detects it is stale, re-merges onto the new green → git raises a **real**
conflict on `page.tsx` → `resolveConflict` fires → resolves → builds → lands. No
silent marker committed across racing jobs, no build failure against a tree a
sibling mutated, no permanent `fixing` wedge. **The failure mode cannot occur
because no two writers ever share a mutable destination.**

---

## 6. Incremental path (MVP → north star, no rework)

Because a serialized queue _is_ a merge queue, the contract is built once and
scaled later:

- **Now (small, correct, ships today):**
  1. One **integration lock per app** — the gate never runs two merges into the
     same green concurrently.
  2. Merges happen in an **ephemeral per-candidate worktree**, not the shared
     `_merge`.
  3. `plan/<slug>` advances **only on green**.
  4. `.gitattributes merge=union` for manifest/barrel files.
  - This alone closes the race and makes the existing self-heal resolver
    actually fire (conflicts now surface at git-merge time).
- **Next:** 5. Generated/registry integration points (kills hot-file conflicts). 6. Waves become queue **ordering hints**, not the integration unit.
- **Later (multi-machine):** 7. Flip object-truth to the central remote. 8. Move queue/lock to DDB + ref-CAS. 9. Add speculative-train workers.
  - Same contract throughout — no rewrite.

---

## 7. Open questions for the brainstorm

These are deliberately unresolved — they're what the session is for.

1. **Green-trunk identity.** Is the eternal green trunk `main`, with `plan/<slug>`
   as a _per-plan_ green line that fast-forwards to `main` on plan approval
   (two-level always-green)? Or do we collapse to a single green line and treat a
   "plan" as just a label/PR over a range of green commits?
2. **Lock granularity.** Per-repo (simplest, matches "one green per repo") vs.
   per-plan vs. per-file-set. Does per-repo serialization bottleneck when one app
   has many concurrent plans?
3. **Speculation depth & cost.** How deep a merge train before the rebuild-on-
   failure cost outweighs throughput? Is speculation worth it at our scale, or is
   a single fast gate enough for a long time?
4. **Conflict-resolution authority.** Should resolution always be gated purely by
   build/test, or do we also want a reviewer-agent sign-off for _semantic_
   correctness (the code compiles but is wrong)? How do improving models change
   that answer?
5. **Reader staleness contract.** For debates/planning: pin-at-session-start +
   manual sync, or live-follow green? What's the UX when green moves mid-debate?
6. **Remote as source of truth.** Cost/latency of making the central remote the
   object truth for every worker fetch/push — do we need regional mirrors or a
   self-hosted git for the laptop fleet?
7. **Cross-app / monorepo futures.** If multiple apps ever share code, does the
   per-repo green model still hold, or do we need a higher-level integration
   plane?
8. **Conflict-reduction vs. agent freedom.** How hard do we push the
   registry/generated-integration scaffold before it constrains what agents can
   build? Where's the line between "additive by design" and "too rigid"?
9. **Backpressure & fairness.** When 10 agents finish at once, how does the queue
   prioritize (FIFO? dependency-order? plan priority?) and avoid starving a slow
   plan?
10. **Observability.** What does the operator watch — queue depth, green age,
    candidate pass-rate, resolution-success-rate — to trust the system is
    healthy without reading logs?

---

## 8. Appendix — glossary

- **Always-green trunk:** a branch guaranteed to build and pass tests at every
  commit, because it only advances through a validating gate.
- **Merge queue / gate:** the single serialization point that validates and
  lands candidates onto green.
- **Candidate:** an ephemeral, content-addressed merge result `(greenSHA +
[wipSHAs])` awaiting validation.
- **Merge train / speculative execution:** testing queued candidates in parallel
  by assuming earlier ones will land; rebuild the tail if one fails.
- **Ref-CAS:** compare-and-swap on a git ref (`--force-with-lease` / expected
  old value) used as a distributed lock for the atomic green advance.
- **Not Rocket Science Rule:** "automatically maintain a branch that always
  passes all the tests" (Graydon Hoare) — the principle behind merge queues.
