# Futurator-Admin — Skills Institution PRD

**Author:** Richie
**Date:** 2026-06-17
**Version:** 1.0 (draft — in progress)
**Source of truth:** `docs/concepts/skills-management/skills-repository-vision.md` (converged design, 16 locked decisions)
**Scope rule:** PRD + architecture at full vision breadth; **only Phase 1 decomposed to stories.**

---

## Executive Summary

Futurator Labs turns plans into shipped apps via an agentic pipeline. Its agents already _use_
skills (procedural SKILL.md knowledge) and already _notice lessons_ (the REFLECTOR) — but those
lessons fall on the floor: the apply path can only **install an existing skill by name** (it can't
author a new skill from a lesson), the registry is an unvetted dump of 245 internet-sourced skills, and
nothing makes a skill **improve from one plan run to the next.**

The Skills Institution closes that loop. Skills become a **compounding asset**: born from real work,
adapted per-app during plan runs, graded and security-scanned through one gate, curated by cluster,
retrieved by relevance, and — only after earning human-ratified trust — promoted back into a global
registry that every future app draws from. The same substrate eventually lets **Mycelium recommend
skills conditioned on a codebase**, which no flat skill list can do.

This is a **brownfield** effort: ~70% of the machinery exists and is disconnected. The PRD specs the
_delta_ — five open seams, one gate, and the lifecycle that ties them together — not the shipped base.

### What Makes This Special

**The registry gets better every time a plan runs — and a human only ever ratifies, never re-authors.**

The "wow": a lesson the pipeline learns fighting flaky tests in App A silently sharpens App B's first
attempt at the same problem, with the operator doing nothing but approving a one-line diff. Skills
**compound** instead of accumulating. The governing law keeps it from rotting: **storage is free,
trust is earned** — the warehouse may hold thousands of `reviewed` skills, but `trusted` (what agents
actually receive) grows only through use plus human ratify. The result is the rare skill system that
is simultaneously _huge_ (retrieval-gated warehouse), _safe_ (every skill scanned, provenance is the
access boundary), and _self-improving_ (the reflector→adapt→graduate→ratify flywheel).

---

## Project Classification

**Technical Type:** Brownfield platform subsystem — agentic pipeline (EC2 daemon) + serverless API (Hono/Lambda) + admin web app (Next.js static export) + Git-backed registry + Memgraph/Mycelium graph.
**Domain:** AI agent infrastructure / internal developer tooling. **Security-sensitive** (executable-instruction skills from the open web are an injection surface), **not regulated**.
**Complexity:** High _design_ complexity (two-tier registry, retrieval, lifecycle state machine, graph handoff) bounded by an existing substrate — most pieces exist and need _connecting_, not inventing.

Single-operator internal factory (not multi-tenant SaaS). Consumers of the system are the pipeline's
own agents (SKILL-SCOUT, DEV, REFLECTOR) and one human curator (the operator).

---

## Success Criteria

Success is **specific and provable from pipeline telemetry**, not vanity counts. Each criterion notes
the phase in which it first becomes measurable.

1. **The loop closes** _(Phase 1 — the core win)._ A lesson the pipeline learns in plan _N_ becomes a
   ratified skill change that is loaded by the agents of a **later** plan on the same app — with the
   operator only **ratifying a diff, never authoring**. _Proof:_ a REFLECTOR `project-skill` proposal,
   once approved, lands in the app's `.claude/skills/` and appears in a subsequent plan's `Skills-Used:`
   commit trailer. Today this is 0% for **newly-authored** skills (apply can only install existing
   federation skills by name; it can't author from a lesson); success = it happens end-to-end at least
   once, then routinely.

2. **No unvetted skill ever reaches an agent** _(Phase 1)._ Nothing is installed into any app unless it
   passed Gate-1 security scan and is `trusted`. _Proof:_ 100% of scout-installed skills are `trusted`;
   **0** `unverified`/`quarantined`/`reviewed` skills ever appear in an app's `.claude/skills/`.

3. **The 245 incumbents are honestly labeled** _(Phase 1)._ After the retro-scan, every registry skill
   carries a real `securityStatus` + `trustTier`; none wears a "curated" badge it didn't earn. _Proof:_
   0 skills with null `securityStatus`; a one-time `REPORT.md` accounts for every pass/quarantine.

4. **Per-app adaptation compounds** _(Phase 2)._ An app that runs multiple plans accumulates
   app-evolved skills the scout prefers over generic global ones (app sub-registry resolves first).
   _Proof:_ app-evolved skills are proposed/loaded in later plans of the same app, and graduate to the
   global registry only via human ratify after proving out across ≥2 plans.

5. **Curation scales sub-linearly** _(Phase 3)._ Operator decisions per 100 ingested skills **trend
   down** as cluster-curation takes over (ratify the canonical, inherit the cluster). _Proof:_
   decisions-per-100-candidates falls as the corpus grows — the operator is never the bottleneck.

6. **Selection stays sharp as the warehouse grows** _(Phase 3)._ Scout proposal relevance does **not**
   degrade as the warehouse crosses hundreds → thousands, because retrieval gates what's considered
   rather than full-scanning descriptions. _Proof:_ proposal accept-rate holds steady while warehouse
   size grows 10×.

**Anti-goals (explicit non-success):** more skills is not the goal — a bloated `trusted` set is a
failure; full automation of _synthesis_ is not the goal — Phase-2 cognition (merge/promote) stays a
human ratify step by design.

---

## Product Scope

Scope follows the build order (vision §10). **Phase 1 is the MVP and the only phase decomposed to
stories now**; Phases 2–3 are specified at epic level and decomposed later.

### MVP — Phase 1: Close the loop, safely (build-steps 1–3 · decomposed to stories)

The minimum that makes skills self-improve **and** makes the registry honest about safety. Proves
success criteria #1, #2, #3.

- **`REFLECTOR-APPLY`** — approving a REFLECTOR `target: project-skill` proposal **writes the skill into
  the app's `.claude/skills/`** (minimal app sub-registry), commits it, so a later plan loads it. _This
  is the single highest-value cut — it gives the existing reflector loop a landing zone._
- **The one gate (minimal path)** — `merge (dedup) → scan (Gate-1 deterministic) → label → inbox →
ratify`. Grading is lazy/deferred; versioning is a lineage stamp. One orchestration, the entry
  adapters that Phase 1 needs (reflect + create + paste-URL).
- **Registry Growth inbox** — the global curation surface in `/labs/skills` where proposals queue and
  are ratified (gist for triage → diff for the decision). Distinct from the existing per-plan Growth
  telescope.
- **Retro-scan the 245** — run Gate-1 over the incumbents → `reviewed`/`quarantined` + a one-time
  `REPORT.md`. Adds `securityStatus` + `trustTier` to every registry entry.

**Phase 1 hard guarantee:** the scout installs **only `trusted`** skills — so even before Phases 2–3,
no unvetted skill can reach an app.

### Growth — Phase 2: Make it scale & robust (build-steps 4–6 · epic level)

- **Phase-1 telemetry state machine** — usage counters → `stale`/`archive` transitions; snapshot-before-write. Powers the reflector's "non-obvious happened" trigger (fix-cycles, QA send-backs, gaps, drift).
- **Provenance classes + origin-hash** — `constitutional` / `vendored` / `app-evolved` / `third-party`; the app sub-registry becomes a real tier whose adaptations are never stomped by upstream.
- **Retrieval wiring** — read-side embeddings: metadata trust-filter → hybrid (keyword⊕vector) top-k → rerank → shortlist. Proves criterion #6’s substrate.

### Vision — Phase 3: Fill & expose (build-steps 7–8 + §7.5–7.6 · epic level)

- **Bulk acquisition** — Source Registry (per-source trust + license) → Firecrawl crawl → agentic extract-to-rubric → the gate → tiered auto-disposition → **curate-by-cluster** (B primary / C accelerator / A exception).
- **Agentic Skill Builder** — one engine, three adapters (chat / URL / reflection); trigger-clause-centered; finishes at "tested," not "drafted." It is the gate's create/ingest adapter.
- **Mycelium handoff & as-product** — skills become graph nodes once co-activation edges are dense → graph retrieval + community-driven dedup; the `trusted` set, retrieved conditioned on a codebase, becomes the external moat.

**Scope discipline:** anything that does not help Phase 1 _close the loop safely_ is deferred. The MVP
deliberately ships a _minimal_ sub-registry and _lazy_ grading — robustness and scale are Phase 2+.

---

## Innovation & Novel Patterns

What makes this more than "a skill folder with a UI":

- **The Phase-1 / Phase-2 governance line** — mechanical _counting/thresholding_ scales without limit
  and stays principle-safe; _synthesis_ (merge, promote) is deliberately reserved for a human ratify
  step. We adopt Hermes's mechanical substrate wholesale and **replace its meta-agent's brain with an
  inbox.** This is the design's spine.
- **App sub-registry with origin-hash forking** — a skill adapted during a plan run forks to an
  app-owned variant whose origin-hash diverges from upstream, so it is **never stomped by an upstream
  pull.** Per-app procedural memory that compounds.
- **The compounding registry (the flywheel)** — lessons → skills → adapt → graduate → ratify → re-enter
  as `trusted`. The registry _improves itself_ from real pipeline work.
- **Code + skill in one graph (Mycelium)** — procedural-knowledge retrieval **conditioned on a
  codebase**, which a flat skill list structurally cannot do. The eventual external moat.

**Validation approach:** prove the flywheel on **one app first** (criterion #1 end-to-end), then
measure scout proposal accept-rate as the warehouse grows. Fallbacks are built in: lazy grading,
sidecar-before-graph, manual paste-URL before bulk crawl.

---

## Platform & Integration Requirements

Brownfield — the Institution extends existing components rather than standing up new infrastructure.
Touchpoints (vision §13 ground truth):

- **Daemon (EC2)** — `reflector-runner.mjs`, `skill-installer.mjs`, `federation-resolver.mjs`,
  `loaded-skills-tracker.mjs`. Homes for `REFLECTOR-APPLY`, the retro-scan, retrieval read-side, and the
  telemetry state machine.
- **API (Hono/Lambda)** — extend `/api/skills*`, `/api/reflections*`, `/api/skill-scout/proposals/*`
  with the gate pipeline and the Registry Growth inbox endpoints (queue / gist / diff / ratify).
- **Registry (Git)** — `futurator-repos/futurator-skills` (`index.json` + `index.embeddings.json` +
  `skills/<name>/SKILL.md`) plus per-app `.claude/skills/`. **`index.json` entry shape must gain the
  labeling facets** (`provenanceClass`, `securityStatus`, `qualityGrade`, `trustTier`, `maturity`,
  `lineage`) — today it has only 7 fields.
- **Graph (Memgraph/Mycelium)** — `graph-sync.mjs`, S3 `knowledge-live/<projectId>/`. Phase-3 consumer
  of `trusted` skills + co-activation edges.
- **Contracts touched** — `project-skill-manifest-schema.ts` (activate the `plans:` overlay +
  `graduate-policy`), `reflection.ts` (already carries `target: project-skill`), `skill-catalog.ts` /
  `skill-authoring.ts` (index entry shape + body CRUD).

---

## Functional Requirements

Organized by **capability**. **Phase-1 FRs carry full acceptance criteria** (they decompose to
stories); Phase 2–3 FRs are summary-level (decomposed later).

### Capability A — Skill Authoring from Experience (Phase 1)

**FR1 — `REFLECTOR-APPLY`.** When the operator ratifies a REFLECTOR proposal with
`target: project-skill`, the system materializes the skill into the target app and closes the loop.

- _AC1:_ `action: create` writes `.claude/skills/<name>/SKILL.md` (name+description+body from the
  proposal) to the app repo and commits with an attributable trailer.
- _AC2:_ `action: tune` updates the existing skill's relevant section; `promote-from-project` stages a
  **global-registry** proposal into the inbox (never writes global directly).
- _AC3:_ The skill passes the Gate-1 security scan (FR3) **before** commit; a flagged proposal cannot
  be applied and is surfaced as quarantined.
- _AC4:_ A later plan run on the same app loads the skill — verifiable in its `Skills-Used:` trailer
  (**this is success criterion #1**).
- _AC5:_ Atomic — a failed commit leaves no partial skill; the reflection stays `pending`.

### Capability B — The Quality & Security Gate (Phase 1)

**FR2 — One gate, minimal path.** Every inbound skill traverses a single pipeline
`merge → scan → label → inbox`. Phase-1 entry adapters: reflect, create, paste-URL.

- _AC1:_ All adapters converge on one orchestration (not per-source code paths).
- _AC2:_ Merge flags near-duplicates (cosine ≥ threshold) and offers merge-into-canonical over a new entry.
- _AC3:_ A skill that fails Gate-1 never reaches the inbox as ratifiable (routed flagged).
- _AC4:_ Grading is deferred — a Phase-1 skill enters the inbox `qualityGrade: ungraded`.

**FR3 — Security scan (Gate-1 deterministic, blocking; Gate-2 LLM, advisory).**

- _AC1:_ Gate-1 detects+blocks: secret/env exfiltration, destructive shell (`rm -rf`,
  `aws s3 sync --delete`), network calls to non-allowlisted hosts, base64 blobs, package-install-from-URL,
  prompt-injection tells, over-broad always-trigger directives.
- _AC2:_ A blocked skill → `securityStatus: quarantined`, routed to the inbox **flagged with the
  triggering pattern** (never silently dropped).
- _AC3:_ Bundled scripts are **inspected, never executed**.
- _AC4:_ Gate-2 LLM reviewer is **optional and operator-launched** — a **"Run LLM review" button** on
  an inbox item runs an on-demand deep security/quality review whose verdict is attached **advisory**;
  it never auto-admits and is never a blocking prerequisite to ratify. (Deterministic Gate-1 is the only
  blocking gate in Phase 1.)

**FR5 — Registry labeling facets.** `index.json` entries gain `provenanceClass`, `securityStatus`,
`qualityGrade`, `trustTier`, `maturity`, `lineage`.

- _AC1:_ Schema extended; existing entries migrated with safe defaults.
- _AC2:_ System-owned facets (provenance/security/grade/maturity) are **not** human-editable; `trustTier`
  is the only human-set facet.
- _AC3:_ Registry browse filters/sorts by `trustTier` and `securityStatus`.

### Capability C — Curation Inbox (Phase 1)

**FR4 — Registry Growth inbox.** Global curation surface: queue of pending proposals, triage by gist,
decide on diff.

- _AC1:_ Lists pending proposals with a one-line **gist** + source + `securityStatus`.
- _AC2:_ Selecting one shows the **unified diff** (the decision unit).
- _AC3:_ **Ratify** sets `trustTier` (→ `trusted` for global; `confirmed` for an app reflection);
  **reject** resolves without applying; **defer** keeps it pending.
- _AC4:_ Quarantined items appear flagged; ratify is blocked until explicit override.
- _AC5:_ Pending proposals survive a restart.

### Capability D — Registry Integrity (Phase 1)

**FR6 — Retro-scan the 245 incumbents.** One-time batch: Gate-1 over all incumbents.

- _AC1:_ Every incumbent gets non-null `securityStatus` + `trustTier` (`reviewed` on pass,
  `quarantined` on fail).
- _AC2:_ Emits a one-time `REPORT.md` (pass/quarantine counts + per-quarantine triggering pattern).
- _AC3:_ `qualityGrade` stays `ungraded` (lazy). _AC4:_ Idempotent / re-runnable.

**FR7 — Trusted-only install guarantee.** SKILL-SCOUT proposes/installs **only** `trustTier: trusted`.

- _AC1:_ Proposal set filtered to `trusted`; `reviewed`/`quarantined`/`unverified` are never proposed.
- _AC2:_ The install path rejects a non-trusted skill even if explicitly requested.
- _AC3:_ `reviewed` skills remain browsable/searchable but not installable.

### Capability E — Manual Growth (Phase 1)

**FR8 — Create / paste-URL adapter.** Operator grows the registry by hand, through the gate.

- _AC1:_ Create-in-UI submits name+description+body to the **gate** (not directly to the registry).
- _AC2:_ Paste-URL fetches + extracts to SKILL.md shape, then through the gate.
- _AC3:_ Both land in the inbox as `draft`; they reach `trusted` only via ratify.

### Phase 2–3 Functional Requirements (summary)

- **FR9 — Telemetry state machine** _(P2)_ — usage counters (view/load/patch) drive `stale`/`archive`
  transitions; snapshot-before-write; powers the reflector "non-obvious happened" trigger.
- **FR10 — Provenance classes + origin-hash** _(P2)_ — four classes; app sub-registry becomes a real
  tier; `vendored` skills auto-sync upstream unless adapted.
- **FR11 — Retrieval read-side** _(P2)_ — trust-filter → hybrid (keyword⊕vector) top-k → rerank →
  shortlist; the scout proposes from the shortlist.
- **FR12 — Bulk acquisition** _(P3)_ — Source Registry (per-source trust + license) → Firecrawl crawl →
  agentic extract-to-rubric → the gate → tiered auto-disposition → **curate-by-cluster (B/C/A)**.
- **FR13 — Agentic Skill Builder** _(P3)_ — one engine, three adapters (chat/URL/reflection);
  trigger-clause-centered; finishes "tested," not "drafted."
- **FR14 — Mycelium handoff & as-product** _(P3)_ — skills as graph nodes once co-activation edges are
  dense; graph retrieval; `trusted`-set export with evidence, app-private lineage stripped at the edge.

---

## Non-Functional Requirements

Only categories that matter for this product. (Accessibility is out of scope — single-operator internal
tool.)

### Security (critical)

- **Provenance is the access-control boundary.** `constitutional` = read-only to agents;
  `app-evolved` = the only agent-writable class; all agent-authored or ingested content is **scanned
  before it can reach the inbox.**
- **Two independent gates** — scanning (auto-quarantine) is separate from ratifying (human). Never
  ratify something Gate-1 should have killed.
- **No execution during scan** — bundled scripts are sandbox-inspected, never run.
- **License integrity** — unknown/incompatible license → can **never** reach `trusted`.
- **Bulk safety (P3)** — source-trust gating; quarantine-by-default for unknown sources; source trust
  accelerates the clean path but **never launders a flag**.
- **Secrets discipline** — PATs/keys never logged or echoed; honor existing deploy-safety constraints
  (deploy via `sst deploy`; never sync `out/` to the public bucket).

### Reliability & Data Integrity

- **Atomic skill writes** — body + index in lockstep (body-last fail-safe, as in `skill-authoring.ts`);
  a failed write leaves no partial/advertised skill.
- **No loss of app procedural memory** — origin-hash forking guarantees an app-evolved skill is **never
  stomped** by an upstream pull. This is the "zero data loss during critical operations" guarantee.
- **Durable inbox** — pending proposals survive daemon/Lambda restarts.
- **Reversible curation** — snapshot-before-write on any curator mutation; a mistaken rollback is itself
  reversible (Hermes pattern). Retro-scan and migrations are idempotent.

### Performance & Scalability

- **The warehouse never enters a session** — agents load only installed (carry-on) skills; warehouse
  size has **zero** effect on session startup tokens.
- **Scales to thousands** — retrieval gates what's considered; scout selection quality must not degrade
  as the warehouse grows 10× (success criterion #6).
- **Retrieval latency** — pre-PM scout shortlist (T2) returns within a few seconds; sidecar cosine in
  Lambda memory is sufficient up to low-thousands before the graph is needed.
- **Bulk is async** — ingestion/scan/grade run as daemon jobs (batched), never blocking interactive use.
- **Catalog cache** — the 5-min Lambda catalog cache sustains the registry UI; busts on write.

### Operability & Deployment (brownfield constraints)

- **Must not break** existing federation resolution, manifest reconciliation, or the running pipeline.
- **Deploy channels** — API + UI via `sst deploy`; daemon via SSM Run Command (SSH unreliable due to
  rotating egress IP); mind the SSM-as-root `~`→`/root` gotcha (write daemon files to absolute
  `/home/ubuntu/...` and `chown ubuntu`).
- **Reuse the daemon job runner** for eval/scan/LLM-review jobs rather than new infrastructure.

### Observability & Audit

- **Derived artifacts** — retro-scan and curator passes emit a timestamped `REPORT.md` (the security/
  curation paper trail).
- **Attributable trust** — every `trustTier` transition records who ratified and when.
- **Durable usage record** — `Skills-Used:` commit trailers remain the source-of-truth usage log;
  Phase-1 telemetry counters are auditable.

---

## User Experience Principles

The system is backend-heavy; the genuine UX surface is **three operator surfaces**, and they must use
the **same Labs UI primitives** (tables/cards/dialogs) — the registry must not "feel like another app."

- **Registry Growth inbox** — feels like a **code-review queue**, not a form. Triage on **one-line
  gists**; decide on a **unified diff** (you ratify a delta, not a document). The trust-conferring
  action is one deliberate, unmistakable click. Fast to clear; safe to clear.
- **Registry browse** — **labels are first-class**: `trustTier`, `securityStatus`, `provenanceClass`
  shown as badges; filter/sort by trust; the curated (`trusted`) set is visually distinct from the
  `reviewed` shelf, so "what an agent will actually get" is obvious at a glance.
- **Skill Builder** — a **conversation, not a form**: the draft grows visibly as you answer; it centers
  on the trigger clause; it ends with a **green test**, not a save button.

**Vibe:** operator-grade — dense, fast, trustworthy. No marketing chrome. Consistency with Labs is a
hard requirement (prior feedback: the skills module "felt like another app").

---

## Implementation Planning

### Epic Breakdown Required

Phase 1 requirements decompose into epics/stories in a later workflow step. Build order (epics) is
pre-seeded from vision doc §10.

---

## References

- Vision / converged design: `docs/concepts/skills-management/skills-repository-vision.md`
- Build log (Phase 0–4): `docs/concepts/skills-management/skills-management-plan.md`
- External: `github.com/nousresearch/hermes-agent`, `github.com/anthropics/skills/.../skill-creator`

---

## Next Steps

1. Architecture — `3-solutioning/architecture` → `skills-institution-architecture.md`
2. UX Design — `2-plan-workflows/create-ux-design` → `skills-institution-ux.md`
3. Epics & stories (Phase 1) — `4-implementation/*` → `epics/`
