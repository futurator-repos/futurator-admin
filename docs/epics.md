# Futurator Admin Hub - Epic Breakdown

**Author:** Richie
**Date:** 2026-04-05
**Version:** 1.0

---

## Overview

This document decomposes the [PRD](./PRD.md) and [Architecture](./architecture.md) into implementable epics and stories. Each story is sized for a single dev agent session with Claude Code Max.

### Epic Summary

| #   | Epic                                 | MVP | Stories | Depends On |
| --- | ------------------------------------ | --- | ------- | ---------- |
| 0   | Project Scaffolding & Infrastructure | 1   | 10      | —          |
| 1   | AWS Tagging Foundation               | 1   | 4       | Epic 0     |
| 2   | Project Registry                     | 1   | 5       | Epic 0     |
| 3   | AWS Cost Dashboard                   | 1   | 6       | Epic 0, 1  |
| 4   | AWS Resource Map                     | 1   | 4       | Epic 0, 1  |
| 5   | Multi-Provider Cost Aggregation      | 2   | 5       | Epic 3     |
| 6   | Resource Scheduler                   | 2   | 5       | Epic 0     |
| 7   | Identity Dashboard                   | 2   | 3       | Epic 0     |
| 8   | Alert Management                     | 2   | 4       | Epic 3, 4  |

**Total: 46 stories across 9 epics**

### Sequencing

```
MVP 1 (sequential):  Epic 0 → Epic 1 → Epic 2 + 3 + 4 (parallel)
MVP 2 (parallel):    Epic 5, 6, 7, 8 (all independent after MVP 1)
```

---

## Epic 0: Project Scaffolding & Infrastructure

**Goal:** Standing Next.js static app deployed via SST on AWS (S3/CloudFront + Lambda + DynamoDB) with Google OAuth authentication, dev tooling, and CI pipeline. This epic establishes the foundation for all subsequent work.

**Value:** Zero to deployed app with auth — everything else builds on this.

---

### Story 0.1: Next.js Project Initialization

As a developer,
I want a Next.js project with TypeScript strict, Tailwind CSS, and App Router,
So that I have a properly configured foundation to build upon.

**Acceptance Criteria:**

**Given** an empty project directory
**When** I run the project initialization commands
**Then** a Next.js 15.x project is created with:

- TypeScript strict mode enabled
- Tailwind CSS 4.x configured
- App Router with `src/` directory structure
- `next.config.ts` with `output: 'export'` for static generation
- Basic folder structure: `src/app/`, `src/components/`, `src/hooks/`, `src/stores/`, `src/lib/`, `src/types/`
- A root layout with HTML lang attribute and basic metadata
- A placeholder home page that renders successfully

**And** `npm run build` completes without errors
**And** `npm run dev` starts the dev server on localhost:3000

**Prerequisites:** None — this is the first story.

**Technical Notes:**

```bash
npx create-next-app@latest futurator-admin --typescript --tailwind --eslint --app --src-dir
```

Set `output: 'export'` in `next.config.ts`. Create empty directories for the folder structure.

---

### Story 0.2: Dev Tooling — ESLint, Prettier, Knip, Husky

As a developer,
I want automated code quality checks on every commit,
So that code stays consistent and clean without manual effort.

**Acceptance Criteria:**

**Given** the initialized Next.js project from Story 0.1
**When** I configure dev tooling
**Then** the following tools are set up and working:

- **ESLint** flat config (`eslint.config.mjs`) with `@typescript-eslint`, `import`, `react-hooks` plugins. Prettier integration via `eslint-config-prettier`.
- **Prettier** (`.prettierrc`) with: single quotes, trailing commas, 100 char width, 2-space tabs, LF line endings.
- **Knip** (`knip.config.ts`) configured for Next.js entry points and excluding test files.
- **Husky** pre-commit hook running `lint-staged` which executes `eslint --fix` and `prettier --write` on staged files.

**And** `npm run lint` runs ESLint without errors
**And** `npm run format:check` runs Prettier check
**And** `npm run knip` detects no unused exports
**And** committing a file with lint errors triggers auto-fix via Husky

**Prerequisites:** Story 0.1

**Technical Notes:**
Install: `eslint`, `@typescript-eslint/eslint-plugin`, `@typescript-eslint/parser`, `eslint-plugin-import`, `eslint-plugin-react-hooks`, `eslint-config-prettier`, `prettier`, `knip`, `husky`, `lint-staged`. Add npm scripts: `lint`, `lint:fix`, `format`, `format:check`, `knip`, `typecheck`.

---

### Story 0.3: SST Initialization & Infrastructure

As a developer,
I want all AWS infrastructure defined in code via SST,
So that I can deploy and tear down the entire stack with one command.

**Acceptance Criteria:**

**Given** the Next.js project from Story 0.1
**When** I initialize SST and define the infrastructure
**Then** `sst.config.ts` creates:

- S3 bucket for static frontend files
- CloudFront distribution with:
  - Default behavior → S3 origin (static files)
  - `/api/*` behavior → API Gateway origin
  - `/auth/*` behavior → API Gateway origin
  - HTTPS only, TLS 1.2+
  - Security headers policy (CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy)
- API Gateway (HTTP API)
- Placeholder Lambda function for `/api/health` returning `{ status: "ok" }`
- Placeholder Lambda function for `/auth/callback` returning 200

**And** `npx sst deploy --stage prod` deploys all resources successfully
**And** the CloudFront URL serves the static Next.js build
**And** `GET /api/health` returns 200 through CloudFront
**And** all resources are tagged with `futurator:project=admin-hub`, `futurator:environment=production`, `futurator:managed-by=sst`

**Prerequisites:** Story 0.1

**Technical Notes:**

```bash
npx sst@latest init
```

Use SST's `StaticSite`, `Function`, and `ApiGatewayV2` constructs. CloudFront behaviors route `/api/*` and `/auth/*` to API Gateway, everything else to S3. Set custom domain `admin.futurator.ai` via Route 53.

---

### Story 0.4: DynamoDB Tables

As a developer,
I want all DynamoDB tables created and accessible,
So that the application has its data stores ready.

**Acceptance Criteria:**

**Given** the SST infrastructure from Story 0.3
**When** I add DynamoDB table definitions to `sst.config.ts`
**Then** the following tables are created:

| Table                       | Partition Key   | Sort Key          | Billing         |
| --------------------------- | --------------- | ----------------- | --------------- |
| `futurator-admin-projects`  | `projectId` (S) | —                 | PAY_PER_REQUEST |
| `futurator-admin-costs`     | `projectId` (S) | `date` (S)        | PAY_PER_REQUEST |
| `futurator-admin-resources` | `projectId` (S) | `resourceArn` (S) | PAY_PER_REQUEST |
| `futurator-admin-audits`    | `projectId` (S) | `auditDate` (S)   | PAY_PER_REQUEST |

**And** all tables have Point-in-Time Recovery enabled
**And** all tables are tagged with `futurator:project=admin-hub`
**And** Lambda functions have IAM permissions to read/write their respective tables
**And** `sst deploy` creates all tables successfully

**Prerequisites:** Story 0.3

**Technical Notes:**
Use SST `Dynamo` construct. Each table gets its own construct. Link tables to Lambda functions for IAM permissions. MVP 2 tables (`schedules`, `users`, `alerts`) will be added in later epics.

---

### Story 0.5: Hono API Router with Health Endpoint

As a developer,
I want a single Lambda function with Hono routing all API requests,
So that all backend endpoints share one cold start and one deployment unit.

**Acceptance Criteria:**

**Given** the Lambda function from Story 0.3
**When** I replace the placeholder with a Hono router
**Then** `functions/api/index.ts` implements:

- Hono app with AWS Lambda adapter
- `GET /api/health` returns `{ status: "ok", timestamp: "ISO-8601" }`
- CORS middleware configured for `admin.futurator.ai` (and `localhost:3000` in dev)
- Global error handler returning structured errors: `{ error: { code, message } }`
- 404 handler for unmatched routes
- Shared DynamoDB client in `functions/shared/dynamo-client.ts`
- Shared types in `functions/shared/types.ts`
- Shared error classes in `functions/shared/errors.ts`

**And** `GET /api/health` returns 200 via CloudFront
**And** `GET /api/nonexistent` returns 404 with structured error
**And** CORS headers are present in responses

**Prerequisites:** Story 0.3, 0.4

**Technical Notes:**
Install `hono` and `@hono/aws-lambda`. Use `handle` from `@hono/aws-lambda` as the Lambda handler. Keep bundle small (<5MB). Use `@aws-sdk/lib-dynamodb` with `DynamoDBDocumentClient`.

---

### Story 0.6: Identity Broker Registration & SSM Parameters

As an administrator,
I want the Admin Hub registered with the Identity Broker and secrets stored securely,
So that Google OAuth authentication is ready to integrate.

**Acceptance Criteria:**

**Given** the Identity Broker is running at `https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1`
**When** I register the Admin Hub app
**Then** the following is complete:

- App registered via `POST /apps/register` with:
  - `appId`: `futurator-admin`
  - `name`: `Futurator Admin Hub`
  - `type`: `web`
  - `baseUrl`: `https://admin.futurator.ai`
- `clientId` and `clientSecret` saved from response
- SSM Parameters created (SecureString):
  - `/futurator-admin/prod/IDENTITY_BROKER_URL`
  - `/futurator-admin/prod/IDENTITY_BROKER_APP_ID`
  - `/futurator-admin/prod/IDENTITY_BROKER_CLIENT_ID`
  - `/futurator-admin/prod/IDENTITY_BROKER_CLIENT_SECRET`
  - `/futurator-admin/prod/IDENTITY_BROKER_JWKS_URL`
- Auth Lambda has IAM permission to read these SSM parameters

**And** `GET /auth/oauth/providers?appId=futurator-admin` returns Google as configured
**And** SSM parameters are readable by the auth Lambda function

**Prerequisites:** Story 0.3

**Technical Notes:**
Use the registration script from the Identity Broker quick guide. Store `clientSecret` immediately — it's only shown once. Add SSM read permissions to the auth Lambda's IAM role in `sst.config.ts`.

---

### Story 0.7: Google OAuth Authentication Flow

As a user,
I want to sign in with my Google account,
So that I can access the Admin Hub securely.

**Acceptance Criteria:**

**Given** the Identity Broker registration from Story 0.6
**When** I implement the full OAuth flow
**Then:**

1. **Login page** (`src/app/login/page.tsx`):
   - Displays "Sign in with Google" button
   - Button redirects to `{BROKER_URL}/auth/oauth/google?appId=futurator-admin`

2. **Auth callback Lambda** (`functions/auth/callback.ts`):
   - Receives `?code=otp_xxx` from Identity Broker redirect
   - Reads `clientId` and `clientSecret` from SSM (cached in memory)
   - Calls `POST {BROKER_URL}/auth/oauth/exchange` with `{ code, clientId, clientSecret }`
   - On success: sets HTTP-only cookies:
     - `access_token` (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age=3600)
     - `refresh_token` (HttpOnly, Secure, SameSite=Strict, Path=/auth, Max-Age=604800)
   - Redirects (302) to `/`
   - On failure: redirects to `/login?error=auth_failed`

3. **Auth middleware** (`functions/shared/auth-middleware.ts`):
   - Reads `access_token` cookie from request
   - Validates JWT against JWKS endpoint (cached 1 hour)
   - If valid: attaches user claims to Hono context
   - If expired: returns 401
   - Applied to all `/api/*` routes except `/api/health`

4. **Auth guard** (`src/components/auth/auth-guard.tsx`):
   - Wraps protected pages
   - Checks auth state via `GET /api/auth/me` (returns user from JWT claims)
   - Redirects to `/login` if unauthenticated

5. **Logout** endpoint on Hono router:
   - `POST /api/auth/logout` clears both cookies, returns 200

**And** a user can sign in with Google and land on the home page authenticated
**And** refreshing the page maintains the session (cookies persist)
**And** accessing any page without auth redirects to `/login`
**And** `clientSecret` is never sent to the browser

**Prerequisites:** Story 0.5, 0.6

**Technical Notes:**
Use `jose` library for JWT validation (lighter than `jsonwebtoken` + `jwks-rsa`). Cache JWKS in Lambda module scope (persists across warm invocations). The auth callback Lambda is separate from the Hono API Lambda for security isolation (different IAM role — only auth Lambda reads SSM secrets).

---

### Story 0.8: App Shell & Layout

As a user,
I want a clean navigation layout with sidebar,
So that I can navigate between dashboard sections easily.

**Acceptance Criteria:**

**Given** authentication is working from Story 0.7
**When** I build the app shell
**Then** the layout includes:

- **Sidebar** (`src/components/layout/sidebar.tsx`):
  - Logo/title: "Futurator Admin"
  - Navigation links: Dashboard (home), Projects, Costs, Resources
  - Active state highlighting for current route
  - Collapsible on mobile (responsive)

- **Header** (`src/components/layout/header.tsx`):
  - User avatar/name from auth state
  - Logout button

- **App shell** (`src/components/layout/app-shell.tsx`):
  - Wraps all authenticated pages
  - Sidebar + header + main content area

- **Zustand stores**:
  - `auth-store.ts`: user object, isAuthenticated flag
  - `ui-store.ts`: sidebar collapsed state

- **TanStack Query setup** (`src/lib/query-client.ts`):
  - Default stale time: 5 minutes
  - Default retry: 1
  - Query client provider in root layout

- **API client** (`src/lib/api-client.ts`):
  - Fetch wrapper that includes credentials (cookies)
  - On 401 response: clear auth store, redirect to /login

**And** shadcn/ui components installed: `button`, `card`, `badge`, `tabs`, `table`, `dialog`, `dropdown-menu`, `separator`, `skeleton`
**And** the layout renders correctly on desktop and mobile
**And** navigation between pages works without full reload

**Prerequisites:** Story 0.7

**Technical Notes:**
Install shadcn/ui: `npx shadcn@latest init` then add components. Use Next.js `Link` for navigation. Zustand stores in `src/stores/`. TanStack Query provider wraps the app in `src/app/layout.tsx`.

---

### Story 0.9: Vitest Testing Setup

As a developer,
I want a testing framework configured and a baseline test passing,
So that I can write tests for all subsequent stories.

**Acceptance Criteria:**

**Given** the project from previous stories
**When** I configure Vitest
**Then:**

- `vitest.config.ts` configured with:
  - TypeScript support
  - Path aliases matching `tsconfig.json`
  - Test file pattern: `**/*.test.ts` and `**/*.test.tsx`
  - Coverage reporter (istanbul)
- `npm run test` script runs Vitest
- `npm run test:coverage` generates coverage report
- Baseline tests pass:
  - `tests/functions/api.test.ts`: health endpoint returns 200
  - `tests/components/login-button.test.tsx`: renders Google login button

**And** `npm run test` exits with 0

**Prerequisites:** Story 0.5, 0.8

**Technical Notes:**
Install `vitest`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. Mock DynamoDB client and fetch for Lambda tests.

---

### Story 0.10: CI Pipeline Script

As a developer,
I want a single command that runs all quality checks,
So that I can validate before deploying.

**Acceptance Criteria:**

**Given** all dev tooling from Story 0.2 and testing from Story 0.9
**When** I create the CI script
**Then** `npm run ci` runs in sequence:

1. `npm run lint` (ESLint)
2. `npm run format:check` (Prettier)
3. `npm run knip` (dead code)
4. `npm run typecheck` (TypeScript)
5. `npm run test` (Vitest)
6. `npm run build` (Next.js static export)

**And** the script exits with non-zero code if any step fails
**And** all steps currently pass

**Prerequisites:** Story 0.2, 0.9

**Technical Notes:**
Add to `package.json` scripts: `"ci": "npm run lint && npm run format:check && npm run knip && npm run typecheck && npm run test && npm run build"`. This can later be called by GitHub Actions or CodeBuild.

---

## Epic 1: AWS Tagging Foundation

**Goal:** Every AWS resource across all Futurator projects is tagged consistently, enabling cost allocation and resource discovery by the Admin Hub.

**Value:** Without tags, Cost Explorer cannot allocate costs per project. This is the critical prerequisite for Epics 3 and 4.

---

### Story 1.1: Tag Audit Script

As an administrator,
I want to scan all AWS resources and see which are missing mandatory tags,
So that I know the scope of the tagging work needed.

**Acceptance Criteria:**

**Given** AWS credentials with read access to Resource Groups Tagging API
**When** I run the tag audit script
**Then** `scripts/tag-audit.ts` produces:

- Scans all resources in us-east-1 (and eu-central-1 if any exist)
- For each resource, checks for mandatory tags: `futurator:project`, `futurator:environment`, `futurator:service-role`, `futurator:managed-by`
- Outputs a JSON report to stdout with:
  - Total resources scanned
  - Compliant count / Non-compliant count / Compliance percentage
  - Per-resource detail: ARN, existing tags, missing tags
- Groups results by project (if `futurator:project` tag exists) or "untagged"

**And** the script runs via `npx tsx scripts/tag-audit.ts`
**And** output is valid JSON parseable by `jq`

**Prerequisites:** Story 0.3 (AWS credentials configured)

**Technical Notes:**
Use `@aws-sdk/client-resource-groups-tagging-api` `GetResources` with pagination. Call for both regions. Match resources to projects using existing naming patterns (e.g., `evidencegraph` → `mbe`).

---

### Story 1.2: Bulk Retroactive Tagging

As an administrator,
I want to apply mandatory tags to all existing untagged resources,
So that Cost Explorer can allocate costs per project.

**Acceptance Criteria:**

**Given** the tag audit report from Story 1.1
**When** I run the bulk tagging script
**Then** `scripts/bulk-tag.ts`:

- Reads a project-to-resource mapping configuration (JSON file mapping resource name patterns to project IDs)
- For each untagged resource, applies:
  - `futurator:project` = mapped project ID
  - `futurator:environment` = `production` (default) or `staging`
  - `futurator:service-role` = inferred from resource type (e.g., DynamoDB → `storage`, Lambda → `compute`)
  - `futurator:managed-by` = `manual` (for retroactively tagged resources)
- Outputs count of resources tagged per project
- Dry-run mode (`--dry-run`) that shows what would be tagged without making changes

**And** running tag-audit after bulk-tag shows improved compliance
**And** dry-run mode makes no AWS API write calls

**Prerequisites:** Story 1.1

**Technical Notes:**
Use `@aws-sdk/client-resource-groups-tagging-api` `TagResources`. Create `scripts/tag-mapping.json` with patterns like `{ "evidencegraph": "mbe", "applicator": "applicator" }`. Respect API rate limits.

---

### Story 1.3: Activate Cost Allocation Tags

As an administrator,
I want cost allocation tags activated in AWS Billing,
So that Cost Explorer can group costs by project.

**Acceptance Criteria:**

**Given** resources are tagged from Story 1.2
**When** I activate cost allocation tags
**Then:**

- `futurator:project` is activated as a cost allocation tag in AWS Billing console
- `futurator:environment` is activated as a cost allocation tag
- `futurator:cost-center` is activated as a cost allocation tag
- A note is added to `docs/concepts/` documenting:
  - Which tags were activated and when
  - The 24-hour propagation delay before tags appear in Cost Explorer data

**And** after 24 hours, Cost Explorer shows cost data grouped by `futurator:project`

**Prerequisites:** Story 1.2

**Technical Notes:**
This is a manual step in the AWS Billing console (Billing → Cost Allocation Tags → Activate). Cannot be automated via API. Document the process for future reference.

---

### Story 1.4: Tag Compliance API Endpoint

As a user,
I want to see tag compliance scores per project on the dashboard,
So that I know which projects need tagging attention.

**Acceptance Criteria:**

**Given** the tag auditor cron Lambda runs daily
**When** I add the tag compliance endpoint and cron job
**Then:**

- `functions/cron/tag-auditor.ts`:
  - Runs daily at 07:30 UTC via EventBridge
  - Scans all resources using Tagging API
  - Calculates compliance percentage per project
  - Stores results in `futurator-admin-audits` table (PK=projectId, SK=YYYY-MM-DD)

- `GET /api/tags/compliance` on Hono router:
  - Returns latest audit results per project
  - Response: `[{ projectId, tagComplianceScore, totalResources, compliantResources, auditDate }]`

**And** cron job runs successfully and stores data
**And** API returns accurate compliance data

**Prerequisites:** Story 0.5, 0.4, Story 1.1

**Technical Notes:**
Add EventBridge cron rule in `sst.config.ts`. Separate IAM role for tag-auditor Lambda with Tagging API read + DynamoDB write (audits table only).

---

## Epic 2: Project Registry

**Goal:** Single source of truth for all Futurator projects — metadata, features, status, and clients — browsable on the dashboard.

**Value:** Foundation for all project-centric views (costs, resources, users, alerts are all per-project).

---

### Story 2.1: Project Data Model & Repository

As a developer,
I want TypeScript types and a DynamoDB repository for projects,
So that all project data access follows consistent patterns.

**Acceptance Criteria:**

**Given** the `futurator-admin-projects` DynamoDB table from Story 0.4
**When** I create the data model and repository
**Then:**

- `src/types/project.ts` defines: `Project`, `Feature`, `ProjectCategory`, `ProjectStatus`
- `functions/shared/types.ts` includes the same types (shared between frontend and backend)
- `functions/shared/repositories/project-repository.ts` implements:
  - `getAll(): Promise<Project[]>`
  - `getById(projectId: string): Promise<Project | null>`
  - `update(projectId: string, updates: Partial<Project>): Promise<Project>`
  - `create(project: Project): Promise<Project>`
- All methods use DynamoDB DocumentClient
- Input validated with zod schemas

**And** repository methods are unit tested

**Prerequisites:** Story 0.4, 0.5

**Technical Notes:**
Keep repository thin — direct DynamoDB operations, no ORM. Zod schemas in `functions/shared/schemas/project-schema.ts`.

---

### Story 2.2: Seed All Projects

As an administrator,
I want all 11 Futurator projects pre-loaded in the database,
So that the dashboard shows real project data from day one.

**Acceptance Criteria:**

**Given** the project repository from Story 2.1
**When** I run the seed script
**Then** `scripts/seed-projects.ts` inserts these projects:

| projectId       | name                | status      | category              |
| --------------- | ------------------- | ----------- | --------------------- |
| contento        | Contento            | beta        | independent-companies |
| sellebra        | Sellebra            | planning    | independent-companies |
| mbe             | MBE                 | in-progress | joint-venture         |
| applicator      | MyApplicator        | beta        | personal              |
| gomad           | GoMAD / Debatator   | beta        | personal              |
| atlassinator    | Atlassinator        | beta        | personal              |
| dasher          | Dasher              | in-progress | personal              |
| songster        | Songster            | in-progress | personal              |
| mycelium        | Mycelium            | in-progress | personal              |
| admin-hub       | Futurator Admin Hub | in-progress | personal              |
| identity-broker | Identity Broker     | active      | shared-infra          |

- Each project includes: brief, features list, awsServices array (from brainstorm Section 3.3)
- Script is idempotent (re-running doesn't duplicate data)

**And** `GET /api/projects` returns all 11 projects

**Prerequisites:** Story 2.1

**Technical Notes:**
Data sourced from brainstorm doc Section 3 (Project Portfolio Overview) and the AWS Service × Project Matrix.

---

### Story 2.3: Project API Endpoints

As a developer,
I want REST endpoints for project CRUD,
So that the frontend can list, view, and update projects.

**Acceptance Criteria:**

**Given** the project repository from Story 2.1
**When** I add project routes to the Hono router
**Then:**

- `GET /api/projects` — returns all projects (array)
- `GET /api/projects/:id` — returns single project or 404
- `PUT /api/projects/:id` — updates project metadata (zod validated), returns updated project
- All endpoints require auth (JWT middleware)
- All endpoints return structured errors on failure

**And** endpoints are tested with Vitest (mock DynamoDB)

**Prerequisites:** Story 2.1, 0.7 (auth middleware)

**Technical Notes:**
Add routes to `functions/api/index.ts` Hono app. Use project repository. Zod validation on PUT body.

---

### Story 2.4: Project Registry Dashboard

As a user,
I want to see all my projects as cards on the home page,
So that I get an instant overview of my portfolio.

**Acceptance Criteria:**

**Given** the project API from Story 2.3
**When** I build the dashboard page
**Then** `src/app/page.tsx` (home) displays:

- Grid of project cards (responsive: 3 columns desktop, 2 tablet, 1 mobile)
- Each card shows:
  - Project name and status badge (color-coded: green=active, yellow=beta, blue=in-progress, gray=planning)
  - Category tag
  - Brief description (truncated to 2 lines)
  - AWS services as small icons/badges
- Loading skeleton while data fetches
- Error state if API fails
- TanStack Query hook: `useProjects()` in `src/hooks/use-projects.ts`

**And** all 11 projects display correctly
**And** the page works without JavaScript (static HTML renders first, data hydrates client-side)

**Prerequisites:** Story 0.8 (app shell), Story 2.3

**Technical Notes:**
Use shadcn/ui `Card`, `Badge`. TanStack Query with 5-minute stale time (project data changes rarely).

---

### Story 2.5: Project Detail Page

As a user,
I want to click into a project and see its full details,
So that I can understand each project's scope and configuration.

**Acceptance Criteria:**

**Given** the project API and dashboard from Stories 2.3 and 2.4
**When** I build the project detail page
**Then** `src/app/projects/[id]/page.tsx` displays:

- **Overview tab** (default):
  - Project name, status, category
  - Full brief/description
  - Team members
  - AWS services used (badges)
  - Created/updated dates

- **Features tab**:
  - Feature list with name, status badge, associated AWS services
  - Feature count in tab label

- Placeholder tabs for: **Costs**, **Resources** (populated by Epics 3 and 4)

- Breadcrumb navigation: Dashboard → Project Name
- Back button to dashboard
- Loading and error states

**And** navigating from project card opens the correct project
**And** tab switching doesn't trigger API re-fetch (data is shared)

**Prerequisites:** Story 2.4

**Technical Notes:**
Use shadcn/ui `Tabs`. TanStack Query fetches project detail via `useProject(id)`. Placeholder tabs render "Coming soon" until Epics 3/4.

---

## Epic 3: AWS Cost Dashboard

**Goal:** Real-time cost visibility per project with daily trends, forecasts, and anomaly detection — the primary value proposition of the Admin Hub.

**Value:** See what every project costs, catch spikes before the bill arrives.

---

### Story 3.1: Cost Aggregation Lambda

As a system,
I want daily cost data pulled from AWS Cost Explorer and stored in DynamoDB,
So that the dashboard can serve cost data fast without calling Cost Explorer on every request.

**Acceptance Criteria:**

**Given** cost allocation tags are active (Story 1.3) and the costs table exists (Story 0.4)
**When** the cost aggregation Lambda runs
**Then** `functions/cron/cost-aggregator.ts`:

- Runs daily at 06:00 UTC via EventBridge cron
- Calls Cost Explorer API (us-east-1 region, cross-region call):
  - `GetCostAndUsage` grouped by `futurator:project` + `SERVICE` for last 90 days
  - `GetCostForecast` for next 30 days per project
  - `GetAnomalies` for last 7 days
- Stores daily cost records in `futurator-admin-costs` table:
  - PK=projectId, SK=YYYY-MM-DD
  - Breakdown by AWS service, total amount, currency
- Stores portfolio totals: PK=`PORTFOLIO`, SK=YYYY-MM-DD
- Stores forecast data alongside current month record
- Stores anomalies as list on the relevant project+date record
- Logs structured JSON: projects processed, total cost, anomaly count, duration

**And** Lambda completes within 30 seconds
**And** costs table contains data after first run
**And** re-running is idempotent (overwrites same date records)

**Prerequisites:** Story 0.4, 1.3

**Technical Notes:**
IAM role needs `ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:GetAnomalies` (us-east-1) + DynamoDB write (costs table). Use `@aws-sdk/client-cost-explorer`. Lambda memory: 512MB. Note: Cost Explorer has 24h data delay.

---

### Story 3.2: Cost API Endpoints

As a developer,
I want API endpoints serving cost data from DynamoDB,
So that the frontend can display cost dashboards.

**Acceptance Criteria:**

**Given** cost data in DynamoDB from Story 3.1
**When** I add cost routes to the Hono router
**Then:**

- `GET /api/costs/overview` — portfolio summary:
  - Total monthly cost, project ranking (sorted by cost desc), top services, month-over-month change
- `GET /api/projects/:id/costs?range=30d|60d|90d` — per-project:
  - Daily cost records for the range, breakdown by service, forecast, anomalies, budget status
- `GET /api/costs/forecast` — 30-day forecast per project and portfolio total
- All endpoints require auth, return structured errors

**And** endpoints return correct data matching DynamoDB records
**And** query parameter validation with zod (range must be 30d, 60d, or 90d)

**Prerequisites:** Story 3.1, 0.5

**Technical Notes:**
Read from `futurator-admin-costs` table. Use DynamoDB Query with PK + SK range for date filtering. Calculate month-over-month from stored daily data.

---

### Story 3.3: Portfolio Cost Dashboard UI

As a user,
I want to see my total AWS spend across all projects in one view,
So that I understand my portfolio cost at a glance.

**Acceptance Criteria:**

**Given** cost API endpoints from Story 3.2
**When** I build the portfolio cost dashboard
**Then** `src/app/costs/page.tsx` displays:

- **Total monthly cost** (large number, prominently displayed)
- **Month-over-month change** (percentage, green if down, red if up)
- **Project ranking** (horizontal bar chart, Recharts, sorted by cost descending)
- **Service breakdown** (pie chart, Recharts, top AWS services by cost)
- **Date range selector** (30d / 60d / 90d toggle)
- **Cost trend line** (daily cost line chart for selected range)
- Loading skeletons for all charts while data fetches
- TanStack Query hooks: `useCostOverview()`, `useCostTrend(range)`

**And** charts render correctly with real or seeded data
**And** switching date range re-fetches and updates charts
**And** sidebar navigation highlights "Costs" as active

**Prerequisites:** Story 3.2, 0.8

**Technical Notes:**
Use Recharts `BarChart`, `PieChart`, `LineChart`. Dynamic import Recharts to reduce initial bundle. Chart components in `src/components/charts/`.

---

### Story 3.4: Per-Project Cost View

As a user,
I want to see cost details for a specific project,
So that I can understand where that project's money goes.

**Acceptance Criteria:**

**Given** the cost API and project detail page from Stories 3.2 and 2.5
**When** I populate the Costs tab on the project detail page
**Then** the project Costs tab displays:

- **Monthly cost** (current month total)
- **Service breakdown pie chart** (cost per AWS service for this project)
- **Daily cost trend line chart** (30/60/90 day toggle)
- **Cost forecast bar** (projected end-of-month cost with confidence indicator)
- **Top 5 most expensive services** (list with amounts)
- TanStack Query hook: `useProjectCosts(projectId, range)`

**And** cost data matches the project's `futurator:project` tag
**And** date range toggle updates the chart

**Prerequisites:** Story 2.5, 3.2

**Technical Notes:**
Reuse chart components from Story 3.3 with different data props. Add to the existing project detail page Costs tab.

---

### Story 3.5: Cost Anomaly Detection Display

As a user,
I want to see cost anomalies highlighted on the dashboard,
So that I catch unexpected spending immediately.

**Acceptance Criteria:**

**Given** anomaly data stored by the cost aggregation Lambda (Story 3.1)
**When** I display anomalies on the UI
**Then:**

- **Project cards** (home page) show an orange warning badge if project has recent anomalies
- **Portfolio cost page** shows anomaly alerts at the top (dismissible)
- **Per-project cost tab** shows anomaly detail: which service spiked, expected vs actual amount, severity
- Anomaly format: `{ service, amount, expectedAmount, severity: "low"|"medium"|"high" }`

**And** anomalies are visually distinct (warning colors, icons)
**And** projects with no anomalies show no badge

**Prerequisites:** Story 3.3, 3.4

**Technical Notes:**
Anomaly data comes from Cost Explorer `GetAnomalies` API stored in the costs table. Filter for last 7 days.

---

### Story 3.6: Budget Setup & Tracking

As a user,
I want to set budget limits per project and see utilisation,
So that I know when projects approach their spending limits.

**Acceptance Criteria:**

**Given** cost data in DynamoDB
**When** I add budget functionality
**Then:**

- `PUT /api/projects/:id/budget` — set budget: `{ monthlyLimit: number }`
  - Stores in projects table as `budget` attribute
- Budget data included in cost API responses
- **Project cards** show budget progress bar (green < 80%, yellow 80-100%, red > 100%)
- **Per-project cost tab** shows budget utilisation: limit, used, percentage, progress bar
- Optional: call AWS Budgets API to create corresponding AWS budget

**And** budget progress bar accurately reflects current month spend vs limit
**And** projects without budgets show no progress bar

**Prerequisites:** Story 3.4, 2.3

**Technical Notes:**
Budget is a simple attribute on the project record. No separate table needed. AWS Budgets API call is optional enhancement.

---

## Epic 4: AWS Resource Map

**Goal:** Per-project inventory of all AWS resources with tag compliance tracking and basic consistency checks.

**Value:** Know exactly what resources exist, find untagged/misconfigured resources, prevent sprawl.

---

### Story 4.1: Resource Discovery Lambda

As a system,
I want daily discovery of all AWS resources mapped to projects,
So that the dashboard shows an up-to-date resource inventory.

**Acceptance Criteria:**

**Given** tagged resources (Epic 1) and resources table (Story 0.4)
**When** the resource discovery Lambda runs
**Then** `functions/cron/resource-discoverer.ts`:

- Runs daily at 07:00 UTC via EventBridge cron
- Discovers resources in us-east-1 (and eu-central-1 if any exist):
  - Resource Groups Tagging API: all resources with `futurator:project` tag
  - DynamoDB: `ListTables` + `DescribeTable` for each
  - S3: `ListBuckets` + `GetBucketTagging` for each
  - Lambda: `ListFunctions` + `GetFunctionConfiguration` for each
  - ECS: `DescribeClusters` + `DescribeServices` + `ListTasks`
  - ECR: `DescribeRepositories` + `ListImages`
- Stores each resource in `futurator-admin-resources` table:
  - PK=projectId, SK=resourceArn
  - Attributes: serviceType, resourceName, region, tags, config (key values), tagCompliant, discoveredAt
- Calculates tag compliance per resource (has all 4 mandatory tags)

**And** Lambda completes within 60 seconds
**And** resources table is populated after first run

**Prerequisites:** Story 0.4, 1.1

**Technical Notes:**
IAM role needs read-only access to: Tagging API, DynamoDB describe, S3 list/get-tagging, Lambda list/get, ECS describe, ECR describe. Separate IAM role from cost Lambda. Memory: 512MB.

---

### Story 4.2: Resource API Endpoints

As a developer,
I want API endpoints serving resource inventory data,
So that the frontend can display resource maps.

**Acceptance Criteria:**

**Given** resource data in DynamoDB from Story 4.1
**When** I add resource routes to the Hono router
**Then:**

- `GET /api/projects/:id/resources` — per-project resources:
  - Grouped by serviceType, sorted alphabetically
  - Each resource: name, ARN, type, region, tagCompliant, key config values
- `GET /api/resources/summary` — global summary:
  - Total resources per service type across all projects
  - Overall tag compliance percentage
- All endpoints require auth

**And** endpoints return correct data

**Prerequisites:** Story 4.1, 0.5

**Technical Notes:**
Query resources table with PK=projectId for per-project. For summary, scan or query all projects.

---

### Story 4.3: Resource Map UI

As a user,
I want to browse AWS resources per project and globally,
So that I can see exactly what's deployed and where.

**Acceptance Criteria:**

**Given** resource API endpoints from Story 4.2
**When** I build the resource map UI
**Then:**

- **Resources page** (`src/app/resources/page.tsx`):
  - Global resource summary: total count, count per service type, overall tag compliance
  - Per-project breakdown (expandable sections)

- **Project detail Resources tab** (populates placeholder from Story 2.5):
  - Resources grouped by service type (Compute, Storage, Database, etc.)
  - Each resource shows: name, type, region, tag compliance badge (green/red)
  - Expandable to show full tags and config values
  - Resource count in tab label

- TanStack Query hooks: `useProjectResources(projectId)`, `useResourceSummary()`

**And** tag compliance badges correctly reflect tag status
**And** resources grouped logically by service type

**Prerequisites:** Story 2.5, 4.2

**Technical Notes:**
Use shadcn/ui `Table` with expandable rows. Group by `serviceType` field from API response.

---

### Story 4.4: Basic Consistency Audit

As a user,
I want to see consistency issues across projects,
So that I can identify misconfigured or drifting resources.

**Acceptance Criteria:**

**Given** resource data from Story 4.1
**When** the tag auditor Lambda (Story 1.4) is extended with consistency checks
**Then** the daily audit also checks:

- Lambda runtime version consistency (all should match)
- DynamoDB billing mode consistency (all should be PAY_PER_REQUEST)
- S3 encryption enabled on all buckets
- S3 public access blocked on all buckets
- CloudWatch log groups have retention policies (not infinite)
- Security groups: flag any with 0.0.0.0/0 on non-HTTP ports

- Results stored in `futurator-admin-audits` table alongside tag compliance
- `GET /api/tags/compliance` extended to include consistency issues
- Project detail shows audit issues count on Overview tab

**And** consistency issues display with severity (Critical, Warning, Info)

**Prerequisites:** Story 1.4, 4.1

**Technical Notes:**
Extend the existing tag-auditor cron Lambda. Add per-service checks using the same AWS SDK clients from resource-discoverer. Store issues as list in audit record.

---

## Epic 5: Multi-Provider Cost Aggregation (MVP 2)

**Goal:** Aggregate costs from Google Cloud, API providers, and manual entries into the unified cost dashboard.

**Value:** See total spend across ALL providers, not just AWS.

---

### Story 5.1: Cost Provider Abstraction Layer

As a developer,
I want a common interface for cost data providers,
So that adding new providers follows a consistent pattern.

**Acceptance Criteria:**

**Given** the existing AWS cost aggregation from Epic 3
**When** I create the provider abstraction
**Then:**

- `functions/shared/cost-provider.ts` defines:
  ```typescript
  interface CostProvider {
    name: string;
    fetchCosts(startDate: string, endDate: string): Promise<CostRecord[]>;
  }
  interface CostRecord {
    provider: string;
    projectId: string;
    service: string;
    date: string;
    amount: number;
    currency: string;
  }
  ```
- Existing AWS cost aggregator refactored to implement `CostProvider`
- Cost records in DynamoDB now include `provider` field
- Cost API endpoints support `?provider=aws|all` query parameter

**And** existing AWS cost functionality still works after refactor

**Prerequisites:** Story 3.1, 3.2

**Technical Notes:**
This is a refactor of existing code. The `provider` field on cost records enables filtering.

---

### Story 5.2: Google Cloud Cost Integration

As a user,
I want to see Google Cloud costs alongside AWS costs,
So that I have a complete picture of cloud spending.

**Acceptance Criteria:**

**Given** the cost provider interface from Story 5.1
**When** I implement the GCP cost adapter
**Then:**

- `functions/cron/cost-gcp.ts` implements `CostProvider`:
  - Reads GCP billing data from BigQuery billing export
  - Maps GCP projects to Futurator project IDs
  - Runs daily via EventBridge
  - Stores cost records with `provider: "gcp"`
- GCP service account credentials stored in SSM Parameter Store

**And** GCP costs appear in the unified cost dashboard
**And** portfolio total includes both AWS and GCP costs

**Prerequisites:** Story 5.1

**Technical Notes:**
Requires GCP service account with BigQuery read + Billing Viewer roles. Use `@google-cloud/bigquery` SDK. If no GCP billing export exists yet, document setup steps.

---

### Story 5.3: API Provider Cost Integrations

As a user,
I want to see third-party API costs (Anthropic, ElevenLabs, etc.),
So that I track all AI/API spending in one place.

**Acceptance Criteria:**

**Given** the cost provider interface from Story 5.1
**When** I implement API provider adapters
**Then** `functions/cron/cost-providers.ts` implements adapters for:

- **Anthropic**: usage API (if available) or manual entry fallback
- **ElevenLabs**: `/usage` API endpoint
- **OpenAI**: `/usage` API endpoint (if used)
- **GitHub Actions**: billing API for Actions minutes

- Each adapter runs daily, stores with appropriate `provider` value
- API keys stored in SSM Parameter Store
- If a provider API is unavailable, logs warning and skips (doesn't fail entire job)

**And** provider costs appear in unified dashboard
**And** failure of one provider doesn't block others

**Prerequisites:** Story 5.1

**Technical Notes:**
Each provider may have different API formats and auth. Some may not have usage APIs — document which require manual entry.

---

### Story 5.4: Manual Cost Entry

As a user,
I want to enter non-API costs manually (domains, licenses, contractors),
So that my total cost view includes everything.

**Acceptance Criteria:**

**Given** the cost records in DynamoDB
**When** I add manual cost entry
**Then:**

- `POST /api/costs/manual` — create manual entry: `{ projectId, service, amount, date, description }`
- `GET /api/costs/manual` — list manual entries
- `DELETE /api/costs/manual/:id` — delete entry
- Manual entries stored with `provider: "manual"`
- UI form accessible from cost dashboard:
  - Select project, enter service name, amount, date, description
  - Validation: amount > 0, date is valid, projectId exists

**And** manual costs appear in total portfolio cost
**And** manual entries are distinguishable in the dashboard (different styling/icon)

**Prerequisites:** Story 5.1, 3.3

**Technical Notes:**
Manual entries go in the same costs table with `provider: "manual"`. Add a generated ID as additional attribute to support DELETE.

---

### Story 5.5: Unified Multi-Provider Dashboard

As a user,
I want to see costs from all providers in one unified view,
So that I understand total spending across everything.

**Acceptance Criteria:**

**Given** all cost provider data (AWS, GCP, API providers, manual)
**When** I extend the cost dashboard
**Then:**

- **Provider toggle** on portfolio cost page: AWS Only | All Providers
- **Provider breakdown pie chart** (new): cost by provider (AWS, GCP, Anthropic, etc.)
- **Total includes all providers** when "All Providers" selected
- **Per-project cost view** extended to show costs per provider
- Project cards show total cost including all providers

**And** toggling between AWS-only and All Providers updates all charts
**And** provider breakdown correctly sums to total

**Prerequisites:** Story 5.2, 5.3, 5.4, 3.3

**Technical Notes:**
Extend existing TanStack Query hooks with `provider` filter parameter. Reuse existing chart components with additional data series.

---

## Epic 6: Resource Scheduler (MVP 2)

**Goal:** Schedule start/stop of EC2 instances and ECS tasks to save costs during off-hours.

**Value:** Direct cost savings — EC2 instances stopped at night save ~66% of their monthly cost.

---

### Story 6.1: Schedule Data Model & CRUD API

As a developer,
I want a data model and API for resource schedules,
So that the scheduler UI can create and manage schedules.

**Acceptance Criteria:**

**Given** a new `futurator-admin-schedules` DynamoDB table
**When** I implement the schedule API
**Then:**

- Table added to `sst.config.ts`: PK=`scheduleId` (S), PAY_PER_REQUEST
- `functions/shared/repositories/schedule-repository.ts` with CRUD
- Hono routes:
  - `GET /api/schedules` — list all schedules
  - `POST /api/schedules` — create schedule (zod validated)
  - `PUT /api/schedules/:id` — update schedule
  - `DELETE /api/schedules/:id` — delete schedule
- Schedule fields: scheduleId, resourceType (ec2|ecs), resourceId, projectId, action (start|stop), cronExpression, timezone, enabled, createdAt

**And** CRUD operations work correctly
**And** invalid cron expressions are rejected by validation

**Prerequisites:** Story 0.5

**Technical Notes:**
Use `cron-parser` library for cron expression validation. Generate scheduleId with `crypto.randomUUID()`.

---

### Story 6.2: EventBridge Scheduler Integration

As a system,
I want schedules to create corresponding EventBridge Scheduler rules,
So that start/stop actions execute automatically on schedule.

**Acceptance Criteria:**

**Given** schedule CRUD from Story 6.1
**When** I integrate with EventBridge Scheduler
**Then:**

- Creating a schedule → creates an EventBridge Scheduler rule targeting the action Lambda
- Updating a schedule → updates the corresponding rule
- Deleting a schedule → deletes the corresponding rule
- Disabling a schedule → disables the rule (not deleted)
- Rule names: `futurator-admin-{scheduleId}`
- Rules target a new `functions/cron/schedule-executor.ts` Lambda

**And** EventBridge rules are created/updated/deleted in sync with DynamoDB records
**And** disabled schedules don't trigger

**Prerequisites:** Story 6.1

**Technical Notes:**
Use `@aws-sdk/client-scheduler`. IAM role needs `scheduler:CreateSchedule`, `scheduler:UpdateSchedule`, `scheduler:DeleteSchedule`. The executor Lambda needs EC2 and ECS permissions.

---

### Story 6.3: EC2 Start/Stop Actions

As a user,
I want to automatically start/stop EC2 instances on a schedule,
So that I save money on instances that don't need to run 24/7.

**Acceptance Criteria:**

**Given** EventBridge triggers from Story 6.2
**When** the schedule executor Lambda receives an EC2 action
**Then:**

- `start` action: calls `ec2:StartInstances` for the specified instance ID
- `stop` action: calls `ec2:StopInstances` for the specified instance ID
- Validates instance has `futurator:project` tag (safety check — won't act on untagged resources)
- Logs action with: scheduleId, instanceId, action, result, timestamp
- Stores execution record in schedules table (last execution time, result)

**And** instances start/stop successfully
**And** untagged instances are rejected with an error log

**Prerequisites:** Story 6.2

**Technical Notes:**
IAM role: `ec2:StartInstances`, `ec2:StopInstances`, `ec2:DescribeInstances` scoped to resources with `futurator:project` tag via IAM condition.

---

### Story 6.4: ECS Task Start/Stop Actions

As a user,
I want to automatically start/stop ECS Fargate tasks on a schedule,
So that I save money on tasks that don't need to run 24/7.

**Acceptance Criteria:**

**Given** EventBridge triggers from Story 6.2
**When** the schedule executor Lambda receives an ECS action
**Then:**

- `start` action:
  - Calls `ecs:RunTask` with the specified task family and cluster
  - Waits for task to reach RUNNING state
  - Gets task public IP
  - Updates Route 53 A record for the task's domain
- `stop` action:
  - Calls `ecs:StopTask` for the running task
- Validates task definition has `futurator:project` tag
- Logs action with: scheduleId, taskFamily, action, result, timestamp

**And** tasks start/stop successfully
**And** Route 53 DNS is updated on start (following existing deploy playbook pattern)

**Prerequisites:** Story 6.2

**Technical Notes:**
IAM role: `ecs:RunTask`, `ecs:StopTask`, `ecs:DescribeTasks`, `route53:ChangeResourceRecordSets`. Reuse deploy script logic for Route 53 update.

---

### Story 6.5: Scheduler Dashboard UI

As a user,
I want to view and manage resource schedules from the dashboard,
So that I can control start/stop times visually.

**Acceptance Criteria:**

**Given** schedule API from Story 6.1
**When** I build the scheduler dashboard
**Then** `src/app/schedules/page.tsx` displays:

- **Schedule list**: table of all schedules with: resource name, project, action, cron expression (human-readable), next execution time, enabled toggle, edit/delete buttons
- **Create schedule form** (dialog):
  - Select resource type (EC2 / ECS)
  - Select resource (from discovered resources)
  - Select action (start / stop)
  - Cron expression builder (presets: weekday mornings, weekday evenings, custom)
  - Timezone selector
  - Preview: "Runs at 08:00 CET on weekdays"
- **Estimated savings**: display monthly cost savings based on scheduled off-hours
- Navigation: add "Schedules" to sidebar

**And** creating a schedule shows it in the list immediately
**And** toggling enabled/disabled updates the schedule
**And** delete confirms before removing

**Prerequisites:** Story 6.1, 0.8

**Technical Notes:**
Use `cronstrue` library for human-readable cron descriptions. Savings estimate = hourly resource cost × scheduled off-hours per month.

---

## Epic 7: Identity Dashboard (MVP 2)

**Goal:** View users across all Futurator projects via the Identity Broker's Cognito user pool.

**Value:** Know who's using what, track adoption, manage access.

---

### Story 7.1: Cognito User Sync Lambda

As a system,
I want daily user data synced from Cognito into the Admin Hub,
So that user information is available without calling Cognito on every request.

**Acceptance Criteria:**

**Given** a new `futurator-admin-users` DynamoDB table
**When** the user sync Lambda runs
**Then:**

- Table added to `sst.config.ts`: PK=`userId` (S), PAY_PER_REQUEST
- `functions/cron/user-sync.ts`:
  - Runs daily at 08:00 UTC via EventBridge
  - Calls Cognito Admin API `ListUsers` (Identity Broker user pool: `us-east-1_djPwzFjUe`)
  - For each user, stores: userId, email, name, projects (from token claims or user attributes), lastLogin, syncedAt
  - Handles pagination (Cognito returns max 60 users per call)

**And** users table is populated after first run
**And** Lambda completes within 30 seconds

**Prerequisites:** Story 0.4

**Technical Notes:**
IAM role: `cognito-idp:ListUsers`, `cognito-idp:AdminGetUser` on the Identity Broker's user pool. Cross-region call to us-east-1. Use `@aws-sdk/client-cognito-identity-provider`.

---

### Story 7.2: User Directory API & UI

As a user,
I want to browse all users across projects,
So that I can see who has access to what.

**Acceptance Criteria:**

**Given** user data from Story 7.1
**When** I build the user directory
**Then:**

- `GET /api/users` — list all users, supports `?projectId=xxx` filter
- `GET /api/users/:id` — user detail with project access list
- **Users page** (`src/app/users/page.tsx`):
  - User table: name, email, projects (badges), last login
  - Filter by project (dropdown)
  - Search by name or email
- Navigation: add "Users" to sidebar

**And** user list displays correctly
**And** project filter narrows the list

**Prerequisites:** Story 7.1, 0.8

**Technical Notes:**
Use shadcn/ui `Table` with search input. TanStack Query hook: `useUsers(projectId?)`.

---

### Story 7.3: Per-Project User Counts

As a user,
I want to see active user counts on project cards,
So that I can gauge adoption at a glance.

**Acceptance Criteria:**

**Given** user data from Story 7.1
**When** I add user counts to the project views
**Then:**

- `GET /api/projects/:id` response extended with `userCount` field
- Project cards (home page) show user count badge
- Project detail Overview tab shows user count
- Count reflects users who have that project in their access list

**And** projects with 0 users show no badge (clean UI)

**Prerequisites:** Story 7.2, 2.4

**Technical Notes:**
Calculate user count per project during user sync Lambda (store as aggregated value). Or compute on-the-fly from users table scan (fine at small scale).

---

## Epic 8: Alert Management (MVP 2)

**Goal:** Centralised view of CloudWatch alarms, budget breaches, and cost anomalies with notification routing.

**Value:** Catch problems before they become expensive — proactive monitoring across all projects.

---

### Story 8.1: CloudWatch Alarm Discovery

As a system,
I want all CloudWatch alarms across projects discovered and stored,
So that the dashboard shows alarm states.

**Acceptance Criteria:**

**Given** a new `futurator-admin-alerts` DynamoDB table
**When** the alarm discovery runs
**Then:**

- Table added to `sst.config.ts`: PK=`alertId` (S), SK=`timestamp` (S), PAY_PER_REQUEST
- Extend resource-discoverer Lambda (Story 4.1) to also scan CloudWatch alarms:
  - `cloudwatch:DescribeAlarms` across both regions
  - Maps alarms to projects via tags or naming patterns
  - Stores: alarmName, projectId, state (OK/ALARM/INSUFFICIENT_DATA), metricName, threshold, region

**And** alarm data is stored in alerts table
**And** alarms are mapped to correct projects

**Prerequisites:** Story 4.1

**Technical Notes:**
Add `cloudwatch:DescribeAlarms` to resource-discoverer IAM role. Store alarm state changes as separate records (for history).

---

### Story 8.2: Budget Breach Notifications

As a system,
I want budget breaches recorded in the alerts table,
So that the dashboard shows when projects exceed budgets.

**Acceptance Criteria:**

**Given** budget data from Story 3.6 and alerts table from Story 8.1
**When** the cost aggregation Lambda detects a budget breach
**Then:**

- Cost aggregator Lambda (Story 3.1) extended to check budget limits after aggregation
- If project cost >= budget limit: creates alert record with type `budget-breach`
- If project cost >= 80% of budget: creates alert record with type `budget-warning`
- Alert records: alertId, projectId, type, severity (warning/critical), message, amount, limit, timestamp

**And** budget breaches appear as alerts
**And** no duplicate alerts for same breach on same day

**Prerequisites:** Story 3.6, 8.1

**Technical Notes:**
Check budget after cost aggregation in the same Lambda execution. De-duplicate by checking if alert for same project+type+date already exists.

---

### Story 8.3: Unified Alert Dashboard

As a user,
I want to see all alerts (alarms, budget breaches, anomalies) in one feed,
So that I can respond to issues quickly.

**Acceptance Criteria:**

**Given** alert data from Stories 8.1 and 8.2
**When** I build the alert dashboard
**Then:**

- `GET /api/alerts` — list alerts, supports `?projectId=xxx&type=xxx&severity=xxx` filters
- **Alert page** (`src/app/alerts/page.tsx`):
  - Alert feed sorted by timestamp (newest first)
  - Each alert: project name, type icon, severity badge, message, timestamp
  - Filter by: project, type (alarm/budget/anomaly), severity (info/warning/critical)
  - Alert count badge on sidebar navigation
- **Project detail** extended with alert count in tab label
- Navigation: add "Alerts" to sidebar

**And** alerts display with correct severity colours (red=critical, yellow=warning, blue=info)
**And** filters work correctly

**Prerequisites:** Story 8.1, 8.2, 0.8

**Technical Notes:**
Use shadcn/ui `Badge` for severity. TanStack Query hook: `useAlerts(filters)`.

---

### Story 8.4: Email Notification Routing

As a user,
I want critical alerts sent to my email,
So that I don't have to constantly check the dashboard.

**Acceptance Criteria:**

**Given** alerts from Stories 8.1-8.3
**When** I configure notification routing
**Then:**

- `PUT /api/notifications/settings` — save preferences: `{ email, alertTypes, minSeverity }`
- Notification settings stored in projects table (or separate config)
- When alert is created with severity >= configured minimum:
  - Send email via AWS SES to configured address
  - Email includes: alert type, project, severity, message, link to dashboard
- SES verified sender email configured in SSM

**And** critical alerts trigger email delivery
**And** low-severity alerts don't send email (respects minSeverity setting)

**Prerequisites:** Story 8.3

**Technical Notes:**
Use `@aws-sdk/client-ses`. IAM role: `ses:SendEmail`. Sender email must be SES-verified. Keep email simple — plain text or minimal HTML.

---

_For implementation: Use the `/bmad:bmm:workflows:create-story` workflow to generate individual story implementation plans from this epic breakdown._
