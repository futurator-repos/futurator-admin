# EC2 Authentication Lifecycle — Problems & Solutions

## Current Architecture

The Futurator-Admin daemon on EC2 spawns Claude Code CLI processes to execute agentic pipelines. Each `claude` invocation needs valid Anthropic credentials to call the Claude API.

```
┌─────────────────┐     ┌──────────────────────┐     ┌────────────────┐
│  Mac (Ricardo)   │     │  EC2 (t2.micro)       │     │  Anthropic API  │
│                  │     │                       │     │                 │
│  macOS Keychain  │────>│  .credentials.json    │────>│  Claude models  │
│  (OAuth tokens)  │ SSM │  (copied file)        │ API │                 │
│                  │     │                       │     │                 │
│  Claude Code     │     │  Daemon → claude CLI  │     │                 │
│  (auto-refreshes)│     │  (reads file on exec) │     │                 │
└─────────────────┘     └──────────────────────┘     └────────────────┘
```

### How credentials flow today

1. User runs Claude Code locally on Mac → Anthropic OAuth login → tokens stored in macOS Keychain under `Claude Code-credentials`
2. Tokens contain `accessToken` (short-lived, ~hours) and `refreshToken` (longer-lived, ~days)
3. Claude Code on Mac auto-refreshes tokens on each use and writes back to Keychain
4. To authorize EC2: user manually copies Keychain → pastes in admin UI → API base64-encodes → SSM writes to `/home/ubuntu/.claude/.credentials.json`
5. Daemon spawns `claude -p "..." --model haiku` → Claude CLI reads `.credentials.json` → calls Anthropic API

### Authentication methods Claude Code supports

| Method              | Env/Config                          | Expiration           | Billing                                      |
| ------------------- | ----------------------------------- | -------------------- | -------------------------------------------- |
| **OAuth (current)** | `.credentials.json` in `~/.claude/` | Hours to days        | Claude Max subscription ($100/mo or $200/mo) |
| **API Key**         | `ANTHROPIC_API_KEY` env var         | Never                | Pay-per-token (Anthropic Console billing)    |
| **API Key Helper**  | `apiKeyHelper` in `--settings`      | Depends on helper    | Depends on provider                          |
| **AWS Bedrock**     | AWS credentials                     | IAM role (no expiry) | AWS Marketplace billing                      |
| **GCP Vertex AI**   | GCP service account                 | SA key (no expiry)   | GCP billing                                  |

---

## Problems Identified

### Problem 1: OAuth tokens expire and there's no refresh mechanism on EC2

**Evidence:** PM Agent failed with "Not logged in - Please run /login" on 3 separate occasions during the Chrome Dinosaur epic (April 15-16). Each failure required manual intervention — either re-pasting credentials from the admin UI or running `security find-generic-password` + SSM from a local Claude Code session.

**Root cause:** The `.credentials.json` file on EC2 is a static copy. When the `accessToken` expires, Claude CLI on EC2 cannot refresh it because:

- The refresh flow requires writing back to the credential store
- Claude Code on EC2 runs in `--output-format stream-json` mode (non-interactive)
- There is no Keychain on Linux — the file is just a flat JSON file
- Even if Claude CLI could refresh the token and write it back to the file, concurrent daemon processes reading the same file could hit race conditions

**Impact:** Every 12-24 hours, all agent work stops until a human pushes fresh credentials. For an overnight YOLO run, this means guaranteed failure.

### Problem 2: Manual credential transfer is error-prone

**Evidence:** On April 15, the admin UI's "Re-authorize" modal produced a **235-byte truncated file** instead of the correct 471-byte credential JSON. The truncation happened because the Keychain command output was incorrectly parsed during the base64 encode/decode cycle in the `/api/ec2/refresh-credentials` Lambda endpoint.

**Root cause:** The flow has 5 serialization steps, each a potential corruption point:

1. `security find-generic-password -w` → raw JSON to clipboard
2. User pastes into textarea (browser may modify whitespace/encoding)
3. Frontend sends as JSON string in POST body
4. Lambda base64-encodes the string
5. SSM command decodes and writes to file

Any of these can truncate, double-encode, or mangle the JSON.

**Impact:** Daemon launches Claude processes that silently fail with $0 cost and empty output. The failure surfaces as "PM Agent Failed" with no indication that auth was the cause.

### Problem 3: Credential refresh kills running agent work

**Evidence:** On April 15, user clicked "Re-authorize" while Wave 1 had 5 active stories. The `/api/ec2/refresh-credentials` endpoint runs `sudo systemctl restart futurator-daemon`, which sends SIGTERM to the daemon, killing all 5 Claude processes. Jobs marked FAILED, work lost.

**Root cause:** The refresh endpoint unconditionally restarts the daemon:

```javascript
const writeCmd = [
  `echo '${b64}' | base64 -d > /home/ubuntu/.claude/.credentials.json`,
  'chown ubuntu:ubuntu /home/ubuntu/.claude/.credentials.json',
  'sudo systemctl restart futurator-daemon', // ← kills everything
].join(' && ');
```

**Impact:** Re-authorizing during active work destroys all in-flight jobs. Users learn to avoid re-authorizing, which means they wait until everything is stuck before fixing auth — maximizing wasted time.

### Problem 4: No visibility into auth state

**Evidence:** The admin UI shows "Daemon: green/red" and "EC2: running" but has no indicator for whether Claude Code credentials are valid. The user only discovers expired credentials when a PM job fails with "PM agent produced no epic" — a misleading error message that doesn't mention auth.

**Root cause:** The daemon doesn't validate credentials on startup or during heartbeats. It discovers expired tokens only when a spawned `claude` process returns "Not logged in" — by which time the job is already counted as an attempt.

**Impact:** Users waste 5-15 minutes per occurrence discovering the root cause. The forensic pattern is always: (1) PM/DEV fails with $0 cost, (2) user checks daemon logs, (3) finds "Not logged in", (4) re-authorizes, (5) retries.

### Problem 5: Claude Max subscription tokens are not designed for server-side use

**Evidence:** The OAuth token format (`sk-ant-oat01-...` / `sk-ant-ort01-...`) is from Claude's consumer OAuth flow, designed for interactive desktop use where the app can re-authenticate via browser. Server-side use (headless daemon) was never the intended use case.

**Root cause:** Claude Code's auth system is built around: (1) interactive browser login, (2) Keychain/credential-store persistence, (3) automatic background refresh. None of these work on a headless Linux server.

---

## Proposed Solutions

### Option A: Anthropic API Key

**Mechanism:** Generate an API key at `console.anthropic.com`, store it in the daemon's `.env` file as `ANTHROPIC_API_KEY`. Claude Code CLI uses this key directly (especially with `--bare` flag).

**Advantages:**

- API keys never expire — zero auth maintenance
- No credential transfer needed — set once, works forever
- No Keychain dependency — works on any Linux server
- No daemon restart on credential change
- Standard industry pattern for server-side API access

**Disadvantages:**

- **Billing shifts from Max subscription to pay-per-token** — the Chrome Dinosaur epic cost $5.56 in agent work. At API rates (Haiku: $0.25/$1.25 per MTok in/out, Sonnet: $3/$15) this is real money
- If already paying for Max subscription, the API key means paying twice (subscription + API usage)
- API keys are a security-sensitive secret — needs proper secrets management (SSM Parameter Store, not a flat .env file)
- Rate limits differ between Max subscription and API tier

**Cost estimate (Chrome Dinosaur equivalent):**

- 10 stories × ~$0.47/story average = ~$4.70
- QA + build checks = ~$0.87
- **Total: ~$5.57 per epic at API rates** (roughly the same as the observed Max subscription usage, since Max doesn't actually charge per-token)

**Implementation complexity:** Low — one env var change + daemon restart.

### Option B: Automated Mac-to-EC2 credential sync

**Mechanism:** A cron job on the Mac runs every 4-6 hours, extracts fresh tokens from Keychain, and pushes them to EC2 via SSM. Since Claude Code on Mac auto-refreshes tokens on each use, the Keychain always has fresh tokens as long as Claude Code runs locally at least once per day.

```
┌─ Mac cron (every 4h) ────────────────────────────────────────┐
│ 1. security find-generic-password -s "Claude Code-credentials" -w │
│ 2. base64 encode                                                    │
│ 3. aws ssm send-command → write to EC2                              │
└─────────────────────────────────────────────────────────────────┘
```

**Advantages:**

- Keeps billing on Max subscription (no API key cost)
- Automated — no manual paste required
- Fresh tokens every 4 hours — well within expiration window
- No daemon restart needed (Claude CLI reads credentials per-invocation)

**Disadvantages:**

- **Depends on Mac being powered on and connected** — if Mac sleeps, cron doesn't run, tokens eventually expire
- Requires local AWS CLI credentials to be valid (SSM access)
- Adds a moving part outside the Futurator-Admin codebase (Mac crontab)
- Tokens still expire during long weekends or travel
- If Keychain tokens themselves expire (Max subscription lapses, password change), the automation breaks silently

**Implementation complexity:** Low — one shell script + `crontab -e`.

### Option C: Daemon-side token refresh

**Mechanism:** Modify the daemon to detect "Not logged in" errors from Claude CLI, and when detected, use the `refreshToken` in `.credentials.json` to call Anthropic's token refresh endpoint directly, write back the new `accessToken`, and retry the job.

**Advantages:**

- Self-healing — no external dependency
- Keeps Max subscription billing
- No Mac dependency after initial setup
- No cron jobs or external infrastructure

**Disadvantages:**

- **Anthropic's OAuth refresh endpoint is undocumented** — would need to reverse-engineer Claude Code's refresh flow
- The `refreshToken` itself eventually expires (typically 30-90 days), at which point manual re-auth is required anyway
- Adds complexity to the daemon's error handling
- If Anthropic changes their OAuth flow, the custom refresh breaks

**Implementation complexity:** Medium-high — reverse-engineering OAuth flow, error handling, token file locking.

### Option D: AWS Bedrock (Claude via AWS)

**Mechanism:** Instead of calling Anthropic's API directly, route Claude requests through AWS Bedrock. Authentication uses IAM roles attached to the EC2 instance — no tokens, no keys, no expiration.

**Advantages:**

- **Zero auth maintenance** — IAM role never expires
- Native AWS integration — EC2 instance role provides credentials automatically
- No secrets to manage — no .env files, no Keychain, no API keys
- Claude Code supports Bedrock via `CLAUDE_CODE_USE_BEDROCK=1` env var
- Billing through existing AWS account

**Disadvantages:**

- **Bedrock pricing is different** from direct API — may be more expensive
- Need to enable Claude models in Bedrock console (model access request)
- Bedrock may have different rate limits or model availability
- Some Claude Code features may not work identically through Bedrock
- Adds AWS Bedrock dependency to the infrastructure

**Implementation complexity:** Medium — Bedrock model access setup, IAM policy, env var changes.

### Option E: Hybrid — API Key for daemon, Max subscription for interactive

**Mechanism:** Use an Anthropic API key specifically for the daemon (server-side agent work), while keeping the Max subscription for local interactive Claude Code use. The daemon's `.env` gets `ANTHROPIC_API_KEY`, local Mac continues using OAuth/Keychain.

**Advantages:**

- Clean separation of concerns — server work vs. interactive work
- API key for daemon = never expires, zero maintenance
- Max subscription for interactive = included in plan, no per-token cost for development work
- Can monitor server-side API usage separately in Anthropic Console
- Can set spending limits on the API key

**Disadvantages:**

- Two billing sources (Max subscription + API usage)
- API key cost for agentic pipelines could be significant at scale (but controllable via spending limits)
- Need to manage API key rotation policy (recommended every 90 days even though keys don't expire)

**Implementation complexity:** Low — same as Option A for the daemon. No changes to local setup.

---

## Comparison Matrix

| Criterion             | A: API Key      | B: Mac Sync                | C: Self-Refresh | D: Bedrock  | E: Hybrid       |
| --------------------- | --------------- | -------------------------- | --------------- | ----------- | --------------- |
| Auth maintenance      | None            | Cron setup                 | None            | None        | None            |
| Expires?              | Never           | Every 4-12h (auto-renewed) | Every 30-90d    | Never (IAM) | Never           |
| Mac dependency        | No              | Yes                        | No              | No          | No              |
| Billing               | API (per-token) | Max sub                    | Max sub         | AWS Bedrock | API + Max       |
| Implementation effort | Low             | Low                        | High            | Medium      | Low             |
| Reliability           | High            | Medium                     | Medium          | High        | High            |
| Works offline/travel  | Yes             | No                         | Partially       | Yes         | Yes             |
| Secrets management    | API key in .env | OAuth tokens               | OAuth tokens    | IAM role    | API key in .env |

---

## Immediate Fix (regardless of chosen solution)

These should be done now to reduce pain:

1. **Add auth health check to daemon heartbeat** — on startup and every 5 minutes, run a lightweight `claude -p "ok" --model haiku` test. Write `authValid: true/false` to the heartbeat. Show a red "Auth Expired" badge in the admin UI.

2. **Remove `systemctl restart` from credential refresh** — just write the file. Claude CLI reads credentials per-invocation, so a daemon restart is unnecessary and destructive.

3. **Show auth-specific error messages** — when a job completes with $0 cost and "Not logged in" in the output, surface "Claude credentials expired — re-authorize from EC2 settings" instead of the generic "PM agent produced no epic".
