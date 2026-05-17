# Futurator-Admin — Technical Specification: Labs Party Module (P0 Slice)

**Author:** Richie
**Date:** 2026-04-17
**Project Level:** 1 (Coherent feature, 2–3 stories originally — scope escalated to 7 stories, see note)
**Change Type:** New feature (Labs tab + daemon pipelines + DDB tables + EC2 bootstrap)
**Development Context:** Brownfield — existing Futurator-Admin codebase with established conventions
**Scope Note:** This tech-spec covers the P0 slice only. P1 items (export-to-epic handoff, new-project UI, multi-user concurrency, BMAD upgrade flow) are deferred to separate tech-specs.

---

## Context

### Available Documents

Loaded from `docs/`:

- **`docs/PRD.md`** — Futurator-Admin Hub PRD (MVP 1 Project Observatory, MVP 2 Control Plane). Labs is the experimental area; Party is a new module within Labs. The admin hub targets near-zero hosting cost and single-operator usage (Richie).
- **`docs/architecture.md`** — locks the stack: Next.js 16 static export, Hono-on-Lambda API, multi-table DynamoDB, SST (Ion) infra, Vitest+Playwright testing, Tailwind 4 + shadcn/ui frontend.
- **`docs/epics.md`**, **`docs/epics-epic-orchestrator.md`**, **`docs/epics-mycelium-devs.md`**, **`docs/epics-project-hub-enhancement.md`** — prior epics establishing the Labs area, the agent orchestrator (daemon), and the observability spine.
- **`docs/concepts/ec2-auth-lifecycle-analysis.md`** — Option E auth model: SSM-backed API key + auth probe loop. Relevant because the party daemon pipeline inherits this auth path.
- **`docs/concepts/observability-spine-contract.md`** — NDJSON event contract on `futurator-agent-events`. The party turn/bootstrap pipelines MUST emit on this spine (reused, not forked).
- **`docs/concepts/agentic-pipeline-forensic-report.md`**, **`docs/concepts/orchestrator-prompt-template.md`**, **`docs/concepts/touch-point-inference-design.md`** — exemplars of existing daemon pipelines; reference for the new party pipelines.
- No existing product brief or research for Party specifically — context derived from in-session Party Mode discussion (captured above this tech-spec).

BMAD workflow status file at `docs/bmm-workflow-status.yaml` shows admin-project Phase 0–3 complete; this tech-spec is a standalone Level-1 insert for the Party feature.

### Project Stack

**Frontend — Next.js 16 static export (brownfield admin app):**

- `next` 16.2.2 (App Router, `output: 'export'`, `trailingSlash: true`)
- `react` 19.2.4, `react-dom` 19.2.4
- `typescript` 5.x (strict), `tsconfig.json` path alias `@/*` → `./src/*`
- `tailwindcss` 4.x, `@tailwindcss/postcss` 4.x, `tw-animate-css` 1.4.0
- `shadcn` 4.1.2 (Radix-based primitives in `src/components/ui/`), `class-variance-authority` 0.7.1, `clsx` 2.1.1, `tailwind-merge` 3.5.0
- `zustand` 5.x (client state, `/src/stores`)
- `@tanstack/react-query` 5.x (server state, 5-min staleTime)
- `zod` 3.x (validation, always `.safeParse()`)
- `lucide-react` 1.7.0 (icons)
- `date-fns` 4.x
- `next-themes` 0.4.6

**Backend — Hono on Lambda:**

- `hono` 4.12.10 — single Hono app in `functions/api/index.ts` (~700 LOC), exported as Lambda handler
- `@hono/node-server` 1.19.12
- `jose` 6.2.2 — JWT validation against Identity Broker JWKS
- CORS at Lambda Function URL level (do NOT add Hono CORS middleware — per CLAUDE.md)

**AWS SDK v3 (@aws-sdk/client-\* / lib-\* 3.1024.0):**

- `client-dynamodb`, `lib-dynamodb` (repositories), `client-ssm`, `client-s3`, `client-ec2`, `client-cloudfront`, `client-cloudwatch`, `client-cognito-identity-provider`, `client-cost-explorer`, `client-lambda`, `client-scheduler`, `client-resource-groups-tagging-api`, `client-route-53`, `client-ecs`, `client-ecr`, `s3-request-presigner`

**Daemon — Node.js ESM (`/daemon`, separate `package.json`):**

- Node.js 20.x
- `@aws-sdk/client-dynamodb` 3.1024.0, `@aws-sdk/lib-dynamodb` 3.1024.0, `@aws-sdk/client-ssm` 3.1024.0
- Standalone `.mjs` modules, `import`/`export`, `node --watch` dev
- Runs on EC2 Ubuntu instance as `ubuntu` user

**Infrastructure:**

- `sst` 4.6.11 (Ion/Pulumi), deploys to `us-east-1`
- 11 DynamoDB tables (PAY_PER_REQUEST), API Lambda (256 MB / 30 s), AuthCallback Lambda (256 MB / 10 s), 5 cron Lambdas

**Testing:**

- `vitest` 3.x (jsdom env, `@/*` alias, setup at `tests/setup.ts`, coverage on `src/**` and `functions/**`)
- `@playwright/test` 1.59.1 (Chromium only, smoke tests, pre-seeded auth)
- `@testing-library/react` 16, `@testing-library/jest-dom` 6, `jsdom` 26

**Tooling:**

- `eslint` 9.x (flat config, `--max-warnings 0`)
- `prettier` 3.x
- `knip` 5.x (unused exports/deps)
- `husky` 9.x + `lint-staged` 15.x (pre-commit: eslint --fix, prettier --write)

**BMAD:**

- BMAD-METHOD pinned at **6.0.0-alpha.7** (matches `bmad/_cfg/manifest.yaml` in this repo as of 2026-04-02). New projects install this exact version.
- Custom agents (8): `ludwig`, `pedrock`, `dave-ups-aws-devops`, `sean-tinel-aws-security`, `nimbus-aws-sa`, `kube-rick-containers`, `sue-render`, `rick-innovation` — live in `bmad/agents/<name>/` in this admin repo (source of truth per party-mode decision #1).

### Existing Codebase Structure

Admin repo is brownfield; conventions detected and confirmed:

**Frontend organization (feature-per-folder):**

- `src/app/<route>/page.tsx` — Next.js App Router pages, each a thin shell
- `src/components/labs/<module>/` — one folder per Labs module (existing: `agentic-workflow/`, `claude-code-workflow/`)
- `src/components/ui/` — shadcn primitives
- `src/hooks/use-<domain>.ts` — one hook file per domain, wraps TanStack Query + api-client
- `src/stores/<feature>-store.ts` — Zustand slices
- `src/types/<domain>.ts` — shared types
- `src/lib/api-client.ts` — central fetch wrapper with Bearer JWT auto-refresh

**Backend organization:**

- `functions/api/index.ts` — single Hono app, all routes
- `functions/shared/repositories/<concern>-repository.ts` — one file per DDB table, pure functions (no classes). Exemplar: `agent-jobs-repository.ts`.
- `functions/shared/schemas/<domain>-schema.ts` — Zod schemas, `safeParse` only
- `functions/shared/types/<domain>.ts` — shared types
- `functions/shared/auth-middleware.ts` — JWT validation, JWKS caching
- `functions/shared/errors.ts` — `AppError`, `ValidationError` envelope types
- `functions/cron/` — scheduled Lambdas (one file per cron)

**Daemon organization:**

- `daemon/agent-daemon.mjs` — main loop, polls DDB, spawns Claude subprocess
- `daemon/pipelines/<pipeline>.mjs` — one file per pipeline (exemplars: `epic-dev-pipeline.mjs`, `compile-pipeline.mjs`)
- `daemon/pipelines/lib/` — shared helpers
- `daemon/pipelines/job-router.mjs` — dispatches job types to handlers
- `daemon/pipelines/__tests__/*.test.mjs` — Vitest tests
- `daemon/forwarder/ndjson-forwarder.mjs` — NDJSON → DDB event forwarding
- `daemon/receiver/http-receiver.mjs` — loopback HTTP for wave-complete/heartbeat

**Naming & style (confirmed):**

- Files: kebab-case (`story-card.tsx`, `agent-jobs-repository.ts`)
- Exported React components: PascalCase
- Hooks/utilities: camelCase
- 2-space indent, single quotes, semicolons, Prettier 3 defaults
- Imports: `@/...` absolute for `src/`, relative for `functions/` and `daemon/`
- React: hooks only, no class components
- Tests co-located in `__tests__/` folders

**Conforming to existing conventions for Party module: YES (confirmed implicitly via brownfield choice).**

---

## The Change

### Problem Statement

The Futurator-Admin Labs area today offers structured pipelines that turn an input into deployed code (`agentic-workflow`, `claude-code-workflow`). There is **no facility for structured pre-epic deliberation** — the exploratory, multi-perspective discussion that good epic scoping demands. Users currently jump straight from a raw idea into the PM agent; the "should we even build this, and if so, what exactly?" step is implicit and carried in Richie's head.

Additionally, the 8 projects already present under `/home/ubuntu/projects/` (battleship, dino-chrome, dino-chrome1, dinosaour-chrome, guess-the-number, hello-world, solitaire, spyhunter) have **no structured way to be retroactively analyzed, documented, or debated**. They were generated by earlier Labs pipelines and exist as code without companion reflection.

The 23-voice BMAD Party Mode workflow exists _conceptually_ in this repo's `bmad/` tree but has no UI affordance — it can only be invoked by opening Claude Code in a terminal and typing a slash command. Custom agents authored in this admin repo (Ludwig, Rick, Nimbus, Pedrock, Dave ups!, Sean Tinel, Kube Rick, Sue Render) are siloed here and don't automatically reach each project folder.

### Proposed Solution

Add a new **Party** tab in the Labs area that enables structured, multi-agent BMAD Party Mode conversations **scoped to a selected EC2 project folder**.

Mechanics:

1. **Select a project.** User opens Labs → Party, sees the 8 existing projects listed from `/home/ubuntu/projects/`, each with a status badge indicating BMAD install state (MISSING / HEALTHY / DRIFTED / INSTALLING / FAILED).
2. **Install or retrofit BMAD per project.** If a project has no `bmad/` tree, a one-click "Install BMAD" action enqueues a daemon bootstrap job that runs `npx bmad-method@6.0.0-alpha.7 install`, rsyncs the 8 custom agents from a central source clone, rebuilds the `agent-manifest.csv`, and verifies 24 agents present (16 core + 8 custom). Progress streams live to the UI via the existing NDJSON event spine.
3. **Start a Party session.** Once a project is HEALTHY, the user clicks "New Party" to open a chat UI. Behind the scenes this creates a `futurator-party-sessions` row and, on the first user message, the daemon spawns `claude -p --resume <sessionId>` with `cwd` = project path, injecting `/bmad:core:workflows:party-mode` as the turn-1 prefix.
4. **Converse.** User types, agents respond multi-voice in-character, any agent can read/grep the project's actual code (Claude Code tools in `cwd`), user continues the conversation across turns. State survives via Claude CLI's on-disk session storage; DDB carries only metadata + the event log for UI rendering.
5. **Drift detection.** Every session open triggers a cheap inspector step: verify `agent-manifest.csv` parses, verify custom-agent SHA still matches admin-repo source. If drifted → offer "Re-sync custom agents" before starting.

All communication with the daemon reuses the existing job-queue/NDJSON-forwarder transport already running for `agentic-workflow` and `claude-code-workflow`. Party is additive: no existing code paths change.

### Scope

**In Scope (P0):**

1. Project listing surface in Labs under a new "Party" tab.
2. BMAD-install inspector that classifies each `/home/ubuntu/projects/*` directory as MISSING / HEALTHY / DRIFTED / CORRUPTED / INSTALLING / FAILED.
3. Install-or-retrofit pipeline on the daemon (new `daemon/pipelines/party-bootstrap.mjs`) that runs `npx bmad-method install`, rsyncs custom agents from `/home/ubuntu/bmad-agents-source/`, rebuilds `agent-manifest.csv`, and persists verification results.
4. Rebuild-manifest helper (`daemon/pipelines/lib/rebuild-manifest.mjs`) that regenerates `bmad/_cfg/agent-manifest.csv` from the on-disk `bmad/` tree. Critical because BMAD provides no public script for this.
5. Party session lifecycle: `futurator-party-sessions` DDB table, create/list/open.
6. Turn loop: new `daemon/pipelines/party-turn.mjs` that spawns `claude -p` with `--resume` semantics and streams stdout to the existing NDJSON spine.
7. Custom-agent drift detection at session open (cheap SHA check, surface DRIFTED status).
8. Frontend Party UI (tab, project list, bootstrap progress, session chat) wired to TanStack Query + Zustand, reusing `Ec2Toggle`, `api-client`, and the existing streaming display pattern from `story-live-output.tsx`.
9. Tests: unit (Vitest), daemon pipeline tests, one Playwright smoke.

**Out of Scope (deferred to separate P1 tech-specs):**

- Export-to-PM-epic handoff (writing session summary to `docs/party-<sessionId>-summary.md` and linking to `agentic-workflow` epic generator).
- New-project creation UI (mkdir + bootstrap for a greenfield folder). P0 handles retrofit only, because all 8 current projects already exist.
- Multi-user concurrency (locking, session ownership). Single-operator model (Richie).
- BMAD version upgrade flow (per-project upgrade from 6.0.0-alpha.7 to future versions).
- Session archive/delete/rename UX beyond MVP.
- CloudWatch alarms or custom metrics for party pipelines (use existing daemon observability).
- Multi-provider token accounting for party conversations.
- Non-English output (inherits BMAD config's `document_output_language: English`).

---

## Implementation Details

### Source Tree Changes

**Frontend (`src/`):**

| File                                                 | Action | Purpose                                                                                                                                                       |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/labs/party/page.tsx`                        | CREATE | Next.js App Router route for Labs Party tab                                                                                                                   |
| `src/components/labs/party/index.tsx`                | CREATE | Top-level Party component: hosts project list + active session                                                                                                |
| `src/components/labs/party/project-list.tsx`         | CREATE | Grid of projects from `GET /api/party/projects` with status badges                                                                                            |
| `src/components/labs/party/project-status-badge.tsx` | CREATE | Colored badge per `bmadStatus` value                                                                                                                          |
| `src/components/labs/party/bootstrap-progress.tsx`   | CREATE | Live pipeline event renderer for bootstrap job                                                                                                                |
| `src/components/labs/party/session-chat.tsx`         | CREATE | Multi-agent chat thread, message input, streaming turn rendering                                                                                              |
| `src/components/labs/party/session-header.tsx`       | CREATE | Session metadata row (project, agent count, turn count, actions)                                                                                              |
| `src/hooks/use-party-projects.ts`                    | CREATE | TanStack Query wrapper for list/inspect projects                                                                                                              |
| `src/hooks/use-party-bootstrap.ts`                   | CREATE | Mutation for bootstrap + polling events for in-flight job                                                                                                     |
| `src/hooks/use-party-sessions.ts`                    | CREATE | List/create sessions for a project                                                                                                                            |
| `src/hooks/use-party-session.ts`                     | CREATE | Single session + events + send-message mutation                                                                                                               |
| `src/stores/party-store.ts`                          | CREATE | Zustand slice: `selectedProjectId`, `activeSessionId`, `draftMessage`                                                                                         |
| `src/types/party.ts`                                 | CREATE | Shared types: `PartyProject`, `PartySession`, `PartyEvent`, `BmadStatus`                                                                                      |
| _Labs tab registry_                                  | MODIFY | Add "Party" entry to the Labs navigation list — exact file TBD during Story 4 by inspecting where `agentic-workflow` and `claude-code-workflow` tabs register |

**Backend (`functions/`):**

| File                                                                        | Action | Purpose                                                                                                                                                                                                                                                                            |
| --------------------------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `functions/api/index.ts`                                                    | MODIFY | Append routes: `GET /party/projects`, `GET /party/projects/:id`, `POST /party/projects/:id/bootstrap`, `GET /party/projects/:id/bootstrap/:jobId/events`, `POST /party/sessions`, `GET /party/sessions/:id`, `POST /party/sessions/:id/messages`, `GET /party/sessions/:id/events` |
| `functions/shared/repositories/party-projects-repository.ts`                | CREATE | DDB CRUD for `futurator-party-projects`                                                                                                                                                                                                                                            |
| `functions/shared/repositories/party-sessions-repository.ts`                | CREATE | DDB CRUD for `futurator-party-sessions` (with GSI1 query by projectId)                                                                                                                                                                                                             |
| `functions/shared/schemas/party-schema.ts`                                  | CREATE | Zod schemas for all party request bodies and domain models                                                                                                                                                                                                                         |
| `functions/shared/types/party.ts`                                           | CREATE | Shared TS types (reused by frontend via type-only import)                                                                                                                                                                                                                          |
| `functions/shared/repositories/__tests__/party-projects-repository.test.ts` | CREATE | Unit tests                                                                                                                                                                                                                                                                         |
| `functions/shared/repositories/__tests__/party-sessions-repository.test.ts` | CREATE | Unit tests                                                                                                                                                                                                                                                                         |
| `functions/shared/schemas/__tests__/party-schema.test.ts`                   | CREATE | Unit tests                                                                                                                                                                                                                                                                         |

**Daemon (`daemon/`):**

| File                                                   | Action | Purpose                                                                                                                                           |
| ------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ | -------------------------- |
| `daemon/pipelines/party-bootstrap.mjs`                 | CREATE | Orchestrates install + custom-agent sync + manifest rebuild + verify                                                                              |
| `daemon/pipelines/party-turn.mjs`                      | CREATE | Spawns `claude -p --resume` for one party turn, streams NDJSON                                                                                    |
| `daemon/pipelines/party-inspector.mjs`                 | CREATE | Filesystem inspection + status classification + drift detection                                                                                   |
| `daemon/pipelines/lib/bmad-install.mjs`                | CREATE | Wraps `npx bmad-method@<version> install --directory ... --yes`; idempotent (checks existing install)                                             |
| `daemon/pipelines/lib/custom-agent-sync.mjs`           | CREATE | Wraps `rsync -av --checksum /home/ubuntu/bmad-agents-source/bmad/agents/ <proj>/bmad/agents/`                                                     |
| `daemon/pipelines/lib/rebuild-manifest.mjs`            | CREATE | Globs `bmad/**/agents/*.md`, parses `<agent>` XML headers, writes `bmad/_cfg/agent-manifest.csv`                                                  |
| `daemon/pipelines/lib/custom-agents-sha.mjs`           | CREATE | Computes SHA256 of sorted-concat custom agent files                                                                                               |
| `daemon/pipelines/job-router.mjs`                      | MODIFY | Add `JOB_HANDLER_PARTY_BOOTSTRAP`, `JOB_HANDLER_PARTY_TURN`, `JOB_HANDLER_PARTY_INSPECT`; extend `selectHandler()` to dispatch `'party-bootstrap' | 'party-turn' | 'party-inspect'` job types |
| `daemon/agent-daemon.mjs`                              | MODIFY | Import new pipeline functions; dispatch new job types through router                                                                              |
| `daemon/pipelines/__tests__/rebuild-manifest.test.mjs` | CREATE | Given fake `bmad/` tree, assert exact CSV output                                                                                                  |
| `daemon/pipelines/__tests__/party-bootstrap.test.mjs`  | CREATE | Mocked exec; verify idempotency + error handling                                                                                                  |
| `daemon/pipelines/__tests__/party-turn.test.mjs`       | CREATE | Mocked spawn; verify claudeSessionId capture + NDJSON forwarding                                                                                  |
| `daemon/pipelines/__tests__/party-inspector.test.mjs`  | CREATE | Fake fs; assert status classification matrix                                                                                                      |

**Infrastructure (`sst.config.ts`):**

| Change                            | Action | Purpose                                                                                                                                                                                                                                             |
| --------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add `PartyProjects` DDB table     | MODIFY | PK `projectId` (string), PAY_PER_REQUEST, no GSI, no PITR (ephemeral state)                                                                                                                                                                         |
| Add `PartySessions` DDB table     | MODIFY | PK `sessionId` (string), GSI1: `GSI1PK=projectId`, `GSI1SK=createdAt`, PAY_PER_REQUEST, no PITR                                                                                                                                                     |
| Wire env vars into API Lambda     | MODIFY | `PARTY_PROJECTS_TABLE`, `PARTY_SESSIONS_TABLE`                                                                                                                                                                                                      |
| Wire env vars into daemon context | MODIFY | Daemon reads `PARTY_PROJECTS_TABLE`, `PARTY_SESSIONS_TABLE`, `PROJECTS_ROOT` (=`/home/ubuntu/projects`), `BMAD_AGENTS_SOURCE` (=`/home/ubuntu/bmad-agents-source/bmad/agents`), `BMAD_VERSION` (=`6.0.0-alpha.7`) via SSM parameters or systemd env |
| No new Lambda                     | —      | Existing API Lambda handles all new routes                                                                                                                                                                                                          |

**Docs:**

| File                             | Action | Purpose                                                                                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `CLAUDE.md`                      | MODIFY | Add brief "Labs Party module" entry under Architecture → Frontend note the EC2 prerequisite (`bmad-agents-source` clone) |
| `daemon/README.md`               | MODIFY | Document new EC2 setup step: `git clone <admin repo> /home/ubuntu/bmad-agents-source/`                                   |
| `docs/tech-spec-party-module.md` | CREATE | This document                                                                                                            |

### Technical Approach

**Per-project BMAD install, pinned version.**
BMAD resolves workflows via `{project-root}/bmad/...` paths, so installation is per-project. Each project install uses `npx bmad-method@6.0.0-alpha.7 install --directory <projectPath> --modules core,bmm,cis --tools claude-code --yes`. The version is pinned in `BMAD_VERSION` env var (default `6.0.0-alpha.7`, the version already installed in this admin repo per `bmad/_cfg/manifest.yaml`). Each `futurator-party-projects` DDB row stores the installed `bmadVersion` so drift is visible across projects.

**Custom agents seeded from admin repo via a central clone on EC2.**
The 8 custom agents (Ludwig, Rick, Pedrock, Nimbus, Dave ups!, Sean Tinel, Kube Rick, Sue Render) live in this admin repo's `bmad/agents/` directory. On EC2, we maintain a shallow clone at `/home/ubuntu/bmad-agents-source/` (one-time setup). The bootstrap pipeline runs `git -C /home/ubuntu/bmad-agents-source fetch --depth 1 origin main && git -C ... reset --hard origin/main` before each bootstrap, then rsyncs `bmad/agents/` into the target project. A SHA256 of the custom-agent files is persisted on the project row (`customAgentsSHA`) so drift is detectable.

**Manifest rebuild is our code, not BMAD's.**
BMAD has no public script to regenerate `bmad/_cfg/agent-manifest.csv`. We write one in `daemon/pipelines/lib/rebuild-manifest.mjs`. Algorithm:

1. Glob `bmad/**/agents/*.md` (exclude `*.source.md`, `*.customize.yaml`).
2. For each file, parse the `<agent id="...">` XML block for attributes `name`, `title`, `icon`. Extract the persona fields from subsequent tags or YAML frontmatter (`role`, `identity`, `communicationStyle`, `principles`).
3. Derive `module` from path: `bmad/core/agents/` → `core`; `bmad/bmm/agents/` → `bmm`; `bmad/cis/agents/` → `cis`; `bmad/bmb/agents/` → `bmb`; `bmad/agents/<name>/` → `agents`.
4. Write CSV with exact column order: `name,displayName,title,icon,role,identity,communicationStyle,principles,module,path`.
5. CSV escaping: any field containing `,`, `"`, or newline is wrapped in double quotes with internal `"` doubled (RFC 4180). Critical: `principles` fields are long prose and WILL contain commas.
6. Order: core rows first, then bmb, bmm, cis, agents — preserves the manifest ordering we already ship.

**Session turn loop via `claude -p --resume` (no long-lived subprocess).**
Each user turn = one `claude -p` invocation. Turn 1: `claude -p "/bmad:core:workflows:party-mode\n\n<user_message>" --session-id <generated-uuid> --output-format stream-json --verbose` with `cwd=<projectPath>`. Subsequent turns: `claude -p "<user_message>" --resume <claudeSessionId> --output-format stream-json --verbose`. `claudeSessionId` is captured from the stream-json output on turn 1 and persisted on the session row; reused for all subsequent turns. Claude CLI's on-disk session store holds the full conversation; DDB is metadata + event log only.

**Eventing reuses `futurator-agent-events` (no new table for events).**
The existing NDJSON forwarder writes to this table keyed by `jobId`. Party uses `jobId == sessionId` for turn events and `jobId == bootstrapJobId` for bootstrap events, disambiguated by `eventType`:

- `party.turn.user` — user message appended
- `party.turn.assistant.token` — streaming token from Claude
- `party.turn.assistant.agent` — per-agent name boundary (parsed from content)
- `party.turn.completed` — turn finished
- `party.turn.error` — turn errored
- `party.bootstrap.step.started` / `.output` / `.completed` / `.failed`
- `party.inspect.drift.detected`

Frontend polls `GET /api/party/sessions/:id/events?since=<seq>` every 1.5s while session is ACTIVE; stops polling after 30s of silence.

**Security boundaries:**

- All routes gated by existing `auth-middleware.ts` (Bearer JWT via Identity Broker JWKS).
- `projectPath` always derived server-side from `projectId` by concatenating with `PROJECTS_ROOT`; client never sends paths. `projectId` regex: `^[a-z0-9][a-z0-9-]{0,63}$`.
- Message body: max 8 KB, UTF-8 text only (Zod `.max(8192)` + `.regex(/^[\s\S]*$/)`).
- Claude subprocess runs as `ubuntu` user (already the daemon's uid), `cwd` confined to the project folder.
- No arbitrary code execution risk beyond what Claude CLI already carries; the custom-agent source is git-tracked in a trusted repo.

### Existing Patterns to Follow

This is a brownfield project; the new module must conform to existing conventions detected in the codebase.

**Repository pattern** (exemplar: `functions/shared/repositories/agent-jobs-repository.ts`):

- Pure functions, no classes. Each exported function accepts a `DynamoDBDocumentClient` or uses a module-level one.
- Named exports only; no default exports from repositories.
- Type the returned row shape; use `Partial<T>` where attributes are optional.
- Error on missing environment variables at module load, not on first call.

**Hono route pattern** (exemplar: all existing routes in `functions/api/index.ts`):

- Routes mounted on the single Hono app under a namespace: `app.get('/party/projects', handler)`.
- Auth middleware applied per route group or per route (follow existing `/api/epic-workflows/*` pattern).
- Request body: `const parsed = PartyCreateSessionSchema.safeParse(await c.req.json()); if (!parsed.success) throw new ValidationError(parsed.error);`
- Errors bubble to the Hono app-level error handler; do NOT try/catch inside handlers unless transforming.

**Hook pattern** (exemplar: `src/hooks/use-epic-workflow.ts`):

- `useQuery`/`useMutation` wrappers around `api-client.ts`.
- `staleTime: 5 * 60 * 1000` (5-minute default, override for polling hooks).
- Query keys: `['party', 'projects']`, `['party', 'projects', projectId]`, `['party', 'sessions', sessionId, 'events', since]`.
- Polling hooks (for live events) use `refetchInterval: 1500` while session ACTIVE, else `refetchInterval: false`.

**Zustand pattern** (exemplar: any existing `src/stores/*.ts`):

- Single slice file per feature, named `<feature>-store.ts`.
- Exposes `useXxxStore` hook + actions as object methods.
- Do NOT persist ephemeral UI state (active session, draft message) to localStorage; only persist user preferences.

**Zod pattern** (exemplar: `functions/shared/schemas/agent-orchestrator-schema.ts`):

- Named exports `<Name>Schema`. Type inference via `z.infer`.
- Always `.safeParse()`; never `.parse()` (which throws).
- Compose small schemas into larger ones.

**Daemon pipeline pattern** (exemplar: `daemon/pipelines/epic-dev-pipeline.mjs`):

- Named exports only; each pipeline exposes `run<PipelineName>(job, ctx)` where `ctx = { ddb, emit, env }`. No default exports.
- Emits events via the forwarder (`emit('party.bootstrap.step.started', { step })`).
- On completion, updates the job row via `UpdateCommand` (status, timestamps).
- On error, sets status to `ERROR` with a reason message; does NOT auto-retry.

**Job router pattern** (exemplar: `daemon/pipelines/job-router.mjs` `selectHandler()`):

- Export `JOB_HANDLER_<NAME>` constants.
- Extend `selectHandler()` to return the new handler ID for the new job-type string.
- Validation functions like `validateEpicDevJob` exist — write `validatePartyBootstrapJob`, `validatePartyTurnJob` to mirror.

**Error handling:**

- Backend: `AppError` (HTTP-mapped), `ValidationError` (wraps Zod errors), both from `functions/shared/errors.ts`.
- Daemon: throw plain `Error`; pipeline wrappers translate to event emission + status update.
- Frontend: `api-client.ts` throws `ApiError` on non-2xx; hooks surface errors through `useQuery`/`useMutation` `error` state.

**Test pattern:**

- Co-located `__tests__/` folders.
- File naming: `<name>.test.ts` (TS) or `<name>.test.mjs` (daemon).
- `vi.fn()`, `vi.mock()`, `vi.spyOn()` — no other mocking library.
- Each test file starts with imports + `describe` block; avoid top-level assertions.

### Integration Points

| Boundary                        | Integration                                                                                                                                                                                                                                         |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Identity Broker**             | All `/api/party/*` routes authenticate via existing `auth-middleware.ts`. No changes to middleware.                                                                                                                                                 |
| **Ec2Toggle component**         | The Party tab consumes the current EC2 mode from the existing `localStorage('futurator.labs.runtimeMode')` pattern. Local mode is out of scope for P0 (party requires EC2). When mode=local, the Party tab shows "Switch to EC2 to use Party Mode." |
| **NDJSON event spine**          | Reuses `futurator-agent-events` DDB table and `daemon/forwarder/ndjson-forwarder.mjs`. Party emits new `eventType` prefixes (`party.*`) but uses the same record shape.                                                                             |
| **Agent jobs table**            | Reuses `futurator-agent-jobs` for bootstrap and turn jobs. Adds new `jobType` values (`'party-bootstrap'`, `'party-turn'`, `'party-inspect'`). No schema change; existing columns suffice.                                                          |
| **Daemon job loop**             | `daemon/agent-daemon.mjs` picks up PENDING jobs via existing query; routes new job types through `job-router.mjs`. No changes to the polling loop.                                                                                                  |
| **Heartbeat / stale detection** | Existing `daemon/pipelines/stale-heartbeat.mjs` finds stalled jobs and resumes. Party bootstrap and turn jobs inherit this — a stalled party turn is detected and can be retried via `buildResumeJob`.                                              |
| **Claude CLI**                  | Subprocess invocation with `--session-id`, `--resume`, `--output-format stream-json`, `--verbose`. Auth via existing SSM-backed API key (Option E from `ec2-auth-lifecycle-analysis.md`); daemon already hot-reloads keys on SIGUSR1.               |
| **BMAD installer**              | External command `npx bmad-method@<version> install ...`. Captures stdout/stderr, streams to events, checks exit code.                                                                                                                              |
| **rsync**                       | External command for custom-agent sync. `rsync -av --checksum --delete` (the `--delete` is intentional: custom agents removed from source should be removed from projects).                                                                         |
| **git**                         | External command for pulling the central `bmad-agents-source` clone before each bootstrap.                                                                                                                                                          |
| **Frontend → API**              | Via `api-client.ts` Bearer-JWT fetch wrapper. No new transport layer.                                                                                                                                                                               |
| **Static export constraint**    | Next.js `output: 'export'` precludes SSR. All Party UI is client-rendered, data fetched via TanStack Query after mount.                                                                                                                             |

---

## Development Context

### Relevant Existing Code

Developers implementing this spec should read, in order:

1. **`src/components/labs/ec2-toggle.tsx`** (lines 1–162) — EC2 lifecycle UI and the `localStorage('futurator.labs.runtimeMode')` convention. Party tab UI hooks into this via `useEc2Status()` from `src/hooks/use-ec2-daemon.ts`.
2. **`src/components/labs/agentic-workflow/index.tsx`** — exemplar Labs module composition: project selector, live output, state management. Party module structure mirrors this.
3. **`src/components/labs/agentic-workflow/story-live-output.tsx`** — existing NDJSON streaming renderer. Party session-chat reuses the pattern (streaming tokens grouped by speaker).
4. **`src/components/labs/agentic-workflow/project-selector.tsx`** (lines 1–80) — card-grid project selector pattern. Party's `project-list.tsx` mirrors the card shape, swaps the semantic for BMAD status.
5. **`functions/shared/repositories/agent-jobs-repository.ts`** — repository pattern exemplar. `party-projects-repository.ts` and `party-sessions-repository.ts` mirror structure and naming.
6. **`functions/shared/schemas/agent-orchestrator-schema.ts`** — Zod schema organization exemplar. `party-schema.ts` mirrors.
7. **`functions/api/index.ts`** — see route mounting style for `/api/epic-workflows/*` as the template for `/api/party/*`.
8. **`daemon/pipelines/epic-dev-pipeline.mjs`** — daemon pipeline structure (event emission, DDB updates, error handling). `party-bootstrap.mjs` and `party-turn.mjs` mirror.
9. **`daemon/pipelines/job-router.mjs`** — handler dispatch. Extend with three new handlers.
10. **`daemon/agent-daemon.mjs`** (lines 1–80 for config/init context) — job polling loop. Add new job type imports.
11. **`daemon/forwarder/ndjson-forwarder.mjs`** — event emission mechanics. Reuse directly.
12. **`bmad/_cfg/agent-manifest.csv`** (the existing file in this repo) — canonical example of the CSV shape `rebuild-manifest.mjs` must reproduce.
13. **`docs/concepts/ec2-auth-lifecycle-analysis.md`** — background on daemon auth model; informs subprocess env handling.
14. **`docs/concepts/observability-spine-contract.md`** — event shape and forwarding invariants.

### Dependencies

**Framework / Libraries (exact versions):**

- `next` 16.2.2 (App Router, static export)
- `react` 19.2.4, `react-dom` 19.2.4
- `typescript` 5.x strict
- `hono` 4.12.10
- `zod` 3.x
- `zustand` 5.x
- `@tanstack/react-query` 5.x
- `tailwindcss` 4.x, `shadcn` 4.1.2
- `lucide-react` 1.7.0
- `@aws-sdk/client-dynamodb` 3.1024.0
- `@aws-sdk/lib-dynamodb` 3.1024.0
- `@aws-sdk/client-ssm` 3.1024.0
- `jose` 6.2.2
- `vitest` 3.x
- `@playwright/test` 1.59.1
- `sst` 4.6.11

No new npm dependencies required for the admin app; all needed packages already installed.

**Daemon:** no new npm dependencies. `rsync`, `git`, `npx`, `claude` must be present on the EC2 host (already are).

**Internal modules (admin app):**

- `@/lib/api-client` — fetch wrapper
- `@/stores/auth-store` — token storage
- `@/components/ui/*` — shadcn primitives (Card, Button, Badge, Dialog, Input, Textarea, Skeleton)
- `@/hooks/use-ec2-daemon` — existing EC2 status hook
- `functions/shared/errors` — `AppError`, `ValidationError`
- `functions/shared/auth-middleware` — JWT validation
- `functions/shared/forwarder` (daemon) — NDJSON event forwarder

### Configuration Changes

**`sst.config.ts` — two new DDB tables:**

```ts
const partyProjectsTable = new sst.aws.Dynamo('PartyProjects', {
  fields: { projectId: 'string' },
  primaryIndex: { hashKey: 'projectId' },
});

const partySessionsTable = new sst.aws.Dynamo('PartySessions', {
  fields: {
    sessionId: 'string',
    GSI1PK: 'string',
    GSI1SK: 'string',
  },
  primaryIndex: { hashKey: 'sessionId' },
  globalIndexes: {
    GSI1: { hashKey: 'GSI1PK', rangeKey: 'GSI1SK' },
  },
});
```

Wire as `link`s on the API Lambda. Also export table names to SSM parameters so the daemon reads them at startup.

**Daemon environment (via systemd env file or SSM):**

```
PARTY_PROJECTS_TABLE=futurator-party-projects
PARTY_SESSIONS_TABLE=futurator-party-sessions
PROJECTS_ROOT=/home/ubuntu/projects
BMAD_AGENTS_SOURCE=/home/ubuntu/bmad-agents-source/bmad/agents
BMAD_VERSION=6.0.0-alpha.7
AGENT_JOBS_TABLE=futurator-agent-jobs              # existing
AGENT_EVENTS_TABLE=futurator-agent-events          # existing
```

**EC2 host setup (one-time, Ubuntu):**

```bash
# Shallow clone of this admin repo as custom-agent source of truth
sudo -u ubuntu git clone --depth 1 https://github.com/<org>/futurator-admin.git \
  /home/ubuntu/bmad-agents-source

# Ensure projects root exists (already does)
sudo -u ubuntu mkdir -p /home/ubuntu/projects
```

**Frontend:** no env changes. `NEXT_PUBLIC_API_URL` already configured for local vs. production.

### Existing Conventions (Brownfield)

Confirmed and applied:

- **Code style:** 2-space indent, single quotes, semicolons (Prettier 3 defaults).
- **Imports:** `@/...` absolute for `src/`, relative paths for `functions/` and `daemon/`.
- **File naming:** kebab-case for all files.
- **Component exports:** PascalCase, named exports only (no default exports in components).
- **Hook naming:** `use<Domain>` camelCase.
- **Type naming:** PascalCase.
- **Environment variables:** SCREAMING_SNAKE_CASE, read via `process.env.X` in Lambda; via systemd env file in daemon.
- **Error envelope:** `{ error: { code, message, details? } }` via `AppError`.
- **Logging:** `console.log/warn/error` in daemon; structured fields preferred; no external logging library.
- **DynamoDB table naming:** `futurator-<concern>` kebab-case; one table per concern (NEVER single-table design per CLAUDE.md/`feedback_dynamodb_multi_table.md`).
- **API response shape:** JSON envelope, consistent via Hono handlers; 4xx via `AppError.httpStatus`.
- **Public vs. private routes:** `/api/health`, `/api/auth/*`, `/api/public/*` are public; everything else requires JWT. Party routes all require JWT.

### Test Framework & Standards

- **Unit / integration:** Vitest 3.x, jsdom env, `@/*` alias, `tests/setup.ts`.
- **E2E:** Playwright 1.59.1, Chromium only, auth pre-seeded via `sessionStorage`, API mocked via `page.route()`. Smoke-level only.
- **Test file naming:** `<name>.test.ts` for TS; `<name>.test.mjs` for daemon ESM.
- **Test organization:** co-located `__tests__/` folders (see existing `functions/shared/repositories/__tests__/`, `daemon/forwarder/__tests__/`, `daemon/pipelines/__tests__/`).
- **Assertion style:** `expect()`.
- **Mocking:** `vi.fn()`, `vi.mock()`, `vi.spyOn()`. No `sinon`, no `jest.mock` (Vitest's API is Jest-compatible but we use the `vi` namespace).
- **Coverage:** no hard threshold configured; new Party code should be comprehensively covered (unit + at least one smoke).

---

## Implementation Stack

- **Runtime:** Node.js 20.x (admin app build, Lambda runtime, daemon)
- **Frontend framework:** Next.js 16.2.2 App Router (`output: 'export'`, `trailingSlash: true`)
- **UI stack:** React 19.2.4 + Tailwind CSS 4 + shadcn/ui (Radix) + lucide-react icons
- **Client state:** Zustand 5
- **Server state:** TanStack Query 5 (5-min staleTime, 1.5s refetchInterval when polling)
- **Backend framework:** Hono 4.12.10 (single Lambda handler in `functions/api/index.ts`)
- **Language:** TypeScript 5 strict (frontend + Lambda); JavaScript ESM (daemon)
- **Database:** DynamoDB via `@aws-sdk/lib-dynamodb` 3.1024.0 (PAY_PER_REQUEST, no PITR for Party tables)
- **Validation:** Zod 3 (`.safeParse()` only)
- **Auth:** Bearer JWT via Identity Broker JWKS (jose 6.2.2)
- **Testing:** Vitest 3 + Playwright 1.59.1 (Chromium)
- **Infrastructure:** SST 4.6.11 (Ion / Pulumi), us-east-1
- **Lint/format:** ESLint 9 flat config (`--max-warnings 0`), Prettier 3
- **Unused-code detection:** Knip 5
- **Git hooks:** Husky 9 + lint-staged 15
- **EC2 host:** Ubuntu, Node 20, Claude CLI installed, `rsync` + `git` + `npx` available
- **BMAD:** `bmad-method` 6.0.0-alpha.7 (pinned; matches admin-repo install)

---

## Technical Details

### DynamoDB Schemas

**`futurator-party-projects`:**

| Attribute            | Type         | Notes                                                                                      |
| -------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| `projectId`          | string       | PK. Regex `^[a-z0-9][a-z0-9-]{0,63}$`. Matches folder name under `/home/ubuntu/projects/`. |
| `path`               | string       | Absolute, always `${PROJECTS_ROOT}/${projectId}`. Denormalized for convenience.            |
| `bmadStatus`         | string       | `MISSING` \| `INSTALLING` \| `HEALTHY` \| `DRIFTED` \| `CORRUPTED` \| `FAILED`             |
| `bmadVersion`        | string?      | e.g. `6.0.0-alpha.7`. Null if not installed.                                               |
| `customAgentsSHA`    | string?      | SHA256 hex of sorted-concat custom agent files.                                            |
| `agentCount`         | number?      | Total rows in agent-manifest.csv. Expected: 24 (16 stock + 8 custom).                      |
| `expectedAgentCount` | number       | Static `24` for now; param of the BMAD version.                                            |
| `lastInspectedAt`    | string (ISO) | Updated on every inspect.                                                                  |
| `lastBootstrapJobId` | string?      | Most recent bootstrap job.                                                                 |
| `failureReason`      | string?      | Set when `FAILED`.                                                                         |
| `createdAt`          | string (ISO) |                                                                                            |
| `updatedAt`          | string (ISO) |                                                                                            |

**`futurator-party-sessions`:**

| Attribute            | Type          | Notes                                                                |
| -------------------- | ------------- | -------------------------------------------------------------------- |
| `sessionId`          | string        | PK. UUID v4.                                                         |
| `projectId`          | string        | FK-ish.                                                              |
| `projectPath`        | string        | Denormalized.                                                        |
| `claudeSessionId`    | string?       | Captured from Claude CLI on turn 1. Null until first turn completes. |
| `status`             | string        | `ACTIVE` \| `PROCESSING` \| `IDLE` \| `ERROR` \| `ARCHIVED`          |
| `turnCount`          | number        | Increments per user turn.                                            |
| `lastTurnAt`         | string (ISO)? |                                                                      |
| `createdAt`          | string (ISO)  |                                                                      |
| `topic`              | string?       | Optional label the user can set.                                     |
| `bmadVersionAtStart` | string        | Frozen on session create.                                            |
| `GSI1PK`             | string        | = `projectId`                                                        |
| `GSI1SK`             | string        | = `createdAt`                                                        |

GSI1 enables "list sessions for project X, newest first."

### Manifest Rebuild Algorithm (Critical)

Pseudocode for `daemon/pipelines/lib/rebuild-manifest.mjs`:

```
rebuildManifest(bmadRoot):
  files = glob(`${bmadRoot}/**/agents/*.md`)
    .filter(path =>
      !path.endsWith('.source.md') &&
      !path.endsWith('.customize.yaml')
    )

  rows = []
  for each file in files:
    content = readFile(file)
    agentBlock = extractXmlBlock(content, 'agent')  // the first <agent id="..."> ... </agent>
    metadata = {
      name: attr(agentBlock, 'name'),
      title: attr(agentBlock, 'title'),
      icon: attr(agentBlock, 'icon'),
    }
    // Persona fields are embedded in different shapes per agent:
    // - Some have explicit <role>, <identity>, <communication_style>, <principles> children.
    // - Custom agents (e.g., Ludwig, Rick) embed them in the activation/persona sections.
    // - Strategy: extract by known tag names; fall back to empty string.
    persona = {
      role: extractTagContent(content, 'role') ?? '',
      identity: extractTagContent(content, 'identity') ?? '',
      communicationStyle: extractTagContent(content, 'communication_style') ?? '',
      principles: extractTagContent(content, 'principles') ?? '',
    }
    module = deriveModule(file, bmadRoot)  // 'core' | 'bmb' | 'bmm' | 'cis' | 'agents'
    relPath = relative(bmadRoot, file)  // e.g. 'bmad/agents/rick-innovation/rick-innovation.md'
    rows.push({ ...metadata, ...persona, module, path: relPath })

  rows.sort((a, b) => moduleOrder(a.module) - moduleOrder(b.module))
    // moduleOrder: core=0, bmb=1, bmm=2, cis=3, agents=4

  csv = toCsv(rows, columnOrder: [
    'name', 'displayName', 'title', 'icon', 'role', 'identity',
    'communicationStyle', 'principles', 'module', 'path'
  ])  // displayName fallback = name if absent in block

  writeFile(`${bmadRoot}/_cfg/agent-manifest.csv`, csv)
  return rows.length  // expected 24
```

CSV escaping MUST handle fields containing commas, double quotes, and newlines (principles are multi-sentence prose). Use RFC 4180: wrap field in `"`, double any internal `"`. Test coverage must include at least one agent with commas and quotes in persona fields.

### Bootstrap Pipeline Steps

`daemon/pipelines/party-bootstrap.mjs`, input `{ projectId, projectPath, forceReinstall=false }`:

1. **Validate** — `projectPath` starts with `PROJECTS_ROOT`; `projectId` matches regex; project dir exists (`fs.stat`). Emit `party.bootstrap.step.started { step: 'validate' }`, then `.completed`.
2. **Refresh agent source** — `git -C $BMAD_AGENTS_SOURCE fetch --depth 1 origin main` then `git reset --hard origin/main`. Emit step events.
3. **Install BMAD** — if `bmad/_cfg/manifest.yaml` already exists AND version matches `BMAD_VERSION` AND `!forceReinstall` → skip install, log `idempotent-skip`. Else run `npx bmad-method@$BMAD_VERSION install --directory $projectPath --modules core,bmm,cis --tools claude-code --yes`. Capture stdout as `.output` events.
4. **Sync custom agents** — `rsync -av --checksum --delete $BMAD_AGENTS_SOURCE/ $projectPath/bmad/agents/`. Emit step events.
5. **Rebuild manifest** — call `rebuildManifest($projectPath/bmad)`, capture returned count. Emit step events.
6. **Compute custom-agents SHA** — read each file under `$projectPath/bmad/agents/**/*.md`, sort by path, concat, SHA256.
7. **Verify** — parse regenerated CSV, assert row count === `expectedAgentCount` (24). On mismatch → `FAILED` with reason.
8. **Persist** — update `futurator-party-projects` row: `bmadStatus='HEALTHY'`, `bmadVersion`, `customAgentsSHA`, `agentCount`, `lastInspectedAt`, `updatedAt`.
9. **Complete** — emit `party.bootstrap.completed`.

On any step error: set `bmadStatus='FAILED'`, `failureReason=<message>`, emit `.failed`. No auto-retry.

**Idempotency guarantee:** running bootstrap twice in a row on a healthy project results in: refresh source (cheap), skip install (idempotent branch), rsync (no-op if identical), rebuild manifest (deterministic), verify (passes). End state unchanged, status updated `lastInspectedAt`.

### Inspector Steps

`daemon/pipelines/party-inspector.mjs`, input `{ projectId, projectPath }`:

1. `fs.stat $projectPath` — if missing → not inspectable (404 at API layer).
2. `fs.stat $projectPath/bmad/_cfg/manifest.yaml` — if missing → `MISSING`.
3. Read `manifest.yaml`, extract `installation.version`.
4. Read `$projectPath/bmad/_cfg/agent-manifest.csv`; if missing → `CORRUPTED`.
5. Parse CSV; count rows. If parse fails → `CORRUPTED`.
6. Compute `customAgentsSHA` from current `$projectPath/bmad/agents/**/*.md`.
7. Compute expected `customAgentsSHA` from `$BMAD_AGENTS_SOURCE/**/*.md` (cached with 30s TTL).
8. If SHAs differ → `DRIFTED`; else if version differs from `$BMAD_VERSION` → `DRIFTED` (version drift); else → `HEALTHY`.
9. Update the project row (PutItem) or return the computed state (caller persists).

Inspector is cheap (~ms) — safe to call on every session open.

### Party Turn Execution

`daemon/pipelines/party-turn.mjs`, input `{ sessionId, message }`:

1. Load session row. Assert `status IN (ACTIVE, IDLE)`. Transition to `PROCESSING` via conditional UpdateCommand (lock).
2. Append user message to agent-events as `party.turn.user`.
3. Prepare subprocess command:
   - Turn 1 (claudeSessionId is null): `claude -p '/bmad:core:workflows:party-mode\n\n<message>' --session-id <generated-uuid> --output-format stream-json --verbose`
   - Turn N: `claude -p '<message>' --resume <claudeSessionId> --output-format stream-json --verbose`
4. Spawn child: `cwd = projectPath`, `env = { ...process.env, ANTHROPIC_API_KEY: <from SSM> }`, `stdio=['ignore','pipe','pipe']`.
5. Pipe stdout through NDJSON parser → forwarder. Each JSON line → one event. Event types observed:
   - `system.init` — capture `session_id`, persist as `claudeSessionId` if null.
   - `assistant` — emit `party.turn.assistant.token` or `.agent` (split by agent-name markers in content).
   - `result` — turn complete.
6. On child exit 0: set session `status='ACTIVE'`, increment `turnCount`, set `lastTurnAt`, emit `party.turn.completed`.
7. On child exit ≠ 0 or timeout (180s): kill, set `status='ERROR'`, emit `party.turn.error`.

### Concurrency & Locking

- **Bootstrap lock per project:** conditional UpdateCommand on `futurator-party-projects` row: `SET bmadStatus = :installing` with `ConditionExpression: bmadStatus IN (:missing, :drifted, :healthy, :failed, :corrupted)` — fails if already `INSTALLING`. API returns 409 Conflict.
- **Turn lock per session:** conditional UpdateCommand on `futurator-party-sessions`: `SET #status = :processing` with `ConditionExpression: #status IN (:active, :idle)` — fails if `PROCESSING`. API returns 409 Conflict.
- **Cross-session**: no coupling. Multiple sessions on the same project can be active simultaneously (Claude CLI handles distinct session IDs).
- **Single operator**: no user-level concurrency concerns.

### Failure Modes

| Failure                                        | Detection                                                  | Handling                                                                                                                                                                         |
| ---------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npx install` fails (network, registry 503)    | Non-zero exit from install step                            | `bmadStatus=FAILED`, user retries via UI                                                                                                                                         |
| Disk full                                      | ENOSPC from write steps                                    | Surface exact error; no partial-state commit                                                                                                                                     |
| Claude subprocess timeout (> 180s)             | Per-turn watchdog                                          | Kill, `status=ERROR`, allow retry                                                                                                                                                |
| EC2 reboot mid-job                             | `stale-heartbeat.mjs` picks up stale job on daemon restart | Bootstrap: restart from step 1 (idempotent). Turn: retry from last complete turn — `claudeSessionId` persists on disk under `/home/ubuntu/.claude/`, so user message is re-sent. |
| Custom-agent source clone missing              | Fail-fast in step 2 of bootstrap                           | Clear error, operator must clone the repo manually                                                                                                                               |
| Manifest rebuild produces ≠ 24 rows            | Verify step                                                | `bmadStatus=FAILED`, `failureReason='manifest: expected 24 rows, got N'`                                                                                                         |
| CSV parse fails on inspect                     | Inspector step 5                                           | Status `CORRUPTED`; re-running bootstrap fixes                                                                                                                                   |
| Claude CLI version mismatch with session files | Observable as resume errors                                | Out of scope for P0 — treated as generic ERROR                                                                                                                                   |

---

## Development Setup

**Prerequisites (local — admin app):**

- Node 20.x
- Repo cloned; `npm install` at root; `cd daemon && npm install`.
- Valid AWS credentials for dev account (existing pattern).
- Google OAuth dev client configured (existing pattern).

**Local dev:**

```bash
npm run dev          # Next dev server on :3000
npm run typecheck    # tsc --noEmit
npm run lint         # eslint --max-warnings 0
npm run test         # vitest run
npm run test -- functions/shared/repositories/__tests__/party-projects-repository.test.ts
npm run test:e2e     # Playwright smoke, starts dev server
```

**Local daemon dev:**

The daemon runs on EC2 in production. For local iteration, you can run `cd daemon && npm run dev` against a local DDB or a dev account's tables, but Party features that spawn `claude -p` require the Claude CLI locally. Most new daemon code can be unit-tested (mocked `spawn`, mocked fs) without running the live daemon.

**EC2 one-time setup (Ubuntu):**

```bash
# As ubuntu user:
git clone --depth 1 https://github.com/<org>/futurator-admin.git \
  /home/ubuntu/bmad-agents-source

# Ensure projects root exists
mkdir -p /home/ubuntu/projects

# Verify tools
node --version         # 20.x
claude --version       # installed
rsync --version
git --version
npx --version
```

**Deploy:**

```bash
sst deploy             # Provisions new DDB tables, updates API Lambda
# Sync daemon code to EC2
rsync -av daemon/ ubuntu@ec2-host:/home/ubuntu/futurator-daemon/
ssh ubuntu@ec2-host 'sudo systemctl restart futurator-daemon'
```

---

## Implementation Guide

### Setup Steps

Before coding:

1. Create feature branch: `feat/labs-party-module`.
2. Verify local `npm run dev` works and existing Labs modules load.
3. Verify `sst deploy` works in dev account (no code changes yet).
4. Read the "Relevant Existing Code" list end-to-end.
5. Verify EC2 prerequisites: `bmad-agents-source` clone exists (or add a setup story to create it).
6. Optional: set up a throwaway EC2 project folder like `/home/ubuntu/projects/party-test/` for integration testing.

### Implementation Steps (organized by story)

**Story 1 — Foundations (types, schemas, repositories, SST tables).**

Produces: Zod schemas + types + repositories + DDB tables deployed to dev. No new API routes yet. Unit tests pass.

1. `functions/shared/types/party.ts` — `PartyProject`, `PartySession`, `BmadStatus` union, `PartyEventType` union.
2. `functions/shared/schemas/party-schema.ts` — `PartyProjectSchema`, `PartySessionSchema`, `CreateSessionInputSchema`, `SendMessageInputSchema`, `BootstrapInputSchema`. Include the `projectId` regex and `message` max-length.
3. `functions/shared/repositories/party-projects-repository.ts` — `getProject`, `listProjects`, `putProject`, `updateProjectStatus`, conditional lock-transition helper.
4. `functions/shared/repositories/party-sessions-repository.ts` — `createSession`, `getSession`, `listSessionsByProject` (via GSI1), `updateSessionStatus`, `incrementTurn`, lock-transition helper.
5. `functions/shared/repositories/__tests__/*.test.ts` — CRUD + lock-conflict cases with `@aws-sdk/client-dynamodb` mocked via `vi.mock`.
6. `functions/shared/schemas/__tests__/party-schema.test.ts` — positive + negative cases per schema.
7. `sst.config.ts` — add `PartyProjects` and `PartySessions` tables. Link to API Lambda. Wire env vars.
8. `sst deploy` to dev; verify tables exist.

**Story 2 — Daemon bootstrap pipeline + inspector + manifest rebuilder.**

Produces: end-to-end bootstrap of an empty EC2 project folder → HEALTHY, 24 agents. Drift detection works. Tests pass.

1. `daemon/pipelines/lib/rebuild-manifest.mjs` — with extensive unit tests (see Testing Strategy).
2. `daemon/pipelines/lib/custom-agents-sha.mjs`.
3. `daemon/pipelines/lib/bmad-install.mjs` — wraps `npx`; idempotency branch; stdout capture.
4. `daemon/pipelines/lib/custom-agent-sync.mjs` — wraps `rsync`.
5. `daemon/pipelines/party-inspector.mjs` — status classification.
6. `daemon/pipelines/party-bootstrap.mjs` — orchestrates. Event emission via existing NDJSON forwarder.
7. `daemon/pipelines/job-router.mjs` — add `JOB_HANDLER_PARTY_BOOTSTRAP`, `JOB_HANDLER_PARTY_INSPECT`.
8. `daemon/agent-daemon.mjs` — import + dispatch.
9. `daemon/pipelines/__tests__/rebuild-manifest.test.mjs`, `party-bootstrap.test.mjs`, `party-inspector.test.mjs`.
10. Manual test on EC2 dev: run bootstrap against `/home/ubuntu/projects/party-test/`, assert 24 agents, party mode invokes successfully via a manual `claude -p '/bmad:core:workflows:party-mode'` in that dir.

**Story 3 — API: project routes (list, inspect, bootstrap).**

Produces: `/api/party/projects` endpoints backed by real data. Frontend still has no UI.

1. `functions/api/index.ts` — `GET /party/projects` (list + inspect each in one call; for P0, in-line inspector read from fs via… wait — Lambda can't access EC2 fs directly. The inspect route instead enqueues a `party-inspect` job, which updates the project row; the route returns the last-known row shape. Client polls.). Alternative: API returns cached row from DDB immediately; a separate "Refresh" action enqueues a new inspect. Chosen: **cache-first; inspect-on-demand.**
2. `GET /party/projects/:id`.
3. `POST /party/projects/:id/bootstrap` — enqueue `party-bootstrap` job; return `jobId`.
4. `GET /party/projects/:id/bootstrap/:jobId/events?since=<seq>` — reuse existing events endpoint pattern.
5. Zod validation + auth middleware applied.
6. Manual verify: curl through all routes, observe DDB rows update as daemon processes jobs.

**Story 4 — Frontend: Labs Party tab + project list + bootstrap UI.**

Produces: visible Party tab with project list, status badges, install buttons, live bootstrap progress. Session UI not yet wired.

1. `src/types/party.ts`, `src/stores/party-store.ts`.
2. `src/hooks/use-party-projects.ts`, `use-party-bootstrap.ts`.
3. `src/components/labs/party/project-status-badge.tsx`, `project-list.tsx`, `bootstrap-progress.tsx`, `index.tsx`.
4. `src/app/labs/party/page.tsx`.
5. Register Party tab in the Labs navigation (file TBD — inspect existing Labs shell).
6. Playwright smoke: `/labs/party` renders the list (with mocked API), clicking install triggers the mutation.

**Story 5 — Daemon party-turn pipeline.**

Produces: given a session + user message, daemon spawns Claude, streams NDJSON to events, captures and persists `claudeSessionId`. Tested with mocked spawn.

1. `daemon/pipelines/party-turn.mjs` — spawn + stream + parse + persist.
2. `daemon/pipelines/job-router.mjs` — add `JOB_HANDLER_PARTY_TURN`.
3. `daemon/pipelines/__tests__/party-turn.test.mjs` — mocked `child_process.spawn`; simulate stream-json output; assert `claudeSessionId` extracted and events emitted in correct order.

**Story 6 — API: sessions.**

Produces: session CRUD over `/api/party/sessions`.

1. `POST /party/sessions` — body `{ projectId, topic? }`; assert project HEALTHY; create row.
2. `GET /party/sessions/:id`.
3. `POST /party/sessions/:id/messages` — body `{ content }`; acquire session lock (conditional update to PROCESSING); enqueue `party-turn` job; return `{ jobId }`.
4. `GET /party/sessions/:id/events?since=<seq>` — reuse event-poll pattern.
5. Zod + auth.

**Story 7 — Frontend: session chat UI.**

Produces: click Party on a HEALTHY project → chat opens → send message → see 2–3 agents respond in streaming multi-voice.

1. `src/hooks/use-party-sessions.ts`, `use-party-session.ts`.
2. `src/components/labs/party/session-header.tsx`, `session-chat.tsx`.
3. Wire into `src/components/labs/party/index.tsx` as the right-pane when a session is active.
4. Render agent-boundary events as speaker changes; render tokens within a speaker as they stream.
5. Playwright smoke: open session, send message (mocked), observe stream rendering.

### Testing Strategy

**Unit tests (Vitest) — MUST:**

- `rebuild-manifest.mjs` — property-shaped test matrix:
  - Minimal tree with 1 core agent → 1 CSV row, correct module column.
  - Full synthetic tree with 16 + 8 agents → 24 rows in exact expected order (core, bmb, bmm, cis, agents).
  - Agent file with commas in `principles` → CSV correctly escapes.
  - Agent file with double-quotes in `identity` → `"` doubled in output.
  - Agent file missing `role` tag → empty string, no crash.
  - `.source.md` and `.customize.yaml` siblings → excluded.
- `party-inspector.mjs` — status matrix:
  - No `bmad/` → MISSING
  - `bmad/` present, no CSV → CORRUPTED
  - CSV present, wrong count → CORRUPTED (or DRIFTED — pick one; spec says CORRUPTED when parse fails, DRIFTED when version/SHA mismatch; row count === 24 is part of HEALTHY check)
  - SHA mismatch with source → DRIFTED
  - Version mismatch with `BMAD_VERSION` → DRIFTED
  - All matches → HEALTHY
- `bmad-install.mjs` — idempotency branch:
  - Existing manifest.yaml matching version → skips install (no spawn call).
  - Existing manifest.yaml with older version → runs install.
  - Missing manifest.yaml → runs install.
- `party-turn.mjs` — with `vi.mock('child_process')`:
  - Turn 1: spawn called with `--session-id` and party-mode prefix; captures `session_id` from stream-json; persists to session row.
  - Turn N: spawn called with `--resume`, no party-mode prefix.
  - Exit 0: emits `party.turn.completed`.
  - Exit ≠ 0: emits `party.turn.error`.
  - Timeout: kills process; emits error.
- `party-projects-repository.ts` / `party-sessions-repository.ts` — CRUD + conditional-update lock transitions, both success and conflict paths.
- `party-schema.ts` — valid + invalid inputs for each schema.
- Frontend hooks — basic render + fetch-success / fetch-error (React Testing Library + mocked fetch).

**Integration tests:**

- Vitest against a dev DDB endpoint is OUT OF SCOPE for P0; unit tests with mocked clients are sufficient. Revisit if repositories grow complex.

**E2E (Playwright smoke, 1 test):**

- Visit `/labs/party`, assert project list renders from a mocked API response (8 rows). Click Install on one. Assert bootstrap-progress appears. Assert transition to HEALTHY badge after mocked completion.

**Manual tests on EC2 dev:**

1. Bootstrap a throwaway `/home/ubuntu/projects/party-test/` folder. Verify 24 agents in manifest. Open a terminal on EC2, `cd` into folder, run `claude -p '/bmad:core:workflows:party-mode'` and confirm all 8 custom agents surface.
2. Full turn loop: send a message via UI, observe streaming response, send a follow-up, verify party agents retain memory of turn 1.
3. Induce drift: `touch /home/ubuntu/bmad-agents-source/bmad/agents/ludwig/ludwig.md`, git commit, push. Next inspector run on any party project should show DRIFTED.
4. Bootstrap idempotency: run bootstrap twice on a HEALTHY project; second run should skip install, re-sync agents (no-op), pass verify.

### Acceptance Criteria

Each criterion is binary-testable. These flow directly into story ACs.

1. **AC1 — Project listing renders.** Given `/home/ubuntu/projects/` contains 8 folders, when the user opens `/labs/party`, they see 8 rows each with a project name and a status badge. All badges show `MISSING` on first load (no `bmad/` installed yet).
2. **AC2 — Bootstrap happy path.** Given a project with `bmadStatus=MISSING`, when the user clicks "Install BMAD", then (a) a bootstrap job is enqueued, (b) progress events stream live to the UI within 5s of enqueue, (c) on success within 3 minutes `bmadStatus=HEALTHY`, `agentCount=24`, `bmadVersion='6.0.0-alpha.7'`, `customAgentsSHA` is set.
3. **AC3 — Bootstrap conflict.** Given a project with `bmadStatus=INSTALLING`, when the user clicks "Install BMAD" again, the API returns 409 and the UI surfaces "Install already in progress."
4. **AC4 — Session create.** Given a project with `bmadStatus=HEALTHY`, when the user clicks "New Party", then a session row is created with `status=ACTIVE`, `turnCount=0`, `bmadVersionAtStart='6.0.0-alpha.7'`.
5. **AC5 — Turn 1 streams live multi-voice.** Given an ACTIVE session and no prior turns, when the user sends "Discuss this project", then within 60s the UI renders responses from 2–3 distinct agents (e.g., "Mary:", "Winston:", "Rick:"), tokens stream progressively, and after completion `session.claudeSessionId` is non-null and `turnCount=1`.
6. **AC6 — Turn N retains memory.** Given a session with `turnCount >= 1`, when the user sends a follow-up that references a fact from turn 1, the agents' response demonstrates recall of that fact (manual qualitative check).
7. **AC7 — Drift detection surfaces correctly.** Given a HEALTHY project and a change to the custom-agent source repo, when the user opens the project (or clicks "Refresh"), the status shows `DRIFTED` and a "Re-sync" button is offered.
8. **AC8 — Re-sync restores HEALTHY.** Given `bmadStatus=DRIFTED`, when the user clicks "Re-sync", then a bootstrap job runs (skip-install branch), re-syncs agents + rebuilds manifest, and `bmadStatus=HEALTHY` with updated `customAgentsSHA`.
9. **AC9 — Project path validation.** Given a POST to any party endpoint with a `projectId` that does not match `^[a-z0-9][a-z0-9-]{0,63}$` or a path outside `PROJECTS_ROOT`, the API returns 400 `{ error: { code: 'INVALID_INPUT', ... } }`.
10. **AC10 — Session lock.** Given an ACTIVE session with `status=PROCESSING`, when a POST to `/messages` is made, the API returns 409 `{ error: { code: 'SESSION_BUSY', ... } }`.
11. **AC11 — Agent manifest fidelity.** Given a freshly bootstrapped project, reading `bmad/_cfg/agent-manifest.csv` yields exactly 24 rows with names including all of: `bmad-master, bmad-builder, analyst, architect, dev, pm, sm, tea, tech-writer, ux-designer, brainstorming-coach, creative-problem-solver, design-thinking-coach, innovation-strategist, storyteller, ludwig, pedrock, dave-ups-aws-devops, sean-tinel-aws-security, nimbus-aws-sa, kube-rick-containers, sue-render, rick-innovation` (plus `bmad-master` and `bmad-builder` for 16 stock total — note: core has `bmad-master`, bmb has `bmad-builder`, bmm has 8, cis has 5; 1+1+8+5+8 = 23; stock is 15 + 8 custom = 23). **Correction:** expected count is **23** per current manifest. Update `expectedAgentCount` config to `23`.

> **Note on agent count correction:** Earlier in the party-mode discussion we cited "24 = 16 + 8." Actual current manifest has 15 stock (1 core + 1 bmb + 8 bmm + 5 cis) + 8 custom = 23. `expectedAgentCount=23`. This tech-spec updates the expected value to 23; all ACs and tests use 23.

---

## Developer Resources

### File Paths Reference

Complete set of files this tech-spec touches:

**Created (frontend):**

- `src/app/labs/party/page.tsx`
- `src/components/labs/party/index.tsx`
- `src/components/labs/party/project-list.tsx`
- `src/components/labs/party/project-status-badge.tsx`
- `src/components/labs/party/bootstrap-progress.tsx`
- `src/components/labs/party/session-chat.tsx`
- `src/components/labs/party/session-header.tsx`
- `src/hooks/use-party-projects.ts`
- `src/hooks/use-party-bootstrap.ts`
- `src/hooks/use-party-sessions.ts`
- `src/hooks/use-party-session.ts`
- `src/stores/party-store.ts`
- `src/types/party.ts`

**Created (backend):**

- `functions/shared/repositories/party-projects-repository.ts`
- `functions/shared/repositories/party-sessions-repository.ts`
- `functions/shared/schemas/party-schema.ts`
- `functions/shared/types/party.ts`
- `functions/shared/repositories/__tests__/party-projects-repository.test.ts`
- `functions/shared/repositories/__tests__/party-sessions-repository.test.ts`
- `functions/shared/schemas/__tests__/party-schema.test.ts`

**Created (daemon):**

- `daemon/pipelines/party-bootstrap.mjs`
- `daemon/pipelines/party-turn.mjs`
- `daemon/pipelines/party-inspector.mjs`
- `daemon/pipelines/lib/bmad-install.mjs`
- `daemon/pipelines/lib/custom-agent-sync.mjs`
- `daemon/pipelines/lib/rebuild-manifest.mjs`
- `daemon/pipelines/lib/custom-agents-sha.mjs`
- `daemon/pipelines/__tests__/rebuild-manifest.test.mjs`
- `daemon/pipelines/__tests__/party-bootstrap.test.mjs`
- `daemon/pipelines/__tests__/party-inspector.test.mjs`
- `daemon/pipelines/__tests__/party-turn.test.mjs`

**Modified:**

- `functions/api/index.ts`
- `daemon/agent-daemon.mjs`
- `daemon/pipelines/job-router.mjs`
- `daemon/README.md`
- `sst.config.ts`
- `CLAUDE.md`
- Labs navigation registry (file TBD during Story 4)

**Created (docs):**

- `docs/tech-spec-party-module.md` (this file)

### Key Code Locations

- **Party UI entry:** `src/components/labs/party/index.tsx`
- **Session chat root:** `src/components/labs/party/session-chat.tsx`
- **Bootstrap pipeline entry:** `daemon/pipelines/party-bootstrap.mjs` → exported `runPartyBootstrap(job, ctx)`
- **Turn pipeline entry:** `daemon/pipelines/party-turn.mjs` → exported `runPartyTurn(job, ctx)`
- **Inspector entry:** `daemon/pipelines/party-inspector.mjs` → exported `inspectProject({ projectId, projectPath })`
- **Manifest rebuilder entry:** `daemon/pipelines/lib/rebuild-manifest.mjs` → exported `rebuildManifest(bmadRoot)`
- **Repositories entry points:** one per CRUD operation in each repository file (see Story 1 list)
- **API route declarations:** appended near end of `functions/api/index.ts` under the existing `/api` path

### Testing Locations

- Frontend unit / component tests: co-located with source under `src/components/labs/party/__tests__/` and `src/hooks/__tests__/`.
- Frontend E2E: `tests/e2e/party.smoke.spec.ts` (one file, one test).
- Backend unit: `functions/shared/**/__tests__/*.test.ts`.
- Daemon unit: `daemon/pipelines/__tests__/*.test.mjs`.
- No integration test tier for P0.

### Documentation to Update

- **`CLAUDE.md`** — add a brief section under Architecture → Labs mentioning the Party module and the EC2 `bmad-agents-source` clone prerequisite.
- **`daemon/README.md`** — add EC2 setup step for cloning the admin repo as custom-agent source.
- **`docs/architecture.md`** — add a "Labs: Party module" subsection referencing this tech-spec.
- Consider promoting this tech-spec's "Technical Approach" section into a `docs/concepts/party-architecture.md` concept doc in a follow-up if the module grows beyond P0.

---

## UX/UI Considerations

Party is a frontend-visible feature (new Labs tab). UX details:

**Tab placement:** alongside existing Labs tabs (`agentic-workflow`, `claude-code-workflow`). Tab label: "Party". Icon: `PartyPopper` from `lucide-react` (1.7.0). Activation shows the Party root component.

**Project list view (left pane on desktop, full width on mobile):**

- Card grid (2–3 columns on desktop), one card per project folder.
- Card content: project name, full path, status badge, agent count (if HEALTHY), `bmadVersion` (if installed), last inspected timestamp.
- Status badge colors (semantic tokens from `src/styles`):
  - `HEALTHY` → `success` (green)
  - `DRIFTED` → `warning` (yellow)
  - `MISSING` → muted
  - `INSTALLING` → `accent-blue` pulsing
  - `FAILED` → `destructive` (red)
  - `CORRUPTED` → `destructive` (red)
- Primary action button on each card:
  - `MISSING` / `FAILED` → "Install BMAD"
  - `HEALTHY` → "New Party" + "Re-inspect" (secondary)
  - `DRIFTED` → "Re-sync agents" (primary) + "Start Party anyway" (secondary)
  - `INSTALLING` → disabled button showing progress spinner
- "Refresh inspector" action at top of list (triggers a `party-inspect` job for all projects).

**Bootstrap progress panel (right pane when install in progress):**

- Step-by-step list of pipeline steps with live status (pending / running / done / failed).
- Collapsible "Raw output" accordion showing tailing NDJSON events.
- On success → card auto-transitions to HEALTHY; progress panel disappears after 2s.
- On failure → error panel with the `failureReason`, a "Retry" button, and "View logs" link (scrolls to output).

**Session chat view (right pane when session active):**

- Top: `session-header.tsx` with project name, topic (editable inline), turn count, "New Party" (starts another session), "Archive session" (secondary).
- Middle: message thread.
  - User messages right-aligned, monospace, muted bg.
  - Agent messages left-aligned, each prefixed with `{icon} {displayName}:` and a subtle separator between agents within one turn.
  - Per-agent streaming indicator while tokens arrive.
  - "Agent asked you a question →" callout when the model asks a direct question (parsed from `[Awaiting user response...]` marker in content, or a new event type `party.turn.awaiting_user`).
- Bottom: input textarea (Cmd+Enter to send, Shift+Enter for newline), character count (8 KB max), send button. Input disabled while session `PROCESSING`.
- Empty-thread placeholder: "Pick a topic and introduce yourself to the room. The PM, Analyst, Architect, and 20 others are listening."

**Responsive:**

- Desktop ≥ 1024px: two-pane (project list + session/bootstrap).
- Tablet / mobile: single pane with back-navigation between list and session.

**Accessibility:**

- Keyboard navigation: Tab through cards, Enter to select, Cmd/Ctrl+Enter to send message.
- ARIA live region on the streaming area (`aria-live="polite"`) for screen readers.
- Status badges have text labels, not color-only.
- Focus ring on interactive elements per existing shadcn conventions.

**Existing design system:**

- Conform to Tailwind 4 + shadcn/ui semantic tokens (`success`, `warning`, `destructive`, `accent-blue` already defined per CLAUDE.md). No new design tokens.
- No new shadcn primitives added — Card, Button, Badge, Textarea, Dialog, Skeleton all exist.

---

## Testing Approach

**Test framework:** Vitest 3 (unit/component); Playwright 1.59.1 (E2E smoke).

**Test file conventions (conforming to existing):**

- TypeScript tests: `<name>.test.ts` co-located under `__tests__/`.
- Daemon JS tests: `<name>.test.mjs` co-located under `__tests__/`.
- One `describe` block per unit; `it` per behavior.
- `expect()` assertions; Jest-compatible matchers via Vitest.
- Mock with `vi.fn()`, `vi.mock()`, `vi.spyOn()`. No other mocking libraries.

**Coverage targets:**

- New code (party-\*): comprehensive unit coverage on schemas, repositories, manifest rebuilder, inspector, bootstrap orchestration, turn spawn logic.
- No hard threshold (repo has no threshold configured); reviewer judgment.
- Critical paths MUST have tests:
  - Manifest rebuild CSV escaping (commas, quotes, newlines).
  - Inspector status matrix (6 cells).
  - Bootstrap idempotency branch.
  - Session lock transitions (both success and conflict).

**E2E scope:** one smoke test per the existing Playwright convention. Assert the Party tab route renders and the list populates from a mocked API. No deeper interaction tests for P0.

**Manual test matrix (on EC2 dev):**

1. Bootstrap a throwaway project; verify 23-agent manifest and that `claude -p '/bmad:core:workflows:party-mode'` lists all custom agents.
2. End-to-end turn loop via UI.
3. Drift induction + detection + re-sync.
4. Bootstrap idempotency (twice in a row).
5. Bootstrap failure mode (intentionally break `bmad-agents-source` clone; verify FAILED status with clear reason).

---

## Deployment Strategy

### Deployment Steps

1. Create feature branch `feat/labs-party-module`.
2. Land PRs incrementally per story (Story 1 → 7). Each PR runs `npm run ci` (lint + format + knip + typecheck + test + build).
3. Before Story 3 (API routes), `sst deploy` to provision the two new DDB tables in dev.
4. Before Story 5 (daemon turn pipeline), ensure EC2 dev has `bmad-agents-source` cloned at `/home/ubuntu/bmad-agents-source/`.
5. Deploy daemon code to EC2 via existing rsync+systemd restart procedure after Stories 2 and 5 land.
6. After Story 7 merges to `main`:
   1. `sst deploy` from main → updates production API Lambda + provisions prod DDB tables.
   2. Sync daemon to prod EC2: `rsync -av daemon/ ubuntu@prod-ec2:/home/ubuntu/futurator-daemon/ && ssh ... 'sudo systemctl restart futurator-daemon'`.
   3. One-time (prod): `git clone --depth 1 <repo> /home/ubuntu/bmad-agents-source` on prod EC2 if not already present.
7. Smoke test in prod: open `/labs/party`, verify 8 projects visible, bootstrap one throwaway project, start a session, send one message.

### Rollback Plan

**Frontend/API rollback:**

- `git revert <merge-commit>` on main → `sst deploy` → previous Lambda + static bundle redeployed.
- DDB tables remain (empty, harmless).

**Daemon rollback:**

- Previous daemon binary preserved on EC2 by rsync convention (keep `futurator-daemon.prev/` alongside `futurator-daemon/`). `sudo systemctl stop futurator-daemon`, swap dirs, `sudo systemctl start futurator-daemon`.

**Data rollback:**

- Party tables have no PITR; data is ephemeral. If a bad deploy corrupts rows, operator can `aws dynamodb scan + batch-delete` or simply rename the tables and let SST recreate.
- Per-project BMAD installations on EC2 are not rolled back (they're project-local artifacts). If a bootstrap pipeline bug leaves a project in a bad state, operator runs a manual `rm -rf /home/ubuntu/projects/<id>/bmad/` and re-bootstraps.

**Hard cap:** if Party causes issues with the existing Labs flows (agentic-workflow, claude-code-workflow), revert the Labs nav registry change (single file) to hide the tab while keeping the DDB tables / daemon changes in place. No cross-contamination risk — Party is additive.

### Monitoring

**Reuse existing:**

- CloudWatch Lambda logs for `/aws/lambda/futurator-admin-api-*` (existing).
- Daemon stdout → `/var/log/futurator/events` (existing path from `agent-daemon.mjs`).
- DDB console for manual inspection of `futurator-party-projects` / `futurator-party-sessions`.

**New (P0 minimum):**

- No new CloudWatch alarms for P0 (single operator; manual observation suffices).
- Daemon logs should use structured fields (`jobType`, `projectId`, `sessionId`, `step`) for grep-ability.

**Metrics to informally track (post-MVP):**

- Bootstrap success rate (count of `HEALTHY` transitions / total bootstrap attempts).
- Median bootstrap duration (event log analysis).
- Turn round-trip latency (user-message → turn-completed).
- Custom-agent drift events per week (signal for when to move custom-agent source to its own repo, per BMad Master's option 2 upgrade path).

**Post-MVP observability roadmap:**

- Add CloudWatch custom metrics from daemon once multi-user or higher-traffic patterns emerge.
- Add a "Party health" panel on the existing Admin dashboard summarizing per-project BMAD status at a glance.

## Post-Review Follow-ups

Items surfaced during code review of stories in this epic that warrant epic-scoped cleanup or follow-on work.

**From Story 15.4 review (2026-05-17):**

- **[Med]** `party-refresh.mjs` `emitStepStarted` emits `party.refresh.started` for every step (should be `party.refresh.step.started`). Add the event-type to `PartyEventType` and rewire. [`daemon/pipelines/party-refresh.mjs:54-60`, `functions/shared/types/party.ts:155-158`]
- **[Med]** `party-refresh.mjs` `emitStepOutput` emits `party.refresh.step.completed` for stdout/stderr streaming (should be `party.refresh.step.output`). Add the event-type to `PartyEventType` and rewire. [`daemon/pipelines/party-refresh.mjs:68-75`]
- **[Med]** No API-layer integration test for the four outcome paths of `POST /api/party/projects/:id/refresh`. Pattern: copy `functions/api/__tests__/app-create-route.test.ts` and adapt.
- **[Low]** Greenfield bootstrap step-event payloads don't carry `kind` field; brownfield events do. Add for symmetry. [`daemon/pipelines/party-bootstrap.mjs:75-79`]
- **[Low]** `BrownfieldProjectCard` lives in `index.tsx` instead of the originally-planned `project-list.tsx`. Either split or reword the task.
- **[Low]** Consider switching `createPartyProjectInputSchema` from `z.union` to `z.discriminatedUnion('kind', [...])` for performance + clarity. [`functions/shared/schemas/party-schema.ts:103-106`]
- **[Low]** Add defense-in-depth URL regex validation inside `createBrownfieldProjectRow`. [`functions/shared/repositories/party-projects-repository.ts:85-117`]
- **[N/A — out of scope, but tracked]** 4 pre-existing failures in `daemon/pipelines/__tests__/epic-dev-pipeline.test.mjs` block strict `npm run ci` green. Unrelated to Story 15.4 but blocks AC #13's literal "must pass" wording on this epic until addressed elsewhere.
