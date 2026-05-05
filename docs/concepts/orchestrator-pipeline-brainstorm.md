# Orchestrator Pipeline — State of Play

**Purpose.** Shared mental model for a brainstorming session. Describes what the pipeline is *supposed* to do end-to-end, how it's currently wired, what logs/events we capture, what the UI expects to visualize, and where the design is fragile. Written to invite challenge, not to document a finished system.

**Reading time:** ~10 min. **Reference files** (click-through):

- `daemon/pipelines/epic-dev-pipeline.mjs` — orchestrator spawner
- `daemon/pipelines/templates/epic-orchestrator-prompt.md.tpl` — the system prompt
- `daemon/receiver/http-receiver.mjs` — daemon-local HTTP endpoints
- `daemon/pipelines/lib/epic-repo.mjs` — epic-workflows DDB access
- `src/components/labs/agentic-workflow/index.tsx` — UI root
- `src/components/labs/agentic-workflow/story-live-output.tsx` — Actions panel
- `src/hooks/use-agent-events.ts` — event polling
- `functions/api/index.ts` — `/api/epic-workflows/*` routes

---

## 1. The end-to-end flow, 30 seconds

```
USER intent ("simple pacman game, 2 levels")
  │
  ▼
[PM agent] ─ Claude CLI subprocess, one-shot
  │  reads intent + project context
  │  emits <epic>…</epic> XML
  ▼
[UI parser]  parses XML → ParsedEpic {title, desc, criteria, stories[]}
  │
  ▼
[Touch-point inference agent] — Claude CLI, one-shot
  │  per story: infers {touchPoints, complexity, reviewRigor}
  │  computes wave number from dependsOn DAG
  ▼
[POST /api/epic-workflows/from-xml]
  │  persists epic to futurator-epic-workflows
  │  if autoStart && all stories inferred → creates agent-jobs row
  │     with phase='epic-dev', epicDevPayload={stories, digest, rubric…}
  ▼
[Daemon poll loop] picks up PENDING job
  │  validates payload, spawns:
  │    claude -p <prompt> --model opus --output-format stream-json
  │          --permission-mode bypassPermissions
  ▼
[ORCHESTRATOR Claude CLI process]
  │  for each wave K:
  │    dispatch dev subagents (parallel, via Task tool)
  │    collect <DEV_RESULT> → dispatch senior-reviewer subagents
  │    parse <VERDICT> → APPROVE | REQUEST_CHANGES → remediate or move on
  │    POST /wave-complete at end of wave
  │    POST /story-status at every transition *(see §6 caveat)*
  │  emits <EPIC_COMPLETE> block → exits
  ▼
[Daemon] on child exit:
  │  sets job.status = COMPLETED / FAILED
  │  emits step_complete event with cost/duration/turns
  ▼
[UI] polls /api/epic-workflows/:id (5s) and
     /api/agent-jobs/:jobId/events?after=<seq> (1s while RUNNING)
```

---

## 2. Stage-by-stage

### 2.1 Intent Design — user → PM agent

- **Surface.** `src/components/labs/agentic-workflow/epic-generator.tsx`
- **Input.** App name, working dir, 5 model/effort knobs, YOLO toggle, one-line idea ("simple pacman game, 2 levels").
- **Action.** `useGenerateEpic()` POSTs `/api/epic-workflows/generate` → creates an agent-job with `phase='pm-agent'`. Daemon spawns `claude -p <pm-prompt> --output-format stream-json`.
- **Output.** A single `<epic>…</epic>` XML block streamed back as text_delta events. Includes `<title>`, `<description>`, `<criterion>` list, and a `<story id="Sn">…</story>` per story with `<title>`, `<description>`, `<dependsOn>`.
- **What the PM agent *does not* produce:** touch points, complexity, review rigor, wave numbers.

### 2.2 Epic XML → structured ParsedEpic

- **Client-side parser.** `epic-generator.tsx:parseEpicFromXml` — regex-based, tolerant to whitespace, extracts the story graph.
- **Touch-point inference.** Second Claude CLI run (`phase='touch-point-inference'`). Per story, it infers:
  - `touchPoints: string[]` — file globs the story will modify
  - `complexity: 'trivial' | 'standard' | 'complex' | 'architectural'` — drives model selection
  - `reviewRigor: 'light' | 'standard' | 'strict'` — drives reviewer depth
- **Wave computation.** `storiesWithWaves` in `functions/api/index.ts` — topological sort on `dependsOn`, assigning every story a `wave: number` (0-indexed).

### 2.3 Epic persistence + orchestrator spawn

- **Endpoint.** `POST /api/epic-workflows/from-xml` in `functions/api/index.ts:1488+`.
- **DDB write.** Row in `futurator-epic-workflows` with `stories[]`, `status='ready'` if all inferred else `'draft'`, `yoloMode` (default now `body.yoloMode !== false`).
- **Single-click flow.** If `autoStart && allInferred && useEpicOrchestrator`, the endpoint also:
  1. Builds `epicDevPayload` = {orchestratorModel, maxParallel, maxRemediationRounds, epicGoal, contextDigest, rubric, stories}.
  2. `PutItem` into `futurator-agent-jobs` with `phase='epic-dev'`, `status='PENDING'`.
  3. Returns `{epicId, orchestratorJobId}` — UI switches to live view.

### 2.4 Orchestrator process

- **Daemon poll.** `agent-daemon.mjs` polls `futurator-agent-jobs` every 3 s. On a PENDING row with `phase='epic-dev'`, it calls `runEpicDevPipeline(job, …)` from `daemon/pipelines/epic-dev-pipeline.mjs`.
- **Spawn.** `epic-dev-pipeline.mjs:253-286`:
  ```
  claude -p <renderedPrompt>
         --model opus
         --output-format stream-json
         --verbose
         --permission-mode bypassPermissions
  ```
  - `bypassPermissions` (changed from `acceptEdits` in the last iteration) is why `npm install` no longer blocks.
- **Prompt rendering.** `renderOrchestratorPrompt()` substitutes 12 `{{vars}}` into the template. The key injected variables:
  - `contextDigest` — pre-compiled project summary (README, package.json, tech-brief excerpts).
  - `rubric` — merged default + per-project overlay review rubric.
  - `storyManifestJson` — the full story array, inlined as JSON.
  - `daemonPort` — so the orchestrator can curl localhost receivers.

### 2.5 Orchestrator control flow (what the prompt asks for)

Defined in `daemon/pipelines/templates/epic-orchestrator-prompt.md.tpl`. Per wave K in ascending order:

| Step | Orchestrator action | Expected side-effect |
|---|---|---|
| 1. Claim check | Scan `touchPoints` for overlap → split into sub-waves if needed | `wave_split` event |
| 2. Dispatch devs | Invoke `Task` tool in one message, one call per story; `subagent_type` picked by complexity | `subagent_dispatch` events + `POST /story-status running` per story |
| 3. Collect dev results | Parse `<DEV_RESULT>` tags from each Task return; detect file collisions | `subagent_return` event |
| 4. Dispatch reviewers | Another `Task` batch, `subagent_type: 'senior-reviewer'`; computes `git diff` per story | `POST /story-status in_review` per story |
| 5. Collect verdicts | Parse `<VERDICT>`: APPROVE / REQUEST_CHANGES / malformed | `review_verdict` event + `POST /story-status done / fixing / failed` |
| 6. Remediation | If changes requested and attempt < max → re-dispatch dev with remediation framing → back to Step 3 | `POST /story-status fixing`, then `running` on re-dispatch |
| 7. Persist wave | `emit-event.sh wave_complete` + `curl /wave-complete` | job.waveResults[K] written |

**Parallelism cap** = `maxParallel` (default 4). Waves larger than the cap get batched.

### 2.6 Completion

Orchestrator writes `<EPIC_COMPLETE>…</EPIC_COMPLETE>` to stdout with a summary JSON (see last run's log for the shape). Process exits 0. Daemon flips `agent-jobs.status` to `COMPLETED` and pushes a `step_complete` event with `cost`, `sessionId`, `durationMs`, `numTurns`.

---

## 3. Observability — three signal channels

The orchestrator has three independent ways to tell us what happened:

### 3.1 Stream-json events (high volume)

- **Source.** Every `assistant` / `tool_use` / `tool_result` / `stream_event` token the Claude CLI emits on stdout.
- **Parsing.** `epic-dev-pipeline.mjs:processEvent` line-buffers stdout, parses JSON per line, and translates each event type into a `pushEvent()` call.
- **Storage.** `futurator-agent-events` table — partition key `jobId`, sort key `eventSeq` (monotonic int). Event shape: `{eventType, stepId, agentId, toolName?, toolInput?, toolOutput?, text?, timestamp}`.
- **Tool I/O caps.** Both `toolInput` and `toolOutput` are sliced to 2000 chars in the daemon (`epic-dev-pipeline.mjs:310,320`). Full outputs live in the stdout log file.

### 3.2 `POST /wave-complete` (one per wave)

- **Endpoint.** `daemon/receiver/http-receiver.mjs:handleWaveComplete` binds `127.0.0.1:17631`.
- **Effect.** `agent-jobs.waveResults[<K>] = {...results, epicId, persistedAt}`.
- **Why it exists.** Lets the orchestrator checkpoint per-wave verdict maps so a crashed orchestrator can resume (see `stale-heartbeat.mjs` + the `{{resumeFromWaveResults}}` prompt variable).

### 3.3 `POST /story-status` (many per story, the weakest link)

- **Endpoint.** `daemon/receiver/http-receiver.mjs:handleStoryStatus`.
- **Effect.** Updates `stories[i].status` in `futurator-epic-workflows` via `epic-repo.updateStoryStatus`.
- **Who calls it.** The orchestrator, by executing `Bash: curl …` statements the prompt tells it to emit.
- **Compliance problem.** Purely prompt-driven. In the last test run, only 1 of 9 stories got a `done` POST — Opus chose to skip or batch the others. We backfilled manually.

Plus a fourth, auxiliary channel: **heartbeats** via `POST /heartbeat`, used by the stale-job scanner to detect wedged orchestrators.

---

## 4. Subagent logging & extraction

The dev and reviewer subagents run **inside the orchestrator's process** via the Claude `Task` tool. They are not separate CLI invocations, not separate daemon jobs, not separate DDB rows. They have **no direct channel to the UI**.

### What we *do* see

- Every subagent dispatch appears as a `tool_use` event with `toolName: "Agent"` (or `"Task"`) and `toolInput` containing the subagent_type + prompt.
- The subagent's final `<DEV_RESULT>` or `<VERDICT>` block comes back as a single `tool_result` event — sliced to 2000 chars, so full diffs get truncated in DDB but survive in the orchestrator stdout log.
- Any tool the subagent uses internally (Read, Edit, Bash) does **not** emit as a distinct event — it's invisible to our observability spine, consumed only within that one `tool_result`.

### What we *don't* see

- Per-subagent step-by-step actions (Read this file, Edit that file, run `npm test`).
- Subagent token costs broken out from the orchestrator's total.
- Which files a dev actually touched (we rely on the dev declaring `filesTouched` in its structured output — trust-based).
- Reviewer's internal reasoning before the verdict — only the verdict block emerges.

### The log files on EC2

Every orchestrator run produces three files under `/var/log/futurator/events/`:

| File | Contents | Size (typical) |
|---|---|---|
| `<jobId>.orchestrator.prompt.log` | The fully-rendered prompt handed to Claude | 10–20 KB |
| `<jobId>.orchestrator.stdout.log` | Raw stream-json, every event, untruncated | 1–5 MB |
| `<jobId>.orchestrator.stderr.log` | CLI errors (empty on success) | 0–few KB |

Only reachable via SSM shell commands right now. No UI bridge yet.

---

## 5. UI expectations — what visualizes what

### 5.1 Epic header + kanban

- **Source.** `useEpicWorkflow(epicId)` hook, polls `/api/epic-workflows/:id` every 5 s.
- **Renders.** Epic title, stage pills (Concept → Development → Review → Deploy), wave tabs (`Wave 0  0/1`, `Wave 1  0/5 5P`…), story cards with status badge.
- **The story-status badge is the single visible manifestation of `/story-status` POSTs.** If the orchestrator doesn't emit, every story reads PENDING until the job finishes and we manually backfill.

### 5.2 Actions live output (`story-live-output.tsx`)

- **Source.** `useAgentEvents(jobId)` polls `/api/agent-jobs/:jobId/events?after=<lastSeq>` every 1 s while RUNNING.
- **Renders.**
  - A "latest thought" line (last 200 chars of streamed text).
  - An expandable **Actions** panel — one row per tool_use, with input/output revealable on click.
  - A **Response** panel — accumulated text_delta output, i.e., the orchestrator's narrative prose between tool calls.
- **Copy logs button** (just added) — dumps all actions expanded, with full tool inputs/outputs (truncated to 2000 chars by the daemon), ready for paste into another Claude session for deeper inspection.

### 5.3 What the UI expects that isn't reliably delivered today

- **Per-story live logs** — we don't have a per-story stream. Everything is under the orchestrator's single jobId. A story card clicked open shows nothing story-specific.
- **Timeline of waves with timings** — we have the events to synthesize this but don't render it.
- **Failed-story drill-down** — the verdict lives in a truncated tool_result; the actual review text isn't easily surfaced.

---

## 6. What works vs. what doesn't (honest list)

### Works today

- End-to-end from idea to working React/Vite app (last run: 9 stories, 4 waves, 20 min, $4.14, all approved).
- `bypassPermissions` lets `npm install` / `npm run build` proceed without gating.
- Stream-json parsing + DDB event store: the Actions panel reliably lights up within seconds of a tool call.
- `/wave-complete` checkpointing — resume from crash is wired.
- YOLO default-on at both UI and API layers.

### Fragile / inconsistent

- **Story-status POSTs are prompt-driven and unreliable.** Opus skips them, especially deep into a run. Fixing this is the highest-leverage change for UX fidelity.
- **Tool I/O truncation at 2000 chars** drops most of the reviewer's verdict, large diffs, long build logs.
- **Subagent activity is opaque.** 100% of a dev subagent's work is one tool_result blob.
- **Latency is long per wave.** Opus spends significant time on verification steps (post-dev build, cross-story overlap analysis, re-reading files). Not a bug — behavior of the current prompt.

### Missing entirely

- No UI access to the orchestrator's stdout log on EC2.
- No per-subagent cost accounting (we know total epic cost, not per-story).
- No way to interrupt or re-direct the orchestrator mid-run other than killing the job.

---

## 7. Design questions for the brainstorming session

The stated constraint: *make the pipeline truly dynamic without overloading the orchestrator's context*. Some angles worth challenging:

### 7.1 Move status emission out of the prompt

Today: orchestrator is told to curl `/story-status` for every transition. Relies on Claude following instructions in a context that's growing by the minute.

Alternative: the **daemon parses orchestrator stdout**, detects `Task` dispatches and tool_result returns, and POSTs status itself. The orchestrator stops carrying status-emission instructions entirely. Saves prompt tokens, makes status emission deterministic.

Cost: daemon now has to understand subagent_type, map Task calls to storyIds (we'd need a naming convention like `storyId: "story-3"` in the Task prompt the orchestrator must include), and parse verdicts.

### 7.2 Thin the orchestrator prompt

Today the prompt inlines the **full story manifest as JSON**, the **full context digest**, and the **full rubric**. Every wave carries all of it.

Alternatives:
- **Wave-scoped prompts.** Re-spawn the orchestrator per wave with just that wave's stories. Loses continuity but trades tokens for determinism. Heartbeats + `waveResults` already support resume.
- **Fetch-on-demand.** Orchestrator has a `GET /epic/:id/stories?wave=K` Bash command available; fetches on entry to each wave instead of inlining.
- **Rubric references instead of inlining.** Prompt points to a rubric file path; reviewer subagent reads it.

### 7.3 Elevate subagents to first-class jobs

Today: subagents are ephemeral `Task` calls inside the orchestrator's process.

Alternative: the orchestrator POSTs `/dispatch-story { storyId, ... }` to the daemon, which spawns a separate Claude CLI per story with its own jobId. The orchestrator's job becomes pure coordination (wait for all dispatches in wave K to finish, dispatch reviewers, decide remediation). Downsides: more OAuth token churn, parallel CLI processes on EC2, harder to share in-memory context. Upsides: per-story event stream, per-story cost, story-card click-in shows real activity.

### 7.4 Replace the prompt loop with a code loop

The prompt today is a ~170-line finite state machine expressed in prose. Claude interprets it each turn.

Alternative: daemon-side FSM. Daemon spawns dev subagent, gets `<DEV_RESULT>`, spawns reviewer, parses `<VERDICT>`, decides remediation — all in JS/TS. Orchestrator Claude becomes **only** the conductor-of-conductors that plans the wave graph once at the start, then steps back.

### 7.5 Streaming verdicts, not tool_result blobs

Today the reviewer emits `<VERDICT>` at the end of a long thinking trace, which comes back as one tool_result. The orchestrator has to parse prose.

Alternative: give the reviewer subagent a structured-output constraint so the verdict is always valid JSON, and bubble it up intact via an extraction event we already support.

---

## 8. Appendix — file & endpoint map

### Key files

- `daemon/pipelines/epic-dev-pipeline.mjs` — spawner + stream parser
- `daemon/pipelines/templates/epic-orchestrator-prompt.md.tpl` — system prompt
- `daemon/receiver/http-receiver.mjs` — localhost endpoints (wave-complete, heartbeat, story-status)
- `daemon/pipelines/lib/epic-repo.mjs` — epic-workflows DDB access from daemon
- `daemon/forwarder/ddb-event-store.mjs` — NDJSON→DDB event forwarder
- `functions/api/index.ts` — `/api/epic-workflows/*`, `/api/agent-jobs/*` routes
- `functions/shared/repositories/epic-workflow-repository.ts` — Lambda-side epic-workflows access
- `src/components/labs/agentic-workflow/index.tsx` — UI root
- `src/components/labs/agentic-workflow/story-live-output.tsx` — Actions panel + Copy logs
- `src/hooks/use-agent-events.ts` — events polling
- `src/hooks/use-epic-workflow.ts` — epic polling

### DDB tables involved

| Table | Purpose |
|---|---|
| `futurator-epic-workflows` | Epic definitions + stories[] with status |
| `futurator-agent-jobs` | Every job the daemon has picked up, status, waveResults |
| `futurator-agent-events` | Event stream (one row per emitted event) |

### Endpoints

| Endpoint | Purpose |
|---|---|
| `POST /api/epic-workflows/generate` | Intent → PM agent job |
| `POST /api/epic-workflows/from-xml` | Persist epic + optionally spawn orchestrator |
| `GET /api/epic-workflows/:id` | Fetch epic (UI polls every 5s) |
| `PATCH /api/epic-workflows/:id` | Update epic (YOLO toggle, etc.) |
| `GET /api/agent-jobs/:jobId/events?after=N` | Event tail (UI polls every 1s while RUNNING) |
| `POST http://localhost:17631/wave-complete` | Orchestrator checkpoint |
| `POST http://localhost:17631/story-status` | Story status flip |
| `POST http://localhost:17631/heartbeat` | Liveness signal |

### Log files on EC2

All under `/var/log/futurator/events/`:
- `<jobId>.orchestrator.prompt.log`
- `<jobId>.orchestrator.stdout.log`
- `<jobId>.orchestrator.stderr.log`

Reachable today only via `aws ssm send-command`. A `/api/ec2/orchestrator-log/:jobId` endpoint would be a small addition.
