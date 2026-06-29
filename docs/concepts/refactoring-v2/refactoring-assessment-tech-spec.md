# Refactoring & Assessment — Consolidated Technical Specification

> **Status:** as-built reference, current to the latest `feat/pipeline-v3` deploy.
> **Audience:** engineers / agents working on code-quality, refactoring, compliance, or infra
> concepts. This is the **authoritative end-to-end reference** for the whole capability — both the
> v1 deterministic foundation and the v2 hybrid scan engine. Companion docs (linked, narrower):
> `scan-engine-design.md` (v2 design rationale), `docs/prd-refactoring-module.md` +
> `docs/epics-refactoring-module.md` (v1 PRD/epics).
>
> **Invariants that hold everywhere below:** report-only (the pipeline **never edits code**);
> deterministic-first (structural + compliance work spends ~0 LLM); the cloned source **never leaves
> the EC2 box**; every LLM claim is anchored to a real file path or dropped.

---

## 1. What the capability does

Upload any brownfield repo (GitHub clone) → get (a) a **structural + semantic + compliance
assessment** across five dimensions, (b) an **infrastructure map**, (c) a **maturity scorecard**, and
(d) a **phased, dependency-ordered refactoring plan** that hands off to the dev pipeline. Two
generations, layered:

- **v1 — deterministic recon + L3 adjudication** (the foundation, now consumed BY v2): cheap (~0 LLM,
  <3 min) structural truth — graph, fan-in, dead code, god-objects, duplicate subsystems — plus an
  optional LLM adjudication. Its `recon.mjs` chain + the privacy/graph/dual-agent pieces are reused
  wholesale by v2; **the standalone v1 "Refactoring Assessment" UI has been retired** (route + job
  kind kept but unexposed). The Assess tab is now v2-only.
- **v2 — hybrid scan engine** (the current headline): v1 recon builds the skeleton and **seeds an
  LLM swarm** (per-subsystem + cross-cutting passes) that catches the semantic findings recon is
  blind to; an aggregator produces Executive themes + a Severity×Effort matrix + the phased plan;
  plus the **Infrastructure** inventory and **Maturity** scorecard modules.

---

## 2. System architecture

```
INGEST   git clone → EC2 clone under /home/ubuntu/projects/<projectId>  (source never leaves the box)
   │
DEPS     npm install --ignore-scripts (best-effort, 240s cap) → node_modules   [§4.2]
         so knip (dead-code) + eslint (lint health) can resolve imports
   │
DETERMINISTIC RECON (recon.mjs, ~0 LLM)                                        [§4]
   graphify-build.py → graph.json            (AST symbol graph + Leiden communities)
   knip --reporter json → knip.json          (TS-resolver dead code; best-effort)
   alias-resolve.mjs → resolved-imports.json (alias-aware fan-in, edges, fileRoles) + graph.resolved.json
   hotspot-detect.mjs → hotspots.json        (5 ranked kinds + severity + evidence)
   graph-project.mjs → graph-ui.json         (file-level graph, role+provider tags)
   exit codes: 0 ok · 2 graphify-missing · 3 degenerate-build · 1 error   ← the trust gate
   │
SCAN-ENGINE EXTRAS (deterministic, ~0 LLM)
   subsystem-decompose.mjs → subsystem-shards.json   (named/scoped subsystems)         [§5]
   privacy-scan-internal.mjs → privacy.json          (GDPR + EU AI Act)                 [§6]
   infra-extract.mjs → infra.json                    (file-first infra inventory)        [§7]
   tests-detect.mjs → tests.json                     (TDD maturity)                      [§8.2]
   eslint-detect.mjs → eslint.json                   (eslint health; needs deps)         [§8.2]
   │
LLM SWARM (parallel, bounded concurrency 6)                                    [§8.1]
   per-subsystem analyzers  +  5 cross-cutting passes (error/magic-numbers/type-safety/ui/security)
   │
ADJUDICATE + MERGE
   version-adjudicator + independent refuter  ·  anchored-path guard  ·  dedupe          [§8.1, §9]
   │
SYNTHESIZE
   maturity-score.mjs (RAG scorecard)         [§10]
   phase-planner.mjs (topo-sort → Phase 0..6, char-net-gated)   [§11]
   aggregator report-writer (markdown)
   │
PERSIST   scan.json → S3 · scanEngineSummary → job row · docs/refactoring-scan.md → clone   [§13]
```

**Process model.** All of the above runs as **one daemon job** on EC2 (`agent-daemon.mjs`). Each
deterministic stage is a plain Node child process (never the agent path — they spend ~0 tokens). The
LLM swarm uses `spawnGateAgent` (OAuth/Max subscription). The API Lambda only enqueues jobs + serves
results.

**Live streaming.** Every stage emits `scan.*` events (`scan.deps.installing/done`, `scan.recon.done`,
`scan.decomposed`, `scan.swarm.started`, **per-agent `scan.agent.start/done`** with a finding count,
`scan.maturity`, `scan.planned`, `scan.report.done`) rendered in the Assess-tab "Scan log (live)"
(`StoryLiveOutput`) so the operator watches each subsystem analyzer + cross-cutting pass in real time.
The UI running-state is LOCAL-first (set on POST success) so the spinner shows immediately, independent
of the URL/poll round-trip in the static export.

---

## 3. Component & file map

| Layer     | Component                             | File                                                                                          | Tested      |
| --------- | ------------------------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| Recon     | Orchestrator                          | `daemon/scripts/refactor-recon/recon.mjs`                                                     | —           |
| Recon     | AST graph                             | `daemon/scripts/refactor-recon/graphify-build.py`                                             | —           |
| Recon     | Alias-resolve / fan-in / roles        | `daemon/scripts/refactor-recon/alias-resolve.mjs`                                             | —           |
| Recon     | Hotspot detector                      | `daemon/scripts/refactor-recon/hotspot-detect.mjs`                                            | ✓           |
| Recon     | Detector calibration                  | `daemon/scripts/refactor-recon/recon-calibration.json`                                        | (via above) |
| Recon     | File-graph projection                 | `daemon/scripts/refactor-recon/graph-project.mjs`                                             | ✓ (roles)   |
| Detectors | Privacy/role taxonomy                 | `daemon/scripts/refactor-recon/privacy-detectors.mjs`                                         | ✓           |
| Detectors | Internal privacy scanner              | `daemon/scripts/refactor-recon/privacy-scan-internal.mjs`                                     | ✓           |
| Detectors | Infra inventory (file-first)          | `daemon/scripts/refactor-recon/infra-extract.mjs`                                             | ✓           |
| Detectors | TDD-maturity                          | `daemon/scripts/refactor-recon/tests-detect.mjs`                                              | ✓           |
| Detectors | Eslint-health (best-effort)           | `daemon/scripts/refactor-recon/eslint-detect.mjs`                                             | ✓           |
| v2        | Subsystem decomposer                  | `daemon/scripts/refactor-recon/subsystem-decompose.mjs`                                       | ✓           |
| v2        | Finding schema                        | `functions/shared/schemas/scan-finding-schema.ts`                                             | ✓           |
| v2        | Deterministic→finding mappers         | `daemon/pipelines/lib/scan-finding-map.mjs`                                                   | ✓           |
| v2        | Swarm prompts + parser                | `daemon/pipelines/lib/scan-engine-prompts.mjs`                                                | —           |
| v2        | Orchestration core                    | `daemon/pipelines/scan-engine-job-runner.mjs`                                                 | ✓           |
| v2        | Phase planner                         | `daemon/pipelines/lib/phase-planner.mjs`                                                      | ✓           |
| v2        | Maturity scorecard                    | `daemon/pipelines/lib/maturity-score.mjs`                                                     | ✓           |
| v1        | Refactor-audit runner + char-net gate | `daemon/pipelines/refactor-audit-job-runner.mjs`                                              | ✓           |
| v1        | Privacy summariser                    | `daemon/pipelines/privacy-audit-job-runner.mjs`                                               | ✓           |
| Harness   | Dual-agent compare                    | `daemon/pipelines/dual-agent-compare-runner.mjs` + `…-capture.mjs`                            | ✓           |
| Daemon    | Job handlers + dispatch               | `daemon/agent-daemon.mjs`, `daemon/pipelines/job-router.mjs`                                  | ✓ (router)  |
| API       | Routes + schemas                      | `functions/api/index.ts`, `functions/shared/schemas/party-schema.ts`                          | —           |
| Types     | Job + record contracts                | `functions/shared/types/agent-orchestrator.ts` + `refactor-audit.ts` (+ `src/types/` mirrors) | —           |
| UI        | Assess tab (v2-only) + views          | `src/components/labs/app-detail/assess/*` (legacy v1 "Refactoring Assessment" UI retired)     | ✓           |
| UI        | Hooks                                 | `src/hooks/use-app-audit.ts`, `use-scan-engine.ts`, `use-agent-compare.ts`                    | —           |

---

## 4. Deterministic recon (v1 foundation)

`recon.mjs <repo> [--src src] [--skip-graphify]`. Stages run sequentially; outputs land in
`<repo>/graphify-out/`.

**4.1 graphify** (`graphify-build.py`, Python) — AST symbol graph: nodes (files, classes, functions)
with `source_file`, `community` (Leiden), edges (defines/imports/calls). Degenerate builds (too few
nodes/edges) exit 3 → recon aborts (the structural substrate isn't trustworthy enough to ground a
swarm).

**4.2 deps + knip** — the scan-engine runs a best-effort `npm install --ignore-scripts --no-audit
--no-fund` (or `npm ci` when a lockfile exists; `--ignore-scripts` is a security boundary — never run
an untrusted clone's postinstall) with a 240s cap **before** recon, so knip + eslint can resolve
imports (emits `scan.deps.installing` / `scan.deps.done`). knip then runs `npx knip --reporter json`
→ `knip.json`; `toolStatus.knip` records `ok|empty|unavailable`. If the install fails/times out (slow
deps, private registry, OOM), knip + eslint degrade gracefully: dead-code falls back to a zero-fan-in
orphan heuristic flagged `needs-review`, and the eslint axis stays `unmeasured`.

**4.3 alias-resolve** (`alias-resolve.mjs`) — recomputes the file→file import graph from source with
tsconfig path-alias + extension + index resolution (graphify's edges are alias-blind). Emits
`resolved-imports.json`: `hubs[]` (`{file, inDegree}`), `edges[]` (`{source, target}`), and
`fileRoles{}` (per-file `{role, kinds, detections}` from the shared privacy detectors — §6). Also
writes `graph.resolved.json` (graphify graph + `resolved_in_degree`).

**4.4 hotspot-detect** (`hotspot-detect.mjs`) → `hotspots.json`. Five kinds, each scored 0–100 →
severity bucket; calibration externalised in `recon-calibration.json` (`--calibration <path>` to
override — tunes the heuristics per framework without editing code).

| Kind                          | Trigger                                                                                | Evidence fields                                            |
| ----------------------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| `god-object`                  | class with ≥ `godObjectMinMethods` (12) method out-edges                               | `methods, importers, community, role, file`                |
| `duplicate-subsystem`         | same basename across dirs (excluding conventions) / version-marked roots               | `copies[]` or `{count, totalFiles, roots[]}`               |
| `design-system-consolidation` | duplicate basenames under `components/(ui\|primitives)/`                               | `canonical, byDir, duplicatedComponents[]`                 |
| `low-cohesion-split`          | community ≥ `lowCohesionMinNodes` (25) with cohesion ≤ `lowCohesionMaxCohesion` (0.12) | `size, cohesion, community`                                |
| `dead-code`                   | knip-flagged / zero alias-resolved fan-in                                              | `knipFlagged, confirmedZeroFanIn, needsReview, confidence` |

Severity buckets: `score ≥ 80` critical · `≥ 55` high · `≥ 30` medium · else low.
**False-positive guards (calibration):** `conventionFilenames` (route.ts/page.tsx/… — required to
repeat, never duplicate-flagged), `coLocatedConventionFilenames` (types.ts/utils.ts/… — recur per
module legitimately), `uiDirPattern`, `versionMarkerPattern` (cluster legacy by first marked
segment; numbered families → highest-version-is-current; `enhanced`/`hierarchical`/migrations
excluded), `duplicateExcludeDirs` (variants/**mocks**/**fixtures**). `toolStatus` +
`detected/shown` counts are emitted (no silent truncation).

**4.5 graph-project** (`graph-project.mjs`) → `graph-ui.json` (file-level CanvasNode/CanvasLink for
the Graph tab): one node per source file with `community`, `fanIn`, `hotspotKinds`, and **`role` +
`providers`** (infra/db/ai/thirdParty, from `fileRoles`). Capped at 1500 nodes (keeps all hotspot +
highest-degree files). Uploaded to S3 `knowledge-live/<id>/_refactor/graph.json`.

**4.6 L3 adjudication (optional, v1)** — `runL3Adjudication` (`refactor-audit-job-runner.mjs`) spawns
ONE agent (`version-adjudicator` role) that confirms/rejects hotspots from code and emits a
Strangler-Fig `planOutput`; `findCharacterizationGateViolations` flags any deletion/repoint story
lacking a characterization-net dependency. Gated by `refactorAuditPayload.runL3`.

---

## 5. Subsystem decomposition (v2)

`subsystem-decompose.mjs <graphifyOutDir>` → `subsystem-shards.json`. Derives named/scoped
subsystems from recon outputs (NOT a hand-authored list): **parent-directory boundaries** (the
robust fallback when Leiden communities are degenerate), each shard carrying `members[]` (scoped
read-set), `depends[]` (cross-module `§sys:` edges from `resolved-imports`), `fanInTotal`, `roleMix`,
`hotspotCount`, and a **`focus`** line synthesised from that shard's hotspots + top hubs. Ranks
hotspot-bearing + high-fan-in shards first. The cap is **soft**: `analyze = (rank < cap) ||
hotspotCount > 0`, so **every hotspot-bearing shard gets a dedicated analyzer regardless of `--cap`
(default 24)** — the cap only bounds the non-hotspot top-by-rank tail; the rest are sampled (logged).
On a debt-heavy repo this means the swarm scales up (observed: applicator-onboarding → 482 shards,
43 analyzed = all 43 hotspot-bearing, 48 swarm agents). Emits `lowConfidence` when one boundary holds

> 70% of files or there's a single boundary.

---

## 6. Privacy / compliance detectors

**6.1 Shared taxonomy** (`privacy-detectors.mjs`) — one source of truth used by the scanner, the
graph role-tags, and the infra inventory. `classifyImport(spec)` / `classifyPath(file)` /
`classifyFile(file, specifiers)` → `{kind, provider, residency}`. `kind ∈ ai|db|infra|thirdParty`;
`residency ∈ external | in-account | varies`. Residency-aware AI distinction is central: **Anthropic
Claude API = external**, **AWS Bedrock = in-account**. `primaryRole(kinds)`: infra > db > ai >
thirdParty.

**6.2 Internal scanner** (`privacy-scan-internal.mjs`) — deterministic, ~0 LLM, source stays on the
box. Maps each detection to GDPR / EU AI Act findings: AI external → EU AI Act "AI System In Use" +
GDPR Art. 44 "Cross-border AI Data Transfer"; db → Art. 32 "Personal Data Store"; thirdParty
analytics → "3rd-party Tracking — Consent"; infra → "Infrastructure & Data Residency"; + a
PII-in-logs line scan. Skips docs/tests/fixtures. Groups into `by_regulation`. `summarizePrivacyReport`
(`privacy-audit-job-runner.mjs`) rolls findings up **category-first** into a `PrivacyAuditSummary`
(`byRegulation[reg].categories[]` with severity/score/fileCount/remediation/citation/sampleFiles).

**6.3 External mode** — `privacyMode: 'external'` routes to the `data-privacy-platform` service
(rulepack-in/findings-out). Default is `internal`.

---

## 7. Infrastructure inventory (v2, file-first)

`infra-extract.mjs <repo>` → `infra.json`. **Detection strategy, strongest signal first** (each
detection records `detectedBy` + `confidence`, so codebases of different infra-expression maturity
are scored honestly):

1. **IaC / config FILES — declared, authoritative (high):** `parseConfig` reads content of
   `schema.prisma` (datasource provider), `*.tf` (terraform `provider` + `resource` blocks →
   friendly services + cloud via `TF_RESOURCE`), `serverless.yml`, `docker-compose.yml` (images),
   Pulumi/CloudFormation, platform configs (Vercel/Netlify/Fly/Render/GCP App Engine/Heroku), CI
   deploy workflows.
2. **ENV-key names — declared intent (medium):** parsed from `.env.example/.sample/.template` ONLY
   (never `.env`; no secrets) via `ENV_KEY`, incl. safe value host hints (`smtp.hostinger.com`).
3. **SDK/package imports — inferred (medium/low):** `CLOUD_SDK` catalog (AWS/GCP/Azure/Supabase/
   email/Steam) + `classifyImport` for db/ai/3rd-party.

Output: `services[]` (`{name, kind, cloud, residency, dataStore, detectedBy[], confidence,
declares[], files[]}`), `iac[]`, `external[]` (residency=external → **feeds GDPR Art. 44 + EU AI
Act**), `clouds[]`, `boundaries` (client/server/external-touching file counts → front-end↔infra
security surface), and **`signalQuality`** (`high` if IaC declared · `medium` if SDK/env only ·
`low`). Declared detections beat inferred when merging.

**Tiers (boundary):** Tier 1 (which services + IaC presence) = built. Tier 2 (deep configs — ALB
rules, Lambda memory, CloudFront behaviours via an LLM cartographer) and Tier 3 (live AWS state) =
designed, not built.

---

## 8. The v2 swarm + detectors

**8.1 LLM swarm** (`scan-engine-prompts.mjs` + `scan-engine-job-runner.mjs`). Two layers
(`parseAndValidate` enforces the finding vocab; bounded concurrency 6):

- **Per-subsystem analyzers** — one per analyzed shard, scoped to `members[]`, steered by `focus`,
  forbidden from re-deriving repo structure (recon already did → cheap + grounded).
- **5 cross-cutting passes** (whole-repo breadth, each **seeded** with deterministic candidate sites,
  never "go find smells"): `error-handling`, `magic-numbers`, `type-safety`, `ui-centralization`,
  `safety-security`. Empty-agent fallback so a barren pass never zeroes a section.

Compliance findings cost **zero LLM** (the internal privacy scanner is complete; unioned at merge).

**8.2 deterministic maturity detectors** (~0 LLM, feed the scorecard §10):

- **tests-detect** (`tests-detect.mjs`) — file-walk: test/source file ratio + runner detection
  (vitest/jest/playwright/test-script) → `tests.json` (TDD-maturity axis). Always runnable.
- **eslint-detect** (`eslint-detect.mjs`) — runs the repo's OWN eslint (`npx --no-install eslint . -f
json`; needs the deps installed in §4.2), then `summarizeEslint` weights **code > tests > warnings**
  (code errors ×1, test errors ×0.3, warnings ×0.25) so the score floats on production-code lint
  health → `eslint.json` (eslint-health axis). Best-effort: no config/deps → `runnable:false` →
  axis `unmeasured`.

---

## 9. Finding contract & merge

**9.1 `ScanFinding`** (`scan-finding-schema.ts`) — ONE shape deterministic + LLM findings both map
into:

```ts
{ id, dimension: 'architecture'|'safety-security'|'compliance'|'code-quality-refactoring'|'correctness',
  area, severity: 'High'|'Medium'|'Low–Med'|'Low', effort: 'Trivial'|'Small'|'Medium'|'Large',
  location: 'path:line', issue, suggestion, evidence: {…}, source: 'deterministic'|'llm',
  confidence?, dependsOn: [], overlaps?: [] }
```

`effort`/`dimension`/`dependsOn` are the net-new axes over v1's `AuditHotspot`. `compareFindings`
sorts severity High→Low then cheapest-effort-first.

**9.2 Mappers** (`scan-finding-map.mjs`): `hotspotToFinding` (carries the planner's evidence hints:
`hotspotKind/isFoundation/isDeletion/godFile/safeCandidate/…`), `privacyToFindings` (category-first,
one finding per regulation-category), `dropUnanchored` (keep deterministic always; drop LLM findings
whose file ∉ `graph.resolved.json` node set — the hallucination guard).

**9.3 Adjudication + dedupe** (`scan-engine-job-runner.mjs`): the `version-adjudicator` +
independent-refuter pattern (default-skeptic); `dedupe` collapses same-`location+issue` (deterministic
beats llm, higher severity wins, loser id → `overlaps`).

---

## 10. Maturity scorecard (v2)

`computeMaturity` (`maturity-score.mjs`) → `{axes[], overall}`. 9 axes; status `≥0.7 good · ≥0.4
fair · else poor`; `overall` averages only **measured** axes; unmeasured axes carry a CTA, never a
fake score. `scoreFromCount(n, worstAt)` = `clamp(1 - n/worstAt)`.

| Axis                           | Source                                              | Status                         |
| ------------------------------ | --------------------------------------------------- | ------------------------------ |
| component-driven (anti-inline) | UI-centralization findings + design-system hotspots | live                           |
| dead code / clutter            | knip / dead-code findings                           | live (degraded if knip absent) |
| structure sanity               | god-objects + duplicate-subsystems + low-cohesion   | live                           |
| type safety                    | unsafe-cast / unvalidated findings                  | live                           |
| security & compliance          | High safety-security + compliance findings          | live                           |
| graph installed                | graph built?                                        | live                           |
| TDD maturity                   | `tests-detect` ratio + runner                       | live                           |
| eslint health                  | `eslint-detect` (code>tests>warnings)               | live (best-effort; needs deps) |
| SDD-driven                     | (parallel spec-driven-development work)             | unmeasured                     |

---

## 11. Phased plan generator (the differentiator)

`phase-planner.mjs` — a topological sort over a **rework-dependency DAG**, not a severity sort
(severity-first forces re-touching files 3× as later phases re-extract).

**11.1 Dependency edges** (`deriveDependencies` + the char-net gate): (1) **foundation-before-
consumer** (consumers of a shared artifact depend on the finding that introduces it; high-fan-in
shards are foundational), (2) **Strangler-Fig** (a deletion depends on its extract/repoint), (3) the
**characterization-net gate** (`findCharacterizationGateViolations`, regex `DELETION_RE` /
`CHAR_NET_RE`) run on the linearised sequence.

**11.2 Bands** (`assignBand`) — the canonical ladder; routing is **text-driven** for LLM findings
(they carry no structural hints), deterministic kinds route by kind first:
Phase 0 stop-the-bleeding (all dead-code + mechanical + High/Medium-Trivial quick-wins) · 1 shared
constants & contracts (magic-numbers/centralize) · 2 shared helpers (duplication/dedup) · 3 UI
centralization (hand-rolled/inline/badge/design-system) · 4 god-file decomposition · 5 correctness
(entangled remainder) · 6 scale & quality (Large auth/pagination/perf).

**11.3 Algorithm** (`planPhases`): normalize+dedupe → build DAG → assign bands → propagate (a finding
is pulled **later**, never earlier, if a dep sits later) → topo-sort within bands (severity then
effort tiebreak) → emit phases with a per-phase "why-before-next" rework-minimization proof.

**11.4 `toPlanOutput`** — emits schema-shaped epics/stories (`E\d+`/`S\d+`); every phase containing a
mutator (`DELETION_RE` on title+suggestion) gets a leading characterization-net story that mutators
depend on → the generated plan **passes `findCharacterizationGateViolations` by construction**.

**11.5 Bridge to real refactoring** — `buildScanPlanIntent` (`scan-report.tsx`): selected phases →
a dependency-ordered, Strangler-Fig, char-net-gated intent → `NewPlanModal` → the existing dev
pipeline (create-story/dev-story, which enforces tests-before-mutation at run time).

---

## 12. Dual-agent comparison harness

`runDualAgentCompare` (`dual-agent-compare-runner.mjs`) + `…-capture.mjs`: same question, two agents
over the clone — A vanilla tools, B + the Mycelium graph MCP (`myceliumMcpSpawnForced`, regardless
of the global flag — graph access IS the variable). Captures per lane `{answer, latencyMs, tokens,
costUsd, toolCalls, graphToolCalls}` (`DualAgentLaneResult`). Run sequentially (OAuth contention).
Job kind `dual-agent-compare`; result rides the job row.

---

## 13. Data contracts, APIs, persistence

**13.1 API routes** (`functions/api/index.ts`, brownfield-only, JWT-auth):

| Method · Route                                   | Enqueues / returns                                                                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /api/party/projects/:id/assess`            | v1 `refactor-audit` job (body: `src, skipGraphify, runL3, topN, runPrivacy, privacyMode`). Route + job kept; **UI retired** — no longer exposed in the Assess tab. |
| `POST /api/party/projects/:id/scan-engine`       | v2 `scan-engine` job (body: `src, cap, privacyMode` — `internal` default \| `external` GDPR service)                                                               |
| `POST /api/party/projects/:id/agent-compare`     | `dual-agent-compare` job (body: `question, model, timeoutMs`)                                                                                                      |
| `GET /api/party/projects/:id/audits`             | durable audits list                                                                                                                                                |
| `GET /api/refactor-audits/:auditId` · `DELETE …` | one durable record / delete                                                                                                                                        |

**13.2 Daemon job kinds** (`job-router.mjs` `selectHandler` → `agent-daemon.mjs` executors):
`refactor-audit` → `executeRefactorAuditJob` · `scan-engine` → `executeScanEngineJob` ·
`dual-agent-compare` → `executeDualAgentCompareJob`. Each validated (`validate*Job`) + bounded to
`projectPath` under `PARTY_PROJECTS_ROOT` (`/home/ubuntu/projects`).

**13.3 Persistence** — denormalized summaries on the `futurator-agent-jobs` row
(`refactorAuditSummary` · `scanEngineSummary` · `dualAgentCompareResult`); durable
`RefactorAuditRecord` in `futurator-refactor-audits` (status `recon-only|adjudicated|scan-v2`); full
artefacts in S3 `knowledge-live/<projectId>/_refactor/` (`graph.json`, `scan.json`, `privacy.json`);
the markdown report in the clone at `docs/refactoring-scan.md`. `scan.json` carries
`{findings, phases, planOutput, gateViolations, counts, maturity, infra, lowConfidence,
reportMarkdown}`.

---

## 14. The five dimensions & scan-authority sequencing

Dimensions: `architecture` · `safety-security` · `compliance` · `code-quality-refactoring` ·
`correctness`. **Sequencing matters:** `infra-extract` runs **before** the compliance/AI-Act
reasoning because its `external[]` list (every processor data leaves to) is exactly what GDPR Art. 44

- the EU AI Act key off; the infra inventory + privacy scanner share `privacy-detectors.mjs`, so the
  role/residency taxonomy is identical across the graph, the scanner, and the infra map (no divergent
  re-detection). Front-end↔infra security is the `boundaries` count + the `safety-security` pass.

---

## 15. Deployment & ops

- **Daemon:** `./scripts/rsync-daemon.sh` → `/opt/futurator-daemon/` on EC2 (hash-verifies
  `agent-daemon.mjs`, restarts the systemd unit). **Deploy the daemon FIRST** (it holds all the
  detectors + executors).
- **API + frontend:** `sst deploy` (never a manual `aws s3 sync` — see the CLAUDE.md dual-bucket
  safety rule).
- **Safety:** report-only; clone under `PARTY_PROJECTS_ROOT`; source never leaves the box (privacy
  boundary events log the host, never tokens/values).

---

## 16. As-built vs designed-not-built

**Built + tested + deployed:** all of §4–§13 — v2 subsystem decomposition + swarm + adjudication +
dedupe + maturity + phase-planner + file-first infra + bridge + export; the deterministic detectors
(privacy, infra, tests, **eslint**) + the best-effort `npm install` that lets knip + eslint run; v2
uploads `graph.json` (Graph tab populates after a v2 scan); the v2 **External\|Internal privacy
toggle**; **live per-agent streaming** (`scan.*` events incl. `scan.agent.start/done`, deps steps) +
a reliable running-state/spinner; the **v1 deterministic-only "Refactoring Assessment" UI is retired**
(its route + job kind remain but are unexposed — the Assess tab is v2-only). Multiple real runs on
`applicator-onboarding` (e.g. 308 findings across 5 dimensions, 6 phases, 41 hotspots).

**Designed, not built:** infra Tier 2 (LLM cartographer for deep IaC configs) + Tier 3 (live-AWS
probing); the **SDD-driven** maturity axis; per-language graphify adapters (non-JS/TS gets a thin
skeleton); cross-portfolio roll-up; sharded aggregator for very large repos. **Environment-dependent:**
the `npm install` is best-effort (240s cap, `--ignore-scripts`) — on a slow/private/OOM-prone clone it
degrades and knip + eslint report unmeasured.

---

## 17. Extension guide

- **Add a deterministic detector:** new `*.mjs` in `refactor-recon/`, spawn it in
  `executeScanEngineJob`'s `readArtifacts`, map its rows via `scan-finding-map.mjs` (or feed a
  maturity axis). Keep it ~0 LLM.
- **Add a cross-cutting pass:** append to `CROSS_CUTTING` in `scan-engine-prompts.mjs` with a seed.
- **Add a dimension:** extend `SCAN_DIMENSIONS` in `scan-finding-schema.ts` + the UI `DIMENSIONS`.
- **Tune phasing:** `assignBand` / the `*_RE` regexes in `phase-planner.mjs` (unit-test against real
  finding text).
- **Tune detection:** `recon-calibration.json` (no code edits) for hotspot heuristics;
  `privacy-detectors.mjs` / `infra-extract.mjs` catalogs for providers.

---

## 18. Test inventory

`scan-finding-schema.test.ts` · `phase-planner.test.mjs` · `scan-finding-map.test.mjs` ·
`subsystem-decompose.test.mjs` · `scan-engine-job-runner.test.mjs` · `maturity-score.test.mjs` ·
`infra-extract.test.mjs` · `eslint-detect.test.mjs` · `tests-detect` (in maturity test) ·
`build-scan-plan-intent.test.ts` · `build-plan-intent.test.ts` (v1 intent, retained) ·
`hotspot-detect.test.mjs` (v1 regression) · `graph-project-roles.test.mjs` ·
`dual-agent-compare-runner.test.mjs` · privacy detector/scanner tests. Deterministic cores are pure

- unit-tested; the LLM swarm + job wiring are tested with injected fakes.

---

## 19. Linked source docs

- `scan-engine-design.md` — v2 design rationale (thesis, why-hybrid, open questions).
- `docs/prd-refactoring-module.md` · `docs/epics-refactoring-module.md` — v1 PRD + epics.
- `docs/concepts/privacy-assessment-change-requests.md` — privacy lane change requests.
