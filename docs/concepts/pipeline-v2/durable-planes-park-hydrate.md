# Durable Planes — GitHub as truth, S3 as evidence, hosts as cache

> Status: PROPOSED 2026-06-12 (post dino1-ENOSPC, post hardlink-store).
> Companion: `multi-host-dispatch-readiness.md` (the v3 fleet layer — this doc
> supplies its missing storage half), `boilerplate-runtime-contract.md`.

## 0. The question this answers

"Is GitHub a real backup of the code? Can I delete the worktree — even the
whole project — when a plan is done, and pull it back when I want to work
again, so EC2 only becomes a working server when necessary?"

**Yes — that is exactly the right model, and ~90% of the machinery already
exists.** What's missing is one safety gate (verified push), one lifecycle
verb pair (Park / Wake), and an evidence archive for the things git can't
hold. This doc specifies all three.

## 1. What GitHub holds TODAY — audit of the push cadence

Every app has `github.com/futurator-repos/<appId>`. Three push points exist:

| Moment                   | What pushes                                | Guarantee                                      |
| ------------------------ | ------------------------------------------ | ---------------------------------------------- |
| per-story `compile-push` | `git push origin HEAD` (wip / plan branch) | **soft-fail** — `GIT_PUSH_WARN` + continue     |
| per-wave green advance   | `plan/<slug>` ref (wave-merge-runner)      | **non-blocking** — warn + continue             |
| deploy writeback         | FF `main` → push → delete plan branch      | part of delivery; skipped if deploy never runs |

So GitHub is a **near-real-time mirror with best-effort semantics**. The
code comments say it plainly: "the local ref is the source of truth today;
origin is a mirror." A network blip at the wrong moment means origin is
behind and _nothing stops you deleting the only copy_.

**The fix is not to harden every push** (soft-fail mid-plan is correct —
a flaky network must not stall a wave). The fix is a single **verified-push
gate at the moment of destruction**: before any Park/delete of EC2 state,
compare `git for-each-ref` (local bare repo) against `git ls-remote origin`.
Any local ref ahead of origin → refuse, list the unpushed refs, offer
one-click push. After the gate passes, deleting EC2 state loses nothing.

With that gate, **GitHub is a real backup of the code** — committed and
pushed code, which after a completed plan (merged + deployed) is all of it.

## 2. What GitHub can NEVER hold — and where it lives

| Artifact                                                          | Why not git                                                           | Durable home                                                        |
| ----------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------- |
| Plans / epics / stories / jobs / events / attention / reflections | operational rows, high churn                                          | **DynamoDB** (already durable — survives any EC2 death today)       |
| VQA + QA screenshots                                              | binary evidence, judged verdicts reference URLs                       | **S3** (`review-screenshots/`, qa-prepare uploads — already there)  |
| Mycelium knowledge graph (Memgraph)                               | a running DB                                                          | **S3 `knowledge-live/<appId>/`** (daemon s3-backup — already there) |
| Forensic timing JSON, QA report snapshots                         | generated from DDB on demand; events rows have TTL — history _decays_ | **S3 archive — MISSING, proposed §4**                               |
| node_modules, build caches, worktrees                             | reproducible from lockfile + git                                      | nowhere — **rebuilt on Wake**                                       |

Three planes, then:

1. **Code plane = GitHub.** Source, lockfiles, committed wave-VQA reports,
   `.context/` handoffs, `knowledge/` markdown, CLAUDE.md. Versioned, owns
   "what is the product."
2. **Evidence plane = DynamoDB + S3.** Owns "what happened while building
   it" — who/when/how, verdicts, screenshots, costs, graph snapshots.
   Queryable from the admin UI forever, independent of any host.
3. **Compute plane = hosts (EC2 / laptop / mac mini).** Bare-repo cache,
   worktrees, hardlink node_modules store, Memgraph instance, build caches.
   **100% reconstructible from planes 1+2 — therefore disposable.**

The dino1 disk crisis was planes bleeding together: the compute plane was
treated as precious, so nothing was ever deleted. Once plane 3 is formally
a cache, disk pressure becomes a non-event: park something.

## 3. Park / Wake — the app lifecycle verbs

An app is either **active** (hydrated on ≥1 host) or **parked** (exists only
as GitHub + S3 + DDB). EC2 "transforms into a working server when necessary"
— the user's phrase, and precisely the design.

### Park (operator button, or auto after N idle days)

Preconditions (enforced, in order):

1. No running/pending plan or party session for the app on this host.
2. **Verified-push gate** (§1): every local ref in `repos/<appId>.git`
   present-and-equal on origin. Refuse + list otherwise.
3. Fresh knowledge snapshot: trigger `s3-backup` for the app, confirm
   object landed.
4. (Optional, belt-and-suspenders) `git bundle create` →
   `s3://…/git-bundles/<appId>/<date>.bundle` — a GitHub-independent
   restore point. One file, ~MBs, cents.

Action: the **EC2-local subset of the existing app-delete cascade** —
`projects/<appId>`, `worktrees/<appId>`, `repos/<appId>.git`,
`.node_modules_store/<appId>`, transcripts/residue — _without_ touching
GitHub, S3, Secrets, or DDB. The cascade code (`cleanupAppArtifacts`)
already factors into per-step helpers; Park = a new entry point calling the
SSM steps only, plus `app.status = 'parked'` on the App row.

### Wake (operator button, or implicit on "Run plan" against a parked app)

1. `git clone --bare git@github:futurator-repos/<appId>` → `repos/<appId>.git`
   (the brownfield bootstrap path already does exactly this).
2. Checkout `projects/<appId>` from main; `npm ci` → store entry (the
   cross-app hardlink seeding makes this seconds when any same-boilerplate
   app is already hydrated; warm npm cache covers the rest).
3. Restore Memgraph from `knowledge-live/<appId>/` latest snapshot.
4. `app.status = 'active'`, host recorded.

Cost of a Wake: ~1–3 minutes worst case, seconds in the common case.
That's the price of an idle app costing **zero** disk.

### UI

App card gains a state chip (`active on <host>` / `parked`) + Park/Wake
actions. Parked apps keep their full plan history visible (it's all DDB+S3).

## 4. The S3 evidence archive (the missing piece)

Today the forensic JSON is generated on demand from DDB and downloaded by
hand; event rows carry TTLs; QA reports are recomputed live. History decays.
For "later: who created that and when, how was plan X going, statistics,
problems, investigations" — freeze the evidence at the moment it's complete:

**On plan completion (and on plan delete), the Lambda writes:**

```
s3://futurator-labs-archive/apps/<appId>/plans/<planId>/
  forensic.json          ← full timing forensic (slices, categories, narrative)
  qa-report.json         ← final QA report incl. gateVqa claims + verdicts
  attention.json         ← all attention items, resolved + open
  plan.json              ← plan + epics + stories snapshot (incl. costs)
  wave-reports/          ← the committed .context/wave-N-vqa-report.md copies
```

Screenshots stay where they are (`review-screenshots/`, QA uploads) — the
archived JSONs already carry their URLs. Knowledge snapshots become
**date-keyed** (`knowledge-live/<appId>/<date>/`) instead of overwrite-only,
so graph evolution is replayable ("how did the knowledge grow during plan X").

Lifecycle policy: Standard → IA at 30d → Glacier at 180d. At your volumes
this is cents per month, permanently.

A separate bucket (`futurator-labs-archive`), NOT `futurator-ai-website` —
the public-site bucket keeps its four scoped paths and its deploy-safety
rules untouched.

This archive is also what makes **deleting an app non-destructive to
history**: the app-delete cascade purges live S3 prefixes + DDB, but the
archive bucket retains the development record.

## 5. Multi-host, multi-plan, multi-app (ties into the v3 dispatcher doc)

`multi-host-dispatch-readiness.md` already settles the control plane: DDB
queue + host registry + claim/lease, caps per host, prefer-local/burst-EC2.
Park/Wake supplies the missing storage answer: **any host can hydrate any
app on demand from planes 1+2**, because no host ever holds unique state
once the verified-push gate exists. What this doc adds to that design:

- **Phase 1 — plan→host affinity (build first).** A plan is claimed by one
  host and runs there end-to-end (stories, gates, merges all local). Two
  plans of the _same app_ on two hosts is already safe at the git layer —
  both hydrate from GitHub, work on `plan/<slugA>` vs `plan/<slugB>`, and
  push through origin. The only cross-host serialization needed is the
  **integration lock** (today an in-process mutex in `integration-lock.mjs`)
  → becomes a DDB conditional-write lease keyed `lock#<appId>` with TTL.
  Merge-to-main (deploy writeback) takes the same lease, fetches origin
  first, FFs, pushes.
- **Phase 2 — cross-host story fan-out (only if a single wave outgrows one
  host).** Stories of one wave on different hosts requires wip branches to
  travel: `compile-push` already pushes `wip/<storyId>` to origin; the gate
  host `git fetch`es them before the candidate merge. The wave-merge runner
  needs one new step (fetch wip refs) — everything else is host-local
  already. Defer until proven necessary; plan-affinity parallelism across
  apps/plans will saturate capacity long before a single wave does.
- **Hardlink store is per-host** and that's correct: it's a cache. The
  cross-app seeding means a host's _second_ app of a boilerplate hydrates
  in seconds regardless.
- **Spot/ephemeral workers become safe**: a host dying mid-plan loses only
  in-flight (uncommitted) story work; the lease expires, the job re-queues,
  another host hydrates and the retry machinery (which already handles
  retries on the same host) resumes from the last pushed green.

## 6. EC2 limits — the budget after all of this

Per-host steady state: OS+infra ~8G, playwright+npm caches ~2.4G, then
**~700M per unique lockfile + ~50M per active app**. A 19G host comfortably
runs 3–5 active apps; everything else is parked at zero cost. Scaling is
horizontal (add a worker, even spot) — never "bigger disk."

## 7. Build order (MVP-first)

| #   | Deliverable                                                                                                | Size | Unblocks                                        |
| --- | ---------------------------------------------------------------------------------------------------------- | ---- | ----------------------------------------------- |
| M1  | Verified-push gate + **Park/Wake** (Lambda steps from the existing cascade helpers + App status + UI chip) | S–M  | EC2-as-cache today; safe manual disk control    |
| M2  | **S3 evidence archive** on plan completion/delete + date-keyed knowledge snapshots + lifecycle policy      | S    | permanent dev history, app-delete loses nothing |
| M3  | DDB **integration lease** + job claim/lease + host registry (the "build now" list in the v3 doc §4)        | M    | plan→host affinity; second host                 |
| M4  | Cross-host wip fetch in wave-merge                                                                         | S    | story-level fan-out (defer until needed)        |

M1+M2 are independent of the fleet work and pay off immediately on the
single host. M3 is where the second machine joins. M4 only when a single
wave is bigger than a host.
