# Multi-Host Dispatch Readiness — lessons → what must change

Status: **ANALYSIS / FORWARD-LOOKING (2026-06-03)**
Goal: dispatch Claude Code terminals across **many EC2 hosts + local machines**,
not just the single EC2 daemon.
Related: `claude-code-dispatch-findings.md` (Claude-cloud vs EC2 _cost/ToS_ — a
different question; concluded "stay on Max, make EC2 elastic"). This doc is about
**horizontally scaling the _execution substrate_** (the worktrees + agent runs),
which the cost doc didn't cover.

---

## 1. The one root cause behind every bug this cycle

Every failure we debugged — boilerplate scaffold shipped instead of the game,
empty commits, no VQA screenshots, reaper destroying live work, plan-create
blocked — was a different face of **one** thing:

> **The pipeline encodes implicit, single-machine assumptions as shared, mutable,
> host-local filesystem state — and trusts periodic scans of that state.**

That model is _fragile even on one box_ (it's why these bugs happened). On
many boxes it becomes _incorrect by construction_. So the multi-host work isn't
a new feature bolted on — it's the same hardening, finished properly. The bugs
were early warnings.

Concrete examples of the pattern, and why each breaks across hosts:

| Single-host assumption (caused a bug)                                                    | Why it's fatal multi-host                                                                                        |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `node_modules` **symlink** into a host-local dedup store                                 | a symlink can't cross machines; host B can't see host A's store                                                  |
| bare repo + worktrees on **one local filesystem**                                        | host B literally cannot `cd` into host A's worktree                                                              |
| the **reaper scans local dirs** + reaped an _active_ worktree on a transient lookup miss | host A's reaper must NEVER touch host B's worktrees; cross-host it'd delete live work it can't even see is alive |
| `projects/<appId>` is the **one** trunk; QA/deploy assume it's "here"                    | which host's trunk? two hosts diverge instantly                                                                  |
| `main` fast-forward + push assumes **one canonical local main**                          | concurrent hosts racing `main` = lost updates                                                                    |
| daemon = **one** poller of the jobs table                                                | N hosts polling the same table double-claim jobs                                                                 |
| OAuth token synced Mac→**this** EC2; SSH allowlist = **one** IP                          | every host needs its own auth + reachability                                                                     |

---

## 2. Principles to adopt now (cheap insurance, pay off at multi-host)

1. **No silent shared mutable state. Make ownership explicit.**
   Every worktree/branch/store-entry must record _which host owns it_ and
   _which job/lease is live_. The reaper bug is the canonical lesson: cleanup
   must be **owner-aware and lease-aware**, never "scan + guess." (We already
   added the freshness guard — the durable version is an explicit lease/heartbeat
   per worktree.)

2. **State is either host-partitioned or content-addressed — never "the host's."**
   - _Partitioned:_ each host has its **own** bare repo clone + worktrees +
     node_modules store, keyed by host. Hosts sync through a shared truth
     (origin / S3), never each other's disks. (We're already most of the way:
     origin is the sync point; the delivery push we added makes `main` the
     shared truth.)
   - _Content-addressed:_ the node_modules store is already keyed by lockfile
     SHA — that's content-addressing. Per-host stores with the same SHA are
     independent + correct. (And per the boilerplate contract, materialize
     **real** dirs — symlinks are inherently host-local.)

3. **The job row carries its full execution context.**
   A job must say _where_ it runs (hostId), _what_ worktree, and _how_ to
   provision/boot/build the app — the last of which is the **boilerplate
   runtime contract** (`boilerplate-runtime-contract.md`). A remote/local
   worker must be able to run a job with **zero tribal knowledge of the
   dispatching host.** Today the deploy agent "rediscovers" the app shape; a
   second host can't rely on that.

4. **Dispatch = lease, not poll-and-pray.**
   Replace "the daemon polls PENDING jobs" with a **claim/lease**: a worker
   atomically claims a job (conditional DDB write on `claimedBy`/`leaseExpiry`),
   heartbeats while running, and the lease auto-expires so a dead host's job is
   re-dispatchable. This is also the _correct_ fix for the reaper class of bug:
   a worktree is reapable **iff its lease is expired**, never on a scan miss.

5. **Idempotent, crash-safe, resumable steps.**
   If host A dies mid-story, host B must be able to take over (or cleanly
   restart) without corrupting `plan/<slug>`. The wave-merge already advances
   `plan/<slug>` atomically via `update-ref` off detached candidates — that
   design is exactly right and should be the template: **never leave shared
   refs half-written; advance atomically at green.**

---

## 3. The dispatcher shape (target)

```
┌── Control plane (DDB, today) ──────────────────────────────┐
│  jobs: + hostId, claimedBy, leaseExpiry, heartbeatAt        │
│  hosts: { hostId, kind: ec2|local, capacity, lastSeenAt }   │
└────────────────────────────────────────────────────────────┘
        ▲ claim (conditional write)      ▲ heartbeat
        │                                │
  ┌─────┴─────┐  ┌───────────┐    ┌──────┴──────┐
  │ EC2 host1 │  │ EC2 host2 │    │ local laptop│   ← each: own bare repos,
  │  daemon   │  │  daemon   │    │   daemon    │     worktrees, node_modules
  └───────────┘  └───────────┘    └─────────────┘     store, Max OAuth token
        │ push main + per-story branches
        ▼
   origin (GitHub) + S3 (knowledge, deploys, screenshots)  ← the shared truth
```

- **Scheduling:** plan-waves / story-waves already define parallelism; the
  dispatcher just assigns each ready job to a host with free capacity (respect
  the per-app **integration lock** so two hosts don't merge the same plan
  branch concurrently — we built that lock; it becomes cross-host critical).
- **Affinity:** stories of one plan ideally land on one host (shared bare repo
  - warm node_modules store) — but any host _can_ run any job because the
    boilerplate contract + origin sync make a worktree reconstructible anywhere.
- **Local machines:** identical daemon; the only deltas are auth (its own Max
  token) and reachability (it polls/claims DDB outbound — no inbound SSH needed,
  which sidesteps the IP-allowlist pain we hit repeatedly this session).

---

## 4. What to prepare _now_ (low cost, unblocks later)

1. **Land the boilerplate runtime contract** — prerequisite #1. Without it no
   remote/local host can provision+boot+build an app deterministically.
2. **Add `hostId` to jobs + worktree metadata** (even with one host today) —
   start recording ownership so the reaper/cleanup is owner-scoped from the
   start. Cheap now; mandatory later.
3. **Convert dispatch to claim-lease + heartbeat** — the single most valuable
   change: it fixes the reaper-reaps-active-work bug _properly_ (lease, not
   freshness heuristic), AND is the exact primitive multi-host needs.
4. **Make cleanup lease-driven, not scan-driven** — a worktree is reaped iff its
   lease expired + job terminal. Drop the hourly "scan + guess" to a daily
   backstop (per the reaper discussion).
5. **Keep origin + S3 as the only cross-host truth** — never assume a sibling
   host's disk. The delivery `push main` we added is the first brick.

---

## 5. Honest assessment

We are **closer than it looks** because the painful single-host hardening this
cycle (atomic plan-branch advance, content-addressed node_modules store, integration
lock, delivery push, appId-keyed deploy) are all _also_ the multi-host primitives.
The missing pieces are: **(a) the boilerplate contract** (so a job is
self-describing), **(b) claim-lease dispatch + heartbeat** (so hosts don't
collide and dead work is recoverable), and **(c) owner/lease-scoped cleanup**
(so a host never reaps what it doesn't own — the most dangerous failure mode at
scale). Do those three and "many EC2 + local machines" is a scheduling layer on
top, not a rewrite.
