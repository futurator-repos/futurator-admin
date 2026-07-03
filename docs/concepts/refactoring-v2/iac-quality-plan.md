# IaC Quality — Enhancement Plan for the Infrastructure Module

> **Source:** `~/Downloads/iac-migration.md` (migration playbook + tool catalogue + maturity rubric,
> mid-2026) checked against the deployed scan engine. **Status: plan** — nothing built yet.
>
> **Thesis:** today the Infrastructure module measures **presence + coverage** (is infra declared in
> code; which resources are click-ops). That is exactly the doc's Level-0/1 boundary. The doc's A.2
> rubric shows IaC _quality_ is five independent dimensions — state, env separation, modularity,
> testing, governance, drift/cost — and almost all of them are **statically detectable from files**.
> This plan upgrades the module from "is there IaC?" to "how mature is the IaC, and what is the
> stack-aware path to the next level" — the phased-suggestions payoff.

---

## 0. Gap audit (codebase vs doc, verified 2026-07-02)

| Doc dimension (A.2)      | In `infra-extract.mjs` today                                                             | Gap                          |
| ------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------- |
| Presence / click-ops     | ✅ iacCoverage, deployScripts, iac tiers, cost surface, graph pass-2 (fanIn/centralized) | —                            |
| **State & provisioning** | ❌ nothing — no backend detection, no committed-tfstate check                            | Level 1↔2 boundary invisible |
| **Env separation**       | ❌ no Pulumi stack files, env dirs, workspaces, sst stages                               | invisible                    |
| **Modularity**           | ❌ no `module ""` blocks, no ComponentResource, no monolith metric                       | invisible                    |
| **Testing**              | ❌ no `*.tftest.hcl`, Terratest, Pulumi unit tests                                       | invisible                    |
| **Governance / policy**  | ❌ no CrossGuard/OPA/Conftest/Checkov/Sentinel configs                                   | invisible                    |
| **Drift & cost gates**   | ❌ no scheduled plan/preview detection, no Infracost-in-CI                               | invisible                    |
| **Tag taxonomy**         | ❌ no default_tags / 4-tag coverage                                                      | invisible (FinOps tie)       |
| **Region / residency**   | ❌ no region extraction → no GDPR pin check                                              | invisible (compliance tie)   |
| **Deprecated toolchain** | ❌ worse: `cdktf` is scored a POSITIVE 'resource'-tier signal                            | doc: archived Dec 10 2025    |
| Phase suggestions        | phase-planner has ~zero IaC awareness (1 grep hit)                                       | migration playbook unused    |

---

## Part A — `iac-maturity` grading (deterministic, ~$0, extends infra-extract)

New checks, all file/content-based, following the existing detector pattern. Output = an
`iacMaturity` object on the inventory:

```
iacMaturity: {
  level: 0-4, levelName: 'ClickOps'|'Repeatable'|'Defined'|'Managed'|'Optimizing',
  dimensions: {
    state:        { level, evidence, gaps[] },   // per-dimension grade (doc: grade independently)
    envSeparation:{ ... }, modularity: { ... }, testing: { ... },
    governance:   { ... }, driftCost:  { ... },
  },
  deprecated: [{tool, status, eolDate, remediation}],
  regions: string[], regionPinned: boolean,
  tagTaxonomy: { present: string[], missing: string[], coveragePct },
  findings: ScanFinding[],
}
```

### A.1 Dimension graders

1. **State & provisioning**
   - TF/OpenTofu: `backend "s3|gcs|azurerm|remote|http"` in `*.tf` → remote; `backend "local"`/none → local.
     Lock signal: DynamoDB table / `use_lockfile`.
   - Pulumi: `Pulumi.yaml` `backend: url:` (s3://, gs://) or Pulumi-Cloud default → managed.
   - SST: state managed by the platform → auto-pass.
   - **`terraform.tfstate`/`.pulumi/` state committed in the repo → HIGH finding** (secrets + corruption;
     also feeds security module).
2. **Env separation** — `Pulumi.{dev,staging,prod}.yaml` stacks · `environments/{dev,…}/` dirs ·
   per-env `*.tfvars` · `terraform workspace` in CI · sst `--stage` usage. One-env-only → gap.
3. **Modularity** — TF `module ""` blocks + `modules/` dir + pinned sources (`?ref=`/`version =`) vs
   root-monolith (resource count in root files); Pulumi `ComponentResource` classes / shared infra
   package. Terraformer-generated `tfer--` names → "unrefactored generated code" smell (doc A.3).
4. **Testing** — `*.tftest.hcl` (native), Terratest (Go importing terratest), Pulumi unit tests
   (test files importing @pulumi with mocks).
5. **Governance** — CrossGuard (`PulumiPolicy.yaml`/policy-pack dirs), OPA/Conftest (`*.rego`),
   `.checkov.ya?ml`, Trivy config, Sentinel files.
6. **Drift & cost** — CI workflows (we already read them) containing **cron + `plan`/`preview
--expect-no-changes`** → drift check present (the doc's "infra analogue of spec-drift" — cross-link
   the Git module's framing). Infracost in CI / `infracost.yml` → cost gate. Tag taxonomy: parse
   `default_tags` (TF), shared-tags modules, Pulumi tag args → coverage of
   `team/environment/service/cost-center` (+`data-classification` when compliance findings exist).
7. **Region/residency** — regions from provider blocks + Pulumi/sst config → `regions[]`;
   `regionPinned` when policy or single region; GDPR flag when compliance module active and region
   outside EU. Feeds the Compliance tab too.

**Roll-up:** level = min-gated like the doc (e.g. can't be L2 without remote state + all-infra-in-code;
can't be L3 without tests + policy + cost tags), reported per-dimension so "you're L3 on modularity,
L0 on drift" is visible — the doc explicitly says uneven grades are the point.

### A.2 Deprecated-toolchain catalog (pure catalog update, high value)

| Detect                                       | Status (doc-verified)                     | Action                                                               |
| -------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| `cdktf.json` / cdktf imports                 | **archived Dec 10 2025**                  | flip from positive→WARNING finding: migrate to TF/OpenTofu or Pulumi |
| `.tfsec/` config                             | merged into Trivy (2023)                  | Low finding → `trivy config`                                         |
| Terrascan config                             | archived Nov 20 2025                      | Low finding                                                          |
| `tfer--` resource names                      | Terraformer output (archived Mar 16 2026) | refactor smell                                                       |
| GCP Deployment Manager (`*.jinja` + DM yaml) | **EOL Mar 31 2026**                       | HIGH/urgent: DM Convert                                              |
| driftctl config                              | maintenance since 2023                    | Low finding                                                          |

---

## Part B — Stack-aware migration phases (the "amazing suggestions")

New pure lib (`iac-phase-planner` or extension of phase-planner) mapping **rubric gaps → the doc's
A.1 Phase 0–8 playbook**, emitted as a dedicated **Infrastructure track** in the scan output
(`iacPlan`), separate from the code-refactor phases:

- **Gap-driven:** only emit steps for missing dimensions (remote state exists → skip that step).
- **Stack-aware tooling** (from the Stack Profile we already compute):
  - Pulumi repo → `pulumi import --file` bulk · CrossGuard pack (tags + region pin + no public
    buckets, advisory→mandatory) · Pulumi unit tests · scheduled `pulumi preview --expect-no-changes`.
  - TF/OpenTofu → `import {}` blocks + `-generate-config-out` · `tftest.hcl` · Checkov/Trivy ·
    scheduled plan. Never recommend Terraformer as a pipeline (one-shot only).
  - CDK → `cdk migrate` / `cdk import` / `CfnInclude`; warn on `RemovalPolicy` defaults.
  - GCP → Infrastructure Manager + Cloud Foundation Fabric; DM present → urgent DM Convert step.
- **Import list seeded from what we already detect:** `iacCoverage.undeclared` = the Phase-1
  inventory; each `deployScripts` entry becomes a Phase-2 import target ("graph-sync Lambda is
  provisioned by deploy.sh → import into SST/Pulumi"). **Priority = graph fan-in × git churn**
  (both already computed): stateful + high-fan-in + hot files import first — the session's whole
  toolchain converging on ordering.
- Every mutating step carries the doc's golden rule: _plan/preview must show zero changes before
  commit_ (the IaC analogue of our characterization-test gate — same discipline, note it in the step).
- Surfaces: Infra tab panel + the MD report (new "Infrastructure track" section) + Create-plan
  intent (buildScanPlanIntent gains the IaC track when Infra items are selected).
- Main phase-planner: IaC findings get `evidence.iac` → band to foundations (module-aware banding
  already supports this pattern).

## Part C — Infrastructure tab overhaul (UI)

Reorder to: **Signal → Maturity card → Migration path → coverage/deploy-scripts → cost surface →
clouds/services → IaC files.** New pieces:

1. **IaC Maturity card** — Level badge (`L1 — Repeatable`) + the 5-dimension rubric as a mini-grid
   (dimension → level dots + one-line evidence + top gap). Include the doc's diagnostic question as
   the card's tooltip ("when did prod last change from a laptop without a PR?").
2. **Migration path panel** — "Level 1 → Level 2: next 3 actions" with concrete, stack-aware
   commands (from Part B), plus the full track collapsible.
3. **Deprecated toolchain** — red chips w/ EOL dates.
4. **State & env strip** — backend (remote/local/**committed state!**), env stacks found, regions +
   GDPR pin status.
5. **Tag taxonomy** — 4-tag coverage bar.

- **Overview dashboard:** `infra-declared` axis evolves to blend rubric level with coverage
  (score ≈ level/4 ⊕ coverage); Readiness gains binary `remote-state` + `env-separation` items
  (respecting the binary-vs-quality split).

## Part D — Scanner/skill-backed depth (opt-in tier, later)

Ties to the skill-backed-detector assessment (2026-07-02):

- **Checkov** (doc's default; Apache-2.0, active) as a best-effort CLI detector — the
  `eslint-detect` pattern: run if npx/pipx-able, CRITICAL/HIGH only, non-fatal → misconfig findings
  with real policy IDs (CIS/SOC2 mappings). Trivy as alternative (higher FP — start CRITICAL/HIGH).
- **Infracost** CLI/skill on TF repos → upgrade the cost-surface from _model_ to _numbers_
  (doc: 1,100+ resources, 10M SKUs). PR-gate recommendation goes in the migration track regardless.
- Swarm infra pass may later use a vetted IaC-audit skill — behind the Gate-1 skill-scan, pinned.

## Sequencing

| Phase | Contents                                                                   | Ship            | Validate          |
| ----- | -------------------------------------------------------------------------- | --------------- | ----------------- |
| **A** | maturity graders + deprecated catalog + findings (`infra-extract` + tests) | daemon rsync    | Quick re-scan, $0 |
| **B** | migration-track planner + MD/plan/intent wiring (runner + libs)            | with A          | same              |
| **C** | Infra tab overhaul + Overview axis/readiness (types + scan-report)         | sst             | immediate         |
| **D** | Checkov/Infracost opt-in                                                   | separate, gated | opt-in scan       |

A+B+C is one ultracode batch (file-partitioned: infra-extract / iac-phase-planner / runner /
maturity / types / scan-report — the established pattern). **Test targets:** Mycelium (SST minimal +
deploy.sh click-ops → expect L0–L1 with Pulumi/SST-aware import suggestions naming the graph-sync
Lambda), Futurator-Admin (SST-heavy, no IaC tests/policy → expect L1–L2 with testing/governance
gaps), applicator.

## Non-goals (v1)

Live cloud probing (stays file-first) · running terraform/pulumi CLIs on the clone (plan/preview
needs creds — never) · actual drift computation (we detect the _presence_ of drift checks, not drift).
