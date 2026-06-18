# Skills Institution — Phase 1 Epics & Stories

**Author:** Richie · **Date:** 2026-06-17 · **Version:** 1.0
**Inputs:** `skills-institution-prd.md` (FRs), `skills-institution-architecture.md` (components, contracts),
`skills-institution-ux.md` (surfaces).
**Scope:** **Phase 1 only** — close the loop, safely. Phases 2–3 remain at epic level in the PRD.
**Goal:** prove success criterion #1 (a plan-_N_ lesson improves a later plan, hands-off except ratify)
while guaranteeing no unvetted skill reaches an app.

> Story format follows the repo convention (`docs/stories/*`). These specs are detailed enough to
> implement directly; split into individual story files only if a sprint needs it.

---

## Epic & Story Map

| Epic   | Theme                                         | FRs           | Stories |
| ------ | --------------------------------------------- | ------------- | ------- |
| **E1** | Authoring from Experience (`REFLECTOR-APPLY`) | FR1           | 1.1–1.4 |
| **E2** | The Gate + Security                           | FR2, FR3, FR5 | 2.1–2.5 |
| **E3** | Curation Inbox + Manual Growth                | FR4, FR8      | 3.1–3.5 |
| **E4** | Registry Integrity                            | FR6, FR7      | 4.1–4.4 |

### Suggested sequence (dependency-ordered)

1. **2.1** (extended index schema) — foundational; unblocks E2/E3/E4.
2. **2.2** (Gate-1 scanner) — needed by 1.x, 3.x, 4.1.
3. **E1** (1.1→1.4) — closes the loop; highest value.
4. **2.3, 2.4** (gate orchestration + dedup), then **E3** (inbox + manual growth).
5. **4.1** (retro-scan), **4.2** (trusted-only), **4.3/4.4** (browse labels + migration).
6. **2.5** (on-demand LLM review) — independent, any time after 3.x.

---

## Epic E1 — Authoring from Experience (`REFLECTOR-APPLY`)

_Gives the existing reflector loop a landing zone. Closes success criterion #1._

### Story 1.1 — Author a NEW app-evolved skill from a ratified reflection

> **Sanity-check correction (2026-06-17):** `daemon/pipelines/reflector-apply.mjs` **already exists**
> (Epic 6, 2026-05-20) and is NOT a stub. Its `applyProjectSkillProposal()` currently **installs an
> existing federation skill by `skillName`** (manifest add + `vendor-skills` fetch from GitHub) — it
> **cannot author a new skill from the reflection's `content`.** That authoring path is the real gap,
> so this story EXTENDS the existing module rather than creating it.

**As a** curator, **I want** a ratified `project-skill` reflection with `action: create` to author a
**new** app-evolved skill from its `content`, **so that** a lesson becomes a brand-new skill the next
run can use (not just an install of a pre-existing one).

**Acceptance Criteria**

1. Extend `reflector-apply.mjs::applyProjectSkillProposal()`: when `action: create` and `skillName` is
   not an existing federation skill, write `<app>/.claude/skills/<skillName>/SKILL.md` (frontmatter
   `name` + `description`; body from `content`), add the manifest entry, and commit with the existing
   trailers (`Skills-Changed:`, `Agent: REFLECTOR-APPLY`).
2. `action: tune` updates the existing skill's targeted section; `action: promote-from-project` stages a
   **global** `skill-proposals` row (E3) instead of writing the app.
3. The existing install-by-name path (federation skill) is preserved unchanged.
4. Write is atomic: a failed commit leaves no partial file and surfaces an error.

**Tasks**

- [ ] Extend `applyProjectSkillProposal()` with the author-from-content branch (reuse the app-repo
      commit path already in the module).
- [ ] Route `action: tune` / `promote-from-project` (promote → depends on 3.1).
- [ ] Unit tests: create-new / tune / promote / install-existing-still-works / atomic-failure.

### Story 1.2 — Verify confirm→apply wiring + fix the stale stub comment

> **Sanity-check correction (2026-06-17):** the confirm→apply wiring **already exists** —
> `POST /api/reflections/:projectSlug/:id/confirm` flips status; the daemon picks up `status: confirmed`
> out-of-band and runs `reflector-apply`. This story is now mostly **verification**, not new wiring.

**As a** curator, **I want** confirming a `create` reflection to reach the new authoring path, **so
that** the loop closes for newly-authored skills.

**Acceptance Criteria**

1. A confirmed `target: project-skill, action: create` reflection is routed by the daemon poll to Story
   1.1's authoring branch (verified end-to-end).
2. The stale comment in `functions/shared/services/reflections-service.ts:76–81` (claims "stub today")
   is corrected — apply was implemented in Epic 6.
3. Status transitions only after a successful apply; failure leaves it `pending` with an error surfaced.

**Tasks**

- [ ] E2E test: confirm a `create` reflection → new SKILL.md on disk in the app repo.
- [ ] Fix the stale `reflections-service.ts` comment. [ ] Failure/rollback handling.

### Story 1.3 — Gate-1 scan before commit

**As a** curator, **I want** every applied skill scanned first, **so that** a malicious reflection can't
write executable instructions into an app.

**Acceptance Criteria**

1. `reflector-apply` runs Gate-1 (`security-scan.ts`, Story 2.2) on the body **before** commit.
2. A flagged body is **not** committed; the reflection is marked quarantined/flagged and surfaced.
3. The scan result (`securityStatus` + pattern hits) is recorded on the reflection.

**Tasks**

- [ ] Integrate `security-scan` into the apply path. [ ] Tests for clean + flagged.

### Story 1.4 — Loop verification surface

**As a** curator, **I want** to see that an applied skill was actually used by a later plan, **so that**
I can confirm the loop closed.

**Acceptance Criteria**

1. The plan Growth tab shows applied app-evolved skills and, on a subsequent plan, their appearance in
   `Skills-Used:` (reuse forensic `activationCount`).
2. Success criterion #1 is demonstrable end-to-end on one app.

**Tasks**

- [ ] Surface app-evolved provenance in growth-view. [ ] E2E walkthrough doc/test.

---

## Epic E2 — The Gate + Security

_Build the one gate once; everything reuses it._

### Story 2.1 — Extended `index.json` entry schema + migration

**As a** developer, **I want** skill entries to carry trust/security/provenance facets, **so that** the
registry can be curated and filtered.

**Acceptance Criteria**

1. New `functions/shared/schemas/skill-index-entry-schema.ts` (zod) adds optional `provenanceClass`,
   `securityStatus`, `qualityGrade`, `trustTier`, `maturity`, `lineage` (shapes per architecture §Data).
2. `skill-catalog.ts` `CatalogSkill` and `skill-authoring.ts` read/write the facets; backward-compatible
   (missing facets default safely; `securityStatus` null → treated as `unverified`).
3. A migration stamps existing entries with safe defaults without breaking federation resolution.

**Tasks**

- [ ] Zod schema + types. [ ] Extend catalog/authoring read+write. [ ] Migration + tests (round-trip).

### Story 2.2 — Gate-1 deterministic security scanner

**As a** curator, **I want** a deterministic dangerous-pattern scan, **so that** obvious malicious skills
are auto-quarantined before I ever see them.

**Acceptance Criteria**

1. `functions/shared/skill-gate/security-scan.ts` scans body + any bundled scripts; returns
   `{ securityStatus, patternsHit[] }`.
2. Detects (blocking): secret/env exfiltration, destructive shell (`rm -rf`, `aws s3 sync --delete`),
   non-allowlisted network calls, base64 blobs, package-install-from-URL, prompt-injection tells,
   over-broad always-trigger directives.
3. Pure function, importable by both Lambda and daemon; never executes content.

**Tasks**

- [ ] Pattern table + matcher. [ ] Allowlist config. [ ] Extensive unit tests (true/false positives).

### Story 2.3 — Gate orchestration (merge → scan → label → version)

**As a** developer, **I want** one gate pipeline with entry adapters, **so that** reflect/create/paste
all converge on one safe path.

**Acceptance Criteria**

1. `functions/shared/skill-gate/index.ts` runs `merge → scan → label → version → emit proposal`.
2. Entry adapters: `reflect` (1.x), `create` + `paste-url` (3.4). All produce a `skill-proposals` row.
3. Grading deferred — proposals emit `qualityGrade: ungraded`. Versioning stamps `lineage`.
4. A Gate-1 failure yields `securityStatus: quarantined` and a flagged (non-ratifiable) proposal.

**Tasks**

- [ ] Orchestration + adapter interface. [ ] Labeling (`labeling.ts`). [ ] Tests per adapter.

### Story 2.4 — Dedup / merge step

**As a** curator, **I want** near-duplicates flagged at the gate, **so that** I don't accumulate 40
copies of "write good tests."

**Acceptance Criteria**

1. `skill-gate/dedup.ts` computes similarity vs existing entries (cosine over `index.embeddings.json` if
   present; else name/description heuristic).
2. On match ≥ threshold, the proposal is annotated "possible duplicate of X" and offers merge-into-canonical.
3. Threshold configurable; no auto-merge in Phase 1 (operator decides).

**Tasks**

- [ ] Similarity util. [ ] Annotate proposal. [ ] Tests.

### Story 2.5 — On-demand Gate-2 LLM review

**As a** curator, **I want** a button to run a deeper LLM security/quality review, **so that** I can
escalate a suspicious proposal without it blocking the queue.

**Acceptance Criteria**

1. `POST /api/skill-proposals/:id/llm-review` enqueues a `skill-gate-job` (daemon) reusing the Claude job
   runner.
2. The verdict attaches to the proposal as **advisory** (`llmReview`); never auto-admits, never blocks
   ratify.
3. UI shows an `LlmReviewPanel` when present.

**Tasks**

- [ ] Daemon job + prompt. [ ] Endpoint + storage. [ ] UI panel.

---

## Epic E3 — Curation Inbox + Manual Growth

### Story 3.1 — `skill-proposals` table + repository

**As a** developer, **I want** a durable inbox store, **so that** proposals survive restarts and are
queryable by status.

**Acceptance Criteria**

1. New DynamoDB table `skill-proposals` in `sst.config.ts` (PK `proposalId`, GSI `status-createdAt-index`,
   PAY_PER_REQUEST).
2. `functions/shared/repositories/skill-proposals-repository.ts` (pure functions: put/get/listByStatus/
   updateStatus) + `skill-proposal-schema.ts` (zod, shape per architecture §Data).

**Tasks**

- [ ] SST table. [ ] Repository + schema. [ ] Tests.

### Story 3.2 — Inbox API routes

**As a** curator, **I want** endpoints to list/inspect/ratify proposals, **so that** the UI can drive
curation.

**Acceptance Criteria**

1. `GET /api/skill-proposals?status=`, `GET /api/skill-proposals/:id` (incl. computed unified diff vs
   current registry body).
2. `POST /api/skill-proposals/:id/{ratify|reject|defer}`; ratify on a `quarantined` item requires an
   explicit `override` flag.
3. `POST /api/skills/gate` (create/paste-url submit). All zod-validated; framework skills read-only.

**Tasks**

- [ ] Routes in `functions/api/index.ts`. [ ] Diff computation. [ ] Tests + cache-bust on ratify.

### Story 3.3 — Growth inbox UI

**As a** curator, **I want** a code-review-style queue, **so that** I can triage on gists and decide on
diffs fast.

**Acceptance Criteria**

1. Route under `src/app/labs/skills/growth-inbox/`; `ProposalRow` list (gist + `TrustBadge`/`SecurityBadge`).
2. Drawer with `SkillDiffViewer` + facets + ratify/reject/defer; quarantined → ratify disabled until
   override confirm.
3. Keyboard model: `j/k/Enter/a/x/d/r`. Uses `@/components/ui` only (Labs consistency).

**Tasks**

- [ ] `ProposalRow`, `SkillDiffViewer`, badges, drawer. [ ] Hooks to 3.2. [ ] Keyboard handlers.

### Story 3.4 — Manual create / paste-URL adapters

**As a** curator, **I want** to add a skill by writing it or pasting a URL, **so that** I can grow the
registry by hand through the gate.

**Acceptance Criteria**

1. **+ Add skill** → inline editor or URL field → `POST /api/skills/gate`.
2. Paste-URL fetches + extracts to SKILL.md shape (minimal extraction in P1; agentic Builder is P3).
3. Both land in the inbox as `draft`; reach `trusted` only via ratify (3.5).

**Tasks**

- [ ] UI add-flow. [ ] URL fetch+extract. [ ] Wire to gate.

### Story 3.5 — Ratify → commit to registry

**As a** curator, **I want** ratifying a proposal to publish it, **so that** the skill becomes `trusted`
and available.

**Acceptance Criteria**

1. Ratify sets `trustTier: trusted` and calls `skill-authoring.putSkill()` (body + index entry with
   facets) → commit to `futurator-skills`.
2. Records `ratifiedBy`/`ratifiedAt`; appends to `REPORT.md`. Busts the catalog cache.

**Tasks**

- [ ] Ratify handler → putSkill. [ ] Audit append. [ ] Tests.

---

## Epic E4 — Registry Integrity

### Story 4.1 — Retro-scan the 245 incumbents

**As a** curator, **I want** the existing 245 skills scanned and labeled, **so that** none wears a
"curated" badge it didn't earn.

**Acceptance Criteria**

1. `scripts/retro-scan-skills.mjs` runs Gate-1 over every entry → sets `securityStatus` +
   `trustTier` (`reviewed` on pass, `quarantined` on fail).
2. Emits a one-time `REPORT.md` (pass/quarantine counts + per-quarantine pattern).
3. `qualityGrade` stays `ungraded`. Idempotent / re-runnable. Supports `--dry-run`.

**Tasks**

- [ ] Script reusing `security-scan.ts` + authoring. [ ] REPORT writer. [ ] Dry-run + tests.

### Story 4.2 — Trusted-only install enforcement

**As a** platform owner, **I want** the scout to install only `trusted` skills, **so that** no unvetted
skill reaches an app even before Phases 2–3.

**Acceptance Criteria**

1. `skill-installer.mjs` / `federation-resolver.mjs` filter proposals + installs to `trustTier: trusted`.
2. The install path rejects a non-trusted skill even if explicitly requested.
3. `reviewed` skills remain browsable but not installable.

**Tasks**

- [ ] Trust filter in resolver/installer. [ ] Reject path. [ ] Tests.

### Story 4.3 — Registry browse: labels + filters

**As a** curator, **I want** trust/security/provenance visible and filterable, **so that** I know what an
agent will actually get at a glance.

**Acceptance Criteria**

1. Registry table shows `TrustBadge`/`SecurityBadge`/`ProvenanceBadge`; filter chips by trust tier,
   security status, kind, provenance.
2. `trusted` vs `reviewed` are visually separated. Drawer shows facets + lineage.

**Tasks**

- [ ] Badges + filter chips. [ ] Drawer facets panel. [ ] Tests.

### Story 4.4 — Catalog facet exposure + back-grade

**As a** developer, **I want** the catalog API to return facets and existing entries back-filled, **so
that** the UI and scout read consistent data.

**Acceptance Criteria**

1. `GET /api/skills/catalog` + `GET /api/skills/:name` return the new facets.
2. Entries lacking facets are back-graded (default `securityStatus: unverified`, `trustTier: draft`)
   until retro-scan (4.1) upgrades them.

**Tasks**

- [ ] Catalog read of facets. [ ] Back-grade defaults. [ ] Tests.

---

## Phase 1 Definition of Done

- A ratified reflector lesson writes an app skill that a **later plan loads** (criterion #1, demoed).
- **0** non-`trusted` skills installable into any app (criterion #2).
- All 245 incumbents carry a real `securityStatus` + `trustTier`; `REPORT.md` exists (criterion #3).
- The Growth inbox supports gist→diff→ratify with the keyboard; registry browse shows trust at a glance.
- All new code: zod-validated, tested, lint/typecheck clean; API+UI deployed via `sst deploy`, daemon via
  SSM. No regressions to federation/manifest/pipeline.
