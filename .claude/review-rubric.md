# Futurator-Admin Review Rubric — Project Overlay

Rules specific to this repository. The rubric-merge helper
(`daemon/pipelines/lib/rubric-merge.mjs`) appends this file to the global
default at `/opt/futurator/rubrics/default.md`. Overlay rule IDs win over
default IDs if they collide; the helper logs a warning.

Content derives from `CLAUDE.md` and the epic-orchestrator architecture doc §14.
Architectural stories that propose new rules update this file atomically
(see `.claude/agents/dev-architectural.md`).

Format: each rule is a level-2 heading `## R-{CATEGORY}-{NNN} — {title}`,
followed by bullets including at minimum a `**Check**` (or `**Rule**`) line and
a `**Rationale**` line. Additional `**Default severity**` and `**Applies when**`
bullets are optional metadata consumed by the reviewer subagent.

---

## R-ARCH-001 — DynamoDB Multi-Table Only

- **Default severity**: blocker
- **Applies when**: diff adds or modifies DynamoDB table definitions, repository files, or SST resource declarations
- **Check**: Every table holds a single data concern. Reject designs that shoehorn multiple entity types into one table with a composite key discriminator. Search the diff for PK patterns like `ENTITY#...` or single tables named generically.
- **Rationale**: CLAUDE.md forbids single-table design in this project. Multi-table keeps each concern independently observable, migrable, and billable.

## R-ARCH-002 — Single Hono App in `functions/api/index.ts`

- **Default severity**: blocker
- **Applies when**: diff adds a new Lambda handler, a new Hono app, or splits `functions/api/index.ts` into multiple entrypoints
- **Check**: Reject new Hono apps or additional Lambda handlers for request routing. Every API route lives on the single Hono app exported from `functions/api/index.ts`.
- **Rationale**: CLAUDE.md defines one Hono app as the API surface; parallel entrypoints fragment CORS, auth, and deployment.

## R-ARCH-003 — Repository Pattern, One File per Concern

- **Default severity**: major
- **Applies when**: diff adds, moves, or modifies files under `functions/shared/repositories/`
- **Check**: Each repository file owns exactly one DynamoDB table and exports pure functions (`get*`, `list*`, `update*`, `delete*`). Reject cross-repo joins, shared base classes, or repositories that touch multiple tables in a single function.
- **Rationale**: Matches the multi-table rule and keeps data access auditable and testable per concern.

## R-ARCH-004 — Static Export — No SSR or Dynamic Runtime

- **Default severity**: blocker
- **Applies when**: diff modifies `next.config.*`, `app/` routes, or introduces `'use server'` directives, dynamic route params, or runtime server code
- **Check**: Reject changes that break `output: 'export'` — no `getServerSideProps`, no server actions, no Edge runtime, no dynamic route segments without `generateStaticParams`, no `trailingSlash: false`. Admin ships as static HTML to S3.
- **Rationale**: CLAUDE.md — admin is a Next.js 16 static export deployed to S3 via SST; SSR would break the deploy topology.

## R-ARCH-005 — No Hono CORS Middleware

- **Default severity**: blocker
- **Applies when**: diff modifies `functions/api/index.ts` or imports from `hono/cors`
- **Check**: Reject `.use('/*', cors(...))` or equivalent. CORS lives at the Lambda Function URL level in `sst.config.ts`.
- **Rationale**: Dual CORS produces preflight errors; CLAUDE.md makes SST the single source of truth for CORS policy.

## R-ARCH-006 — Zustand for Client State, TanStack Query for Server State

- **Default severity**: major
- **Applies when**: diff adds client state management (new stores, contexts, reducers) or new data-fetching hooks
- **Check**: Reject new React Context providers that hold server state. New hooks that fetch from the API must wrap `useQuery` / `useMutation` from `@/lib/api-client.ts`; do not hand-roll `fetch` + `useState`.
- **Rationale**: Split is codified in CLAUDE.md; mixing the two fragments caching, invalidation, and persistence.

## R-ARCH-007 — Zod `.safeParse` at API Boundaries

- **Default severity**: major
- **Applies when**: diff adds or modifies a route handler in `functions/api/`
- **Check**: Every handler validates input with a Zod schema from `functions/shared/schemas` using `.safeParse()`, never `.parse()`. Validation errors must use `ValidationError` from `functions/shared/errors.ts`.
- **Rationale**: `.parse()` throws synchronously and collapses context; `.safeParse` + the shared error envelope produces consistent 400 responses.

---

## R-SAFE-001 — Never Sync admin `out/` to futurator-ai-website

- **Default severity**: blocker
- **Applies when**: diff adds or modifies shell scripts, CI configuration, SST deploy hooks, or deploy documentation
- **Check**: Reject any command matching `aws s3 sync out/ s3://futurator-ai-website`. Admin deploys via `sst deploy` to its SST-managed bucket (`futurator-admin-production-adminsiteassetsbucket-*`).
- **Rationale**: 2026-04-15 incident — admin `out/` synced to the public bucket overwrote `index.html` and broke the homepage. Only four scoped paths are writable in the public bucket per CLAUDE.md.

## R-SAFE-002 — No `.env`, Credentials, or Secrets in Diff

- **Default severity**: blocker
- **Applies when**: always
- **Check**: Reject files matching `.env*`, `*credentials*`, `*secret*`, or inline `AWS_SECRET_ACCESS_KEY=`, `sk-*`, high-entropy Bearer tokens.
- **Rationale**: Secrets in git history travel everywhere the repo travels; revocation is expensive and sometimes impossible (third-party keys).

## R-SAFE-003 — No `--no-verify`, `--no-gpg-sign`, or Skipped Hooks

- **Default severity**: blocker
- **Applies when**: diff modifies git commands, pre-commit config, Husky hooks, or shell scripts invoking git
- **Check**: Reject flags that bypass hooks or signing (`--no-verify`, `--no-gpg-sign`, disabling lint-staged entries, `HUSKY=0` in scripts).
- **Rationale**: Hooks enforce lint, typecheck, and commit-style at the earliest cheap point; bypassing them leaks defects downstream.

---

## R-CONV-001 — Bearer Tokens, Never Cookies

- **Default severity**: blocker
- **Applies when**: diff modifies auth flow, `api-client.ts`, `auth-store.ts`, or any handler that reads/writes session state
- **Check**: Reject `document.cookie`, `Set-Cookie` headers, cookie-based session logic, or any server-side assumption of a session cookie. Auth is `Authorization: Bearer <jwt>` end to end, with tokens stored in `localStorage` via `auth-store.ts`.
- **Rationale**: CLAUDE.md and the Identity Broker integration are Bearer-only; a mixed cookie/Bearer flow triggers CORS credential issues and breaks static hosting assumptions.

## R-CONV-002 — Use `@/` Path Alias for Frontend Imports

- **Default severity**: minor
- **Applies when**: frontend imports in `/src/`
- **Check**: `import x from '../../../foo'` is a smell; prefer `@/foo`. Exception: sibling imports within the same feature directory.
- **Rationale**: Deep relative paths make refactors brittle and obscure module ownership.

---

## R-TEST-001 — Colocated Vitest Coverage for New Hooks and Repository Functions

- **Default severity**: major
- **Applies when**: diff adds a new file in `src/hooks/` or `functions/shared/repositories/`
- **Check**: A matching `*.test.ts` exists alongside the new file, covering the primary happy path plus at least one error case. `it.only` / `describe.only` are rejected.
- **Rationale**: CLAUDE.md expects Vitest coverage at these boundaries; skipped tests turn into silent rot.

---

## R-SEC-001 — Auth Middleware on Non-Public Routes

- **Default severity**: blocker
- **Applies when**: diff adds a new route in `functions/api/index.ts`
- **Check**: Public routes per CLAUDE.md: `/api/health`, `/api/auth/*`, `/api/public/*`. Any other route must be protected by the JWT auth middleware from `functions/shared/auth-middleware.ts` (`requireAuth` or equivalent).
- **Rationale**: Broken access control is the default consequence of "forgot to add middleware"; the perimeter catches it, but only if the middleware is on the handler.

## R-SEC-002 — JWT Validation Against Identity Broker JWKS

- **Default severity**: blocker
- **Applies when**: diff modifies `functions/shared/auth-middleware.ts` or adds a new auth verification path
- **Check**: JWT validation uses the Identity Broker JWKS (issuer `https://api.futurator.com/v1`) with the cached 1-hour JWKS client. Reject hand-rolled signature checks, hardcoded public keys, or skipped `aud`/`iss`/`exp` validation.
- **Rationale**: CLAUDE.md specifies Identity Broker as the sole issuer; divergent validation paths are how auth-bypass bugs ship.
