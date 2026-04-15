# Futurator Deployment Playbook v2

> **Purpose:** Unified deployment strategy for ALL Futurator apps on AWS under `*.futurator.ai`. Supports two deployment patterns — **Fargate** (SSR apps, containers) and **Serverless** (static frontend + Lambda API). Choose the right pattern for each app.
>
> **Replaces:** v1 playbook (Fargate-only). All v1 conventions remain valid for Fargate apps; this guide adds the serverless pattern and provides a decision framework.

---

## Decision Framework: Fargate vs Serverless

Choose your deployment pattern **before** starting infrastructure setup.

### Quick Decision

| Question                                                | If YES →                      | If NO →                |
| ------------------------------------------------------- | ----------------------------- | ---------------------- |
| Does the app need SSR (server-side rendering)?          | **Fargate**                   | Serverless possible    |
| Does the app process large files (PDFs, images, audio)? | **Fargate** (more memory/CPU) | Serverless possible    |
| Does the app hold WebSocket connections?                | **Fargate**                   | Serverless possible    |
| Is the app a dashboard/admin tool with <10 users?       | **Serverless**                | Consider Fargate       |
| Must the app cost $0 at rest?                           | **Serverless**                | Fargate is fine        |
| Does the app need >15 minutes of continuous processing? | **Fargate**                   | Serverless (15min max) |

### Pattern Comparison

| Aspect               | Fargate Pattern                                 | Serverless Pattern                    |
| -------------------- | ----------------------------------------------- | ------------------------------------- |
| **Frontend**         | SSR in Docker container                         | Static export → S3 + CloudFront       |
| **Backend**          | Next.js API routes in Docker                    | Lambda functions (Hono/Express)       |
| **Compute**          | ECS Fargate task (always-on or scheduled)       | Lambda (on-demand, per-request)       |
| **Networking**       | VPC + Subnets + Security Group                  | No VPC needed                         |
| **DNS**              | Route 53 A record → task IP (updated on deploy) | Route 53 CNAME → CloudFront           |
| **Build**            | Docker → ECR → CodeBuild                        | esbuild/Vite → S3 (via SST)           |
| **Deploy**           | Custom bash script                              | `npx sst deploy`                      |
| **Cold start**       | None (always running)                           | 1-2 seconds (Lambda)                  |
| **Cost at rest**     | ~$9-24/month                                    | $0                                    |
| **Cost under use**   | Same (always-on)                                | ~$0-1/month (pay per request)         |
| **Max request time** | Unlimited                                       | 30 seconds (API GW) / 15 min (Lambda) |
| **Infra-as-code**    | Manual AWS CLI + scripts                        | SST (sst.config.ts)                   |

### Recommended Pattern Per App

| App                   | Pattern        | Reason                                                    |
| --------------------- | -------------- | --------------------------------------------------------- |
| **Contento**          | Fargate        | SSR, heavy CMS features, file processing                  |
| **Sellebra**          | Fargate        | SSR, e-commerce with real-time PIM                        |
| **MBE**               | Fargate        | SSR, BIM editor, document intelligence, heavy compute     |
| **MyApplicator**      | Fargate        | SSR, PDF generation, TTS/STT, Playwright scraping         |
| **GoMAD / Debatator** | Fargate        | SSR, multi-agent debates, heavy TTS, large doc processing |
| **Atlassinator**      | Fargate        | SSR, sandboxed Python execution                           |
| **Dasher**            | Fargate        | SSR, 15 chart types, interactive dashboards               |
| **Songster**          | Fargate        | SSR, audio processing, Demucs/WhisperX pipeline           |
| **Mycelium**          | Fargate        | SSR, GraphRAG, heavy compute                              |
| **Admin Hub**         | **Serverless** | Static dashboard, 1-3 users, $0 cost target               |
| **Identity Broker**   | **Serverless** | Already Lambda + API Gateway via CDK                      |

---

## Shared Infrastructure (All Apps)

These resources exist once and are shared across every app, regardless of pattern.

| Resource               | Value                                                       | Notes                             |
| ---------------------- | ----------------------------------------------------------- | --------------------------------- |
| AWS Account            | `835745294770`                                              | Single account for all projects   |
| Region                 | `us-east-1`                                                 | Primary region for all apps       |
| VPC                    | `vpc-018eab54c18d93803`                                     | Used by Fargate apps only         |
| Subnets                | `subnet-0b85dc11fb0285693`, `subnet-08786859267def985`      | Public subnets, used by Fargate   |
| Route 53 Hosted Zone   | `Z002886634JUZ2SIMCMV0` (`futurator.ai`)                    | All apps share this zone          |
| ECS Cluster            | `applicator-staging`                                        | Used by Fargate apps only         |
| IAM User               | `futurator-ai-dev`                                          | AdministratorAccess via group     |
| Identity Broker (dev)  | `https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1` | Auth for all apps                 |
| Identity Broker (prod) | `https://uyocidd3ll.execute-api.us-east-1.amazonaws.com/v1` | Production auth                   |
| Cognito User Pool      | `us-east-1_djPwzFjUe`                                       | Shared user pool via broker       |
| Registration API Key   | Stored in SSM                                               | Used to register apps with broker |

---

## Pattern A: Fargate Deployment

> For SSR apps, container-based workloads, heavy compute.

### Architecture

```
appname.futurator.ai:3000
        │
        └──→ Route 53 A record (IP updated on each deploy)
                │
                └──→ Fargate Task (Docker container)
                        │
                        ├──→ DynamoDB (app data)
                        ├──→ S3 (file storage)
                        ├──→ Identity Broker (auth)
                        ├──→ External APIs (Anthropic, etc.)
                        └──→ Lambda (optional, event-driven)
```

### Per-App Resources

| Resource                   | How to Create                                             | Notes                             |
| -------------------------- | --------------------------------------------------------- | --------------------------------- |
| ECR Repository             | `aws ecr create-repository --repository-name appname/web` | Docker image storage              |
| CodeBuild Project          | `aws codebuild create-project ...`                        | Builds Docker images              |
| S3 Source Bucket           | `aws s3 mb s3://appname-codebuild-source`                 | Upload source for CodeBuild       |
| Security Group             | `aws ec2 create-security-group ...`                       | Port 3000 open                    |
| ECS Task Definition        | `aws ecs register-task-definition ...`                    | 1 vCPU / 2GB default              |
| IAM Execution Role         | ECR pull + SSM read + CloudWatch write                    | Per app                           |
| IAM Task Role              | DynamoDB + S3 + SES + whatever app needs                  | Per app, least-privilege          |
| SSM Parameters             | `/appname/staging/*`                                      | All secrets, SecureString         |
| CloudWatch Log Group       | `/ecs/appname`                                            | 14-day retention                  |
| Route 53 A Record          | Auto-updated by deploy script                             | TTL: 60 seconds                   |
| Dockerfile + buildspec.yml | In app repo root                                          | Standardized                      |
| Deploy script              | `scripts/deploy.sh`                                       | Copy from template, change config |

### Deploy Script Template

Every Fargate app uses the same deploy script. Change the config variables at the top:

```bash
# ── Config (CHANGE THESE PER APP) ────────────────────────────
AWS_ACCOUNT_ID="835745294770"
AWS_REGION="us-east-1"
ECR_REPO="appname/web"                          # ← Change
ECS_CLUSTER="applicator-staging"                 # ← Shared
TASK_FAMILY="appname"                            # ← Change
CODEBUILD_PROJECT="appname-build"                # ← Change
S3_SOURCE_BUCKET="appname-codebuild-source"      # ← Change
SUBNETS="subnet-0b85dc11fb0285693,subnet-08786859267def985"
SECURITY_GROUP="sg-XXXXXXXXXXXXXXXXX"            # ← Change (per app)
HOSTED_ZONE_ID="Z002886634JUZ2SIMCMV0"          # ← Shared
APP_DOMAIN="appname.futurator.ai"                # ← Change
```

### Cost (Fargate)

| Mode                      | Monthly Cost          |
| ------------------------- | --------------------- |
| Stopped (nights/weekends) | ~$0 (just ECR ~$0.05) |
| Running 8h/day weekdays   | ~$5-6                 |
| Running 24/7              | ~$23                  |

---

## Pattern B: Serverless Deployment

> For static dashboards, admin tools, lightweight APIs, $0-cost apps.

### Architecture

```
appname.futurator.ai
        │
        └──→ Route 53 CNAME → CloudFront Distribution
                │
                ├──→ /* (default) ──→ S3 Bucket (static frontend)
                ├──→ /api/* ────────→ API Gateway → Lambda (Hono router)
                └──→ /auth/* ───────→ API Gateway → Lambda (auth callback)

EventBridge cron ──→ Lambda (scheduled jobs)
```

### Per-App Resources

All managed by SST in a single `sst.config.ts`:

| Resource        | SST Construct                        | Notes                             |
| --------------- | ------------------------------------ | --------------------------------- |
| S3 Bucket       | `sst.aws.StaticSite`                 | Static frontend files             |
| CloudFront      | `sst.aws.StaticSite`                 | CDN, HTTPS, security headers      |
| API Lambda      | `sst.aws.Function`                   | Hono router for all /api/\*       |
| Auth Lambda     | `sst.aws.Function`                   | OAuth callback, separate IAM role |
| API Gateway     | Automatic (via Function URL or API)  | HTTP API                          |
| DynamoDB Tables | `sst.aws.Dynamo`                     | PAY_PER_REQUEST, one per concern  |
| Cron Lambdas    | `sst.aws.Cron`                       | EventBridge scheduled             |
| IAM Roles       | Automatic (via SST link/permissions) | Per-function least-privilege      |
| SSM Parameters  | Manual (one-time)                    | Secrets for auth                  |
| Route 53        | `sst.aws.StaticSite` domain option   | Automatic CNAME                   |

### Deploy Command

```bash
# Development (live Lambda reload, local frontend)
npx sst dev

# Production
npx sst deploy --stage prod

# Tear down (non-production)
npx sst remove --stage dev
```

### Cost (Serverless)

| State                    | Monthly Cost |
| ------------------------ | ------------ |
| At rest (no traffic)     | **$0**       |
| Light use (1-10 users)   | **~$0-1**    |
| Moderate use (100 users) | **~$1-5**    |

All within AWS Free Tier: S3 (5GB), CloudFront (1TB), Lambda (1M requests), DynamoDB (25 RCU/WCU), API Gateway (1M requests), EventBridge (14M events).

---

## Identity Broker Integration (Both Patterns)

Every Futurator app authenticates via the shared Identity Broker. The integration differs slightly between patterns.

### Step 1: Register Your App (Both Patterns)

```bash
BROKER="https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1"
REG_KEY="your-registration-api-key"

curl -s -X POST "$BROKER/apps/register" \
  -H "Content-Type: application/json" \
  -H "X-Registration-Key: $REG_KEY" \
  -d '{
    "appId": "your-app-id",
    "name": "Your App Name",
    "type": "web",
    "baseUrl": "https://yourapp.futurator.ai"
  }' | jq '.'
```

**Save `clientId` and `clientSecret` immediately — shown only once.**

The broker auto-generates redirect URIs from `baseUrl`. For dev, register again or update with explicit URIs:

```bash
curl -X PUT "$BROKER/admin/apps/your-app-id" \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "redirectUris": [
      "http://localhost:3000/auth/callback",
      "https://yourapp.futurator.ai/auth/callback"
    ],
    "allowedOrigins": [
      "http://localhost:3000",
      "https://yourapp.futurator.ai"
    ]
  }'
```

### Step 2: Store Secrets

**Fargate apps** — store in SSM, referenced by ECS task definition:

```bash
aws ssm put-parameter --name "/yourapp/staging/IDENTITY_BROKER_URL" \
  --value "https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1" \
  --type SecureString --region us-east-1

aws ssm put-parameter --name "/yourapp/staging/IDENTITY_BROKER_CLIENT_ID" \
  --value "app_xxx" --type SecureString --region us-east-1

aws ssm put-parameter --name "/yourapp/staging/IDENTITY_BROKER_CLIENT_SECRET" \
  --value "secret_xxx" --type SecureString --region us-east-1
```

**Serverless apps** — same SSM path, accessed by Lambda via `GetParameter`:

```bash
aws ssm put-parameter --name "/yourapp/prod/IDENTITY_BROKER_URL" \
  --value "https://vnfmz85xj1.execute-api.us-east-1.amazonaws.com/v1" \
  --type SecureString --region us-east-1

# Same for CLIENT_ID, CLIENT_SECRET, JWKS_URL
```

### Step 3: Implement Auth

**Fargate apps** (SSR — token exchange in Next.js API route):

```
User → "Sign in with Google" button
  → Redirect to: {BROKER}/auth/oauth/google?appId={appId}
  → Google consent → Broker callback → Your /auth/callback?code=otp_xxx
  → Next.js API route exchanges OTP server-side (has clientSecret in env)
  → Sets httpOnly cookies or server session
  → Redirect to /
```

The `clientSecret` lives in the Fargate container's environment (injected from SSM at startup). The exchange happens server-side within your Next.js API route. Your backend holds all tokens.

**Serverless apps** (static export — token exchange in Lambda):

```
User → "Sign in with Google" button
  → Redirect to: {BROKER}/auth/oauth/google?appId={appId}
  → Google consent → Broker callback → CloudFront → Auth Lambda /auth/callback?code=otp_xxx
  → Lambda exchanges OTP server-side (reads clientSecret from SSM)
  → Sets httpOnly cookies (access_token, refresh_token, token_family, token_id)
  → 302 Redirect to /
```

The `clientSecret` lives in SSM, read by the auth Lambda at runtime. Static frontend never sees it. All cookies are `HttpOnly; Secure; SameSite=Strict`.

### Token Refresh (Both Patterns)

The Identity Broker uses **refresh token rotation** (OAuth 2.1). Every refresh invalidates the old token and issues a new one.

| Cookie          | Purpose             | Path    | Max-Age |
| --------------- | ------------------- | ------- | ------- |
| `access_token`  | JWT for API auth    | `/`     | 1 hour  |
| `refresh_token` | Token for refresh   | `/auth` | 30 days |
| `token_family`  | Rotation family ID  | `/auth` | 30 days |
| `token_id`      | Current rotation ID | `/auth` | 30 days |

**Critical rules:**

- Always use the LATEST `refreshToken` + `tokenId` (rotation)
- `familyId` stays constant for the session
- Reusing an old token (after 30-second grace period) revokes the entire family
- OTP codes expire in 60 seconds — exchange immediately
- State tokens expire in 10 minutes

### JWKS Validation (Both Patterns)

Validate JWTs locally using the broker's JWKS endpoint — no network call per request:

```typescript
// Cache JWKS for 1 hour (in Lambda module scope or Next.js module scope)
const JWKS_URL = `${BROKER_URL}/.well-known/jwks.json`;
// Issuer: 'https://api.futurator.com/v1'
// Algorithm: RS256
// Claims: userId, email, tenantId, role, activeApps, familyId
```

### Error Handling

The broker returns **RFC 7807 Problem Details**:

```json
{
  "type": "https://api.futurator.com/errors/unauthorized",
  "title": "UnauthorizedError",
  "status": 401,
  "detail": "Invalid refresh token",
  "correlationId": "a1b2c3d4-...",
  "timestamp": "2026-04-05T..."
}
```

Always forward `X-Correlation-Id` for debugging. Rate limits apply (see broker quick guide).

---

## Tagging Strategy (Both Patterns)

Every AWS resource across all projects MUST have these tags:

| Tag                      | Purpose            | Example                                 |
| ------------------------ | ------------------ | --------------------------------------- |
| `futurator:project`      | Cost allocation    | `contento`, `mbe`, `admin-hub`          |
| `futurator:environment`  | Environment        | `production`, `staging`                 |
| `futurator:service-role` | Resource purpose   | `compute`, `storage`, `auth`            |
| `futurator:managed-by`   | How it was created | `sst`, `manual`, `cdk`, `deploy-script` |

**Fargate apps:** Add tags in task definitions, CloudFormation, or deploy scripts.
**Serverless apps:** Add tags in `sst.config.ts` via `transform.table.tags` / resource tags.

Use the Admin Hub's tag audit tools to verify compliance:

```bash
npx tsx scripts/tag-audit.ts      # Scan all resources
npx tsx scripts/bulk-tag.ts --dry-run  # Preview tagging
npx tsx scripts/bulk-tag.ts            # Apply tags
```

---

## DynamoDB Conventions (Both Patterns)

| Convention             | Value                                    |
| ---------------------- | ---------------------------------------- |
| Billing mode           | `PAY_PER_REQUEST` (always)               |
| Table naming           | `appname-tablename` (kebab-case)         |
| Design                 | One table per concern (NOT single-table) |
| Attribute naming       | camelCase                                |
| Date storage           | ISO 8601 UTC strings                     |
| Point-in-Time Recovery | Enabled for production data              |

---

## New App Checklist

### Fargate App

- [ ] Choose `appId` (kebab-case, unique across portfolio)
- [ ] Register with Identity Broker (`POST /apps/register`)
- [ ] Save `clientId` and `clientSecret` to SSM
- [ ] Create ECR repository
- [ ] Create S3 source bucket for CodeBuild
- [ ] Create CodeBuild project
- [ ] Create security group (port 3000)
- [ ] Create IAM execution role (ECR + SSM + Logs)
- [ ] Create IAM task role (DynamoDB + S3 + app-specific)
- [ ] Create CloudWatch log group (`/ecs/appname`)
- [ ] Register ECS task definition
- [ ] Create DynamoDB table(s)
- [ ] Add Dockerfile + buildspec.yml to repo
- [ ] Copy deploy script template, change config vars
- [ ] Tag all resources with `futurator:project`
- [ ] First deploy: `bash scripts/deploy.sh`
- [ ] Verify: `https://appname.futurator.ai:3000`

### Serverless App

- [ ] Choose `appId` (kebab-case, unique across portfolio)
- [ ] Register with Identity Broker (`POST /apps/register`)
- [ ] Save `clientId` and `clientSecret` to SSM
- [ ] Create `sst.config.ts` with all resources
- [ ] Set `output: 'export'` in `next.config.ts`
- [ ] Create Lambda functions in `functions/` directory
- [ ] Tag all SST resources with `futurator:project`
- [ ] First deploy: `npx sst deploy --stage prod`
- [ ] Seed data: run seed scripts
- [ ] Verify: `https://appname.futurator.ai`

---

## Cost Summary

| App Type                 | At Rest | Light Use | Always-On |
| ------------------------ | ------- | --------- | --------- |
| Fargate (stopped nights) | ~$0.05  | ~$5-6/mo  | ~$23/mo   |
| Serverless               | $0      | ~$0-1/mo  | ~$1-5/mo  |
| Identity Broker          | $0      | ~$0       | ~$0       |

**Portfolio target:** Keep total AWS spend under control by:

1. Using serverless for all new admin/dashboard tools
2. Scheduling Fargate tasks to stop overnight (via Admin Hub scheduler)
3. Monitoring costs in Admin Hub daily
4. Tagging everything for per-project cost allocation

---

## Rollback Procedures

### Fargate

```bash
# List available image tags
aws ecr list-images --repository-name appname/web --region us-east-1 \
  --query 'imageIds[*].imageTag' --output table

# Stop broken task + start previous version
bash scripts/deploy.sh stop
aws ecs run-task --cluster applicator-staging --task-definition appname \
  --overrides '{"containerOverrides":[{"name":"appname-web","image":"835745294770.dkr.ecr.us-east-1.amazonaws.com/appname/web:PREVIOUS_TAG"}]}' \
  --network-configuration '...' --region us-east-1
```

### Serverless

```bash
# SST keeps deployment history — redeploy previous commit
git checkout <previous-commit>
npx sst deploy --stage prod

# Or remove and redeploy
npx sst remove --stage prod
git checkout main
npx sst deploy --stage prod
```

---

## Reference Architecture Diagram

```
                    futurator.ai (Route 53 Hosted Zone)
                    ┌────────────────────────────────────────────┐
                    │                                            │
                    │  FARGATE APPS:                             │
                    │  mbe.futurator.ai:3000 ──→ Fargate IP     │
                    │  contento.futurator.ai:3000 ──→ Fargate IP│
                    │  ...                                       │
                    │                                            │
                    │  SERVERLESS APPS:                          │
                    │  admin.futurator.ai ──→ CloudFront dist    │
                    │                                            │
                    │  SHARED SERVICES:                          │
                    │  Identity Broker ──→ API Gateway           │
                    └────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  ECS Cluster: applicator-staging                                │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐                       │
│  │ MBE Task │ │Contento  │ │Applicator│  ... (Fargate apps)   │
│  │ 1vCPU/2GB│ │ Task     │ │ Task     │                       │
│  │ :3000    │ │ :3000    │ │ :3000    │                       │
│  └────┬─────┘ └────┬─────┘ └────┬─────┘                       │
└───────┼─────────────┼────────────┼─────────────────────────────┘
        │             │            │
        ▼             ▼            ▼
  ┌──────────────────────────────────────┐
  │  Shared Data Layer                   │
  │  ├── DynamoDB (per-app tables)       │
  │  ├── S3 (per-app buckets)            │
  │  ├── SSM Parameter Store (secrets)   │
  │  └── CloudWatch Logs                 │
  └──────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Serverless Apps (no VPC, no ECS)                               │
│                                                                  │
│  Admin Hub:                                                      │
│  CloudFront → S3 (static) + API Gateway → Lambda (Hono)        │
│                                                                  │
│  Identity Broker:                                                │
│  API Gateway → Lambda (CDK-managed)                              │
│                                                                  │
│  EventBridge cron → Lambda (cost/resource/tag/user sync)         │
└─────────────────────────────────────────────────────────────────┘
```

---

_This playbook is the single source of truth for deploying Futurator apps. Both Fargate and Serverless patterns are first-class citizens. Choose based on app requirements, not habit._

_v2 — April 2026 — Richie_
