# Futurator App → AWS Migration + Proper IaC — Launch Prompt (portable)

Copy the fenced block below into a **fresh Claude Code / agent session inside the target app's repo**,
fill the `<<...>>` placeholders, and run it. It is self-sufficient (does not need any other repo) and is
derived from two real migrations into the shared Futurator org AWS account: **Mycelium** (parallel Pulumi
data-plane) and **Futurator-Admin** (SST retarget). Both converged on the same principles below.

Launch it and leave it — it recons, asks you a few blocking questions, then goes full automode and reports
at the end. The one thing it **cannot** do autonomously is write secret values into the production secret
store (the harness classifier correctly gates that) — it will surface those as your finish-line step.

---

```
You are migrating THIS app into our shared Futurator AWS org account and standing up clean,
FinOps-tagged IaC, the same way the Mycelium and Futurator-Admin apps were migrated. Work
on automode after a short recon + a few questions. Use the "ultracode" multi-agent workflow
pattern (parallel author → adversarial verify → fix → gate) for the heavy lifting.

── TARGET (shared org account — READ CAREFULLY) ──
- AWS account **421515025850** IS the Futurator ORG account. It hosts MANY apps (Mycelium,
  Futurator-Admin, and now this one) — it is NOT per-app.
- Region: **eu-central-1** (default choice — matches Mycelium + Futurator-Admin, EU residency).
  Confirm with me if this app has a reason to differ.
- AWS CLI profile: **FuturatorClaude** (generic admin, shared across all apps). Confirm it works:
  `AWS_EC2_METADATA_DISABLED=true aws sts get-caller-identity --profile FuturatorClaude`
  (expect Account 421515025850). The old per-app accounts are DEAD — `default`/`futurator`
  profiles return InvalidClientTokenId. That forces GREENFIELD unless you can revive the old account.
- Because the account is SHARED, the #1 risk is COLLISION with another app's resources:
  → EVERY resource MUST be namespaced by THIS app's name (prefix) AND carry an `App=<<app-name>>`
    tag. Before creating anything, LIST existing resources and confirm your names are free. NEVER
    touch, rename, or delete a resource tagged with a different App. (Mycelium = `mycelium-*`/
    `Mycelium_*` in eu-central-1; Futurator-Admin = `futurator-*` — do not clash with either.)
- Lambda reserved-concurrency = 10 is ACCOUNT-WIDE (shared across all apps) until a quota case
  lands. Fine for low-traffic; don't concurrent-load-test it (self-inflicted 429s).

── FILL IN BEFORE STARTING ──
- App name (resource prefix + App tag):  <<app-name>>
- Repo / working dir:                    <<path>>
- Known complexity / special constraints: <<notes — e.g. "has Postgres RDS", "websockets",
  "SST or plain Pulumi or container/ECS?", "heavy background jobs", "already partly on AWS">>

── RECON, THEN ASK ME THESE (before automode) ──
1. Confirm the app's stack (framework, hosting model — SST/OpenNext? plain Pulumi? ECS? static?),
   its datastores (DynamoDB/RDS/S3/queues/cache), 3rd-party providers (AI/APIs/auth), and secrets.
2. Ask me the FOUR blocking decisions (I answer, then you go):
   - DATA: greenfield fresh (default — old account dead) vs I can revive the old account to copy data.
   - REGION: eu-central-1 (default) vs other.
   - AUTH: is this app's login provider (e.g. the Identity Broker `futurator-core`) already migrated
     and reachable? If not → deploy infra-only, auth wired later.
   - DEFERRALS: EC2/daemon, custom domain/DNS, and any costly compute — default to DEFERRING these
     unless I say otherwise (start cheap, add later).
   - IaC SCOPE: if the app already uses SST → retarget SST in place + FinOps born-tagging (do NOT
     rewrite into a parallel Pulumi stack). If it has NO IaC → author a Pulumi data-plane like Mycelium.

── GROUND RULES ──
1. Model tiering (token-aware): Sonnet for mechanical edits, Opus for infra/IAM/security reasoning,
   a top-tier model (Fable if available) for the adversarial red-team pass only.
2. `export AWS_EC2_METADATA_DISABLED=true` on EVERY aws/sst/pulumi command off-EC2, or the SDK hangs
   forever on IMDS.
3. GATE every phase before committing: the app's own gate (typecheck + lint + build; tests — accept
   pre-existing failures, block only on regressions YOUR change caused). For Pulumi: `pulumi preview`
   (+ policy pack). Commit per phase. Stage EXACT files only if the branch carries other uncommitted
   workstreams — never `git add -A`. NEVER claim done without the gate output.
4. ADVERSARIALLY VERIFY: after authoring, run independent skeptical re-reads (region-pin completeness,
   account-id completeness, IAM/ARN validity, tag coverage, dead-feature neutralization, deploy-safety
   rules in the repo's CLAUDE.md). This caught REAL runtime IAM defects on both prior migrations that a
   green health-check would have missed.
5. SECRETS ARE OPERATOR-GATED. The harness classifier will (correctly) BLOCK you from writing values
   into the production secret store. Do NOT work around it. `sst deploy` FAILS the whole deploy on ANY
   unset referenced `sst.Secret` — so after everything else deploys, surface to me the exact
   `sst secret set …` commands + the finish `sst deploy`. (Any value unblocks the deploy; real values
   only matter for the specific features that use them.) NEVER run `sst secret list` — it prints values.
6. A production deploy is authorized on this prototype account, but if a classifier blocks a specific
   mutation, that's correct — surface it, don't circumvent.
7. JOURNAL as you go: write `docs/plans/<<app-name>>-aws-migration-runbook.md` — locked decisions,
   what-changed, hard-won gotchas, a running §LOG, and an operator to-do list.

── PHASES (adapt to THIS app's real stack) ──
A. RECON — map the app + current AWS state; confirm greenfield; produce a short as-is + target plan.
B. RETARGET / AUTHOR IaC —
   • If SST: in sst.config.ts set `region: 'eu-central-1'`; replace EVERY hardcoded old-account ID and
     `us-east-1` ARN with the new account/region (IAM on not-yet-existing resources is legal → stays
     valid, feature dormant); add `providers.aws.defaultTags` with the FinOps taxonomy (App, Environment,
     Owner, ManagedBy=sst, CostCenter, Capability, Service, DataClassification); promote any hand-made
     managed policies to born-in-IaC `aws.iam.Policy`; gate off deferred surfaces (EC2/daemon crons,
     auth, custom domains) behind clear `const ENABLE_* = false` flags; make ALLOWED_ORIGIN /
     REDIRECT_BASE_URL env-overridable; add a CORS `EXTRA_ALLOWED_ORIGIN` spread for the post-deploy
     CloudFront URL (two-pass deploy when dropping the custom domain).
   • If no IaC: author a Pulumi data-plane (infra/data/) — every stateful resource BORN-TAGGED + durable
     (PITR/versioning/deletion-protection/`protect:true`), region-pinned, DIY S3+KMS state backend
     `<<app-name>>-pulumi-state-421515025850`.
   • Runtime region literals: replace hardcoded `region: 'us-east-1'` in SDK clients with
     `process.env.AWS_REGION || 'eu-central-1'` — EXCEPT CloudFront, Cost Explorer, and AWS Budgets
     clients, which are GLOBAL services with a us-east-1-only endpoint and MUST stay us-east-1.
C. FINOPS — cost-allocation tags are the foundation (done in B). Declare the budget AS IaC — a
   `new aws.budgets.Budget(...)` resource (COST/MONTHLY, CostFilters `[{name:'TagKeyValue',
   values:['user:App$<<app-name>>']}]`, an ACTUAL %-threshold email alert), NOT an out-of-band script.
   Author a `scripts/finops/generate-manifest.mjs` (read-only reporting → manifest/infra.json).
D. GATE — run the app gate green (typecheck/lint/build); commit.
E. DEPLOY — `sst deploy --stage production` (or `pulumi up`) with AWS_EC2_METADATA_DISABLED=true. It
   will stand up everything except any secret-dependent function; surface the `sst secret set` finish.
F. VERIFY — capture the CloudFront/API URLs; two-pass CORS redeploy with EXTRA_ALLOWED_ORIGIN=<site
   url>; `curl /api/health` → 200; confirm resources are born-tagged; generate the manifest.
G. CLOSE-OUT — finish the runbook §LOG + operator to-dos (set secrets; activate cost-allocation tags
   in Billing → the one non-IaC FinOps step; EC2/auth/domain when ready; rotate any exposed keys).

── HARD-WON GOTCHAS (these cost real time — honor them) ──
- AWS_EC2_METADATA_DISABLED=true on every command off-EC2 (IMDS hang).
- Install pulumi/sst toolchain NATIVELY for your CPU arch (arm64 on Apple Silicon) — an Intel/Rosetta
  binary makes the AWS provider crawl/hang. `pulumi plugin rm resource aws --all` if it got wrong arch.
- NEVER kill a running deploy (partial-apply / corrupted CloudFront state). Run it in the background and
  WAIT. Never launch concurrent deploys; never `sst unlock` while one runs.
- NEVER hand-edit an SST/Pulumi-managed CloudFront distribution — let the tool reconcile it (a manual
  cert/alias edit can make a distribution 403 its own default URL).
- sst deploy FAILS on any unset referenced secret (but still creates every other resource) — set
  secrets, then re-deploy to reconcile the missing function. No state corruption from the clean fail.
- CloudFront CNAME aliases are GLOBAL — a new dist cannot claim an alias held by a dist in the dead
  account. If you keep the custom domain and hit `CNAMEAlreadyExists`, use a fresh subdomain or open an
  AWS Support case. (This is why domains default to DEFERRED — ship on *.cloudfront.net.)
- Cost Explorer is already enabled on this account (a prior migration did the one-time root click) — but
  cost-allocation TAGS still need a one-time Billing-console activation before budgets can group on them.

── DELIVERABLES ──
1. App deployed to 421515025850/eu-central-1 (health 200 after secrets), gated green, born-tagged.
2. IaC (retargeted sst.config.ts OR infra/data Pulumi) + budget-as-IaC + manifest/infra.json.
3. `docs/plans/<<app-name>>-aws-migration-runbook.md` with the running log + operator to-do list.
4. A crisp end report: what's live, the exact secret+redeploy finish-line, and any deferred items.

Start with Phase A recon, then ask me the questions.
```
