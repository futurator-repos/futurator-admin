# Runbook — GitHub PAT rotation

| Field                                  | Value                                                    |
| -------------------------------------- | -------------------------------------------------------- |
| **Owner**                              | Operator (rica.araya.f@gmail.com)                        |
| **Cadence**                            | Quarterly + on attention-item trigger (Story 1.7.1 cron) |
| **Org**                                | `futurator-repos`                                        |
| **Phase 1 stories using this runbook** | 1.1.1, 1.7.1                                             |

This runbook covers minting, rotating, and rolling-back the Pipeline v2 GitHub
PAT. It is intentionally explicit — every step Ricardo (or future-Ricardo)
takes belongs here so a 3am incident does not require code reading.

---

## 1. Minting the initial PAT (Story 1.1.1)

### 1.1. One-time org-policy setup

Visit **https://github.com/organizations/futurator-repos/settings/personal-access-tokens**.

- **Allow access via fine-grained personal access tokens** — selected → **Save**.
- **Require administrator approval** vs **Do not require administrator approval**:
  - For a solo operator (Ricardo): **"Do not require administrator approval"** is the lower-friction choice. Any PAT he mints is usable immediately.
  - For a multi-member org: keep **"Require administrator approval"** so each member's PAT goes through the admin (Ricardo).
- **Fine-grained personal access tokens must expire** — checked, **366 days** (this is GitHub's enforced max for fine-grained tokens). The PAT-age cron (Story 1.7.1) starts nagging at 80 days and escalates at 100, well before expiry.
- **Save** each section.

### 1.2. Create the token

Visit **https://github.com/settings/personal-access-tokens/new** (your _personal_ settings page — the org page lists tokens that have already been minted; new tokens are created from your user settings with the org chosen as the resource owner).

Fill in exactly:

| Field                 | Value                                                                               |
| --------------------- | ----------------------------------------------------------------------------------- |
| **Token name**        | `futurator-admin-pipeline-v1`                                                       |
| **Description**       | `Pipeline v2 Phase 1 — repo creation, content read/write, daemon git ops`           |
| **Resource owner**    | `futurator-repos` ← **select the org from the dropdown, not your personal account** |
| **Expiration**        | 1 year (or 366 days — GitHub's max for fine-grained)                                |
| **Repository access** | **All repositories**                                                                |

**Repository permissions** — set exactly these:

| Permission     | Setting            | Why                                               |
| -------------- | ------------------ | ------------------------------------------------- |
| Contents       | **Read and write** | Clone, push, file content reads                   |
| Administration | **Read and write** | `createRepoFromTemplate` + `deleteRepo`           |
| Metadata       | Read-only (auto)   | Required by everything else                       |
| Pull requests  | Read and write     | Phase 2 PR-mode needs this; harmless to grant now |

**Do NOT grant**:

- Workflows (Phase 2 only — adds blast radius today)
- Any Account-level permission
- Any Organization-level permission

Click **Generate token**. GitHub shows the value once, starting with `github_pat_`. **Copy it immediately.**

### 1.3. Pass the value to the system

You don't pass it to me directly. You set it as an SST secret — encrypted in SSM, never visible to anyone after.

```bash
cd /Users/ricardoarayafarias/GetReal/Futurator-Admin
npx sst secret set GithubPat <paste-the-token-here>

# For local dev (optional — Story 1.1.2 added a fallback to .env.local):
echo "GITHUB_PAT=<paste-the-token-here>" >> .env.local
```

Then deploy:

```bash
sst deploy
```

After deploy, the API Lambda reads it at runtime via `Resource.GithubPat.value`.
The daemon's `configure-git-identity.sh` (Story 1.1.3) reads it at startup
via `aws ssm get-parameter`.

### 1.4. Verify

```bash
# Hit the public status route — should return connected: true and your login.
curl https://<your-api-lambda-url>/api/github/status
```

Expected:

```json
{
  "connected": true,
  "login": "rica-araya-f",
  "rateLimit": { "limit": 5000, "remaining": 4999, "reset": <unix> }
}
```

If `connected: false`, check:

1. The PAT was set in the production stage (`npx sst secret set GithubPat ... --stage production`).
2. The Lambda was redeployed after the secret was set.
3. The PAT has the right scopes (re-mint if not).

---

## 2. Rotating the PAT (Story 1.7.1 — quarterly or on attention item)

### 2.1. Trigger

You'll see one of:

- An attention item in the dock: _"GitHub PAT due for rotation (last rotated YYYY-MM-DD)"_ (info at 80d, medium at 100d).
- An expiring PAT email from GitHub.
- A scheduled quarterly rotation reminder.

### 2.2. Mint a new token

Repeat §1.2. Use a name that includes the rotation date: `futurator-admin-pipeline-2026-Q3`. **Don't delete the old token yet** — keep it as a fallback for the next 24h.

### 2.3. Rotate via the Settings UI

Open `admin.futurator.ai/settings/github` → **Rotate PAT** → paste the new token → submit.

Server-side flow (no operator action):

1. Validates the new PAT via `getUser()`.
2. Writes to `/futurator/_pipeline/github-pat` in SSM.
3. Writes the rotation timestamp to `/futurator/_pipeline/github-pat-rotated-at`.
4. Returns 200 + the PAT-age attention item is cleared on next cron run (within 24h).

### 2.4. Verify

Refetch the connection status (the page does this automatically). The rate-limit reads start fresh (full 5000 quota).

### 2.5. Revoke the old token

After 24h of clean operation, delete the previous token at https://github.com/settings/tokens.

---

## 3. Phase-1 known limitation — SST secret path mismatch

**Issue:** the rotation UI writes to `/futurator/_pipeline/github-pat`. SST stores its own `GithubPat` secret at `/sst/futurator-admin/<stage>/Secret/GithubPat/value`. These are two separate SSM parameters. The daemon's `configure-git-identity.sh` reads from both paths in order, but the API Lambda only reads from the SST path.

**Workaround for Phase 1:** after rotating via the UI, also run:

```bash
npx sst secret set GithubPat <new-token> --stage production
sst deploy
```

So the API Lambda picks up the new value too.

**Phase-2 followup:** align the rotation UI to write directly to the SST-managed path (or have the rotation Lambda invoke the SST CLI). Tracked as a Phase-2 deferral in the epic doc.

---

## 4. Rollback / break-glass

If you suspect the PAT was leaked:

1. **Revoke immediately** at https://github.com/settings/tokens — click the token name, scroll to bottom, **Delete**.
2. The pipeline will error out within 1 minute as Lambdas hit 401s. The daemon's `configure-git-identity.sh` will refuse to start (exit code 2 from the smoke test).
3. Mint a new token (§1.2).
4. Rotate (§2.3).
5. Audit your repos at https://github.com/orgs/futurator-repos for unexpected commits in the last 24h.

If the leak source is unclear, also check:

- Recently-merged PRs touching `functions/shared/github/`
- CI/CD logs (search for `github_pat_` or `ghp_` strings)
- Local `.env.local` files on team machines (`grep -r ghp_ ~/`)

---

## 5. Token inventory (kept current)

| Token name                    | Minted                     | Expires   | Status  | Rotated to |
| ----------------------------- | -------------------------- | --------- | ------- | ---------- |
| `debatator test`              | <unknown>                  | <expired> | Expired | —          |
| `futurator-admin-pipeline-v1` | _to be filled when minted_ | _+366d_   | Active  | —          |
