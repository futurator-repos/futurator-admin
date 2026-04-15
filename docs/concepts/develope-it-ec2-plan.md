# Develope-IT — EC2 Daemon Integration Plan

**Goal:** Let the user toggle the Labs Agentic Workflow between running the daemon on their local Mac (current) or on a managed EC2 instance in AWS. When EC2 mode is enabled, the infrastructure starts the instance, runs the daemon on it, processes the epic, and then auto-stops the instance when work is done.

**Status:** In progress
**Project tag:** `develope-it`
**Owner (current session):** Claude Code agent

---

## Context

We've built an agentic workflow module that orchestrates multiple Claude Code CLI sessions via a Node.js daemon. The daemon polls DynamoDB for pending jobs and spawns `claude -p` subprocesses with `stream-json` output. Today it runs on the user's Mac. We want a cloud-hosted option so work can happen without the user's machine being online.

The current local flow:

```
Browser ─(POST job)─▶ Lambda ─(write)─▶ DynamoDB
                                            │
                                Local daemon ─(poll)─▶ DynamoDB
                                            │
                                            └─▶ spawn `claude -p`
```

New EC2 flow (what we're building):

```
Browser ─(toggle: EC2)─▶ Lambda /ec2/enable
                               │
                               ├─▶ ec2:StartInstances
                               ├─▶ wait for running
                               └─▶ ssm:SendCommand → daemon start

EC2 daemon ─(poll)─▶ DynamoDB ─(jobs)─▶ spawn `claude -p` on EC2

Epic completes ─▶ Browser ─(or Lambda)─▶ /ec2/disable
                                             │
                                             └─▶ ec2:StopInstances
```

---

## Infrastructure

### EC2 instance (existing, repurposed)

| Field          | Value                                          |
| -------------- | ---------------------------------------------- |
| Instance ID    | `i-0826d68c316ae97dd`                          |
| Name tag       | `debatator-memgraph` (original name, kept)     |
| Project tag    | `develope-it` (added)                          |
| Type           | `t4g.small` (ARM64)                            |
| OS             | Ubuntu 24.04 ARM64 (`ami-00cdb36f35bd8af7d`)   |
| Elastic IP     | `54.86.226.233`                                |
| Subnet         | `subnet-0b5d0e0a050901c02`                     |
| Security Group | `sg-018c22d0f268746f4`                         |
| IAM role       | `develope-it-ec2-ssm` (added)                  |
| State at start | Stopped (on purpose — we start/stop on demand) |

The user explicitly authorized reusing this instance for prototyping.

### IAM role `develope-it-ec2-ssm`

Attached to the instance, grants:

- `AmazonSSMManagedInstanceCore` — allows SSM agent to register + receive commands
- Inline `dynamodb-access` policy — read/write on `futurator-agent-jobs` + `futurator-agent-events` (so the daemon can poll jobs)

Instance profile: `develope-it-ec2-ssm`

### Lambda (Api function) — new permissions needed

Add these actions to the existing Lambda role (`futurator-admin-production-ApiRole-...`):

- `ec2:StartInstances` on `i-0826d68c316ae97dd`
- `ec2:StopInstances` on `i-0826d68c316ae97dd`
- `ec2:DescribeInstances` on `*` (describe doesn't support resource-level)
- `ec2:DescribeInstanceStatus` on `*`
- `ssm:SendCommand` on the instance + on `AWS-RunShellScript` document
- `ssm:GetCommandInvocation` on `*`

### DynamoDB heartbeat differentiation

The daemon writes a heartbeat to `DAEMON_HEARTBEAT` in the jobs table every poll. Add a `source` field: `local` or `ec2`. The UI status indicator reads this to show which daemon is alive.

### Claude Code on EC2

Installed via bootstrap script:

```bash
# Node.js 22 arm64
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# Claude Code CLI
sudo npm install -g @anthropic-ai/claude-code

# Daemon dependencies
cd /opt/futurator-daemon && npm install
```

**Authentication:** On first use, the user must run `claude auth login` interactively on the EC2 instance. We'll provide a documented path using SSM Session Manager. After that, the OAuth refresh token persists in `~/.claude/` and subsequent runs don't require re-auth until the token expires.

### Daemon location on EC2

`/opt/futurator-daemon/` owned by `ubuntu` user. Contains:

- `agent-daemon.mjs` (same file as local)
- `package.json`
- `node_modules/`
- `.env` with `AGENT_JOBS_TABLE=futurator-agent-jobs`, `AGENT_EVENTS_TABLE=futurator-agent-events`, `AWS_REGION=us-east-1`, `DAEMON_SOURCE=ec2`

**Systemd unit:** `/etc/systemd/system/futurator-daemon.service` — allows clean start/stop via `systemctl`.

---

## Execution Plan (tasks)

Each task is checkable and self-contained so another agent session can pick up where this one left off.

### Phase 1 — Infrastructure prerequisites

- [x] Investigate existing EC2 instance (tags, IAM, state) — done, see Infrastructure section
- [x] Create IAM role `develope-it-ec2-ssm` with SSM + DynamoDB permissions
- [x] Create instance profile + associate with instance `i-0826d68c316ae97dd`
- [x] Tag instance with `Project=develope-it`

### Phase 2 — Bootstrap EC2

- [ ] Start the instance once to run the bootstrap (can stop after)
- [ ] Wait for SSM agent to come online
- [ ] Send bootstrap script via `ssm:SendCommand`:
  - Install Node.js 22 arm64
  - Install Claude Code CLI globally
  - Create `/opt/futurator-daemon/`
  - Upload/write `agent-daemon.mjs` + `package.json`
  - `npm install` in daemon dir
  - Write `.env` file
  - Create systemd unit `futurator-daemon.service`
  - `systemctl daemon-reload && systemctl enable futurator-daemon`
- [ ] Document how to run `claude auth login` once via SSM Session Manager
- [ ] User runs `claude auth login` manually one time

### Phase 3 — Lambda API endpoints

- [ ] Add IAM permissions to Lambda role:
  - `ec2:StartInstances`, `ec2:StopInstances`, `ec2:DescribeInstances`
  - `ssm:SendCommand`, `ssm:GetCommandInvocation`
- [ ] New endpoints in `functions/api/index.ts`:
  - `POST /api/ec2/enable` → start instance, wait for running, send SSM command to `systemctl start futurator-daemon`
  - `POST /api/ec2/disable` → SSM command `systemctl stop futurator-daemon`, then `ec2:StopInstances`
  - `GET /api/ec2/status` → returns `{ state, running, daemonAlive, publicIp }`
- [ ] Config: store `EC2_INSTANCE_ID` env var on Lambda

### Phase 4 — UI integration

- [ ] Add runtime toggle to Labs page header (next to daemon status):
  - `Local` (current) ↔ `EC2`
  - Persists in localStorage
- [ ] When toggled to `EC2`:
  - Call `/api/ec2/enable`
  - Show "Starting EC2..." with spinner
  - Poll `/api/ec2/status` until `daemonAlive: true`
- [ ] When toggled to `Local`:
  - If previously EC2, call `/api/ec2/disable`
  - Show confirmation "EC2 stopped"
- [ ] Daemon status indicator shows source (Local or EC2)
- [ ] Auto-disable EC2 when epic fully completes (YOLO chain: PO done + dev server done → disable EC2)

### Phase 5 — Daemon enhancements

- [ ] Daemon writes `source` field in heartbeat (`local` or `ec2`, from env var)
- [ ] Daemon auto-creates working directory if it doesn't exist (`mkdir -p`)
- [ ] (Optional) Daemon logs to `/var/log/futurator-daemon.log` on EC2

### Phase 6 — Auth helper

- [ ] Document the `claude auth login` flow via SSM Session Manager
- [ ] (Stretch) Add "Re-auth EC2" button that opens an SSM session

### Phase 7 — Testing

- [ ] End-to-end test: toggle EC2, load epic, verify daemon runs on EC2, verify auto-stop after completion
- [ ] Verify cost (EC2 runs only for epic duration)
- [ ] Verify working directory auto-creation works
- [ ] Verify dev server startup works on EC2 (note: localhost URLs won't be reachable from user's browser — may need SSH tunnel or skip dev server on EC2 mode)

---

## Known risks / open questions

1. **Dev server + localhost:** The "Start Dev Server" action starts the Vite server. On local daemon, the user can open `http://localhost:5173` in their own browser. On EC2, localhost is inside the instance — not reachable from the user's browser without SSH tunnel, port forwarding, or a public listen address. **Proposed solution:** When on EC2, skip dev server or show public IP URL with a warning about security groups.

2. **Claude Code OAuth session:** The OAuth token has a limited lifetime (unsure of exact TTL). When it expires, the daemon will fail. Solution: add a "re-auth" button that triggers `claude auth login` via SSM session.

3. **Concurrent daemons:** If the user accidentally runs both local and EC2 daemons, they'll both poll DynamoDB and race for jobs. Mitigation: check `source` in heartbeat — if both heartbeats are fresh, warn the user.

4. **EC2 cost tracking:** `t4g.small` at ~$0.0168/hr. For a typical epic (~15-30 minutes), cost is ~$0.008. Negligible but should be visible in the UI for transparency.

5. **SSM command latency:** `ssm:SendCommand` is async. We poll `ssm:GetCommandInvocation` for completion. Add a 30s timeout.

---

## Handoff notes (for future sessions / agents)

- The EC2 instance is in us-east-1, tagged `Project=develope-it`
- The instance profile `develope-it-ec2-ssm` is already attached
- The Lambda function is `futurator-admin-production-ApiFunction-zdmmuxuc`
- Lambda role is `futurator-admin-production-ApiRole-bddrwzcu`
- The daemon code is at `daemon/agent-daemon.mjs` in this repo — same file that runs locally
- DynamoDB tables are `futurator-agent-jobs`, `futurator-agent-events`, `futurator-epic-workflows`
- Don't delete the local daemon path — it's still the default
- The user's login may expire periodically (Identity Broker session)
