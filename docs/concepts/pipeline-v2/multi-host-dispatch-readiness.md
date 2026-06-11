# Multi-Host Dispatch — the Pipeline v3 dispatcher

Status: **DESIGN / FORWARD-LOOKING (2026-06-03)**
Goal: a **dispatcher** that sends agent jobs to a queue and runs them across a
**fleet of heterogeneous, capped hosts** — many EC2 instances _and_ connected
local machines (laptop, mac mini) — so multiple plans across multiple apps (plus
debates, free-agent, fixes) run in parallel without ever compromising
worktree/branch/merge correctness.

Related:

- `boilerplate-runtime-contract.md` — the per-app runtime contract. **Prerequisite #1**:
  a job can only run on an arbitrary host if it carries how to install/boot/build itself.
- `claude-code-dispatch-findings.md` — Claude-cloud vs EC2 on _cost/ToS_; concluded
  "stay on Max, make EC2 elastic." This doc reuses that conclusion: in the v3
  dispatcher, **EC2 is burst/overflow capacity** and free local machines are preferred.

---

## 0. What "v3 dispatcher" means (the target picture)

Today: one EC2 daemon polls the jobs table and runs everything itself.

v3: a job is placed on a **queue**. A **fleet of hosts** — each with its own
daemon, its own bare repos + worktrees + node_modules store, its own auth token —
**claims** jobs from that queue up to its **capacity cap**. The queue + the host
registry + the leases live in DynamoDB; the **only cross-host source of truth for
code is `origin` (GitHub) + S3**. No host ever reads another host's disk.

```
                  ┌──────────────── Control plane (DynamoDB) ───────────────┐
                  │ jobs:  + hostId, claimedBy, leaseExpiry, heartbeatAt     │
                  │ hosts: { hostId, kind: ec2|local, capacity, lastSeenAt } │
                  └─────────────────────────────────────────────────────────┘
                        ▲ claim (conditional write)        ▲ heartbeat
                        │                                  │
   ┌───────────┐  ┌───────────┐   ┌───────────┐   ┌──────────────┐
   │ EC2 host  │  │ EC2 host  │   │  laptop   │   │  mac mini    │  ← each host:
   │ cap = 2   │  │ cap = 2   │   │  cap = 4  │   │  cap = 4     │    own bare repos,
   │ (burst)   │  │ (burst)   │   │ (preferred)│  │ (preferred)  │    worktrees,
   └───────────┘  └───────────┘   └───────────┘   └──────────────┘    node_modules,
                        │ push main + per-story branches                  Max token
                        ▼
        origin (GitHub) + S3 (knowledge, deploys, screenshots)  ← THE shared truth
```

**Sequencing decision (2026-06-03):** the cheap _safety primitives_ land **now**,
during v2 hardening, because they also fix today's single-host bugs. The _fleet
scheduler_ (host registry, local-machine onboarding, host selection, caps) is the
**v3 layer on top**. See §4.

---

## 1. The one root cause behind every bug this cycle

Every failure we debugged — boilerplate scaffold shipped instead of the game,
empty commits, no VQA screenshots, reaper destroying live work, plan-create
blocked — was a different face of **one** thing:

> **The pipeline encodes implicit, single-machine assumptions as shared, mutable,
> host-local filesystem state — and trusts periodic scans of that state.**

That model is _fragile even on one box_ (it's why these bugs happened). On many
boxes it becomes _incorrect by construction_. So the dispatcher work isn't a new
feature bolted on — it's the same hardening, finished properly. The bugs were
early warnings.

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

## 2. The invariants that make worktrees/branches/merges 100% autonomous

This is the part you care about most. Five invariants; hold all five and the
fleet cannot corrupt a plan, no matter how many hosts run how many plans at once.

1. **Origin is the only truth. A local worktree is disposable.**
   Nothing is "done" until it is pushed to `origin`. A host that dies, sleeps, or
   is reaped loses _only_ uncommitted local state — which must be small because
   steps commit+push frequently. The merge host fetches branches from `origin`,
   never from a sibling host's disk. This single rule is what makes "any host can
   run any job" true.

2. **Ownership is explicit; cleanup is lease-aware, never scan-and-guess.**
   Every worktree / branch / store entry records _which host owns it_ and _which
   lease is live_. A worktree is reapable **iff its lease has expired AND its job
   is terminal** — never on a directory-scan miss. (The reaper-reaps-live-work bug
   is the canonical lesson; the freshness guard was a band-aid, the lease is the
   cure.) A host **never** touches a worktree it does not own.

3. **State is host-partitioned or content-addressed — never "the host's."**
   - _Partitioned:_ each host has its **own** bare repo clone + worktrees +
     node_modules store, keyed by host. Hosts sync through `origin`/S3, never each
     other's disks.
   - _Content-addressed:_ the node_modules store is keyed by lockfile SHA. Per-host
     stores with the same SHA are independent and correct. (Materialize **real**
     dirs per the boilerplate contract — symlinks are inherently host-local.)

4. **Shared refs advance atomically, by compare-and-swap, with git as the lock.**
   The cross-host integration lock **is git itself**: `git update-ref <branch>
<new> <old>` / `push --force-with-lease`. Advance `plan/<slug>` (and `main`)
   only if the ref is still where we forked from; otherwise re-fork and retry.
   Git is the source of truth, so the lock can never drift from repo reality — no
   separate DDB lock to keep consistent with git. `wave-merge-runner.mjs` already
   does exactly this off detached candidates; that design is the template for all
   shared-ref writes.

5. **Fencing on resume.** A host that comes back from sleep/disconnect must
   re-validate its leases _before_ touching any shared ref or worktree. If a lease
   expired while it was away, the job was already re-dispatched — it abandons the
   stale worktree and does not push. (Prevents split-brain: a woken laptop must
   never stomp work another host took over.)

---

## 3. The dispatcher (v3 fleet layer)

### 3.1 Host registry + heartbeat

Each host's daemon **self-registers** on startup into a `hosts` row
(`{ hostId, kind: ec2|local, capacity, lastSeenAt }`) and heartbeats `lastSeenAt`
on a timer. A host whose `lastSeenAt` lapses is considered **offline**: it claims
no new jobs, and any job it held becomes re-dispatchable once its per-job lease
expires (§2.2/§2.5).

- **Join:** start the daemon on the machine; it registers and begins claiming.
- **Leave (laptop lid close, etc.):** heartbeat lapses → offline; in-flight jobs
  re-dispatch by lease expiry. No inbound connection to the host is ever required.

### 3.2 Capacity caps — flat agent count per host

Each host declares a flat **`capacity`** = max concurrent agents
(e.g. `ec2 = 2`, `laptop = 4`, `mac-mini = 4`). The host claims jobs only while
`activeCount < capacity`. This is the **unified** count: pipeline stories _and_
interactive jobs (party, free-agent, fixes) draw from the same per-host budget,
because they share the same RAM — extending the single-host unified-queue
decision (`concurrency-manager.mjs`) to per-host across the fleet.

> **Per-host caps protect RAM/CPU — they do _not_ scale LLM throughput.**
> Verified 2026-06-03 (§6.1): the Max usage budget is a **single account-wide
> pool shared across every host, every `claude` session, and claude.ai itself.**
> Adding machines buys more _parallel physical execution surface_ (more worktrees
> building/booting/screenshotting at once) but the **agent-call throughput hits
> the same Max ceiling regardless of host count.** So the dispatcher needs a
> **global budget guard** on top of per-host caps — otherwise more hosts just hit
> the rolling-5hr / weekly rate-limit wall _sooner_. Treat the global Max budget
> as the fleet's true scarce resource; per-host caps only keep each box from OOM.

> Caps are set **conservatively by hand** for now. On a local machine you also
> use as a workstation, pick a number that leaves the box usable while you work.
> _Adaptive foreground backoff_ and _weight-classed capacity_ (heavy VQA/Turbopack
> boots costing more than a reflector/doc step) are deliberate **deferred
> refinements** — add them only if a flat count proves too blunt (see §6).

### 3.3 Dispatch = claim/lease, not poll-and-pray

Replace "the daemon polls PENDING jobs and runs them" with a **claim**: a worker
atomically claims a ready job via a conditional DDB write on
`claimedBy`/`leaseExpiry`, heartbeats while running, and the lease auto-expires so
a dead/asleep host's job is re-dispatchable. This simultaneously (a) stops N hosts
double-claiming, and (b) is the _correct_ fix for the reaper class of bug.

### 3.4 Host selection — prefer local, burst to EC2

The plan-wave / story-wave graph already defines _what's ready to run_. The
dispatcher only decides _where_:

1. **Prefer free local hosts** (laptop, mac mini) — they're free compute.
2. **Affinity tiebreak:** among eligible hosts, prefer one that already holds this
   plan's warm worktree + node_modules store (speed only — correctness is
   guaranteed by §2 regardless of which host wins).
3. **Burst to EC2** only when local capacity is saturated **and** queue depth
   crosses a threshold (then auto-start an EC2 host per the elastic-EC2 plan).
4. **Integration affinity:** respect the per-app merge lock (§2.4) so two hosts
   never merge the same plan branch concurrently.

### 3.5 Local hosts are the same daemon

A local machine runs the **identical daemon**. The only deltas: its own auth
token (§6) and reachability — it claims jobs **outbound** against DDB, so **no
inbound SSH** and no IP allowlist (sidesteps the allowlist pain we hit repeatedly
this cycle).

---

## 4. What to build now vs. in v3

**Now (v2 hardening — these also fix current single-host bugs, so they pay for themselves):**

1. **Land the boilerplate runtime contract** — prerequisite #1; without it no
   host (even a second EC2) can provision+boot+build an app deterministically.
2. **Add `hostId` to jobs + worktree metadata** even with one host — start
   recording ownership so cleanup is owner-scoped from day one. Cheap now,
   mandatory later.
3. **Convert dispatch to claim-lease + heartbeat** — the single highest-value
   change: fixes reaper-reaps-active-work _properly_ (lease, not freshness
   heuristic) and is the exact primitive the fleet needs.
4. **Make cleanup lease-driven, not scan-driven** — reap iff lease expired + job
   terminal; demote the hourly scan to a daily backstop.
5. **Keep origin + S3 as the only cross-host truth** — the delivery `push main`
   we added is the first brick; never assume a sibling host's disk.

**v3 (the fleet scheduler on top):**

6. **Host registry + self-registration + heartbeat** (§3.1).
7. **Flat per-host capacity caps**, unified across pipeline + interactive (§3.2).
8. **Host-selection policy: prefer-local / affinity / burst-EC2** (§3.4).
9. **Local-machine onboarding** — daemon packaging + **per-host official-CLI
   login** (no token copying — §3.5, §6.1).
10. **Fencing-on-resume** for intermittent hosts (§2.5).
11. **Global Max-budget guard** — fleet-wide awareness of the shared usage pool so
    the dispatcher throttles _total_ in-flight agents against the rolling-5hr /
    weekly caps, not just per-host (§3.2, §6.1). Without this, more hosts hit the
    rate-limit wall sooner instead of going faster.

---

## 5. Honest assessment

We are **closer than it looks**. The painful single-host hardening this cycle
(atomic plan-branch advance via `update-ref`, content-addressed node_modules
store, integration lock, delivery push, appId-keyed deploy) are _all also_ the
multi-host primitives. The missing pieces are: **(a) the boilerplate contract**
(so a job is self-describing), **(b) claim-lease dispatch + heartbeat** (so hosts
don't collide and dead work is recoverable), and **(c) owner/lease-scoped
cleanup** (so a host never reaps what it doesn't own — the most dangerous failure
mode at scale). Do those three during v2 and the v3 fleet is a **scheduling layer,
not a rewrite.**

---

## 6. Open questions (resolve before / during v3)

1. **Auth — can one Max subscription run `claude` concurrently on EC2 + laptop +
   mac mini? → RESOLVED 2026-06-03: yes, with two constraints.**
   - **It's allowed.** A single user running Anthropic's _official_ `claude` CLI
     on any number of machines (local / VPS / EC2 / CI) is the permitted lane.
   - **Constraint A — no token extraction.** Transferring the subscription OAuth
     token to use it _outside_ the official CLI is prohibited. The current
     Mac→EC2 `.credentials.json` _copy_ sits in that gray zone. **Fleet rule:
     each host logs in independently via the official `claude` CLI login (its own
     OAuth) — never copy the credentials file around.**
   - **Constraint B — one shared usage pool, not more capacity.** Rate limits are
     account-wide and shared across every host + every session + claude.ai. More
     machines = more parallel _execution surface_, **not** more LLM throughput.
     This is why the dispatcher needs a **global budget guard** (§3.2, build item
     #11). The scarce resource is the Max budget, not the host count.
   - Sources: Anthropic support "Use Claude Code with your Pro/Max plan"
     (shared-usage statement); ToS analysis on CLI-on-VPS allowance + token-
     extraction prohibition. See `claude-code-dispatch-findings.md` Sources.
2. **Laptop-as-workstation usability.** Flat caps are set by hand for now (§3.2).
   If a static number proves too blunt while you're actively using the machine,
   add **adaptive foreground backoff** (lower the cap when you're at the keyboard).
3. **Weight-classed capacity.** If a flat count lets a host draw N all-heavy jobs
   (VQA/Turbopack boots) and choke, evolve `capacity` into a budget where heavy
   jobs cost more than light ones (reflector/docs).
4. **Uncommitted-work loss tolerance.** §2.1 assumes steps commit+push often
   enough that a sleeping laptop loses only trivial local state. Confirm every
   long-running step has a checkpoint cadence that makes this true.
5. **Elastic-EC2 trigger tuning.** What queue-depth threshold + cooldown starts a
   burst EC2 host, and when does it auto-stop? (Hand off to `develope-it-ec2-plan.md`.)
6. **June 15, 2026 billing change (12 days out — WATCH).** The cost doc flagged
   that subscription `claude -p` / Agent-SDK usage may start drawing from a
   _separate metered_ pool. The entire daemon is `claude -p` on Max, so if true it
   changes the global-budget math (§3.2) for the whole fleet. Couldn't confirm/
   refute on 2026-06-03 — check `claude.ai/settings/usage` after the date.
