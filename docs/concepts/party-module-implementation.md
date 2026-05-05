# Party Module — Implementation Notes

**Status:** Shipped to production 2026-04-20. Stock BMAD 6.3.0 roster (6 agents) works end-to-end. Custom-agent overlay deferred.
**Primary spec:** [tech-spec-party-module.md](../tech-spec-party-module.md) + [epics-party-module.md](../epics-party-module.md) + 3 stories under `docs/stories/15-*.md`.
**Status file entries:** `sprint-status.yaml` — Epic 15 (`15-1`, `15-2`, `15-3` at `review`).

This document is the **operational-truth + gotchas** reference. Intended for a future session to pick up and continue improving without rediscovering what we already hit. Not a design doc.

---

## 1. What it does

A new **Party tab** in `/labs` lists EC2 project folders under `/home/ubuntu/projects/`, lets the operator one-click install BMAD into any of them, then open a multi-agent "Party Mode" chat scoped to that project. Each user message spawns real BMAD subagents (Mary/John/Winston/Sally/Amelia/Paige) via the Claude Code `bmad-party-mode` skill; the agents debate the topic as independent thinkers, not one LLM wearing hats.

**Proven flow (2026-04-20):** Install BMAD on `solitaire` → send *"lets debate about creating a scoring system"* → John (Product Manager) responded with "before we debate *how* to score, ask *why*" and broke the user base into Casual-Player vs Competitive-Player personas with different needs. That's the target behavior.

---

## 2. Architecture (layered view)

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER — admin.futurator.ai/labs (Next.js static export)          │
│  src/components/labs/party/  ·  src/hooks/use-party-*.ts            │
│       │                                                              │
│       ▼  POST /api/party/...                                         │
└───────┼─────────────────────────────────────────────────────────────┘
        │
┌───────┼─────────────────────────────────────────────────────────────┐
│  LAMBDA — rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1     │
│  functions/api/index.ts  (Hono app, ~3300 LOC single file)          │
│       │                                                              │
│       ▼  PutItem / UpdateItem                                        │
└───────┼─────────────────────────────────────────────────────────────┘
        │                                                               ▲
        │                                                               │
┌───────▼──────────────────────────────────┐   ┌────────────────────────┴──────┐
│  DynamoDB                                │   │  Claude-party-mode skill      │
│  futurator-party-projects  (PK projectId)│   │  (reads config + manifest     │
│  futurator-party-sessions  (PK sessionId,│   │   from _bmad/_config/...)     │
│                             GSI projectId│   └──────────┬────────────────────┘
│  futurator-agent-jobs      (shared)      │              │ invoked as subagents
│  futurator-agent-events    (shared,      │              │
│                             event log)   │   ┌──────────▼────────────────────┐
└───────┬──────────────────────────────────┘   │  Claude Code CLI               │
        │ PENDING jobs polled by daemon         │  `claude -p --resume <sid>`    │
        ▼                                       │  cwd=/home/ubuntu/projects/... │
┌─────────────────────────────────────────┐    └──────────▲────────────────────┘
│  EC2 daemon — /opt/futurator-daemon/    │               │ spawn
│  agent-daemon.mjs (polls DDB)           │               │
│  pipelines/party-bootstrap.mjs          │───────────────┘
│  pipelines/party-inspector.mjs          │  (one child per turn, --resume for turn N)
│  pipelines/party-turn.mjs               │
│  pipelines/lib/bmad-install.mjs         │
└─────────────────────────────────────────┘
```

Boundaries:

- **Lambda never touches the EC2 filesystem.** All filesystem work (`npx bmad-method install`, reading the manifest) happens on EC2 via the daemon.
- **Daemon never calls Lambda.** Daemon only reads/writes DDB.
- **Claude is only spawned on EC2.** Never in Lambda.

---

## 3. Data model

### `futurator-party-projects`

| Attribute | Type | Notes |
|---|---|---|
| `projectId` | S (PK) | Regex `^[a-z0-9][a-z0-9-]{0,63}$` |
| `path` | S | `${PROJECTS_ROOT}/${projectId}` — denormalized |
| `bmadStatus` | S | `MISSING` \| `INSTALLING` \| `HEALTHY` \| `DRIFTED` \| `CORRUPTED` \| `FAILED` |
| `bmadVersion` | S? | `6.3.0` after install |
| `customAgentsSHA` | S? | `n/a-6.3.x` on 6.3.x (placeholder; real SHA only on legacy layout) |
| `agentCount` | N? | Row count in `_bmad/_config/agent-manifest.csv` (6 for stock install) |
| `expectedAgentCount` | N | Static `23` for now — **unused by inspector since switching to floor-based verify** |
| `lastInspectedAt` | S? | ISO timestamp |
| `lastBootstrapJobId` | S? | Most recent bootstrap job — useful for UI progress-poll |
| `failureReason` | S? | Set when status is `FAILED`, includes which step threw |
| `createdAt` / `updatedAt` | S | ISO |

### `futurator-party-sessions`

| Attribute | Type | Notes |
|---|---|---|
| `sessionId` | S (PK) | UUID v4 |
| `projectId` | S | FK-ish (no referential constraint) |
| `projectPath` | S | Denormalized `${PROJECTS_ROOT}/${projectId}` |
| `claudeSessionId` | S? | **Null until Claude's `system.init` stream event fires on turn 1.** After that, persisted via conditional `attribute_not_exists` update so subsequent turns can `--resume`. |
| `status` | S | `ACTIVE` \| `PROCESSING` \| `IDLE` \| `ERROR` \| `ARCHIVED` |
| `turnCount` | N | Increments per successful turn |
| `lastTurnAt` | S? | ISO |
| `topic` | S? | Optional user-set label |
| `bmadVersionAtStart` | S | Pinned at session create |
| `GSI1PK` / `GSI1SK` | S | `projectId` / `createdAt` — for "sessions by project, newest first" |

### `futurator-agent-events` (shared)

Events are keyed by `jobId` for bootstrap jobs and by `sessionId` for turn jobs. Both UIs poll the same endpoint; disambiguation is by `eventType` prefix:

- `party.bootstrap.step.{started,output,completed,failed}` / `party.bootstrap.{completed,failed}`
- `party.inspect.{completed,drift.detected}`
- `party.turn.{user,assistant.token,assistant.agent,completed,error,awaiting_user}`

---

## 4. Bootstrap pipeline (8 steps)

`daemon/pipelines/party-bootstrap.mjs` — orchestrates `npx bmad-method install` + custom-agent seeding.

| Step | 6.3.x behavior | Legacy 6.0.x behavior |
|---|---|---|
| 1. `validate` | Asserts `projectPath` under `PROJECTS_ROOT` + exists | same |
| 2. `refresh-source` | `git fetch && reset --hard` on `/home/ubuntu/bmad-agents-source/` IF `.git` exists; skips silently if not (our source was rsynced, not cloned) | same |
| 3. `bmad-install` | `npx bmad-method@6.3.0 install --directory <path> --modules core,bmm,cis --tools claude-code --yes` | Same command, but v6.0.0-alpha.7 only accepted `-h`. **Pinned to 6.3.0.** |
| 4. `sync-agents` | **SKIPPED** — emits `skipped — BMAD 6.3.x manages agents via Claude Code skills; custom-agent sync deferred`. Target was `bmad/agents/`; 6.3.x ignores that dir. | rsync `/home/ubuntu/bmad-agents-source/bmad/agents/` → `<project>/bmad/agents/` |
| 5. `rebuild-manifest` | **SKIPPED** — reads BMAD-generated `_bmad/_config/agent-manifest.csv` and counts rows | Our RFC-4180 CSV writer globs `bmad/**/agents/*.md`, parses `<agent>` XML, writes CSV |
| 6. `compute-sha` | **SKIPPED** — placeholder `n/a-6.3.x` | SHA256 of sorted-concat `bmad/agents/**/*.md` |
| 7. `verify` | Floor check: `rowCount >= 5` (BMAD 6.3.0 stock ships 6 agents) | Floor check (was strict equality with `expectedAgentCount` before 2026-04-20 fix) |
| 8. `persist` | Writes `bmadStatus='HEALTHY'`, `bmadVersion`, `agentCount`, `customAgentsSHA` to DDB row | same |

**Detection:** `isNewLayout = existsSync('<path>/_bmad/_config/agent-manifest.csv')`. Decided post-install, after step 3 writes the filesystem.

**Idempotency:** Re-running on a HEALTHY project triggers BMAD's "Quick update complete!" branch — it compares versions, detects no change, exits ~fast. Then steps 4-6 skip, step 7 passes, step 8 writes the same row. Safe to click Install BMAD repeatedly.

---

## 5. Turn pipeline (critical detail: **single-line prompt**)

`daemon/pipelines/party-turn.mjs`

```js
// Turn 1 — Claude is fresh; we invoke the skill via slash-command
const prompt = isFirstTurn
  ? `/bmad-party-mode ${content}`   // ← SPACE, not newline
  : content;                         // ← turn N just sends the message

// Spawn args
claude -p
  --output-format stream-json
  --verbose
  --permission-mode acceptEdits
  [--resume <claudeSessionId> on turn N ≥ 2]
```

Critical gotcha we hit: `/bmad-party-mode\n\n<message>` (separate lines with blank line) makes Claude hallucinate *"I don't have a skill called bmad-party-mode"* — even though the skill IS in the `slash_commands` and `skills` lists from the `system.init` event. Claude's slash-command parser in `-p` mode wants `<command> <args>` on one line. Single-line form reliably invokes the skill.

Watch for this same pattern if you add other skill invocations to the daemon. `claude -p "/skill arg1 arg2"` works; `claude -p "/skill\n\narg1"` does not.

### Capturing `claudeSessionId`

Turn-1 is the only time we learn the Claude session UUID. Stream-json shows:

```json
{"type":"system","subtype":"init","cwd":"...","session_id":"8e4e778a-...","tools":[...],"skills":[...]}
```

The daemon parses each NDJSON line; on the first `system.init` it calls:

```js
await setClaudeSessionId(sessionId, parsed.session_id);
```

...which is an `UpdateItem` with `ConditionExpression: attribute_not_exists(claudeSessionId)`. If Claude emits init twice (we've seen this on retry/resume), the second call is a no-op.

On turn N ≥ 2, we append `--resume <claudeSessionId>`. Claude reads its own on-disk session store (`/home/ubuntu/.claude/...`) and continues. **We never re-send the `/bmad-party-mode` prefix** — it's a turn-1-only thing.

### Session locking

Every message attempt does a conditional `SET status = 'PROCESSING'` with `ConditionExpression: status IN ('ACTIVE', 'IDLE')`. If already PROCESSING, returns 409 `SESSION_BUSY` to the UI. On turn finish: status goes `ACTIVE`; on error: `ERROR`; on timeout (180s watchdog → SIGTERM → SIGKILL): `ERROR` with reason `TIMEOUT`.

---

## 6. Claude Code skill format (6.3.x) — the mental model

Install puts the skill at `<project>/.claude/skills/bmad-party-mode/SKILL.md` (single file, ~8 KB). Frontmatter:

```markdown
---
name: bmad-party-mode
description: 'Orchestrates group discussions between installed BMAD agents...'
---
# Party Mode
...
```

When Claude Code starts in that project cwd, skill is auto-loaded. User-visible invocations:

1. `/bmad-party-mode [args]` — slash-command (we use this from the daemon).
2. Natural language: "invoke bmad-party-mode" or "let's have a party-mode discussion". Claude's skill-description matcher picks it up.

**What the skill does internally** (relevant excerpts):

1. Loads `{project-root}/_bmad/core/config.yaml` for `user_name`, `communication_language`.
2. Reads `{project-root}/_bmad/_config/agent-manifest.csv` — stock install produces 6 rows.
3. Searches for `**/project-context.md` (absent by default; we don't seed one).
4. Welcomes user, lists roster.
5. For each user message: picks 2-4 agents, **spawns each as a real Claude Code subagent via the Agent tool**, collects their responses, presents in full.

So: our outer `claude -p` process is the *party orchestrator*. Each message round spawns N sub-Claude processes (via Agent tool) in parallel. Stream-json reports each subagent as `task_started` / `task_progress` events.

---

## 7. UI surface

`src/app/labs/page.tsx` — 3-tab Labs layout, Party is tab #3. Component tree:

```
Party (src/components/labs/party/index.tsx)
├── ProjectList (left pane, 2-col grid on desktop)
│   ├── ProjectStatusBadge — 6-state color (HEALTHY/DRIFTED/MISSING/INSTALLING/FAILED/CORRUPTED)
│   └── per-card primary action varies by status
├── BootstrapProgress (right pane when any project INSTALLING)
│   ├── 8 pipeline steps with per-step status dots
│   └── collapsible raw-output accordion
└── SessionChat (right pane when a session is active)
    ├── SessionHeader (project name, turn count, Close)
    ├── Turn thread (user right-aligned; agent blocks left, split on **Agent:** markers)
    ├── awaiting_user callout when Claude emits that event
    └── Textarea + 8KB-byte counter + Cmd+Enter-to-send
```

State (Zustand, `src/stores/party-store.ts`): `selectedProjectId`, `activeSessionId`, `draftMessage`. Ephemeral; not persisted.

Polling intervals:

- Project list: 2s while any project `INSTALLING`, else stopped.
- Bootstrap events: 1.5s while no terminal event received; stops on `.completed` or `.failed`.
- Session + session events: 1.5s while session `PROCESSING`; stops otherwise.

---

## 8. IAM + auth — where permissions live

Two layers, both required:

| Role | Managed by | DynamoDB resource list |
|---|---|---|
| Lambda API (`ApiRole`) | SST (auto via `link: [partyProjectsTable, partySessionsTable]`) | ✓ |
| EC2 instance (`develope-it-ec2-ssm`) | Externally — inline policy `dynamodb-access` | **Must be manually extended when adding a table the daemon writes to** |

The EC2 role's `dynamodb-access` policy had to be manually updated on 2026-04-20 to add `futurator-party-projects`, `futurator-party-sessions`, and `futurator-party-sessions/index/*`. See Gotcha §11.3.

**Claude OAuth:** The daemon reads `/home/ubuntu/.claude/.credentials.json` at startup and on SIGUSR1. It has a 5-min auth probe that hits Anthropic's API. When stale, the operator clicks the **Re-auth** button in the Labs header which calls `mac-oauth-server.mjs` on the Mac at `127.0.0.1:9876` — that server reads fresh OAuth from the Mac Keychain and pushes it to EC2 via SSM Send Command. The Re-auth button is now **always visible** on EC2 mode (not just when the probe reports `auth expired`), because we observed the probe can say OK while the actual `claude -p` subprocess still hits 401. See Gotcha §11.5.

---

## 9. Public API surface

Under `functions/api/index.ts`, all routes under `/api/party/*` require JWT via the existing `authMiddleware`:

| Route | Purpose |
|---|---|
| `GET    /api/party/projects` | List all party projects from DDB (cache-first) |
| `GET    /api/party/projects/:id` | Single project row |
| `POST   /api/party/projects/:id/bootstrap` | Enqueue `party-bootstrap` job. Body: `{forceReinstall?}`. Acquires bootstrap lock (409 `BOOTSTRAP_IN_PROGRESS` if contended) |
| `POST   /api/party/projects/:id/inspect` | Enqueue `party-inspect` job |
| `POST   /api/party/sessions` | Create a session on a HEALTHY project. Body: `{projectId, topic?}` |
| `GET    /api/party/sessions/:id` | Single session row |
| `GET    /api/party/projects/:projectId/sessions` | List sessions for a project via GSI1 |
| `POST   /api/party/sessions/:id/messages` | Send a turn. Body: `{content}` (8 KB cap). Acquires session lock (409 `SESSION_BUSY`) |
| `GET    /api/party/sessions/:id/events?after=<seq>` | Poll events for a session (events keyed by sessionId, not jobId) |

Daemon polls `futurator-agent-jobs` for jobs with `jobType IN ('party-bootstrap','party-inspect','party-turn')`. Router at `daemon/pipelines/job-router.mjs`.

---

## 10. Environment & infrastructure

**EC2 host paths (Ubuntu):**
- `/home/ubuntu/projects/<id>/` — project root for Party sessions
- `/home/ubuntu/bmad-agents-source/` — rsync'd copy of this admin repo's `bmad/` subtree; lives there for Path 3 custom-agent work (currently unused by 6.3.x pipeline)
- `/opt/futurator-daemon/` — daemon code, running as systemd unit `futurator-daemon.service` (user: `ubuntu`)

**Daemon env defaults** (override in `/opt/futurator-daemon/.env`):

```
PARTY_PROJECTS_TABLE=futurator-party-projects
PARTY_SESSIONS_TABLE=futurator-party-sessions
PROJECTS_ROOT=/home/ubuntu/projects
BMAD_VERSION=6.3.0
BMAD_AGENTS_SOURCE=/home/ubuntu/bmad-agents-source/bmad/agents
BMAD_AGENTS_SOURCE_REPO=/home/ubuntu/bmad-agents-source
PARTY_EXPECTED_AGENT_COUNT=6
```

**Deploy/update cycle:**

1. Code change in `daemon/pipelines/party-*.mjs` or `daemon/agent-daemon.mjs`
2. `./scripts/rsync-daemon.sh` (or `--dry-run` first to preview)
3. Wait ~2 seconds for rsync file writes to settle (see Gotcha §11.4)
4. `ssh ubuntu@... 'sudo systemctl restart futurator-daemon'`
5. `ssh ubuntu@... 'sudo tail -n 20 /var/log/futurator-daemon.log'` to confirm clean restart

**Code change in `functions/api/index.ts` or frontend:** `npx sst deploy --stage production`. Deploy usually takes 3-5 minutes; sometimes the CloudFront invalidation step fails with a DNS flake — re-run `aws cloudfront create-invalidation --distribution-id EEO2UH2R6JW79 --paths "/*"` manually if needed.

---

## 11. Gotchas — keep this section; each one cost real time

### 11.1 BMAD version matters, a lot

Pinning to `6.0.0-alpha.7` (what the admin repo's `bmad/_cfg/manifest.yaml` had) seemed principled but that alpha's CLI only accepts `-h`. **All install flags (`--directory`, `--modules`, `--tools`, `--yes`) were added in 6.3.0.** `@latest` currently resolves to 6.3.0 but pin to `6.3.0` explicitly so upgrades are deliberate. When bumping, always re-verify via EC2:

```bash
cd /tmp && npx -y bmad-method@<new-version> install --help
```

### 11.2 BMAD 6.3.0 restructured the filesystem

Old layout (6.0.x): `bmad/_cfg/agent-manifest.csv`, `bmad/{core,bmm,cis}/agents/`.
New layout (6.3.x): `_bmad/_config/agent-manifest.csv`, `_bmad/{core,bmm,cis}/`, plus `.claude/skills/bmad-*/SKILL.md` (51 skills). **Stock agents are now Claude Code skills, not files under `bmad/`.** Custom agents are supposed to be installed as proper modules via `--custom-source <git-url>` with a `manifest.yaml` — our rsync-into-`bmad/agents/` approach is for the old layout and is ignored by 6.3.x. Hence the "deferred custom-agent overlay" comment everywhere. Path 3 work unblocks the 8-agent extension.

### 11.3 Two IAM surfaces need updating per new DDB table

Adding a new DDB table that the daemon writes to requires updating **both**:

1. `sst.config.ts` Lambda `link:` list (automatic — SST manages)
2. The EC2 instance role `develope-it-ec2-ssm` inline policy `dynamodb-access` — **manual**, via `aws iam put-role-policy`. Policy is resource-explicit (not wildcarded), so each new table ARN must be listed. Forgetting this → daemon's `UpdateItem` fails with `is not authorized to perform: dynamodb:UpdateItem` even though the Lambda has access.

Symptom: bootstrap pipeline's `persist` step fails *after* all other steps succeed.

### 11.4 Rsync + daemon restart race

If you run `rsync ... && ssh ... systemctl restart` in near-parallel (two background tasks in one go, or two close-together commands), the new daemon process may start reading modules from disk *before* rsync finishes writing the file. Result: daemon runs old code despite file on disk being correct — confirmed md5sums match but runtime behavior is old.

**Always** sequential: rsync finishes → `sleep 2` → restart. `scripts/rsync-daemon.sh` currently does rsync only; restart is a separate step.

### 11.5 Claude OAuth token probe can lie

The daemon's 5-minute auth probe can return OK while an actual `claude -p` subprocess invocation hits `401 Invalid authentication credentials`. The mechanisms behind the probe and the subprocess's own token read can diverge briefly around token expiry.

Consequence for UI: the green `✓ oauth` badge is not a reliable gate for "messaging will work". We made the **Re-auth button always visible** in `ec2-toggle.tsx` when on EC2 mode, not conditional on `authBroken`. If a turn returns 401, user clicks Re-auth and retries — round-trip is ~3 seconds because the Mac helper (`scripts/mac-oauth-server.mjs`, PID typically 5734) is already running on the Mac.

### 11.6 Slash-command prompt format

`/bmad-party-mode <content>` on a single line → skill invoked.
`/bmad-party-mode\n\n<content>` (blank line) → Claude hallucinates *"I don't have that skill"* and does its own thing. See §5. This only matters for turn 1; turn N ≥ 2 just sends `<content>` with `--resume`.

### 11.7 `expectedAgentCount = 23` is a vestigial field

The DDB schema still has `expectedAgentCount: 23` (from the original 15 stock + 8 custom vision). The bootstrap `verify` step no longer gates on this — it uses a `MIN_REASONABLE_ROW_COUNT = 5` floor. On 6.3.x stock you get 6 agents, which passes. The frontend still shows `expected agents: 6` in the grid header (hardcoded constant in `src/types/party.ts` = 6). Don't delete `expectedAgentCount` yet — Path 3 (custom-agent integration) will need to bring it back as a moving target.

### 11.8 `customAgentsSHA: 'n/a-6.3.x'` is a placeholder

On 6.3.x we have no custom agents synced, so SHA is a fixed string. Inspector's drift-detection code compares `installedSHA` vs `expectedSHA`; on 6.3.x the expected-SHA is always `null` (source dir has no files that the inspector should be hashing), so drift detection never fires. Fine for now because we're not syncing custom agents; matters for Path 3.

### 11.9 Sessions can leak as `ERROR` with no recovery

If a turn times out or 401s, session goes to `ERROR`. The UI's "send message to recover" hint works only if the root cause was OAuth/timeout — for persistent issues (wrong prompt format, stale pipeline code), it just fails again. There's no automatic resume logic. Operator-friendly recovery: click **Close** to clear UI state, click **New Party** for a fresh session.

---

## 12. Where to continue (improvement roadmap)

Listed roughly in order of value-per-effort:

### 12.1 Auto-clear errored sessions

When a session goes `ERROR`, UI should either:
- auto-close with a visible reason banner, or
- offer "Start fresh session on this project" as a single click

Current behavior: session stays visible, user reads a cryptic `NON_ZERO_EXIT` message and has to click Close themselves. Small UX improvement, probably ~1 hour.

### 12.2 Kill orphaned subagent processes on session close

Close button currently just updates UI state. The Claude subprocess running in the daemon keeps going (subagents keep exploring, using tokens). Adding a proper server-side `DELETE /api/party/sessions/:id` that:
- transitions session to `ARCHIVED`
- finds the running `party-turn` job in `futurator-agent-jobs`
- SIGTERMs the child process
- emits a `party.turn.aborted` event

Estimated ~1 day; cleanest form requires the daemon receiver to expose a per-session abort endpoint.

### 12.3 Custom-agent overlay (Path 3 from recovery plan)

The 8 custom agents (Ludwig, Rick, Pedrock, Dave ups!, Sean Tinel, Nimbus, Kube Rick, Sue Render) are currently invisible in Party Mode. Two implementation paths:

- **(a) Convert to 6.3.x module format** — each agent becomes a `.agent.yaml` + proper module with `manifest.yaml`. Install via `--custom-source /home/ubuntu/bmad-agents-source` flag at `bmad-install` step. BMAD's installer extends `_bmad/_config/agent-manifest.csv` with the new rows. Target: 6 + 8 = 14 agents in the roster.

- **(b) Directly append rows to `_bmad/_config/agent-manifest.csv`** post-install (keep our `rebuild-manifest.mjs` logic for this). Skip BMAD's custom-module ceremony; pay the cost that we own the CSV format matching BMAD's schema across future versions.

(a) is more future-proof; (b) is faster. Leaning (a) for next session. ~1-2 days of work including agent-file rewrites.

### 12.4 Re-sync flow for DRIFTED projects

Currently when a project drifts (custom agents source changed), we show a `DRIFTED` badge and a "Re-sync agents" button. On 6.3.x that button re-runs the bootstrap pipeline which is essentially idempotent — so it mostly works. But the DRIFTED state can never actually fire on 6.3.x (see Gotcha §11.8). This becomes active when Path 3 lands.

### 12.5 Export-to-PM-epic handoff

Original tech-spec §"Out of Scope" item 1: at the end of a productive party discussion, one-click to write a conversation summary + decisions to `projects/<id>/docs/party-<sessionId>-summary.md`. Then the agentic-workflow epic generator can be seeded with that file instead of a raw one-liner.

Clean design: add a menu item on `SessionHeader`, call a new `POST /api/party/sessions/:id/export`, daemon writes the file via `fs.writeFile`, emits an event with the path. Operator hand-copies to agentic-workflow or we add a direct hand-off button.

### 12.6 Cost accounting per session

Stream-json emits `usage.output_tokens` and `cache_*` counts per assistant message. The daemon is already forwarding all stream-json lines as events; a simple reducer over `party.turn.*` events with `usage` fields → per-session cumulative cost. Surface on `SessionHeader`. Useful especially since party-mode spawns N subagents per turn and costs add up fast. Half-day of work.

### 12.7 Pre-seed `project-context.md`

The party-mode skill looks for `**/project-context.md` and passes it to subagents as background context when relevant. We never seed one. A "generate project context" button on the project card that runs `bmad-generate-project-context` (another Claude Code skill — it exists in the install list) would bootstrap better responses.

### 12.8 Migrate our custom orchestration to skill invocations

Broader strategic direction: many skills in the 51-skill install (`bmad-create-prd`, `bmad-dev-story`, `bmad-create-epics-and-stories`, `bmad-code-review`, etc.) are exactly what our `agentic-workflow` Labs module does via explicit step pipelines today. Party Mode proves the pattern of "daemon invokes `claude -p /<skill-name> <args>` with the right cwd" works reliably. If we like it, we can consolidate more of Labs around the skill model rather than our own step DSL.

Caveat: see `docs/recovery-orchestration-plan.md` — the user explicitly wants **explicit step-based control** for epic-dev, not skill-driven orchestration. So this direction is Party-module-internal, not a replacement for the orchestration-recovery work.

### 12.9 Multi-user concurrency

Currently single-operator (Richie). `createdBy` is stored on jobs but nothing enforces session ownership. If the operator count ever grows, add session-level ACL + maybe friendlier user names in agent manifest (`user_name: Ubuntu` is the OS default, not pretty).

### 12.10 Testing on EC2 dev project

We have a `party-test` naming convention we mentioned in the original tech-spec. Currently we've tested exclusively against `solitaire`. Good practice: create `/home/ubuntu/projects/party-test/` with a minimal empty project, use it as the reference "always-working" smoke test. Documented here so we don't lose track.

---

## 13. Key files to read first (for a future session)

```
docs/tech-spec-party-module.md         ← original spec
docs/epics-party-module.md             ← 3 stories, scope
docs/stories/15-{1,2,3}-*.md           ← story details + AC + file lists
docs/recovery-orchestration-plan.md    ← context for broader orchestration direction

daemon/pipelines/party-bootstrap.mjs   ← 8-step orchestration (main loop)
daemon/pipelines/party-turn.mjs        ← single-line prompt + --resume logic
daemon/pipelines/party-inspector.mjs   ← status classification (6 states)
daemon/pipelines/lib/bmad-install.mjs  ← npx wrapper (idempotency branch)
daemon/agent-daemon.mjs                ← dispatch (JOB_HANDLER_PARTY_*)

functions/api/index.ts (line ~3100+)   ← /api/party/* routes
functions/shared/repositories/party-*  ← DDB repositories
functions/shared/types/party.ts        ← shared types

src/components/labs/party/             ← all UI components
src/hooks/use-party-*.ts               ← 4 hooks
src/stores/party-store.ts              ← Zustand slice
src/app/labs/page.tsx                  ← tab registration

scripts/rsync-daemon.sh                ← daemon deploy helper
scripts/mac-oauth-server.mjs           ← local OAuth helper (runs on Mac)
```

---

## 14. Environment snapshot at shipping

- **Date:** 2026-04-20
- **BMAD:** 6.3.0
- **Claude Code CLI:** 2.1.101
- **Node:** 22.22.2 on EC2
- **Stock agent roster in install:** Mary (Analyst), John (PM), Sally (UX), Winston (Architect), Amelia (Dev), Paige (Technical Writer)
- **EC2 instance:** `i-0826d68c316ae97dd`, Ubuntu, `ec2-54-86-226-233.compute-1.amazonaws.com`
- **Lambda URL:** `https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws/`
- **Static site:** `https://admin.futurator.ai/labs/`
- **DDB tables:** `futurator-party-projects`, `futurator-party-sessions` (both PAY_PER_REQUEST, no PITR — session events are ephemeral by design)
- **CloudFront:** `EEO2UH2R6JW79`
- **First successful party-mode run:** `solitaire` project, topic "scoring system", John (PM) led with product-thinking challenges before mechanics debate

---

## 15. Custom agents — how to bring them to the party (deferred Path 3)

The 8 custom agents (Ludwig, Rick, Pedrock, Dave ups!, Nimbus, Sean Tinel, Kube Rick, Sue Render) are invisible to BMAD 6.3.x's stock install. Authored for the old 6.0.x format (`<agent>` XML in `.md`), they sit dead in `bmad/agents/` after rsync. This section is the plan + warnings for getting them into Party Mode's roster.

### 15.1 How party-mode actually uses the manifest (insight)

Reading the skill's source at `<project>/.claude/skills/bmad-party-mode/SKILL.md` carefully:

> "Read the agent manifest at `{project-root}/_bmad/_config/agent-manifest.csv`. Build an internal roster of available agents with their `displayName`, `title`, `icon`, `role`, `identity`, `communicationStyle`, and `principles`."
>
> "For each selected agent, spawn a subagent using the Agent tool. Each subagent gets: {agent prompt built from the manifest data}"

**Critical insight:** the skill consumes *only seven manifest fields* to build the per-subagent prompt. It does **not** dereference `path`, does not load any additional agent-specific files, does not expect a SKILL.md per agent. **An agent in party-mode is literally a CSV row** — persona data + a name + an icon. Everything that makes Rick sound like Rick lives in the `identity` + `communicationStyle` + `principles` strings.

This is profoundly useful. It means we don't need BMAD's full "custom module" ceremony to add agents. We just need rows in the CSV.

### 15.2 Three paths to add custom agents, ranked

#### Path 3a — Proper BMAD custom module (official)

- Rewrite each of the 8 agents as a `.agent.yaml` file in the new 6.3.x YAML format.
- Wrap the 8 into a proper BMAD module with its own `manifest.yaml`, `module-help.csv`, etc.
- At `bmad-install` time, pass `--custom-source /home/ubuntu/bmad-agents-source` (which is already prepared on EC2 with the admin repo's `bmad/` subtree).
- BMAD's installer extends `_bmad/_config/agent-manifest.csv` with the new rows, registers the skills.

**Pros:** Official path. Survives BMAD upgrades if they honor the public custom-module contract.

**Cons:** The custom-module format is sparsely documented outside the BMAD repo itself. ~1-2 days rewriting agents, then at least a day trial-and-erroring the installer. Also: if BMAD's installer has special handling for the `agents` module name (our current module ID is the literal string `"agents"`), we may get weird merge behavior.

#### Path 3b — Direct CSV injection (pragmatic, recommended)

- Bootstrap pipeline gains a new step between `rebuild-manifest` and `verify`:
  1. Parse BMAD-generated `_bmad/_config/agent-manifest.csv` (6 rows + header).
  2. For each custom agent in `/home/ubuntu/bmad-agents-source/bmad/agents/<name>/<name>.md`:
     - parse our existing `<agent>` XML block (we already have a parser — `_internals.extractAgentAttrs` + `extractTag` in `daemon/pipelines/lib/rebuild-manifest.mjs`).
     - emit one CSV row in the 12-column 6.3.x schema.
  3. Write the combined CSV back.
- Idempotent: re-running post-install overwrites with fresh content; if BMAD's update changes stock rows, ours append cleanly.

**Pros:** ~1 day of work. No new tech to learn. Full control over persona content. We can even add runtime-filtered rosters (e.g., "only Dev agents for this project type").

**Cons:** Riding outside BMAD's contract. If BMAD 6.4 adds a 13th column or renames one, our injector outputs schema-mismatched rows and party-mode breaks. Also: the `path` column points to a directory BMAD expects to exist; if BMAD or any other skill ever tries to open that path, they'll 404.

#### Path 3c — Own the orchestrator prompt (max control)

- Stop invoking `/bmad-party-mode` entirely.
- `party-turn.mjs` reads personas directly from our `bmad-agents-source/` + the BMAD-generated stock rows.
- Builds a single giant orchestrator prompt with the roster inlined.
- Spawns one `claude -p` with that prompt. Claude does roster picking + subagent spawning with no BMAD skill dependency.

**Pros:** Total control — we could even pre-select voices per topic, run solo-mode-by-default, customize the output format.

**Cons:** We re-implement ~8KB of carefully-tuned skill prompt logic. Miss nuances like rotation, cross-talk handling, orchestrator notes, the "ask the user" protocol. Also loses the zero-maintenance benefit of riding on BMAD's evolving skill. Not recommended unless we outgrow BMAD's model.

### 15.3 My recommendation: Path 3b, one-day sprint

Plan sketch (no code yet, just design intent):

1. **New helper** `daemon/pipelines/lib/inject-custom-agents.mjs`:
   - Input: path to the 6.3.x CSV + path to custom-agent source dir.
   - Parse stock CSV (use a real CSV lib, or carefully handle quoted multi-line fields — several stock rows have newlines inside `principles`).
   - Parse each custom `.md`'s `<agent>` XML + persona tags.
   - Emit additional 12-column rows with:
     - `name` = `bmad-agent-<our-name>` (prefix convention? or use raw name like `rick-innovation`)
     - `displayName` = from XML `name` attribute (e.g., "Rick")
     - `title` = from XML `title` attr
     - `icon` = from XML `icon` attr
     - `capabilities` = short comma-list (generated from the role, or explicit field added to agent `.md` files)
     - `role` / `identity` / `communicationStyle` / `principles` = from inner tags
     - `module` = constant `custom`
     - `path` = `_bmad/agents-custom/<name>` (create an empty dir there so BMAD doesn't choke if it checks)
     - `canonicalId` = empty
   - Write back combined CSV with `rebuildManifest`-style RFC 4180 quoting.

2. **Bootstrap integration** — after step 5 (`rebuild-manifest`), add step 5.5 (`inject-custom-agents`, skippable via env var `PARTY_CUSTOM_AGENTS_ENABLED=false`). On 6.3.x this step runs; on the legacy layout it's a no-op.

3. **Frontend** — `expectedAgentCount` becomes dynamic: the `GET /api/party/projects` response already returns per-project `agentCount`; UI can display *"6 stock + 8 custom = 14 agents"* per card when custom-agent overlay is present.

4. **Testing protocol** (on the `solitaire` project):
   - Before re-bootstrap: count rows in `_bmad/_config/agent-manifest.csv` = 6.
   - Add custom-agent injection code, bootstrap again.
   - Expected: row count = 14. `agentCount` on DDB row = 14.
   - Start a new party session. First-turn welcome should list 14 agents with icons.
   - Send "I want to brainstorm something disruptive and innovative". Expect Rick + Carson (Brainstorming Coach, if he's stock) + another voice.
   - Inspect Claude's subagent spawn prompts (via stream-json `task_started` events) to confirm Rick's `identity`/`communicationStyle`/`principles` are injected verbatim.

### 15.4 Flags, warnings, and things that will bite us

These are ordered by likelihood-to-cause-pain, not importance.

**15.4.1 CSV schema can change across BMAD minor versions.** We already saw 10 → 12 columns between 6.0.0-alpha.7 and 6.3.0. Our injector MUST detect schema by reading the header row, not hardcode column order. If the header doesn't match what we know, skip injection + log a loud warning rather than emit schema-mismatched rows.

**15.4.2 Multi-line field values in CSV.** The stock rows' `identity` + `communicationStyle` + `principles` sometimes span multiple lines (newlines inside quoted fields, per RFC 4180). Our current `rebuildManifest` wraps every field in quotes and doubles internal quotes, which is correct. But a naive line-count on the CSV won't give you row count — you need real CSV parsing. **Do not use `split('\n')` to count rows; use `readFileSync + csv-parse` (add the lib to daemon package.json — it's not there yet).**

**15.4.3 Persona length bloats subagent context.** Our custom agents have long persona blocks. Rick's `identity` alone is ~400 words, Dave ups!' ~600 words. Every round the skill injects these verbatim into the subagent prompt. 4 agents × avg 500 words × 5 turns = 10,000 words of cached persona context, plus the growing discussion summary. Claude handles it fine but cache-miss overhead is real. Consider condensing personas to ~150 words each for party-mode use — keep the full personas in the agent .md files for other consumers. Warning: condensed personas lose character; don't strip too aggressively.

**15.4.4 Icon encoding.** Some of our custom agents use multi-byte emoji in `icon` (🔥 for Dave ups!, 🪨 for Pedrock, ⚡ for Sue Render, 🧪 for Rick). BMAD's CSV is UTF-8 and the stock `📊` etc. icons also multi-byte. Our injector must `writeFileSync('utf8')` not buffer-default. Minor but easy to get wrong.

**15.4.5 `module: "custom"` is our convention, not BMAD's.** BMAD might reject rows with unknown module values, or skills that enumerate modules via module-help.csv might fail. Test against `bmad-help` skill after injection — if `bmad-help` complains, pick a different module value (maybe use the stock `"bmm"` module name so we blend in? That feels wrong but may be pragmatic).

**15.4.6 `bmad-party-mode` skill DOES NOT re-read the CSV per turn.** It loads once at skill activation. Which means: if we inject custom rows *after* a session already started, they won't appear until the next fresh session. Fine for our flow — bootstrap → then New Party — but a recurring-session model would need cache invalidation.

**15.4.7 Claude may pick the wrong agents.** Party-mode's "pick 2-4 agents whose expertise is most relevant" is an LLM judgment call. With 14 agents some won't be obvious fits. For very specific topics (e.g., "AWS security on S3"), Sean Tinel should be an auto-pick — but if the LLM doesn't know which agent's expertise maps to which domain, it defaults to stock. Good `capabilities` text in the CSV really matters here — this is the primary signal for agent-relevance matching. Spend effort on that field.

**15.4.8 Our custom-agent file format is pre-6.3.0.** The `<agent>` XML wrapper with nested `<role>`, `<identity>`, `<communication_style>`, `<principles>` is 6.0.x-style. New BMAD agents use `.agent.yaml` with structured `agent.persona` objects. If we ever move to Path 3a, we'd rewrite all 8. For Path 3b, no rewrite needed — our parser already works.

**15.4.9 Idempotency across bootstrap re-runs.** Bootstrap re-runs (e.g., project already HEALTHY, user clicks Re-inspect + "Re-sync agents") trigger BMAD install which may regenerate the CSV, blowing away our injected rows. Two fixes:
- Always run inject-custom-agents as a post-step after every install — done correctly, idempotent.
- Detect if the current CSV already contains our rows (by the `module: custom` signature) and skip re-injection.

Prefer option 1. Option 2 has concurrency corners (what if the install AND the injection overlap?).

**15.4.10 Drift detection becomes real again.** Once we're injecting custom rows, `customAgentsSHA` stops being a `n/a-6.3.x` placeholder. Inspector's compare-SHAs branch fires again. Good — we want DRIFT detection when someone edits a custom agent .md in the admin repo and the EC2 source clone hasn't been refreshed. Don't remove the legacy drift-detection code when implementing 3b; revive it.

**15.4.11 The `capabilities` field is new in 6.3.x.** Stock rows have nice short lists like *"market research, competitive analysis, requirements elicitation, domain expertise"*. Our current custom-agent files don't have an explicit `<capabilities>` tag. Add one (hand-written 4-8 terms per agent) rather than auto-deriving from `role` (which is usually too verbose). This is about 30 minutes of thoughtful work for all 8 agents but pays off in agent-picking quality every time the skill runs.

**15.4.12 Test the orchestrator's "cross-talk" pattern.** Skill supports prompts like *"Winston, what do you think about what Rick said?"*. That spawns one subagent (Winston) with prior-round context. For this to work well, our custom agents need to disagree meaningfully. If our 8 all happen to agree ("yes, ship it, looks good") the round is dead. Stress-test by framing polarizing topics ("should we move from Next.js static to SSR?") and see if the roster fragments.

### 15.5 Migration impact on existing code

Specific files that Path 3b touches:

- `daemon/pipelines/lib/inject-custom-agents.mjs` — **new**
- `daemon/pipelines/lib/rebuild-manifest.mjs` — parameterize column schema (currently 10-column hardcoded)
- `daemon/pipelines/party-bootstrap.mjs` — add step `inject-custom-agents` between rebuild-manifest and verify; restore `compute-sha` to real SHA now that we have files to hash; update persist to write real `customAgentsSHA`
- `daemon/pipelines/party-inspector.mjs` — drift detection un-commented (currently always falls through to HEALTHY on 6.3.x because expected SHA is null)
- `docs/concepts/party-module-implementation.md` — update Gotchas §11.7, §11.8, §11.10 once they no longer apply

### 15.6 What *not* to do

- **Don't** try to expose custom agents as individual Claude Code skills (one SKILL.md per agent). The skill-tool has overhead per skill registration, some quota applies, and party-mode doesn't discover agents that way. Manifest rows are the mechanism.
- **Don't** hand-edit `_bmad/_config/agent-manifest.csv` directly on EC2 as a quick test. BMAD's next quick-update run will regenerate and clobber. Go through the injection step.
- **Don't** add custom agents to `.claude/skills/` thinking they'll show up as party-mode voices. That's a mental-model error — party-mode's roster comes from the CSV, not from the skills directory.
- **Don't** skip the `capabilities` field. It's the best signal we have for the LLM to pick relevant agents; under-investing there = weaker responses. Longer personas can't compensate for missing capabilities.

### 15.7 Testing the end state

Once Path 3b lands, the success criterion is concrete:

1. Fresh `solitaire` bootstrap → 14 rows in CSV, `agentCount = 14` on DDB row.
2. New session → welcome message lists 14 agents (Mary, John, Sally, Winston, Amelia, Paige + Ludwig, Rick, Pedrock, Dave ups!, Nimbus, Sean Tinel, Kube Rick, Sue Render).
3. Topic: *"I want to debate whether we should use GraphQL or REST for this project's API"* → Expect Winston (Architect) + Rick (Innovation Disruptor) + maybe Ludwig (Orchestration Architect) — our custom agents should be PICKED, not ignored.
4. Subagent output stream shows injected persona markers — Rick's output starts with his classic irreverent Rick-Sanchez voice, not generic Claude voice.
5. Drift: touch one custom agent .md in the admin repo's `bmad/agents/rick-innovation/`, rsync to EC2 source, run Re-inspect on solitaire → status flips to DRIFTED. Click Re-sync → bootstrap re-runs, injects updated row, status → HEALTHY.

If all 5 pass, custom agents are first-class party members. If any fail, that's the bug to fix.

End of document.
