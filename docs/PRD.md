# Futurator Admin Hub - Product Requirements Document

**Author:** Richie
**Date:** 2026-04-04
**Version:** 1.0

---

## Executive Summary

The Futurator Admin Hub is a centralised cost observatory and control plane for the Futurator portfolio — 9+ AI-powered applications running on AWS with additional dependencies on Google Cloud and third-party API providers (Anthropic, ElevenLabs, OpenAI, etc.).

Today, answering "how much does Contento cost per month?" requires manual tag filtering in the AWS Console. Resources sprawl across projects with inconsistent naming. There is no single view of portfolio health or costs.

The Admin Hub solves this by providing a single dashboard where Richie (the sole operator) can see every project's costs, resources, and health — across all providers — and act on what he sees (scheduling resources, catching anomalies, controlling spend).

### What Makes This Special

One page. Every project. Every cost. Every provider. Open the dashboard and instantly see your total portfolio spend broken down by project, catch cost spikes before the bill arrives, and know exactly which AWS resources are running across all 9+ projects. The "wow" moment: total clarity over a complex multi-project, multi-provider infrastructure — from a tool that itself costs almost nothing to run.

---

## Project Classification

**Technical Type:** Web App (Static Next.js export on S3/CloudFront + Lambda API routes)
**Domain:** General (internal DevOps/FinOps tooling)
**Complexity:** Medium (multiple AWS API integrations, multi-provider cost aggregation)
**Database:** Multi-table DynamoDB (one table per concern, PAY_PER_REQUEST)
**Region:** us-east-1 (co-located with existing infrastructure and Identity Broker)
**Auth:** Identity Broker with Google OAuth
**Deployment:** Static export → S3 + CloudFront (frontend), Lambda + API Gateway (backend)
**Users:** 1-3 (Richie + possible future team members)
**Cost target:** Near-zero (~$0-1/month at prototype scale)

---

## Success Criteria

1. **Cost clarity** — Within 30 seconds of opening the dashboard, Richie can tell how much any project costs this month, broken down by AWS service
2. **Anomaly awareness** — Cost spikes are visible on the dashboard within 24 hours (Cost Explorer API lag), not discovered on the monthly bill
3. **Portfolio overview** — Total monthly spend across ALL providers (AWS + GCP + API providers) visible in one view
4. **Resource visibility** — Every AWS resource across all projects is inventoried, tagged, and browsable per project
5. **Near-zero self-cost** — The Admin Hub itself costs ~$0-1/month (static S3/CloudFront + on-demand DynamoDB + scheduled Lambdas — all within free tier or near-zero at prototype scale)
6. **Fast login** — Google OAuth via Identity Broker, authenticated in under 3 seconds
7. **No maintenance burden** — Daily data aggregation runs unattended via scheduled Lambdas

---

## Product Scope

### MVP 1 — Project Observatory (Read-Only)

**Target: 6-8 weeks**

The read-only layer. See everything, touch nothing.

| Capability             | Description                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project Registry**   | Dashboard showing all 9+ projects with status, category, brief, features. Click into any project for detail view. Seed data for all existing projects.               |
| **AWS Cost Dashboard** | Per-project cost breakdown by AWS service. Portfolio-wide cost view. Daily/monthly trends (30/60/90 day). Cost forecasts. Anomaly detection badges. Budget tracking. |
| **AWS Resource Map**   | Per-project inventory of all AWS resources (DynamoDB tables, S3 buckets, Lambda functions, ECS services, ECR repos). Grouped by service type. Tag compliance scores. |
| **Tag Foundation**     | Audit script to scan all existing resources. Bulk retroactive tagging. Cost allocation tag activation. Tag compliance API.                                           |
| **Auth & Security**    | Google OAuth via Identity Broker. Server-side token exchange. HTTP-only secure cookies. JWT validation via JWKS. Protected routes. Security headers.                 |
| **Dev Tooling & CI**   | ESLint flat config, Prettier, Knip, Husky pre-commit hooks. Lint/typecheck/test/build pipeline.                                                                      |
| **Deployment**         | Static Next.js export → S3 bucket, CloudFront CDN. Lambda functions via API Gateway for backend. Zero compute cost at rest.                                          |

### MVP 2 — Control Plane (Write Operations)

**Target: 4-6 weeks after MVP 1**

The write layer. Act on what you see.

| Capability               | Description                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Multi-Provider Costs** | Aggregate costs from Google Cloud (BigQuery billing export), Anthropic API, ElevenLabs, OpenAI, GitHub Actions minutes. Manual cost entry for non-API costs (domains, licenses). Unified multi-provider dashboard. |
| **Resource Scheduler**   | Schedule start/stop of EC2 instances and ECS tasks to save costs. EventBridge Scheduler integration. Cron builder UI. Estimated savings calculation.                                                               |
| **Identity Dashboard**   | View users across all projects via Cognito Admin API. Per-project user counts. Active users, last login. Session management.                                                                                       |
| **Alert Management**     | Centralised view of CloudWatch alarms and budget breaches. Alert feed with filtering by project/severity. Notification routing (email via SES).                                                                    |

### Vision Features (Future MVPs)

| Capability                      | Description                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------- |
| **Cross-Project Analytics**     | Shared infrastructure patterns, dependency mapping, optimisation suggestions |
| **AI Ops Assistant**            | Natural language queries: "What's my most expensive Lambda?" via Bedrock RAG |
| **New Project Wizard**          | Guided UI to spin up a new project from the Futurator Boilerplate            |
| **Automated Consistency Rules** | AWS Config custom rules enforcing naming, runtime versions, config alignment |
| **Microservice Registry**       | Service discovery, health checks, dependency graph                           |

---

## Web App Specific Requirements

### Frontend

| Requirement     | Detail                                                                |
| --------------- | --------------------------------------------------------------------- |
| Framework       | Next.js with App Router, TypeScript strict mode                       |
| Styling         | Tailwind CSS, responsive design (desktop-first for admin dashboard)   |
| State           | Zustand for client state                                              |
| Charts          | Recharts for cost visualisation (pie, line, bar charts)               |
| Data fetching   | Server components where possible, client fetch for interactive charts |
| Browser support | Modern evergreen browsers (Chrome, Firefox, Safari, Edge)             |
| SEO             | Not needed (internal tool, behind auth)                               |

### Backend (API Routes)

| Requirement      | Detail                                                                        |
| ---------------- | ----------------------------------------------------------------------------- |
| Runtime          | Lambda functions behind API Gateway (HTTP API)                                |
| Auth middleware  | JWT validation against Identity Broker JWKS endpoint, cached 1 hour           |
| Input validation | Zod schemas on all API endpoints                                              |
| Error handling   | Structured JSON errors `{ error: { code, message } }`, never expose internals |
| Logging          | Structured JSON to CloudWatch Logs (Lambda auto-creates log groups)           |

### Authentication & Authorisation

| Requirement     | Detail                                                                              |
| --------------- | ----------------------------------------------------------------------------------- |
| Provider        | Identity Broker (existing service at us-east-1)                                     |
| OAuth flow      | Google OAuth → broker redirect → server-side OTP exchange → HTTP-only secure cookie |
| Token storage   | HTTP-only, Secure, SameSite=Strict cookies — NEVER localStorage/sessionStorage      |
| Client secret   | Server-side only — never exposed to browser                                         |
| Token refresh   | Server-side API route reads HTTP-only cookie, calls broker refresh endpoint         |
| JWKS validation | Local validation using broker's `/.well-known/jwks.json`, cached 1 hour             |
| Access control  | Single role: admin (all authenticated users are admins for MVP)                     |

### API Endpoints (MVP 1)

| Method | Path                           | Purpose                                    | Auth   |
| ------ | ------------------------------ | ------------------------------------------ | ------ |
| `GET`  | `/api/health`                  | Health check                               | Public |
| `GET`  | `/api/auth/callback`           | OAuth callback — exchanges OTP server-side | Public |
| `POST` | `/api/auth/refresh`            | Token refresh via HTTP-only cookie         | Cookie |
| `POST` | `/api/auth/logout`             | Clear auth cookies                         | Cookie |
| `GET`  | `/api/projects`                | List all projects                          | JWT    |
| `GET`  | `/api/projects/[id]`           | Project detail                             | JWT    |
| `PUT`  | `/api/projects/[id]`           | Update project metadata                    | JWT    |
| `GET`  | `/api/costs/overview`          | Portfolio cost summary                     | JWT    |
| `GET`  | `/api/projects/[id]/costs`     | Per-project cost data (query: range)       | JWT    |
| `GET`  | `/api/costs/forecast`          | 30-day cost forecast                       | JWT    |
| `GET`  | `/api/projects/[id]/resources` | Per-project AWS resource inventory         | JWT    |
| `GET`  | `/api/resources/summary`       | Global resource counts by type             | JWT    |
| `GET`  | `/api/tags/compliance`         | Tag compliance scores per project          | JWT    |

### API Endpoints (MVP 2 additions)

| Method                | Path                   | Purpose                        | Auth |
| --------------------- | ---------------------- | ------------------------------ | ---- |
| `GET`                 | `/api/costs/providers` | Multi-provider cost overview   | JWT  |
| `POST`                | `/api/costs/manual`    | Create manual cost entry       | JWT  |
| `GET/POST/PUT/DELETE` | `/api/schedules`       | CRUD for resource schedules    | JWT  |
| `GET`                 | `/api/users`           | User directory across projects | JWT  |
| `GET`                 | `/api/alerts`          | Centralised alert feed         | JWT  |

---

## User Experience Principles

**Design philosophy:** Utilitarian, data-dense, fast. This is an admin dashboard for one power user, not a consumer product. Prioritise information density and scan-ability over visual polish.

**Visual personality:** Clean, professional, dark-mode friendly. Think AWS Console clarity meets Vercel dashboard aesthetics.

### Key Interactions

1. **Portfolio Dashboard (home)** — Grid of project cards showing: name, status badge, monthly cost, cost trend arrow (up/down/flat), resource count. Click any card → project detail.
2. **Cost Explorer** — Date range selector, project filter. Pie chart (cost by service), line chart (daily trend), budget progress bar. Toggle between AWS-only and all-providers view.
3. **Resource Map** — Per-project resource list grouped by AWS service type. Each resource: name, type, tags, key config. Tag compliance badge.
4. **Project Detail** — Tabbed view: Overview | Costs | Resources | (MVP2: Users | Alerts)

---

## Functional Requirements

### FR-1: Project Registry

| ID     | Requirement                                                                                  | Acceptance Criteria                                                                      |
| ------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| FR-1.1 | System stores project metadata (name, status, category, brief, features, AWS services, team) | All 11 projects (9 apps + Admin Hub + Identity Broker) registered with complete metadata |
| FR-1.2 | Dashboard displays project cards with key summary info                                       | Cards show name, icon, status, category, monthly cost, resource count                    |
| FR-1.3 | Project detail page shows full metadata, features, and links                                 | All metadata fields displayed, features listed with status badges                        |
| FR-1.4 | Project metadata is editable                                                                 | PUT endpoint updates metadata, changes reflected immediately                             |

### FR-2: AWS Cost Tracking

| ID     | Requirement                                                                | Acceptance Criteria                                                                    |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| FR-2.1 | Daily Lambda aggregates cost data from Cost Explorer API                   | Lambda runs daily at 06:00 UTC, stores per-project cost data in DynamoDB `costs` table |
| FR-2.2 | Costs are grouped by project (via `futurator:project` tag) and AWS service | Cost breakdown shows each service's contribution to project total                      |
| FR-2.3 | Dashboard shows portfolio-wide cost summary                                | Total monthly cost, project ranking, service ranking visible on home page              |
| FR-2.4 | Per-project cost view shows daily trends                                   | Line chart with 30/60/90 day toggle, accurate to daily granularity                     |
| FR-2.5 | 30-day cost forecast displayed per project and portfolio-wide              | Forecast from Cost Explorer `GetCostForecast` API, shown as projected bar              |
| FR-2.6 | Cost anomalies detected and surfaced                                       | Daily Lambda calls `GetAnomalies`, anomaly badges appear on project cards              |
| FR-2.7 | Per-project budgets with utilisation tracking                              | Budget amounts configurable, progress bar shows % utilised                             |

### FR-3: AWS Resource Inventory

| ID     | Requirement                                                  | Acceptance Criteria                                                                                               |
| ------ | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| FR-3.1 | Daily Lambda discovers all AWS resources across both regions | Resource Groups Tagging API + per-service discovery (DynamoDB, S3, Lambda, ECS, ECR). Stores in `resources` table |
| FR-3.2 | Resources are mapped to projects via tags                    | Each resource linked to its `futurator:project` tag value                                                         |
| FR-3.3 | Resource map displays resources grouped by service type      | Expandable sections: Compute, Storage, Database, etc.                                                             |
| FR-3.4 | Tag compliance score calculated per project                  | Percentage of resources with all mandatory tags                                                                   |

### FR-4: AWS Tagging Foundation

| ID     | Requirement                                                      | Acceptance Criteria                                                                                                                 |
| ------ | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| FR-4.1 | Audit script scans all resources for tag status                  | CLI script outputs CSV/JSON of all resources with tag compliance status                                                             |
| FR-4.2 | Bulk tagging script applies mandatory tags to existing resources | Script tags all known resources with `futurator:project`, `futurator:environment`, `futurator:service-role`, `futurator:managed-by` |
| FR-4.3 | Cost allocation tags activated in AWS Billing                    | `futurator:project`, `futurator:environment`, `futurator:cost-center` activated                                                     |

### FR-5: Multi-Provider Cost Aggregation (MVP 2)

| ID     | Requirement                                    | Acceptance Criteria                                                   |
| ------ | ---------------------------------------------- | --------------------------------------------------------------------- |
| FR-5.1 | Cost provider abstraction with adapter pattern | `CostProvider` TypeScript interface, one adapter per provider         |
| FR-5.2 | Google Cloud costs aggregated daily            | GCP BigQuery billing export adapter, daily Lambda                     |
| FR-5.3 | API provider costs aggregated daily            | Adapters for Anthropic, ElevenLabs, OpenAI, GitHub Actions            |
| FR-5.4 | Manual cost entry for non-API costs            | UI form for domains, licenses, contractor costs                       |
| FR-5.5 | Unified dashboard showing all providers        | Total cost across all providers, filter by provider, breakdown charts |

### FR-6: Resource Scheduler (MVP 2)

| ID     | Requirement                                | Acceptance Criteria                                                             |
| ------ | ------------------------------------------ | ------------------------------------------------------------------------------- |
| FR-6.1 | CRUD for resource schedules                | Create/read/update/delete schedules with cron expressions                       |
| FR-6.2 | EventBridge Scheduler integration          | Schedules create/update corresponding EventBridge rules                         |
| FR-6.3 | EC2 start/stop actions                     | Lambda executes StartInstances/StopInstances, scoped to tagged resources        |
| FR-6.4 | ECS task start/stop actions                | Lambda runs/stops Fargate tasks, updates Route 53 DNS on start                  |
| FR-6.5 | Scheduler dashboard with estimated savings | List schedules, cron builder, savings calculation based on resource hourly cost |

### FR-7: Identity Dashboard (MVP 2)

| ID     | Requirement                              | Acceptance Criteria                                           |
| ------ | ---------------------------------------- | ------------------------------------------------------------- |
| FR-7.1 | User sync from Cognito                   | Daily Lambda calls Cognito ListUsers, stores in `users` table |
| FR-7.2 | User directory with project mapping      | List users, filter by project, show roles and last login      |
| FR-7.3 | Per-project user counts on project cards | Active user count badge on project cards                      |

### FR-8: Alert Management (MVP 2)

| ID     | Requirement                 | Acceptance Criteria                                     |
| ------ | --------------------------- | ------------------------------------------------------- |
| FR-8.1 | CloudWatch alarm discovery  | Lambda scans alarms, maps to projects via tags          |
| FR-8.2 | Budget breach notifications | SNS topic for budget alerts, Lambda records in DynamoDB |
| FR-8.3 | Unified alert dashboard     | Alert feed filtered by project, severity, type          |

---

## Non-Functional Requirements

### Security

| ID     | Requirement                                                                      | Rationale                                                                            |
| ------ | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| NFR-S1 | OAuth token exchange server-side only; `clientSecret` never in browser           | Identity Broker client secret is a credential — exposing it compromises all users    |
| NFR-S2 | Auth tokens in HTTP-only, Secure, SameSite=Strict cookies                        | Prevents XSS token theft and CSRF                                                    |
| NFR-S3 | All secrets in SSM Parameter Store (SecureString)                                | Never hardcode secrets in code, env vars, or Docker images                           |
| NFR-S4 | IAM roles follow least-privilege — no wildcard permissions                       | Admin Hub has elevated access to cost/resource data; over-permissioning is high risk |
| NFR-S5 | Security headers on all responses (CSP, X-Frame-Options, X-Content-Type-Options) | Standard web security hardening                                                      |
| NFR-S6 | CORS restricted to `admin.futurator.ai` only in production                       | No wildcard origins                                                                  |
| NFR-S7 | Input validation (zod) on all API endpoints                                      | Prevent injection and malformed data                                                 |
| NFR-S8 | Lambda functions use minimal IAM roles per function                              | Least-privilege per Lambda                                                           |

### Integration

| ID     | Requirement                                                                                 | Rationale                                          |
| ------ | ------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| NFR-I1 | Identity Broker (us-east-1): OAuth initiation, OTP exchange, JWKS validation, token refresh | Centralised auth across all Futurator apps         |
| NFR-I2 | AWS Cost Explorer API (us-east-1 only): GetCostAndUsage, GetCostForecast, GetAnomalies      | Primary cost data source — 24h delay is acceptable |
| NFR-I3 | AWS Resource Groups Tagging API: GetResources                                               | Resource discovery by tag                          |
| NFR-I4 | AWS service-specific APIs: DynamoDB, S3, Lambda, ECS, ECR, CloudWatch                       | Deep resource discovery and metrics                |
| NFR-I5 | AWS Budgets API: CreateBudget, DescribeBudgets                                              | Per-project budget tracking                        |
| NFR-I6 | AWS EventBridge Scheduler (MVP 2): Create/update/delete scheduled rules                     | Resource scheduling                                |
| NFR-I7 | Third-party provider APIs (MVP 2): GCP BigQuery, Anthropic, ElevenLabs, OpenAI, GitHub      | Multi-provider cost aggregation                    |

### Performance

| ID     | Requirement                                                                  | Rationale                                                        |
| ------ | ---------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| NFR-P1 | Dashboard loads in under 2 seconds (static files from CloudFront CDN)        | Static export served from edge, near-instant                     |
| NFR-P2 | Cost/resource data is pre-aggregated (daily Lambda), not computed on request | Cost Explorer API is slow; pre-aggregate and serve from DynamoDB |
| NFR-P3 | Lambda cold starts under 2 seconds for API calls                             | Acceptable for 1-3 user dashboard; keep Lambda bundle small      |
| NFR-P4 | JWKS cached for 1 hour                                                       | Avoid calling broker on every request                            |

---

## Implementation Planning

### Epic Breakdown

#### Epic 0: Project Scaffolding & Infrastructure Foundation

> Standing Next.js app deployed on Fargate in us-east-1 with auth, dev tooling, and CI pipeline.

**Stories:**

1. Next.js project init (App Router, TypeScript strict, Tailwind, Zustand, folder structure)
2. Dev tooling (ESLint flat config, Prettier, Knip, Husky + lint-staged pre-commit)
3. S3 bucket + CloudFront distribution for static frontend hosting
4. API Gateway (HTTP API) + Lambda functions for backend API routes
5. Deploy scripts (frontend: build + S3 sync + CloudFront invalidation, backend: Lambda deploy)
6. DynamoDB tables (projects, costs, resources, audits — PAY_PER_REQUEST, PITR enabled)
7. Identity Broker registration & Google OAuth (server-side exchange, HTTP-only cookies, JWKS validation, protected routes, login/logout)
8. SSM parameters (Identity Broker credentials stored as SecureString)
9. Security headers & CORS (CSP, X-Frame-Options, CORS for admin.futurator.ai, zod validation, rate limiting)
10. CI pipeline (lint, format:check, knip, typecheck, test, build)

#### Epic 1: AWS Tagging Foundation

> Every AWS resource tagged consistently. Cost allocation tags activated.

**Stories:**

1. Tag audit script (Resource Groups Tagging API scan, output untagged resources)
2. Bulk retroactive tagging (apply mandatory tags to all existing resources)
3. Activate cost allocation tags (AWS Billing console)
4. Tag compliance API endpoint and display

#### Epic 2: Project Registry

> Single source of truth for all Futurator projects.

**Stories:**

1. Project data model & DynamoDB repository (projects table CRUD)
2. Seed all 11 projects with complete metadata
3. Project registry API (list, detail, update endpoints)
4. Project registry dashboard UI (card grid with status, cost, resource count)
5. Project detail page (tabbed: Overview, Features, Resources, Costs)

#### Epic 3: AWS Cost Dashboard

> Real-time cost visibility per project with trends and anomaly detection.

**Stories:**

1. Cost aggregation Lambda (daily, Cost Explorer API, stores in costs table)
2. Cost API endpoints (overview, per-project, forecast)
3. Portfolio cost dashboard UI (total cost, project ranking, service ranking, trends)
4. Per-project cost view UI (service breakdown, daily trend, forecast, top resources)
5. Cost anomaly detection (GetAnomalies in daily Lambda, anomaly badges)
6. Budget setup & tracking (Budgets API, progress bars)

#### Epic 4: AWS Resource Map

> Per-project inventory of all AWS resources with consistency checks.

**Stories:**

1. Resource discovery Lambda (daily, Tagging API + per-service discovery, stores in resources table)
2. Resource API endpoints (per-project list, global summary)
3. Resource map UI (grouped by service type, tag compliance badges)
4. Basic consistency audit (runtime versions, encryption, public access, tag compliance)

#### Epic 5: Multi-Provider Cost Aggregation (MVP 2)

> Unified cost view across AWS + GCP + API providers.

**Stories:**

1. Cost provider abstraction layer (TypeScript interface, adapter pattern)
2. Google Cloud cost integration (BigQuery billing export adapter)
3. API provider cost integrations (Anthropic, ElevenLabs, OpenAI, GitHub)
4. Manual cost entry (UI form + CRUD API)
5. Unified multi-provider cost dashboard

#### Epic 6: Resource Scheduler (MVP 2)

> Schedule start/stop of resources to save costs.

**Stories:**

1. Schedule data model & CRUD API (schedules table)
2. EventBridge Scheduler integration
3. EC2 start/stop actions (Lambda, scoped IAM)
4. ECS task start/stop actions (Lambda, Route 53 update)
5. Scheduler dashboard UI (cron builder, estimated savings)

#### Epic 7: Identity Dashboard (MVP 2)

> User visibility across all projects.

**Stories:**

1. Cognito user sync Lambda (daily, stores in users table)
2. User directory API & UI (list, filter by project, roles, last login)
3. Per-project user counts on project cards

#### Epic 8: Alert Management (MVP 2)

> Centralised alert view.

**Stories:**

1. CloudWatch alarm discovery (Lambda, map to projects)
2. Budget breach notifications (SNS + Lambda)
3. Unified alert dashboard UI (feed, filter by project/severity)
4. Notification routing (email via SES)

---

## References

- Brainstorm: `docs/concepts/futurator-admin-hub-brainstorm.md`
- Deployment Guide: `docs/concepts/futurator-deployment-guide.md`
- Identity Broker Guide: `docs/concepts/identity-broker-quick-guide.md`

---

## Next Steps

1. **Architecture** - Run: `/bmad:bmm:workflows:architecture` for technical architecture decisions
2. **Epic & Story Breakdown** - Run: `/bmad:bmm:workflows:create-epics-and-stories` for detailed story files
3. **UX Design** (optional) - Run: `/bmad:bmm:workflows:create-ux-design` for detailed user experience design

---

_This PRD captures the essence of Futurator Admin Hub — total cost clarity across a complex multi-project portfolio, from a tool that itself costs almost nothing._

_Created through collaborative discovery between Richie and AI facilitator._
