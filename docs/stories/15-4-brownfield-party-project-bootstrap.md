# Story 15.4: Brownfield Party Project Bootstrap & Refresh

**Status:** review

---

## User Story

As **Richie (operator of Futurator-Admin)**,
I want **to register existing private GitHub repos as brownfield Party projects on EC2, with one-way sync from GitHub → EC2 controlled by an explicit Refresh action**,
So that **I can initiate BMAD party-mode debates against my real codebases (`debatator`, `applicator`, `songster`, `futurator`) from mobile, anywhere, while continuing to commit and push from my laptop as the single source of truth**.

---

## Acceptance Criteria

**AC #1** — `PartyProject` entity is extended with `kind: 'greenfield' | 'brownfield'` (discriminator field), optional `gitRepoUrl: string`, `gitBranch: string` (default `'main'`), `lastPulledAt: string | null`, `lastCommitSha: string | null`. **And** existing project rows are migrated to `kind: 'greenfield'` on first read via a lazy migration in `party-projects-repository.ts` (no batch script; absent field defaults to `'greenfield'`).

**AC #2** — Given a request to `POST /api/party/projects` with body `{ name, kind: 'brownfield', gitRepoUrl, gitBranch? }`, **when** validation runs, **then** `gitRepoUrl` MUST match regex `^https://github\.com/[\w.-]+/[\w.-]+(\.git)?$`, `name` is kebab-cased to derive `projectId` matching Story 15.1's existing `^[a-z0-9][a-z0-9-]{0,63}$`, `gitBranch` defaults to `'main'` if omitted. On success the project row is created with `kind='brownfield'`, `bmadStatus='INSTALLING'`, and a `party-bootstrap` job is enqueued with `payload.kind='brownfield'`. **And** the existing greenfield `POST /api/party/projects/:id/bootstrap` path remains unchanged.

**AC #3** — Given a `party-bootstrap` job is picked up by the daemon **and** `job.payload.kind === 'brownfield'`, **when** the pipeline executes, **then** it runs only: (a) `clone-repo` — `git clone --branch <gitBranch> --depth 50 <tokenized-url> <projectPath>`; (b) `verify` — assert `bmad/_cfg/agent-manifest.csv` exists with ≥ 1 row; (c) `compute-sha` — record `customAgentsSHA` from the cloned `bmad/agents/` tree (may be empty if the repo has no custom agents); (d) `persist` — set `bmadStatus='HEALTHY'`, `bmadVersion`, `agentCount`, `lastPulledAt=now`, `lastCommitSha`. **And** steps `refresh-source`, `install` (`npx bmad-method`), and `sync-agents` are SKIPPED because the cloned repo brings its own BMAD installation. Events emitted: `party.bootstrap.step.started/output/completed` for each executed step using the existing observability spine.

**AC #4** — The brownfield PAT is loaded once at daemon startup from AWS Secrets Manager secret `futurator/labs-brownfield-github-pat` (fine-grained, `contents:read` scope only, restricted to the four target repos: `debatator`, `applicator`, `songster`, `futurator`). **And** the PAT value is never logged, never written to any DDB row, never included in any event payload. The clone URL is constructed in-memory as `https://x-access-token:<token>@github.com/<owner>/<repo>.git` and is redacted in stdout/stderr capture and event output as `https://***@github.com/<owner>/<repo>.git` via the new `daemon/pipelines/lib/git-clone.mjs` helper. A unit test asserts redaction on a string containing a fake token.

**AC #5** — Given a brownfield clone completes but the resulting `projectPath` lacks `bmad/_cfg/agent-manifest.csv`, **when** the `verify` step runs, **then** the project row is set to `bmadStatus='FAILED'` with `failureReason='BMAD_NOT_FOUND_IN_REPO'`, no auto-retry is attempted, and event `party.bootstrap.failed` is emitted with reason field set. The operator must add BMAD to the upstream repo and re-register or delete and recreate.

**AC #6** — New endpoint `POST /api/party/projects/:id/refresh` (auth-gated). **And** for projects with `kind='greenfield'` returns 400 with error envelope `{ error: { code: 'INVALID_FOR_GREENFIELD', ... } }`. **And** for brownfield projects: enqueues a `party-refresh` job with `payload.projectId`; daemon runs `git fetch origin && git reset --hard origin/<gitBranch>` in `projectPath`, then re-runs the inspector (recompute `customAgentsSHA`, verify, persist). On success, the project row's `lastPulledAt` and `lastCommitSha` are updated and event `party.refresh.completed` is emitted with the new SHA.

**AC #7** — Given a brownfield project, **when** a refresh is requested while another refresh job for the same project is `PROCESSING`, **then** the API returns 409 with error code `REFRESH_IN_PROGRESS`. **And** when a refresh is requested while any session for that project has `status='PROCESSING'`, **then** the API returns 409 with error code `PROJECT_BUSY`. The lock is implemented as a conditional `UpdateCommand` on the project row transitioning `bmadStatus IN ('HEALTHY', 'DRIFTED') → 'REFRESHING'`, with the session-busy check performed via a query on `futurator-party-sessions` GSI1 (PK=projectId) filtering for `status='PROCESSING'`.

**AC #8** — Admin UI: an "Add Brownfield Project" entry-point button is added to the Labs Party page header (`src/components/labs/party/index.tsx`), opening a modal form with three fields: `name` (text, inline-validated against `^[a-z0-9][a-z0-9-]{0,63}$`), `gitRepoUrl` (text, inline-validated against the HTTPS GitHub URL regex from AC #2), `gitBranch` (text, default `main`). **And** form submission calls `POST /api/party/projects` with the brownfield shape, closes the modal on success, invalidates `['party', 'projects']`. **And** brownfield project cards display: a `Git` Lucide icon, the `gitRepoUrl` with middle-truncation when > 40 chars, the `gitBranch` as a small chip, and `lastPulledAt` rendered as relative time (`date-fns/formatDistanceToNow`). **And** brownfield cards show a "Refresh" secondary action (replacing the "Re-inspect" action used on greenfield cards); while a refresh job is `PROCESSING`, the button shows a spinning state and the card badge displays `REFRESHING`.

**AC #9** — The first turn of a brownfield party session uses the existing `/bmad-party-mode` slash command unchanged. **And** agents read the cloned repo via Claude Code's native `Read`/`Glob`/`Grep` tools under the existing `--permission-mode acceptEdits` posture. **And** per `[[brownfield-party-permission-mode]]` memory, NO path-scoped Edit/Write restrictions are added — incidental file edits are wiped by `git reset --hard` on the next refresh. **And** artifacts generated by debate-spawned BMAD workflows land at `<projectPath>/docs/` per each project's own `bmad/bmm/config.yaml:output_folder` and are retrievable via the existing `GET /api/party/projects/:id/files` endpoint with no modifications.

**AC #10** — Mobile UX parity at ≤768px breakpoint: the "Add Brownfield Project" modal form is visually correct and form fields are usable with thumb input; brownfield card layout reflows cleanly (Git icon + URL on one row, branch chip + `lastPulledAt` on next row, action buttons full-width). **And** the extended Playwright smoke test `tests/e2e/party.smoke.spec.ts` includes a viewport-768 assertion that the modal renders with all three input fields visible without horizontal scroll.

**AC #11** — A visible obligations reminder appears on each brownfield card: a small muted-text hint near `lastPulledAt` reading "Push first, then Refresh — EC2 mirrors GitHub" (or similar concise phrasing). No automation — the operator owns the commit/push/refresh loop. The reminder is also documented in `CLAUDE.md` under a new "Labs Party — Brownfield Usage" section.

**AC #12** — All new and extended unit tests pass:

- `functions/shared/repositories/__tests__/party-projects-repository.test.ts` — extended with: brownfield row create, lazy `kind='greenfield'` migration on read, `tryAcquireRefreshLock` success and conflict paths, `updateProjectAfterRefresh` (`lastPulledAt`, `lastCommitSha`).
- `functions/shared/schemas/__tests__/party-schema.test.ts` — extended with `BrownfieldProjectInputSchema` positive cases (valid HTTPS URL with and without `.git`, default branch handling) and negative cases (non-GitHub URL, SSH URL rejected, invalid name regex, branch with whitespace).
- `daemon/pipelines/__tests__/party-bootstrap.test.mjs` — extended with brownfield branch: clone-success path asserting only 4 steps run, missing-BMAD failure path asserting `failureReason='BMAD_NOT_FOUND_IN_REPO'`, secret-redaction assertion that the captured stderr does not contain the raw PAT.
- `daemon/pipelines/__tests__/party-refresh.test.mjs` (NEW) — fetch+reset success path, refresh-lock conflict (409 `REFRESH_IN_PROGRESS`), busy-session (409 `PROJECT_BUSY`), brownfield-only gate (400 `INVALID_FOR_GREENFIELD` exercised at the API layer), git error paths (network failure, branch not found).
- `daemon/pipelines/__tests__/git-clone.test.mjs` (NEW) — URL tokenization correctness, redaction filter against various raw-token formats, exit-code-nonzero handling.

**AC #13** — `npm run ci` passes end-to-end with zero lint warnings (`eslint --max-warnings 0`), passing typecheck, all tests, and successful build. **And** manual verification on EC2 dev: register `debatator`, `applicator`, `songster`, and `futurator` as brownfield projects; each clones to its own folder under `PROJECTS_ROOT`; each transitions to `bmadStatus='HEALTHY'`; tap Refresh on each — `lastPulledAt` and `lastCommitSha` update; start a party session on each — agents read the codebase and respond in multi-voice.

---

## Implementation Details

### Tasks / Subtasks

**Types, schemas, and repository extensions**

- [x] Modify `functions/shared/types/party.ts` — add fields `kind: 'greenfield' | 'brownfield'`, `gitRepoUrl?: string`, `gitBranch?: string`, `lastPulledAt?: string | null`, `lastCommitSha?: string | null` to `PartyProject`. Update `PartyEventType` union to include `'party.refresh.started' | 'party.refresh.step.completed' | 'party.refresh.completed' | 'party.refresh.failed'`. (AC #1, AC #6)
- [x] Modify `functions/shared/schemas/party-schema.ts` — add `BrownfieldProjectInputSchema` (zod) enforcing `kind: z.literal('brownfield')`, `gitRepoUrl: z.string().regex(/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/)`, `gitBranch: z.string().default('main')`. Add `RefreshRequestParamsSchema` (zod) for `:id` path validation reusing the existing `ProjectIdSchema` regex. Use `.safeParse()` only. (AC #2, AC #6)
- [x] Modify `functions/shared/repositories/party-projects-repository.ts` — (a) handle new fields in `getProject`, `listProjects` write/read paths with lazy `kind='greenfield'` migration when the field is absent on existing rows; (b) extend `putProject` to accept brownfield fields; (c) add `tryAcquireRefreshLock(projectId)` using conditional `UpdateCommand` (`ConditionExpression: 'bmadStatus IN (:healthy, :drifted)'` → `SET bmadStatus = :refreshing`); (d) add `releaseRefreshLock(projectId, newStatus)`; (e) add `updateProjectAfterRefresh(projectId, { lastPulledAt, lastCommitSha, customAgentsSHA })`. (AC #1, AC #6, AC #7)
- [x] Extend `functions/shared/repositories/__tests__/party-projects-repository.test.ts` per AC #12 list above. (AC #12)
- [x] Extend `functions/shared/schemas/__tests__/party-schema.test.ts` per AC #12. (AC #12)

**Daemon — git-clone helper (secret-safe)**

- [x] Create `daemon/pipelines/lib/git-clone.mjs` exporting `cloneRepo({ repoUrl, branch, token, targetPath, depth, ctx })`. Construct the tokenized URL in-memory only. Spawn `git clone --branch <branch> --depth <depth> <tokenized-url> <targetPath>`. Capture stdout/stderr; redact the raw token in both captured streams before passing to `ctx.emit` or logging. On non-zero exit, throw with the redacted error. (AC #3, AC #4)
- [x] Create `daemon/pipelines/__tests__/git-clone.test.mjs` — mock `child_process.spawn`; assert URL tokenization correctness, redaction filter against multiple raw-token formats, non-zero-exit error path. (AC #4, AC #12)

**Daemon — bootstrap (extended for brownfield)**

- [x] Modify `daemon/pipelines/party-bootstrap.mjs` — at entry, branch on `job.payload.kind`. Greenfield path unchanged (existing 8-step pipeline). Brownfield path executes ONLY: `clone-repo` (calls `git-clone.mjs`) → `verify` (assert `bmad/_cfg/agent-manifest.csv` exists with ≥ 1 data row using existing manifest-reader helper) → `compute-sha` (reuse `custom-agents-sha.mjs`; OK if `bmad/agents/` is empty — returns SHA of empty input) → `persist`. On verify failure: `bmadStatus='FAILED'`, `failureReason='BMAD_NOT_FOUND_IN_REPO'`, no retry. (AC #3, AC #5)
- [x] Extend `daemon/pipelines/__tests__/party-bootstrap.test.mjs` per AC #12 (clone-success, missing-BMAD, secret-redaction). (AC #12)

**Daemon — refresh pipeline**

- [x] Create `daemon/pipelines/party-refresh.mjs` exporting `runPartyRefresh(job, ctx)`. Steps: (a) acquire lock via `tryAcquireRefreshLock`; (b) `cd <projectPath> && git fetch origin && git reset --hard origin/<branch>` via `child_process.spawn`; (c) recompute `customAgentsSHA`; (d) re-run inspector verify; (e) read new HEAD SHA via `git rev-parse HEAD`; (f) `updateProjectAfterRefresh` + `releaseRefreshLock(projectId, 'HEALTHY')`. Emit `party.refresh.*` events on the existing spine. On any step error: `releaseRefreshLock(projectId, 'FAILED')`, emit `party.refresh.failed`. (AC #6, AC #7)
- [x] Create `daemon/pipelines/__tests__/party-refresh.test.mjs` per AC #12. (AC #12)

**Daemon — startup PAT load + job routing**

- [x] Modify `daemon/agent-daemon.mjs` — at startup, load the brownfield PAT once via `@aws-sdk/client-secrets-manager` `GetSecretValueCommand` for secret name `futurator/labs-brownfield-github-pat`. Store in module-scoped `const BROWNFIELD_GH_TOKEN`. Pass into `runPartyBootstrap` and `runPartyRefresh` via ctx. On startup failure to load (secret missing, IAM denied), log and continue — only brownfield jobs fail; greenfield jobs unaffected. (AC #4)
- [x] Modify `daemon/pipelines/job-router.mjs` — export `JOB_HANDLER_PARTY_REFRESH`; extend `selectHandler(jobType)` to dispatch `'party-refresh'`; add `validatePartyRefreshJob` mirroring `validatePartyBootstrapJob`. (AC #6)

**API routes**

- [x] Modify `functions/api/index.ts` — (a) update `POST /api/party/projects` to accept both greenfield and brownfield shapes via zod discriminated union (`z.discriminatedUnion('kind', [...])`); on brownfield, derive `projectId` from kebab-cased `name`, validate URL, enqueue `party-bootstrap` with `payload.kind='brownfield'`; (b) add `POST /api/party/projects/:id/refresh` — zod-validate `:id`; load project; return 400 `INVALID_FOR_GREENFIELD` if greenfield; check session-busy via repository helper, return 409 `PROJECT_BUSY` if any session PROCESSING; acquire refresh lock, return 409 `REFRESH_IN_PROGRESS` on conflict; enqueue `party-refresh` job; return `{ jobId }`. (AC #2, AC #6, AC #7)

**Infrastructure (SST)**

- [x] Modify `sst.config.ts` — declare a new Secrets Manager-backed `sst.Secret` named `BrownfieldGithubPat` (or extend existing pattern if `sst.Secret` is already used elsewhere). Grant the daemon EC2 IAM role and the API Lambda role `secretsmanager:GetSecretValue` on the secret ARN. Wire env var `BROWNFIELD_PAT_SECRET_NAME=futurator/labs-brownfield-github-pat` for the daemon. (AC #4)
- [x] Operational (one-time, NOT in PR): create the AWS Secrets Manager secret with a fine-grained PAT scoped to `contents:read` on `debatator`, `applicator`, `songster`, `futurator`. Document the creation step in `daemon/README.md`. (AC #4)

**Frontend — types, hooks, components**

- [x] Modify `src/types/party.ts` — re-export or re-declare the new fields from the backend types. (AC #1)
- [x] Modify `src/hooks/use-party-projects.ts` — add `useCreateBrownfieldProjectMutation()` calling `POST /api/party/projects` with the brownfield body; on success invalidate `['party', 'projects']`. Add `useRefreshProjectMutation()` calling `POST /api/party/projects/:id/refresh`; on success poll the resulting job events at 1500ms via the existing event-poll pattern and invalidate `['party', 'projects']` on terminal event. (AC #2, AC #6, AC #8)
- [x] Create `src/components/labs/party/add-brownfield-form.tsx` — modal with the three input fields per AC #8; uses `shadcn/ui` `Dialog`, `Input`, `Label`, `Button`; inline regex validation on `name` and `gitRepoUrl`; default `gitBranch='main'`; calls `useCreateBrownfieldProjectMutation` on submit. Named export. No default export. (AC #8)
- [x] Modify `src/components/labs/party/project-list.tsx` — distinguish brownfield vs greenfield card variants by `project.kind`. Brownfield variant renders `Git` Lucide icon, truncated `gitRepoUrl`, `gitBranch` chip, `lastPulledAt` relative time, the "Push first, then Refresh — EC2 mirrors GitHub" obligations hint per AC #11, and the "Refresh" secondary action calling `useRefreshProjectMutation`. (AC #8, AC #11)
- [x] Modify `src/components/labs/party/index.tsx` — add "Add Brownfield Project" button in the page header; mount `<AddBrownfieldForm />` modal with open-state in `party-store.ts`. (AC #8)
- [x] Modify `src/stores/party-store.ts` — add `isBrownfieldFormOpen: boolean` and `openBrownfieldForm()`, `closeBrownfieldForm()` actions. (AC #8)
- [x] Extend `tests/e2e/party.smoke.spec.ts` — add a viewport-768 test asserting the Add Brownfield modal renders correctly per AC #10. Add a brownfield-card-render test using a mocked project list response. (AC #10, AC #12)

**Documentation**

- [x] Modify `CLAUDE.md` — add a "Labs Party — Brownfield Usage" section: how to register a brownfield project, the obligations contract ("Push first, then Refresh — EC2 mirrors GitHub"), the four current target repos, and the deferred concerns (no Memgraph ingestion, no agents-can-push-to-GitHub). (AC #11)
- [x] Modify `daemon/README.md` — document the one-time AWS Secrets Manager secret creation step for the brownfield PAT (AC #4 operational note).

**Validation**

- [x] Run `npm run ci` end-to-end; verify zero warnings, all tests pass, build succeeds. (AC #13) — _All Story 15.4 tests + targeted lint + prettier + typecheck pass on touched files. Pre-existing failures (4 tests in `daemon/pipelines/__tests__/epic-dev-pipeline.test.mjs`, plus `Plan.kind`/`Plan.appId`/`TimerCategory` typecheck errors) persist — none reference party-module code, none caused by Story 15.4 changes._
- [ ] EC2 dev manual verification per AC #13 final paragraph (register all four repos, refresh each, start a session on each). — _Deferred to operator post-merge; requires the one-time Secrets Manager secret creation documented in `daemon/README.md`._

**Review Follow-ups (AI) — 2026-05-17:**

- [x] [AI-Review][Med] Add `'party.refresh.step.started'` to `PartyEventType` union and rewire `emitStepStarted` in `party-refresh.mjs` to emit it (currently uses `party.refresh.started` for every step start). (AC #6) [file: `functions/shared/types/party.ts:155-167`, `daemon/pipelines/party-refresh.mjs:54-60`] — _Fixed 2026-05-17. Pipeline-start `party.refresh.started` now emits exactly once at entry; each step emits `party.refresh.step.started`. Mirrored in `src/types/party.ts`. Test asserts both event-type cardinalities._
- [x] [AI-Review][Med] Add `'party.refresh.step.output'` to `PartyEventType` union and rewire `emitStepOutput` in `party-refresh.mjs` to emit it (currently uses `party.refresh.step.completed` for streamed stdout/stderr). (AC #6) [file: `functions/shared/types/party.ts:155-167`, `daemon/pipelines/party-refresh.mjs:68-75`] — _Fixed 2026-05-17. Streaming now emits `party.refresh.step.output`; test asserts `step.completed` events never carry a `stream` field._
- [x] [AI-Review][Med] Add API-layer integration test for `POST /api/party/projects/:id/refresh` covering 202 success + 400 `INVALID_FOR_GREENFIELD` + 409 `PROJECT_BUSY` + 409 `REFRESH_IN_PROGRESS`. (AC #12) [file: `functions/api/__tests__/party-refresh-route.test.ts` (NEW)] — _Created 2026-05-17. 8 tests covering: invalid projectId (400 zod), missing project (404), greenfield (400), brownfield with no gitBranch (400), legacy row missing kind (lazy-migrated greenfield → 400), session-busy (409), refresh-lock-held (409), happy path (202 with createJob assertions on jobType + payload shape)._
- [ ] [AI-Review][Low] Add `kind: 'greenfield'` to greenfield bootstrap step-event payloads for symmetry with brownfield events. [file: `daemon/pipelines/party-bootstrap.mjs:75-79`]
- [ ] [AI-Review][Low] Either split `BrownfieldProjectCard` into `src/components/labs/party/project-list.tsx` (matching original task path) or update the Tasks/Subtasks line to reference the actual location (`index.tsx`).
- [ ] [AI-Review][Low] Optional: switch `createPartyProjectInputSchema` from `z.union([brownfield, greenfield])` to `z.discriminatedUnion('kind', [...])` for faster parsing and clearer error messages. [file: `functions/shared/schemas/party-schema.ts:103-106`]
- [ ] [AI-Review][Low] Optional: add defense-in-depth URL regex validation inside `createBrownfieldProjectRow` to catch internal callers bypassing the API zod layer. [file: `functions/shared/repositories/party-projects-repository.ts:85-117`]

---

## Dev Notes

### Architecture patterns and constraints

- **Brownfield is an EXTENSION of `PartyProject`, not a new entity.** No new DDB tables. No new S3 buckets. No new event spine. The party module's existing observability and routing patterns apply unchanged. [Source: docs/epics-party-module.md Story 15.4]
- **Single source of truth = the operator's laptop's GitHub repo.** EC2 mirrors GitHub via clone/refresh; the daemon NEVER writes back. Incidental edits agents make during debates are wiped by `git reset --hard` on the next refresh. The obligations contract is enforced socially, not technically: "Push first, then Refresh." [Source: party-mode debate session 2026-05-16/17; CLAUDE.md per AC #11]
- **Permission posture unchanged from greenfield.** `claude -p --permission-mode acceptEdits`. Path-scoped Edit/Write restrictions are deferred — investigation confirmed they require `settings.json` + `PreToolUse` hooks rather than a single CLI flag, which fails the user's "must be simple" bar. [Source: memory `[[brownfield-party-permission-mode]]`]
- **BMAD ships WITH the cloned repo.** Each of the four target repos (`debatator`, `applicator`, `songster`, `futurator`) already has BMAD installed under its own `bmad/` tree with its own `bmad/_cfg/agent-manifest.csv`. The brownfield bootstrap branch SKIPS the `npx bmad-method install` step and the custom-agent sync from `bmad-agents-source`. If a brownfield project's debate needs a specific custom agent (e.g., `Ludwig`), the operator copies that agent file into the upstream repo's `bmad/agents/` and commits — there is no admin-side push. [Source: party-mode debate session 2026-05-16/17]
- **Artifacts land at `<projectPath>/docs/` per each repo's own `bmad/bmm/config.yaml:output_folder`.** Retrievable via the existing `GET /api/party/projects/:id/files` endpoint with no modifications. [Source: bmad/bmm/config.yaml:18; party-mode debate session]
- **Concurrency:** the refresh lock is implemented as a conditional `UpdateCommand` on the project row (transitioning `bmadStatus IN ('HEALTHY', 'DRIFTED') → 'REFRESHING'`); the session-busy check queries the existing sessions GSI1. This mirrors Story 15.1's `tryAcquireBootstrapLock` pattern.

### Source tree components to touch

Foundations exist from Stories 15.1–15.3 — extend, don't recreate:

- `functions/shared/types/party.ts` (entity union extension)
- `functions/shared/schemas/party-schema.ts` (zod discriminated union for create input)
- `functions/shared/repositories/party-projects-repository.ts` (refresh lock + lazy migration)
- `daemon/pipelines/party-bootstrap.mjs` (brownfield branch)
- `daemon/pipelines/lib/git-clone.mjs` (NEW helper)
- `daemon/pipelines/party-refresh.mjs` (NEW pipeline)
- `daemon/pipelines/job-router.mjs` (new handler + validator)
- `daemon/agent-daemon.mjs` (PAT load on startup + new dispatch)
- `functions/api/index.ts` (extend POST, add refresh route)
- `src/components/labs/party/*.tsx` (brownfield card variant + new form)
- `src/hooks/use-party-projects.ts` (two new mutations)
- `sst.config.ts` (Secrets Manager grant)

### Testing standards summary

- **Vitest** for all repository, schema, daemon-pipeline tests. Reuse existing `@aws-sdk/client-dynamodb` and `child_process` mock patterns from Story 15.1's tests. [Source: docs/stories/15-1-bmad-per-project-install-and-inspection.md AC #10]
- **Playwright** smoke test extension for the Add Brownfield modal + mobile-viewport assertion. Reuse the auth-pre-seeded session pattern from existing `tests/e2e/party.smoke.spec.ts`. [Source: docs/stories/15-3-labs-party-ui.md AC #11]
- **Secret redaction** must have a dedicated unit test in `git-clone.test.mjs` — the tokenized URL must never appear unredacted in captured stdout/stderr.
- **No integration tests against real GitHub** in CI. Manual EC2 verification is the integration step per AC #13.

### Learnings from Previous Story

**From Story 15-3 (Status: review)** — Story 15.3 (Labs Party UI) established the full frontend surface for the party module: `project-list.tsx`, `project-status-badge.tsx`, `session-chat.tsx`, hooks under `src/hooks/use-party-*.ts`, Zustand store at `src/stores/party-store.ts`, and the page at `src/app/labs/party/page.tsx`. Story 15.4 EXTENDS these — do NOT recreate. Specifically:

- **Reuse `project-status-badge.tsx`** as-is; the new `REFRESHING` status will use the same semantic-token mapping (`accent-blue animate-pulse`) as `INSTALLING`.
- **Reuse the event-polling pattern** from `use-party-bootstrap.ts` (1500ms while job PROCESSING, invalidate on terminal event) for the new `useRefreshProjectMutation`.
- **Reuse the modal/Dialog pattern** from any existing shadcn-based modal in the codebase rather than introducing a new dialog primitive.
- **The `Ec2Toggle`-gated visibility** (Story 15.3 AC #8) applies to the new Add Brownfield button as well: hide it when `mode !== 'ec2'`.

[Source: docs/stories/15-3-labs-party-ui.md#Tasks-Subtasks]

### Project Structure Notes

- New file paths align with the established kebab-case convention and module layout from Stories 15.1–15.3. No conflicts detected.
- The Secrets Manager secret name `futurator/labs-brownfield-github-pat` follows the existing `futurator/...` naming used elsewhere in the SST config (verify on first edit; minor renaming OK if existing convention differs).
- No changes to the existing Story 15.1 `tryAcquireBootstrapLock` — the new `tryAcquireRefreshLock` is a parallel function with a different status-transition condition.

### References

- [Source: docs/epics-party-module.md Story 15.4] — the canonical scope, ACs, prerequisites, and tech-notes for this story.
- [Source: docs/tech-spec-party-module.md §"Bootstrap Pipeline Steps"] — greenfield 8-step pipeline that the brownfield branch parallels.
- [Source: docs/tech-spec-party-module.md §"Inspector Steps"] — verify step semantics reused in the brownfield bootstrap and refresh pipelines.
- [Source: docs/tech-spec-party-module.md §"Concurrency & Locking"] — conditional-update lock pattern that the new refresh lock mirrors.
- [Source: docs/stories/15-1-bmad-per-project-install-and-inspection.md AC #5] — RFC-4180 CSV-escaping behavior on manifest read (re-encountered in brownfield `verify` step).
- [Source: docs/stories/15-2-party-session-orchestration-and-turn-loop.md AC #3] — `claude -p` invocation contract; brownfield sessions reuse this verbatim, no changes.
- [Source: bmad/bmm/config.yaml:18] — `output_folder: '{project-root}/docs'` — canonical BMAD artifact path that brownfield debates honor.
- [Source: memory/project_brownfield_party_candidates.md] — the four target repos and the rationale for this batch.
- [Source: memory/feedback_brownfield_party_permission_mode.md] — the `acceptEdits` posture decision and the deferral rationale for path-scoped restrictions.

---

## Dev Agent Record

### Context Reference

- [docs/stories/15-4-brownfield-party-project-bootstrap.context.xml](./15-4-brownfield-party-project-bootstrap.context.xml) — generated 2026-05-17 by `*story-context`

### Agent Model Used

<!-- To be filled when implementation begins -->

### Debug Log References

**2026-05-17 — Amelia (dev agent) — implementation plan:**

Working through the story in 10 sections per Tasks/Subtasks order. Approach:

1. **Types/schemas/repo** — extend `PartyProject` with `kind` discriminator + 4 git fields; lazy-migrate `kind='greenfield'` on read; add `tryAcquireRefreshLock`/`releaseRefreshLock`/`updateProjectAfterRefresh`; `BrownfieldProjectInputSchema` as zod literal + URL regex; `createPartyProjectInputSchema` becomes `discriminatedUnion('kind', […])`.
2. **git-clone helper** — tokenized-URL constructed in-memory; spawn `git clone --branch <b> --depth <d> <url> <target>`; redact raw token AND tokenized form in captured stdout/stderr; throw redacted error on non-zero exit.
3. **Bootstrap extension** — branch on `payload.kind` at entry; brownfield runs only 4 steps (clone → verify → compute-sha → persist); greenfield path unchanged.
4. **Refresh pipeline** — `runPartyRefresh`: acquire lock → fetch+reset → SHA → verify → read HEAD → persist → release. On error: release as FAILED, emit `party.refresh.failed`.
5. **Daemon startup PAT + routing** — `GetSecretValueCommand` once at startup, module-scoped; `validatePartyRefreshJob` + dispatch in `selectHandler`.
6. **API** — discriminatedUnion on POST /party/projects; new POST /:id/refresh with greenfield gate, session-busy 409, refresh-lock 409.
7. **SST** — `sst.Secret('BrownfieldGithubPat')` mirroring `GithubPat`; IAM grant via existing link; env var wired.
8. **Frontend** — `useCreateBrownfieldProjectMutation` + `useRefreshProjectMutation` (1500ms event-poll for refresh); `AddBrownfieldForm` modal; brownfield card variant; party-store form-open slice; gated by Ec2Toggle.
9. **Docs** — CLAUDE.md "Labs Party — Brownfield Usage" + daemon/README.md operational note.
10. **Validation** — `npm run ci`.

Key constraints from context.xml: PAT never logged/persisted/event-payloaded; refresh lock mirrors `tryAcquireBootstrapLock` pattern; no path-scoped permission restrictions (per memory `feedback_brownfield_party_permission_mode`); BMAD ships with the cloned repo so `npx bmad-method install` + custom-agent sync are SKIPPED; artifacts land at `<projectPath>/docs/` per each repo's own `bmad/bmm/config.yaml`.

### Completion Notes List

**2026-05-17 — Amelia (dev agent) — implementation complete, marking for review.**

**What landed (all 13 ACs):**

- **AC #1** — `PartyProject` extended with `kind: 'greenfield' | 'brownfield'` + 4 optional git fields (`gitRepoUrl`, `gitBranch`, `lastPulledAt`, `lastCommitSha`). Lazy `kind='greenfield'` migration on read in `party-projects-repository.applyLazyKind()` — no DDB write. Schema mirror updated with new fields + `'REFRESHING'` added to `bmadStatusSchema`.
- **AC #2** — `POST /api/party/projects` now accepts a zod **discriminated union** on `kind` (greenfield legacy shape kept for back-compat). Brownfield branch derives `projectId` from kebab-cased `name`, validates HTTPS GitHub URL via regex, and enqueues a `party-bootstrap` job with `payload.kind='brownfield'`. New repo helper `createBrownfieldProjectRow(...)` conditionally PUTs the row.
- **AC #3** — `runPartyBootstrap` branches on `payload.kind` at entry. Brownfield path runs ONLY 4 steps: `clone-repo` → `verify` → `compute-sha` → `persist`. `runGitRefresh`, `installBmad`, `syncCustomAgents`, `rebuildManifest`, `injectCustomAgents` are all skipped. Greenfield path unchanged (existing 9-step pipeline).
- **AC #4** — New `daemon/pipelines/lib/git-clone.mjs` builds the tokenized URL in-memory and redacts both the raw token and the `https://x-access-token:<token>@...` URL form before emit/log. PAT loaded once at daemon startup via `SecretsManagerClient.GetSecretValueCommand` for `futurator/labs-brownfield-github-pat`; stored in module-scoped `brownfieldGithubToken`, passed into pipeline ctx; never written to DDB, never logged, never in event payloads. Redaction test verifies fake tokens don't leak in stdout/stderr/error messages.
- **AC #5** — On verify failure (missing or empty `bmad/_cfg/agent-manifest.csv`), brownfield bootstrap sets `bmadStatus='FAILED'`, `failureReason='BMAD_NOT_FOUND_IN_REPO'`, and emits `party.bootstrap.failed` with the failureReason in the payload. No auto-retry. A custom `BmadNotFoundError` class scopes the failure reason cleanly.
- **AC #6** — New endpoint `POST /api/party/projects/:id/refresh`. Auth-gated. Greenfield projects → 400 `INVALID_FOR_GREENFIELD`. Brownfield projects enqueue a `party-refresh` job; daemon's `runPartyRefresh` runs 6 steps (acquire-lock → git-fetch-reset → compute-sha → verify → read-head-sha → persist+release-lock) and emits `party.refresh.*` events.
- **AC #7** — Refresh lock is a conditional `UpdateCommand` transitioning `bmadStatus IN (HEALTHY, DRIFTED) → REFRESHING`. New repo helpers `tryAcquireRefreshLock`/`releaseRefreshLock`/`updateProjectAfterRefresh`. Session-busy check via new `partySessionsRepo.hasProcessingSession(projectId)` (GSI1 query with `FilterExpression: #status = :processing`, `Limit: 1`). API returns 409 `PROJECT_BUSY` or 409 `REFRESH_IN_PROGRESS` as appropriate.
- **AC #8** — New "Add brownfield project" button in `PartyProjectChooser` (Labs Party header). New `AddBrownfieldForm.tsx` (shadcn Dialog) with 3 fields (name/gitRepoUrl/gitBranch), inline regex validation, calls `useCreateBrownfieldProjectMutation`. New `BrownfieldProjectCard` variant in `src/components/labs/party/index.tsx` — note: the story called for splitting card variants into `project-list.tsx`, but that file doesn't exist (the chooser is in `index.tsx`), so the variant is colocated there. Brownfield cards render Git icon, middle-truncated URL, branch chip, relative `lastPulledAt`, the obligations hint, and the Refresh action. HEALTHY-view header swaps Re-inspect → Refresh for brownfield. `useRefreshProjectMutation` invalidates `['party', 'projects']` on success.
- **AC #9** — No changes required. Brownfield sessions reuse the existing `/bmad-party-mode` slash command and `claude -p --permission-mode acceptEdits` posture verbatim. Per memory `feedback_brownfield_party_permission_mode`, NO path-scoped Edit/Write restrictions added.
- **AC #10** — Mobile parity: the `Dialog` primitive (`@base-ui/react`) auto-handles ≤768px viewport sizing; form fields are full-width. Playwright smoke test extended with `page.setViewportSize({ width: 768, height: 1024 })` assertion that all 3 input fields render visible.
- **AC #11** — Obligations hint "Push first, then Refresh — EC2 mirrors GitHub" rendered on every brownfield card near `lastPulledAt`. Documented in CLAUDE.md under a new "Labs Party — Brownfield Usage" section.
- **AC #12** — Test coverage:
  - `functions/shared/repositories/__tests__/party-projects-repository.test.ts` — 26 tests (up from 14): brownfield row create, lazy `kind` migration on get + list, refresh-lock success/conflict/not-found/invalid-state, releaseRefreshLock for both HEALTHY/FAILED, updateProjectAfterRefresh.
  - `functions/shared/schemas/__tests__/party-schema.test.ts` — 41 tests (up from 24): brownfield input positive (with/without .git, default branch, custom branch), negative (SSH, non-github, bad name, whitespace branch, missing kind), discriminated union accepts both shapes, refresh params validation.
  - `daemon/pipelines/__tests__/git-clone.test.mjs` (NEW) — 14 tests: URL tokenization, redaction filter (multiple raw-token formats, bare occurrences, multiple URLs), spawn invocation correctness, exit-code-nonzero path, spawn-error path, ctx.emit-throws tolerance, required-arg validation.
  - `daemon/pipelines/__tests__/party-bootstrap.test.mjs` — 12 tests (up from 8): brownfield 4-step happy path, kind=brownfield in completion event, PAT-never-in-event-payload assertion, missing-BMAD failure, empty-manifest failure, missing-token startup-failure assertion.
  - `daemon/pipelines/__tests__/party-refresh.test.mjs` (NEW) — 8 tests: 6-step happy path, completed event with new SHA, step list ordering, lock-not-acquired path, fetch-error releases lock to FAILED, manifest-missing releases lock to FAILED, projectPath-missing pre-lock-check, party.refresh.failed event step attribution.
  - `daemon/pipelines/__tests__/job-router.test.mjs` — 19 tests (up from 14): selectHandler dispatch for `party-refresh`, validatePartyRefreshJob structural checks.
  - **Total: 120 party-related tests, all passing.**
- **AC #13** — Targeted CI gates pass on touched files: `eslint --max-warnings 0` clean, `prettier --check` clean, `tsc --noEmit` clean for all party-module files. Full `npm run ci` is NOT 100% clean because of pre-existing failures unrelated to Story 15.4 (see "Known pre-existing issues" below). EC2 manual verification deferred to operator post-merge.

**Known pre-existing issues (NOT caused by Story 15.4):**

- 4 failures in `daemon/pipelines/__tests__/epic-dev-pipeline.test.mjs` — `capturedPrompt` not populated. The test does NOT use `vi.mock` and does NOT touch any party-module file; the failure reproduces in isolation. Likely a pre-existing regression in the epic-dev pipeline's stdin handling. Out of scope for this story.
- Typecheck errors on `Plan.kind`, `Plan.appId`, `Plan.iterationLabel`, `PlanRigor`, `BoilerplateType`, `TimerCategory.{tamper-check,baseline-check}`, `salvageable/skipTolerant/maxConsecutiveRetries`, `concurrencyClass`/`costCeilingUsd`, etc. — all in non-party files (`functions/api/index.ts:1517+`, `functions/api/__tests__/timing-routes.test.ts`, `functions/shared/repositories/__tests__/plan-repository.test.ts`, etc.). Pre-existing and unrelated.

**Implementation notes:**

- Re-running brownfield bootstrap (manual reinstall) `rmSync -r` wipes the project folder before re-cloning. The bootstrap lock guarantees no concurrent operations on the same project. Refresh uses `git fetch + reset --hard` instead — never wipes the folder.
- The `mock node:child_process` test pattern needed `vi.hoisted` + `importOriginal` + `default: { ...actual, spawn: spawnMock }` to satisfy the Node loader's expectations. Same shape used in git-clone.test, party-bootstrap.test (brownfield branch), party-refresh.test.
- The "section 7" sst.config change adds `sst.Secret('BrownfieldGithubPat')` and links it to the API Lambda for forward-flexibility, but the EC2 daemon role is managed outside SST and needs the IAM policy attached manually per `daemon/README.md`.
- `sst-env.d.ts` will need to be regenerated by `sst dev`/`sst deploy` to expose the new `BrownfieldGithubPat` secret to the Lambda environment.

### File List

**Modified:**

- `functions/shared/types/party.ts` — `kind` discriminator + 4 git fields on `PartyProject`; `'REFRESHING'` added to `BmadStatus`; `'party-refresh'` added to `PartyJobType`; `'brownfield'`/git fields added to `PartyBootstrapJobPayload`; new `PartyRefreshJobPayload`; 4 new `party.refresh.*` `PartyEventType` members; `GITHUB_HTTPS_URL_REGEX`; `FAIL_REASON_BMAD_NOT_FOUND`.
- `functions/shared/schemas/party-schema.ts` — `'REFRESHING'` in `bmadStatusSchema`; new `partyProjectKindSchema`; new `kind` + git fields in `partyProjectSchema`; new `greenfieldProjectInputSchema`, `brownfieldProjectInputSchema`, `refreshProjectParamsSchema`; `createPartyProjectInputSchema` rewritten as `z.union([brownfield, greenfield])` (effective discriminated union via `kind` literal).
- `functions/shared/repositories/party-projects-repository.ts` — `applyLazyKind()` helper + lazy migration in `getProject`/`listProjects`; `createBrownfieldProjectRow()`; `RefreshLockResult` type; `tryAcquireRefreshLock()`/`releaseRefreshLock()`/`updateProjectAfterRefresh()`.
- `functions/shared/repositories/party-sessions-repository.ts` — `hasProcessingSession()` helper using GSI1 query + `FilterExpression`.
- `functions/shared/repositories/__tests__/party-projects-repository.test.ts` — +12 tests for new behavior.
- `functions/shared/schemas/__tests__/party-schema.test.ts` — +17 tests for new schemas.
- `functions/shared/types/agent-orchestrator.ts` — `'party-refresh'` added to `jobType` union; `kind`/`gitRepoUrl`/`gitBranch` added to `partyBootstrapPayload`; new `partyRefreshPayload`.
- `functions/api/index.ts` — `POST /api/party/projects` extended to discriminated union; new `POST /api/party/projects/:id/refresh`.
- `daemon/agent-daemon.mjs` — `SecretsManagerClient` import; `BROWNFIELD_PAT_SECRET_NAME` const + `brownfieldGithubToken` module var + `loadBrownfieldPat()` function called from startup `IIFE`; `partyTryAcquireRefreshLock`/`partyReleaseRefreshLock`/`partyUpdateProjectAfterRefresh` daemon-side helpers; `buildPartyCtx` includes the new wirings; `executePartyRefreshJob()`; dispatch case for `JOB_HANDLER_PARTY_REFRESH`.
- `daemon/pipelines/party-bootstrap.mjs` — entry-point branch on `payload.kind`; new `runBrownfieldBootstrap()` (4-step), `BmadNotFoundError`, `readGitHeadSha()` (exported, also used by `party-refresh.mjs`); `BROWNFIELD_STEPS` const; `cloneRepo` import.
- `daemon/pipelines/job-router.mjs` — `JOB_HANDLER_PARTY_REFRESH` const; `selectHandler` dispatch; `validatePartyRefreshJob()`.
- `daemon/pipelines/__tests__/party-bootstrap.test.mjs` — +4 tests for brownfield (happy path, completed-event, secret-redaction, missing-BMAD, missing-token, empty-manifest).
- `daemon/pipelines/__tests__/job-router.test.mjs` — +6 tests for refresh handler + validator.
- `src/types/party.ts` — mirrored backend types (`PartyProjectKind`, `'REFRESHING'`, git fields, `'party.refresh.*'` event types, `CreateBrownfieldProjectInput`, `PartyRefreshResponse`).
- `src/stores/party-store.ts` — `isBrownfieldFormOpen` slice + `openBrownfieldForm`/`closeBrownfieldForm` actions.
- `src/hooks/use-party-projects.ts` — `useCreateBrownfieldProjectMutation()` + `useRefreshProjectMutation()`.
- `src/components/labs/party/index.tsx` — `AddBrownfieldForm` mount; "Add brownfield project" button in `PartyProjectChooser`; brownfield card variant (`BrownfieldProjectCard`); HEALTHY-view header swaps Re-inspect → Refresh for brownfield.
- `src/components/labs/party/project-status-badge.tsx` — `'REFRESHING'` entry (blue-pulse, matches `INSTALLING`).
- `src/components/labs/project-picker.tsx` — `'REFRESHING'` entry in `BMAD_BADGE` (required by exhaustiveness check after extending `BmadStatus`).
- `tests/e2e/party.smoke.spec.ts` — brownfield card render test + viewport-768 modal-render test (mocked API).
- `sst.config.ts` — `sst.Secret('BrownfieldGithubPat')` declaration + link to API Lambda.
- `CLAUDE.md` — new "Labs Party — Brownfield Usage" section + "Recent changes" entry.
- `daemon/README.md` — new "Brownfield Party PAT (Story 15.4)" section.
- `docs/sprint-status.yaml` — `15-4-brownfield-party-project-bootstrap: in-progress → review` (after merge of this change).
- `docs/stories/15-4-brownfield-party-project-bootstrap.md` — this file: all tasks checked, Dev Agent Record populated.

**New:**

- `daemon/pipelines/lib/git-clone.mjs` — `redactToken`, `buildTokenizedUrl`, `cloneRepo`.
- `daemon/pipelines/party-refresh.mjs` — `runPartyRefresh`, `PARTY_REFRESH_STEPS`.
- `daemon/pipelines/__tests__/git-clone.test.mjs` — 14 tests.
- `daemon/pipelines/__tests__/party-refresh.test.mjs` — 10 tests (8 original + 2 added in review-fix pass asserting event-taxonomy correctness).
- `functions/api/__tests__/party-refresh-route.test.ts` — 8 tests (added in review-fix pass per M3) covering the four refresh endpoint outcome paths.
- `src/components/labs/party/add-brownfield-form.tsx` — `AddBrownfieldForm` (3-field modal with inline validation).
- `docs/stories/15-4-brownfield-party-project-bootstrap.context.xml` — Story Context XML (generated 2026-05-17 by `*story-context`).

---

## Senior Developer Review (AI)

**Reviewer:** Richie
**Date:** 2026-05-17
**Outcome:** **Changes Requested**

> ⚠️ **Conflict of interest disclosure:** This review was performed in the same session and by the same agent (`Amelia`) that implemented the story. The workflow expects a clean-context independent reviewer. Findings here should be re-verified by a fresh-context reviewer before merge. The findings below are deliberately critical — the in-context bias would naturally lean approve, so the reviewer leaned the other way and dug for real issues.

### Summary

The implementation is broadly correct and well-structured: the brownfield branch in `party-bootstrap.mjs` is cleanly isolated, secret handling is rigorous (in-memory tokenized URL + dual redaction in `git-clone.mjs`), and the concurrency model (`tryAcquireBootstrapLock` + `tryAcquireRefreshLock` + `hasProcessingSession`) mirrors prior art in Story 15.1. 120 unit/integration tests pass and the touched files clear lint/prettier/typecheck cleanly.

However, **two real bugs in `party-refresh.mjs` event emission** prevent approval: every step's `started` event is emitted as the same overall-pipeline event type, and stdout/stderr streaming during `git-fetch-reset` is emitted as `step.completed` rather than as a distinct `step.output` event. Together these break the event stream's ability to distinguish step lifecycle phases — the UI poll won't be able to render per-step progress correctly. Adding the missing event types to `PartyEventType` and rewiring the two helpers is a ~20-line fix.

One **MEDIUM test-coverage gap** also stands: the AC #12 requirement to exercise the API-layer 400 `INVALID_FOR_GREENFIELD` response has no automated test.

A few **LOW** findings worth flagging but not blocking: inconsistent `kind` field on greenfield vs brownfield bootstrap event payloads, lack of defense-in-depth URL validation in `createBrownfieldProjectRow`, and a small TOCTOU window between session-busy check and refresh-lock acquisition (benign consequence).

### Key Findings

#### HIGH severity

_(None.)_

#### MEDIUM severity

- **[M1] `party-refresh.mjs` emits `party.refresh.started` for every step start.**
  `emitStepStarted` at `daemon/pipelines/party-refresh.mjs:54-60` uses `'party.refresh.started'` as the eventType. It is called once per step (6 times). The bootstrap pipeline uses `party.bootstrap.step.started` for analogous calls (`party-bootstrap.mjs:75-79`). The `PartyEventType` union (`functions/shared/types/party.ts:155-158`) does NOT contain `'party.refresh.step.started'` — it should be added. Consumers cannot distinguish overall-pipeline start from individual step starts.

- **[M2] `party-refresh.mjs` emits stdout/stderr as `party.refresh.step.completed`.**
  `emitStepOutput` at `daemon/pipelines/party-refresh.mjs:68-75` uses `'party.refresh.step.completed'` for streaming stdout/stderr from `git-fetch-reset`. The bootstrap pipeline uses `party.bootstrap.step.output` for the same purpose (`party-bootstrap.mjs:74-80`). The union is missing `'party.refresh.step.output'`. Streaming output and step-completion semantics are conflated — a consumer counting `step.completed` events would over-count, and a consumer looking for `step.output` would find nothing.

- **[M3] No automated test for 400 `INVALID_FOR_GREENFIELD` response.**
  AC #12 explicitly calls for "brownfield-only gate (400 `INVALID_FOR_GREENFIELD` exercised at the API layer)". The code path exists at `functions/api/index.ts:4973-4978` but no test fires it. The existing daemon-pipeline test in `party-refresh.test.mjs` only covers the lock-acquisition path, not the API-layer rejection of greenfield projects.

#### LOW severity

- **[L1] Greenfield bootstrap step-events don't include `kind`.**
  Brownfield event payloads carry `kind: 'brownfield'` (`party-bootstrap.mjs:391-396`); greenfield events don't (`party-bootstrap.mjs:75-79`). Lazy migration handles the project-row side but consumers filtering events by `kind` will need to treat missing-`kind` as greenfield. Consider adding `kind: 'greenfield'` to the existing greenfield emit functions for symmetry — non-breaking, just consistent.

- **[L2] `createBrownfieldProjectRow` has no defense-in-depth URL regex check.**
  `functions/shared/repositories/party-projects-repository.ts:85-117` accepts `gitRepoUrl` as a plain string. The API zod schema validates the regex upstream, so any caller via the public API is safe, but a future internal caller (script, test helper) could bypass it. Optional: re-validate via `GITHUB_HTTPS_URL_REGEX` inside the repo function.

- **[L3] TOCTOU between session-busy check and refresh-lock acquisition.**
  `functions/api/index.ts:4988-4997`: `hasProcessingSession(...)` followed by `tryAcquireRefreshLock(...)`. A new session-turn could enter PROCESSING in the window between. Consequence is benign — the operator gets a refresh that briefly overlaps with a turn — but if strict mutual exclusion is desired, the refresh-lock acquisition could conditionally fail when any session is PROCESSING (would require an indexed scan, more expensive). Acceptable for MVP; revisit if the operator reports interleaving artifacts.

- **[L4] Brownfield re-bootstrap `rmSync` is destructive.**
  `party-bootstrap.mjs:413-414` wipes the project folder before re-cloning. By design (story note explicitly accepts this), and the bootstrap-lock prevents concurrent operations. But any local-only edits the agent made during a debate are gone. Documented in the obligations contract; flagging only for awareness.

- **[L5] Tasks/Subtasks line for `src/components/labs/party/project-list.tsx` is marked [x] but the file doesn't exist.**
  The functionality (BrownfieldProjectCard variant) was delivered inline in `src/components/labs/party/index.tsx:482-540`. This was disclosed in Completion Notes (AC #8 paragraph) but the task checkbox should ideally be reworded for traceability — or the helper should be split into its own file matching the originally-planned path.

### Acceptance Criteria Coverage

| AC#                                                                                                                                          | Status                               | Evidence                                                                                                                                                                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC1 — `PartyProject` extended with `kind` + 4 git fields; lazy `kind='greenfield'` migration                                                 | ✅ IMPLEMENTED                       | `functions/shared/types/party.ts:19,24,41-47`; `party-projects-repository.ts:17-23` (`applyLazyKind`); test `party-projects-repository.test.ts:55-72`                                                                                                                                                     |
| AC2 — `POST /party/projects` discriminated union; brownfield row + bootstrap job with `payload.kind='brownfield'`; greenfield path unchanged | ✅ IMPLEMENTED                       | `party-schema.ts:87-108`; `functions/api/index.ts:4879-4951`                                                                                                                                                                                                                                              |
| AC3 — Brownfield runs only clone-repo → verify → compute-sha → persist; install/sync-agents SKIPPED                                          | ✅ IMPLEMENTED                       | `party-bootstrap.mjs:41` (BROWNFIELD_STEPS); `party-bootstrap.mjs:364-488` (runBrownfieldBootstrap); test `party-bootstrap.test.mjs:230+`                                                                                                                                                                 |
| AC4 — PAT loaded once at startup from Secrets Manager; redacted in stdout/stderr/events                                                      | ✅ IMPLEMENTED                       | `agent-daemon.mjs:2715-2748,3968-3970`; `git-clone.mjs:24-34,82-98`; test `git-clone.test.mjs:30-46,103-130`                                                                                                                                                                                              |
| AC5 — Missing manifest → FAILED + `failureReason='BMAD_NOT_FOUND_IN_REPO'`; no auto-retry                                                    | ✅ IMPLEMENTED                       | `party-bootstrap.mjs:437-446,490-509`; test `party-bootstrap.test.mjs:303-320`                                                                                                                                                                                                                            |
| AC6 — `POST /:id/refresh` with greenfield 400, brownfield enqueues `party-refresh`                                                           | ✅ IMPLEMENTED                       | `functions/api/index.ts:4964-5026`; `party-refresh.mjs:30-154`                                                                                                                                                                                                                                            |
| AC7 — 409 `REFRESH_IN_PROGRESS` + 409 `PROJECT_BUSY` via conditional update + GSI1 query                                                     | ✅ IMPLEMENTED                       | `party-projects-repository.ts:222-251`; `party-sessions-repository.ts:42-56`; `functions/api/index.ts:4988-5005`                                                                                                                                                                                          |
| AC8 — "Add Brownfield Project" button + modal + card variant + REFRESHING badge                                                              | ✅ IMPLEMENTED                       | `index.tsx:373-381` (button), `add-brownfield-form.tsx` (modal), `index.tsx:482-540` (BrownfieldProjectCard), `project-status-badge.tsx:24-27` (REFRESHING)                                                                                                                                               |
| AC9 — First turn uses `/bmad-party-mode` unchanged; `acceptEdits` posture; artifacts in `<projectPath>/docs/`                                | ✅ IMPLEMENTED (no changes required) | `party-turn.mjs` (zero `kind`/`brownfield` references); existing `GET /:id/files` route at `functions/api/index.ts:5518` works for both kinds                                                                                                                                                             |
| AC10 — Mobile UX ≤768px parity; Playwright viewport-768 assertion                                                                            | ✅ IMPLEMENTED                       | Responsive classes in `index.tsx:391,510,526`; `add-brownfield-form.tsx:75`; `tests/e2e/party.smoke.spec.ts` (viewport-768 modal test)                                                                                                                                                                    |
| AC11 — Obligations hint on each brownfield card; documented in CLAUDE.md                                                                     | ✅ IMPLEMENTED                       | `index.tsx:518-521`; `CLAUDE.md:96`                                                                                                                                                                                                                                                                       |
| AC12 — All test files pass (repo, schema, bootstrap, refresh, git-clone)                                                                     | ⚠️ PARTIAL                           | 120 tests pass across 6 files; **MISSING**: API-layer test for 400 `INVALID_FOR_GREENFIELD` (story explicitly required this — see [M3])                                                                                                                                                                   |
| AC13 — `npm run ci` passes end-to-end; manual EC2 verification                                                                               | ⚠️ PARTIAL                           | Targeted lint/format/typecheck/test on touched files pass; full `npm run ci` does NOT pass — 4 pre-existing failures in `epic-dev-pipeline.test.mjs` + Plan/TimerCategory typecheck errors (all unrelated to Story 15.4). Strict AC reading: not satisfied. Manual EC2 verification deferred to operator. |

**Summary: 11 of 13 ACs fully implemented; 2 partial (AC #12 missing API test; AC #13 has pre-existing-CI caveat).**

### Task Completion Validation

All 27 task checkboxes marked `[x]` were verified against the codebase. Caveats:

- **Task "Modify `src/components/labs/party/project-list.tsx`"** — marked `[x]` but no such file exists. Functionality delivered inline at `src/components/labs/party/index.tsx:482-540` (BrownfieldProjectCard). Disclosed in Completion Notes. **Verified delivered, just at a different path.** [L5]
- **Task "Run `npm run ci` end-to-end"** — marked `[x]` with explicit caveat. Targeted gates pass on touched files; full project CI has pre-existing failures. **Verified for touched files only.** [AC13 PARTIAL]
- **Task "EC2 dev manual verification"** — correctly marked `[ ]` (deferred to operator).

All other 25 tasks: **VERIFIED COMPLETE** with file:line evidence in the AC table above and the story's File List.

### Test Coverage and Gaps

**Coverage strengths:**

- 120 party-related tests pass across 6 files.
- Secret redaction has dedicated test coverage with multiple raw-token formats (`git-clone.test.mjs:30-46`).
- Refresh pipeline failure paths (lock conflict, fetch error, manifest missing, projectPath missing) all covered (`party-refresh.test.mjs:151+`).
- Discriminated-union zod validation has positive + negative cases (`party-schema.test.ts`).

**Gaps:**

- **[M3]** No API-layer test for 400 `INVALID_FOR_GREENFIELD`, 409 `PROJECT_BUSY`, 409 `REFRESH_IN_PROGRESS`, or the success path of `POST /:id/refresh`. The functions/api layer has no `__tests__/party-*` test file. An integration test exercising the Hono app via `app.request(...)` would close this.
- **No assertion that event types match the `PartyEventType` union.** A unit test that calls `runPartyRefresh` and asserts every emitted eventType is in the union would have caught [M1] and [M2] immediately. Consider adding a generic "event-types-are-typed" lint/test.

### Architectural Alignment

- ✅ DynamoDB multi-table preference honored — extends existing `futurator-party-projects` table, no new tables.
- ✅ Permission posture per `[[brownfield-party-permission-mode]]` memory: `acceptEdits` unchanged, no path-scoped restrictions.
- ✅ Single source of truth = laptop GitHub repo; daemon never pushes back (no `git push` call anywhere in `party-refresh.mjs` or `party-bootstrap.mjs`).
- ✅ Repository pattern preserved — new `tryAcquireRefreshLock`/`releaseRefreshLock`/`updateProjectAfterRefresh` mirror the existing `tryAcquireBootstrapLock` shape.
- ✅ Hono single-app pattern preserved — new route lives in the same `functions/api/index.ts` file.
- ✅ Validation uses `.safeParse()` only at API boundaries — confirmed in all new routes.
- ⚠️ Event-spine consistency violated by [M1]/[M2] — bootstrap and refresh pipelines should emit events with the same lifecycle taxonomy.

### Security Notes

- ✅ **PAT handling is rigorous.** The token lives only in Secrets Manager and in the daemon's module-scoped `brownfieldGithubToken`. The tokenized URL is built in-memory inside `cloneRepo` and is never serialized to DDB rows, events, or any log line that flows through `redactToken`.
- ✅ **Dual redaction** — both the `https://x-access-token:<token>@` URL pattern AND any bare occurrence of the raw token are masked (`git-clone.mjs:24-34`).
- ✅ **Test coverage for redaction** verifies the raw token never leaks in stdout/stderr/error messages (`git-clone.test.mjs:65-94` and `party-bootstrap.test.mjs:286-310`).
- ✅ **No `git push` paths anywhere.** Verified by grep — no `'push'` argument is ever passed to `spawn('git', ...)` in this story's surface.
- ⚠️ **PAT scope (operational, not code):** the secret in AWS Secrets Manager should be a fine-grained PAT scoped `contents:read` on exactly the four target repos. This is documented in `daemon/README.md:50+` but cannot be verified from code review alone — operator must confirm the actual PAT scope at provisioning time.
- ⚠️ **No rate limiting on `POST /:id/refresh`** — denial-of-service via spam is bounded only by the refresh-lock (409s after the first). Acceptable for single-tenant admin tool; flag for review if multi-tenancy is added later.

### Best-Practices and References

- **Vitest `vi.hoisted` + `importOriginal` for mocking `node:child_process`** — the implementation correctly uses this pattern (e.g., `git-clone.test.mjs:11-15`). Required because Node's built-in modules have many named exports the loader expects to preserve. Reference: https://vitest.dev/api/vi.html#vi-mock
- **DynamoDB conditional updates for distributed locks** — the `attribute_exists(projectId) AND bmadStatus IN (...)` pattern is idiomatic and matches the existing `tryAcquireBootstrapLock` pattern. Reference: `functions/shared/repositories/party-projects-repository.ts:127-156`
- **Zod `discriminatedUnion` vs `union`** — the implementation uses `z.union([brownfield, greenfield])` rather than `z.discriminatedUnion('kind', [...])`. Both work but `discriminatedUnion` gives better error messages and faster parsing. **Minor optimization opportunity** — not a blocker.
- **GitHub fine-grained PATs with `x-access-token`** — `https://x-access-token:<PAT>@github.com/...` is the official format. Reference: https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens

### Action Items

**Code Changes Required:**

- [x] [Med] Add `'party.refresh.step.started'` to `PartyEventType` union and update `emitStepStarted` in `party-refresh.mjs` to emit it (instead of `party.refresh.started` per step). Reserve `'party.refresh.started'` for one emission at pipeline start. (AC #6) [file: `functions/shared/types/party.ts:155-167`, `daemon/pipelines/party-refresh.mjs:54-60`] — **Resolved 2026-05-17**
- [x] [Med] Add `'party.refresh.step.output'` to `PartyEventType` union and update `emitStepOutput` in `party-refresh.mjs` to emit it (instead of `party.refresh.step.completed`). (AC #6) [file: `functions/shared/types/party.ts:155-167`, `daemon/pipelines/party-refresh.mjs:68-75`] — **Resolved 2026-05-17**
- [x] [Med] Add API-layer integration test exercising the 4 outcome paths of `POST /api/party/projects/:id/refresh`: success (202), greenfield (400 `INVALID_FOR_GREENFIELD`), session-busy (409 `PROJECT_BUSY`), refresh-in-progress (409 `REFRESH_IN_PROGRESS`). Mirror the pattern used by `functions/api/__tests__/app-create-route.test.ts`. (AC #12) [file: `functions/api/__tests__/party-refresh-route.test.ts` (NEW)] — **Resolved 2026-05-17**

**Advisory Notes:**

- Note: Consider adding `kind: 'greenfield'` to greenfield bootstrap step-event payloads (`party-bootstrap.mjs:75-79`) for symmetry with the brownfield emit functions. Non-breaking, just consistent. [L1]
- Note: Either split `BrownfieldProjectCard` into a dedicated `src/components/labs/party/project-list.tsx` matching the original task path, or reword the corresponding task checkbox to reference `index.tsx`. [L5]
- Note: Consider switching `createPartyProjectInputSchema` from `z.union([...])` to `z.discriminatedUnion('kind', [...])` for faster parsing and clearer error messages. (Optimization, not a bug.)
- Note: Consider adding defense-in-depth URL regex validation inside `createBrownfieldProjectRow` to catch any future internal callers that bypass the API zod layer. [L2]
- Note: Pre-existing failures in `daemon/pipelines/__tests__/epic-dev-pipeline.test.mjs` (4 tests) and Plan/TimerCategory typecheck errors are out of scope for Story 15.4 but should be tracked separately so AC #13 strict reading can be satisfied on future stories.
- Note: A fresh-context independent reviewer should re-validate the findings above before merge. The same-session conflict of interest disclosure at the top of this review applies.

### Change Log

| Date       | Change                                                                                                                                        | Author          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| 2026-05-17 | Story drafted (Path B — added to Epic 15 directly)                                                                                            | Bob (SM)        |
| 2026-05-17 | Story Context XML generated (`*story-context`)                                                                                                | Bob (SM)        |
| 2026-05-17 | Implementation completed; 120 tests pass; status → review                                                                                     | Amelia (dev)    |
| 2026-05-17 | Senior Developer Review notes appended; outcome Changes Requested                                                                             | Amelia (review) |
| 2026-05-17 | Med review items resolved: party-refresh event taxonomy (2 fixes) + API-layer integration test (8 new tests); 130 tests pass; status → review | Amelia (dev)    |
