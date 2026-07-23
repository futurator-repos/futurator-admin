# ecc → Futurator-Admin: Comparison & Extraction Analysis

> ecc = "ecc-universal" v2.0.0 (github.com/affaan-m/ecc) — a universal agentic-engineering framework:
> a JS/Python LLM core, a Rust next-gen control plane (`ecc2/`), an epic-orchestration system,
> an instinct/evolve/council learning layer, 271 skills, 67 agents, 92 commands, and 12 harness
> adapters. Source at `repos/ecc/` (cloned, gitignored, not built). Produced 2026-06-29 by an
> 8-agent parallel investigation (one reader per subsystem) + synthesis. Companion to
> `jcode-pipeline-analysis.md`, and to the Mycelium `futurator-sdd-jcode-analisis-1.md` /
> `futurator-ponytail-analysis-1.md`.

## TL;DR — the verdict

ecc is a **pattern donor, not a dependency** (same call as jcode). It is Claude-ecosystem-centric, a
JS+Python+Rust mix, and most of its 271 skills / 67 agents are breadth (domain-specific) not depth. But
buried in it are **~8 mechanisms that map almost 1:1 onto Futurator's named pain points** — and three of
them independently reinforce the single highest-leverage change already surfaced by the jcode and SDD
analyses: **move gating from post-hoc diff audit to LIVE pre-tool interception.**

**The through-line across all four analyses (jcode, SDD/Mycelium, ponytail, ecc): the #1 move is a
deterministic pre-tool gate.** ecc adds the missing detail — a _composite risk score_ and an
_investigation-as-gate_ ("fact-force") — that tells us exactly how to make that gate smart, not just
allow/deny.

---

## Part 1 — How ecc works (all subsystems)

ecc is really five layers stacked on a multi-harness distribution substrate.

### 1.1 JS/Python core runtime & CLI (`src/llm/`, `scripts/`)

A Python LLM core (`src/llm/core`, `providers`, `tools`, `prompt`, `cli`) with a provider-agnostic
`LLMProvider` interface (Claude/OpenAI/Ollama/Astraflow/Atlas), a `PromptBuilder` that adapts tool
schemas per provider, and a deterministic `ReActAgent` loop (max-iterations cap, strict tool-result
ordering). A JS CLI (`scripts/ecc.js`) dispatches ~17 commands by spawning subprocess scripts. A
**control-pane** (`scripts/lib/control-pane/server.js`) is a loopback-only HTTP operator dashboard
showing sessions/work-items/actions with a click-to-claim board. State persists in **SQLite via sql.js**
(`scripts/lib/state-store/`). ~40 runtime hooks with `ECC_HOOK_PROFILE=minimal|standard|strict` gating.

### 1.2 ecc2 — the Rust control plane (`ecc2/src/`)

A next-gen rewrite (tokio/ratatui/rusqlite/git2) to "manage many agent sessions from one surface":

- **session/** — sessions as a 7-state machine (Pending→Running→Idle/Stale→Completed/Failed/Stopped),
  SQLite store (sessions, tool_logs, messages, worktree_requests, scheduled_tasks, remote_dispatch,
  context_graph), heartbeat enforcement, hard budget limits, merge queue.
- **worktree/** — git worktree per session (`git worktree add -b ecc/{id}`), **dependency-cache sharing
  via symlinks** to parent `node_modules`/`target`/`.venv` keyed on lock-file SHA, `git merge-tree`
  dry-run conflict prediction, hunk-level staging, draft-PR creation.
- **observability/** — **composite tool-call risk score (0–1)** = base tool risk + file sensitivity +
  blast radius + irreversibility → `Allow/Review/RequireConfirmation/Block` thresholds; every call logged.
- **comms/** — typed inter-agent messages (TaskHandoff/Query/Response/Completed/Conflict) with priority,
  an inbox pattern.
- **config/** — multi-layer TOML with **agent-profile inheritance** (`inherits = "base"`, per-profile
  model + allowed/disallowed tools + budget), harness-runner map, orchestration templates with `{{var}}`.
- **notifications/** — desktop + Slack/Discord webhooks with quiet hours; **context graph** (entities,
  relations, observations) for cross-session memory.

### 1.3 Epic orchestration (`commands/epic-*`, `scripts/orchestrate-*`, `scripts/lib/github-coordination/`)

GitHub-native, decentralized: coordination state (status/owner/branch/validation/review/deps/tasks) is
embedded **inside the GitHub issue body** as a JSON block; SQLite is a cache, GitHub is the source of
truth. The loop: `sync → decompose` (parse task checklist, no child issues) `→ claim` (lease; note:
documented **non-atomic**) `→` build a worker plan `→` **tmux + worktree fan-out** via a template
launcher (`{task_file}`,`{worktree_path}`,`{status_file}`) with **seed-path code overlays** `→` workers
write `handoff.md`/`status.md` `→ validate` (deps closed) `→ review` (policy state machine) `→ publish →
unblock` (sweep blocked epics whose deps are now closed). The `unblock` sweep is the elegant bit.

### 1.4 Agents library (`agents/`, 67)

Markdown + YAML frontmatter (`tools`, `model` tier, prompt). Taxonomy: 23 reviewers (general + 16
language + 5 domain), 13 build-resolvers, 5 architects, the **GAN trio** (planner→generator→evaluator,
adversarial: planner writes an ambitious spec + rubric, generator builds, evaluator browser-tests live
and scores 4 axes, loops until ≥7/10), and meta-agents: **harness-optimizer** (tune config not code),
**loop-operator** (autonomous-loop circuit-breakers: stall/retry-storm/cost-drift escalation),
**agent-evaluator** (5-axis evidence-required scorecard), **chief-of-staff**, code-simplifier,
comment-analyzer. Reviewers ship a **false-positive gate** (cite line / failure-mode / read context /
defensible severity before flagging; zero findings is valid).

### 1.5 Learning layer (`skills/continuous-learning-v2`, `commands/instinct-*`, `evolve`, `council`)

**Instincts** = atomic learned behaviors (`trigger`,`action`,`confidence 0.3–0.9`,`domain`,`scope`)
captured by **100%-reliable Pre/PostToolUse hooks** (not probabilistic skills) into project-scoped
`observations.jsonl`, analyzed by a background Haiku observer, confidence-scored with decay (−0.02/wk) and
correction (−0.1). **Promotion**: an instinct seen in 2+ projects at ≥0.8 graduates to global. **Evolve**
clusters instincts → generates skills/commands/agents. **Council** convenes 4 voices (architect/skeptic/
pragmatist/critic) in parallel for ambiguous decisions. Plus `agent-self-evaluation` (5-axis) and
`agent-introspection-debugging` (4-phase failure recovery), `checkpoint` (verify-against-baseline).

### 1.6 Cost / observability / hooks / security

- **Cost**: Stop-hook reads the transcript, sums tokens × model rate table → `costs.jsonl`; `/cost-report`
  summarizes. Soft + post-hoc (under-reports). **cost-aware-llm-pipeline** skill adds model routing
  (Haiku<Sonnet<Opus by complexity), **immutable `CostTracker` dataclass**, narrow retry, prompt caching.
  A **harness-cost bridge** (`/tmp/harness-cost-{id}.json`) lets the statusline inject authoritative cost.
- **Observability**: a **bridge contract** — Stop hook writes `/tmp/ecc-metrics-{id}.json` (context%, cost,
  loop ring-buffer), a PostToolUse monitor reads it and emits debounced warnings; an `observability:ready`
  deterministic ~150-check rubric gates GA.
- **Hooks**: `hooks/hooks.json` (70+) with a novel **GateGuard fact-force** PreToolUse gate — instead of
  "are you sure?" (LLMs always say yes) it _demands facts_ (list importers, affected API, rollback plan)
  before an edit/destructive-bash proceeds; session-memoized to avoid re-gating.
- **Security**: `the-security-guide.md` threat model, `security:ioc-scan` (secrets/hidden-unicode/malicious
  pkgs), AgentShield (`npx ecc-agentshield scan` → A–F grade), CodeRabbit config, supply-chain IR playbook.

### 1.7 Multi-harness distribution (`scripts/lib/install-targets/`, `schemas/`, `manifests/`)

Canonical source (skills/rules/commands/agents/hooks) → **frozen `ADAPTER_RECORDS`** declaring what each
of 12 harnesses supports → per-harness **install-target adapters** that `planOperations` (copy /
merge-json / flatten with a `strategy`) → **`harness:audit`** verifies parity and fails on doc drift →
**JSON-schema contracts** (`plugin`, `hooks`, `install-components` with `family:slug` taxonomy) →
**profiles** (minimal/core/developer/security/research/full) compose modules. `build:opencode` transpiles
a `.opencode/` TS adapter.

---

## Part 2 — Best ideas for Futurator, ORDERED BY IMPACT

Each row de-dups findings that recurred across readers. Effort S/M/L; impact is for _Futurator's named
pain_ (spawn cold-start, compile thrash 47%, host saturation, soft cost ceiling ≈10× under-report,
reviewer inconsistency, inter-wave dead time, post-hoc-only gating, IAM-blocked reflector).

| #   | Idea (ecc source)                                                                                                                        | Futurator pain it kills                                          | Verdict      | Effort | Impact |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------ | ------ | ------ |
| 1   | **Composite risk-score + GateGuard fact-force as the live pre-tool gate** (ecc2/observability `compute_risk`; `gateguard-fact-force.js`) | post-hoc-only gating; bypassPermissions                          | port         | M      | **Hi** |
| 2   | **Hard cost ceiling: immutable CostTracker + harness-cost bridge + model routing** (cost-aware-llm-pipeline; ecc-metrics-bridge)         | soft ceiling under-reports ~10×; Opus-for-everything             | port         | S–M    | **Hi** |
| 3   | **Dependency unblock-sweep → continuous ready-frontier dispatch** (epic-unblock; `verifyDependenciesClosed`)                             | 2–5 min inter-wave dead time                                     | port         | M      | **Hi** |
| 4   | **Worktree isolation + lock-SHA dependency-cache symlinks** (ecc2/worktree)                                                              | compile thrash 47%; host saturation; index.md write race         | port (big)   | L      | **Hi** |
| 5   | **Instinct loop (hook-captured, confidence-scored, project-scoped) → executable reflector** (continuous-learning-v2; evolve; promote)    | reflector IAM-blocked, proposals never applied/replayed          | port         | M      | **Hi** |
| 6   | **GAN adversarial loop (planner→generator→evaluator, score-gated)** (gan-\* trio)                                                        | reviewer inconsistency; over-build reaches review                | port         | L      | Med-Hi |
| 7   | **Multi-harness adapter registry + `harness:audit` parity** (ADAPTER_RECORDS; install-targets; profiles)                                 | provider-agnostic / OpenCode migration blueprint                 | port         | M      | Med-Hi |
| 8   | **Context-budget audit + content-hash cache** (context-budget; content-hash-cache-pattern)                                               | context bloat; repeated-scan tax across dev/compile              | use/port     | S–M    | Med    |
| 9   | **Meta-agents: agent-evaluator scorecard, loop-operator circuit-breakers, council, harness-optimizer**                                   | subjective review; runaway loops; ambiguous calls; static config | port/inspire | S–M    | Med    |
| 10  | **Supply-chain IOC scan + observability-readiness rubric + agent-profile inheritance**                                                   | supply-chain risk; release gating; config duplication            | use          | S      | Med    |

### The top 5, in detail

**#1 — Composite risk-score + fact-force = the smart live gate.** The jcode and SDD analyses already named
"live pre-tool gate" as move #1; ecc supplies the _intelligence_ for it. Instead of a flat allow/deny
list, score each tool call `base_tool_risk + file_sensitivity + blast_radius + irreversibility` and map to
`Allow/Review/Confirm/Block` thresholds (ecc2 `observability/mod.rs`). And replace "are you sure?" with
**fact-force**: the gate demands the agent state importers/affected-API/rollback before a risky
edit/bash. Wire both into the `pretool-gate.mjs` spike already in `spikes/ponytail/`-adjacent work and the
`PreToolUse` seam. _First step:_ port `compute_risk` scoring into `daemon/.../scope-violation-detector`'s
logic and run it pre-write, fail-open.

**#2 — Convert the soft cost ceiling to a hard one.** Three composable pieces: (a) the **immutable
`CostTracker`** dataclass (never mutates → safe under concurrency/resume), (b) the **harness-cost bridge**
(`/tmp/harness-cost-{id}.json` written by the statusline = authoritative per-process cost the daemon
reads, fixing the ≈10× under-report from `project_retrospect_audit`), (c) **model routing** Haiku<Sonnet<
Opus by task complexity (3–4× cheaper trivial work). Futurator already has cost _infrastructure_
(DynamoDB aggregator, UI) — this makes it _enforcing_, not just observing. _First step:_ add the bridge
read to the spawn wrapper + a complexity→model selector keyed on story tier.

**#3 — Kill inter-wave dead time with a ready-frontier sweep.** ecc's `epic-unblock` scans blocked epics
and promotes any whose dependencies are all closed — _exactly_ the "computed ready-frontier" the SDD doc
recommends. Replace cron-cadence wave batches with: dispatch any story whose `depends_on` are `done`, the
moment they free. This is the same idea from two independent sources; build it. _First step:_ a
`readyFrontier(graph)` over the story dependency edges, invoked at wave-merge instead of the timed gate.

**#4 — Worktree isolation with shared dep-cache (the structural fix).** ecc2 gives each session a git
worktree but **symlinks `node_modules`/`target` from the parent when the lock SHA matches** — so parallel
agents get isolation _without_ N× reinstall/recompile. That attacks compile-thrash (47%), host saturation
(no duplicate dep trees), and the index.md last-write-wins race (isolated trees + `git merge-tree`
conflict prediction + a merge queue) at once. Highest structural payoff, largest effort (touches the spawn
model). _First step:_ spike one wave running stories in per-story worktrees with lock-SHA symlinks; measure
compile time vs today.

**#5 — Close the reflector loop with instincts.** Futurator's reflector writes proposals it can't apply
(IAM-blocked). ecc's instinct system is the missing executable substrate: capture tool-use via reliable
Pre/PostToolUse hooks → confidence-scored atomic instincts (project-scoped, so app-A patterns don't bleed
into app-B) → `evolve` clusters them into skills → `promote` graduates cross-epic patterns. Feed instincts
as nodes into Mycelium (they're small, tagged, relational — ideal graph content). _First step:_ capture
epic tool-use into an `observations.jsonl`, run the clustering as the reflector's new output format.

---

## Part 3 — Where Futurator wins ecc, ORDERED BY IMPACT

1. **Strongly-consistent single source of truth.** Futurator's DynamoDB (with conditional writes for
   _atomic_ claims) beats ecc's GitHub-issue-body coordination + local SQLite cache — ecc's `claim` is
   _documented non-atomic_ (two workers can both win). Futurator already has the lock primitive ecc lacks.
2. **Deterministic, structured, automated pipeline.** epic→solutioning-gate→wave→story(dev/review/compile)
   →QA→reflector with _automated_ decomposition and _non-negotiable_ compile/QA gates vs ecc's manual
   checklist parsing and _human-invoked_ reviewers/build-resolvers.
3. **Spec-driven graph (Mycelium) with test-bound AC as drift signals** — more principled than ecc's flat
   YAML instincts. (Borrow ecc's _confidence scoring_; keep your typed graph + bound-AC completion gate.)
4. **Broader ambition: provider-agnostic, not just harness-agnostic.** ecc spans 12 _harnesses_ but all
   Claude-ecosystem runners; Futurator+Mycelium targets true _provider_ independence (Claude Max now,
   OpenCode/others later). ecc's adapter pattern is the blueprint, but your target is wider.
5. **Real cost infrastructure already deployed** — DynamoDB cost aggregator, daily refresh, UI dashboard,
   billing integration vs ecc's token-estimate tables. (Caveat: enforcement is still soft — hence Part 2 #2.)
6. **Multi-tenant isolation at the storage layer** — separate DynamoDB tables + IAM scoping per project
   vs ecc's project-hash directories.
7. **Persistent daemon + process-group lifecycle** (`child-tracker` SIGTERM→wait→SIGKILL, targeted abort)
   vs ecc's stateless per-session hooks.
8. **Lockfile-based skills federation (planned)** — git sources + version pinning is more scalable than
   ecc's in-repo monolith of 271 skills.

---

## Part 4 — The honest call

**Don't install ecc; mine ~8 patterns.** Reasons mirror the jcode verdict, plus:

- ecc is **Claude-centric** and a **JS+Python+Rust** mix — adopting it wholesale means three runtimes and a
  huge surface (271 skills / 67 agents, most domain-specific cruft for an app-factory).
- It ships **external tooling and its own telemetry/scan services** (AgentShield, advisory sources) —
  audit-around cost for an internal single-operator factory (`project_labs_tenancy_internal`).
- Several ecc mechanisms Futurator **already equals or beats** (Part 3) — you're behind only on the
  specific levers in Part 2.

**Use-directly (narrow):** the immutable `CostTracker` shape and model-routing thresholds; the risk-score
weights; the `harness:audit` parity idea; `security:ioc-scan` as a pre-release CI gate.
**Port-the-pattern (the value):** items #1–#8 in Part 2.
**Inspiration-only:** control-pane dashboard, the full GAN harness, council, the 12-harness matrix.

---

## Part 5 — Convergence: ecc reinforces the existing roadmap

The four analyses now point at one spine. ecc didn't change the plan — it _hardened_ it and filled gaps:

| Cross-analysis theme                | jcode                   | SDD/Mycelium            | ponytail                  | ecc                                        |
| ----------------------------------- | ----------------------- | ----------------------- | ------------------------- | ------------------------------------------ |
| **Live pre-tool gate is move #1**   | hook exit 0/2 fail-open | touches-edge scope      | injection seam            | **+ composite risk score + fact-force**    |
| Kill barriers → continuous dispatch | session reuse           | ready-frontier          | —                         | **+ dependency unblock-sweep**             |
| Hard cost control                   | compaction              | —                       | less code = less cost     | **+ immutable tracker + bridge + routing** |
| Close the learning loop             | memory graph            | spec drift signals      | debt ledger               | **+ instinct capture + evolve/promote**    |
| Provider-agnostic                   | provider trait          | harness-portable policy | one-builder-many-adapters | **+ adapter registry + parity audit**      |
| Worktree isolation                  | —                       | touches-driven          | —                         | **+ lock-SHA dep-cache symlinks**          |

**Net recommendation:** proceed with the pre-tool gate as the keystone (now triple-reinforced), and build
it with ecc's _risk-score + fact-force_ intelligence rather than a flat allow/deny. Then take cost
(#2), ready-frontier (#3), and worktree-cache (#4) as the next three — each kills a specifically named,
measured Futurator pain.
