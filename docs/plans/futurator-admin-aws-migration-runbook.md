# Futurator-Admin → New AWS Account: Migration Plan, Runbook & Log

**Owner:** Ricardo · **Date:** 2026-07-15 · **Status:** IN PROGRESS

A retarget of Futurator-Admin's existing SST infrastructure into the shared Futurator org AWS
account, region-aligned with Mycelium, with FinOps born-tagging from day one. This document is
**both the plan and the running log** — §9 is appended as work happens, mirroring the
[Mycelium migration runbook](../../../Mycelium/docs/plans/mycelium-aws-migration-runbook.md)
format for consistency across projects.

---

## 0. Locked decisions

| Decision                | Choice                                                                                        | Consequence                                                                                                                                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Data**                | **Greenfield — fresh tables**                                                                 | No data copy from the old account. SST provisions all 11 DynamoDB tables new, empty, in the target account/region.                                                                                                                                   |
| **Region**              | **eu-central-1**                                                                              | Matches Mycelium; EU residency for both Futurator-Admin properties. **App change:** existing defaults targeted `us-east-1` — must be retargeted in `sst.config.ts` and any runtime region literals in `functions/`.                                  |
| **Account**             | **421515025850** — shared Futurator org account, profile **`FuturatorClaude`**                | Same account/profile as the Mycelium migration; no new IAM user needed. All `aws`/`sst` CLI invocations use `--profile FuturatorClaude`.                                                                                                             |
| **Auth**                | **DEFERRED** — Identity Broker lives in a separate `futurator-core` project, not yet migrated | UI deploys and is reachable, but OTP login will not complete end-to-end until the broker is retargeted too. Documented as a known gap, not a blocker for shipping the static UI + APIs.                                                              |
| **EC2 / daemon**        | **DEFERRED to next day** (cost control)                                                       | The daemon EC2 instance (agent-daemon.mjs poller) is not stood up in this pass. Admin dashboard + APIs come up without it; agent-job execution stays pointed at the old daemon (or paused) until the follow-up session.                              |
| **IaC scope**           | **Retarget existing SST + FinOps born-tagging** — no separate Pulumi rewrite                  | Unlike Mycelium (which authored a parallel Pulumi data-plane), Futurator-Admin keeps its existing `sst.config.ts` as the single source of infra truth. Migration = point SST at the new account/region + add default tags, not a parallel IaC stack. |
| **DNS / custom domain** | **DEFERRED** — ship on the `*.cloudfront.net` URL                                             | No `admin.futurator.ai` custom-domain wiring in this pass (avoids the cross-account CloudFront alias-lock class of issue hit during the Mycelium migration). Revisit once the account/DNS story is settled org-wide.                                 |

---

## 1. What changed

| Area                             | Before                                        | After                                                                                                                                                                |
| -------------------------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Region**                       | `us-east-1`                                   | `eu-central-1` (match Mycelium, EU residency)                                                                                                                        |
| **Account**                      | old/original Futurator account                | **421515025850**, shared Futurator org account, profile `FuturatorClaude`                                                                                            |
| **Default tags**                 | ad hoc / inconsistent                         | `sst.config.ts` `providers.aws.defaultTags` carries the FinOps cost-allocation taxonomy (`App=futurator-admin` + supporting tags) applied to every resource at birth |
| **DynamoDB IAM**                 | inline/per-table policy wiring                | managed policy, **born-in-IaC** (avoids the API-role 10KB inline-policy ceiling hit previously — see project memory)                                                 |
| **Cognito / daemon / EC2 crons** | live                                          | **gated off** for this pass — daemon EC2 + its cron Lambdas are not provisioned; Cognito-adjacent auth wiring deferred with Identity Broker (see §0 Auth)            |
| **Custom domains**               | `admin.futurator.ai` via ACM/CloudFront alias | **dropped** for this pass — ships on the SST-generated `*.cloudfront.net` URL                                                                                        |
| **CORS**                         | single-origin allowlist                       | **two-pass CORS** via `EXTRA_ALLOWED_ORIGIN` — lets the new account's CloudFront origin be added without a hardcoded redeploy-only allowlist edit                    |

---

## 2. Hard-won gotchas honored (carried forward from the Mycelium migration)

- **`AWS_EC2_METADATA_DISABLED=true`** must be set on the environment for _every_ `aws` and `sst`
  command run off-EC2 (this laptop). Without it, the AWS SDK's credential resolution hangs
  indefinitely probing the IMDS endpoint. Both FinOps scripts in this runbook (`generate-manifest.mjs`,
  `create-budgets.mjs`) set this in their own `execSync` env — but any _manual_ `aws`/`sst` command
  the operator runs needs it exported in the shell too.
- **Never kill a running `sst deploy`.** A killed mid-flight deploy risks a partial-apply / corrupted
  distribution state (see Mycelium runbook §9 rows 10–11, 23, 26) — always let it finish or fail on
  its own; `sst unlock` only after confirming no deploy is actually still in flight.
- **Never run `sst secret list`** — it prints secret values directly into the terminal/transcript.
  Use `sst secret set` (write-only) and verify indirectly via app health checks instead.
- **New-account Lambda reserved-concurrency cap = 10, shared account-wide.** Fresh AWS accounts (and
  shared-account new regions) start at a 10-concurrent-execution ceiling across _all_ functions in
  the account, not per-function. This is a scaling ceiling, not a functional blocker for low-traffic
  admin use, but concurrent load/test bursts will self-inflict 429s. Request a quota increase
  (`service-quotas`, quota `L-B99A9384`) proactively if Futurator-Admin usage is expected to burst.
- **CloudFront + Cost Explorer clients are pinned to `us-east-1`** regardless of the app's home
  region — both are effectively global services surfaced through a single regional endpoint. The
  FinOps budgets script in this pass follows the same rule for AWS Budgets.

---

## 3. FinOps deliverables (this pass)

| File                                   | Purpose                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `scripts/finops/generate-manifest.mjs` | Enumerates live `futurator-*` DynamoDB tables, `futurator-admin-*` Lambda functions, and `futurator-admin-*` S3 buckets in account 421515025850/eu-central-1, reads tags, writes `manifest/infra.json` (generated, `verification_status: verified` per resource). Idempotent, dependency-free (AWS CLI via `execSync` only).                          |
| `scripts/finops/create-budgets.mjs`    | Creates (or updates, idempotently) an AWS Budgets monthly COST budget `futurator-admin-monthly`, scoped to tag `App=futurator-admin`, $50 limit, 80%-ACTUAL email alert to `rica.araya.f@gmail.com`. Calls the Budgets API pinned to `--region us-east-1` per the gotcha above; resolves the account id at runtime via `aws sts get-caller-identity`. |

Both scripts are additive/read-mostly against the live account (the manifest script is read-only;
the budgets script's only mutation is the budget object itself) and safe to re-run.

---

## 4. Operator to-dos

- [ ] Run `node scripts/finops/generate-manifest.mjs` after the SST retarget deploys, to produce the
      first verified `manifest/infra.json` snapshot.
- [ ] Run `node scripts/finops/create-budgets.mjs` once billing/cost-allocation tags are active on
      the account, to stand up the `futurator-admin-monthly` budget + alert.
- [ ] Confirm cost-allocation tag activation (`App` key) in Billing → Cost Allocation Tags for the
      account — Budgets `CostFilters` on an unactivated tag silently under-counts.
- [ ] Decide on EC2/daemon stand-up timing (deferred to "next day" per §0) and re-open this runbook's
      §9 log to record it.
- [ ] Decide on `admin.futurator.ai` custom-domain cutover timing; when ready, budget time for the
      cross-account CloudFront alias-lock class of issue seen during the Mycelium migration.
- [ ] Retarget the Identity Broker (`futurator-core`) so OTP login completes end-to-end against the
      new account; until then, treat the deployed UI as reachable-but-unauthenticated.
- [ ] Rotate any secrets that were echoed to a terminal/transcript during setup (mirrors the Mycelium
      lesson on `sst secret list` exposure) — confirm none were listed, not just avoided going forward.

---

## 9. Migration LOG

| #   | Phase | Action | Result | Finding |
| --- | ----- | ------ | ------ | ------- |
|     |       |        |        |         |
