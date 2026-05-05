# Pipeline v2.0 — logic overview (in developing)

A short brief for agents joining mid-flight. Describes the moving parts and how
they compose. Cross-references the long-form docs at the bottom.

## Frame

User intent → working app → deployed bundle, with an LLM doing only the work
no shell can. Three-tier:

```
[ Operator ] → [ Admin UI (Next.js) ] → [ API Lambda (Hono) ] → [ DDB tables ]
                                                                      ↑
[ Daemon on EC2 ] ← polls jobs ← [ agent-jobs table ]
       ↓
[ Claude CLI subprocess ] + [ bash shell steps ] + [ git push to GitHub ]
       ↓
[ s3://futurator-ai-website/ ] (app bundles, QA snapshots, knowledge graphs, public projects.json)
```

**Bash-first axiom (PR-3):** every pipeline step asks "why can't bash do this?"
before adding to a prompt. Dev + reviewer = LLM; everything else (build
checks, screenshot capture, L0 verdicts, S3 upload, status flips) is shell.
Cheaper AND more diagnosable — bash failures pinpoint the broken step; LLM
failures swallow context.

## Domain objects

- **App** (`functions/shared/types/app.ts`) — immortal product. Slug, working
  dir on EC2, GitHub repo, boilerplateType. 1:N Plans.
- **Plan** (`functions/shared/types/plan.ts`) — iteration on an App. intent,
  rigor, autoRunQa, qaJobId. Owns `plan.md`. 1:N Epics.
- **Epic** (`functions/shared/types/epic-workflow.ts`) — coarse work grain.
  Stories[], waveBuildJobs, deployJobId.
- **Story** — atomic dev unit. criteria[], visualTests[], jobId,
  status (pending/in_progress/done/fixing).
- **AgentJob** (`functions/shared/types/agent-orchestrator.ts`) — concrete
  pipeline run. Owns pipeline definition, variables (extracted from agent
  output), status, costUsd.

## Daemon

`/daemon/agent-daemon.mjs` runs on EC2 (`/opt/futurator-daemon/`).

Polls DDB for PENDING jobs → executes the pipeline step-by-step → marks
COMPLETED/FAILED. Two step types:

- **`agent`** — spawns `claude -p --model=… --output-format stream-json`,
  enforces tool allowlist (PR-3), cost ceiling (PR-1), time ceiling, prework
  gate (PR-2). Captures variables from stdout via extractor configs.
- **`shell`** — runs the bash command directly, captures stdout, applies
  extractor regexes. No model fee.

Daemon-side modules in `/daemon/lib/*.mjs`. Some pipeline shell heredocs
need shared TS logic (e.g., the visual-test classifier); those bundle to
`daemon/lib/*-bundle.cjs` via `scripts/build-daemon-bundles.mjs` (PR-8f).

Auth: daemon holds an Anthropic OAuth token; `runAgentWithAuthRecovery`
(PR-6) refreshes proactively when <2 min remaining.

## GitHub

Each App is provisioned from a `futurator-repos/template-<boilerplate>` repo
via the daemon's **app-bootstrap** saga (clone → inject `__APP_SLUG__`/
`__APP_DISPLAY_NAME__` placeholders → npm install → BMAD bootstrap → commit →
push to a fresh App-owned origin).

Working tree lives at `/home/ubuntu/projects/<appId>/` on the daemon EC2 box.
Dev work commits to local git. Deploy stage `commit-and-push`es to the App's
origin; no forks, no PRs — direct pushes by the agent.

## Boilerplates

`functions/shared/boilerplates/registry.ts` is the single source of truth.
Four entries: `nextjs` (wired), `sst` / `vite` / `mobile` (stubs).

Each entry declares:

- `defaultStack` — runtime, package manager, dev/build/test commands
- `postCreateSteps` — ordered scaffold steps the daemon runs after clone
- `pmContext` — framework descriptor + scaffolded paths PM must NOT recreate (PR-5)
- `qaContext` — port, healthcheck, dev command, warmup ms, console
  allowlist (PR-8b/g)

`boilerplateType` lives on the App row; `qa-boilerplate-resolver.ts` (PR-8g)
plumbs it to QA at runtime.

## Bash scripts

- `scripts/rsync-daemon.sh` — pushes local `daemon/` tree to EC2. Runs
  `build-daemon-bundles.mjs` first so .cjs bundles are fresh.
- `scripts/build-daemon-bundles.mjs` — esbuild → CJS for `node -e` shell
  heredocs. Currently bundles `visual-test-classifier`.
- `scripts/qa-smoke-test.mjs` — pre-deploy validator. Verifies bundle
  resolves, heredoc round-trips hostile JSON, classifier round-trips
  rigor floors. `--with-cli` adds claude/playwright/aws probes.
- `scripts/deploy.sh` (homepage repo) — only thing that should ever
  `aws s3 sync` to `futurator-ai-website/` root. Admin uses `sst deploy`.

## Pipeline stages (happy path, App/Plan v1)

```
App bootstrap
   → Plan from intent (PM agent)
       → Epics + Stories with ACs + visual tests
           → [orchestrator]  one Sonnet runs whole epic inline
              | OR
              [legacy pipeline]  per-story dev → reviewer → fixing-loop
                → Wave build-check (compile/typecheck/lint/unit/browser per rigor)
                   → Plan build-check (full-tree at plan scope)
                      → QA aggregate (classifier, coverage, contract draft)
                         → [operator approves contract]
                            → QA execute (prepare → l0 → l1 → l2 → report → cleanup)
                               → Deploy (build → s3 sync → projects.json)
                                  → Plan: delivered
```

Per stage, briefly:

1. **App bootstrap** — `POST /api/apps`. Bash-only saga; no LLM.
2. **Plan from intent** — `plan-generation-service.ts`. PM agent emits JSON
   plan; daemon writes `plan.md`, creates Epic + Story rows.
3. **Story dispatch** — orchestrator mode (default since EO-7.2) or legacy
   wave pipeline. Pre-DEV gate (PR-2) skips already-done work via bash
   git-log inspection. Touch-point inference (PR-4) scopes file edits.
4. **Wave build-check** — `wave-build-pipeline.ts`. Shell steps. Failures
   write attention items keyed by `wave-reducer:test-gate-failed:<storyId>`.
5. **Plan build-check** — `plan-build-pipeline.ts`. Same matrix at plan scope.
6. **QA aggregate** — single shell step. Bundles classifier (PR-8f) +
   coverage + specificity. Writes `visual-tests-draft.md`. Sets
   `plan.qaContractStatus='pending'`.
7. **QA execute** — seven bash steps. **One** dev server per plan (PR-8a).
   Tests routed by level: L0 = bash matchers, L1 = Haiku per screenshot
   (parallel batches of 5), L2 = Sonnet per flow (sequential). Per-test
   wallclock + cost budgets enforce kill on overage (PR-8e). Plan-level
   cost ceiling marks remaining tests `skipped-budget`.
8. **Deploy** — `POST /api/epic-workflows/:id/deploy`. Daemon builds, syncs
   to `s3://futurator-ai-website/apps/<appName>/`, updates `data/projects.json`.

## Rigor dial

`Plan.rigor ∈ {prototype, mvp, production}` (Phase C). Drives:

- Pipeline builder — which gate checks run (prototype = compile+typecheck+lint;
  mvp adds unit; production adds tamper + browser)
- QA classifier — caps test level (prototype → L0 only; mvp → L0+L1;
  production → all three) (PR-8f)
- AC sign-off — production refuses implicit pass; mvp/prototype allow

`autoRunQa` defaults from rigor: production=true, mvp/prototype=false.

## Auditing

Three signal channels:

- **Attention items** — `attention-items` DDB table. Idempotent upsert by
  `dedupKey` (PR-7). Categories: test-gate-failed, tamper-reverted,
  dev-server-down, qa-failure. Global bell renders unresolved counts;
  per-plan drawer shows the failed step trail.
- **Forensic builder** — `functions/shared/timer/forensic-builder.ts`.
  Rebuilds the stage-by-stage timeline of any plan from agent-jobs +
  cost-meter samples. Powers the Forensic tab on the dashboard.
- **Cost meter** — `daemon/lib/cost-meter.mjs`. Per-job cost tracking,
  aggregated into `plan.totalCostUsd`. Cost-ceiling-after-DONE detector
  (PR-1) catches retry-loop runaways.

3× escalator (`functions/shared/timer/escalator.ts`, story 1.8.7) compares
plan delivery timing against a cohort baseline; sustained 3× outliers
escalate post-delivery (fire-and-forget).

## Cross-cutting protections by PR

| PR | What it added | Why it matters |
|---|---|---|
| PR-1 | cost-ceiling-after-DONE + retry budget | catches runaway retries |
| PR-2 | daemon-side pre-DEV gate (T0.2) | skips already-done work cheaply |
| PR-3 | tool allowlist + B8 deny + remove BASELINE prose | prompt cleanliness |
| PR-4 | touch-point inference at dispatch | scopes file edits |
| PR-5 | boilerplate-aware PM prompt | no Vite/React hardcode |
| PR-6 | retry resilience + auth recovery | survives token expiry mid-job |
| PR-7 | attention hygiene + Labs-root bell | one inbox, no duplicates |
| PR-8a | plan-scoped QA (kill epic fan-out) | t2.micro fits; -75% RAM |
| PR-8b | qa-prepare bash + viewport-fixed schema | screenshot work off the LLM |
| PR-8c | three-level routing (L0/L1/L2) | cost-aware judges |
| PR-8d | operator-gated test contract | no unreviewed test runs |
| PR-8e | per-test + plan-level budgets | predictable QA spend |
| PR-8f | classifier bundle + rigor floor + smoke test | EC2 deploys actually work |
| PR-8g | boilerplate-aware QA launcher | Next/SST/Expo Apps boot the right server |

## Where to read more

- Long-form: `docs/concepts/pipeline-v2/futurator-pipeline-qa-stage-redesign.md`
- Efficiency fixes plan: `docs/concepts/pipeline-v2/pipeline-v2-0-efficency-fixes.md`
- v1 deferrals (still relevant context): `docs/concepts/pipelinev1-deferrals.md`
- Deploy map: `docs/deployment.md`
- App/Plan v1 spec: `docs/tech-spec-app-plan-v1.md`

---

*This is a living overview — when a PR changes the pipeline shape, update
the corresponding section here, not just the long-form doc.*
