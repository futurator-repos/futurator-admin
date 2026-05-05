# Futurator-Admin — Epic: Labs Party Module

**Date:** 2026-04-17
**Project Level:** 1 (Coherent feature, 3 stories, ~13 story points)
**Tech-Spec:** [tech-spec-party-module.md](./tech-spec-party-module.md)
**Epic Number:** 15 (follows existing epic numbering: 9-theming, 10-data, 11-list, 12-edit, 13-content, 14-export)

---

## Epic 15: Labs Party Mode

**Slug:** `party-module`

### Goal

Give Richie a structured, multi-agent pre-epic deliberation surface in the Futurator-Admin Labs area. A "Party" tab lists EC2 project folders, retrofits BMAD onto any of them with one click, and then lets the operator converse with the 23-voice BMAD roster (15 stock + 8 custom) scoped to a specific project — debating design, generating documentation, and asking questions about the code, all before any implementation work begins. This closes the ideation gap between "raw idea in Richie's head" and "well-scoped PM epic."

### Scope

**In Scope:**

- New Labs tab "Party" visible alongside the existing `agentic-workflow` and `claude-code-workflow` tabs.
- Project listing of `/home/ubuntu/projects/*` with per-project BMAD install status (MISSING / HEALTHY / DRIFTED / CORRUPTED / INSTALLING / FAILED).
- One-click BMAD install-or-retrofit per project, pinned at `bmad-method@6.0.0-alpha.7`, custom agents seeded from `/home/ubuntu/bmad-agents-source/` (shallow clone of this admin repo).
- Agent-manifest rebuild that produces all 23 expected rows (15 stock + 8 custom) with RFC-4180 CSV escaping.
- Party session creation + turn loop via `claude -p --resume`, with live NDJSON streaming to the UI reusing the existing agent-events spine.
- Drift detection on session open (cheap SHA check of custom agents vs. source) with "Re-sync" remediation.
- Two new DynamoDB tables: `futurator-party-projects` and `futurator-party-sessions` (GSI1 by projectId).

**Out of Scope (deferred to separate tech-specs):**

- Export-to-PM-epic handoff (session summary → `agentic-workflow` epic generator).
- New-project creation UI (greenfield folder creation).
- Multi-user concurrency and session ownership.
- BMAD version upgrade flow per project.
- Session archive/delete/rename UX beyond MVP.

### Success Criteria

1. Operator can open `/labs/party` and see all 8 current EC2 projects listed with their BMAD status.
2. Operator can bootstrap a `MISSING` project to `HEALTHY` in under 3 minutes via one button click, with live progress.
3. Each bootstrapped project's `bmad/_cfg/agent-manifest.csv` contains exactly 23 rows with all expected agents.
4. Operator can start a Party session on a `HEALTHY` project, send messages, and see 2–3 named BMAD agents respond in streaming multi-voice within 60 seconds per turn.
5. Turn N retains context from turns 1…N-1 (session resumption works via `claude -p --resume`).
6. When custom agents change in this admin repo and are pulled to EC2, the inspector surfaces `DRIFTED`; "Re-sync" restores `HEALTHY` without breaking existing sessions.
7. All new code passes `npm run ci` (lint + format + knip + typecheck + test + build) with zero warnings.
8. No regression in existing Labs modules (`agentic-workflow`, `claude-code-workflow` still function).

### Dependencies

**External / operational:**

- EC2 host is Ubuntu (`/home/ubuntu/...`), already provisioned, running the futurator-daemon.
- One-time EC2 setup: clone this admin repo to `/home/ubuntu/bmad-agents-source/` (custom-agent source of truth).
- `npx`, `rsync`, `git`, and Claude CLI already present on EC2.
- Identity Broker + JWT auth unchanged; existing `auth-middleware.ts` gates all new routes.

**Internal:**

- Uses existing `Ec2Toggle` component and `useEc2Status` hook without modification.
- Reuses `futurator-agent-jobs` and `futurator-agent-events` DDB tables.
- Reuses `daemon/forwarder/ndjson-forwarder.mjs` and `daemon/pipelines/job-router.mjs` (extended, not replaced).

**No forward dependencies between stories** — each story leaves the system in a working state.

---

## Story Map — Epic 15

```
Epic 15: Labs Party Module
├── Story 15.1: BMAD per-project install & inspection (5 pts)
│   Dependencies: None (foundational)
│   Delivers: API-driven project list + install/inspect pipeline; verifiable via curl
│
├── Story 15.2: Party session orchestration & turn loop (3 pts)
│   Dependencies: Story 15.1 (needs HEALTHY project)
│   Delivers: API-driven party session lifecycle + streaming turns; verifiable via curl
│
└── Story 15.3: Labs Party UI (5 pts)
    Dependencies: Story 15.2 (needs end-to-end API surface)
    Delivers: User-visible Labs tab with project list, install buttons, session chat
```

**Total Story Points:** 13
**Estimated Timeline:** ~1.5 sprints (1.5 weeks at ~1 pt/day)

---

## Stories — Epic 15

### Story 15.1: BMAD per-project install & inspection

As **Richie (operator)**,
I want **to list my EC2 project folders and retrofit BMAD onto any of them with one click**,
so that **I can enable Party Mode on both new and existing projects without touching the EC2 shell**.

**Acceptance Criteria:**

- **AC #1** — Given `/home/ubuntu/projects/` contains 8 folders, when `GET /api/party/projects` is called with a valid JWT, then the response returns 8 entries each with `{projectId, path, bmadStatus, agentCount?, bmadVersion?, lastInspectedAt}`. On first call all 8 return `bmadStatus: 'MISSING'`.
- **AC #2** — Given a project with `bmadStatus=MISSING`, when `POST /api/party/projects/:id/bootstrap` is called, then a bootstrap job is created in `futurator-agent-jobs` with `jobType='party-bootstrap'` and the API returns `{jobId}`. The project row is atomically transitioned to `bmadStatus='INSTALLING'`.
- **AC #3** — Given a bootstrap job is `PENDING`, when the daemon picks it up, then it executes the 8-step pipeline (validate → refresh-source → install → sync-agents → rebuild-manifest → compute-sha → verify → persist) streaming `party.bootstrap.step.*` events to `futurator-agent-events`. On success the project row is updated to `bmadStatus='HEALTHY'`, `bmadVersion='6.0.0-alpha.7'`, `agentCount=23`, `customAgentsSHA` set.
- **AC #4** — Given a freshly bootstrapped project, when its `bmad/_cfg/agent-manifest.csv` is read, then it contains exactly 23 rows with columns in exact order `name,displayName,title,icon,role,identity,communicationStyle,principles,module,path`, row order is core → bmb → bmm → cis → agents, and all expected agent names are present: `bmad-master, bmad-builder, analyst, architect, dev, pm, sm, tea, tech-writer, ux-designer, brainstorming-coach, creative-problem-solver, design-thinking-coach, innovation-strategist, storyteller, ludwig, pedrock, dave-ups-aws-devops, sean-tinel-aws-security, nimbus-aws-sa, kube-rick-containers, sue-render, rick-innovation`.
- **AC #5** — Given `rebuild-manifest.mjs` is invoked on a `bmad/` tree where an agent's `principles` field contains commas and double quotes, when the CSV is written, then fields are wrapped in `"` and internal `"` is doubled per RFC 4180; the output parses correctly when read back.
- **AC #6** — Given a project with `bmadStatus=INSTALLING`, when a second `POST /api/party/projects/:id/bootstrap` is received, then the API returns 409 Conflict with error code `BOOTSTRAP_IN_PROGRESS` and the daemon does not create a duplicate job.
- **AC #7** — Given a project with `bmadStatus=HEALTHY`, when the custom-agent source on EC2 is modified (a `bmad/agents/*/*.md` file changes and is pulled) and the inspector is re-run, then `bmadStatus='DRIFTED'` on the project row and the response includes the old and new `customAgentsSHA`.
- **AC #8** — Given any project endpoint is called with a `projectId` not matching `^[a-z0-9][a-z0-9-]{0,63}$`, then the API returns 400 with error code `INVALID_INPUT`.
- **AC #9** — Given a bootstrap fails at any step (e.g., `npx install` returns non-zero), then the project row is set to `bmadStatus='FAILED'` with `failureReason` populated; no auto-retry is attempted; `party.bootstrap.failed` event is emitted.
- **AC #10** — All unit tests under `functions/shared/repositories/__tests__/party-projects-repository.test.ts`, `functions/shared/schemas/__tests__/party-schema.test.ts`, `daemon/pipelines/__tests__/rebuild-manifest.test.mjs`, `daemon/pipelines/__tests__/party-bootstrap.test.mjs`, and `daemon/pipelines/__tests__/party-inspector.test.mjs` pass.
- **AC #11** — `npm run ci` passes end-to-end (lint zero warnings, typecheck, test, build).

**Prerequisites:** None (foundational story). Operational one-time: `/home/ubuntu/bmad-agents-source/` must be a clone of this admin repo on EC2.

**Technical Notes:**

- Files created (foundations): `functions/shared/types/party.ts`, `functions/shared/schemas/party-schema.ts`, `functions/shared/repositories/party-projects-repository.ts`, `functions/shared/repositories/party-sessions-repository.ts` (sessions repo stub only; full session lifecycle in 15.2).
- Files created (daemon): `daemon/pipelines/party-bootstrap.mjs`, `daemon/pipelines/party-inspector.mjs`, `daemon/pipelines/lib/bmad-install.mjs`, `daemon/pipelines/lib/custom-agent-sync.mjs`, `daemon/pipelines/lib/rebuild-manifest.mjs`, `daemon/pipelines/lib/custom-agents-sha.mjs`.
- Files modified: `daemon/pipelines/job-router.mjs` (add `JOB_HANDLER_PARTY_BOOTSTRAP`, `JOB_HANDLER_PARTY_INSPECT`), `daemon/agent-daemon.mjs` (dispatch new job types), `functions/api/index.ts` (add 4 party project routes), `sst.config.ts` (add `PartyProjects` + `PartySessions` DDB tables), `daemon/README.md` (document `bmad-agents-source` clone setup), `CLAUDE.md` (brief Party note).
- See tech-spec §"Manifest Rebuild Algorithm" for the CSV-writer contract; §"Bootstrap Pipeline Steps" for the 8-step orchestration; §"Inspector Steps" for the status-classification logic.

**Estimated Effort:** 5 points (~5 days)

---

### Story 15.2: Party session orchestration & turn loop

As **Richie (operator)**,
I want **to start a Party session on a HEALTHY project and exchange streaming turns with the BMAD agents via an API**,
so that **the backend is provably capable of driving a multi-agent conversation before any UI exists**.

**Acceptance Criteria:**

- **AC #1** — Given a project with `bmadStatus=HEALTHY`, when `POST /api/party/sessions` is called with `{projectId, topic?}`, then a new session row is created in `futurator-party-sessions` with `status='ACTIVE'`, `turnCount=0`, `claudeSessionId=null`, `bmadVersionAtStart='6.0.0-alpha.7'`, `GSI1PK=projectId`, `GSI1SK=createdAt`, and the API returns `{sessionId, ...}`.
- **AC #2** — Given a project with `bmadStatus IN (MISSING, INSTALLING, FAILED, CORRUPTED, DRIFTED)`, when `POST /api/party/sessions` is called, then the API returns 409 with error code `PROJECT_NOT_HEALTHY` and no row is created.
- **AC #3** — Given an ACTIVE session with `turnCount=0`, when `POST /api/party/sessions/:id/messages` is called with `{content: "Discuss this project"}`, then (a) a `party-turn` job is enqueued, (b) session is locked by transitioning `status='PROCESSING'` atomically, (c) the daemon spawns `claude -p "/bmad:core:workflows:party-mode\n\nDiscuss this project" --session-id <uuid> --output-format stream-json --verbose` with `cwd=<projectPath>`, (d) stdout lines are parsed and emitted as `party.turn.*` events to `futurator-agent-events` keyed by `sessionId`.
- **AC #4** — Given turn 1 completes successfully, when the daemon parses the stream-json `system.init` event, then `claudeSessionId` is persisted on the session row and survives subsequent reads. After completion, session `status='ACTIVE'`, `turnCount=1`, `lastTurnAt` set.
- **AC #5** — Given a session with `turnCount >= 1` and `claudeSessionId` set, when `POST /api/party/sessions/:id/messages` is called with `{content: "follow-up"}`, then the daemon spawns `claude -p "follow-up" --resume <claudeSessionId> --output-format stream-json --verbose` (NO party-mode prefix on turn N). `turnCount` increments by 1.
- **AC #6** — Given a session with `status='PROCESSING'`, when a second `POST /messages` is received, then the API returns 409 with error code `SESSION_BUSY` and no second child process is spawned.
- **AC #7** — Given a turn runs longer than 180 seconds, when the watchdog fires, then the child process is killed, session transitions to `status='ERROR'`, `party.turn.error` event is emitted with reason `TIMEOUT`.
- **AC #8** — Given a message content exceeds 8192 bytes OR is not valid UTF-8 text, when `POST /messages` is called, then the API returns 400 with error code `INVALID_INPUT` and no turn is started.
- **AC #9** — Given an ACTIVE session, when `GET /api/party/sessions/:id/events?since=<seq>` is called, then it returns all events with sequence greater than `since`, ordered ascending, matching the event shape already used by existing pipelines.
- **AC #10** — All unit tests under `daemon/pipelines/__tests__/party-turn.test.mjs` and extended repository tests pass, including: turn 1 spawn-args assertion, turn N spawn-args assertion, `claudeSessionId` capture from mocked stream-json, timeout handling, exit-code-nonzero handling, session lock success and conflict paths.
- **AC #11** — Manual verification on EC2 dev: using curl only, create a session on a HEALTHY test project, send a message, observe streaming events, send a follow-up message, verify agents recall prior-turn content.
- **AC #12** — `npm run ci` passes end-to-end.

**Prerequisites:** Story 15.1 complete (needs `party-projects-repository`, `party-sessions-repository` stub, `futurator-party-sessions` table, a HEALTHY project to test against).

**Technical Notes:**

- Files created: `daemon/pipelines/party-turn.mjs`, `daemon/pipelines/__tests__/party-turn.test.mjs`.
- Files modified: `functions/shared/repositories/party-sessions-repository.ts` (full session-lifecycle functions: `createSession`, `getSession`, `listSessionsByProject`, `acquireSessionLock`, `releaseSessionLock`, `incrementTurn`, `setClaudeSessionId`), `functions/shared/schemas/party-schema.ts` (add `CreateSessionInputSchema`, `SendMessageInputSchema`), `functions/api/index.ts` (add 4 session routes: POST create, GET single, POST messages, GET events), `daemon/pipelines/job-router.mjs` (add `JOB_HANDLER_PARTY_TURN`), `daemon/agent-daemon.mjs` (dispatch new job type).
- Subprocess handling: use `child_process.spawn` with `cwd: session.projectPath`, `env: { ...process.env, ANTHROPIC_API_KEY: <from SSM> }`, `stdio: ['ignore', 'pipe', 'pipe']`. Parse stdout as NDJSON using existing forwarder pattern.
- See tech-spec §"Party Turn Execution" for the 7-step pipeline; §"Concurrency & Locking" for the conditional-update lock pattern; §"Integration Points → Claude CLI" for invocation details.

**Estimated Effort:** 3 points (~3 days)

---

### Story 15.3: Labs Party UI

As **Richie (operator)**,
I want **a visual "Party" tab in the Labs area where I can see my projects, click to install BMAD, and have a natural chat conversation with BMAD agents about a selected project**,
so that **Party Mode is accessible from the browser without ever opening a terminal on EC2**.

**Acceptance Criteria:**

- **AC #1** — Given the admin app loads and the user is authenticated, when they click the "Party" tab in the Labs navigation, then the route `/labs/party` renders and shows a project grid populated from `GET /api/party/projects` within 2 seconds of mount.
- **AC #2** — Given the project grid is rendered, when a project has `bmadStatus='HEALTHY'`, then its card shows a green `HEALTHY` badge, the `bmadVersion`, `agentCount`, `lastInspectedAt`, and primary action "New Party" with secondary "Re-inspect". When `bmadStatus='MISSING'`, the card shows a muted `MISSING` badge and primary action "Install BMAD".
- **AC #3** — Given the user clicks "Install BMAD" on a MISSING project, when the mutation fires, then the card transitions to a pulsing blue `INSTALLING` badge, a right-pane `BootstrapProgress` panel appears showing live step events polled every 1.5s, and on success within 3 minutes the card transitions to `HEALTHY` and the progress panel auto-dismisses after 2 seconds.
- **AC #4** — Given bootstrap fails, when `FAILED` is detected in the event stream, then the card shows a red `FAILED` badge with `failureReason` tooltip, a "Retry" button is offered, and the bootstrap progress panel remains visible with the error highlighted.
- **AC #5** — Given the user clicks "New Party" on a HEALTHY project, when a session is successfully created via `POST /api/party/sessions`, then the UI transitions to a chat view with a `SessionHeader` (project name, turn count, "New Party" / "Archive"), an empty thread with placeholder text, and a disabled-until-typed Input box supporting `Cmd+Enter` to send and `Shift+Enter` for newline.
- **AC #6** — Given an ACTIVE session and the user types a message and presses Cmd+Enter, when the mutation fires, then (a) input is cleared and disabled, (b) user message appears right-aligned in the thread, (c) within 60 seconds, 2–3 distinct BMAD agents' responses render left-aligned each prefixed with `{icon} {displayName}:`, tokens streaming progressively, (d) input re-enables when the turn completes.
- **AC #7** — Given a session event includes `party.turn.awaiting_user` (model asked a question), when the event is received, then a highlighted callout "Agent asked you a question →" appears above the input, referencing the asking agent by name.
- **AC #8** — Given the runtime mode is `local` (not `ec2`) via existing `Ec2Toggle`, when the user visits `/labs/party`, then the page shows a single message "Switch to EC2 to use Party Mode" and does not fetch the project list.
- **AC #9** — Given a DRIFTED project, when the user clicks "Re-sync agents", then a bootstrap job with `forceReinstall=false` is enqueued (re-sync branch), live progress streams, and on success the badge transitions to `HEALTHY`.
- **AC #10** — Given the Party tab has been built, when the user opens other Labs tabs (`agentic-workflow`, `claude-code-workflow`), then they still function identically to before (no regression). Existing Playwright smoke tests pass.
- **AC #11** — A new Playwright smoke test `tests/e2e/party.smoke.spec.ts` verifies: (a) `/labs/party` renders with a mocked 8-project response, (b) clicking Install triggers the mutation and the INSTALLING badge appears, (c) mocking a completion event transitions the card to HEALTHY.
- **AC #12** — All new files conform to existing conventions: file naming kebab-case, named exports only, `@/...` imports for `src/`, Prettier 3 defaults, ESLint 9 zero warnings.
- **AC #13** — `npm run ci` passes end-to-end.

**Prerequisites:** Stories 15.1 AND 15.2 complete (full API surface needed).

**Technical Notes:**

- Files created (frontend): `src/app/labs/party/page.tsx`, `src/components/labs/party/index.tsx`, `src/components/labs/party/project-list.tsx`, `src/components/labs/party/project-status-badge.tsx`, `src/components/labs/party/bootstrap-progress.tsx`, `src/components/labs/party/session-chat.tsx`, `src/components/labs/party/session-header.tsx`, `src/hooks/use-party-projects.ts`, `src/hooks/use-party-bootstrap.ts`, `src/hooks/use-party-sessions.ts`, `src/hooks/use-party-session.ts`, `src/stores/party-store.ts`, `src/types/party.ts` (frontend re-export of the backend types), `tests/e2e/party.smoke.spec.ts`.
- Files modified: the Labs navigation registry (file TBD during implementation — inspect where `agentic-workflow` and `claude-code-workflow` tabs register, e.g., `src/app/labs/page.tsx` or similar).
- Reused components (no changes): `src/components/labs/ec2-toggle.tsx`, `src/components/ui/*` (Card, Button, Badge, Textarea, Skeleton, Dialog), `src/lib/api-client.ts`, `src/hooks/use-ec2-daemon.ts`.
- UI patterns follow tech-spec §"UX/UI Considerations" — semantic status tokens, two-pane responsive layout, ARIA-live streaming area, keyboard shortcuts.
- Event polling: reuse the pattern from `src/components/labs/agentic-workflow/story-live-output.tsx`. Poll every 1.5s while session status is PROCESSING or bootstrap is INSTALLING; stop after 30s idle.

**Estimated Effort:** 5 points (~5 days)

---

## Implementation Timeline — Epic 15

**Total Story Points:** 13

**Estimated Timeline:** ~1.5 sprints (7–10 working days depending on testing depth).

**Sequencing rationale:**

1. **Story 15.1 first** — Foundations (types, schemas, repos, tables) + daemon bootstrap/inspector + read-path API. End state: can curl the full "list, install, check status" lifecycle. Zero UI; nothing user-visible yet. This proves the hardest part (manifest rebuild + idempotent bootstrap) early and unblocks both 15.2 and 15.3.
2. **Story 15.2 second** — Session lifecycle + turn spawn pipeline. End state: can curl a full conversation. Depends on 15.1 only for a HEALTHY project to target.
3. **Story 15.3 last** — All frontend wiring. Depends on the full API surface from 15.1 + 15.2. End state: Party tab is live, user-visible, shippable.

**Dependency Validation:** ✅ Valid sequence — no forward dependencies. Each story leaves the system in a working state (15.1 adds API without UI; 15.2 completes API without UI; 15.3 adds UI).

---

## Tech-Spec Reference

See [tech-spec-party-module.md](./tech-spec-party-module.md) for complete technical implementation details — the tech-spec is the single source of truth for file paths, code references, algorithms, schemas, and deployment steps. Stories cite specific tech-spec sections; do not re-specify implementation details in stories.
