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
