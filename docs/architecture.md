# Architecture

## Executive Summary

The Futurator Admin Hub is a serverless cost observatory deployed entirely on AWS free-tier services. The frontend is a statically exported Next.js app served via S3 + CloudFront. The backend is a single Lambda function (Hono router) behind API Gateway. Data is stored across purpose-specific DynamoDB tables (PAY_PER_REQUEST). Daily scheduled Lambdas aggregate cost and resource data. Authentication uses the existing Identity Broker service with Google OAuth, with server-side token exchange via a dedicated Lambda. Infrastructure is managed by SST (Ion).

**Cost at rest: $0. Cost under use: ~$0-1/month.**

## Project Initialization

First implementation story should execute:

```bash
npx create-next-app@latest futurator-admin --typescript --tailwind --eslint --app --src-dir
```

Then initialize SST in the project:

```bash
cd futurator-admin
npx sst@latest init
```

This establishes the base architecture with these decisions:

- Next.js App Router with TypeScript strict
- Tailwind CSS for styling
- ESLint base configuration
- `src/` directory structure
- SST for infrastructure-as-code (Pulumi-based)

## Decision Summary

| Category         | Decision                       | Version    | Affects Epics  | Rationale                                                 |
| ---------------- | ------------------------------ | ---------- | -------------- | --------------------------------------------------------- |
| Framework        | Next.js (static export)        | 15.x       | All            | Static export → S3/CloudFront = $0 hosting                |
| Language         | TypeScript (strict)            | 5.x        | All            | Type safety across frontend + Lambda                      |
| Styling          | Tailwind CSS                   | 4.x        | All UI epics   | Utility-first, no CSS runtime                             |
| Components       | shadcn/ui (Radix-based)        | latest     | All UI epics   | Copy-paste components, zero runtime dep, Tailwind native  |
| State Management | Zustand                        | 5.x        | Frontend epics | Minimal boilerplate, works with static export             |
| Data Fetching    | TanStack Query                 | 5.x        | All data epics | Caching, dedup, stale-while-revalidate for dashboard data |
| Charts           | Recharts                       | 2.x        | Epic 3, 5      | Cost visualisation (pie, line, bar)                       |
| Validation       | zod                            | 3.x        | All API epics  | Input validation on Lambda + form validation on frontend  |
| Date/Time        | date-fns                       | 4.x        | All            | Tree-shakeable, date range math for cost queries          |
| Testing          | Vitest                         | 3.x        | All            | Fast, Vite-native, Jest-compatible API                    |
| API Router       | Hono                           | 4.x        | All API epics  | Lightweight Lambda router, single handler for all routes  |
| Database         | DynamoDB (multi-table)         | -          | All data epics | PAY_PER_REQUEST, one table per concern, $0 at low usage   |
| Auth             | Identity Broker + Google OAuth | -          | Epic 0, 7      | Existing service, server-side OTP exchange                |
| Infrastructure   | SST (Ion)                      | latest     | All            | Deploys S3/CF + Lambda + API GW + DynamoDB + EventBridge  |
| CDN              | CloudFront                     | -          | All            | Serves static frontend, routes /api and /auth to Lambda   |
| CI/CD            | Deploy scripts (sst deploy)    | -          | Epic 0         | Single command deployment                                 |
| Linting          | ESLint flat config             | 9.x        | All            | Code quality with TypeScript rules                        |
| Formatting       | Prettier                       | 3.x        | All            | Consistent code formatting                                |
| Dead Code        | Knip                           | 5.x        | All            | Detect unused exports/dependencies                        |
| Git Hooks        | Husky + lint-staged            | 9.x / 15.x | All            | Pre-commit lint + format                                  |

## Project Structure

```
futurator-admin/
├── sst.config.ts                    # SST infrastructure definition
├── package.json
├── tsconfig.json
├── next.config.ts                   # output: 'export', static generation
├── eslint.config.mjs                # ESLint flat config
├── .prettierrc                      # Prettier config
├── knip.config.ts                   # Dead code detection config
├── vitest.config.ts                 # Test configuration
├── .husky/
│   └── pre-commit                   # lint-staged hook
│
├── src/
│   ├── app/                         # Next.js App Router (static pages)
│   │   ├── layout.tsx               # Root layout with providers
│   │   ├── page.tsx                 # Portfolio dashboard (home)
│   │   ├── login/
│   │   │   └── page.tsx             # Login page (Google OAuth button)
│   │   ├── auth/
│   │   │   └── callback/
│   │   │       └── page.tsx         # OAuth callback handler (client-side)
│   │   ├── projects/
│   │   │   ├── page.tsx             # Project registry grid
│   │   │   └── [id]/
│   │   │       └── page.tsx         # Project detail (tabbed)
│   │   ├── costs/
│   │   │   └── page.tsx             # Portfolio cost explorer
│   │   ├── resources/
│   │   │   └── page.tsx             # Global resource map
│   │   └── schedules/               # MVP 2
│   │       └── page.tsx             # Resource scheduler
│   │
│   ├── components/
│   │   ├── ui/                      # shadcn/ui components (auto-generated)
│   │   │   ├── button.tsx
│   │   │   ├── card.tsx
│   │   │   ├── tabs.tsx
│   │   │   ├── table.tsx
│   │   │   ├── badge.tsx
│   │   │   ├── dialog.tsx
│   │   │   └── ...
│   │   ├── layout/
│   │   │   ├── app-shell.tsx        # Main layout with sidebar + header
│   │   │   ├── sidebar.tsx          # Navigation sidebar
│   │   │   └── header.tsx           # Top header with user menu
│   │   ├── charts/
│   │   │   ├── cost-pie-chart.tsx   # Cost by service breakdown
│   │   │   ├── cost-trend-line.tsx  # Daily cost trend
│   │   │   ├── budget-bar.tsx       # Budget utilisation
│   │   │   └── project-ranking.tsx  # Project cost ranking
│   │   ├── projects/
│   │   │   ├── project-card.tsx     # Project summary card
│   │   │   └── project-tabs.tsx     # Detail page tab container
│   │   ├── resources/
│   │   │   ├── resource-list.tsx    # Resource inventory grouped by service
│   │   │   └── tag-compliance.tsx   # Tag compliance badge/score
│   │   └── auth/
│   │       ├── auth-guard.tsx       # Protected route wrapper
│   │       └── login-button.tsx     # Google OAuth login button
│   │
│   ├── hooks/
│   │   ├── use-auth.ts             # Auth state + token management
│   │   ├── use-projects.ts         # TanStack Query hooks for projects
│   │   ├── use-costs.ts            # TanStack Query hooks for costs
│   │   └── use-resources.ts        # TanStack Query hooks for resources
│   │
│   ├── stores/
│   │   ├── auth-store.ts           # Zustand: auth state (user, isAuthenticated)
│   │   └── ui-store.ts             # Zustand: sidebar state, date range, filters
│   │
│   ├── lib/
│   │   ├── api-client.ts           # Fetch wrapper with auth cookie handling
│   │   ├── query-client.ts         # TanStack Query client config
│   │   ├── constants.ts            # API base URL, project list, etc.
│   │   └── utils.ts                # Shared utilities (cn helper, formatCurrency, etc.)
│   │
│   └── types/
│       ├── project.ts              # Project, Feature, Client types
│       ├── cost.ts                 # CostRecord, CostSummary, CostForecast types
│       ├── resource.ts             # AWSResource, ResourceSummary types
│       ├── auth.ts                 # User, Session types
│       └── api.ts                  # API response envelope types
│
├── functions/                       # Lambda functions (SST deploys these)
│   ├── api/
│   │   └── index.ts                # Hono router — single Lambda for all /api/* routes
│   │
│   ├── auth/
│   │   └── callback.ts             # OAuth callback Lambda — exchanges OTP, sets cookies
│   │
│   ├── cron/
│   │   ├── cost-aggregator.ts      # Daily: Cost Explorer → DynamoDB costs table
│   │   ├── resource-discoverer.ts  # Daily: AWS APIs → DynamoDB resources table
│   │   └── tag-auditor.ts          # Daily: Tag compliance scan
│   │
│   └── shared/
│       ├── auth-middleware.ts       # JWT validation via JWKS (shared across functions)
│       ├── dynamo-client.ts         # DynamoDB DocumentClient factory
│       ├── types.ts                 # Shared backend types
│       └── errors.ts               # Structured error classes
│
├── scripts/
│   ├── seed-projects.ts            # Seed all 11 projects into DynamoDB
│   ├── tag-audit.ts                # CLI: scan all AWS resources for tag compliance
│   └── bulk-tag.ts                 # CLI: apply mandatory tags to existing resources
│
├── public/
│   └── favicon.ico
│
└── tests/
    ├── functions/
    │   ├── api.test.ts             # API route tests
    │   └── cron.test.ts            # Cron Lambda tests
    └── components/
        └── ...                     # Component tests
```

## Epic to Architecture Mapping

| Epic                                    | Frontend (src/app, src/components)             | Backend (functions/)                                        | Data (DynamoDB)          | Infrastructure (sst.config.ts)                             |
| --------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- | ------------------------ | ---------------------------------------------------------- |
| **Epic 0: Scaffolding**                 | App shell, layout, login page, auth callback   | auth/callback.ts, api/index.ts (health)                     | All tables created       | S3, CloudFront, API Gateway, Lambda, DynamoDB, EventBridge |
| **Epic 1: Tagging**                     | Tag compliance display (component)             | — (CLI scripts only)                                        | —                        | —                                                          |
| **Epic 2: Project Registry**            | projects/ pages, project-card, project-tabs    | api/index.ts (project routes)                               | `projects` table         | —                                                          |
| **Epic 3: Cost Dashboard**              | costs/ page, all chart components              | api/index.ts (cost routes), cron/cost-aggregator.ts         | `costs` table            | EventBridge cron rule                                      |
| **Epic 4: Resource Map**                | resources/ page, resource-list, tag-compliance | api/index.ts (resource routes), cron/resource-discoverer.ts | `resources` table        | EventBridge cron rule                                      |
| **Epic 5: Multi-Provider Costs** (MVP2) | Extended cost charts, manual entry form        | api/index.ts (provider routes), additional cron Lambdas     | `costs` table (extended) | Additional cron rules                                      |
| **Epic 6: Scheduler** (MVP2)            | schedules/ page, cron builder UI               | api/index.ts (schedule routes)                              | `schedules` table        | EventBridge Scheduler                                      |
| **Epic 7: Identity Dashboard** (MVP2)   | Users page, user directory                     | api/index.ts (user routes), cron/user-sync.ts               | `users` table            | EventBridge cron rule                                      |
| **Epic 8: Alerts** (MVP2)               | Alert feed, notification prefs                 | api/index.ts (alert routes)                                 | `alerts` table           | SNS topic                                                  |

## Technology Stack Details

### Core Technologies

**Frontend Runtime:**

- Next.js 15.x with `output: 'export'` in next.config.ts — generates pure static HTML/CSS/JS
- No SSR, no API routes in Next.js — all server logic is in Lambda functions
- TanStack Query for all data fetching with stale-while-revalidate caching
- Zustand for client-only state (auth, UI preferences, filters)

**Backend Runtime:**

- Single Lambda function running Hono router for all `/api/*` endpoints
- Separate Lambda for `/auth/callback` (OAuth exchange)
- Separate Lambda functions for each cron job (cost, resources, tags)
- Node.js 22.x runtime, ARM64 architecture (Graviton — 20% cheaper)
- Lambda memory: 256MB for API, 512MB for cron jobs (AWS API calls need more)

**Infrastructure:**

- SST Ion manages all AWS resources via `sst.config.ts`
- Single `sst deploy` command deploys everything
- `sst dev` for local development with live Lambda

### Integration Points

```
┌─────────────────────────────────────────────────────────┐
│  CloudFront Distribution (admin.futurator.ai)           │
│                                                          │
│  Behaviors:                                              │
│  ├── Default (/*) ──────→ S3 Bucket (static frontend)   │
│  ├── /api/* ────────────→ API Gateway → Lambda (Hono)    │
│  └── /auth/callback ───→ API Gateway → Lambda (auth)     │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  Lambda Functions                                        │
│                                                          │
│  API Handler (Hono):                                     │
│  ├── GET  /api/projects         → DynamoDB projects      │
│  ├── GET  /api/projects/:id     → DynamoDB projects      │
│  ├── PUT  /api/projects/:id     → DynamoDB projects      │
│  ├── GET  /api/costs/overview   → DynamoDB costs         │
│  ├── GET  /api/projects/:id/costs → DynamoDB costs       │
│  ├── GET  /api/costs/forecast   → DynamoDB costs         │
│  ├── GET  /api/projects/:id/resources → DynamoDB resources│
│  ├── GET  /api/resources/summary → DynamoDB resources    │
│  └── GET  /api/tags/compliance  → DynamoDB audits        │
│                                                          │
│  Auth Callback:                                          │
│  └── GET  /auth/callback?code=  → Identity Broker OTP    │
│      exchange → Set HTTP-only cookies → Redirect to /    │
│                                                          │
│  Cron Jobs (EventBridge):                                │
│  ├── cost-aggregator   (daily 06:00 UTC)                 │
│  │   └── Cost Explorer API (us-east-1) → costs table     │
│  ├── resource-discoverer (daily 07:00 UTC)               │
│  │   └── Tagging API + service APIs → resources table    │
│  └── tag-auditor       (daily 07:30 UTC)                 │
│      └── Tagging API → audits table                      │
└─────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────┐
│  External Services                                       │
│                                                          │
│  Identity Broker (us-east-1):                            │
│  ├── GET  /auth/oauth/google?appId=futurator-admin       │
│  ├── POST /auth/oauth/exchange (OTP → JWT)               │
│  ├── GET  /.well-known/jwks.json (cached 1hr)            │
│  └── POST /auth/refresh                                  │
│                                                          │
│  AWS APIs (called by cron Lambdas):                      │
│  ├── Cost Explorer (us-east-1 only)                      │
│  ├── Resource Groups Tagging API                         │
│  ├── DynamoDB, S3, Lambda, ECS, ECR describe APIs        │
│  ├── CloudWatch (alarms, metrics)                        │
│  └── Budgets API                                         │
└─────────────────────────────────────────────────────────┘
```

## Implementation Patterns

These patterns ensure consistent implementation across all AI agents:

### Naming Conventions

| Entity                      | Convention                  | Example                                |
| --------------------------- | --------------------------- | -------------------------------------- |
| Files (components)          | PascalCase.tsx              | `ProjectCard.tsx`                      |
| Files (hooks)               | kebab-case with use- prefix | `use-projects.ts`                      |
| Files (utilities)           | kebab-case                  | `api-client.ts`                        |
| Files (Lambda functions)    | kebab-case                  | `cost-aggregator.ts`                   |
| React components            | PascalCase                  | `export function ProjectCard()`        |
| Hooks                       | camelCase with use prefix   | `export function useProjects()`        |
| TypeScript types/interfaces | PascalCase                  | `interface CostRecord {}`              |
| Variables/functions         | camelCase                   | `const totalCost = ...`                |
| Constants                   | UPPER_SNAKE_CASE            | `const API_BASE_URL = ...`             |
| DynamoDB tables             | kebab-case                  | `futurator-admin-projects`             |
| DynamoDB attributes         | camelCase                   | `projectId`, `monthlyTotal`            |
| API routes                  | kebab-case, plural nouns    | `/api/projects`, `/api/costs/overview` |
| Environment variables       | UPPER_SNAKE_CASE            | `IDENTITY_BROKER_URL`                  |
| CSS classes                 | Tailwind utilities only     | No custom CSS classes                  |

### Code Organization

| Rule                      | Convention                                                                 |
| ------------------------- | -------------------------------------------------------------------------- |
| Component structure       | One component per file, named export (not default)                         |
| Component co-location     | Component + test in same directory                                         |
| Barrel exports            | `index.ts` only in `components/ui/` — avoid elsewhere                      |
| Import order              | builtins → external → internal → parent → sibling (ESLint enforced)        |
| Shared types              | `src/types/` for frontend, `functions/shared/types.ts` for backend         |
| No cross-boundary imports | Frontend never imports from `functions/`, Lambda never imports from `src/` |

### Error Handling

**Lambda API errors — structured JSON response:**

```typescript
// All API errors use this format
interface ApiError {
  error: {
    code: string; // e.g., "AUTH_EXPIRED", "PROJECT_NOT_FOUND"
    message: string; // Human-readable message
  };
}

// HTTP status codes:
// 400 — validation error (zod)
// 401 — missing or invalid auth
// 403 — insufficient permissions
// 404 — resource not found
// 500 — internal error (never expose details)
```

**Frontend error handling:**

```typescript
// TanStack Query error handling — all hooks follow this pattern
const { data, error, isLoading } = useProjects();
// Components check error/isLoading states
// Auth errors (401) trigger redirect to /login via auth-guard
```

**Cron Lambda errors:**

- Log structured JSON error to CloudWatch
- Do not throw — cron jobs should be idempotent and retry-safe
- Store partial results if possible

### Logging Strategy

**Lambda logging — structured JSON:**

```typescript
// All Lambda logs use this format
console.log(JSON.stringify({
  level: "info" | "warn" | "error",
  message: "descriptive message",
  functionName: "cost-aggregator",
  timestamp: new Date().toISOString(),
  // Additional context:
  projectId?: string,
  duration?: number,
  error?: { code: string, message: string, stack?: string }
}));
```

- `info` for normal operations
- `warn` for degraded but functional (e.g., one project's cost fetch failed)
- `error` for failures requiring attention
- Never log secrets, tokens, or PII

### Date/Time Handling

| Context          | Format                               | Example                      |
| ---------------- | ------------------------------------ | ---------------------------- |
| DynamoDB storage | ISO 8601 UTC string                  | `"2026-04-04T06:00:00.000Z"` |
| Cost date keys   | `YYYY-MM-DD`                         | `"2026-04-04"`               |
| Monthly keys     | `YYYY-MM`                            | `"2026-04"`                  |
| API responses    | ISO 8601 UTC string                  | `"2026-04-04T06:00:00.000Z"` |
| UI display       | `date-fns format()` with user locale | `"Apr 4, 2026"`              |
| All computation  | UTC — never local timezone           | —                            |

### API Response Format

```typescript
// Success responses — direct data, no wrapper
// GET /api/projects → Project[]
// GET /api/projects/:id → Project
// GET /api/costs/overview → CostOverview

// Error responses — structured error object
// { error: { code: string, message: string } }

// Pagination (when needed):
// GET /api/resources?cursor=xxx&limit=50
// → { items: Resource[], nextCursor: string | null }
```

### Testing Strategy

| Layer             | Tool                                | What to Test                                       |
| ----------------- | ----------------------------------- | -------------------------------------------------- |
| Lambda API routes | Vitest                              | Request/response, auth middleware, validation      |
| Cron Lambdas      | Vitest                              | Data transformation, error handling (mock AWS SDK) |
| React components  | Vitest + Testing Library            | Rendering, user interactions                       |
| Hooks             | Vitest + Testing Library renderHook | Data fetching, state management                    |
| E2E               | Not for MVP                         | —                                                  |

## Data Architecture

### DynamoDB Tables

**`futurator-admin-projects`**

| Attribute        | Type      | Description                                          |
| ---------------- | --------- | ---------------------------------------------------- |
| `projectId` (PK) | String    | e.g., `contento`, `mbe`, `admin-hub`                 |
| `name`           | String    | Display name                                         |
| `status`         | String    | `planning`, `in-progress`, `beta`, `active`          |
| `category`       | String    | `independent-companies`, `joint-venture`, `personal` |
| `brief`          | String    | One-line description                                 |
| `features`       | List      | `[{ id, name, status, awsServices }]`                |
| `awsServices`    | StringSet | `["ecs", "dynamodb", "s3", "lambda"]`                |
| `team`           | List      | `["richie"]`                                         |
| `createdAt`      | String    | ISO 8601                                             |
| `updatedAt`      | String    | ISO 8601                                             |

**`futurator-admin-costs`**

| Attribute        | Type   | Description                                       |
| ---------------- | ------ | ------------------------------------------------- |
| `projectId` (PK) | String | Project identifier or `PORTFOLIO` for totals      |
| `date` (SK)      | String | `YYYY-MM-DD` (daily) or `YYYY-MM` (monthly)       |
| `provider`       | String | `aws`, `gcp`, `anthropic`, `elevenlabs`, `manual` |
| `totalAmount`    | Number | Total cost in USD                                 |
| `currency`       | String | `USD`                                             |
| `breakdown`      | Map    | `{ "ECS Fargate": 5.20, "DynamoDB": 0.01, ... }`  |
| `forecast`       | Map    | `{ "endOfMonth": 45.00, "confidence": "medium" }` |
| `anomalies`      | List   | `[{ service, amount, expectedAmount, severity }]` |

**`futurator-admin-resources`**

| Attribute          | Type    | Description                                      |
| ------------------ | ------- | ------------------------------------------------ |
| `projectId` (PK)   | String  | Project identifier                               |
| `resourceArn` (SK) | String  | Full AWS resource ARN                            |
| `serviceType`      | String  | `dynamodb`, `s3`, `lambda`, `ecs`, `ecr`, etc.   |
| `resourceName`     | String  | Human-readable name                              |
| `region`           | String  | `us-east-1`, `eu-central-1`                      |
| `tags`             | Map     | All tags on the resource                         |
| `config`           | Map     | Key config values (capacity mode, runtime, etc.) |
| `tagCompliant`     | Boolean | Has all mandatory tags                           |
| `discoveredAt`     | String  | ISO 8601                                         |

**`futurator-admin-audits`**

| Attribute            | Type   | Description                              |
| -------------------- | ------ | ---------------------------------------- |
| `projectId` (PK)     | String | Project identifier or `GLOBAL`           |
| `auditDate` (SK)     | String | `YYYY-MM-DD`                             |
| `tagComplianceScore` | Number | 0-100 percentage                         |
| `totalResources`     | Number | Count of resources                       |
| `compliantResources` | Number | Count with all mandatory tags            |
| `issues`             | List   | `[{ rule, resource, severity, detail }]` |

**`futurator-admin-schedules`** (MVP 2)

| Attribute         | Type    | Description                |
| ----------------- | ------- | -------------------------- |
| `scheduleId` (PK) | String  | UUID                       |
| `resourceType`    | String  | `ec2`, `ecs`               |
| `resourceId`      | String  | Instance ID or task family |
| `projectId`       | String  | Associated project         |
| `action`          | String  | `start` or `stop`          |
| `cronExpression`  | String  | EventBridge cron           |
| `timezone`        | String  | e.g., `Europe/Berlin`      |
| `enabled`         | Boolean | Active or paused           |
| `createdAt`       | String  | ISO 8601                   |

**`futurator-admin-users`** (MVP 2)

| Attribute     | Type   | Description                                           |
| ------------- | ------ | ----------------------------------------------------- |
| `userId` (PK) | String | Cognito user ID                                       |
| `email`       | String | User email                                            |
| `name`        | String | Display name                                          |
| `projects`    | Map    | `{ "contento": { role: "admin", lastLogin: "..." } }` |
| `syncedAt`    | String | ISO 8601                                              |

## API Contracts

### Authentication Flow

```
1. User clicks "Sign in with Google" on /login
   → Redirect to: {BROKER_URL}/auth/oauth/google?appId=futurator-admin

2. Google OAuth consent → Broker handles → Redirects to:
   → https://admin.futurator.ai/auth/callback?code=otp_abc123

3. CloudFront routes /auth/callback to Lambda:
   → Lambda POST {BROKER_URL}/auth/oauth/exchange
     Body: { code, clientId, clientSecret }
   → Receives: { accessToken, idToken, refreshToken, user }
   → Sets HTTP-only cookies:
     - access_token (HttpOnly, Secure, SameSite=Strict, Path=/, Max-Age=3600)
     - refresh_token (HttpOnly, Secure, SameSite=Strict, Path=/auth, Max-Age=604800)
   → 302 Redirect to /

4. All /api/* requests include cookies automatically
   → Hono auth middleware reads access_token cookie
   → Validates JWT against JWKS (cached)
   → If expired: auto-refresh using refresh_token cookie
   → Returns 401 if both expired → Frontend redirects to /login
```

### Request/Response Examples

```typescript
// GET /api/projects
// Response: 200
[
  {
    "projectId": "contento",
    "name": "Contento",
    "status": "beta",
    "category": "independent-companies",
    "brief": "AI-based web builder for small entrepreneurs",
    "features": [{ "id": "headless-cms", "name": "Headless CMS", "status": "active" }],
    "awsServices": ["ecs", "dynamodb", "s3", "lambda", "bedrock"]
  }
]

// GET /api/costs/overview
// Response: 200
{
  "totalMonthly": 142.50,
  "currency": "USD",
  "period": "2026-04",
  "projects": [
    { "projectId": "contento", "amount": 45.20, "trend": "up", "changePercent": 12.5 },
    { "projectId": "mbe", "amount": 32.10, "trend": "flat", "changePercent": -1.2 }
  ],
  "topServices": [
    { "service": "ECS Fargate", "amount": 68.00 },
    { "service": "DynamoDB", "amount": 22.50 }
  ]
}

// GET /api/projects/contento/costs?range=30d
// Response: 200
{
  "projectId": "contento",
  "period": { "start": "2026-03-05", "end": "2026-04-04" },
  "daily": [
    { "date": "2026-04-04", "amount": 1.52, "breakdown": { "ECS Fargate": 0.98, "DynamoDB": 0.01 } }
  ],
  "forecast": { "endOfMonth": 48.00, "confidence": "medium" },
  "anomalies": [],
  "budget": { "limit": 50.00, "used": 45.20, "percentUsed": 90.4 }
}
```

## Security Architecture

### Authentication & Session Security

| Control        | Implementation                                                             |
| -------------- | -------------------------------------------------------------------------- |
| OAuth flow     | Google OAuth via Identity Broker, server-side OTP exchange                 |
| Token storage  | HTTP-only, Secure, SameSite=Strict cookies                                 |
| Client secret  | Stored in SSM Parameter Store, accessed by Lambda only — never in frontend |
| JWT validation | JWKS from Identity Broker, cached 1 hour in Lambda memory                  |
| Token refresh  | Server-side via dedicated Lambda, uses refresh_token cookie                |
| Session expiry | Access token: 1 hour, Refresh token: 7 days                                |

### Infrastructure Security

| Control            | Implementation                                                                   |
| ------------------ | -------------------------------------------------------------------------------- |
| IAM                | Separate IAM roles per Lambda function, least-privilege                          |
| API Lambda role    | DynamoDB read/write (own tables only)                                            |
| Cost cron role     | DynamoDB write (costs table) + Cost Explorer read-only (us-east-1)               |
| Resource cron role | DynamoDB write (resources table) + Tagging API read-only + service describe APIs |
| Auth Lambda role   | SSM read (broker credentials) + no DynamoDB access                               |
| S3 bucket          | Private, CloudFront OAC (Origin Access Control) only                             |
| CloudFront         | HTTPS only, TLS 1.2+                                                             |
| API Gateway        | IAM auth from CloudFront, not publicly accessible                                |

### Security Headers (CloudFront Response Headers Policy)

```
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' https://*.execute-api.us-east-1.amazonaws.com
X-Frame-Options: DENY
X-Content-Type-Options: nosniff
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: camera=(), microphone=(), geolocation=()
```

## Performance Considerations

| Concern             | Strategy                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- |
| Cold starts         | Single Hono Lambda (shared cold start), ARM64/Graviton, keep bundle <5MB                 |
| Dashboard load      | Static HTML from CloudFront edge cache, API data fetched client-side with TanStack Query |
| Cost data freshness | Pre-aggregated daily by cron Lambda, served from DynamoDB (single-digit ms reads)        |
| JWKS validation     | Cached in Lambda memory for 1 hour (avoids network call per request)                     |
| Bundle size         | Tree-shake date-fns, dynamic import Recharts, shadcn/ui is zero-runtime                  |

## Deployment Architecture

```
Developer machine
  │
  ├── npx sst dev          # Local development (live Lambda, local frontend)
  │
  └── npx sst deploy       # Production deployment
      │
      ├── next build && next export → S3 bucket (static files)
      │   └── CloudFront invalidation (automatic)
      │
      ├── functions/*.ts → esbuild bundle → Lambda functions
      │   └── API Gateway HTTP API (automatic)
      │
      ├── DynamoDB tables (created/updated)
      │
      └── EventBridge rules (cron schedules)
```

**Environments:**

- `sst dev` — development (live Lambda reload, local frontend on localhost:3000)
- `sst deploy --stage prod` — production (admin.futurator.ai)

**Cost at Rest:** $0

- S3: free tier (5GB)
- CloudFront: free tier (1TB transfer/month)
- Lambda: free tier (1M requests + 400,000 GB-seconds/month)
- DynamoDB: free tier (25 RCU/WCU + 25GB storage)
- API Gateway: free tier (1M requests/month)
- EventBridge: free (14M events/month free)

## Development Environment

### Prerequisites

- Node.js 22.x
- npm 10.x
- AWS CLI v2 configured with credentials (`futurator-ai-dev` profile)
- SST CLI (installed via npx)

### Setup Commands

```bash
# Clone and install
git clone <repo-url> futurator-admin
cd futurator-admin
npm install

# Configure AWS (if not already done)
aws configure --profile futurator-ai-dev

# Initialize shadcn/ui
npx shadcn@latest init

# Start development
npx sst dev

# In another terminal:
npm run dev    # Next.js dev server

# Run checks
npm run lint        # ESLint
npm run format      # Prettier check
npm run knip        # Dead code detection
npm run typecheck   # TypeScript
npm run test        # Vitest
```

## Architecture Decision Records (ADRs)

### ADR-001: Static Export over SSR/Fargate

**Decision:** Next.js static export to S3/CloudFront instead of SSR on Fargate.
**Context:** Admin dashboard for 1-3 users. Cost must be near-zero.
**Rationale:** Static files cost $0 to serve. Fargate minimum is ~$9/month 24/7. Dashboard data changes daily (cron), not per-request, so SSR adds no value.
**Trade-off:** No server-side rendering. All data fetching is client-side. OAuth callback requires separate Lambda.

### ADR-002: Multi-Table DynamoDB over Single-Table

**Decision:** One DynamoDB table per domain concern (projects, costs, resources, audits, schedules, users).
**Context:** Single-table design adds complexity with composite keys and overloaded GSIs.
**Rationale:** Tables are free to create with PAY_PER_REQUEST. Simple keys are easier to debug, backup, and reason about. No cross-entity transactions needed.
**Trade-off:** Cannot do cross-entity queries in a single request. Acceptable — dashboard loads data from separate API endpoints anyway.

### ADR-003: Hono over Express/Fastify for Lambda

**Decision:** Hono router as single Lambda handler for all API routes.
**Context:** Need a lightweight router that works natively on Lambda.
**Rationale:** Hono is purpose-built for serverless/edge. Tiny bundle (<14KB). Built-in middleware for auth, CORS, validation. One cold start serves all routes.
**Trade-off:** Less ecosystem than Express. Acceptable — we use minimal middleware.

### ADR-004: SST (Ion) for Infrastructure

**Decision:** SST Ion for all infrastructure management.
**Context:** Need to deploy S3/CloudFront + Lambda + API Gateway + DynamoDB + EventBridge.
**Rationale:** Single `sst.config.ts` manages everything. TypeScript-native. `sst dev` provides live Lambda development. Handles Next.js static export deployment natively.
**Trade-off:** Dependency on SST framework. Acceptable — infrastructure is simple enough to migrate if needed.

### ADR-005: Server-Side OAuth Exchange via Lambda

**Decision:** Dedicated Lambda function handles OAuth callback and token exchange.
**Context:** Static frontend cannot hold `clientSecret`. Identity Broker requires server-side OTP exchange.
**Rationale:** CloudFront behavior routes `/auth/callback` to a Lambda that exchanges OTP for JWT tokens, sets HTTP-only cookies, and redirects. Client secret never leaves server side.
**Trade-off:** Extra Lambda function and CloudFront behavior. Acceptable — security is non-negotiable.

### ADR-006: No Fargate — Full Serverless

**Decision:** Zero always-on compute. All compute via Lambda (on-demand + scheduled).
**Context:** Cost target is $0-1/month. 1-3 users, occasional dashboard access.
**Rationale:** Lambda free tier covers all usage. Fargate has minimum $9/month cost. Cold starts (1-2s) are acceptable for an admin dashboard.
**Trade-off:** Cold starts on first API call after idle period. Acceptable for internal tool.

---

_Generated by BMAD Decision Architecture Workflow_
_Date: 2026-04-04_
_For: Richie_
