# GitHub Integration — Design Doc

**Status:** Draft (MVP proposal)
**Author:** Ricardo + Claude
**Date:** 2026-04-25
**Scope:** Add per-Plan GitHub repository creation and lifecycle management to the Labs pipeline. CI/CD considerations sketched but not in MVP.

---

## 1. Current Pipeline (no GitHub)

This section documents the pipeline **as it exists today**, so the integration can be reasoned about without ambiguity. All file references are real.

### 1.1 The Plan as the unit of work

Since Epic 17 (2026-04-21), Labs is organized around a first-class **Plan** object: one intent → 1..N epics → stories → waves. A Plan owns its identity for the entire lifecycle.

- **Type:** `functions/shared/types/plan.ts`
- **Schema (Zod):** `functions/shared/schemas/plan-schema.ts`
- **Lifecycle states:** `concept → developing → review → delivered` (plus `fixing`, `archived`).

Key Plan fields relevant to GitHub integration:

| Field | Locked when | Notes |
|---|---|---|
| `name` | At creation | kebab-case slug; doubles as EC2 folder slug **and** deploy URL segment. Already URL-safe → repo-name-safe. |
| `displayName` | After leaving `concept` | Human-readable label. |
| `workingDir` | At creation | `/home/ubuntu/projects/<name>` on the daemon EC2 box. |
| `executionMode` | Soft | `'pipeline'` (legacy per-story) or `'orchestrator'` (default). |
| `rigor` | At first wave launch | `prototype` / `mvp` / `production`. Drives QA defaults. |
| `epicIds` | Mutable | Ordered list of epic IDs the plan owns. |
| `deployJobIds[]` | Append-only | Plan-level deploy history. |

### 1.2 Hierarchy: Plan → Epic → Story → Wave

- **Epic** (`functions/shared/types/epic-workflow.ts:147`) belongs to a Plan via `planId`. Epics declare `dependsOnEpics`, which produces a **plan-wave** number — epics in plan-wave 0 start immediately, plan-wave N+1 epics start when all wave N epics complete.
- **Story** (`functions/shared/types/epic-workflow.ts:112`) lives inside its epic's `stories[]` array (denormalized — no separate stories table). Stories declare `dependsOn`, producing an intra-epic **story-wave** number. Stories in the same wave run in parallel.
- **Storage:** `futurator-plans` and `futurator-epic-workflows` DDB tables. Stories are nested in epics; jobs live in `futurator-agent-jobs`.

### 1.3 Trigger points: where development "starts"

```
POST /api/plans/from-intent       (functions/api/index.ts:1332)
  ├─ Insert Plan (status: 'concept')
  ├─ SSM: mkdir -p /home/ubuntu/projects/<name>, write plan.md
  ├─ Enqueue PM job (PENDING)            ── kicks off epic generation
  └─ Optionally enqueue party-bootstrap   ── BMAD agents

POST /api/plans/:id/start         (functions/api/index.ts:1587)
  ├─ Compute plan-wave 0 (epics with no dependsOnEpics)
  ├─ For each wave-0 epic: enqueue epic-dev job (or pipeline jobs in legacy mode)
  └─ Plan transitions: 'concept' → 'developing'    ◄── this is "development starts"
```

`/start` is the moment GitHub repo creation should fire (see §3.3).

### 1.4 Daemon execution model

`daemon/agent-daemon.mjs` polls `futurator-agent-jobs` every ~3s for `PENDING` jobs.

- Per-plan working directory: `/home/ubuntu/projects/<plan.name>` — **all epics under one plan share the same folder**. This is important: the repo is naturally one-per-plan.
- The daemon `chdir`s into `job.workingDir` and spawns Claude CLI as a subprocess. Claude writes files into that folder.
- Job routing (`daemon/pipelines/job-router.mjs`):
  - `phase: 'epic-dev'` → `epic-dev-pipeline.mjs` (orchestrator mode)
  - `jobType: 'party-turn' | 'party-bootstrap'` → BMAD pipelines
  - else → legacy step-based pipeline
- Job statuses: `PENDING → RUNNING → COMPLETED | FAILED | COMPLETE_WITH_BLOCKED_STORIES | STALE`.

### 1.5 Wave completion

`functions/cron/wave-completion-check.ts` runs every 60s:

1. Scans plans in `developing | fixing | review`.
2. Reduces each plan's wave state. When all stories in story-wave N are terminal, enqueues story-wave N+1.
3. When all stories in the last story-wave of an epic are done, the epic completes; this can unblock plan-wave N+1 across the plan.
4. When all epics complete, the plan transitions `developing → review`. If `autoRunQa` is on, browser-test QA jobs fire.

Wave boundaries are the **natural commit/PR boundaries** for GitHub.

### 1.6 Existing deploy flow

`POST /api/epic-workflows/:id/deploy` (`functions/api/index.ts:3509`) runs a single DevOps Deploy agent that:

1. Ensures `vite.config.ts` has `base: '/apps/<appName>/'`.
2. `npm run build`.
3. `aws s3 sync dist/ s3://futurator-ai-website/apps/<appName>/`.
4. CloudFront invalidation.

Today **deploy is the only thing that leaves the EC2 folder**. Source code, config, and tests stay on the box. There is no remote source-of-truth for what Claude has written. This is the gap GitHub fills.

---

## 2. Why GitHub integration

Three concrete benefits, in priority order:

1. **Durable source of truth.** EC2 is ephemeral. Today, if the daemon box is rebuilt, every plan's working tree is gone. A Git remote is the cheapest off-box backup.
2. **Diffability and review.** Every wave currently fires off Claude with no record beyond the agent-job logs. PRs make the diff inspectable, and per-wave PRs give us a natural "what did wave 2 actually change?" surface.
3. **CI/CD as the deploy pipeline.** The current Deploy Agent is a Claude subprocess running `aws s3 sync`. Replacing it with a GitHub Actions workflow (triggered on merge to `main`) is more robust, free for public repos / cheap for private, and gives us cache-able dependencies and parallel job slots — without us having to re-build orchestration in the daemon.

---

## 3. MVP design

The principle: **never block the pipeline on GitHub**. Every git/GitHub step is best-effort and surfaces failures via the existing job/plan status surfaces. If GitHub is down, development still happens locally on EC2.

### 3.1 Plan model changes

Add to `Plan`:

```ts
githubRepo?: {
  enabled: boolean;          // default true; settable only at creation
  owner?: string;            // resolved from env GITHUB_REPO_OWNER at create time
  repo?: string;             // = plan.name (locked alongside name)
  url?: string;              // https://github.com/<owner>/<repo>
  defaultBranch?: string;    // 'main'
  status: 'pending' | 'created' | 'failed' | 'disabled';
  createdAt?: string;
  lastSyncAt?: string;
  error?: string;            // last failure reason for retry UI
};
```

Locking rules:
- `enabled` is **lock-at-create** (matches `name`). Toggling off mid-flight gets weird.
- `repo` mirrors `name`, so it inherits the existing slug validation (`/^[a-z][a-z0-9-]{2,40}$/`) — already GitHub-compatible.
- `status` is mutable so we can show retry UI.

### 3.2 UI toggle

In `src/components/labs/plans/new-plan-form.tsx`, advanced section, default ON:

> ☑ **Link to GitHub repo**
> Auto-creates `github.com/<owner>/<plan-name>` when development starts. Wave commits and PRs sync automatically.

On the Plan dashboard, after creation:
- A repo chip near the plan name with link + status.
- If `status === 'failed'`: a "Retry GitHub link" button that re-runs the create step.

### 3.3 Repo lifecycle through the pipeline

Lazy creation — we don't burn a repo for a plan that never starts.

| Pipeline event | GitHub side-effect |
|---|---|
| `POST /plans/from-intent` (status `concept`) | None. Just persist `githubRepo.enabled` + `repo` (= name). |
| Plan edited / epics generated | None. |
| `POST /plans/:id/start` (transition to `developing`) | **Create repo** (`gh repo create <owner>/<name> --private`). Initial commit pushes `plan.md`, generated `epics.md`, and any scaffolding the PM agent produced. Set `githubRepo.status = 'created'`. |
| Daemon picks up an epic-dev job | `git fetch`, ensure `main` is checked out, `git pull`. If `.git` is missing (fresh box), `git clone`. |
| Story-wave starts | Daemon checks out branch `wave/<epicId>-<waveN>` from `main`. |
| Each story in the wave finishes | Commit per story: `git commit -m "story(<storyId>): <title>"`. Authored by `Futurator Bot <bot@futurator.ai>`. Co-authored-by trailer for the agent model. |
| Wave completes (all stories terminal) | `git push origin wave/<epicId>-<waveN>`, `gh pr create --base main --head wave/...`, then `gh pr merge --squash --auto` (auto-merges once required checks pass — see §4). |
| Epic completes | No-op at GitHub level. The merged wave PRs already represent the epic. |
| Plan transitions to `review` | Optional: open a single tracking issue `Plan ready for review` linking the wave PRs. (Stretch.) |
| Deploy fires | (Phase 2.) Triggered by GitHub Actions on merge to main, not by Claude. See §4. |
| Plan archived | Repo stays. Just unlink. We never auto-delete repos — too irreversible. |

### 3.4 Branching strategy — wave-per-branch

We considered three options:

- **A. Branch per story → PR per story.** Cleanest review surface, but stories in the same wave run in parallel, and a single working directory can't hold parallel branches without git worktrees. Rules out option A for MVP.
- **B. Direct commits to `main`.** Simplest, but loses any review surface and serializes parallel waves through a single working tree race.
- **C. Branch per wave → PR per wave.** ✅ **Picked.** Stories in a wave run in parallel into the same branch (the daemon already serializes story completion by definition — the wave only advances when all stories are terminal). One PR per wave matches the existing wave-completion-cron's natural cadence. Story-level granularity is preserved through commits.

**Branch naming:** `wave/<epicId-short>/<waveNumber>` (e.g., `wave/auth-login/0`). Plan-wave and story-wave are both flat numbers; epic id disambiguates.

**Conflicts:** because all waves share one working dir on EC2, two epics in the same plan-wave that touch the same files **can** conflict. MVP behavior: rebase wave N+1 onto latest `main` before starting; if it fails, mark the plan `fixing` and surface the conflict in the existing blocker UI. Don't attempt auto-resolution.

### 3.5 Commit cadence

- **Per story** — one commit per story completion, not per Claude turn. The orchestrator already knows when a story is "done" (status transition to `done`); that's the trigger.
- **Author identity:** `Futurator Bot <bot@futurator.ai>`, with `Co-Authored-By: <agent-model> <noreply@futurator.ai>` trailers so the model lineage stays in `git log`.
- **Message format:** `story(<storyId>): <title>` — `<storyId>` already exists, parsable by tools later.
- **No commits during in-progress agent runs.** We commit on terminal status transitions only, to avoid noise from the orchestrator's iterative edits.

### 3.6 PR strategy

- One PR per wave, opened when the wave's last story reaches a terminal state.
- PR body auto-generated from the wave's stories: title, acceptance criteria, jobId link back to the admin app (`https://admin.futurator.ai/labs/?planId=<id>`), cost summary.
- `--auto` merge enabled. CI gates the merge. If CI fails, the wave-completion cron sees a non-merged PR and marks the plan `fixing`, blocking wave N+1.
- **Review:** human review is **opt-in for MVP** — `--auto` merges as soon as required checks pass without waiting for approval. Rigor `production` should require an approval; we'll wire that in phase 2 by toggling branch protection.

### 3.7 Auth

- **GitHub fine-grained PAT** in **AWS Secrets Manager** at `futurator/github-pat`.
- Scopes: `repo` (read/write), `workflow` (so we can write Actions YAML), and resource-restricted to a single owner.
- The daemon reads it at startup and exports `GH_TOKEN` for `gh` CLI calls and as the auth header for HTTPS git remotes (`https://x-access-token:${GH_TOKEN}@github.com/...`).
- The Lambda API also needs it for the create-on-start path; granted via IAM `secretsmanager:GetSecretValue`.
- **Owner** comes from env `GITHUB_REPO_OWNER` (single value for MVP — your account or a dedicated org). No per-plan owner picker yet.

### 3.8 Failure handling

| Failure | Behavior |
|---|---|
| Repo create fails on `/start` | Plan still transitions to `developing`. `githubRepo.status = 'failed'`, error stored. UI shows "Retry GitHub link". Pipeline runs locally on EC2 only. |
| `git push` fails (auth, rate limit) | Job logs the failure, retries 3× with backoff, then sets `githubRepo.status = 'failed'`. Wave still completes from the orchestrator's perspective. Surfaces a banner. |
| PR creation fails | Branch is pushed; PR is not. We set a flag and the wave-completion cron retries PR creation on its next tick. |
| Repo already exists at create time | Treat as success, attach to existing repo. (We never auto-delete repos, so this is the recovery path after a previous plan with the same name.) Ricardo: this implies plan `name` collisions need to be checked at creation against GitHub, not just DDB — small extra round-trip. |

---

## 4. CI/CD

This section is **directional, not MVP**. The MVP just gets the repo wired up and committing. CI/CD comes once we trust the repo state.

### 4.1 Where the existing deploy flow goes

The current Deploy Agent (`/api/epic-workflows/:id/deploy`) becomes redundant once GitHub Actions can do the same work. Migration plan:

1. **MVP+1:** keep the Deploy Agent as-is. The repo just shadows what's on EC2.
2. **Phase 2:** add a `.github/workflows/deploy.yml` to the **scaffolding** the PM agent generates at plan creation. On push to `main`, it runs `npm ci && npm run build && aws s3 sync dist/ s3://futurator-ai-website/apps/<appName>/` and invalidates CloudFront.
3. **Phase 3:** the admin "Deploy" button stops creating a Claude job and instead triggers `gh workflow run deploy.yml` (or just relies on the auto-deploy from the wave-merge to `main`). The Deploy Agent code is deleted.

### 4.2 What CI gates the wave PRs?

Per `Plan.rigor`, a tiered set of required checks:

| Rigor | Required checks |
|---|---|
| `prototype` | `lint`, `typecheck` |
| `mvp` (default) | `lint`, `typecheck`, `test` (Vitest) |
| `production` | `lint`, `typecheck`, `test`, `e2e` (Playwright headless), `build`, **+ human approval** |

These are configured as a single `.github/workflows/ci.yml` with conditional jobs, plus a branch-protection rule on `main` that requires the rigor-appropriate set. Branch protection is created/updated by the daemon at plan-start time using `gh api -X PUT /repos/.../branches/main/protection`.

### 4.3 Secrets / IAM for Actions

- AWS deploy needs S3 + CloudFront perms. Use **GitHub OIDC → IAM Role** (`AmazonS3FullAccess` scoped to `futurator-ai-website/apps/*` + CloudFront invalidation). No long-lived AWS keys in GitHub.
- One IAM role per repo owner, trust policy scoped to the repo via `token.actions.githubusercontent.com` `sub` claim.

### 4.4 Cost / blast radius

- Public repos: free. Private: `2,000 Action minutes/month` free on GitHub Free tier; more than enough for MVP.
- Per-wave PR + CI is cheap: a typical wave touches ~3-10 files, CI runs in 2-5 min. At 10 plans × 5 epics × 3 waves = 150 wave-PRs/month → ~600 min, well inside free tier.
- Worst case (production rigor with Playwright): 10-15 min per CI run. Still within free tier at current volumes.

### 4.5 What we explicitly do NOT do in MVP CI/CD

- No deploy previews / preview URLs per PR.
- No automated rollback on failed deploy.
- No release tagging / semver / changelogs.
- No Dependabot / Renovate.
- No multi-environment (staging / prod) — we deploy straight from `main` to the only environment.
- No artifact registry / container builds.

These are all reasonable phase-3 additions. None block MVP.

---

## 5. Open questions for Ricardo

1. **Owner.** Personal account (`rica-araya`?) or new org (`futurator-labs`)? Org is cleaner for ownership transfer later but takes 5 min to set up.
2. **Visibility.** Default private? Some plans might be public-by-design (e.g., demos). Add a per-plan toggle, or always private with manual flip-to-public?
3. **Scaffold ownership.** Today the PM agent writes `plan.md`. Should it also write `.gitignore`, `README.md`, and `.github/workflows/ci.yml`? My read: yes — the PM agent is already the "set up the project" step.
4. **Branch protection on `main`.** Requires admin scope on the PAT. OK to grant?
5. **What happens to existing plans?** Pre-Epic-17 plans are wiped (per CLAUDE.md). Plans created since Epic 17 but before this lands have no repo. Backfill on next `/start`, or leave them orphan? My read: leave them orphan; surface a "Link to GitHub" action for them post-hoc.

---

## 6. Implementation order (proposed)

Each step ships independently and is reversible.

1. **Schema + UI toggle** — add `githubRepo` field to Plan, default-on toggle in `new-plan-form`, repo chip on Plan dashboard. Behind a feature flag (`NEXT_PUBLIC_GITHUB_INTEGRATION=1`). No actual GitHub calls yet. *(~1 day)*
2. **PAT + Secrets Manager wiring** — provision PAT, store in Secrets Manager, give Lambda + daemon read access. Verify `gh auth status` works from EC2. *(~½ day)*
3. **Repo creation on `/start`** — wire `gh repo create` into the plan-start handler. Initial commit of `plan.md`. Failure-tolerant. *(~1 day)*
4. **Daemon git bootstrap** — daemon ensures `.git` exists in the working dir, fetches, checks out branch on wave start. *(~1 day)*
5. **Wave commits + PR** — story-completion commits, wave-completion push + PR + auto-merge. *(~2 days)*
6. **Branch protection by rigor** — write CI workflow YAML in scaffold, enable branch protection. *(~1 day)*
7. **CI/CD deploy migration** — replace Deploy Agent with workflow_dispatch. *(phase 2; out of MVP)*

Total MVP: ~6 working days.

---

## 7. Decision summary

- **One repo per Plan**, owned by a single env-configured GitHub owner.
- **Created lazily** at `/plans/:id/start`, not at plan-create.
- **Branch per wave**, one squash-merged PR per wave, auto-merge gated by CI.
- **Auth via fine-grained PAT** in AWS Secrets Manager.
- **CI/CD lives in `.github/workflows/`** but is phase 2 — the MVP just gets the repo state right.
- **Failures never block the local pipeline.** GitHub is a mirror, not a dependency.
