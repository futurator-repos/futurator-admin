# Running Pipeline Agents on Claude Cloud vs EC2 — Findings & Proposals

**Audience:** Ricardo (operator).
**Question that started this:** "Can I use Claude Code's web/cloud compute to run the
pipeline agents instead of my EC2 box, since I already pay for Claude Max?"
**Date:** 2026-05-30.
**Inputs:** `~/Downloads/claude-code-dispatch-for-futurator.md` (research doc) + a full
read of the current daemon pipeline + verification against live Anthropic docs (these
features postdate the model's training cutoff, so every claim below was re-checked on
the web — see Sources).

> **Decisive context:** Futurator Labs is an **internal, single-operator** system
> (only you dispatch agents, against your own repos). It is **not** a multi-tenant
> product. This single fact changes most of the dispatch doc's conclusions — see §2.

---

## TL;DR

1. **Your agents already run on Max (flat fee), not per-token.** The daemon spawns
   `claude -p` against your Max OAuth token and deliberately strips
   `ANTHROPIC_API_KEY` from every subprocess. The LLM inference is already the
   cheap part.
2. **"Use Claude's cloud compute" does not unlock more capacity.** Cloud Routines /
   cloud sessions **draw down the same Max usage budget** as your EC2 `claude -p`
   calls. Moving the loop to Anthropic's cloud saves **the box**, not tokens.
3. **The only real cost is the idle EC2 box** (~$15–30/mo for a `t4g.small`/`medium`
   running 24/7) **plus operational tax** (OOM kills, the Mac→EC2 OAuth-sync dance,
   single-instance SPOF).
4. **Your current EC2 setup is 100% ToS-legal** — Anthropic explicitly allows running
   the Claude Code CLI on your own VPS for personal _or business_ use. The doc's
   "you must move to API-key/Bedrock" rule only fires **if Labs becomes a product**.
   It isn't one.
5. **Routines can't be the pipeline engine: Max caps you at 15 routine-runs/day**, and
   the cloud has none of your bare-repo / per-story-worktree / `_merge` wave topology.
6. **Recommendation: stay on Max. Make the EC2 box elastic (auto-stop/start) now —
   that kills ~80–90% of the dollar cost with ~a day of work and zero pipeline risk.
   Optionally offload standalone jobs (party debates, housekeeping) to Routines
   `/fire`. Do NOT move to Bedrock/Managed Agents unless Labs becomes multi-tenant.**

---

## 1. How the pipeline runs today (ground truth from the code)

| Concern              | Reality                                                                                                                                                                                                                                                                                              | Where                                                                                                       |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **LLM invocation**   | `spawn(node, [claudeBin, '-p', prompt, '--output-format','stream-json','--verbose', …])` — long-lived subprocesses streaming NDJSON until `---DONE---` / `---WORK_SUMMARY---` sentinels.                                                                                                             | `daemon/agent-daemon.mjs` (~L901 spawn); epic orchestrator `daemon/pipelines/epic-dev-pipeline.mjs` (~L301) |
| **Auth / billing**   | **Claude Max subscription OAuth** at `/home/ubuntu/.claude/.credentials.json`. `ANTHROPIC_API_KEY` is _deleted_ from the env and _stripped_ from every child. **No per-token billing for agent work.**                                                                                               | `agent-daemon.mjs` `loadOAuth()` / `stripApiKey()`                                                          |
| **Control loop**     | `while(!shuttingDown)` polls `futurator-agent-jobs` (GSI `status-createdAt-index`) every ~3 s; `POLL_INTERVAL_MS`; `MAX_CONCURRENT` default 2 (capped to 2 under 3 GB RAM).                                                                                                                          | `agent-daemon.mjs` `poll()` (~L5441)                                                                        |
| **Routing**          | Pure `selectHandler(job)` by `jobType` / `phase` → party / app-bootstrap / free-agent / wave-merge / skill-scout / reflector / epic-dev / legacy step pipeline.                                                                                                                                      | `daemon/pipelines/job-router.mjs` (~L60)                                                                    |
| **Story run**        | prework-gate (zero-LLM short-circuit) → context-pack → `git worktree add` → CLAUDE.md via `--append-system-prompt` → DEV `claude -p` → REVIEWER `claude -p` → compile steps. One/two long subprocess calls, minutes to 1 hr+.                                                                        | `agent-daemon.mjs` `executePipeline()` (~L2352)                                                             |
| **Git topology**     | Bare repo `/home/ubuntu/repos/<appId>.git`; per-story worktrees `/home/ubuntu/worktrees/<appId>/<planSlug>/<storyId>/` on `wip/<storyId>`; coordinator `_merge/` does `--no-ff` merges in storyId order, HALTS on conflict.                                                                          | `daemon/lib/story-worktree.mjs`, `wave-merge-runner.mjs`, `worktree-paths.mjs`                              |
| **Wave advancement** | Event-driven: job completion fire-and-forgets `WaveCompletionCheck` Lambda; 1-min cron backstop. Reducer logic lives in the Lambda (TS), not the daemon.                                                                                                                                             | `sst.config.ts` (WaveCompletionCheck), daemon `triggerWaveReduce()`                                         |
| **Host coupling**    | Hardwired to a persistent EC2 box: `/home/ubuntu/...` paths, local `claude` binary (`which claude`), local git, instance IAM role for DDB/S3/Lambda/Secrets, PreToolUse hooks written into worktree `.claude/settings.json`, loopback receiver `127.0.0.1:17631`, instance id `i-0826d68c316ae97dd`. | throughout daemon + `sst.config.ts`                                                                         |

**Key insight:** the daemon does two separable jobs —

- **Orchestration brain** (poll/route/gate/parse/advance/reflect/compile) — already
  half-migrated into the `WaveCompletionCheck` Lambda.
- **Execution host** (long-lived `claude -p` + local git worktrees + event stream) —
  this is the _only_ part that needs a 24/7 box.

---

## 2. Why tenancy changes everything

Anthropic's terms:

- **Forbidden:** using a **claude.ai subscription** to power an **external /
  customer-facing product** (the "LLM wrapper SaaS" pattern). Those must use an
  **API key / Bedrock / Vertex** under commercial terms.
- **Explicitly allowed:** running the **Claude Code CLI** on your own VPS/EC2, for
  **personal _or_ business** use.

Since Labs is **internal / just you**, you are in the _allowed_ lane. The dispatch
doc is written largely as if Labs were "the product" (its Track B, Managed Agents,
Bedrock recommendations all assume multi-tenant). **That framing is aspirational, not
your current state.** For a solo operator already paying Max, moving to per-token
billing (Bedrock / Managed Agents / Agent SDK) almost always costs **more**, not less.

> If Labs ever becomes multi-tenant (customers dispatch agents), ToS _forces_ the
> switch to API-key/Bedrock regardless — at that point re-read §5 of the dispatch doc.
> Until then, Max is both legal and cheapest.

---

## 3. The three dispatch paths, verified (2026-05-30)

| Path                     | Auth                                                            | Runs where                          | Streaming                                                     | Killer constraint for _your_ pipeline                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------- | ----------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Routines `/fire`**     | Max subscription (per-routine bearer token, **not** an API key) | Anthropic cloud                     | ❌ fire-and-forget; returns a session URL to watch in browser | **Max = 15 routine-runs/day (hard cap).** Cloud clones your repo and works on `claude/` branches — **none** of your bare-repo + per-story-worktree + `_merge` wave choreography exists there. Coarse status only via an MCP→webhook the prompt calls. |
| **Agent SDK (headless)** | API key / Bedrock — **per-token**                               | Your infra (Fargate)                | ✅ full delta+tool stream                                     | More infra than you run today **and** flips you off Max onto per-token. Wrong direction for solo.                                                                                                                                                     |
| **Managed Agents**       | API key — **$0.08/session-hr + tokens**                         | Anthropic "brain" / sandbox "hands" | ✅ bidirectional (interrupt/steer)                            | Per-token; only economical at product scale. Public beta.                                                                                                                                                                                             |

**The number that ends the "Routines as engine" idea:** one real Plan→Epic→Story→Wave
run fires _dozens_ of story/reviewer/merge jobs. At **15 starts/day** Routines blows
the cap before a single plan finishes, and can't host wave-merge or live streaming.
**Routines are for standalone, fire-and-forget jobs only.**

---

## 4. Options & tradeoffs (internal use; cost _and_ fragility)

| Option                                                                                                                                                                         | Cost win                                                | Effort                                                  | What breaks                                                          | Verdict                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------- |
| **A. Elastic EC2** — auto stop/start the box on queue depth (EventBridge: start when a PENDING `futurator-agent-jobs` row appears; stop after N min idle)                      | **~80–90% of the EC2 bill** — pay only while agents run | **Low (~1 day)**, no pipeline changes                   | Nothing — full pipeline, streaming, worktrees intact                 | ✅ **Do first.** Kills the dollar cost, keeps all the machinery. |
| **B. Routines `/fire` for the fire-and-forget subset** — brownfield **party debates**, docs-drift, dep-bumps, deploy-verify (fit 15/day, no wave-merge, no live stream needed) | Offloads load off the box → helps right-size A          | **Medium** — per-routine setup + MCP→Hub status webhook | Live token-stream UX for those jobs (replaced by milestone webhooks) | ✅ **Good hybrid.** = the doc's "Track A".                       |
| **C. Full cloud re-arch** (Bedrock / Managed Agents)                                                                                                                           | **Negative** — adds per-token cost on top of Max        | **High**                                                | Discards worktree/wave-merge control plane                           | ❌ Only if Labs becomes a product.                               |

**On fragility specifically (OOM / OAuth-sync / SPOF):** Option A is still a single
box, so it doesn't fix those. They're orthogonal and cheaper to fix directly than a
re-arch:

- **OOM** → right-size the instance. (Consistent with the standing rule: _fix the
  host, never lower agent concurrency to mask saturation._)
- **OAuth-sync dance** → inherent to the one-box model; the cloud-Routines subset (B)
  removes it for exactly the jobs that cause the most "is the box even up?" anxiety.
- **SPOF** → accept it for an internal tool, or let B carry the standalone jobs so the
  box being down doesn't block debates/housekeeping.

So if **fragility** outweighs **dollars**, the move is **A + B**, still not C.

---

## 5. Recommendation

1. **Stay on Max.** It's legal for internal use and cheapest.
2. **Implement Option A (elastic EC2) now.** One day, zero pipeline risk, ~80–90% of
   the cost gone.
3. **Layer Option B (Routines for party/debates + housekeeping)** when you want to
   thin the box's load and de-risk the standalone jobs.
4. **Do not touch Bedrock / Managed Agents** unless/until Labs becomes multi-tenant —
   then ToS forces it and §3 + the dispatch doc's Track B apply.

---

## 6. Open items to verify before committing

- **June 15, 2026 billing change** (cited in the dispatch doc): `claude -p` / Agent-SDK
  usage on subscription plans reportedly starts drawing from a **separate metered
  Agent-SDK credit pool**. Your **entire current daemon is `claude -p` on Max** — if
  true this affects the _status-quo_ economics regardless of any decision here.
  **Confirm at `claude.ai/settings/usage` and the routines/SDK billing notes.**
- **Per-plan Routine daily cap** — docs state Max = 15/day; confirm your account's
  current number at `claude.ai/code/routines` before relying on B for anything
  frequent.
- **EventBridge start/stop wiring** for Option A — confirm the daemon comes up clean
  on instance _start_ (git identity from SSM, OAuth creds present, reaper/heartbeat
  resume) and that an in-flight job is never killed by the idle-stop timer (drain
  before stop).

---

## 7. Suggested next actions (pick any)

- **(a)** Spec Option A: EventBridge + Lambda auto stop/start against instance
  `i-0826d68c316ae97dd` and the `futurator-agent-jobs` queue, including the
  safe-drain-before-stop guard.
- **(b)** Prototype Option B: wire one brownfield **party debate** to a Routine
  `/fire` + MCP→Hub status webhook as a working demo.
- **(c)** (this doc) — captured next to the dispatch research for later reading.

---

## Sources

- Claude Code routines (docs) — https://code.claude.com/docs/en/routines
- Trigger a routine via API (`/fire`) — https://platform.claude.com/docs/en/api/claude-code/routines-fire
- Claude Code on the web (cloud sessions) — https://code.claude.com/docs/en/claude-code-on-the-web
- Managed Agents overview — https://platform.claude.com/docs/en/managed-agents/overview
- Managed Agents pricing ($0.08/session-hr) — https://aiproductivity.ai/news/anthropic-claude-managed-agents-public-beta/
- Claude Code ToS / VPS allowance — https://autonomee.ai/blog/claude-code-terms-of-service-explained/
- Subscription-vs-API for external products — https://mlq.ai/news/anthropic-ends-paid-access-for-claude-in-third-party-tools-like-openclaw/
- Source research doc — `~/Downloads/claude-code-dispatch-for-futurator.md`

_Note: Routines and Managed Agents are research preview / public beta; API shapes,
limits, and pricing may change. Re-verify before any production commitment._
