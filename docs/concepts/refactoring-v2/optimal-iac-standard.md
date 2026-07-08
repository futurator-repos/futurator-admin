# The Optimal IaC Standard

**A provider-agnostic infrastructure-as-code standard for every app built in Mycelium — aligned 1:1 with the Futurator "Assess" IaC maturity engine.**

**Date:** 2026-07-08
**Status:** canonical standard
**Applies to:** any app the Mycelium command center scaffolds, deploys, or evolves — regardless of cloud (AWS/GCP/Azure/self-hosted), IaC tool (Terraform/OpenTofu/Pulumi/CDK/SST/CloudFormation/Bicep), or team strategy.
**Companion:** the grading logic this standard is derived from lives in `daemon/scripts/refactor-recon/infra-extract.mjs` (`gradeIacMaturity`, `iacCoverage`, `computeModuleReadiness`) and `daemon/pipelines/lib/iac-phase-planner.mjs`. This document is the _human/agent-readable contract_ for the same rubric the engine scores.

---

## 0. Why this document exists

Mycelium is a command center that **creates and evolves apps**. We want IaC excellence to be a property of the _factory_, not an afterthought bolted on per app. This standard makes that enforceable:

1. **Alignment.** Futurator's Assess engine scores every app's IaC on a 6-dimension, 5-level rubric. This document _is_ that rubric, expressed as buildable requirements. An app that satisfies this standard scores **Level 4 (Optimizing)** — by construction, not by gaming.
2. **Provider-agnostic.** Requirements are stated as **properties the infrastructure must exhibit**, never as a specific tool's syntax. §9 maps each property to how any mainstream tool satisfies it. A team picking Pulumi and a team picking Terraform both reach the same score.
3. **Progressive.** An app does not need Level 4 on day one — it needs to **hit each level's bar at the right lifecycle stage and never regress**. §5 defines the stage→level ladder Mycelium enforces as apps evolve.

> **The one-sentence law:** _Everything that costs money or holds state is declared in version-controlled IaC, tagged, environment-scoped, and reconciled against reality — from the first resource onward._

---

## 1. First principles (the invariants that never change)

These hold at every level and for every tool. They are the "constitution"; the dimensions in §2 are how we grade progress toward them.

| #      | Invariant                                                                                                                                                                                                                                                             | Why it matters                                                                                                                                                                                       |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **I1** | **Declared coverage = 1.0.** Every provisionable, stateful, or billable resource is created by an IaC **resource constructor** in version control. Not the console. Not a `deploy.sh`. Not merely referenced by an IAM ARN.                                           | An undeclared data plane is invisible to cost, audit, drift, and reproducibility. This is the single highest-leverage property — the assessment's `iacCoverage.resourceRatio` measures exactly this. |
| **I2** | **One source of truth; zero drift.** The running cloud never diverges from the code. Drift is treated as a bug, detected on a schedule, and reconciled — never patched by hand.                                                                                       | Hand edits erode every other guarantee. `plan`/`preview` must show **no changes** before any commit.                                                                                                 |
| **I3** | **Legibility.** A machine can enumerate every resource and answer: what is it, who owns it, which environment, which data classification, what lifecycle.                                                                                                             | This is what unlocks the downstream FinOps / privacy / policy modules. Legibility is a first-class deliverable, not documentation.                                                                   |
| **I4** | **Declared vs. verified.** Code declares _intent_; a reconcile step confirms _reality_. Never assert as fact what the code cannot prove (backups, encryption, live health). Carry a `basis` and a verification backlog until a live reconcile flips it to `verified`. | Honest infra reporting. The assessment refuses to score cloud-only facts as maturity; it emits them as an explicit verification backlog.                                                             |
| **I5** | **Every resource is born complete.** No resource exists without: a stable **name**, the full **tag taxonomy**, an **environment**, a **data classification**, and a **lifecycle policy** (retention / deletion-protection / versioning as applicable).                | "Add tags later" never happens. Completeness at birth is cheap; retrofitting is expensive and is what the assessment flags.                                                                          |
| **I6** | **No secrets in code, no secrets in function env.** Secrets live in a secrets manager and are referenced; they are never committed and never injected as plaintext into a function's environment block.                                                               | A committed secret or an env-injected credential is a security finding the assessment raises directly.                                                                                               |
| **I7** | **Maintained toolchain only.** No archived/EOL IaC tooling (see §8 anti-patterns).                                                                                                                                                                                    | Deprecated tooling is unmaintained risk; the assessment carries a deprecation catalog and downgrades these.                                                                                          |

---

## 2. The six dimensions (the grading axes) — with the bar at each level

The assessment grades these **six dimensions independently** (they may be uneven — that is intentional), then rolls up to an overall 0–4 level with a **min-gated** rule (§4). For each dimension below: the property, the provider-agnostic requirement, and the exact bar to clear Level 1 → 2 → 3 → 4.

Maturity levels (industry-standard ladder): **L0 ClickOps · L1 Repeatable · L2 Defined · L3 Managed · L4 Optimizing.**

### 2.1 State & provisioning

- **Property:** provisioning is reproducible and state is remote, locked, and encrypted.
- **Requirement:** a managed/remote state backend with locking; **no state file committed** to the repo; state encrypted at rest.
- **Bars:**
  - **L1:** an IaC tool is adopted and provisions resources (no more console click-ops).
  - **L2:** remote **and** locked **and** encrypted state backend (or a platform that manages state for you). No committed state.
  - **L3:** state access is least-privilege and audited; state is backed up.
  - **L4:** state operations are fully automated in CI with no human write path.

### 2.2 Environment separation

- **Property:** dev / staging / prod are isolated so a change to one can never clobber another.
- **Requirement:** distinct state and configuration per environment (separate stacks / workspaces / directories / per-env variable files).
- **Bars:**
  - **L1:** stage/workspace tooling present but environments not clearly separated.
  - **L2:** ≥2 clearly separated environments with **separate state**.
  - **L3:** promotion between environments is gated and identical infra code is parameterized (no per-env divergence in logic).
  - **L4:** ephemeral/preview environments spun from the same definitions on demand.

### 2.3 Modularity & composition

- **Property:** infrastructure is composed from reusable, **version-pinned** building blocks, not a monolith.
- **Requirement:** shared infra extracted into modules/components with **pinned/versioned sources**; the root is not a giant flat file.
- **Bars:**
  - **L1:** resources declared inline / monolithic.
  - **L2:** modules/components present (but not version-pinned).
  - **L3:** modules composed from **pinned/versioned** sources.
  - **L4:** an internal module library / platform layer that apps consume; breaking changes are versioned.

### 2.4 Testing

- **Property:** infrastructure has an automated test pyramid wired into CI — the infra analogue of TDD.
- **Requirement:** static validation + **unit tests** (assertion/mocked synthesis) and, above L2, **integration tests** (apply to a sandbox, assert real behavior), all as **required CI checks**.
- **Bars:**
  - **L1:** format/validate only (or none).
  - **L2:** unit tests present (native assertions / mocked provider).
  - **L3:** unit **and** integration tests as required checks.
  - **L4:** contract/compliance tests + policy tests; test coverage gates merges.

### 2.5 Governance (policy-as-code + scanning)

- **Property:** misconfigurations and policy violations are caught automatically before they ship.
- **Requirement:** static misconfig **scanning** (Checkov/Trivy-class) **and** **policy-as-code** (OPA/Conftest, CrossGuard, Sentinel-class), starting advisory and promoted to mandatory.
- **Bars:**
  - **L1:** none.
  - **L2:** static misconfig scanning configured.
  - **L3:** policy-as-code present (advisory or mandatory) **plus** scanning.
  - **L4:** policy is **mandatory** (blocks merge/deploy) and covers tagging, region, public-exposure, and encryption rules.

### 2.6 Drift, cost & tagging

- **Property:** drift is detected on a schedule, cost is gated per change, and every resource carries a cost/ownership tag taxonomy.
- **Requirement:** a **scheduled** drift check (`plan/preview --expect-no-changes` on a cron, evidenced by a CI workflow — not prose), a **cost gate** per PR (Infracost-class, evidenced by a config/CI artifact), and the full **tag taxonomy** (§3.2).
- **Bars:**
  - **L1:** none.
  - **L2:** any one of {scheduled drift check, cost gate, ≥75% tag taxonomy}.
  - **L3:** scheduled drift check **and** cost gate.
  - **L4:** drift auto-reconciles or auto-alerts, cost budgets are enforced, tag taxonomy is 100% and policy-enforced.

---

## 3. Resource-level requirements (the coverage & lifecycle contract)

Dimensions (§2) grade the _pipeline_; this section grades the _resources_. These are where most real-world scores are won or lost, and they map to the assessment's resource-level model (`services[].resources[]`, `iacCoverage`, tag taxonomy, PII mapping, orphan triage).

### 3.1 Full declared coverage (Invariant I1, restated as a check)

- Every table, bucket, queue, function, database, cache, and CDN that the app uses is **declared by a resource constructor**.
- A resource that appears **only** as an IAM-grant ARN, a `create-*` shell script, or a console-created object is **`used-but-undeclared`** — it counts _against_ coverage. Adopt it into IaC (import) before it can count as declared.
- Referenced-but-not-declared resources must be marked **existence: unknown** — never assert a resource exists just because code names it.
- **Target:** `iacCoverage.resourceRatio == 1.0`, `undeclared == []`.

### 3.2 The tag taxonomy (7 tags, on every resource)

Applied via the IaC tool's default/provider-level tagging so it is uniform and declared:

| Tag                   | Purpose                                                                 |
| --------------------- | ----------------------------------------------------------------------- |
| `team`                | ownership (human)                                                       |
| `environment`         | dev/staging/prod scoping                                                |
| `service`             | which app/service                                                       |
| `cost-center`         | FinOps attribution                                                      |
| `owner`               | accountable individual/role                                             |
| `managed-by`          | the IaC tool/stack that owns it (proves it is not click-ops)            |
| `data-classification` | public / internal / confidential / pii — **unlocks the privacy module** |

- Platform-implicit tags (e.g. an `sst:app` / `sst:stage` a platform adds automatically) are **not** a substitute — they are reported separately and do not count toward the operator-declared taxonomy.
- **Target:** 100% of the 7 tags present in declared IaC.

### 3.3 Region & residency

- Pin a **single region** per environment, or declare an explicit multi-region policy. An unpinned region is a compliance and cost risk.
- Record data **residency** for every store (in-account vs. external processor). External processors are compliance-relevant.

### 3.4 Stateful-store hardening (the "verification backlog" you should pre-satisfy)

For every database/bucket/queue that holds state, the IaC declares (so it can later be _verified_, not just assumed):

- **Point-in-time recovery / backups** enabled.
- **Deletion protection** on production stores.
- **Versioning** on object stores.
- **Encryption at rest** with a customer-managed key where the data class requires it.
- These are exactly the facts the assessment emits as an **`UNKNOWN` verification backlog** in code-only mode. Declaring them in IaC turns each backlog item into a code-provable claim, and a live reconcile flips it to `verified`.

### 3.5 Secrets & function environment (Invariant I6)

- Secrets are stored in a secrets manager and **referenced** by the resource.
- **Never** inject a plaintext credential into a function's `environment` / `--environment` block — the assessment flags this as an infra-security finding.

### 3.6 PII → store mapping

- Any store that holds identity/session/user data is tagged `data-classification: pii` and named so its purpose is legible (the assessment infers PII from adapters like `@auth/*-adapter` plus store-name patterns; make it explicit rather than inferred).
- **Target:** every PII store is mapped, classified, and encryption/residency-declared.

### 3.7 Lifecycle & orphan hygiene

- Every resource has an explicit lifecycle: active, or **explicitly** deprecated/retiring (a written retirement note near its declaration).
- Do not leave a retired stack declared-but-unused. The assessment flags **orphan-candidates** (a data/backend service with a retire/legacy/deprecated signal, or declared-but-never-imported) — a clean app has **zero** unresolved orphan-candidates.

---

## 4. The roll-up rule (how the six dimensions become one score)

The overall level is **min-gated** — you cannot buy a high level in one dimension to cover a low one:

- **L1** — an IaC tool is present at all.
- **L2** — L1 **and** remote/managed state (§2.1 ≥ L2) **and** all-in-code coverage (§3.1: `resourceRatio ≥ 0.8`, ideally 1.0).
- **L3** — L2 **and** testing ≥ L2 **and** governance ≥ L2 **and** drift/cost ≥ L2.
- **L4** — L3 **and** env-separation ≥ L2 **and** modularity ≥ L3 **and** testing ≥ L3 **and** governance ≥ L3 **and** drift/cost ≥ L3.

**Consequence for Mycelium:** the fastest path _up_ is to fix the **lowest** dimension. The most common ceiling is L1→L2 blocked by **coverage** (an undeclared data plane) — which is why §3.1 is the first thing Mycelium enforces.

---

## 5. Progressive adoption — the lifecycle→level ladder Mycelium enforces

IaC maturity should **track the app's lifecycle stage**. The rule is not "be L4 immediately"; it is **"meet the bar for your stage, and never regress a dimension."** Mycelium raises the required level as an app advances and blocks promotion until the bar is met.

| Lifecycle stage                 | Required level    | The bar Mycelium enforces at this stage                                                                                                                                                                                                       |
| ------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0 · Spike / prototype**       | **L1 Repeatable** | An IaC tool is adopted from the first resource. **No console click-ops.** Every resource declared. State remote (even if single-env). `.gitignore` blocks state files.                                                                        |
| **1 · MVP / first real deploy** | **L2 Defined**    | Remote + locked + encrypted state. **Declared coverage = 1.0** (nothing used-but-undeclared). dev/prod separated with separate state. The 7-tag taxonomy present. Region pinned.                                                              |
| **2 · Production**              | **L3 Managed**    | Unit **and** integration IaC tests as required CI checks. Policy-as-code + misconfig scanning. Scheduled drift check + per-PR cost gate. Stateful stores hardened (§3.4). PII stores classified.                                              |
| **3 · Scale / platform**        | **L4 Optimizing** | Version-pinned module library. Multi-env incl. ephemeral previews. Full test pyramid. **Mandatory** policy gates. Verification backlog resolved via live reconcile (`basis: verified`). moduleReadiness: finops/privacy/policy all **ready**. |

**Non-regression rule:** once a dimension reaches a level, a change that would lower it **fails the gate**. Mycelium runs the Futurator Assess IaC scan in CI and treats a score drop as a failing check (see §6). This is what makes IaC excellence a ratchet, not a one-time cleanup.

**Birth-at-current-bar rule:** every _new_ resource Mycelium generates is born meeting the current stage's bar (tags, env, data-class, lifecycle, hardening) — retrofitting is never scheduled because it never accrues.

---

## 6. How Mycelium enforces this (command-center integration)

This standard is only worth what Mycelium mechanically enforces. Five hooks:

1. **IaC-first scaffolding.** Every new app is generated from an IaC-first template for the team's chosen tool: a remote state backend, an environment structure, provider-level default tags (the 7-tag taxonomy wired to variables), a `.gitignore` that blocks state files, and CI job stubs for drift / cost / scan / policy. The app is **L1 on its first commit** and cannot start below it.
2. **Generation guardrails.** The app/resource generator **refuses** to emit: a resource without name + full tags + environment + data-classification; a committed state file; a plaintext secret in a function env; a deprecated toolchain choice. These are hard stops, mirroring the assessment's findings so nothing can be created that would later score badly.
3. **Stage-promotion gates.** Advancing an app to the next lifecycle stage (§5) runs a **pre-promotion check that mirrors the assessment** and blocks until the higher level's bar is met. The lever surfaced to the team is always "fix the lowest dimension" (§4).
4. **Continuous alignment (the assessment IS the contract).** Mycelium runs the Futurator Assess IaC scan in CI on every app. The scan's `iacMaturity.level`, `iacCoverage.resourceRatio`, `moduleReadiness`, and `verificationBacklog` are treated as build signals: a level drop, a coverage regression, or a new orphan-candidate **fails the check**. Because this standard and the engine share one rubric, "pass the standard" and "score highest on the assessment" are the same event.
5. **The golden rule, always.** Every mutating step carries the invariant: `plan`/`preview` must show **zero changes** before any commit or deploy. This is the infra analogue of a characterization-test gate and is how I2 (no drift) is upheld operationally.

---

## 7. The scoring contract — the L4 checklist (machine-actionable)

An app that can tick every box below scores **Level 4** on the Futurator assessment, for any cloud and any tool. Mycelium uses this as the generation target and the CI gate.

**Foundation**

- [ ] A **maintained** IaC tool is adopted (not on the deprecated list, §8).
- [ ] State is **remote + locked + encrypted**; **no** state file committed.
- [ ] **Declared coverage = 100%** — zero `used-but-undeclared` resources; no IAM-ARN-only or shell-script-only resources.
- [ ] Every resource **enumerated** with declared existence (referenced-only ⇒ marked `unknown`, then adopted).

**Structure**

- [ ] dev / staging / prod **separated** with isolated state.
- [ ] Infra composed from **version-pinned** modules/components.

**Assurance**

- [ ] **Unit + integration** IaC tests as required CI checks.
- [ ] **Policy-as-code** (mandatory at L4) **plus** static misconfig scanning.
- [ ] **Scheduled drift check** + **per-PR cost gate** (both evidenced by CI/config artifacts, not prose).

**Resource contract**

- [ ] **7-tag taxonomy** on every resource (team, environment, service, cost-center, owner, managed-by, data-classification).
- [ ] **Single pinned region** per env (or explicit multi-region policy).
- [ ] Stateful stores: **PITR + deletion-protection + versioning + encryption (CMK where required)** declared.
- [ ] **No secrets** in any function environment; secrets referenced from a manager.
- [ ] **PII stores** classified `data-classification: pii` and encryption/residency-declared.
- [ ] **Zero** unresolved orphan-candidates (lifecycle explicit).

**Downstream unlock**

- [ ] `moduleReadiness`: **finops, privacy, policy-as-code all ready** (no blockers).
- [ ] `verificationBacklog` resolved via live reconcile ⇒ every maturity dimension `basis: verified`.

---

## 8. Anti-patterns (score killers) — and what the assessment catches

| Anti-pattern                                                                                              | What it breaks | How the assessment sees it                                  |
| --------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------- |
| Console / click-ops resources                                                                             | I1 coverage    | `iacCoverage.resourceRatio < 1`, resource `declared: false` |
| An IAM grant to a hand-made table read as "managed"                                                       | I1, I3         | classified `used-but-undeclared`, not declared              |
| Committed `terraform.tfstate` / `.pulumi` state                                                           | I2, security   | HIGH security finding + state pinned to L1                  |
| `deploy.sh` shelling out to the cloud CLI                                                                 | I1             | recorded as a hand-rolled deploy (non-IaC), lowers coverage |
| App-domain `tags: {}` objects mistaken for cost tags                                                      | §3.2           | scoped out — only IaC-file tags count                       |
| Plaintext secret in `--environment`                                                                       | I6             | infra-security finding                                      |
| Deprecated toolchain (CDKTF, GCP Deployment Manager, tfsec, Terrascan, Terraformer-as-pipeline, driftctl) | I7             | deprecation catalog flags + downgrades                      |
| Retired stack left declared-but-unused                                                                    | §3.7           | orphan-candidate finding                                    |
| "Infra is fine" asserted without live verification                                                        | I4             | facts emitted as `UNKNOWN` verification backlog, not scored |

---

## 9. Provider mapping appendix (tool-neutral requirement → concrete satisfaction)

The requirements above are properties; here is how each mainstream tool satisfies them. Mycelium selects the column for the team's chosen tool — **the target score is identical across columns.**

| Property                                     | Terraform / OpenTofu                                         | Pulumi                                         | AWS CDK                             | SST                                    | CloudFormation / SAM                  | Bicep / GCP Infra Manager                  |
| -------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------- | -------------------------------------- | ------------------------------------- | ------------------------------------------ |
| **Remote+locked state** (2.1)                | `backend "s3"` + lock table / `use_lockfile`; GCS; azurerm   | Pulumi Cloud or object-store backend           | CloudFormation-managed              | platform-managed                       | CloudFormation-managed                | Azure/GCS-managed                          |
| **Declared coverage / adopt existing** (3.1) | `import {}` blocks → `plan -generate-config-out`             | `pulumi import`                                | `cdk import` / `cdk migrate`        | `import` option / `transform`          | resource import                       | Infra Manager import / bulk-export         |
| **Env separation** (2.2)                     | workspaces or `environments/{dev,stg,prod}` + per-env tfvars | per-env **stacks**                             | Stage constructs / context          | `--stage` isolation                    | per-env stacks/params                 | per-env projects/params                    |
| **Modularity, pinned** (2.3)                 | `modules/` with `version=`/`?ref=`                           | `ComponentResource` + versioned package        | L3 Constructs / constructs library  | `infra/*.ts` modules                   | nested stacks / macros                | modules / CFT modules                      |
| **Unit + integration tests** (2.4)           | `*.tftest.hcl` + Terratest                                   | `runtime.setMocks` + integration harness       | `aws-cdk-lib/assertions` + snapshot | vitest on infra modules + `sst diff`   | `cfn-lint` + TaskCat                  | `bicep test` / `terraform test`            |
| **Policy-as-code + scanning** (2.5)          | Checkov/Trivy + OPA/Conftest/Sentinel                        | CrossGuard + Checkov                           | Checkov on `cdk.out` + org policy   | CrossGuard (SST v3 = Pulumi) + Checkov | Checkov + Guard/`cfn-guard`           | Policy Controller / `gcloud terraform vet` |
| **Scheduled drift + cost gate** (2.6)        | scheduled `plan` in CI + Infracost PR diff                   | `preview --expect-no-changes` cron + Infracost | scheduled `cdk diff` + Infracost    | scheduled `sst diff` + cost estimate   | scheduled drift detection + Infracost | Infra Manager preview + Infracost          |
| **Tag taxonomy** (3.2)                       | `default_tags` on the provider                               | provider default tags / a tagging component    | `Tags.of(scope).add(...)`           | provider transform                     | stack-level tags                      | resource tags module                       |
| **Secrets referenced** (3.5)                 | secrets-manager data source                                  | config secrets / secret refs                   | Secrets Manager reference           | `sst.Secret` / linked secret           | dynamic references                    | Key Vault / Secret Manager reference       |

> **Deprecated → migrate:** CDKTF → Terraform/OpenTofu or Pulumi · GCP Deployment Manager → Infrastructure Manager · tfsec → `trivy config` · Terrascan → Checkov/Trivy · driftctl → scheduled `plan --expect-no-changes`. Terraformer is a **one-shot** export only, never a pipeline step.

---

## 10. Summary — the alignment guarantee

Because this standard is **derived from the same rubric the Futurator Assess engine grades**, the following three statements are equivalent for any app Mycelium builds:

1. "The app follows the Optimal IaC Standard."
2. "The app scores **Level 4 (Optimizing)** on the Futurator IaC assessment."
3. "FinOps, privacy, and policy-as-code modules are **unlocked** (`moduleReadiness` all ready), with a clean verification backlog."

Mycelium enforces (1) at generation and promotion time; Futurator verifies (2) continuously; and (3) is the downstream payoff — **all from one shared, provider-agnostic, progressively-adopted standard.**
