# Futurator Admin — Deployment Guide

Canonical reference for deploying Futurator-Admin. **Authoritative as of 2026-04-30.** Revise inline when reality drifts.

> **Audience:** any agent or operator deploying this repo. Be specific — copy/paste these commands rather than recalling them from training data.

> **Working directory:** all commands assume `cd /Users/ricardoarayafarias/GetReal/Futurator-Admin` (or wherever this repo lives) unless prefixed otherwise.

---

## TL;DR — three commands cover everything

```bash
# 1. Code-only changes to functions/* or src/* — Lambda + AdminSite + DDB schema
npx sst deploy --stage production

# 2. Code-only changes to daemon/* — EC2 long-running process
bash scripts/rsync-daemon.sh
ssh -i ~/.ssh/debatator-memgraph.pem ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com \
  "sudo systemctl restart futurator-daemon"

# 3. Both
# Run command 1 AND command 2. They are independent — order does not matter.
```

There is no CI pipeline. There are no GitHub Actions. There is no automated pre-deploy gate. **The operator is the deploy gate.**

---

## What deploys where — the full inventory

### SST-managed (single command: `npx sst deploy --stage production`)

| #   | Target                | Type                                                                                                                                                                                                                                                    | Defined in `sst.config.ts` line | Bundle                                                             |
| --- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------ |
| 1   | `Api`                 | Lambda Function URL (256 MB, 30 s, arm64, nodejs22.x)                                                                                                                                                                                                   | 331                             | esbuild from `functions/api/index.ts`                              |
| 2   | `AuthCallback`        | Lambda Function URL (256 MB, 10 s)                                                                                                                                                                                                                      | 495                             | esbuild from `functions/auth/callback.ts`                          |
| 3   | `CostAggregator`      | Cron (06:00 UTC daily) → Lambda (512 MB, 60 s)                                                                                                                                                                                                          | 515                             | esbuild from `functions/cron/cost-aggregator.ts`                   |
| 4   | `ResourceDiscoverer`  | Cron (07:00 UTC daily) → Lambda (512 MB, 120 s)                                                                                                                                                                                                         | 535                             | esbuild from `functions/cron/resource-discoverer.ts`               |
| 5   | `TagAuditor`          | Cron (07:30 UTC daily) → Lambda (512 MB, 60 s)                                                                                                                                                                                                          | 563                             | esbuild from `functions/cron/tag-auditor.ts`                       |
| 6   | `UserSync`            | Cron (08:00 UTC daily) → Lambda (256 MB, 30 s)                                                                                                                                                                                                          | 578                             | esbuild from `functions/cron/user-sync.ts`                         |
| 7   | `AttentionDigest`     | Cron (rate(1 hour)) → Lambda (256 MB, 60 s)                                                                                                                                                                                                             | 603                             | esbuild from `functions/cron/attention-digest.ts`                  |
| 8   | `WaveCompletionCheck` | Cron (rate(1 minute)) → Lambda (256 MB, 120 s)                                                                                                                                                                                                          | 625                             | esbuild from `functions/cron/wave-completion-check.ts`             |
| 9   | `TimingAggregator`    | Cron (rate(6 hours)) → Lambda (512 MB, 300 s)                                                                                                                                                                                                           | 658                             | esbuild from `functions/cron/timing-aggregator.ts`                 |
| 10  | `PatAgeCheck`         | Cron (09:00 UTC daily) → Lambda (256 MB, 30 s)                                                                                                                                                                                                          | 688                             | esbuild from `functions/cron/pat-age-check.ts`                     |
| 11  | `ScheduleExecutor`    | Lambda (256 MB, 120 s, no schedule, no URL — invoked from API)                                                                                                                                                                                          | 713                             | esbuild from `functions/cron/schedule-executor.ts`                 |
| 12  | `AdminSite`           | S3 bucket + CloudFront + Route53 A/AAAA + ACM cert + CF Function + KV Store                                                                                                                                                                             | 736                             | `npm run build` (Next.js static export → `out/`)                   |
| 13  | DynamoDB tables (×18) | `sst.aws.Dynamo` resources                                                                                                                                                                                                                              | 33–328                          | DDB API calls; no bundle                                           |
| 14  | `GithubPat`           | SST Secret (encrypted in Pulumi state, surfaced as Lambda env at deploy)                                                                                                                                                                                | 271                             | Secret value comes from `npx sst secret set` (see below)           |
| 14b | `AnthropicApiKey`     | SST Secret — backs the Debates inline-Q&A endpoint via `claude-haiku-4-5`. Resolved into the `Api` Lambda's `ANTHROPIC_API_KEY` env var at deploy. Without it, `POST /api/party/sessions/:id/inline-questions` returns 503 `ANTHROPIC_API_KEY_MISSING`. | 277                             | `npx sst secret set AnthropicApiKey <sk-ant-…> --stage production` |

### Manually managed (separate commands)

| #   | Target                                                              | Type                                          | Defined in                                   | Bundle                                                      |
| --- | ------------------------------------------------------------------- | --------------------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| 15  | **EC2 daemon** at `/opt/futurator-daemon/` on `i-0826d68c316ae97dd` | Long-running Node.js 22 process under systemd | NOT in `sst.config.ts` — managed out-of-band | rsync, **no transpilation** — source `.mjs` files run as-is |

---

## DynamoDB tables (all created by SST; never recreate manually)

Defined in `sst.config.ts` lines 33–328. Table names are pinned via `transform.table.name` so they survive stack rebuilds:

`futurator-projects`, `futurator-costs`, `futurator-resources`, `futurator-audits`, `futurator-schedules`, `futurator-users`, `futurator-alerts`, `futurator-epic-workflows`, `futurator-project-registry`, `futurator-agent-jobs`, `futurator-agent-events` (TTL on `expireAt`), `futurator-party-projects`, `futurator-party-sessions` (GSI: `GSI1` on `GSI1PK,GSI1SK`), `futurator-party-inline-questions` (GSI: `sessionId-createdAt-index`), `futurator-plans` (GSI: `appId-createdAt-index`), `futurator-apps`, `futurator-attention-items`, `futurator-agent-sessions` (GSI: `jobId-stepId-index`), `futurator-agent-conversations` (GSI: `sessionId-index`), `futurator-timing-summary`.

Adding a new table: edit `sst.config.ts` and run `npx sst deploy --stage production`. Pulumi diffs the schema and creates/modifies tables atomically.

**Do NOT use `aws dynamodb create-table` or `aws dynamodb delete-table` directly** — that produces Pulumi state divergence (we hit this on 2026-04-28). If a table goes wrong, run `npx sst refresh --stage production` to re-sync state from AWS reality.

---

## How each target builds and what it reads from disk

### Lambdas (1–11): esbuild, isolated import-graph

SST bundles each Lambda independently using esbuild. The bundle starts at the file referenced in the `handler` field and follows imports. Tree-shaken — code that no entry imports never lands in the bundle.

- Entry per Lambda: `'<path>.handler'` (e.g., `'functions/api/index.handler'` or `'functions/cron/wave-completion-check.handler'`).
- Output: single `index.mjs` + sourcemap, uploaded as S3 BucketObjectv2 (`ApiCode`, `WaveCompletionCheckHandlerCode`, etc.), then `UpdateFunctionCode`.
- TypeScript path alias `@/*` → `./src/*` (defined in `tsconfig.json`) is **not used by Lambdas** — they use relative imports (`'../shared/...'`).

The same shared file (e.g., `functions/shared/services/wave-reducer.ts`) ends up in **multiple** bundles if imported by multiple Lambdas — each bundle is independent.

### Static site (12): Next.js export, then S3 sync

Build steps inside SST's StaticSite resource (`sst.config.ts:736`):

1. `npm run build` → `next build` → reads `next.config.ts` (`output: 'export'`) → produces `./out/` directory of static HTML + hashed JS chunks.
2. SST runs `aws s3 sync ./out/` to the AdminSite bucket (`futurator-admin-production-adminsiteassetsbucket-czucfmdf` as of 2026-04-30; suffix regenerates on stack rebuild).
3. CloudFront `CreateInvalidation /*`.

`next.config.ts` has `typescript: { ignoreBuildErrors: true }` — **the build does not fail on TypeScript errors.** Run `npm run typecheck` separately if you want type-error gating. Only syntax errors (parse failures) stop the build.

### Daemon (15): rsync, NO build

```bash
rsync -av --delete \
  --exclude node_modules \
  --exclude .env \
  --exclude sst-env.d.ts \
  --exclude '*.log' \
  -e "ssh -i ~/.ssh/debatator-memgraph.pem" \
  $REPO_ROOT/daemon/ \
  ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com:/opt/futurator-daemon/
```

Source `.mjs` files copy verbatim. Node 22 on EC2 executes them directly — no transpilation, no tree-shaking, no minification. After rsync you must restart the systemd unit.

`node_modules` is preserved on the remote. After a `daemon/package.json` change you must SSH in and `cd /opt/futurator-daemon && npm install`.

---

## Shared modules (cross-target imports)

| Path                                              | Imported by                                                |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `functions/shared/repositories/*`                 | API Lambda + every cron Lambda                             |
| `functions/shared/services/wave-reducer.ts`       | API Lambda + WaveCompletionCheck cron                      |
| `functions/shared/services/plan-reducer.ts`       | API Lambda + WaveCompletionCheck cron                      |
| `functions/shared/services/visual-qa-launcher.ts` | API Lambda + WaveCompletionCheck cron                      |
| `functions/shared/services/pipeline-launcher.ts`  | API Lambda + WaveCompletionCheck cron                      |
| `functions/shared/types/*`                        | All Lambdas + AdminSite UI (type-only — zero runtime cost) |
| `functions/shared/timer/*`                        | API Lambda + TimingAggregator cron + AdminSite UI          |
| `functions/shared/boilerplates/registry.ts`       | API Lambda + AdminSite UI                                  |
| `functions/shared/pipelines/*`                    | API Lambda + WaveCompletionCheck cron                      |
| `functions/shared/prompts/*`                      | API Lambda only                                            |

**The daemon does NOT share any code with `functions/**`.** It has parallel implementations (e.g., `daemon/pipelines/lib/review-criteria-parser.mjs`mirrors`functions/shared/services/review-criteria-parser.ts`). Cross-impl parity is enforced by tests, not shared imports.

---

## Pre-deploy gates

The `package.json` defines a full CI gate:

```json
"ci": "npm run lint && npm run format:check && npm run knip && npm run typecheck && npm run test && npm run build"
```

**`npm run ci` is NOT invoked anywhere automatically.** No `.github/workflows/`. The only enforced pre-deploy step is the **husky pre-commit hook** (`.husky/pre-commit`) which runs `npx lint-staged` → eslint+prettier on staged `.ts`/`.tsx` files only.

So:

- Type errors anywhere except staged files: **deploy proceeds.**
- Vitest failures: **deploy proceeds.**
- Knip warnings: **deploy proceeds.**

If you want to gate, run `npm run ci` manually before `npx sst deploy`. Otherwise rely on individual gates:

```bash
npm run typecheck    # tsc --noEmit
npm run test         # vitest run
npm run lint         # eslint --max-warnings 0 .
npm run knip         # find unused exports/deps
```

---

## Per-stack vs. all-at-once

**All-at-once.** A single `npx sst deploy --stage production` processes the entire SST graph in dependency order:

1. Diff Pulumi state (lives in S3) against `sst.config.ts`.
2. Apply DynamoDB schema changes if any.
3. For each Lambda whose source-graph hash changed: bundle, upload, update.
4. For SST secret value changes: re-link to dependent Lambdas.
5. AdminSite: `npm run build` → `aws s3 sync` → CloudFront invalidation.

Pulumi rolls back the entire transaction if any step fails. **If AdminSite fails (step 5), Lambda updates from steps 3–4 are also rolled back at the state level — even though they already executed at the AWS API level.** This created the divergence we hit on 2026-04-28 → 2026-04-30 (PRs 5/6/7) where Lambda code ran ahead of recorded state.

**Targeted deploy** (`npx sst deploy --stage production --target Api`) exists in theory but broke once mid-session. Not currently a usable fast path.

---

## SST secrets

```bash
# Set (production stage)
npx sst secret set GithubPat <value> --stage production
npx sst secret set AnthropicApiKey <sk-ant-…> --stage production

# List
npx sst secret list --stage production

# Verify what's set (doesn't print value)
aws ssm describe-parameters --filters "Key=Name,Values=/futurator/_pipeline/github-pat" --region us-east-1
```

> **Never paste a secret onto the command line directly** — it lands in shell history. Use `read -s`, `pbpaste`, or env-var indirection.

| Secret            | Consumer                                                            | Failure mode if unset                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GithubPat`       | API Lambda + EC2 daemon (via SSM `/futurator/_pipeline/github-pat`) | Daemon fails to start (`configure-git-identity.sh`); App-bootstrap saga errors.                                                                                                                                            |
| `AnthropicApiKey` | API Lambda only — backs Debates inline-Q&A                          | `POST /api/party/sessions/:id/inline-questions` returns 503 `ANTHROPIC_API_KEY_MISSING`. The rest of the chat (party-turn pipeline) is unaffected — that path goes through the Claude CLI on EC2 with OAuth, not this key. |

The `GithubPat` value is independently stored at SSM `/futurator/_pipeline/github-pat` (SecureString) so the EC2 daemon's `configure-git-identity.sh` startup hook can find it. Keeping these two stores in sync is manual. `AnthropicApiKey` lives only in SST/Pulumi state — the daemon does NOT need it (daemon authenticates via the Claude Max OAuth file at `/home/ubuntu/.claude/.credentials.json`).

---

## EC2 daemon — full operations

### Daemon location

| Field             | Value                                                   |
| ----------------- | ------------------------------------------------------- |
| Instance ID       | `i-0826d68c316ae97dd`                                   |
| Public IP         | `54.86.226.233` (Elastic IP, survives stop/start)       |
| DNS               | `ec2-54-86-226-233.compute-1.amazonaws.com`             |
| OS                | Ubuntu (Linux)                                          |
| User              | `ubuntu`                                                |
| SSH key           | `~/.ssh/debatator-memgraph.pem`                         |
| Service unit      | `/etc/systemd/system/futurator-daemon.service`          |
| Code path         | `/opt/futurator-daemon/`                                |
| Env file          | `/opt/futurator-daemon/.env`                            |
| Log destination   | `journalctl -u futurator-daemon` (no separate log file) |
| OAuth credentials | `/home/ubuntu/.claude/.credentials.json`                |
| IAM role          | `develope-it-ec2-ssm`                                   |

### Update daemon code

```bash
bash scripts/rsync-daemon.sh
ssh -i ~/.ssh/debatator-memgraph.pem ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com \
  "sudo systemctl restart futurator-daemon && sleep 5 && sudo systemctl is-active futurator-daemon"
```

Fresh heartbeat verification (independent of SSH):

```bash
aws dynamodb get-item --table-name futurator-agent-jobs \
  --key '{"jobId":{"S":"DAEMON_HEARTBEAT"}}' --region us-east-1 \
  --query 'Item.{updatedAt:updatedAt.S,status:status.S,authValid:auth.M.valid.BOOL}' --output json
```

`updatedAt` should be within ~30 seconds of now if the daemon is alive.

### Refresh Claude Code OAuth credentials

```bash
# Extract from macOS Keychain
python3 -c "
import subprocess
r = subprocess.run(['security', 'find-generic-password', '-s', 'Claude Code-credentials', '-a', 'ricardoarayafarias', '-w'], capture_output=True, text=True, timeout=5)
if r.returncode == 0 and r.stdout.strip():
    open('/tmp/cc-tokens.txt','w').write(r.stdout.strip())
    print(f'Extracted {len(r.stdout.strip())} chars')
else:
    print('FAILED — Keychain item not found')
"

# Push to EC2
scp -i ~/.ssh/debatator-memgraph.pem /tmp/cc-tokens.txt \
  ubuntu@54.86.226.233:/home/ubuntu/.claude/.credentials.json
rm /tmp/cc-tokens.txt

# Daemon reloads OAuth on next probe (hourly) or on first 401 — restart to force-load.
ssh -i ~/.ssh/debatator-memgraph.pem ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com \
  "sudo systemctl restart futurator-daemon"
```

The admin UI also exposes a "Re-Authorize" button — `POST /api/ec2/refresh-credentials` triggers the same flow via SSM.

### EC2 instance control

```bash
# State
aws ec2 describe-instances --instance-ids i-0826d68c316ae97dd --region us-east-1 \
  --query 'Reservations[0].Instances[0].{State:State.Name,IP:PublicIpAddress}' --output table

# Force-stop a hung instance (kernel-level hang — happens under memory pressure)
aws ec2 stop-instances --instance-ids i-0826d68c316ae97dd --force --region us-east-1

# Wait stopped, then start
until aws ec2 describe-instances --instance-ids i-0826d68c316ae97dd --region us-east-1 \
  --query 'Reservations[0].Instances[0].State.Name' --output text | grep -q stopped; do sleep 8; done
aws ec2 start-instances --instance-ids i-0826d68c316ae97dd --region us-east-1

# Wait healthy
until aws ec2 describe-instance-status --instance-ids i-0826d68c316ae97dd --region us-east-1 \
  --query 'InstanceStatuses[0].InstanceStatus.Status' --output text | grep -q ok; do sleep 10; done
echo "INSTANCE_OK"
```

The Elastic IP `54.86.226.233` is preserved across stop/start cycles.

---

## DEPLOY SAFETY — NEVER do these

### NEVER sync `out/` to `futurator-ai-website`

The Admin static export (`out/`) belongs at `admin.futurator.ai` (handled automatically by SST's `AdminSite` resource). It must NEVER be synced to `s3://futurator-ai-website/` — that bucket hosts the public homepage at `futurator.ai`, a SEPARATE Next.js project at `/Users/ricardoarayafarias/GetReal/Clients/futurator`.

Forbidden:

```bash
aws s3 sync out/ s3://futurator-ai-website/         # ❌ NO
aws s3 sync out/ s3://futurator-ai-website/ --delete # ❌ NO
```

The admin Lambda IS allowed to write **scoped paths** in that public bucket:

| Path                            | Writer                                          | Purpose                           |
| ------------------------------- | ----------------------------------------------- | --------------------------------- |
| `data/projects.json`            | `functions/shared/export-public-projects.ts`    | Public projects list for homepage |
| `media/<projectId>/`            | API pre-signed upload endpoint                  | Project media uploaded by admin   |
| `apps/<appName>/`               | Deploy Agent (`/api/epic-workflows/:id/deploy`) | Published Vite/React user apps    |
| `knowledge-live/<projectId>/`   | Daemon's compile-sync step                      | Mycelium knowledge graph backups  |
| `qa-snapshots/<appId>/<jobId>/` | Visual QA agent (when wired)                    | Per-job test screenshots          |
| `party-docs/<projectId>/`       | API presigned PUT (party module)                | Party agent doc uploads           |

The Admin static-site bucket name is `futurator-admin-production-adminsiteassetsbucket-<random-suffix>` — never the public bucket.

### NEVER `aws dynamodb delete-table` on Pulumi-managed tables

Use `sst.config.ts` to remove tables and let SST delete them. Direct DDB deletion produces Pulumi state divergence that's painful to recover from.

### NEVER `aws cloudfront delete-distribution` without operator confirmation

If you must delete a distribution, **disable it first** (`aws cloudfront update-distribution` with `Enabled: false`), wait for `Status: Deployed` (~15-30 min), then delete. Deleting an enabled distribution returns 412 Precondition Failed. (Historical incident: 2026-04-30 PR-7 unblock — `E27Y9O5P5LIRMH` was disabled and queued for deletion after the alias was stripped.)

### NEVER skip `--stage production`

`npx sst deploy` without a stage targets your dev stage (`<your-username>`). Production deploys require `--stage production` explicitly.

---

## Common deploy failure modes (and recovery)

### 1. CloudFront `CNAMEAlreadyExists`

**Symptom:** `sst deploy` fails with `CNAMEAlreadyExists: One or more of the CNAMEs you provided are already associated with a different resource.`

**Cause:** A CloudFront distribution exists in AWS holding `admin.futurator.ai`, but Pulumi state has no record of it (typical after a partial-rollback during nuclear redeploy). Pulumi tries to create a new distribution; AWS rejects.

**Recovery:**

```bash
# 1. Find the orphan distribution (the one holding admin.futurator.ai)
aws cloudfront list-distributions \
  --query 'DistributionList.Items[?Aliases.Items != null]' --output json | \
  python3 -c "import json,sys; [print(d['Id'], d.get('Aliases',{}).get('Items',[])) for d in json.load(sys.stdin) if 'admin.futurator.ai' in d.get('Aliases',{}).get('Items',[])]"

# 2. Strip the alias (releases it immediately)
aws cloudfront get-distribution-config --id <ORPHAN_ID> > /tmp/cfg.json
python3 -c "
import json
d=json.load(open('/tmp/cfg.json'))
d['DistributionConfig']['Aliases']={'Quantity':0}
json.dump(d['DistributionConfig'], open('/tmp/cfg-noalias.json','w'))
print('etag:', d['ETag'])
"
aws cloudfront update-distribution --id <ORPHAN_ID> --if-match <ETAG> \
  --distribution-config file:///tmp/cfg-noalias.json

# 3. Re-run sst deploy — SST creates a new distribution + updates Route 53 records
npx sst deploy --stage production

# 4. (Optional) Disable the orphan for cleanup
aws cloudfront get-distribution-config --id <ORPHAN_ID> > /tmp/cfg-final.json
python3 -c "
import json
d=json.load(open('/tmp/cfg-final.json'))
d['DistributionConfig']['Enabled']=False
json.dump(d['DistributionConfig'], open('/tmp/cfg-disabled.json','w'))
print('etag:', d['ETag'])
"
aws cloudfront update-distribution --id <ORPHAN_ID> --if-match <ETAG> \
  --distribution-config file:///tmp/cfg-disabled.json
# After ~15-30 min: aws cloudfront delete-distribution --id <ORPHAN_ID> --if-match <ETAG>
```

Brief outage window during step 3 (Route 53 still points at the orphan, alias stripped → SSL host mismatch). Typical: 5-10 minutes.

### 2. EC2 instance kernel hang

**Symptom:** SSH banner timeouts. `aws ec2 describe-instance-status` shows `SystemStatus: ok` but `InstanceStatus: impaired`. Daemon heartbeat stale > 1 hour.

**Cause:** t2.micro memory pressure under 4 parallel Claude CLI subprocesses. We've hit this twice (2026-04-28 13:17 and 2026-04-29 15:23).

**Recovery:** force-stop + start (commands above).

**Long-term fix:** upgrade to t3.medium (4 GB RAM, ~$30/mo). Tracked as Phase 2 work.

### 3. Pulumi state divergence (DDB tables already exist)

**Symptom:** `sst deploy` fails with `Table already exists: <name>`.

**Cause:** Tables exist in AWS but Pulumi state lost track (typical after `sst remove` followed by partial recreation).

**Recovery:**

```bash
# Option A: refresh state from AWS reality, then retry
npx sst refresh --stage production
npx sst deploy --stage production

# Option B: empty + delete the orphan table (only if it's empty and safe to recreate)
aws dynamodb scan --table-name <name> --select COUNT --region us-east-1
# If 0 items:
aws dynamodb delete-table --table-name <name> --region us-east-1
# Wait until ResourceNotFoundException, then sst deploy
```

### 4. SST secret missing

**Symptom:** `sst deploy` fails with `SecretMissingError: Set a value for GithubPat`.

**Recovery:**

```bash
npx sst secret set GithubPat "$(aws ssm get-parameter --name /futurator/_pipeline/github-pat --with-decryption --region us-east-1 --query 'Parameter.Value' --output text)" --stage production
npx sst deploy --stage production
```

### 5. Daemon refuses to start: `configure-git-identity.sh exited 1`

**Symptom:** systemd shows daemon flapping with exit-code 3. `journalctl -u futurator-daemon` shows `[configure-git-identity] ERROR: no PAT found in any SSM path`.

**Cause:** SSM parameter `/futurator/_pipeline/github-pat` missing or PAT lost permissions.

**Recovery:**

```bash
# 1. Verify the SSM parameter exists
aws ssm describe-parameters --filters "Key=Name,Values=/futurator/_pipeline/github-pat" --region us-east-1

# 2. If missing — set it (use read -s; never paste on command line)
read -rs PAT
aws ssm put-parameter --name /futurator/_pipeline/github-pat \
  --type SecureString --value "$PAT" --overwrite --region us-east-1
unset PAT

# 3. If the SSM smoke-test repo is wrong (template-nextjs-vite vs template-nextjs):
ssh -i ~/.ssh/debatator-memgraph.pem ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com \
  "echo 'FUTURATOR_GIT_SMOKE_REPO=https://github.com/futurator-repos/template-nextjs.git' | sudo tee -a /opt/futurator-daemon/.env"

# 4. Restart daemon
ssh -i ~/.ssh/debatator-memgraph.pem ubuntu@ec2-54-86-226-233.compute-1.amazonaws.com \
  "sudo systemctl restart futurator-daemon"
```

**Bypass option:** `SKIP_GIT_IDENTITY=1` in `/opt/futurator-daemon/.env` skips the auth-setup hook entirely. Daemon starts but git ops fail silently inside the saga. Use only as a temporary unblock; do not commit it long-term.

---

## Manual deploy bypass (emergency only)

If `sst deploy` is broken and you need to ship a Lambda hotfix immediately, you can bypass SST and update the function code directly:

```bash
# Find the current function name (suffix changes on stack rebuild)
aws lambda list-functions --region us-east-1 \
  --query 'Functions[?starts_with(FunctionName, `futurator-admin-production-Api`)].FunctionName' --output text

# Bundle from entry
npx esbuild functions/api/index.ts \
  --bundle --platform=node --target=node22 --format=esm \
  --outfile=/tmp/bundle.mjs \
  --external:@aws-sdk \
  --banner:js="import { createRequire } from 'module';const require = createRequire(import.meta.url);"

cd /tmp && zip -j lambda-bundle.zip bundle.mjs && cd -

# Update
aws lambda update-function-code \
  --function-name <function-name-from-list> \
  --zip-file fileb:///tmp/lambda-bundle.zip --region us-east-1
```

**Caveat:** the next `sst deploy` will overwrite this with the SST-bundled version. Use only as a stopgap, then make the same change land via SST.

---

## Verifying a deploy

### Quick check: the build-hash strip (PR-61)

Every build stamps the **git short hash** into two places:

| Where                  | How                                                                                            | Visible to operator                                  |
| ---------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Static export (`out/`) | `next.config.ts` inlines `NEXT_PUBLIC_BUILD_HASH` via `execSync('git rev-parse --short HEAD')` | Sidebar shows `v abc1234` under "Futurator Admin"    |
| API Lambda env         | `sst.config.ts` sets `BUILD_HASH` from the same `execSync`                                     | `GET /api/health` returns `{ buildHash, buildTime }` |

A dirty working tree (uncommitted M files) appends `-dirty` to both hashes so the indicator doesn't lie.

**The Sidebar fetches `/api/health` on mount** and cross-checks the API's hash against its own. When they match: just the version string. When they diverge: an orange dot appears next to the hash, with a tooltip explaining the bundle is stale. Hard-refresh (Cmd+Shift+R) clears it.

### Curl-based smoke

After `npx sst deploy --stage production` reports `✓ Complete`:

> **CloudFront routing trap:** The SPA's API calls **bypass CloudFront** — `NEXT_PUBLIC_API_URL` is set to the Lambda Function URL directly at build time (`sst.config.ts`). `https://admin.futurator.ai/api/*` falls through to S3 and returns the SPA shell HTML, not the Lambda. Hit the Lambda URL directly when smoke-testing.

```bash
# Site loads (HTML)
curl -sS -o /dev/null -w "admin: http=%{http_code}\n" https://admin.futurator.ai/

# API health — use the Lambda Function URL printed by `sst deploy`
API_URL=https://rudarnjfpu2ujs76fhz6oajciu0slvcu.lambda-url.us-east-1.on.aws
curl -sS $API_URL/api/health
# Expect: {"status":"ok","timestamp":"…","buildHash":"<short-hash>","buildTime":"…"}

# Cross-check the API hash matches what you just shipped
API_HASH=$(curl -sS $API_URL/api/health | python3 -c 'import json,sys;print(json.load(sys.stdin)["buildHash"])')
LOCAL_HASH=$(git rev-parse --short HEAD)$(git status --porcelain | head -1 | grep -q . && echo '-dirty')
echo "API: $API_HASH  Local: $LOCAL_HASH"
[ "$API_HASH" = "$LOCAL_HASH" ] || echo "⚠ API has not picked up the new build yet"
```

For UI verification: open `admin.futurator.ai` in an **incognito window** (no cache), check the Sidebar's `v…` strip matches `git rev-parse --short HEAD` of the commit you just deployed.

### Deep verification: code freshness

When you want bit-level certainty (e.g., diagnosing whether the deploy actually picked up a file change):

```bash
# Lambda code — extract a unique string from your change
URL=$(aws lambda get-function --function-name <function-name> --region us-east-1 \
  --query 'Code.Location' --output text)
curl -sS -o /tmp/lambda.zip "$URL"
unzip -p /tmp/lambda.zip 2>/dev/null | grep -c "<some-unique-string-from-your-PR>"

# Static-site bundles — JS chunks live in S3:
aws s3api list-buckets --query 'Buckets[?contains(Name, `adminsite`)].Name' --output text
aws s3 cp s3://<adminsite-bucket-name>/_next/static/chunks/ /tmp/chunks/ --recursive --quiet
grep -lE "<some-unique-string-from-your-PR>" /tmp/chunks/*.js | head
```

Recent CloudFront cache may serve old JS for up to 5 minutes after invalidation finishes. Hard-refresh your browser (Cmd+Shift+R) or wait it out — the Sidebar's mismatch indicator clears once your browser has the new bundle.

---

## Cost watchdog

Run a deploy → check that nothing surprising spawned:

```bash
aws ec2 describe-instances --filters "Name=tag:futurator:managed-by,Values=futurator-admin" \
  --region us-east-1 --query 'Reservations[*].Instances[*].[InstanceId,InstanceType,State.Name]' --output table

aws lambda list-functions --region us-east-1 \
  --query 'Functions[?starts_with(FunctionName, `futurator-`)].[FunctionName,LastModified]' --output table

aws dynamodb list-tables --region us-east-1 --query 'TableNames[?starts_with(@, `futurator-`)]'
```

Anything you don't recognize → investigate before assuming it's safe.

---

## Document conventions

- **Update inline when reality drifts.** Don't append "Note: this is now wrong" — fix the section.
- **Concrete IDs only.** Bucket suffixes and CloudFront distribution IDs change on stack rebuilds; refer to them by the lookup command, not by literal value, where it might drift.
- **Recovery procedures grow from incidents.** Every CloudFront orphan / kernel hang / state divergence we hit gets a numbered failure mode in §"Common deploy failure modes".
- **What NOT to do** is as load-bearing as what to do. The DEPLOY SAFETY section reflects past incidents (the 2026-04-15 admin-out-synced-to-public-bucket disaster).

---

## Authoritative source-of-truth files

When this doc and these files disagree, **the files win**. Update this doc to match.

| File                                                         | What it defines                                                                               |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| `sst.config.ts`                                              | Lambdas + cron schedules + DDB tables + secrets + AdminSite + IAM permissions                 |
| `next.config.ts`                                             | Static export config; type-check tolerance                                                    |
| `package.json`                                               | npm scripts; dev dependencies                                                                 |
| `tsconfig.json`                                              | TS path aliases; include/exclude                                                              |
| `.husky/pre-commit`                                          | The only enforced pre-commit gate                                                             |
| `scripts/rsync-daemon.sh`                                    | Daemon deploy script                                                                          |
| `daemon/package.json`                                        | Daemon's runtime deps (separate from root)                                                    |
| `docs/concepts/pipeline-v2/pipeline-v2-0-efficency-fixes.md` | Active pipeline-efficiency work (PR-1..N tracking)                                            |
| `docs/concepts/pipelinev1-deferrals.md`                      | v1 backlog + cross-references                                                                 |
| `docs/concepts/debates-mobile-handoff.md`                    | Mobile-dev handoff for the Debates feature (URL contract, REST surface, parser, agent roster) |
