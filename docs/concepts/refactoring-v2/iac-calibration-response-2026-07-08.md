# IaC Engine Calibration Response — Verified Defect Report & Enhancement Plan

**Date:** 2026-07-08
**Agent:** Claude Fable 5 (analysis-only round — no engine code modified)
**Scope:** Futurator-Admin Refactoring Scan Engine v2, Infrastructure/IaC module
**Inputs audited:** `futurator-assess-iac-calibration-2026-07-08.md` (external reviewer, backed by a live read-only AWS scan), the three Mycelium IaC analyses (enterprise / codebase-only / strategy), `scan-v2-mycelium-2026-07-07.json`, and the engine source on `feat/pipeline-v3`.
**Method:** every reviewer claim reproduced executable-level — local runs of `infra-extract.mjs` on the exact scanned tree (`scannedSha a779dfdc`), a git-worktree A/B contamination experiment at `fc0a691`, planner runs on corrected inventories, and a live SSM inspection of the EC2 clone (`/home/ubuntu/projects/mycelium`).

**Verdict in one line:** all three reviewer defects are real, but two of the three claimed _mechanisms_ are wrong — and the true mechanisms (scan self-contamination; a structurally unreachable import step) are worse, because they generalize across the entire app portfolio and compound on every re-scan.

---

## 0. Context that reframes the audit

- `scan.json.scannedSha = a779dfdc` — the operator had merged `feat/intent-intake-funnel` → `main` before the scan; the 2026-07-07T20:29Z party refresh pulled it. The scan **did** see the newest code.
- The Mycelium party record is HEALTHY again (PAT rotation saga closed); `lastCommitSha = a779dfdc`.
- The engine's provenance on the scanned tree is partially good (`scannedSha` recorded) — but it does **not** record untracked/dirty state, which is precisely why the contamination class (D2) stayed invisible.

---

## A. Defect report — verified root causes, corrected mechanisms

### D1 — DynamoDB `iac-declared` · CONFIRMED, mechanism corrected

**Reviewer's theory:** the engine read the ARN inside the IAM grant as an IaC declaration.
**Verified reality:** the ARN never matches anything. The trigger is
`daemon/scripts/refactor-recon/infra-extract.mjs:232` — the `SST_RES` pattern
`/\bsst\.aws\.(Dynamo|Table)\b/` run by `extractIacResources()` (`:262`) over **raw file
content including comments**. Mycelium's `sst.config.ts:81` contains a comment saying the
tables are _"not declared as `sst.aws.Dynamo` to avoid name-conflict on deploy"_ — the
engine credits "declared" from the comment that explicitly states **not declared**.

**Reproduction:**

- Engine run on the scanned tree (`a779dfdc`) → `detectedBy: ["sdk-import","iac-declared"]`,
  `iacCoverage 2/3`, byte-identical to the deployed scan.
- Engine run on `fc0a691` (comment absent) → correct `["sdk-import"]`, coverage **1/3**,
  `undeclared: [DynamoDB, S3]`.

**Fix:**

1. Strip line/block comments before construct extraction.
2. Require **constructor invocation** syntax (`new sst.aws.Dynamo(`,
   `new aws.dynamodb.Table(`, TF `resource "aws_dynamodb_table"` blocks), never bare tokens.
3. Add an **IAM-grant parser**: ARNs inside permission/policy blocks
   (`arn:…:table/Mycelium_*`) become `used-but-undeclared` references with resource-name
   evidence — today policy ARNs are entirely invisible to the inventory.

**Expected delta on Mycelium re-scan:** coverage 2/3 → true (low) resource-level ratio;
DynamoDB lands in `undeclared`; the plan input inverts correctly (see D4).

### D2 — "Infracost cost gate" · CONFIRMED, mechanism is NOT seal.ts — it is **self-contamination**

**Reviewer's theory:** keyword match on `src/lib/seal.ts` (the SEAL product feature).
**Verified reality:** `seal.ts` never enters the grader — it fails the content-inclusion
regex (`infra-extract.mjs:940`), and at `fc0a691` `git grep -i infracost` finds **nothing**
tracked in the whole tree. The real cause:

1. The daemon writes scan artifacts **into the scanned clone**
   (`agent-daemon.mjs:8326` → `<repo>/graphify-out/infra.json`, plus `graph.json`,
   `graph.resolved.json`, `privacy.json`, …).
2. `walk()`'s IGNORE set (`infra-extract.mjs:887`) does not exclude `graphify-out`.
3. Ambiguous `.json` files are content-included (`:927`, `:944`) and concatenated into
   `allContent`, which the driftCost detector keyword-scans (`:827-828`).
4. The **previous scan's own gap text** ("Add an Infracost cost gate in CI.",
   "Add a scheduled plan/preview --expect-no-changes drift check.") is re-read as evidence
   on the next scan.

**Proof (two independent):**

- **Live:** the EC2 clone's `graphify-out/{graph,graph.resolved,infra}.json` all contain
  "infracost" (SSM inspection, 2026-07-08).
- **Mechanistic A/B:** clean `fc0a691` worktree grades driftCost **L0**; dropping a single
  prior `infra.json` into `graphify-out/` flips it to **L2**.

**Why this is the nastiest bug in the engine:** the _first_ scan of any app is clean; every
**re-scan self-inflates**. driftCost, drift-check, tag taxonomy, regions, and
env-separation signals can all leak from artifacts. Scores ratchet upward with scan count,
portfolio-wide. (`graph.json` embeds source text, so seal.ts's "infracost" _does_ flow into
`allContent` — one hop removed from the reviewer's theory.)

**Fix (layered):**

1. Add `graphify-out` (and every engine output dir) to the exclude set of **all** detectors.
2. Move artifact output **outside the repo tree** (job workdir) — check consumers first:
   `agent-daemon.mjs:8518` reads `graph-ui.json` from projectPath.
3. Evidence-artifact rule: tool detections (Infracost/Checkov/drift) accept only named
   config/CI artifacts (`infracost.yml`, a workflow step invoking the tool), never an
   `allContent` keyword match. Scope tool-keyword detection out of `src/**` regardless.

**Expected delta:** driftCost L2 → honest L0; the scan becomes **idempotent**
(scan-of-scan == scan) — which is also the regression test.

### D3 — No declared-vs-verified register · CONFIRMED (structural)

`gradeIacMaturity` evidence strings ("SST platform-managed state.") and
`maturity-score.mjs:236-248` readiness items (`present: true`, "Remote/managed state") are
asserted as fact. No `basis` field, no verification backlog. The reviewer's live scan proved
the danger: graph-sync broken with 285 dead-lettered messages, zero PITR/deletion-protection
across all 11 tables — all invisible to a code scan, none flagged as unverified.

**Fix:** extend the provenance the engine already has on _detections_
(`detectedBy`/`confidence`) up to every _conclusion_:

- `basis: 'declared' | 'verified'` on each maturity dimension score and readiness item
  (code-only mode ⇒ all `declared`).
- Every declared-only claim emits a `verificationBacklog[]` item carrying the exact verify
  command (`aws dynamodb describe-continuous-backups`, `describe-table`, `list-tables`,
  bucket-versioning reads, DLQ depth…).
- Cloud-blind facts (PITR, deletion-protection, versioning, CMK, runtime health, applied
  tags, shared-account context) are emitted **only** as UNKNOWN backlog items — never as
  new code-scored dimensions (asserting the unmeasurable is exactly the D3 failure).
- Report copy: "✓" → "declared (unverified)" wherever basis is `declared`.

### D4 — Priority inversion is _doubly_ caused (the reviewer found only half)

Even with D1 fixed, the plan still never proposes adoption.
`daemon/pipelines/lib/iac-phase-planner.mjs:298-321`: the phase-2 _"Remote state & resource
import"_ step — **the only step that carries `imports`** — is skipped when
`satisfied('state')`, and SST/CDK repos always grade state L2 with no gaps.

**Proof:** feeding the planner the _corrected_ inventory (true 1/3 coverage,
DynamoDB + S3 undeclared) still yields `env → modularity → testing → drift → governance` —
no import step, `has import step: false`. State-_backend quality_ and adoption-_coverage_
are orthogonal properties; the planner conflates them.

**Fix:** make **"Adopt unmanaged resources into IaC"** a first-class track step gated on
`iacCoverage` (undeclared non-empty), independent of the state dimension; rank data-store
resources first (the fanIn × churn priority in `buildImports` already exists and is good).

**Expected delta:** `nextThree[0]` = adopt the DynamoDB data plane + snapshots bucket —
exactly the live-scan-grounded #1 action (enterprise plan Wave A/C).

### Punch-list §5 verified against engine source

| #   | Item                       | Status in engine                                                                                                                     | Root                        |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | --------------------------- |
| A2  | Resource-level enumeration | ❌ services merged by **name** → 11 tables collapse to 1 entry                                                                       | `infra-extract.mjs:400-402` |
| A4  | Orphan/retire triage       | ❌ no retirement-signal detector exists                                                                                              | —                           |
| A5  | Secret-into-Lambda-env     | ❌ `detectDeployScript` records `provisions` only                                                                                    | `:368-384`                  |
| A6  | PII→specific-store mapping | ❌ 0 PII findings in the scan; privacy module never names stores                                                                     | —                           |
| A7  | Tag taxonomy               | ⚠️ required set lacks `owner`/`managed-by`/`data-classification`; reports absolute "0%" despite SST's implicit `sst:app`/`sst:stage` | `:834`                      |

Ground-truth anchor for A2 (from the live-scan digest): 11 live `Mycelium_*` tables;
code additionally references `Mycelium_Agents` which does **not** exist live — proof that
resource enumeration must mark existence `UNKNOWN` for referenced-only resources, never
assert it.

---

## B. Beyond the review — defects the reviewer did NOT find

1. **Self-contamination** (D2's true form) — a _class_ bug. The security/privacy/tests/
   sdd/stack/ai-readiness detectors each walk the repo; every one must be audited for the
   same artifact-ingestion hole in one sweep.
2. **Import step structurally unreachable** (D4) — affects every platform-managed-state app
   (SST/CDK) in the portfolio, independent of any detection bug.
3. **Comment/string blindness class** — all construct regexes (SST/CDK/Pulumi) match
   comments and string literals. `/\bnew\s+Table\b/` matches any app's `new Table(` UI
   class inside a content-included file → phantom DynamoDB on unrelated apps.
4. **CFN/SAM/Serverless are resource-blind** — `parseConfig` (`:297`, `:306`) records only
   the _tool_; a pure CloudFormation app gets **zero resource enumeration**. Largest
   non-SST generality gap; A2's fix must parse `Resources:` blocks (CFN/SAM) and
   `resources:` (serverless.yml) too.
5. **Region detection is AWS-only** — `/[a-z]{2}-[a-z]+-\d/` (`:843`) never matches
   `us-central1` (GCP) or `eastus2` (Azure) → `regionPinned` wrong for non-AWS apps.
6. **Tag extraction over-broad** — `\btags\s*[:=]\s*\{` over `allContent` matches
   app-domain `tags:` objects (e.g. blog post tags) → false cost-taxonomy credit. Scope to
   IaC files only.
7. **driftCheck accepts prose** — "expect-no-changes" + "schedule:"/"cron" anywhere in
   `allContent` (`:828`); must require a CI-workflow artifact context.
8. **512 KB content cap silently skips files** (`:936`) — an oversized `sst.config.ts` is
   silently ungraded; surface as a `lowConfidence` note in the report.
9. **`platform-config` counts as declared** in `iacCoverage` (`:488`) — a CI workflow using
   `aws-actions` should not equal a resource declaration; demote to a separate
   "automated" evidence tier.
10. **No dirty/untracked provenance** — record the clone's `git status --porcelain` count
    (+ untracked list digest) alongside `scannedSha`, so contamination-class issues are
    visible in the report itself.
11. **No downstream gating** — nothing computes FinOps-/privacy-/policy-readiness. Add
    `moduleReadiness { finops, privacy, policyAsCode }`, each with `blockedBy[]` tied to
    concrete backlog items (resource-level tags → FinOps; PII→store + encryption/residency
    → privacy; true declared/undeclared set + policy pack → policy-as-code).
12. **Live-reconcile adapter — recommend YES, opt-in, design-gated** — a read-only adapter
    (service `list-*`/`describe-*` enumeration; **never** the Resource Groups Tagging API,
    which the live scan proved misses never-tagged resources) that consumes the D3
    verification backlog and flips `basis` declared→verified per fact. Code-only honesty
    preserved by default; cloud-granted orgs get truth. ~30 API calls, $0 LLM.

### What to preserve (do not regress)

- Code-quality & security modules (real bugs: dropped BatchWrite `UnprocessedItems`,
  unchecked `res.ok`, pagination truncation, unauthenticated health endpoints) — keep as-is.
- The six-dimension maturity skeleton — sound; the problem is its **inputs**.
- Provenance primitives (`detectedBy`/`confidence`/`costModel`) and the cost-surface
  classification — D3 _extends_ these upward, never replaces them.
- `buildImports` fanIn × churn priority ordering — correct; it just never fires (D4).
- Report-only posture + scan-cost transparency.

---

## C. Prioritized enhancement plan (approval requested before implementation)

| P      | Change                                                                                                                                                                                                                                             | Risk                                                                        | Rationale for order                                                                 |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **P0** | Kill self-contamination: exclude `graphify-out` in **all** detectors + move artifact output out of the repo tree (coordinate `graph-ui.json` consumers, `agent-daemon.mjs:8518`)                                                                   | Low                                                                         | One bug poisons every re-scan portfolio-wide; also makes every later fix measurable |
| **P1** | Truth-of-declaration: comment-strip + constructor-invocation regexes + IAM-ARN → `used-but-undeclared` parser                                                                                                                                      | Med (regex; guard with fixture corpus + extending the 88-test daemon suite) | Root of the coverage inflation                                                      |
| **P2** | Resource-level model: `resources[]` per service (TableName literals, `${prefix}_X` name-builders, `create-*` scripts, ARN wildcards, TF/CFN/SAM/Serverless resource blocks), each `declared \| referenced-only`, existence UNKNOWN unless declared | Med                                                                         | Fixes the 11-tables collapse and the CFN blindness; unlocks FinOps/privacy/policy   |
| **P3** | Plan re-inversion: adoption step gated on coverage (not state), data-plane-first ranking, `unlocks:` annotation per track step                                                                                                                     | Low                                                                         | Makes the plan point at the right ⅔                                                 |
| **P4** | Epistemics: `basis` field + `verificationBacklog[]` + UNKNOWN emission for cloud-blind facts; readiness items carry basis; report copy "✓" → "declared (unverified)"                                                                               | Low                                                                         | The "trustfully" fix                                                                |
| **P5** | Precision pack: orphan triage (A4), secret-into-env (A5), PII→store via `@auth/dynamodb-adapter` (A6), tag set + platform-implicit tags (A7), region generality, tag scoping, driftCheck artifact rule, size-cap note, provenance of dirty state   | Low                                                                         | Incremental on top of P1/P2                                                         |
| **P6** | Design-only: live-reconcile adapter + `moduleReadiness` gates                                                                                                                                                                                      | —                                                                           | Approve separately                                                                  |

**Deploy note:** P0–P5 are daemon-side → require `rsync-daemon.sh` (restarts the daemon and
kills running jobs; the pending `bad9bbe`/`e928ed9` daemon deploy is held for the same idle
window). Report-UI copy changes deploy via `sst deploy`. Never sync `out/` to
`futurator-ai-website`.

---

## D. Acceptance criteria for the re-scan (testable assertions)

1. **Idempotence:** scanning the same tree twice — with prior artifacts present — yields an
   identical `iacMaturity` block. This is the contamination regression test.
2. DynamoDB carries no `iac-declared`; ≥12 resources enumerated individually
   (11 live `Mycelium_*` tables + `mycelium-snapshots`; `Mycelium_Agents` listed as
   _referenced-only, existence UNKNOWN_); `iacCoverage` reflects the true low ratio.
3. `iacPlan.nextThree[0]` = adopt the unmanaged data plane into IaC (tables + bucket,
   per-resource priority), and every track step states which downstream module it unlocks.
4. graph-sync stack flagged **orphan-candidate** with the code evidence (SCOPE-BOUNDARY /
   retire signals) — asserted as _candidate_ with `basis: declared`, never as "dead".
5. Every maturity dimension and readiness item carries `basis`; in code-only mode the
   `verified` count is 0 and `verificationBacklog` is non-empty, including
   PITR / deletion-protection / bucket-versioning / runtime-health items with their verify
   commands.
6. Zero tool detections without a config/CI artifact (no "Infracost cost gate" without an
   Infracost artifact).
7. `Mycelium_Auth` + `Mycelium_Directory` flagged `contains_pii` by store name (via the
   `@auth/dynamodb-adapter` signal), not merely two health endpoints.
8. Generality fixtures: a CloudFormation app yields resource-level enumeration; a GCP app
   region-pins on `us-central1`; an app with a `new Table(` UI class does **not** grow a
   phantom DynamoDB; the existing 88 daemon tests stay green.
9. Tag report reads "0% **in declared IaC**" and lists `sst:app`/`sst:stage` as
   platform-implicit (basis: declared).

---

_Analysis performed and authored by Claude Fable 5 (Claude Code) on 2026-07-08.
No engine code was modified in this round; implementation awaits operator approval of P0–P5
(and a separate decision on P6)._
