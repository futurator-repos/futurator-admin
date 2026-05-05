# CLAUDE.md — Futurator Admin

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## IDENTITY CHECK

When you start ANY session or task in this project, your very first
message must begin with:

> 🟢 CLAUDE.md loaded — Futurator Admin context active

Do this before anything else, every time, no exceptions.

## RULES

- Never say "Great!" or "Sure!" at the start of a response
- Always refer to this project as "Futurator-Admin" not "the project"
- When asked to create a file, confirm the path before writing

## Recent changes

- **2026-04-21 (Epic 17 — Plan-Based Labs):** Labs is now organized around a
  first-class **Plan** object: one intent → 1..N epics → stories → waves. A
  Plan owns its name (= folder slug = deploy URL slug, locked at creation),
  a persistent `plan.md` on disk, and an epic-level dependency graph that
  drives plan-waves in addition to the existing story-waves. UI home is the
  Plans list at `/labs`; individual plans open via `/labs?planId=<id>`.
  Legacy pre-wipe: all DDB rows + EC2 project folders were cleared
  2026-04-21 before Epic 17 shipped. Do not try to restore historical epics.
- **2026-04-17 (EO-7.2):** new epics default to `useEpicOrchestrator: true`.
  (Superseded by Epic 17 — use `Plan.executionMode` instead; legacy epics
  still honor this flag.)

## ⛔ DEPLOY SAFETY — DO NOT SYNC `out/` TO `futurator-ai-website`

This admin app's static export (`out/`) belongs at **`admin.futurator.ai`** and is
deployed by **`sst deploy`** to its own SST-managed bucket
(`futurator-admin-production-adminsiteassetsbucket-*`). It must **NEVER** be
synced to `s3://futurator-ai-website/` — that bucket hosts the public homepage at
`futurator.ai`, which is a separate Next.js project at
`/Users/ricardoarayafarias/GetReal/Clients/futurator`.

**Forbidden — will break futurator.ai:**

```bash
aws s3 sync out/ s3://futurator-ai-website/         # ❌ NO
aws s3 sync out/ s3://futurator-ai-website/ --delete # ❌ NO
```

**Allowed admin writes to `futurator-ai-website` (scoped paths only):**

| Path                          | Writer                                          | Purpose                           |
| ----------------------------- | ----------------------------------------------- | --------------------------------- |
| `data/projects.json`          | `functions/shared/export-public-projects.ts`    | Public projects list for homepage |
| `media/<projectId>/`          | API pre-signed upload endpoint                  | Project media uploaded by admin   |
| `apps/<appName>/`             | Deploy Agent (`/api/epic-workflows/:id/deploy`) | Published Vite/React user apps    |
| `knowledge-live/<projectId>/` | Daemon `s3-backup.mjs`                          | Mycelium knowledge graph backups  |

**Historical incident (2026-04-15):** the admin `out/` was synced to the bucket
root, overwriting `index.html`. Visitors to futurator.ai got the admin AuthGuard
spinner → Google OAuth redirect instead of the homepage. Recovery required
running `scripts/deploy.sh` from the homepage repo (which preserves the four
scoped paths above).

To deploy this admin app: **`sst deploy`** — never a manual `aws s3 sync`.

## HELLO WORLD SIGNAL

If the user says "ping", respond with exactly:

> pong — CLAUDE.md is alive 🎯

## Project Overview

Futurator Admin Hub — a full-stack Next.js 16 admin dashboard for managing Futurator project portfolios, AWS cost tracking, resource inventory, and an experimental agentic office (Labs). Deployed as a static export to S3 with Lambda-backed APIs via SST.

## Commands

```bash
npm run dev              # Next.js dev server (localhost:3000)
npm run build            # Static export to /out
npm run lint             # ESLint with --max-warnings 0
npm run typecheck        # tsc --noEmit (strict)
npm run test             # Vitest (all tests)
npm run test -- path     # Single test file
npm run test:e2e         # Playwright smoke tests (starts dev server)
npm run test:e2e:headed  # Playwright with browser visible
npm run knip             # Detect unused exports/dependencies
npm run ci               # Full pipeline: lint + format:check + knip + typecheck + test + build
sst deploy               # Deploy infrastructure to AWS
```

Pre-commit hooks (Husky + lint-staged) auto-run `eslint --fix` and `prettier --write` on staged `.ts/.tsx` files.

## Architecture

### Frontend (`/src`)

- **Next.js 16 App Router** with `output: 'export'` (static HTML, no SSR). `trailingSlash: true` for S3 website hosting.
- **Path alias**: `@/*` maps to `./src/*`
- **State**: Zustand stores (`/src/stores`) for client state (auth, UI, agentic office); TanStack Query for server state with 5-min staleTime.
- **Auth**: Bearer JWT tokens stored in localStorage via `auth-store.ts`. `api-client.ts` proactively refreshes tokens when <2 min remaining and auto-retries on 401.
- **UI**: Tailwind CSS 4 + shadcn/ui primitives (`/src/components/ui`). Semantic theme tokens (`success`, `warning`, `accent-blue`) for dark/light mode. Geist font.
- **Custom hooks** (`/src/hooks`): One per domain (use-projects, use-costs, use-resources, use-agent-job, etc.) wrapping TanStack Query + api-client.

### Backend (`/functions`)

- **`/functions/api/index.ts`**: Single Hono.js app (~700+ lines) handling all API routes, exported as a Lambda handler. CORS is configured at the Lambda Function URL level in sst.config.ts — do NOT add Hono CORS middleware.
- **`/functions/shared/repositories`**: One DynamoDB repository file per data concern (projects, costs, resources, epics, agent-jobs, etc.). Repository pattern with pure functions.
- **`/functions/shared/auth-middleware.ts`**: JWT validation against Identity Broker JWKS (cached 1 hour). Issuer: `https://api.futurator.com/v1`.
- **`/functions/cron`**: Scheduled Lambdas — cost-aggregator (daily 6am), resource-discoverer (daily 7am), tag-auditor, schedule-executor (hourly), user-sync.
- **`/functions/auth/callback.ts`**: OAuth callback from Identity Broker.
- **Validation**: Zod schemas in `/functions/shared/schemas`. Always use `.safeParse()`.

### Infrastructure (`/sst.config.ts`)

- **SST v4** (Pulumi-based) deploying to us-east-1.
- **11 DynamoDB tables** (PAY_PER_REQUEST, several with PITR).
- **Lambda functions**: API (256MB, 30s), AuthCallback (256MB, 10s), 5 cron functions.
- External: S3 bucket `futurator-ai-website`, CloudFront dist `E1BI1YWMTLSDTE` (futurator.ai homepage, separately managed).

### Daemon (`/daemon`)

Standalone Node.js process (`agent-daemon.mjs`) that polls DynamoDB for PENDING agent jobs and spawns Claude CLI subprocesses. Runs on EC2 instance. Separate `package.json` — install deps with `cd daemon && npm install`.

## Key Conventions

- **Auth flow**: Identity Broker OTP login → `/api/auth/exchange` → JWT tokens. Frontend uses `Authorization: Bearer <token>` headers. Never use cookies.
- **DynamoDB**: One table per concern (never single-table design). Table names come from environment variables set by SST.
- **API responses**: Consistent JSON envelope. Errors use `AppError`/`ValidationError` from `/functions/shared/errors.ts`.
- **API_BASE_URL**: Relative path in production (empty string + `/api`), only set `NEXT_PUBLIC_API_URL` for local dev pointing at a remote Lambda.
- **Public routes** (no auth): `/api/health`, `/api/auth/*`, `/api/public/projects`.

## Testing

- **Vitest**: jsdom environment, `@/` alias. Coverage includes `src/**` and `functions/**`. Setup in `tests/setup.ts`.
- **Playwright**: Chromium only. Auth pre-seeded in sessionStorage, API routes mocked via `page.route()`. Smoke-level tests for orphaned-component detection, not comprehensive interaction tests.
