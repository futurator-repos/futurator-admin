# Skills Institution — Architecture

**Author:** Richie · **Date:** 2026-06-17 · **Version:** 1.0
**Inputs:** `skills-institution-prd.md`, `skills-repository-vision.md` (§5 state machine, §6 schemas, §10 build order)
**Nature:** Brownfield — extends existing daemon/API/registry/graph components. Decision-focused, optimized
for consistent implementation by AI agents.

---

## Executive Summary

The Skills Institution is a **brownfield extension**, not a new system. Its spine is **one gate**
(`merge → scan → label → version → inbox → ratify`) feeding **one lifecycle state machine**, with a
strict governance line: **mechanical counting/thresholding is automated (Phase-1 telemetry); synthesis
is human-ratified (Phase-2)**. Skills live in **two tiers** — a global Git-backed warehouse
(`futurator-repos/futurator-skills`) and per-app sub-registries (`<app>/.claude/skills/`) — bridged by
SKILL-SCOUT, which proposes **only `trusted`** skills.

Phase 1 closes the loop safely with four capabilities: `REFLECTOR-APPLY` (gives the existing reflector
a landing zone), the minimal gate + deterministic security scan, the Registry Growth inbox, and a
one-time retro-scan that makes the 245 incumbents honestly labeled. Phases 2–3 add the telemetry state
machine, provenance/origin-hash tiering, retrieval, bulk acquisition, the agentic Builder, and the
Mycelium handoff — all reusing the same gate.

**Architectural invariant:** nothing reaches an app's context unless it is `trusted`; nothing becomes
`trusted` without passing Gate-1 (machine) and ratify (human).

---

## Sanity-Check Findings (2026-06-17, verified vs live code)

The doc was validated against the codebase. ~90% held; the corrections below are folded in:

- **🔴 `reflector-apply.mjs` already exists and is NOT a stub** (`daemon/pipelines/reflector-apply.mjs`,
  Epic 6, 2026-05-20). Confirm→apply wiring works (daemon polls `status: confirmed`). **But** its
  `project-skill` path only **installs an existing federation skill by name** (manifest + vendor-fetch);
  it **cannot author a new skill from a reflection's `content`.** → Epic E1 EXTENDS this function and
  fixes the stale stub comment in `reflections-service.ts:76–81`; it does not build from scratch. The
  "apply is a stub" framing (vision §1, PRD) means specifically the **author-from-lesson** capability.
- **🟡 Facets must be added to BOTH types** — `CatalogSkill` (`skill-catalog.ts`) lacks `provenance`
  today; only `SkillIndexEntry` (`skill-authoring.ts`) has it. Story 2.1 extends both; the 5-min catalog
  TTL lives in `functions/api/index.ts:11067` (not the shared module).
- **🟢 `skill-proposals` table template found** — `sst.config.ts` already declares
  `propagatorProposalsTable` (PK `proposalId`, PAY_PER_REQUEST). Clone its shape and add the
  `status-createdAt-index` GSI (pattern: `agentJobsTable`).
- **🟢 Confirmed net-new** — no `skill-gate`, no security scanner, no `/api/skill-proposals`, no
  `growth-inbox` UI; `index.embeddings.json` is write-only; `SkillIndexEntry` is exactly 7 fields.

## Decision Summary

| Category             | Decision                                                                             | Version                   | Affects         | Rationale                                                      |
| -------------------- | ------------------------------------------------------------------------------------ | ------------------------- | --------------- | -------------------------------------------------------------- |
| Registry storage     | Git repo `futurator-repos/futurator-skills` remains canonical; bodies vendored       | existing                  | all             | Already live; Git gives versioning + diff for free             |
| App sub-registry     | App-evolved skills live in `<app>/.claude/skills/` + per-app sidecar                 | new (P1 minimal, P2 full) | A, integrity    | App owns its adaptations; PRD decision                         |
| Inbox store          | New DynamoDB table `skill-proposals` (PK `proposalId`, GSI `status-createdAt`)       | new (P1)                  | C               | Durable across restart; one-table-per-concern preference       |
| App-scoped proposals | Reuse existing `reflections` table for `target: project-skill`                       | existing                  | A               | Reflector already writes these                                 |
| Gate                 | One shared module `functions/shared/skill-gate/` + async daemon job                  | new (P1)                  | B, E            | Build once, four entry adapters                                |
| Security scan        | Deterministic Gate-1 (blocking) in shared module; Gate-2 LLM as on-demand daemon job | new (P1)                  | B               | Gate-1 must run everywhere incl. Lambda; Gate-2 heavy/optional |
| Labeling             | Extend `index.json` entry with 6 facets; backward-compatible                         | new (P1)                  | B, D, integrity | System-owned facets vs human-owned `trustTier`                 |
| Trust gate           | SKILL-SCOUT install path filters to `trustTier: trusted`                             | new (P1)                  | D               | The core safety invariant                                      |
| Origin-hash          | Per-app `.claude/skills/.origin.json` records upstream hash                          | new (P2)                  | A               | Adapted skill never stomped by upstream                        |
| Telemetry            | `index.usage.json` sidecar; counters from `skill_activated`/`Skills-Used`            | new (P2)                  | P2              | Phase-1 mechanical, principle-safe                             |
| Retrieval            | Read `index.embeddings.json` into memory; trust-filter → hybrid top-k → rerank       | new (P2)                  | P2              | Sidecar before graph; scales to low-thousands                  |
| Embeddings           | Voyage `voyage-3` via existing `daemon/scripts/lib/voyage-embed.mjs`                 | existing                  | P2              | Already in stack                                               |
| Bulk                 | Source Registry table + Firecrawl crawl + agentic extract → the gate                 | new (P3)                  | P3              | Curate sources, not skills                                     |
| Curation unit        | Cluster (B) primary, source (C) accelerator, skill (A) exception                     | decided                   | P3              | Scales sub-linearly                                            |
| Graph                | Skills become Mycelium nodes once co-activation edges dense; reuse `graph-sync.mjs`  | new (P3)                  | P3              | Don't build an empty graph                                     |
| Deploy               | API+UI via `sst deploy`; daemon via SSM Run Command                                  | existing                  | all             | SSH unreliable (rotating egress IP)                            |

---

## Project Structure

```
Futurator-Admin/
├── functions/
│   ├── api/index.ts                         # +gate routes, +inbox routes, trust filter (Hono)
│   └── shared/
│       ├── skill-gate/                       # NEW — the one gate
│       │   ├── index.ts                      #   orchestration (merge→scan→label→version)
│       │   ├── security-scan.ts              #   Gate-1 deterministic patterns
│       │   ├── dedup.ts                      #   cosine near-dup (merge step)
│       │   └── labeling.ts                   #   facet computation
│       ├── skill-catalog.ts                  # extend CatalogSkill with facets
│       ├── skill-authoring.ts                # body CRUD (exists); add facet writes
│       ├── schemas/
│       │   ├── skill-index-entry-schema.ts   # NEW — extended index.json entry (zod)
│       │   ├── skill-proposal-schema.ts      # NEW — inbox proposal (zod)
│       │   └── project-skill-manifest-schema.ts # activate plans: overlay (exists)
│       ├── repositories/
│       │   └── skill-proposals-repository.ts # NEW — DynamoDB inbox CRUD
│       └── types/reflection.ts               # exists (target: project-skill)
├── daemon/
│   ├── pipelines/
│   │   ├── reflector-runner.mjs              # exists; +REFLECTOR-APPLY on ratify
│   │   ├── skill-installer.mjs               # exists; enforce trusted-only
│   │   └── skill-gate-job.mjs                # NEW — async gate (bulk/scan/eval/LLM-review)
│   └── lib/
│       ├── federation-resolver.mjs           # exists; +retrieval read-side (P2)
│       ├── skill-retrieval.mjs               # NEW (P2) — filter→top-k→rerank
│       ├── skill-telemetry.mjs               # NEW (P2) — usage state machine
│       └── reflector-apply.mjs               # NEW (P1) — write skill to app repo
├── src/app/labs/skills/                      # registry UI (exists); +Growth inbox, +labels
│   └── growth-inbox/                         # NEW — the curation inbox surface
├── scripts/
│   ├── ingest-skills.mjs                     # exists; route through the gate (P3)
│   └── retro-scan-skills.mjs                 # NEW (P1) — one-time Gate-1 over the 245
└── docs/concepts/skills-management/          # PRD, architecture, ux, epics
```

Registry repo (`futurator-repos/futurator-skills`):

```
futurator-skills/
├── index.json                # entries gain facets (backward-compatible)
├── index.embeddings.json     # voyage-3, exists (read-side wired P2)
├── index.usage.json          # NEW (P2) — telemetry counters
├── REPORT.md                 # NEW (P1) — retro-scan + curator audit artifact
└── skills/<name>/SKILL.md     # bodies (exists)
```

---

## Epic to Architecture Mapping

| Epic (Phase 1)                      | FRs           | Primary components                                                                                                    |
| ----------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------- |
| E1 — Authoring from experience      | FR1           | `daemon/lib/reflector-apply.mjs`, `reflector-runner.mjs`, `skill-gate/security-scan.ts`, reflections repo             |
| E2 — The gate + security            | FR2, FR3, FR5 | `functions/shared/skill-gate/*`, `skill-index-entry-schema.ts`, `daemon/pipelines/skill-gate-job.mjs`                 |
| E3 — Curation inbox + manual growth | FR4, FR8      | `skill-proposals-repository.ts`, `skill-proposal-schema.ts`, `/api` inbox routes, `src/app/labs/skills/growth-inbox/` |
| E4 — Registry integrity             | FR6, FR7      | `scripts/retro-scan-skills.mjs`, `skill-installer.mjs` (trust filter), `skill-catalog.ts`                             |

Phase 2 epics (E5 telemetry, E6 provenance/origin-hash, E7 retrieval) and Phase 3 (E8 bulk, E9 Builder,
E10 Mycelium) map to the `daemon/lib/*` and `scripts/*` new modules above; decomposed later.

---

## Technology Stack Details

### Core Technologies

- **API:** Hono.js single-Lambda (`functions/api/index.ts`). New routes added here; **no Hono CORS**
  (configured at Function URL level).
- **Daemon:** Node.js ESM on EC2; polls DynamoDB, spawns Claude CLI. Hosts apply/scan/retrieval/eval.
- **Registry:** Git (GitHub `futurator-repos`), accessed via the connector (`getFileContent`/`putFile`/
  `deleteFile`, PAT from SST secret). Bodies ≤1MB.
- **Persistence:** DynamoDB, **one table per concern** (`skill-proposals` new; `reflections`,
  `agent-jobs`, `agent-events` exist).
- **Embeddings:** Voyage `voyage-3` (1024-dim) via `daemon/scripts/lib/voyage-embed.mjs`.
- **Graph:** Memgraph/Mycelium via `graph-sync.mjs` (P3 consumer).
- **UI:** Next.js 16 static export; `@/components/ui` primitives (hard requirement: reuse Labs UI).

### Integration Points

- **Reflector → app repo** (FR1): `reflector-apply.mjs` invoked when a `reflections` row flips to
  `confirmed` with `target: project-skill`. Writes `<app>/.claude/skills/<name>/SKILL.md`, commits.
- **Gate → registry** (FR2): ratifying a `skill-proposals` row calls `skill-authoring.putSkill()` with
  facets → commit to `futurator-skills`.
- **Scout → install** (FR7): `skill-installer.mjs` / `federation-resolver.mjs` filter to `trusted`.
- **Telemetry source** (P2): `skill_activated` events (`agent-events`) + `Skills-Used:` trailers feed
  `skill-telemetry.mjs` → `index.usage.json`.

---

## Novel Pattern Designs

### Pattern 1 — The one gate (four adapters, one path)

```
adapter (reflect | create | paste-url | bulk) → buildProposal()
  → merge(dedup)  → scan(Gate-1)  → label(facets)  → version(lineage)  → skill-proposals (status: pending|quarantined)
                                                                          → inbox → ratify → putSkill()/applyToApp()
```

- Synchronous path (create, paste-url single, reflect): runs in Lambda/daemon inline.
- Async path (bulk, LLM-review, eval): enqueued as `skill-gate-job` on the daemon.
- **Invariant:** the only writers to `trusted` are the gate's ratify exit.

### Pattern 2 — The lifecycle state machine (authoritative)

States on `trustTier` × `securityStatus`:
`unverified → [Gate-1] → quarantined | (reviewed) → [ratify] → trusted → [supersededBy] → deprecated`.
App path: `trusted → installed → app-evolved → [graduate ≥2 plans] → gate → trusted`. Implemented as a
pure reducer `functions/shared/skill-gate/lifecycle.ts` (no side effects; transitions validated).

### Pattern 3 — Origin-hash forking (P2)

`<app>/.claude/skills/.origin.json`: `{ "<name>": { sourceVersion, originHash } }`. On install, record
upstream body hash. Before an upstream pull, recompute local hash: **equal → safe to pull; diverged →
app-evolved, skip upstream forever.** Guarantees no loss of app procedural memory.

### Pattern 4 — Retrieval (P2)

`skill-retrieval.mjs`: (1) metadata filter (`trustTier=trusted`, provenance, app-first); (2) hybrid —
keyword match on name/description ⊕ cosine over `index.embeddings.json` (in-memory); (3) optional
rerank. Returns shortlist; the scout proposes from it. Never vector-search the raw pile.

### Pattern 5 — Phase-1/Phase-2 boundary (governance)

Counting/thresholding (`skill-telemetry.mjs`, dedup clustering) is deterministic and unattended.
Synthesis (merge canonical, promote to `trusted`) is always a human ratify in the inbox. **No code path
feeds aggregated cross-journal tallies to an agent that writes a synthesis.**

---

## Implementation Patterns

- **Repository pattern**, pure functions per concern (matches existing `*-repository.ts`).
- **Zod `.safeParse()`** for all external input (proposals, index entries, crawl output).
- **`AppError`/`ValidationError`** envelopes (`functions/shared/errors.ts`); GitHub-relay 401 → 502.
- **Catalog cache** (5-min Lambda TTL) busted on any write.
- **Attributable commits** — skill writes carry trailers (`Skills-Changed:`, `Agent:`, ratifier).
- **Idempotent batch ops** — retro-scan and migrations re-runnable; `BatchWrite` with UnprocessedItems retry.

## Consistency Rules

### Naming Conventions

- Skill `name` = slug `^[a-z0-9][a-z0-9-]{1,63}$`. Files: `skills/<name>/SKILL.md`.
- New modules: kebab-case files; `skill-*` prefix for skill-domain modules.
- DynamoDB: `skill-proposals` table; PK `proposalId` (ULID), GSI `status-createdAt-index`.
- Facets use the vocab in Data Architecture verbatim (no synonyms).

### Code Organization

- Shared, deployable-anywhere logic (scan, lifecycle, labeling, dedup) → `functions/shared/skill-gate/`
  so both Lambda and daemon import it. Daemon-only orchestration → `daemon/lib|pipelines/`.
- UI: the inbox is a route under `src/app/labs/skills/`, using `@/components/ui` only.

### Error Handling

- Gate steps never throw to the caller mid-batch — a failing item drops to `quarantined`/`null` with a
  recorded reason; the batch continues. Atomic single-skill writes (body-last fail-safe).

### Logging Strategy

- Derived artifacts (`REPORT.md`) for human-facing audit; structured daemon logs for jobs; **never log
  secrets/PATs**; trust transitions recorded on the proposal row.

---

## Data Architecture

### Extended `index.json` entry (FR5)

```jsonc
{
  "name": "fix-flaky-tests",
  "kind": "core", // existing
  "framework": false, // existing
  "version": "sha:HEAD", // existing
  "license": "MIT", // existing
  "description": "...", // existing
  "provenance": "github.com/...", // existing (optional)
  // NEW facets (all optional → backward-compatible; migrated with safe defaults):
  "provenanceClass": "third-party", // constitutional|vendored|app-evolved|third-party
  "securityStatus": "reviewed", // clean|flagged|quarantined  (null until scanned → migrate to 'unverified')
  "qualityGrade": "ungraded", // A-F | number | ungraded
  "trustTier": "reviewed", // draft|reviewed|trusted|deprecated
  "maturity": 0, // usage-derived (P2)
  "lineage": { "adaptedFrom": null, "graduatedFrom": null, "supersededBy": null },
}
```

### `skill-proposals` table (FR4) — new DynamoDB

PK `proposalId` (ULID) · GSI `status-createdAt-index`.

```
proposalId, source(reflect-graduate|create|paste-url|bulk), skillName, kind,
proposedBody, proposedEntry(extended index entry), gist(string),
securityStatus, scanReport(patterns hit), qualityGrade, clusterId?(P3),
llmReview?(advisory verdict), status(pending|quarantined|ratified|rejected|deferred),
createdAt, ratifiedBy?, ratifiedAt?, lineage
```

The unified **diff** shown in the inbox is computed from `proposedBody` vs current registry body.

### App-scoped proposals — reuse `reflections` (exists)

PK `projectSlug`, SK `id`. `target: project-skill`, `skillName`, `action`, `content`, `confidence`,
`evidence[]`, `status`. `REFLECTOR-APPLY` consumes `confirmed` rows.

### Per-app origin manifest (P2) — `.origin.json`

`{ "<name>": { "sourceVersion": "sha:...", "originHash": "<sha256-of-installed-body>" } }`.

### Telemetry sidecar (P2) — `index.usage.json`

`{ "<name>": { "views": n, "loads": n, "patches": n, "lastSeen": iso, "state": "active|stale|archived" } }`.

### Audit artifact — `REPORT.md`

Timestamped; retro-scan + each curator pass append: counts (pass/quarantine), per-quarantine pattern,
ratifications.

---

## API Contracts

Existing (extended): `GET /api/skills/catalog` (returns facets), `GET /api/skills/:name`,
`POST|PUT|DELETE /api/skills/*` (route through gate), `GET /api/reflections`,
`POST /api/reflections/:projectSlug/:id/confirm` (triggers REFLECTOR-APPLY),
`POST /api/skill-scout/proposals/:itemId/:action`.

New (Phase 1):

```
POST   /api/skills/gate            # submit a skill (create/paste-url) → runs gate → proposal
GET    /api/skill-proposals        # inbox list (gist + status + securityStatus); ?status=pending
GET    /api/skill-proposals/:id    # full proposal incl. unified diff
POST   /api/skill-proposals/:id/ratify   # → trusted + putSkill commit
POST   /api/skill-proposals/:id/reject
POST   /api/skill-proposals/:id/defer
POST   /api/skill-proposals/:id/llm-review   # on-demand Gate-2 (enqueues daemon job)
POST   /api/skills/retro-scan      # one-time batch (admin) → REPORT.md
```

All write routes: zod `.safeParse`, `trusted`-only enforced at install, framework skills read-only.

---

## Security Architecture

- **Provenance class = access control.** `constitutional` read-only to agents; `app-evolved` the only
  agent-writable class; ingested/authored content scanned before the inbox.
- **Two independent gates.** Gate-1 deterministic (`security-scan.ts`) is the **only blocking** gate in
  P1: secret/env exfiltration, destructive shell (`rm -rf`, `aws s3 sync --delete`), non-allowlisted
  network, base64 blobs, package-install-from-URL, prompt-injection tells, over-broad triggers. Gate-2
  LLM is **on-demand** (inbox button → daemon job), advisory only.
- **No execution during scan** — bundled scripts inspected, never run.
- **License gate** — unknown/incompatible license can never reach `trusted`.
- **Bulk (P3)** — source-trust gating; quarantine-by-default; source trust never launders a Gate-1 flag.
- **Secrets** — PAT from SST secret, never logged; honor `out/`→public-bucket prohibition; deploy only
  via `sst deploy`.

## Performance Considerations

- Warehouse never enters a session (carry-on model) — registry size is irrelevant to startup tokens.
- Retrieval: in-memory cosine over `index.embeddings.json` is fine to low-thousands; graph only when
  co-activation edges justify it. Shortlist target: a few seconds for T2.
- Bulk/scan/eval/LLM-review run async as daemon jobs (batched), never blocking interactive use.
- Catalog cache 5-min; busts on write.

## Deployment Architecture

- **API + UI:** `sst deploy` (static export to admin bucket — never the public bucket).
- **Daemon:** SSM Run Command (SSH unreliable). Write daemon files to absolute `/home/ubuntu/...` and
  `chown ubuntu` (SSM runs as root; `~`→`/root` gotcha).
- **Registry repo:** writes via PAT (`futurator-repos`-scoped) through the connector.
- **New DynamoDB table** (`skill-proposals`) provisioned in `sst.config.ts` (PAY_PER_REQUEST + the GSI).

## Development Environment

### Prerequisites

Node 20+, repo deps (`npm install`), daemon deps (`cd daemon && npm install`), AWS creds (deploy),
`VOYAGE_API_KEY` (embeddings/retrieval), GitHub PAT (registry writes).

### Setup Commands

```bash
npm install
npm run dev                # admin app
npm run typecheck && npm run lint && npm run test
node scripts/retro-scan-skills.mjs --dry-run   # P1 retro-scan preview
sst deploy                 # API + UI (never aws s3 sync to public bucket)
```

---

## Architecture Decision Records (ADRs)

- **ADR-1 — One gate, four adapters.** All inbound skills traverse one orchestration. _Alt:_ per-source
  flows (rejected: divergence). _Consequence:_ the gate is the single chokepoint for safety + quality.
- **ADR-2 — `skill-proposals` as a new DynamoDB table.** Durable, queryable inbox. _Alt:_ a `pending/`
  dir in the repo (Hermes-style). _Chosen DynamoDB:_ survives restart, GSI by status, matches the
  one-table-per-concern preference.
- **ADR-3 — App sub-registry in the app repo.** PRD decision. _Alt:_ per-app namespace in the warehouse
  (rejected: pollutes the global trusted set).
- **ADR-4 — Deterministic Gate-1 blocks; LLM Gate-2 on-demand.** Gate-1 must run in Lambda inline and be
  cheap/auditable; LLM review is heavy and operator-launched.
- **ADR-5 — Trusted-only install.** SKILL-SCOUT proposes only `trusted`; `reviewed` is shelf-only. The
  core safety invariant.
- **ADR-6 — Sidecar before graph.** JSON embeddings/usage sidecars first; Memgraph only when
  co-activation edges are dense. _Rationale:_ don't build/operate an empty graph.
- **ADR-7 — Backward-compatible facet extension.** New `index.json` facets are optional, migrated with
  safe defaults — existing resolution keeps working through the transition.

---

_Generated by BMAD Decision Architecture Workflow v1.0 · Date: 2026-06-17 · For: Richie_
