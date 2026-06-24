# Deployment v2.5 — From "one-shot publish" to a real dev → staging → production ladder

> **Status:** Phases 1–3 IMPLEMENTED in code (see §13). Subdomain hosting (§14) is the one piece pending an `sst deploy` + EC2 IAM grant; until then dev/staging run on shared-bucket prefixes with rebuild-promotion.
> **Audience:** You (operator, learning DevOps as we go). Written to teach the _why_, not just the _what_.
> **Scope:** Add human-clickable **dev** and **staging** environments before production, on a build-once-promote-many model, without rebuilding the git substrate and without breaking the ~$0 cost rule.
> **Supersedes (extends):** `docs/concepts/futurator-deployment-guide-v2.md`.

---

## 0. TL;DR (read this first)

Today, "Deploy" is a single agentic job that builds an app on the EC2 box and `aws s3 sync`s it straight to `s3://futurator-ai-website/apps/<slug>/` — live on `futurator.ai/apps/<slug>/`. The same success event also fast-forward-merges `plan/<slug>` into `main`. **Build, publish, and merge-to-trunk are all one coupled step. There is no environment you can click before it's live.**

v2.5 splits that one step into a **promotion ladder** you walk by hand:

```
plan/<slug> goes green  ──auto──▶  DEV        dev.futurator.ai/<slug>/      ← you click around the exact thing QA tested
        │ (you review)
        ▼ promote (copy artifact)
                          STAGING    staging.futurator.ai/<slug>/  ← production-shaped checks: smoke tests, real-ish data
        │ (you approve)
        ▼ promote (copy artifact) + merge plan/<slug> → main
                          PROD       futurator.ai/apps/<slug>/     ← unchanged from today
```

Three principles drive the whole design:

1. **Build once, promote the artifact.** The bytes you click on dev are the _same bytes_ that reach prod. We never rebuild per environment (that's how "works on staging, breaks in prod" happens).
2. **An environment is not a branch.** dev/staging/prod are _places you copy an artifact to_, not long-lived git branches. Your `plan/<slug>` branch is still the only integration branch; `main` is still production's source of truth. (More on why in §6.)
3. **Don't touch the control plane.** The admin app + its 20 DynamoDB tables stay single-production. dev/staging are **static-hosting-only** — two extra buckets the admin _orchestrates into_. This is what keeps it ~$0 and dodges a big refactor (see §7).

---

## 1. What we have today (ground truth, with file references)

### 1.1 The deploy is an agentic job, not a script

`POST /api/epic-workflows/:id/deploy` (`functions/api/index.ts:5288-5430`) enqueues a one-shot `DEPLOY` agent (Claude Haiku, tools `Bash,Read,Edit,Write,Glob`). The agent, running headless on EC2 inside `epic.workingDir`:

1. Patches `vite.config.ts` to set `base: '/apps/<slug>/'` (so assets resolve under the subpath).
2. `npm run build`.
3. `aws s3 sync <dist>/ s3://futurator-ai-website/apps/<slug>/ --delete`.
4. `aws cloudfront create-invalidation --distribution-id E1BI1YWMTLSDTE --paths "/apps/<slug>/*"`.
5. Emits `DEPLOY_URL:`, `DEPLOY_STATUS:`, `DEPLOY_DETAILS:` lines that the backend regex-parses.

`<slug>` = the leaf of the working-dir path, and it doubles as both the URL segment and the EC2 folder name.

### 1.2 The URL is pure convention — there is no routing table

`https://futurator.ai/apps/<slug>/` is reconstructed independently in three places (deploy endpoint `index.ts:5297`, daemon writeback, report aggregator `deploy-report-aggregator.ts:186`). CloudFront `E1BI1YWMTLSDTE` (aliases `futurator.ai`, `www.futurator.ai`) serves the `futurator-ai-website` bucket. **That bucket and distribution are owned by a _separate_ repo (the public homepage); this admin app only writes scoped prefixes into it.** (See `CLAUDE.md` deploy-safety section.)

### 1.3 Deploy = delivery = trunk advance (all coupled)

On `DEPLOY_STATUS: success`, the daemon's `postDeployWriteback` (`daemon/agent-daemon.mjs:5048-5118`) treats the deploy as the _delivery_ event:

- `git checkout -f main` → `git merge --ff-only plan/<slug>` → `git push origin main`
- safe-deletes `plan/<slug>`, `git clean -fd` the trunk
- the next plan forks brownfield off the new `main` tip.

So **there is currently no separate promotion, no staging gate, no versioned artifact, and no post-deploy verification beyond the agent's in-process build success.**

### 1.4 QA today runs against a _local_ dev server you can't see

Two tiers, both against `http://127.0.0.1:<port>` on EC2 (`daemon/lib/dev-server-boot.mjs`, `daemon/lib/wave-vqa-runner.mjs`):

- **Tier 1 — wave-gate VQA:** per wave, on the merged candidate, Playwright screenshots + a judge panel. Fix-forward (never blocks the green advance except on a deterministic no-boot).
- **Tier 2 — plan-level QA Review:** the `qa` pipeline stage, operator-gated, aggregates AC audit + VQA + automated gate into a verdict.

**This is the gap you felt:** everything QA "sees" is a screenshot from a headless browser on a box you don't have eyes on. There is no URL where _you_ can click the merged result. **Fixing that is Phase 1 and it's the highest-value, lowest-risk change in this whole doc.**

### 1.5 The pipeline stages

`src/components/labs/plan-dashboard/constants.ts:85-91`: `concept → developing → qa → deploy → published`. The "Deploy" stage UI already exists (`views/deploy-stage-view.tsx`) with a deferred-features list that _literally describes this doc_: versioned releases + rollback, **preview environments**, post-deploy smoke tests, two-person approvals, post-launch metrics.

---

## 2. The mental model, corrected

You wrote:

> plans run in their own big branch, then they converge at QA review, then we jump to "staging" branch, and then we merge to main (production).

Two gentle corrections, because they change the design:

**(a) Convergence is incremental, not a single event at QA.** Each story works on `wip/<storyId>`; each _wave_ merges those into a throwaway candidate, validates it, and atomically advances `plan/<slug>`. By the time you reach QA, `plan/<slug>` is _already_ the fully-integrated product. QA reviews it; it doesn't assemble it. ✅ Keep this. It's good. We are **not** rebuilding the git substrate (per your standing guidance).

**(b) "Staging branch" → "staging environment".** The industry-standard move is _not_ a long-lived staging branch. It's: build the artifact once from `plan/<slug>`, then **copy that same artifact** to a dev place, then a staging place, then a prod place. The branch (`plan/<slug>`) and the trunk (`main`) don't change between environments — only _where the built bytes are hosted_ changes.

Why this matters (the lesson): if you rebuild on a "staging branch" and again on "main", you've built the app **three times from three tree states**. The version your users get is one you never actually clicked. Promotion-of-one-artifact guarantees _what you approved is what ships, byte for byte._ This is the single most important DevOps habit in this whole document.

> **The one place a branch still moves:** `main`. Merging `plan/<slug> → main` is how we record "this is now production's source of truth" and how the next plan forks brownfield off it. In v2.5 that merge moves from "happens on deploy" to "happens only on the final production promotion" (§5.3).

---

## 3. The environment ladder (mapped to your screenshot #2)

Your screenshot's six rungs, mapped to what exists and what v2.5 adds:

| Rung                       | Catches                                    | Today                                         | v2.5                                                     |
| -------------------------- | ------------------------------------------ | --------------------------------------------- | -------------------------------------------------------- |
| **E1 Local/Dev**           | Does it run at all?                        | per-story worktree on EC2                     | unchanged                                                |
| **E2 CI/Integration**      | Do the pieces fit?                         | wave-merge + post-merge gate on `plan/<slug>` | unchanged                                                |
| **E3 Preview (ephemeral)** | Does this change work in isolation?        | ❌ none                                       | _(deferred — see §8; per-PR previews)_                   |
| **E4 QA/Test**             | Does it meet acceptance criteria?          | Tier-1 + Tier-2 QA, **headless on localhost** | **+ DEV URL you can click** (`dev.futurator.ai/<slug>/`) |
| **E5 Staging (pre-prod)**  | Does it survive production-shaped reality? | ❌ none                                       | **NEW** `staging.futurator.ai/<slug>/` + smoke tests     |
| **E6 Production**          | Real users, real money                     | `futurator.ai/apps/<slug>/`                   | unchanged URL, now reached only via promotion            |

**v2.5 deliberately does the cheap, high-value rungs (E4 visibility + E5 staging) and defers E3 (ephemeral per-PR previews).** Coverage, not count — you add an environment when a failure class is expensive in prod and invisible earlier. Right now your most expensive blind spot is "I can't see what QA tested," so E4-visibility comes first.

---

## 4. The hosting architecture (decided: subdomains via new SST sites)

### 4.1 Two new SST-managed static sites

`admin.futurator.ai` is already an `sst.aws.StaticSite` with a single `domain:` line that auto-provisions bucket + CloudFront + ACM cert + Route53 record (`sst.config.ts:1418-1429`). We reuse that exact, proven mechanism twice:

```ts
// sst.config.ts — conceptual additions (NOT a static export of THIS admin app;
// these are empty hosting shells the deploy agent syncs user apps INTO)
const devEnvBucket = new sst.aws.Bucket('DevEnvBucket'); // serves dev.futurator.ai/<slug>/
const stagingEnvBucket = new sst.aws.Bucket('StagingEnvBucket'); // serves staging.futurator.ai/<slug>/
// each fronted by its own CloudFront dist + ACM cert + Route53 record in the
// shared futurator.ai hosted zone (Z002886634JUZ2SIMCMV0)
```

> ⚠️ **Implementation nuance:** `StaticSite` wants to _build and upload a site_. Our dev/staging shells host _many_ user apps under path prefixes and are populated by the deploy agent's `aws s3 sync`, not by SST. So in practice these are likely a **`Bucket` + a `Router`/CloudFront** with the domain attached, not a literal `StaticSite`. The net effect (bucket + CDN + cert + DNS, all SST-managed, ~$0) is the same; the exact construct is a Phase-2 detail.

**URLs:**

- Dev: `https://dev.futurator.ai/<slug>/`
- Staging: `https://staging.futurator.ai/<slug>/`
- Prod: `https://futurator.ai/apps/<slug>/` _(unchanged — note prod keeps the `/apps/` segment; dev/staging don't need it since the whole subdomain is the app space)_

> **Base-path nuance (don't skip this):** the deploy agent patches Vite `base: '/apps/<slug>/'` for prod. On the subdomains the app lives at `/<slug>/`, so the base differs (`/<slug>/` vs `/apps/<slug>/`). This is exactly why **build-once-promote** needs care: a Vite SPA bakes the base path into asset URLs at build time, so the _same_ artifact can't trivially serve from two different base paths. Two clean ways out:
>
> - **(Recommended) Make all three environments use the same base path**, e.g. always `/<slug>/`, and put prod on `app.futurator.ai/<slug>/` (a new prod subdomain) OR keep prod at `futurator.ai/apps/<slug>/` but set base to `/apps/<slug>/` everywhere and host dev/staging at `dev.futurator.ai/apps/<slug>/` too. Pick one base, use it in all three. Then the artifact is genuinely identical.
> - **(Avoid)** Rebuild per env with a different base — that breaks the build-once promise.
>
> **Decision to lock in Phase 2:** standardize the path segment across all three envs so one artifact promotes cleanly. My lean: `dev.futurator.ai/apps/<slug>/`, `staging.futurator.ai/apps/<slug>/`, `futurator.ai/apps/<slug>/` — identical `base`, zero rebuild. Slightly longer dev URL, but byte-identical promotion. (This is a real, concrete example of a "deployment nuance" you asked to experience.)

### 4.2 IAM

The API/daemon Lambda role already has scoped `s3:*` on `futurator-ai-website/apps/*` and `cloudfront:CreateInvalidation` on `E1BI1YWMTLSDTE` (`sst.config.ts:930-1003`). v2.5 adds grants for the two new buckets + their two new distributions. Since the new buckets are SST-managed, SST wires these grants by reference (no hardcoded ARNs) — cleaner than the existing externally-owned prod bucket.

### 4.3 Cost

~$0 at rest, consistent with the zero-cost rule:

- CloudFront: no fixed monthly fee, 1 TB/mo free tier.
- S3: pennies for static `dist/` output.
- ACM public certs: free. Route53 records: free (the hosted zone is already paid, shared).
- No Fargate, no always-on compute.

---

## 5. The promotion flow, step by step

### 5.1 Phase 1 — DEV visibility (the thing you actually asked for first)

**Goal:** the moment `plan/<slug>` goes green (after wave merges), publish it to `dev.futurator.ai/.../<slug>/` so you can click exactly what QA is testing.

**Mechanism:** reuse the existing deploy agent, parameterized by environment. Add an `environment: 'dev' | 'staging' | 'production'` input that selects the target bucket + distribution + (standardized) base path. Trigger a **dev deploy automatically** when a plan enters the `qa` stage (or when Tier-1 green advance completes).

**UI:** the QA Review stage gets a **"Open in dev ↗"** button next to the headless VQA screenshots. Now QA's verdict and _your own eyes_ look at the same URL.

This is ~80% reuse of code that already works. It's the cheapest win and de-risks everything after it.

### 5.2 Phase 2 — STAGING + the artifact store

**Goal:** a production-shaped pre-prod check before you commit to going live.

**Mechanism (build-once-promote):**

1. When the dev build succeeds, **save the built artifact** to a versioned store: `s3://<artifacts-bucket>/<slug>/v<timestamp>/`. (This is the "versioned releases" deferred feature — we build it here because promotion _needs_ an immutable artifact to copy.)
2. **Promote to staging** = `aws s3 sync` that stored artifact (no rebuild) into the staging bucket + invalidate staging CDN. Operator clicks **"Promote to staging"** on the Deploy stage.
3. **Staging checks run** against the real `staging.futurator.ai/<slug>/` URL:
   - **Post-deploy smoke test** (the deferred "curl + parse" feature): does the page load, return 200, contain expected markers? This is the _first_ test in the whole pipeline that hits a real CDN-served URL over real HTTPS — it catches base-path bugs, MIME-type issues, missing-asset 404s that localhost never shows.
   - Optionally re-run the Playwright suite against the staging URL (now exercising real CDN caching, real TLS, real cold-cache latency).
4. Staging is where, _later_, you introduce **production-shaped data** (synthetic/anonymized users, real API patterns) as your apps start storing scores/DB data. Staging should point at **non-production data stores** so a bad build can't corrupt real user data. (See §9 — this is the big one for when you add databases.)

### 5.3 Phase 3 — PRODUCTION promotion (decoupled from build & merge)

**Goal:** going live is a deliberate, single, reversible action.

**Mechanism:**

1. Operator reviews staging, clicks **"Promote to production"** (typed-confirmation gate, like the existing red-class confirmations).
2. Promote = `aws s3 sync` the _same stored artifact_ into the prod path + invalidate prod CDN. **No rebuild.**
3. **Only now** does `git merge --ff-only plan/<slug> → main` happen (moved out of the deploy step). Production source-of-truth advances exactly when production hosting advances. The next plan forks off the new `main`.
4. Record the release (slug, artifact version, git SHA, timestamp, who approved) for history + rollback.

**Rollback (the deferred "versioned releases + rollback" feature, now natural):** because every release is `…/<slug>/v<timestamp>/` in the artifact store, rollback = re-sync a previous version's bytes to the prod path + invalidate. Fast and safe. (A pointer-object scheme — prod reads a `current` pointer instead of being a sync target — is the more elegant end-state; the timestamped store is the prerequisite either way.)

---

## 6. Branching: what changes, what doesn't

**Unchanged (keep all of it):**

- `wip/<storyId>` per story.
- Wave-merge → atomic CAS advance of `plan/<slug>`.
- `plan/<slug>` is the single integration branch and the source for _all_ environment builds.
- `main` = production source of truth; next plan forks brownfield off it.

**Changed (one thing):**

- The `plan/<slug> → main` fast-forward merge moves from **"on deploy success"** (`postDeployWriteback`, `daemon/agent-daemon.mjs:5048-5118`) to **"on production promotion"**. Until you promote to prod, `main` does not move and the plan branch stays alive — which is also what lets you **abandon a release after seeing it on staging** without ever having polluted trunk.

**No staging branch.** Staging is a bucket, not a branch. If you later want a paper-trail tag, cut a lightweight annotated git tag `release/<slug>/v<timestamp>` at promotion time — traceability without a long-lived branch to keep in sync.

> **Lesson — "trunk-based + environment promotion" vs "branch-per-environment":** Long-lived `develop`/`staging`/`main` branches (GitFlow) were designed for slow, batched, multi-team releases. They cause merge debt and env-drift. Modern single-operator / continuous setups use **one trunk + immutable artifacts promoted across environments**. Your existing wave-merge-onto-`plan/<slug>` design is _already_ trunk-based in spirit; v2.5 just extends that philosophy to releases. We're not adding GitFlow.

---

## 7. The constraint you must respect (and why dev/staging is _static-only_)

There is a deliberate guard in `sst.config.ts:45-54`: **the SST stack refuses to deploy on any stage except `production`.** Reason (`sst.config.ts:18-43`): ~20 DynamoDB tables have hardcoded names (`futurator-plans`, `futurator-agent-jobs`, …) with **no stage namespacing**. A second stage would read/write the _same production tables_ and its `rate(1 minute)` crons would race production (this actually happened — the "snake-1 bifurcation" incident, 2026-04-28).

**Consequence for v2.5:** we do **not** stand up a second copy of the admin app/control-plane for dev or staging. The admin app, its API, its crons, and its tables stay **single-production**. dev/staging are _just static hosting buckets that the single production control-plane deploys user apps into_. This is the entire reason the plan is cheap and safe — we sidestep the table-namespacing refactor completely.

**The exception that forces the refactor:** the moment your _user apps_ need their own backends with persisted data (scores, DB) and you want dev/staging copies of _that data_, you hit the same wall for the user apps' data plane. That's §9, and it's explicitly a _later_ phase.

---

## 8. Deferred-features list (screenshot #1), reconciled

| Deferred feature                      | v2.5 disposition                                                                                                              |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **Versioned releases + rollback**     | **Built in Phase 2** (artifact store is a prerequisite for promotion). Rollback = re-sync prior version.                      |
| **Preview environments** (per-branch) | **Still deferred.** This is rung E3 (per-PR ephemeral). Lower value than dev/staging right now; revisit once volume picks up. |
| **Post-deploy smoke tests**           | **Built in Phase 2** (curl+parse against the real staging URL; the first real-HTTPS test).                                    |
| **Two-person approvals**              | **Still deferred** — single-operator factory (you). Keep the typed-confirmation gate; revisit if a second human joins.        |
| **Post-launch metrics**               | **Still deferred** to the Published stage. Uptime/traffic/error-rate after live.                                              |

---

## 9. The big one — when user apps start storing data (read before you add scores/DB)

Everything above is safe because the apps are static SPAs with no persisted state — promoting bytes is harmless. **The day an app stores user scores / DB rows, "promotion" stops being only about bytes** and the hard parts of real-world deployment arrive. Be aware of:

1. **Data-plane isolation per environment.** Staging must point at a **separate datastore** from prod. Otherwise a staging test writes garbage into real user data. This is non-negotiable once data is real.
2. **Migrations.** Schema changes must run _before/with_ the artifact that needs them, and must be **backward-compatible** during the window when old + new code coexist (expand-then-contract). This is the #1 source of real production incidents.
3. **Seeding staging with production-shaped data** (your screenshot's "anonymized/synthetic, mid-journey fake users, real API patterns") — so staging catches "works on empty DB, breaks with real data" bugs.
4. **Per-app backends** re-open the SST stage / table-namespacing problem from §7 _for the user apps_ — likely solved per-app (each app owns its own tables, namespaced by env) rather than reopening the admin refactor.
5. **Secrets & config per environment** (API keys, endpoints) — staging keys ≠ prod keys.

**Recommendation:** ship Phases 1–3 for **static apps only** first (immediate value, low risk, you learn the promotion muscle). Treat "stateful user apps" as **v2.6**, designed when the first app actually needs a database — not speculatively now. (Consistent with your "ship MVP, add complexity later" preference.)

---

## 10. Phased rollout

| Phase     | Deliverable                                                                                                                                           | Risk                                                     | Value                                              |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------- |
| **1**     | Parameterize deploy agent with `environment`; auto-deploy green plans to `dev.futurator.ai/.../<slug>/`; **"Open in dev ↗"** in QA stage              | Low (reuses working code)                                | **Highest** — solves "I can't click what QA tests" |
| **2**     | New SST dev+staging buckets/CDNs/DNS; standardize base path; artifact store (`v<timestamp>`); **"Promote to staging"** + smoke tests against real URL | Medium (new infra, base-path care)                       | High — real pre-prod gate                          |
| **3**     | **"Promote to production"** gate; move `plan→main` merge to prod promotion; release history; rollback                                                 | Medium (touches the trunk-merge timing — test carefully) | High — safe, deliberate, reversible go-live        |
| **2.6**   | Stateful user apps: per-env data isolation, migrations, seed data                                                                                     | High                                                     | Deferred until first DB app                        |
| **later** | Ephemeral per-PR previews (E3), two-person approvals, post-launch metrics                                                                             | —                                                        | Deferred per §8                                    |

---

## 11. Things to be aware of / open decisions

- **Base-path standardization (§4.1)** is the one real technical gotcha. Decide the shared path segment in Phase 2 before building the artifact store. My lean: `*.futurator.ai/apps/<slug>/` across all three envs.
- **The prod bucket/CDN is externally owned** (`futurator-ai-website` / `E1BI1YWMTLSDTE`, the homepage repo). Keep honoring the `CLAUDE.md` deploy-safety rule — we only ever write the scoped `apps/<slug>/` prefix there. dev/staging are _our_ SST-managed buckets, which is cleaner.
- **`CLOUDFRONT_DISTRIBUTION_ID` is read from env but not set in `sst.config.ts`** (`deploy-report-aggregator.ts:189`) — the prod CF id only lives hardcoded in the agent prompt, so the Deploy stage's "CloudFront" footer is currently blank. Fix while we're parameterizing per-env distributions.
- **The redeploy endpoint is a stub** (`functions/api/index.ts:10705-10732`, returns 202, does no work). The artifact store from Phase 2 is exactly what it needs to become real.
- **Two merge models exist** (plan pipeline = local `--ff-only` no-PR; party/free-agent = GitHub squash-PR). v2.5 only touches the _plan pipeline_ merge timing. Leave party publishing alone.
- **Don't lower agent concurrency** to manage any host load from extra builds — per standing guidance, parallelism is the feature under test; fix footprint/cruft instead if dev-deploys ever strain the box.

---

## 12. Appendix — key file references

| Concern                                               | Location                                                                                               |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Deploy endpoint (agentic)                             | `functions/api/index.ts:5288-5430`                                                                     |
| Deploy URL convention                                 | `index.ts:5297`, `deploy-report-aggregator.ts:186`                                                     |
| Post-deploy writeback + `--ff-only` merge to main     | `daemon/agent-daemon.mjs:5048-5118`                                                                    |
| Redeploy stub                                         | `functions/api/index.ts:10705-10732`                                                                   |
| Deploy stage UI + deferred features                   | `src/components/labs/plan-dashboard/views/deploy-stage-view.tsx`, `views/deploy/deferred-features.tsx` |
| Pipeline stages                                       | `src/components/labs/plan-dashboard/constants.ts:85-109`                                               |
| QA: local dev-server boot + VQA                       | `daemon/lib/dev-server-boot.mjs`, `daemon/lib/wave-vqa-runner.mjs`                                     |
| Wave merge → `plan/<slug>` atomic advance             | `daemon/lib/wave-merge-runner.mjs`                                                                     |
| Worktree/branch naming                                | `daemon/lib/worktree-paths.mjs`, `daemon/lib/story-worktree.mjs`                                       |
| SST AdminSite (the StaticSite pattern to copy)        | `sst.config.ts:1418-1429`                                                                              |
| Production-only deploy guard + table-namespacing note | `sst.config.ts:18-54`                                                                                  |
| Public bucket/CF constants + IAM scoping              | `sst.config.ts:90-102, 930-1003`                                                                       |
| Shared Route53 hosted zone                            | `Z002886634JUZ2SIMCMV0` (`sst.config.ts:1411`)                                                         |
| Prior deployment guide                                | `docs/concepts/futurator-deployment-guide-v2.md`                                                       |

---

## 13. Implementation status (what shipped)

Phases 1–3 are implemented. The promotion machinery degrades safely: it works **today** on the shared public bucket (dev/staging under reserved `apps/_dev/` / `apps/_staging/` prefixes), and **auto-upgrades** to true build-once copy promotion across `dev.`/`staging.futurator.ai` the moment the §14 infra is deployed — no code change.

### New modules

- `functions/shared/deploy/deploy-targets.ts` — `resolveDeployTarget(slug, env)`. Env-var-gated: reads `DEV_ENV_BUCKET`/`DEV_ENV_CF_ID`/`STAGING_ENV_BUCKET`/`STAGING_ENV_CF_ID` → subdomain hosting (base `/apps/<slug>/` everywhere, copy-promotable); else shared-bucket prefixes. `sourceEnvironmentFor`, `releaseArchivePrefix`.
- `functions/shared/deploy/build-deploy-pipeline.ts` — `buildDeployPipeline` / `buildDeployJob` (build + sync + invalidate; archives the release on production).
- `functions/shared/deploy/build-promote-pipeline.ts` — `buildPromotePipeline` (COPY when src/dst share a base path; REBUILD-at-dst otherwise) + smoke-test step + production archive; `buildRollbackPipeline`; `buildPromoteJob` / `buildRollbackJob`.

### Endpoints

- `POST /api/epic-workflows/:id/deploy` `{ environment }` — environment-aware build deploy (default `production`).
- `POST /api/plans/:id/promote` `{ to: 'staging' | 'production' }` — ladder-gated artifact promotion; production promote does the delivery bookkeeping (registry published, `deployJobIds`, and via the daemon, merge to `main`).
- `POST /api/plans/:id/rollback` `{ jobId }` — restore a previously-archived production release; **never advances `main`** (`skipTrunkAdvance`).

### Daemon

- `postDeployWriteback` routes by `job.deployEnvironment`: `dev`/`staging` record a preview URL only; `production` advances `main` **unless** `skipTrunkAdvance` (rollbacks). A promote job carries `deployEnvironment = <destination>` and emits the standard `DEPLOY_STATUS`/`DEPLOY_URL`, so this one function handles deploys, promotes, and rollbacks uniformly.

### Auto-trigger

- The wave-completion cron auto-publishes the green build to **dev** when a plan reaches `review` (once per plan). The QA stage surfaces **"Open in dev ↗"**.

### UI

- QA stage: dev-preview cluster (Open in dev / Deploy to dev).
- Deploy stage: **environment ladder** (dev → staging → production with live status + URLs), **"Promote to staging"**, **"Promote to production"** (typed-confirm), and **functional rollback** in deploy history (two-click armed; eligible for COMPLETED releases only).

### Tests

- `functions/shared/deploy/__tests__/deploy-targets.test.ts` (prefix isolation invariant, provisioning).
- `functions/shared/deploy/__tests__/promote-pipeline.test.ts` (copy-vs-rebuild mode, archive, job routing, rollback no-trunk-advance).

### Bug fixed along the way

- The Deploy stage's Environment footer CloudFront row was blank (`CLOUDFRONT_DISTRIBUTION_ID` env var was never set). The aggregator now derives the target via `resolveDeployTarget`, so the distribution id is always populated.

---

## 14. SST subdomain infra — ready-to-apply appendix (NOT yet in `sst.config.ts`)

This is the one piece deliberately left out of the live `sst.config.ts` because it can't be validated without `sst deploy` against AWS, and a malformed resource would block the whole stack. Apply it deliberately, then `sst deploy`. Once the env vars below are live, `deploy-targets` auto-switches dev/staging to their own buckets + subdomains and promotion becomes a pure S3 copy (true build-once).

> ⚠️ **Verify the exact SST v4 construct names/props against the installed `sst` version before deploying** — the shape below is conceptual. The bucket+CDN+cert+Route53-record outcome is what matters; the `Router` route-binding syntax in particular may differ by version.

```ts
// ── Inside run(), alongside the other resources ──

// Two static-hosting shells. NOT StaticSite (which would purge synced apps on
// every deploy) — plain Buckets that the deploy/promote agents sync INTO.
const devEnvBucket = new sst.aws.Bucket('DevEnvBucket', {
  transform: { bucket: { bucketName: 'futurator-admin-dev-env' } },
});
const stagingEnvBucket = new sst.aws.Bucket('StagingEnvBucket', {
  transform: { bucket: { bucketName: 'futurator-admin-staging-env' } },
});

// CloudFront + ACM cert + Route53 record per subdomain (shared zone
// Z002886634JUZ2SIMCMV0 is discovered by name match, same as AdminSite).
const devRouter = new sst.aws.Router('DevRouter', {
  domain: 'dev.futurator.ai',
  routes: { '/*': { bucket: devEnvBucket } },
});
const stagingRouter = new sst.aws.Router('StagingRouter', {
  domain: 'staging.futurator.ai',
  routes: { '/*': { bucket: stagingEnvBucket } },
});
```

Then add these to the **API** function env **and** the **WaveCompletionCheck** cron function env (both call `resolveDeployTarget`):

```ts
environment: {
  // ...existing...
  DEV_ENV_BUCKET: devEnvBucket.name,
  DEV_ENV_CF_ID: devRouter.distributionID,
  STAGING_ENV_BUCKET: stagingEnvBucket.name,
  STAGING_ENV_CF_ID: stagingRouter.distributionID,
},
```

### Prerequisite the admin SST app does NOT control

The deploy/promote agents run `aws s3 sync` + `cloudfront create-invalidation` on **EC2 under the instance role** — not the Lambda. That instance role must be granted, for the two new buckets:

- `s3:PutObject`, `s3:GetObject`, `s3:DeleteObject`, `s3:ListBucket` on `arn:aws:s3:::futurator-admin-dev-env*` and `…-staging-env*`
- `cloudfront:CreateInvalidation` on the two new distributions

Until both the SST resources **and** this IAM grant are in place, leave the env vars unset — the code stays on the shared-bucket fallback (functional, just rebuild-promotion under `apps/_dev/` / `apps/_staging/` instead of byte-copy).

### Cost

~$0 at rest: CloudFront has no fixed fee (1 TB/mo free tier), S3 storage is pennies, ACM certs are free, Route53 records are free (zone already paid). No always-on compute.

---

## 15. Environment-true subdomains + plan/app identity — the v2.6 fixing plan (2026-06-19, deployment session)

> §14 was **applied** since it was written: the `DevEnvBucket`/`StagingEnvBucket` + `DevRouter`/`StagingRouter` + env vars now exist (the auto-named buckets are `futurator-admin-production-devenvbucketbucket-*` / `…-stagingenvbucketbucket-*`; the `bucketName` transform never took — cosmetic). But the subdomains **serve `403` on directory paths**, so I added a flag (`DEPLOY_ENV_SUBDOMAINS`, default OFF) that currently keeps dev/staging on the **fallback** (`futurator.ai/apps/_dev/…`, `/apps/_staging/…`) — which works because it rides the production website bucket. This section is the plan to make the **real subdomains** work and adopt the correct **plan-vs-app** identity model.

### 15.1 Root cause (confirmed against live AWS)

`dev` dist `E10EO7ORIP20S6` and `staging` dist `E3F34BER0RR7H7`: `DefaultRootObject:""`, **`FunctionAssociations:0`**, origin = S3 **REST** endpoint + OAC; buckets have **no website hosting**. So `dev.futurator.ai/<x>/` maps to the S3 key `<x>/` (not an object) → **403** (only explicit `…/index.html` + assets serve). Production works only because `futurator-ai-website` is a **website-hosting** bucket (auto-serves index docs for directory paths). The fix is the thing `StaticSite` does automatically and a bare `Router` does not — proven in-account by `futurator-production-AdminSiteCloudfrontFunctionRequest-*`.

### 15.2 The identity model: dev = plan, staging/prod = app

| Env         | Identity               | URL                        | Rationale                                                                                                                                     |
| ----------- | ---------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| **dev**     | **plan** (`plan.name`) | `dev.futurator.ai/<plan>`  | Tests _this plan's_ merged branches in QA, before it's accepted as the app. Plan-scoped so concurrent plans (even for one app) don't collide. |
| **staging** | **app** (`appId`)      | `stage.futurator.ai/<app>` | The QA-approved plan = the app's next-release candidate. One staging slot per app.                                                            |
| **prod**    | **app** (`appId`)      | `futurator.ai/apps/<app>`  | Live app. Unchanged.                                                                                                                          |

Mirrors git: `plan/<name>` (dev) → merge to `main` = the app (staging→prod). Today `deploy-targets` keys all three by the working-dir leaf (≈ appId) — that's the gap.

### 15.3 Why subdomains over `futurator.ai/apps/_dev/<id>` (the path-prefix)

- **Browser-origin isolation (the decisive one):** a subdomain is a separate origin → separate cookies, `localStorage`, `IndexedDB`, and service-worker scope. The path-prefix shares the prod origin, so dev/staging/prod **share client state** (a game's `localStorage` high score is one store across all three; a prod service worker can intercept `_dev` paths). This is exactly the failure class once apps "store users' scores / DB data."
- **Blast radius:** separate buckets — dev/staging can't touch the public homepage bucket (`futurator-ai-website`, the 2026-04-15 incident class).
- **Per-env controls:** can password/WAF/cache staging independently of prod.
- Path-prefix is fine **only** for stateless static apps + as the zero-infra stopgap (it works today). Subdomains are the durable choice for a stateful, demoable pipeline. Both coexist via the `DEPLOY_ENV_SUBDOMAINS` flag.

### 15.4 The fix — two coupled parts

**Part A — infra (make the subdomains serve).** Attach a CloudFront **viewer-request Function** (`cloudfront-js-2.0`) to the dev + staging Routers that rewrites directory/extensionless URIs → `…/index.html`:

```js
function handler(event) {
  var req = event.request,
    uri = req.uri;
  if (uri.endsWith('/')) req.uri = uri + 'index.html';
  else if (!uri.split('/').pop().includes('.')) req.uri = uri + '/index.html';
  return req;
}
```

Encode it durably in `sst.config.ts`: prefer a native `Router` edge/function option **if the installed SST v4 exposes one** (verify — platform sources aren't in `node_modules`); otherwise create a Pulumi `aws.cloudfront.Function` and attach it to each Router's default cache behavior via the Router's `transform`. (CLI attach is a viable _stopgap_ for an imminent demo, but it drifts — a later `sst deploy` reverts it, so land the SST version.) Then flip `DEPLOY_ENV_SUBDOMAINS=on` on the Api + WaveCompletionCheck functions.

**Part B — code (plan/app identity).** Change `resolveDeployTarget(slug, env)` → `resolveDeployTarget({ planSlug, appId }, env)` and resolve per-env: dev → host `dev.futurator.ai`, identity `planSlug`, prefix `''`; staging → `stage.futurator.ai`, `appId`, `''`; prod → `futurator.ai`, `appId`, `apps/`. The deploy/promote/cron call sites already hold the plan row — pass both `plan.name` and `plan.appId`. The daemon writeback needs no change (URLs flow from the resolved target).

### 15.5 Build-once tradeoff (a decision to make)

Identity/base-path differs per env (`/<plan>/` vs `/<app>/` vs `/apps/<app>/`), so each hop **rebuilds** — byte-identical copy can't survive a plan→app identity change. Two options:

- **(Recommended) Hybrid:** dev = per-plan preview (rebuild is fine — throwaway QA view); make **staging↔prod share `/apps/<app>/`** (i.e. `stage.futurator.ai/apps/<app>`) so the _consumer-facing_ hop is a true byte-copy — "what you approved is what ships."
- **(Prettier) Full identity URLs** (`stage.futurator.ai/<app>`) accepting a rebuild on every hop — fine for prototyping. (Overlaps fixes-plan **Q11**.)

### 15.6 Rollout order

1. Add the CF index-rewrite to dev/staging Routers (SST) + `sst deploy` → verify `dev.futurator.ai/apps/<id>/` → 200 (still appId-keyed).
2. Implement plan/app identity (Part B) → verify dev keyed by plan.
3. `DEPLOY_ENV_SUBDOMAINS=on`.
4. Run one plan end-to-end: `dev.futurator.ai/<plan>` → promote → `stage.futurator.ai/<app>` → `futurator.ai/apps/<app>`. Retire the `apps/_dev/` + `apps/_staging/` fallback prefixes.

### 15.7 Cross-stage impact — other agents must adapt

- **QA-review session (`QAreview-agentic`):** dev becomes a **real, plan-scoped, immutable** `dev.futurator.ai/<plan>` URL — exactly the mechanism F11/Q-C9/Q7 wanted ("QA against the dev-deploy URL instead of booting `next dev` in the shared worktree"). The impl-pass _serialized_ F11 but deferred this root fix to Q7/Q11; the plan-scoped dev URL is what unblocks it. QA should: point "Open in dev" + its verification at `dev.futurator.ai/<plan>`, and resolve F11/Q-C9 by targeting it. (QA owns its own rubric/criteria updates.)
- **concept-develop / pipeline owner:** adopt the plan-vs-app identity in any deploy-adjacent design; the `resolveDeployTarget` signature change ripples to deploy/promote/cron call sites.

See fixes-plan **F29** (Track H) for the tracked remediation + hand-off.
