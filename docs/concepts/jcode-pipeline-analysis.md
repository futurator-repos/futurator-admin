# jcode → Futurator-Admin: Decision-Grade Analysis

> Source installed at `repos/jcode/` (cloned, not built — Rust build of 3,602 files is unnecessary for analysis and gets OOM-killed on constrained hosts per their own AGENTS.md). Analysis produced 2026-06-29 by a 6-agent workflow (5 parallel deep-readers + synthesizer).

## 1. How jcode works

jcode is an MIT Rust coding-agent harness built as a **single persistent daemon, many thin clients**. One process owns all state; everything else attaches.

**Runtime / sessions.** `jcode serve` listens on a Unix socket (`/run/user/$UID/jcode.sock`), newline-delimited JSON protocol (`jcode-protocol/src/comm_format.rs`). Sessions are server-owned (`SessionAgents: Arc<RwLock<HashMap<String, Arc<Mutex<Agent>>>>>` in `jcode-app-core/src/server.rs`). The turn loop is `run_turn_streaming_mpsc` (`jcode-app-core/src/agent/turn_streaming_mpsc.rs`): repair tool outputs → auto-compact if over budget → fetch tool defs → inject memory → `provider.complete_split()` streams → parse text+tool-calls incrementally → execute tool → loop. Sessions snapshot to `~/.jcode/sessions/{id}/` and survive server reload; `restored_session_was_interrupted()` (`reload_recovery.rs`) decides auto-resume. Control plane is **lock-free**: `InterruptSignal` = `AtomicBool + tokio::Notify`, plus a `SoftInterruptQueue` checked at safe points so cancels never contend with the agent mutex (`jcode-agent-runtime/src/lib.rs`).

**Swarm / overnight.** Recursive spawn tree, depth-capped at 5 (`MAX_SWARM_SPAWN_DEPTH`, `jcode-swarm-core/src/lib.rs`); children track parent via `report_back_to_session_id`; parent owns subtree cleanup. One `VersionedPlan` per `swarm_id`, server-level singleton, **mutations gated to the root coordinator** (propose→approve flow over `CommProposePlan`/`CommApprovePlan` in `jcode-protocol/src/wire.rs`). Spawned agents **must** emit a `comm_report` completion report (before/after/validation) or the coordinator gets a failure lifecycle event. Overnight (`jcode-overnight-core`, `jcode-app-core/src/overnight.rs`) writes an `OvernightManifest` (run_id, target_wake_at, handoff_ready_at = 30min pre-wake, events.jsonl, task-cards/\*.json), samples resources every 5min, and flips to a hold-pattern checkpoint before wake. Ambient mode does dual-layer memory consolidation and **resource-aware adaptive scheduling** (computes safe wake interval from user token rate + budget + rate-limit backoff).

**Gating / safety / hooks (the crown jewel).** Three independent, composable layers:

- **Two-tier classifier** (`jcode-base/src/safety.rs`): `ActionTier::AutoAllowed` (read/glob/grep/ls/memory/search) vs `RequiresPermission` (bash/write/edit/communicate/launch/unknown). No "always denied" tier.
- **Pre-tool gate hook** (`jcode-base/src/hooks.rs`, invoked at `jcode-app-core/src/tool/mod.rs:584-608`): synchronous external process, gets tool name + input JSON on stdin + env, **exit 0 = allow, exit 2 = block** (stderr → returned to model as tool error), anything else = fail-open allow. Default timeout 5s.
- **Observer hooks** (turn_start/end, session_start/end, post_tool): detached fire-and-forget. **Spawn hook** controls new-terminal placement. Recursion guard via `JCODE_HOOKS_DISABLED=1`. Persistent permission queue (`~/.jcode/safety/queue.json` → `history.json`) with file-based fallback for background processes.

**Providers / compaction / memory.** `Provider` trait (`jcode-provider-core`) with `complete_split()`, explicit prefix routing (`claude:model`, `openai-oauth:model`), `auto_default_provider()` cascade, and `classify_failover_error_message()` (regex on 429/401/413 → `FailoverDecision`, no LLM). Compaction (`jcode-compaction-core`): 200k budget, async summarize at 80%, hard-compact at 95%, keeps `RECENT_TURNS_TO_KEEP=10` verbatim, images charged flat 1600 tokens. **Split system prompt** (static+dynamic) for KV-cache reuse. Memory is a graph (`jcode-memory-types/src/graph.rs`): MemoryEntry/TagEntry/ClusterEntry nodes, HasTag/InCluster/RelatesTo/Supersedes/Contradicts edges, hybrid retrieval (dense cosine + BM25 + RRF), local **all-MiniLM-L6-v2 ONNX embeddings, 384-dim** via tract (`jcode-embedding`), category-specific confidence decay, dynamic variable-k gating. Memory injection runs one turn behind in a background task.

## 2. Our pipeline today

**Flow:** epic → solutioning-gate → plan decomposition → parallel story waves (dev/review/compile per story) → wave build-check → seam-mount-check → wave-merge (conflict detection) → visual QA → post-epic reflection. 15+ job types routed by a pure `selectHandler` (`daemon/pipelines/job-router.mjs`).

**Gating points (all deterministic, all post-hoc or pre-spawn — none intercept the agent mid-tool):**

- Solutioning gate — `functions/shared/services/solutioning-gate.ts` (epic structure, AC coverage, ref resolution, rigor-scaled).
- Prework gate — `daemon/lib/prework-gate.mjs` (commit history + AC @export symbols + `tsc --noEmit`; killed 7 of 9 dev spawns in dino1).
- Scope-violation detector — `daemon/pipelines/lib/scope-violation-detector.mjs` (git diff vs touchPoints/forbiddenAreas, auto-injected as fail-ACs).
- Seam-mount check — `daemon/lib/seam-mount-check.mjs` (two-stage grep, blocks unwired apps).
- Cost ceiling — `daemon/agent-daemon.mjs` (~1200-1250), pre-wave budget gate.
- Wave-merge — `daemon/lib/wave-merge.mjs`.
- Shell guard / path hooks — `daemon/pipelines/lib/shell-guard.mjs`, `free-agent-path-hook.sh`, `party-tool-hook.sh` (Tier-1/2/3 model — note: this already echoes jcode's classifier).
- Role policy — dual TS/MJS mirror with CI parity test (`functions/shared/pipelines/role-policy.ts` + `daemon/pipelines/lib/role-policy.mjs`).

**Real pain points (cited from `docs/concepts/agentic-pipeline-forensic-report.md`):**

1. **Spawn overhead dominates.** Every Claude spawn = ~30s cold start + ~27k cache-creation tokens. No context carries dev→review→compile; each stage re-reads the same files.
2. **Compile thrash = 47% of epic duration.** Per-story compile sessions, redundant re-reads of shared `knowledge/*.md`, parallel write races (8-story wave → last-write-wins, 7 index.md writes lost). `daemon/pipelines/compile-pipeline.mjs`.
3. **Host saturation.** t2.micro (1.8GB) OOM-kills 5 concurrent Sonnet agents (~300MB each).
4. **Reviewer inconsistency.** Story 5 / story 10 each failed 3× on passable code → ~270s wasted.
5. **Dead time between waves** (2-5min) from cron-cadence dispatch.
6. **Economics:** $5.56 for 10 stories that should cost ~$2; 25+ wall-clock hours vs 77 min of agent work.
7. **bypassPermissions everywhere** — `epic-dev-pipeline.mjs` spawns with `--permission-mode bypassPermissions`. Gating is entirely deterministic-external + post-hoc diff audit; there is **no live in-turn tool interception**.

## 3. Capability map

| jcode capability                                             | Our pain it addresses                                    | Verdict                                | Effort | Impact |
| ------------------------------------------------------------ | -------------------------------------------------------- | -------------------------------------- | ------ | ------ |
| Pre-tool gate hook (exit 0/2, fail-open)                     | bypassPermissions + post-hoc-only detection (#7)         | port-pattern                           | S      | **Hi** |
| Single-server, session-owned agents                          | Spawn cold-start 30s + 27k tokens, no context reuse (#1) | port-pattern (big)                     | L      | **Hi** |
| Context compaction (80/95% + flat image cost + split prompt) | Compile thrash, context bloat, re-compaction (#1,#2)     | port-pattern                           | M      | **Hi** |
| Local ONNX MiniLM embeddings + hybrid RRF                    | Redundant re-reads, weak context selection (#1,#2)       | use-directly (model) / port (pipeline) | M      | Med    |
| Multi-provider trait + failover classifier                   | Cost/throughput, OAuth exhaustion → API fallback (#3,#6) | port-pattern                           | M      | Med    |
| Resource-aware adaptive scheduling                           | t2.micro OOM, host saturation (#3)                       | port-pattern                           | M      | **Hi** |
| Soft-interrupt queue / lock-free control                     | No graceful mid-turn steering                            | inspiration                            | M      | Lo     |
| Recursive spawn tree, depth cap, parent cleanup              | Orphan/runaway spawns, crash recovery                    | inspiration (we have child-tracker)    | S      | Lo     |
| Coordinator-gated VersionedPlan singleton                    | Plan-write races, wave coordination                      | inspiration                            | M      | Med    |
| Completion-report requirement (before/after/validation)      | Silent failures, reviewer subjectivity (#4)              | port-pattern                           | S      | Med    |
| Overnight manifest + task-cards + JSONL events               | Crash recovery, audit, 25h wall time visibility (#6)     | port-pattern                           | M      | Med    |
| Two-tier action classifier                                   | Already partially built (party-tool-hook tiers)          | port-pattern (unify)                   | S      | Med    |
| Lease-based session persistence + reload recovery            | Stale-heartbeat marks dev/compile FAILED forever         | port-pattern                           | M      | Med    |
| Telemetry schema (privacy, fire-and-forget, versioned)       | We already have forensic reports                         | inspiration                            | S      | Lo     |

## 4. Gating control — the focused call

**Today:** we spawn with `--permission-mode bypassPermissions` and rely on _external deterministic checks_ (shell-guard, scope-violation-detector, seam-mount-check) that run **before spawn** (admission) or **after diff** (audit). We cannot block or modify an individual tool call _while the agent is mid-turn_. The agent can do anything inside its allowlist between gates; we only catch it after the fact in the git diff. The bash hooks (`free-agent-path-hook.sh`, `party-tool-hook.sh`) are the one exception — they ARE pre-tool — but they're shell-script-only, naive parsers, and not unified with role-policy.

**What jcode gives us:** a real **in-turn interception seam**. Claude Code already supports `PreToolUse` hooks (we use them in the party hook). jcode's model tells us exactly how to make that the _primary_ deterministic gate instead of a side guard:

- **Block/modify/allow per tool call.** A single `PreToolUse` hook receives `{tool_name, tool_input}`, returns allow (exit 0) / block-with-reason (exit 2, reason fed back to the model so it self-corrects) / fail-open. This replaces "bypassPermissions + hope the diff audit catches it" with "every Edit/Write/Bash is adjudicated live against the story's touchPoints + role-policy + cost state."
- **Drive the hook from our existing data tables.** The hook should consult `role-policy.mjs` (already a serialized table) + the story's `touchPoints`/`forbiddenAreas` + live cost from the job row. This turns scope-violation-detector from a _post-hoc reviewer-AC injector_ into a _pre-write blocker_ — the leak never lands in the diff. Same logic, moved earlier on the timeline.
- **Fail-open, not fail-closed.** Critical: jcode's deliberate choice. A broken policy script must never brick a 25h overnight run. Adopt exit-0-on-error, exit-2-only-on-proven-violation.
- **Recursion guard.** Set `FUTURATOR_HOOKS_DISABLED=1` in the hook subprocess (jcode's `JCODE_HOOKS_DISABLED=1`) so a hook that shells out to git/node doesn't re-trigger itself.
- **Three layers, composed:** (1) admission gate (prework — keep), (2) **pre-tool gate (new — the lever)**, (3) post-diff audit (scope/seam — keep as backstop). Defense in depth, exactly jcode's model.

**Net:** we keep bypassPermissions for _interactivity_ but bolt a deterministic `PreToolUse` adjudicator that consults role-policy + touchPoints + cost. That is the single highest-leverage gating change and it's days of work, not a rewrite.

## 5. Develop faster — top levers

1. **Kill spawn cold-start with a persistent session server (biggest token+time win).** Our #1 cost is 30s + 27k cache-creation tokens _per spawn_, and dev→review→compile spawn fresh and re-read everything. jcode's whole architecture is the answer: one daemon owning live sessions, stages sharing KV-cache. We don't need jcode's Rust server — the **Claude Agent SDK** lets dev/review/compile run as subagents in one session, reusing cache. Forensic estimate: 40-60% token reduction on multi-stage stories. This is the structural fix.
2. **Compaction to end compile thrash.** Compile is 47% of epic duration partly from context bloat and per-story re-reads. Port jcode's three-tier compaction (async@80/hard@95, flat image cost, **static+dynamic split system prompt for KV-cache reuse**). Combined with the known-but-unbuilt **per-wave consolidated compile** (one Haiku run sees all diffs, writes shared files atomically — eliminates the race + 47%).
3. **Local ONNX embeddings for context selection.** Instead of agents re-reading whole files (`onnxruntime-node` + all-MiniLM-L6-v2, the exact model jcode ships), embed the knowledge base + story diffs locally (<100ms) and inject only top-k relevant snippets. Cuts the redundant-read tax that inflates both dev and compile.
4. **Multi-provider trait + failover classifier for throughput.** Regex-classify 429/auth/context errors (no LLM latency) and fall back OAuth→API-key. Lets us run more parallel agents without OAuth-exhaustion stalls. Note MEMORY: stay on Max subscription as primary; API-key is the _overflow valve_, not the default.
5. **Resource-aware admission to stop OOM-without-lowering-parallelism.** MEMORY explicitly says never lower concurrency to fix host saturation. jcode's adaptive scheduler / priority-class admission is the right shape: issue tokens per priority (interactive > critical-path > background), and the real fix is a bigger host — but admission tokens keep t2.micro alive until then.

## 6. Top 5 recommendations (ranked)

**#1 — Pre-tool deterministic gate hook (the gating spine).**

- _What:_ A `PreToolUse` hook on all epic-dev spawns that adjudicates each Edit/Write/Bash against role-policy + story touchPoints + live cost, exit-2-blocks with a reason fed back to the model, fail-open on error.
- _Why:_ Converts our entire gating story from post-hoc diff audit to live interception — scope leaks never land, cost ceiling enforced mid-turn not just pre-wave, and we keep agent reasoning freedom (MEMORY: artifact/boundary control, not reasoning constraints). Highest impact, lowest effort because the seam (`PreToolUse`) and the data (`role-policy.mjs`, touchPoints) already exist.
- _Effort:_ S–M. _Risk:_ Low (fail-open guarantees no bricking; backstops stay). _First step:_ Generalize `daemon/pipelines/lib/party-tool-hook.sh` into a `pretool-gate.mjs` that reads `CLAUDE_TOOL_INPUT`, loads `role-policy.mjs` + the job's touchPoints, returns 0/2; wire it into `epic-dev-pipeline.mjs` spawn args; set `FUTURATOR_HOOKS_DISABLED=1` recursion guard.

**#2 — Per-wave consolidated compile + compaction.**

- _What:_ Replace per-story compile with one wave-close Haiku run over all story diffs writing shared knowledge files atomically; add jcode-style compaction + split system prompt to long sessions.
- _Why:_ Directly removes the 47%-of-epic bottleneck and the index.md write race. Already designed (Epic D), just unbuilt.
- _Effort:_ M. _Risk:_ Med (must preserve per-story provenance in the consolidated pass). _First step:_ Refactor `daemon/pipelines/compile-pipeline.mjs` to a `wave-compile` job that takes the wave's full DIFF_MANIFEST in one invocation.

**#3 — Session reuse across dev→review→compile via Agent SDK subagents.**

- _What:_ Collapse the three fresh spawns per story into one session with role-scoped subagents sharing KV-cache.
- _Why:_ Attacks the #1 cost driver (27k cache-creation tokens × 3 stages × N stories). 40-60% token cut.
- _Effort:_ L. _Risk:_ Med-High (touches the core story-pipeline; role-policy must map to subagent tool allowlists; reviewer independence must be preserved). _First step:_ Spike one story end-to-end as a single SDK session in `spikes/`, measure tokens vs current.

**#4 — Local ONNX embedding context service.**

- _What:_ `onnxruntime-node` + all-MiniLM-L6-v2 sidecar; embed knowledge base + diffs, inject top-k instead of full-file reads.
- _Why:_ Cuts redundant-read tax across dev and compile; reuses jcode's exact, proven model.
- _Effort:_ M. _Risk:_ Low (additive, falls back to current behavior). _First step:_ Stand up the embedder as a daemon helper, index `knowledge/` for one project, A/B the compile read volume.

**#5 — Resource-aware admission tokens + provider failover.**

- _What:_ Priority-class admission (interactive>critical>background) in `concurrency-manager.mjs` + regex failover OAuth→API on 429/exhaustion.
- _Why:_ Stops t2.micro OOM without lowering parallelism (MEMORY constraint) and removes rate-limit stalls.
- _Effort:_ M. _Risk:_ Low-Med. _First step:_ Add a failover classifier to the spawn wrapper; tune admission slots per model/rigor.

## 7. Direct-use vs not — the honest call

**Do NOT adopt the jcode binary, and do NOT fork it.** Reasons are decisive:

- jcode is **Rust**; our entire substrate is Node.js daemon + DynamoDB polling + Lambda + Claude CLI subprocesses on EC2. Adopting the binary means running two agent runtimes, re-implementing our 15 job types, role-policy parity, DynamoDB job rows, SST infra, and the Labs/Agentic-Office integration against a foreign socket protocol. The integration surface dwarfs the benefit.
- jcode's provider/auth assumes its own OAuth cascade and **ships telemetry to a third-party Cloudflare Worker** (`jcode-telemetry.jeremyrayhuang55555.workers.dev`). For an internal single-operator factory (MEMORY: Labs tenancy internal), that's an unacceptable default to audit around.
- We already run a **working daemon on a Claude Max subscription** with deterministic gates that, in several cases, _already mirror jcode_ (party-tool-hook tiers ≈ two-tier classifier; child-tracker ≈ spawn-tree cleanup; prework-gate ≈ admission). We're not behind on philosophy — we're behind on a few specific mechanisms.

**Use-directly (narrow):** the **all-MiniLM-L6-v2 ONNX model file** (port via `onnxruntime-node`) and the **compaction constants** (200k/80%/95%, flat-1600-image, RECENT=10) as literal tunables. These are model/config artifacts, not code coupling.

**Port-the-pattern (the real value):** pre-tool gate semantics (0/2/fail-open + recursion guard), three-tier compaction, hybrid RRF retrieval, multi-provider trait + regex failover, completion-report requirement, lease-based session recovery, resource-aware scheduling. These map cleanly onto our existing files (`epic-dev-pipeline.mjs`, `compile-pipeline.mjs`, `concurrency-manager.mjs`, `stale-heartbeat.mjs`, `role-policy.mjs`).

**Inspiration-only:** swarm coordinator-gated VersionedPlan, overnight manifest UX, soft-interrupt steering — good ideas, but our DynamoDB-as-source-of-truth + cron dispatch already covers the durable-coordination need; revisit only if/when we move to multi-host dispatch (MEMORY: multi-host roadmap).

**Bottom line:** jcode is a **pattern donor, not a dependency.** Mine it for the pre-tool gate (do this first), compaction, local embeddings, and failover — all portable into the Node daemon in days-to-weeks, with no Rust runtime, no foreign telemetry, and no disruption to the Max-subscription daemon that already works.
