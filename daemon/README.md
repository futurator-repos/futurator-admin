# Futurator Agent Daemon

Local daemon that polls DynamoDB for pending agent orchestrator jobs and executes them using the Claude Code CLI.

## Prerequisites

- **Node.js 20+**
- **Claude Code CLI** installed and authenticated via OAuth (`claude auth login`)
- **AWS credentials** configured (`~/.aws/credentials` or env vars) with DynamoDB read/write access to `futurator-agent-jobs` and `futurator-agent-events` tables

## Setup

```bash
cd daemon
cp .env.example .env
# Edit .env — table names should already be correct if you used explicit names
npm install
```

## Run

```bash
npm start
# or with auto-restart on file changes:
npm run dev
```

The daemon will:

1. Poll `futurator-agent-jobs` every 3s for `PENDING` jobs
2. Execute the A → B → A(resumed) pipeline using `claude -p`
3. Stream events to `futurator-agent-events` in real time
4. Mark the job as `COMPLETED` or `FAILED`

## How it works

```
Web App → creates PENDING job in DynamoDB
Daemon  → picks up job, spawns `claude -p "..." --output-format stream-json`
        → parses NDJSON output, pushes each event to DynamoDB
        → Agent A runs → Agent B runs with A's output → Agent A resumes with B's feedback
Web App → polls events table, renders live output
```

No inbound ports are opened on your Mac. The daemon only makes outbound calls to DynamoDB.

## Stopping

Press `Ctrl+C`. The daemon will gracefully mark any in-progress job as `FAILED` before exiting.

## Free Agent worktree GC (Story 18.1 — Epic 18)

The free-agent chat widget creates per-session git worktrees under
`/home/ubuntu/free-agent-worktrees/<projectId>/<sessionId>/` (one per session)
on branches `assist/<projectId>/<sessionId>`. These accumulate over time and
need periodic cleanup.

**Scheduled GC.** Story 18.2 will wire the GC to run daily inside the daemon
loop (~03:00 UTC). The GC logic itself ships in Story 18.1 at
`daemon/lib/free-agent-gc.mjs:runFreeAgentGc`; until 18.2 wires the
scheduler, the function is callable but not automatically triggered.

**Reap policy** (`daemon/lib/free-agent-gc.mjs`):

- Reap any worktree whose session shows `status IN (IDLE, EXPIRED, BUDGET_EXHAUSTED)`
  AND `lastActivityAt > 7 days ago`
- Remove any worktree with no corresponding DDB session row (orphan)
- Never reap a session whose status is `ACTIVE` or `PROCESSING`, regardless
  of age (operator may be in a long-running investigation)

**Manual reap (operator-facing).** If you need to remove a single session's
worktree by hand (debugging, runaway session, etc.):

```bash
cd /home/ubuntu/futurator-admin
node -e "
  import('./daemon/pipelines/lib/free-agent-worktree.mjs').then(m =>
    m.reapWorktree({ projectId: 'dino-7', sessionId: 'sess-abc' })
  )
"
```

The reap is idempotent — `git worktree remove --force` plus `git branch -D`,
with an `fs.rmSync` fallback for orphans. "Not found" errors are silently
treated as success.

**Manual GC run (operator-facing).** To trigger a full sweep on demand:

```bash
node -e "
  import('./daemon/lib/free-agent-gc.mjs').then(async m => {
    const result = await m.runFreeAgentGc();
    console.log(JSON.stringify(result, null, 2));
  })
"
```

Default behavior (pre-Story-18.2): treats all worktrees as orphans because
no sessions table exists yet → cleans everything on disk.

## Brownfield Party PAT (Story 15.4)

Brownfield Party projects clone private GitHub repos using a fine-grained
Personal Access Token loaded once at daemon startup from AWS Secrets
Manager. The daemon reads the secret name from `BROWNFIELD_PAT_SECRET_NAME`
(default `futurator/labs-brownfield-github-pat`).

**One-time operational setup** (NOT shipped in any PR — operator runs this
out-of-band):

1. Create a fine-grained GitHub PAT scoped `contents:read` on exactly the
   four current target repos: `debatator`, `applicator`, `songster`,
   `futurator`. No other scopes. No org-wide access.

2. Store the PAT in AWS Secrets Manager:

   ```bash
   aws secretsmanager create-secret \
     --name futurator/labs-brownfield-github-pat \
     --description 'Fine-grained PAT for brownfield Party projects (contents:read on debatator/applicator/songster/futurator)' \
     --secret-string '<paste-token-here>'
   ```

3. Grant the daemon's EC2 IAM role `secretsmanager:GetSecretValue` on the
   secret ARN. The SST config declares `sst.Secret('BrownfieldGithubPat')`
   for the API Lambda's link, but the EC2 daemon role is managed outside
   SST — attach the policy manually:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Effect": "Allow",
         "Action": "secretsmanager:GetSecretValue",
         "Resource": "arn:aws:secretsmanager:us-east-1:835745294770:secret:futurator/labs-brownfield-github-pat-*"
       }
     ]
   }
   ```

If the secret is missing or IAM denies access, the daemon logs a warning
on startup and continues. Greenfield Party jobs are unaffected; only
brownfield bootstrap and refresh jobs will fail with a clear "PAT not
loaded" error.

**Secrets hygiene:** the PAT lives only in Secrets Manager and in
in-memory daemon state. It is never written to DDB rows, never logged,
and never included in event payloads. The git-clone helper
(`daemon/pipelines/lib/git-clone.mjs`) redacts the raw token and the
tokenized URL form (`https://x-access-token:<token>@...`) before passing
captured stdout/stderr to the event spine.

### Migration Runner

For first-time migration of a brownfield repo, prefer the one-shot
runner over hand-running each step:

```bash
# From the admin repo root:
npm run migrate-brownfield -- \
  --path ~/code/applicator \
  --pat-file ~/.brownfield-pat \
  --token <jwt-from-browser-devtools>
```

The runner is idempotent. It will:

1. Pre-flight check the local clone (git repo present, BMAD installed,
   origin remote is HTTPS GitHub, branch resolved, name kebab-case, PAT
   prefix looks right, admin JWT shaped like a JWT).
2. Ensure the AWS Secrets Manager secret exists (or rotate it with
   `--rotate-pat`).
3. Print the `aws iam put-role-policy` command for the daemon EC2 role
   on first run, then exit. Re-run with `--skip-iam-check` once you've
   attached it (the runner doesn't auto-escalate IAM privileges).
4. Verify the admin API is reachable.
5. Register the project via `POST /api/party/projects` (or skip if
   already registered as brownfield).
6. Stream `party.bootstrap.*` events until terminal.
7. Verify `bmadStatus=HEALTHY` and that `lastCommitSha` matches local
   HEAD.

For pulling subsequent updates after pushing from your laptop, use
`--refresh`:

```bash
npm run migrate-brownfield -- --path ~/code/applicator --refresh \
  --token <jwt>
```

See `docs/concepts/brownfield-migration-runner-plan.md` for the full
design rationale.
