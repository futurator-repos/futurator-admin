# Brownfield Migration Runner — Plan

**Status:** Drafted 2026-05-17 (not yet a formal story)
**Proposed location:** Story 15.5 (Epic 15) or standalone operator tool
**Effort estimate:** 1–2 days for CLI form factor + smoke test against `applicator`

---

## Why

Story 15.4 shipped the brownfield-project surface (clone-via-PAT,
discriminated `POST /party/projects`, refresh pipeline, modal + card UI).
But to actually migrate a repo end-to-end the operator currently has to
do ~7 separate manual steps (PAT mint, Secrets Manager `create-secret`,
EC2 IAM policy, `sst deploy`, daemon restart, UI registration, polling).
Each step is documented in `daemon/README.md` and the Story 15.4 review,
but the human cost of stitching them is what's standing between "ready"
and "ready to test on `applicator` in five minutes."

This plan describes a small, self-contained **migration runner** that
takes two inputs — the local clone path and the PAT — and drives the
entire flow idempotently.

---

## User story (proposed)

> As **Richie**, when I want to migrate a private repo into Labs Party,
> I run `node scripts/migrate-brownfield.mjs --path <local-clone> --pat-file <path-to-token-file>`,
> answer at most one confirmation prompt, and within ~30 seconds I have a
> HEALTHY brownfield project visible in the admin UI ready for a party
> session. If anything fails, the runner tells me which step broke and
> what to fix, and I can re-run it safely (idempotent).

---

## Goal & success criteria

The runner is successful when **all of these are true after a single invocation**:

1. The PAT is in AWS Secrets Manager under `futurator/labs-brownfield-github-pat`.
2. The daemon's EC2 IAM role has `secretsmanager:GetSecretValue` on that ARN.
3. SST is deployed with the new code + secret declaration.
4. The daemon process on EC2 has restarted and emitted `[brownfield-pat] loaded`.
5. The project is registered in DDB with `kind='brownfield'` and `bmadStatus='HEALTHY'`.
6. `lastCommitSha` on the DDB row matches `HEAD` of the upstream repo.

If any of steps 1–4 is **already true**, the runner skips it and prints
`✔ already provisioned`. If step 5 is already true, the runner refuses
with a clear "already registered — use Refresh or delete first" message.

---

## Inputs

The runner reads inputs in this order of preference (first match wins):

| Input              | CLI flag            | Env var                    | Interactive prompt                                                          |
| ------------------ | ------------------- | -------------------------- | --------------------------------------------------------------------------- |
| Local repo path    | `--path <dir>`      | `BROWNFIELD_REPO_PATH`     | `Path to local clone:`                                                      |
| GitHub PAT         | `--pat-file <path>` | (file path, never raw env) | `Paste PAT (input hidden):` (read via `readline` `terminal: true`, no echo) |
| Project name       | `--name <slug>`     | —                          | derived from `git remote get-url origin` if omitted                         |
| Branch             | `--branch <ref>`    | —                          | defaults to `main`; or `git symbolic-ref HEAD` of local clone               |
| Admin API base URL | `--api <url>`       | `FUTURATOR_ADMIN_API_URL`  | defaults to `https://admin.futurator.ai/api`                                |
| Admin auth token   | `--token <jwt>`     | `FUTURATOR_ADMIN_TOKEN`    | falls back to whatever `~/.futurator/credentials.json` has                  |

**Critical:** PAT is **never** accepted as a CLI flag string (would land
in shell history). Only `--pat-file` (operator-managed) or hidden TTY
prompt.

---

## Pre-flight (refuse fast)

The runner exits non-zero with a single specific diagnostic line if any
pre-flight check fails. All pre-flights run in <2 seconds.

| Check                                                                       | Failure message                                                                          |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Local path is a git repo                                                    | `not a git repo: <path>/.git missing`                                                    |
| `bmad/_cfg/agent-manifest.csv` or `_bmad/_config/agent-manifest.csv` exists | `BMAD not installed in repo — run \`npx bmad-method install\` first`                     |
| Manifest has ≥1 data row                                                    | `BMAD manifest is empty — re-install BMAD`                                               |
| `origin` remote points at `github.com`                                      | `origin remote is not GitHub: <actual-url>`                                              |
| No unpushed commits                                                         | warn-only: `⚠️ <N> unpushed commits — EC2 will mirror only what's on GitHub`             |
| Name passes `^[a-z0-9][a-z0-9-]{0,63}$`                                     | `derived name "<n>" is invalid kebab-case; pass --name explicitly`                       |
| PAT is non-empty + starts with `github_pat_` or `ghp_`                      | `PAT does not look like a GitHub token`                                                  |
| AWS CLI configured for us-east-1                                            | `aws sts get-caller-identity` → fail with `AWS credentials not configured for us-east-1` |
| Admin API `/api/health` returns 200                                         | `admin API unreachable at <url>`                                                         |

---

## Steps

The runner executes these in order, **each step idempotent and skippable
if already satisfied**:

### Step 1 — Resolve repo URL + commit SHA

- `git -C <path> remote get-url origin` → `https://github.com/<owner>/<repo>(.git)?`
- `git -C <path> rev-parse HEAD` → SHA for later verification
- `git -C <path> rev-parse --abbrev-ref HEAD` → current branch (sanity check)

### Step 2 — Ensure Secrets Manager secret

```js
try { await sm.send(new GetSecretValueCommand({ SecretId: SECRET_NAME })); skip; }
catch (err) {
  if (err.name === 'ResourceNotFoundException')
    await sm.send(new CreateSecretCommand({ Name: SECRET_NAME, SecretString: pat }));
  else throw;
}
```

If the secret exists, the runner **does not** overwrite it by default.
`--rotate-pat` flag opts into `PutSecretValueCommand`.

### Step 3 — Ensure daemon IAM permission

This is the trickiest step. The daemon's EC2 instance role is managed
outside SST. The runner attempts:

1. Resolve the role: `aws ec2 describe-instances` filter by tag `futurator:role=daemon` → IamInstanceProfile → role name
2. Check existing inline policies for the secret ARN: `aws iam list-role-policies` + `get-role-policy`
3. If absent, attach the inline policy from `daemon/README.md` template
4. Verify by calling `aws iam simulate-principal-policy` (optional — depends on caller's IAM perms)

If the operator doesn't have IAM-write perms, the runner falls back to
**print the exact `aws iam put-role-policy` command and exit with a
"manual step required" code**, then on next invocation re-checks and
continues.

### Step 4 — Ensure SST deploy includes the secret

Detect by GET on `/api/_meta/secrets` (NEW endpoint, or reuse existing
health check). If `BrownfieldGithubPat` is not present in the running
Lambda, prompt the operator: `Run \`sst deploy\` now? (y/N)`. If `y`,
spawn `npx sst deploy`and stream output. If`n`, exit and let operator
deploy manually.

> Alternative: skip this check entirely and instruct the operator to run
> `sst deploy` before the runner. Simpler but more friction. **Recommend
> SKIPPING in MVP** — print "run `sst deploy` before this script if you
> haven't" in the pre-flight banner. Removes a brittle SST introspection
> requirement.

### Step 5 — Ensure daemon restarted

Either:

- POST `/api/ec2/start-daemon` (existing admin endpoint per `sst.config.ts:543`) and poll until daemon heartbeat reports `[brownfield-pat] loaded` in CloudWatch, **OR**
- Just print "If daemon was running before SST deploy, restart it now via the admin UI's Re-authorize button or `/api/ec2/start-daemon`" and wait for operator confirmation.

**Recommend MVP**: print the instruction + wait for `<Enter>`. Probing
CloudWatch for the load-message adds AWS API surface for marginal value.

### Step 6 — Register the project

```js
POST /api/party/projects
{
  kind: 'brownfield',
  name: projectName,
  gitRepoUrl: resolvedRepoUrl,
  gitBranch: resolvedBranch,
}
```

Capture `jobId` from the 201 response.

### Step 7 — Poll job events until terminal

```js
poll(`/api/agent-jobs/${jobId}/events?after=<lastSeq>`) every 1500ms
  → render step-by-step output to TTY
  → terminate on `party.bootstrap.completed` or `party.bootstrap.failed`
```

### Step 8 — Verify final state

```js
GET /api/party/projects/<projectName>
assert kind === 'brownfield'
assert bmadStatus === 'HEALTHY'
assert lastCommitSha === resolved sha from step 1
```

If `lastCommitSha` doesn't match → warn: "EC2 mirrored a different SHA
than your local HEAD — did you forget to push?"

### Step 9 — Print success summary

```
✅ applicator migrated successfully
   kind=brownfield  status=HEALTHY  branch=main
   lastCommitSha=abc1234 (matches local HEAD)
   open in admin: https://admin.futurator.ai/labs?project=applicator
```

---

## Idempotency & failure recovery

Every step checks state first. Re-running on a project that already
exists either:

- Returns successfully (if state matches what's expected)
- Refuses with a clear "X already exists; use --force-refresh or delete
  first" message
- Triggers a **refresh** instead of a re-bootstrap, if `--refresh` flag
  is passed (calls `POST /:id/refresh`)

If a step fails midway, the runner exits non-zero with the step name in
the error message. On re-run, completed steps are skipped and the runner
resumes from the first incomplete step. No transactional rollback —
state is recoverable via:

- `aws dynamodb delete-item --table-name futurator-party-projects --key '{"projectId":{"S":"<name>"}}'`
- Re-run the runner.

---

## Form factor

**Recommended: Node.js CLI script** at `scripts/migrate-brownfield.mjs`.

- Runs on the operator's laptop (not on EC2 or in the Lambda).
- Uses `@aws-sdk/client-secrets-manager`, `@aws-sdk/client-iam`,
  `@aws-sdk/client-ec2` (already in the repo's deps).
- Imports the admin API client from the project's existing
  `src/lib/api-client.ts` (or duplicates the auth flow inline — simpler).
- One file, no transpile step (use `.mjs` like the daemon does).
- Documented in `daemon/README.md` (or a new `scripts/README.md`).

**Why not the admin UI:**

- The UI can't provision AWS Secrets Manager or attach IAM policies — those
  steps fundamentally require operator AWS credentials.
- The UI form (Story 15.4) already exists for the "everything is provisioned,
  just register" path. The runner complements it for the first-time-setup path.

**Why not a TUI / interactive wizard:**

- Adds prompt-library deps (`inquirer`, `prompts`) for marginal UX gain over flags.
- Operator who needs this script is also comfortable with flags.

---

## Security considerations

- **PAT handling**: token never written to disk by the runner. Only read
  from operator-provided file path or hidden TTY prompt. Logged messages
  use the same `redactToken` helper from `daemon/pipelines/lib/git-clone.mjs`.
- **AWS credentials**: runner relies on operator's `~/.aws/credentials`
  (no credential storage). If the operator's profile lacks IAM-write
  perms, Step 3 falls back to "print command, exit, retry".
- **Admin API auth**: runner uses an existing JWT from
  `~/.futurator/credentials.json` (or whatever the existing admin CLI
  pattern is). Does NOT mint new tokens.
- **No automatic push to GitHub**: the runner never invokes `git push` —
  consistent with the brownfield-Party design that EC2 mirrors GitHub.

---

## Test plan

- **Unit tests** (vitest) for:
  - Input parsing (CLI flags, env vars, file reads)
  - Pre-flight validators (each check independently)
  - Step 1 (URL/SHA resolution from a fixture git directory in `mkdtemp`)
  - PAT redaction in log output
- **Integration tests** (against a mocked DDB + mocked Secrets Manager):
  - Happy path end-to-end (steps 2–8)
  - Re-run idempotency (run twice, second run is a no-op)
  - Step-3 IAM fallback path (no IAM perms → print command, exit)
- **No real EC2/Lambda calls in tests** — admin API mocked via the same
  `app.request(...)` pattern used in `functions/api/__tests__/party-refresh-route.test.ts`.
- **Smoke test** against the actual `applicator` repo on a dev stage
  (Richie runs it manually once the script is ready).

---

## Acceptance criteria (proposed)

- **AC1** — `node scripts/migrate-brownfield.mjs --help` prints usage with all flags + env vars + examples.
- **AC2** — Given a valid local clone of `applicator` with BMAD installed,
  a fresh PAT in a file, and a working SST deploy, running the runner
  end-to-end produces a HEALTHY brownfield project visible in the admin
  UI in ≤ 90 seconds.
- **AC3** — Each pre-flight check produces a single specific error
  message when it fails; no stack traces.
- **AC4** — Re-running the script with the same inputs after success is
  a no-op (each step says `✔ already provisioned` or `✔ already registered`).
- **AC5** — Re-running with `--refresh` on an existing project triggers
  the `POST /:id/refresh` endpoint and polls until `party.refresh.completed`.
- **AC6** — PAT never appears in the runner's stdout/stderr (verified by
  a unit test that captures all log output and asserts the raw token is absent).
- **AC7** — Failure in any step exits non-zero with the step name in the
  error and prints a clear "to recover, do X" hint.
- **AC8** — `npm run test` passes (≥ 20 new tests) and lint/typecheck
  remain clean.

---

## Out of scope (explicitly deferred)

- Migrating multiple repos in one invocation (single-repo MVP).
- A UI for the runner (CLI only).
- Automatic SST deploy from the runner (operator runs `sst deploy` themselves).
- IAM role creation from scratch (assumes the daemon role already exists; the runner only attaches the missing policy).
- Memgraph ingestion of the cloned repo (per Story 15.4 deferred).
- Setting up the EC2 daemon process itself (assumes it's already running).
- A "rotate PAT" workflow (covered by the `--rotate-pat` flag but no automatic rotation cron).

---

## Open questions for Richie

1. **Form factor confirmation** — CLI script as proposed, or do you want a
   single npm script like `npm run migrate-brownfield -- --path … --pat-file …`?
2. **IAM fallback strictness** — if the operator's AWS profile doesn't have
   IAM-write perms, should the runner (a) print the command and exit, or
   (b) prompt for `sudo`-equivalent role assumption, or (c) accept a flag
   `--skip-iam-check` and assume operator handled it?
3. **SST deploy autoprobe** — Step 4 has two options (verify the Lambda has
   the new code vs. trust operator). I lean toward the trust-operator MVP.
4. **Admin auth source** — runner needs a JWT. Reuse the existing
   `~/.futurator/credentials.json` if there is one, or require `--token`
   flag explicitly?
5. **Should this become a formal Story 15.5** or stay an operator tool
   outside the BMAD story flow?

---

## Suggested next step

If you approve the plan as drafted, I can:

- **Path A (fastest):** drop straight into implementing
  `scripts/migrate-brownfield.mjs` per the plan above. Skip formal story
  creation. ~1 day of work, ~20–30 tests.
- **Path B (BMAD-orthodox):** Bob drafts Story 15.5 using this plan as
  the input, generates a context XML, you approve, then I (Amelia)
  implement. Adds ~1 hour of orchestration overhead but produces the
  full BMAD trail (story file, context, validation gates).

Path A is what I'd pick for an operator tool; Path B is what I'd pick if
this graduates from "test scaffolding" to "shipped feature".
