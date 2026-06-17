# Skills Repository — Vision & Converged Design

**Status:** Brainstorming **output** (converged design) · **Date:** 2026-06-17 · **Type:** Concept (not yet a committed implementation plan)
**Purpose:** Capture the converged design from the party-mode brainstorm on making the Futurator
skill registry — and its consumption by the pipeline — the best skills mechanism in existence.
**Companion:** `skills-management-plan.md` (the executed Phase 0–4 build log).

> This doc supersedes the earlier "brainstorming input" version. It records **decisions locked**
> during the 2026-06-17 design session, the **ground truth** the codebase scouts surfaced, and a
> **final build order**. Sections 7–10 are the actionable core.

---

## 0. TL;DR

We are not building a skill _list_. We are building a **compounding skill institution**: skills are
**born from work**, **adapt per-app**, **graduate by cluster**, **retrieve by relevance**, and are
**curated source-then-cluster-then-exception** — all flowing through **one gate** and landing on
**one state machine**.

The key realization: **Futurator already built ~70% of this and disconnected it.** The REFLECTOR is
the "author from experience" loop; the Growth tab is the propose→ratify inbox; `Skills-Used` +
`activationCount` are Phase-1 telemetry; the knowledge compiler → Mycelium is the graph substrate.
Five seams are open. Close them in order and the loop runs.

Guiding law (Rick's, and it governs everything): **storage is free, trust is earned.** The warehouse
may hold thousands of `reviewed` skills (retrieval-gated, harmless); `trusted` grows _only_ through
use + human ratify. Blur those two and you've built a landfill with a search bar.

---

## 1. The reframe — you already built ~70% of Hermes

The Hermes (`nousresearch/hermes-agent`) lifecycle has four moving parts. Futurator already has each
— just disconnected:

| Hermes part                                          | Futurator equivalent (exists today)                                                                                                                             | Status                                         |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Foreground "author from experience"                  | REFLECTOR proposals: `target: 'project-skill'\|'org-skill'`, `action: create\|tune\|promote-from-project`, `confidence`, `evidence[]` (`reflector-pipeline.ts`) | ✅ proposes, ❌ **apply is a stub**            |
| Background curator — **Phase 1** (telemetry, no LLM) | `loaded-skills-tracker.mjs` → `Skills-Used:` trailer; forensic `activationCount`                                                                                | ✅ counts, ❌ no state machine                 |
| Background curator — **Phase 2** (synthesis)         | **Deliberately the human** = the Growth inbox (`growth-view.tsx`)                                                                                               | ✅ by design                                   |
| Propose-to-inbox / ratify-to-deploy                  | Growth tab approve/decline reflections                                                                                                                          | ✅ exists (ratify-on-content, not yet on-diff) |
| Graph substrate                                      | Knowledge compiler → Memgraph/Mycelium (`graph-sync.mjs`, `knowledge-live/<projectId>/`)                                                                        | ✅ for code knowledge                          |

**The five open seams (close in build order):**

1. **`REFLECTOR-APPLY` is a STUB** (`reflections-service.ts:76–81`). Approving a `project-skill`
   proposal writes _nothing_. The loop has no landing zone. **This is the highest-value fix.**
2. **Retrieval is unwired.** `index.embeddings.json` (voyage-3, 1024-dim) is **write-only**; the
   scout linearly scans all ~245 descriptions. (`federation-resolver.mjs` reads only `index.json`.)
3. **No app sub-registry tier.** The manifest's `plans:` overlay + `graduate-policy` exist in schema
   but are never populated. App-adapted skills have no defined home or lifecycle.
4. **Provenance is binary** — `framework: true` (bmad, read-only) vs everything else. The Hermes
   "binary provenance is too dumb" trap.
5. **No Phase-1 state machine** — counts exist, but nothing transitions a skill to stale/archive; no
   snapshot-before-write, no `REPORT.md`.

---

## 2. Where we are today (built & shipped)

| Phase | What                                                            | State    |
| ----- | --------------------------------------------------------------- | -------- |
| 0     | Reconcile + wire federation (on-disk == manifest == federation) | ✅ live  |
| 1     | Read-only catalog + search + drift view (`/labs/skills`)        | ✅ live  |
| 2     | Authoring CRUD (add/edit/remove → commit to `futurator-skills`) | ✅ live  |
| 3     | Federation source CRUD                                          | ⏸ parked |
| 4     | Scale the registry (245 skills + embeddings sidecar)            | ✅ live  |

**The 245 are unverified.** `scripts/ingest-skills.mjs` `git clone`s 7 curated repos and **dumps
bodies straight into the registry with zero scanning or grading.** index.json carries 7 fields
(`name, kind, framework, version, license, description, provenance?`) — **no quality / trust / security
fields.** So "245 curated skills" is really "245 _unverified_ skills wearing a curated badge." The
retro-scan (build step 2) fixes this.

---

## 3. Core architecture — the two-tier registry

**Why retrieval is mandatory at scale:** Claude loads every available skill's name+description at
startup (~100 tokens each).

| Skills loaded | Startup token cost | Selection quality                                           |
| ------------- | ------------------ | ----------------------------------------------------------- |
| 59            | ~6k                | fine                                                        |
| 300           | ~30k               | degrading (model _satisfices_, grabs first plausible match) |
| 1,000         | ~100k              | broken (window is mostly a skill menu)                      |

So you **never** load the warehouse into a session. Two tiers + a bridge:

- **Tier 0 — global warehouse** (`futurator-repos/futurator-skills`): hundreds/thousands of skills,
  never fully loaded. The scout proposes **only `trusted`**; the browsable shelf includes `reviewed`.
- **Tier 1 — app sub-registry** (**DECISION: lives in the app's own repo** `.claude/skills/` + a
  per-app embeddings sidecar): skills adapted to _that app's_ specifics. When a plan adapts a global
  skill, it **forks into an app-local variant** whose origin-hash diverges from upstream — and that
  divergence means it is now **owned by the app and never stomped by an upstream pull** (Hermes
  origin-hash pattern). The scout resolves **app sub-registry first** (app-optimized beats generic),
  **global warehouse second** via retrieval.
- **SKILL-SCOUT — retrieval bridge** (T1 init / T2 pre-PM / T3 brownfield): given plan intent,
  queries embeddings (filter → top-k → rerank → shortlist) and proposes from the shortlist.

Mental model unchanged: **registry = warehouse, app `.claude/skills/` = carry-on, scout = the bridge.**

---

## 4. The one gate (ingestion / promotion pipeline)

Every skill that enters or is promoted into the curated registry runs the **same** pipeline. Four
entry adapters, one orchestration, one exit. _Build it once; everything reuses it._

```
ENTER:  paste-URL │ create-in-UI │ reflector-propose │ app-graduate │ bulk-crawl
   ↓
[1] MERGE   — cosine near-dup check vs registry; offer "merge into canonical" not a new entry
[2] SCAN    — Gate 1 deterministic (BLOCKING, auto-quarantine) → Gate 2 LLM security (ADVISORY)
[3] GRADE   — structure (deterministic) + triggering eval (daemon job) + tune-frequency anti-signal
[4] LABEL   — provenanceClass / securityStatus / qualityGrade / trustTier=draft / capabilityTags
[5] VERSION — semver bump + changelog (git-derived from ratified diff) + lineage stamp
   ↓
REGISTRY GROWTH INBOX  →  human ratify (on diff, not document)  →  trustTier:trusted  →  registry
```

**Two Growth surfaces — do not conflate:**

- **Plan Growth tab** (exists, `growth-view.tsx`) — _per-app, observational_: skills used, reflector
  lessons, knowledge coverage. The **telescope**.
- **Registry Growth section** (new, in `/labs/skills`) — _global, curative_: every proposal to change
  the curated registry queues here (reflector, gate, deterministic job, manual URL paste). The
  **inbox** — the human synthesis seat.

**Division of authority (the principle that keeps it honest):**
the **system owns** the facets that must not lie (`provenanceClass`, `securityStatus`, `qualityGrade`,
`maturity`); the **human owns** the one that confers authority (`trustTier`). Auto-grade, human-trust.

---

## 5. The skill lifecycle — one state machine

Every mechanism in this doc is a transition on this machine:

```
        ingest / crawl / create / reflect
                  │
                  ▼
   unverified ──[Gate-1 scan]──► quarantined ──► Growth inbox (flagged)
        │
   [clean + struct + source-trust (C)]
        │
        ▼
     reviewed ──[cluster-ratify (B)]──► trusted ──[scout proposes]──► installed (app)
        │                                  │                              │
   [lazy eval on first use]           [supersededBy]                [adapt in plan]
        │                                  ▼                              ▼
      graded                          deprecated                   app-evolved (Tier 1)
                                                                         │
                                                          [reflector: non-obvious signal]
                                                                         │
                                                          [graduate across ≥2 plans → the gate]
                                                                         ▼
                                                                back to inbox → trusted
```

`reviewed` buys **visibility, not authority** — `reviewed` skills are browsable/searchable but **the
scout still only proposes `trusted`.** They're on the shelf, not in the cart.

---

## 6. Provenance, labeling, versioning

**Provenance classes = the security boundary** (not metadata — the access-control model):

| Class            | Writable by agents?                | Sync behavior                                               |
| ---------------- | ---------------------------------- | ----------------------------------------------------------- |
| `constitutional` | **No** (read-only / pin-protected) | hand-authored, origin-hashed                                |
| `vendored`       | No                                 | origin-hashed; auto-pull upstream **unless adapted**        |
| `app-evolved`    | **Yes — the only writable class**  | app-owned; the reflector's output; **scanned before inbox** |
| `third-party`    | No                                 | ingested/crawled; quarantine-by-default until gated         |

**Labeling schema (controlled facets, not freeform tags):**

| Facet              | Values                                                | Who sets it               |
| ------------------ | ----------------------------------------------------- | ------------------------- |
| `kind`             | core/frontend/security/workflow/media/marketing…      | author / ingest           |
| `capabilityTags[]` | searchable controlled vocab                           | author + reflector        |
| `provenanceClass`  | constitutional / vendored / app-evolved / third-party | **system** (origin-hash)  |
| `securityStatus`   | clean / flagged / quarantined                         | **scanner**               |
| `qualityGrade`     | A–F (or 0–100), or `ungraded`                         | **eval, computed (lazy)** |
| `trustTier`        | draft → reviewed → trusted → deprecated               | **human ratify**          |
| `maturity`         | usage-derived                                         | **telemetry (Phase 1)**   |

**Versioning = lineage + git-derived ratified-diff history.** No parallel semver bureaucracy. Surface
a thin per-skill record: `version`, `lineage` (`adaptedFrom: global/<skill>@v1`,
`graduatedFrom: <appId>@<plan>`), and a **changelog generated from the ratified diffs** the inbox
already approves. A skill's "growth" _is_ its commit history; we only surface it.

---

## 7. The four resolved design questions

### 7.1 Retrieval — timing & mechanism

Bulk acquisition (§7.4) promotes retrieval from "someday" to **prerequisite**. Mechanism:
**two-stage**: (1) cheap **metadata filter** (`trustTier=trusted`, provenance, app-sub-registry
first) cuts thousands → hundreds; (2) **hybrid top-k** (keyword/BM25 ⊕ vector — skill triggers are
keyword-dense) → rerank → shortlist. **JSON sidecar now** (~40 MB at 3k vectors fits Lambda memory;
the Voyage helper `daemon/scripts/lib/voyage-embed.mjs` already exists); **Memgraph when edges exist**
(§7.2). The trust ladder _is_ the first retrieval gate — never vector-search the raw pile.

### 7.2 The Mycelium handoff

**Code-knowledge and skill-knowledge are the same graph** — the moat. Skills become first-class
Mycelium nodes beside code articles; edges write themselves: `ADAPTED_FROM` (lineage),
`CO_ACTIVATED_WITH` (from `skill_activated`), `USED_IN`, `SUPERSEDES` (merge), `TRIGGERED_BY`
(capability). Then retrieval upgrades from "nearest vector" to "nearest vector → expand to
co-activated neighbors," and **community detection** clusters near-dupes (the curation engine §7.4
needs). **Telemetry-gated:** sidecar until co-activation edges are dense enough to traverse — don't
build an empty graph.

### 7.3 The reflector trigger — "task done _and_ something non-obvious happened"

Don't add intelligence — add a **Phase-1 filter** that gates _whether the reflector's skill-proposal
pass even runs_. Every signal it needs is already emitted:

- **Error-recovery** → `fix-cycles` / retries (failed-then-passed).
- **Correction** → QA **send-back** (the existing send-back-vs-accept remediation model).
- **Novelty** → a manifest `gap`, or a skill used that wasn't pinned (Skills-Used vs manifest drift).
- **Verbatim success** → passed first try following existing skills → **suppress. No proposal.**

Trigger = `(existing time/rigor gate) AND (Phase-1 non-obvious signal)`. Murat's escalation:
high **tune-frequency** on one skill = "something non-obvious keeps happening _here_" → escalate that
skill to the human inbox as a structural problem, not another patch.

### 7.4 Bulk acquisition from the open web (the keystone)

**Curate sources, not skills.** Stand up a **Source Registry** — every site/repo with a **per-source
trust rating + license**. Source trust pre-weights everything downstream. Pipeline:

```
Source Registry (per-source trust + license)
   → CRAWL (Firecrawl → LLM-ready markdown)
   → EXTRACT/NORMALIZE (agentic): reformat blog posts / gists / prompts INTO rubric-shaped SKILL.md
        (this is the agentic Skill Builder in "ingest mode" — create-from-URL == create-from-chat)
   → THE ONE GATE (merge → scan → grade → label → version)
   → TIERED AUTO-DISPOSITION (the scout's rigor matrix, applied to ingestion):
        low-trust + dup + security-flag      → auto-REJECT (never reaches inbox)
        high-trust + unique + clean + struct → auto-REVIEWED (shelf, not scout-reachable)
        ambiguous middle                     → Growth INBOX (human)
```

**Curate by cluster, not by item.** Embed all candidates → community-detect → human reviews the
**cluster**, ratifies the **canonical representative**, deprecates the rest (`supersededBy`).
~3,000 candidates → ~200 decisions → a deduped canonical `trusted` set as a byproduct.

**Security at scale (non-negotiable):** thousands of untrusted URLs = the largest injection surface
you'll open. Source-trust gating; **Gate-1 deterministic scan on every candidate before the inbox**;
quarantine-by-default for unknown sources; **never auto-execute a bundled script — sandbox-inspect
only**; unknown license → can never reach `trusted`. Source trust accelerates the _clean_ path; it
**never launders a flag**.

**Curation unit (DECISION): B primary, C accelerator, A exception.**

- **(C) per-source** fills the shelf: approve a high-trust source once → its clean/unique/struct-pass
  skills auto-admit as `reviewed`.
- **(B) per-cluster** promotes to trusted: ratify the canonical per cluster → `trusted`, rest
  `deprecated`. The only `reviewed → trusted` path; produces the canonical set as a byproduct.
- **(A) per-skill** is the exception lane: anything Gate-1 flags, any bundled executable script, any
  unknown-license skill — individual review, always, regardless of source trust.

---

## 8. The Phase-1 / Phase-2 boundary (the scaling principle)

This resolves "how do I scale past hand-reading every journal":

- **Phase 1 — mechanical, no model.** `activationCount`, `Skills-Used` tallies, staleness thresholds,
  non-obvious-signal counters, near-dup clustering. Counting across every journal — "this skill fired
  14× across dev and QA this month" — is **telemetry, not cognition. Principle-safe. This is what
  scales.**
- **Phase 2 — cognition.** Reasoning over the aggregate to synthesize a merge or promotion. Futurator
  **routes this to the human** (the Growth inbox). That is the one deliberate divergence from Hermes:
  _adopt their mechanical substrate wholesale; replace their meta-agent's brain with your inbox._

Rule: **counting is automated; synthesis is ratified.** Never cross the line by feeding the tallies to
an agent that reads multiple journals and writes the synthesis.

---

## 9. Decisions locked (2026-06-17 session)

1. App-evolved skills **live in the app's own repo** (`.claude/skills/` + per-app sidecar).
2. **Two Growth surfaces**: plan telescope (exists) + registry curation inbox (new).
3. **One ingestion/promotion gate**, 4 entry adapters: merge → scan → grade → label → version → inbox.
4. **System owns** provenance/security/grade/maturity; **human owns** trust. Auto-grade, human-trust.
5. **Versioning = lineage + git-derived ratified-diff history.** No parallel semver system.
6. **Curated registry = `trusted`-only**; `reviewed` is browsable but not scout-reachable.
7. **Incumbent 245**: retro-scan Gate-1 → auto-`reviewed` (pass) / `quarantined` (fail) + `REPORT.md`.
8. **Curation unit at scale: B (per-cluster) primary, C (per-source) accelerator, A (per-skill) exception.**
9. **Retrieval**: two-stage (metadata filter → hybrid top-k → rerank); sidecar now, graph later.
10. **Reflector trigger**: gate skill-proposals on a Phase-1 non-obvious signal; verbatim success → silence.
11. **Mycelium**: skills become graph nodes once co-activation edges are dense; code+skill = one graph.
12. **Phase-1 mechanical / Phase-2 human** boundary is the scaling + principle line.
13. **Lazy grading**: don't run 245 evals upfront; a skill earns a grade on first real use/proposal.
14. **Security**: scan-before-inbox, two independent gates (deterministic blocking + LLM advisory);
    provenance class is the access-control boundary.

---

## 10. Final build order

1. **`REFLECTOR-APPLY`** (`target: project-skill`) → write app-evolved skill into the app repo. _Closes the dead loop._
2. **Retro-scan Gate-1 over the 245** → `reviewed`/`quarantined` + `REPORT.md`.
3. **Registry Growth inbox + the one gate** (merge→scan→grade→label→version), 4 entry adapters.
4. **Phase-1 telemetry state machine** (usage → stale/archive; snapshot-before-write). Also powers the reflector non-obvious trigger.
5. **Provenance classes + origin-hash** → app sub-registry as a real tier.
6. **Retrieval wiring** (trust-filter → hybrid top-k → rerank). _Now mandatory — bulk depends on it._
7. **Bulk acquisition** — Source Registry + Firecrawl crawl + agentic extract-to-rubric → the gate → tiered auto-disposition → curate-by-cluster (B/C/A).
8. **Mycelium handoff** — skills as graph nodes once co-activation edges are dense → graph retrieval + community-driven dedup.

---

## 11. The flywheel

```
ingest/crawl → normalize → scan → grade → label → curate(cluster) → retrieve → use
     → reflect (non-obvious) → adapt per-app → graduate(≥2 plans) → ratify → re-enter as trusted
```

A small, high-quality, well-retrieved **canonical** `trusted` set, backed by a large `reviewed`
warehouse. The registry doesn't just hold skills — **it compounds them.**

---

## 12. Remaining open questions

1. **Agentic Skill Builder UX** — the interview/extract engine (BMAD elicitation ⊕ skill-creator eval
   loop). Same engine for create-from-chat and create-from-URL. Not yet designed.
2. **Mycelium-as-product** — how the `trusted` set + co-activation graph becomes an external Futurator
   offering.
3. **Ratify-on-diff** — the Growth inbox should show a one-line gist for triage and a unified diff for
   the decision (you ratify a delta, not a document). Currently ratify-on-content.
4. **Source Registry trust model** — how third-party-license skills and operator-authored skills
   coexist in one trust ladder.

---

## 13. Pointers

**Ground truth (code, 2026-06-17 scout pass):**

- Scout: `daemon/pipelines/skill-scout-runner.mjs` (rigor disposition), `functions/shared/prompts/skill-scout-prompt.ts`, accept route `functions/api/index.ts` (`/api/skill-scout/proposals/:itemId/:action`).
- Federation resolver: `daemon/lib/federation-resolver.mjs` (reads `index.json` only — **no embeddings**).
- Manifest: `functions/shared/schemas/project-skill-manifest-schema.ts` (has unused `plans:` overlay + `graduate-policy`), `daemon/lib/app-bootstrap-steps/reconcile-skills-manifest.mjs`, `daemon/pipelines/skill-installer.mjs`.
- Usage: `daemon/lib/loaded-skills-tracker.mjs` → `Skills-Used:` trailer (`functions/shared/pipelines/commit-metadata.ts`); forensic `activationCount` (`functions/shared/timer/forensic-builder.ts`).
- Reflector: `functions/shared/pipelines/reflector-pipeline.ts` (`target: project-skill`, `confidence`, `evidence[]`), `daemon/pipelines/reflector-runner.mjs`, `daemon/lib/reflector-scheduler.mjs`, `functions/shared/types/reflection.ts`; **apply stub** `reflections-service.ts:76–81`.
- Growth UI: `src/components/labs/plan-dashboard/views/growth-view.tsx`.
- Knowledge compiler → Mycelium: `functions/shared/pipelines/wave-compile-pipeline.ts`, `daemon/.../graph-sync.mjs`, S3 `knowledge-live/<projectId>/`.
- Registry: `functions/shared/skill-catalog.ts`, `functions/shared/skill-authoring.ts`, `scripts/ingest-skills.mjs`, repo `github.com/futurator-repos/futurator-skills` (`index.json`, `index.embeddings.json`, `skills/<name>/SKILL.md`).

**External:**

- Hermes: `github.com/nousresearch/hermes-agent` (lifecycle, curator phase boundary, origin-hash provenance, propose/ratify inbox).
- BMAD builder (in-repo): `bmad/bmb/agents/bmad-builder.md`, `bmad/bmb/workflows/{create,edit,audit}-*`.
- skill-creator: `github.com/anthropics/skills/tree/main/skills/skill-creator`.
- Anthropic guide: _The Complete Guide to Building Skills for Claude_ (PDF).
- Blog: `firecrawl.dev/blog/best-claude-code-skills`.
- Build log: `docs/concepts/skills-management/skills-management-plan.md`.
