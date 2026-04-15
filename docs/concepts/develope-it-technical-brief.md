# Develope-IT — Technical Brief

## Prototype Briefing

**What it is:** A web-based platform that takes a product idea in plain English and autonomously builds, reviews, and deploys a working web application — no local development environment needed.

**What it proves:** Multiple isolated Claude Code CLI sessions can be orchestrated from a browser, communicate through a shared variable store, execute in parallel waves, and produce production-ready code on remote infrastructure.

**Current state:** Working prototype, tested end-to-end. Two games (Brick Breaker, Guess the Number) were built from idea to deployed app at `futurator.ai/apps/` without human code intervention.

**Key insight:** The value is not in running one agent — it's in orchestrating many agents with different roles (PM, Dev, Reviewer, PO, DevOps) that hand off structured data between each other, with the human staying at the strategic level.

---

## Architecture Overview

```
Browser (admin.futurator.ai)
   │
   │  User types: "Build me a guess-the-number game"
   │
   ▼
Lambda API (Hono on Function URL)
   │
   ├─► DynamoDB: epic-workflows (epic + stories + state)
   ├─► DynamoDB: agent-jobs (pipeline definitions + results)
   └─► DynamoDB: agent-events (streaming tool calls + text)
          │
          │  Daemon polls every 3s
          ▼
EC2 Daemon (Node.js, systemd)
   │
   ├─► Spawns: claude -p "..." --output-format stream-json
   ├─► Parses NDJSON stdout → pushes events to DynamoDB
   ├─► Runs extractors (regex/delimiters) on agent output
   ├─► Runs validations (equals/contains/not_contains)
   └─► Supports loop-back on validation failure (retry)

Browser polls events → renders live tool calls, thoughts, results
```

---

## AWS Services Used

| Service                   | Purpose                                   | Resource                         |
| ------------------------- | ----------------------------------------- | -------------------------------- |
| **S3 + CloudFront**       | Static site hosting for admin hub         | `admin.futurator.ai`             |
| **S3 + CloudFront**       | Published app hosting                     | `futurator.ai/apps/{name}/`      |
| **Lambda** (Function URL) | API backend (Hono router)                 | Single function, arm64, 256MB    |
| **DynamoDB**              | Epic workflows, agent jobs, agent events  | 3 tables, pay-per-request        |
| **EC2**                   | Remote daemon + Claude Code execution     | `t4g.small`, Ubuntu 24.04, arm64 |
| **SSM**                   | Remote command execution on EC2           | SendCommand for daemon control   |
| **IAM**                   | EC2 instance role for DynamoDB + S3 + SSM | `develope-it-ec2-ssm`            |
| **Route53**               | DNS for `*.futurator.ai`                  | Existing hosted zone             |

---

## Claude Code on EC2

**Installation:**

- Node.js 22 (arm64) via NodeSource
- `npm install -g @anthropic-ai/claude-code` → `/usr/bin/claude`
- AWS CLI v2 (arm64) for S3/CloudFront operations

**Authentication:**

- OAuth flow: `claude auth login` generates a URL, user authenticates in browser, credentials stored in `~/.claude/.credentials.json`
- Credentials were transferred from the user's Mac Keychain to EC2 via SCP
- Refresh token persists across daemon restarts

**Daemon setup:**

- Code at `/opt/futurator-daemon/agent-daemon.mjs`
- Managed by systemd (`futurator-daemon.service`)
- Environment: `AWS_REGION`, table names, `DAEMON_SOURCE=ec2`
- Spawns claude via `spawn(process.execPath, ['/usr/bin/claude', ...args])` (avoids shell interpretation of prompt text)
- Concurrency: up to 5 parallel jobs

---

## Agent Roles

| Agent               | Model        | Tools                               | Purpose                                                                                              |
| ------------------- | ------------ | ----------------------------------- | ---------------------------------------------------------------------------------------------------- |
| **Product Manager** | Sonnet       | Read, Grep, Glob                    | Takes a product idea → generates structured XML epic with stories, dependencies, acceptance criteria |
| **Developer**       | Sonnet       | Bash, Read, Edit, Write, Glob, Grep | Implements one story per session. Fresh session per story.                                           |
| **Reviewer**        | Haiku/Sonnet | Read, Grep, Glob (no write)         | Reviews code against acceptance criteria. Fresh session each review. Can trigger retry loop.         |
| **Product Owner**   | Opus         | Read, Grep, Glob, Bash              | Final acceptance test against epic-level criteria. Runs build to verify compilation.                 |
| **DevOps Deploy**   | Haiku        | Bash, Read                          | Builds app (`npm run build`), uploads to S3, invalidates CloudFront.                                 |
| **DevOps Server**   | Haiku        | Bash                                | Starts dev server on EC2 with `--host 0.0.0.0` for preview.                                          |

---

## Pipeline Engine

Each agent job is a **pipeline** — an ordered list of steps with:

- **Prompt templates** — `{{VARIABLE}}` substitution from a shared variable store
- **Extractors** — regex or delimiter-based capture from agent output → writes to variable store
- **Validations** — assertions between variables (equals, contains, not_contains)
- **Loop-back** — if a step's validation fails, re-run a specified "fix" step then re-check (up to N iterations)
- **Session resume** — a step can `--resume` a previous step's Claude session (preserves context without re-injection)

**Per-story pipeline:**

```
DEV (fresh session) → REVIEWER (fresh session) → [if FAIL → RETRY (resume DEV) → REVIEWER again] → done
```

---

## Parallelism Model

Stories declare dependencies via `depends_on` (e.g., `S1, S2`). The system computes **waves** (topological sort):

- Wave 0: stories with no dependencies (run first)
- Wave N: stories whose dependencies are all in waves 0..N-1

Stories in the same wave are triggered simultaneously. The daemon processes up to 5 concurrent jobs. The server-side YOLO logic (in the GET endpoint) detects completed stories and triggers the next wave automatically — no client-side timing dependencies.

---

## Deployment Flow

```
Epic complete → User clicks "Publish"
  → DeployAgent on EC2:
     1. Sets Vite base path: base: '/apps/{appName}/'
     2. npm run build → dist/
     3. aws s3 sync dist/ s3://futurator-ai-website/apps/{appName}/
     4. aws cloudfront create-invalidation
  → Result: https://futurator.ai/apps/{appName}/
```

Published apps are static (S3 + CloudFront), permanent, HTTPS, globally cached, zero hosting cost.

---

## Data Flow Summary

```
Idea (text)
  → PM Agent → XML epic
  → API parses XML → DynamoDB (epic + stories with waves)
  → YOLO triggers wave 0 stories → daemon picks up jobs
  → DEV agent creates code on EC2 filesystem
  → REVIEWER agent reads code, validates AC
  → [loop if needed]
  → All waves complete → PO agent runs final check
  → Deploy agent builds + uploads to S3
  → CloudFront serves at futurator.ai/apps/{name}/
```

---

## Key Design Decisions

1. **Daemon polls DynamoDB, not the API** — outbound only from EC2, no ports to open, no WebSocket server needed.
2. **One table per concern** — separate tables for jobs, events, epics. No single-table design.
3. **XML for epic structure** — markdown parsing was unreliable with user-pasted content. XML from the PM agent is unambiguous.
4. **Server-side YOLO** — wave advancement happens in the API's GET endpoint (sync-on-read), not in the browser. Avoids race conditions from client-side concurrent mutations.
5. **EC2 toggle** — user can switch between local Mac daemon and EC2 daemon. Same DynamoDB, same job format, same pipeline engine.
6. **`spawn(node, [claude, ...args])`** — avoids both shell interpretation (which breaks prompts with special chars) and shebang issues (which break on Linux without shell).

---

## Known Limitations (for brainstorming)

- **No story editing in UI** — stories come from the PM agent as-is. Adding editable story cards before "Start Development" would let users refine.
- **No incremental deployment** — each "Publish" rebuilds and re-uploads everything. Could diff and upload only changed files.
- **Single EC2 instance** — all jobs run on one `t4g.small`. For heavy parallelism, could scale to multiple instances or use ECS/Fargate.
- **Auth expiry** — Claude Code OAuth tokens expire. Re-auth requires manual intervention via SSH/SSM.
- **No backend apps** — current flow only handles static frontend apps (React/Vite → S3). Server-side apps would need a different deploy target (ECS, Lambda, etc.).
- **No version control** — code is on EC2 filesystem only. Adding git init + commit per story would enable rollback and history.
- **No cost tracking per epic** — individual step costs are tracked but not aggregated at epic level in the UI.
