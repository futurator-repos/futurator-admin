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
