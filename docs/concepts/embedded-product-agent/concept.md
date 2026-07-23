# Signal — Embedded Product Agent

> **Status:** Concept / ideation
> **Owner:** Ricardo
> **Last updated:** 2026-06-19
> **Related:** [[agentic-document-center-epics]] · [[dynamic-workflow-orchestration-concept]] · graphify / Mycelium · pm-plan pipeline

---

## 1. Vision

**Signal** is an embedded, conversational product agent that drops into any Futurator-managed
app — greenfield or brownfield, dev/staging/prod — as a single one-line `<script>`. It slides
out from the right edge of the page and lets a real user express **any** intention. Signal
classifies that intention and routes it into one of three lanes:

| Lane             | Intent                | Outcome                                                                                                                  |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| **A — Bug**      | "this is broken"      | Rich evidence captured → enriched → localized → reproduced → (human button) → **`bug-fix` pipeline**                     |
| **B — Feature**  | "I wish it could…"    | Clustered into a per-project backlog → (human button) → **`feature-build` pipeline**                                     |
| **C — Question** | "how do I…/why does…" | Answered live via **graph-traversed RAG** over curated god-docs + code graph; weak answers feed the doc-improvement loop |

Signal is **not** a bug form. It is the **signal-intake organ for the pipeline** — its job is
to capture enough deterministic context that an _agent_ (not a human) can resolve the
intention. A single conversation can spawn more than one typed record (a question that
reveals a defect becomes a bug).

### What makes it different

Commercial widgets (Gleap, Userback, Atlassian, Sentry Seer) stop at "capture a good ticket
and hand it to a human." Signal's moat is that **Futurator owns the pipeline that built the
app, the Memgraph knowledge graph of the code, and the provenance of which plan/epic shipped
each file.** That enables two things no competitor can do:

1. **Graph-traversed localization & Q&A.** GitHub Copilot's own docs concede its codebase
   answers are _"retrieval-based rather than graph-traversed, so the quality depended on how
   well code search ranked files."_ Signal traverses the actual graph — `REFERENCES` edges for
   blast radius, `PROPOSES` edges back to the authoring plan.
2. **Plan provenance.** "Which plan created this bug?" is answerable, because the graph links
   code nodes back to the plan/epic that authored them.

### Guiding principles

- **Human-gated resolution.** Enrichment (dedup, localize, reproduce) runs _automatically_ and
  _before_ the gate, so by the time an operator looks at a bug it already has a root-cause and
  a fix preview. The button only _dispatches_ the run. (Industry consensus: AI enriches /
  prioritizes / routes / suggests; a human confirms before auto-fix.)
- **Service, not feature.** Multi-tenant from day one. Designed to span brownfield apps
  (applicator, debatator, songster, futurator) that may already be live in prod.
- **Progressive capability.** The widget works at Tier 0 on any registered app immediately;
  agentic superpowers light up as the project is migrated → graphed → wired. No re-embed.
- **Deterministic-first.** Cheap, deterministic steps (dedup by embedding, origin/key checks,
  screening) gate the expensive token-spending steps (localize, reproduce, RAG).

---

## 2. Architecture at a glance

```
                       SIGNAL  (one versioned bundle, multi-tenant)
                conversational intent router · rrweb capture · per-project config
                                          │
        ┌──────────────────────────────────┼──────────────────────────────────┐
     LANE A — Bug                       LANE B — Feature                   LANE C — Question
        │                                  │                                  │
 enrich → localize → repro          cluster → backlog                 graph-traversed RAG
        │                                  │                          over god-docs + graph
 [human: "Fix this"]                [human: "Promote"]                        │
        │                                  │                          answer inline (live)
 NEW bug-fix workflow               NEW feature-build workflow                │
 (repro-test-first)                 (spec → design → build)          persist Q&A + confidence
        │                                  │                                  │
        └──── verify (VQA/QA) ─────────────┘                        low-confidence → doc-gap
                   │                                                → feeds Document Center
              deploy → notify reporter                               (self-improving KB)
```

| Layer         | Native slot in Futurator-Admin                                                                                                                                              |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Widget bundle | Standalone tiny bundle, CDN / scoped-S3-path served (`v1/widget.js`), fetches per-project config by publishable key at runtime                                              |
| Tenancy       | Project Registry + onboarding state machine; `projectId` partitions all data; publishable key + origin allowlist guard the public endpoint                                  |
| Intake        | Public `POST /api/public/widget/conversations` (rate-limited, key+origin gated, SCREENED before expensive enrichment) — mirrors `/api/public/projects` public-route pattern |
| Data          | `widget-conversations` (intake organ) → spawns `bug-reports` / `feature-requests`; answered questions logged for the doc-gap loop                                           |
| Resolution    | `bug-fix` + `feature-build` workflows (new daemon job types) · Lane C synchronous RAG                                                                                       |
| Verify/deploy | Reuses existing VQA/QA gates + epic-workflow deploy                                                                                                                         |

---

## 3. Service & multi-tenant architecture

Signal must serve many apps with isolated data. Tenant = **project**.

### 3.1 Project Registry & onboarding state machine

A project must be _loaded into Futurator_ before Signal lights up fully. Capability tiers are
tied to onboarding state, so the widget degrades gracefully and can be dropped on a live
brownfield app today.

```
REGISTERED ──► MIGRATED (repo synced to EC2) ──► GRAPHED (graphify run) ──► LIVE (pipelines wired)
  Tier 0            Tier 1                            Tier 2                     Tier 3
```

| Tier  | Onboarding state               | What works                                                               |
| ----- | ------------------------------ | ------------------------------------------------------------------------ |
| **0** | Embedded, not yet in Futurator | Capture bug/feature/question, store, generic Q&A. No agentic resolution. |
| **1** | Repo migrated to EC2           | + dedup, intent routing, backlog clustering                              |
| **2** | Project graphed                | + **graph-localization**, **curated Q&A (Lane C live)**, auto-repro      |
| **3** | Pipelines wired                | + one-click `bug-fix` dispatch / feature → `feature-build` promotion     |

**Decision (locked):** Tier 0 capture-only on un-migrated apps — degrade gracefully, never
refuse. The widget ships on applicator in prod _day one_; superpowers switch on as it migrates.

### 3.2 Per-project widget credentials

- **Publishable key** — public, embedded in the snippet. Identifies the tenant.
- **Origin allowlist** — registered origins per project. The public submit endpoint accepts a
  conversation only if `(publishableKey, Origin)` matches a registered, **active** project.
  This doubles as the anonymous-prod abuse defense.
- **Per-env capture rules** — verbose capture (full network bodies) in dev/staging, aggressive
  redaction in prod. Env + git SHA + build id stamped on every record.

### 3.3 Versioned, CDN-served bundle

`signal.futurator.ai/v1/widget.js` (or a scoped S3 path). At runtime the bundle fetches
per-project config by publishable key → theming, enabled lanes, capture rules. **One bundle,
every app, zero re-embeds to update.**

### 3.4 Brownfield onboarding flow (e.g. applicator)

```
1. Register applicator in Futurator   → get publishableKey + embed snippet
2. Drop <script> into applicator       → Tier 0: live capture starts in prod NOW
3. Sync repo to EC2 (existing GitHub→EC2 one-way path)  → Tier 1
4. Run graphify on applicator          → Tier 2: localization + curated Q&A live
5. Wire bug-fix + feature-build to applicator's workingDir → Tier 3: one-click resolution
```

Each step is independently valuable and non-blocking.

---

## 4. Data model

One table per concern (never single-table). `projectId` is the tenant partition key on every
record; a `project-status-index` GSI enables per-app, per-status queries.

### 4.1 `signal-conversations` (intake organ)

```
projectId          (tenant partition)
conversationId     (ULID, sortable by time)
environment        dev | staging | prod
status             OPEN | SCREENED | ROUTED | CLOSED
reporter           userId | anonId, email?, consent flags
page               url, route, appVersion, gitSha, buildId
device             browser, OS, viewport, devicePixelRatio, connection
transcript         [{role, text, ts}]            // the chat
detectedIntents    [bug | feature | question]
evidence           { screenshotKey, replayKey, consoleLogKey, networkLogKey }  // S3 pointers
spawned            { bugReportIds[], featureRequestIds[] }
embeddingVector    (or pointer) for dedup
```

### 4.2 `bug-reports` (Lane A spawn)

```
projectId, bugReportId, conversationId (link)
environment, severity (agent-assigned), userFeltSeverity
status   NEW → SCREENED → TRIAGED → DEDUP_MERGED
              | REPRODUCING → FIX_QUEUED → FIXING → IN_VERIFICATION
              → RESOLVED | WONT_FIX | NEEDS_INFO
dedupClusterId        // embedding cluster — links duplicates, holds a count
rootCause             { suspectFiles[], graphNodeIds[], authoringPlanId, epicId }
reproSteps            agent-generated + reproConfidence
proposedFix           { summary, diffPreview, confidence }
fixJobId              // link to bug-fix workflow job
```

### 4.3 `feature-requests` (Lane B spawn)

```
projectId, featureRequestId, conversationId (link)
status   NEW → SCREENED → CLUSTERED → BACKLOG → PROMOTED → BUILDING → DELIVERED | DECLINED
clusterId             // similar requests merge, hold a demand count (priority signal)
summary, userValue, embeddingVector
buildJobId            // link to feature-build workflow job
```

### 4.4 Answered questions (Lane C — doc-gap loop)

```
projectId, questionId, conversationId (link)
question, answer, answerConfidence, citedNodeIds[]
docGap   boolean   // low confidence → emit a doc-gap signal to the Document Center
```

Evidence blobs (replay/console/network/screenshot) go to **S3** (scoped path, like
`knowledge-live/<projectId>/`); DynamoDB holds keys + structured/agentic fields. Keeps tables
light and queryable.

---

## 5. Widget SDK spec

- **Mount:** right-edge slide-out conversational panel. One-line `<script>` include.
- **Capture (rrweb thin custom widget):** rolling ~60s ring buffer of rrweb events + console +
  a `fetch`/XHR interceptor, all in memory. **Buffer, don't stream** — serialize and upload
  only on submit. Zero cost when nobody reports; full replay when they do.
- **PII masking at the SDK layer** (non-negotiable): inputs masked by default;
  `data-signal-mask` opt-in/out. PII never leaves the browser.
- **Screenshot + annotate:** draw a box on the broken thing — cheap, hugely improves the
  vision-judge's localization (reuses VQA vision-judge infra).
- **Env-aware:** same bundle on dev/staging/prod; reads env + git SHA from build-injected
  config and stamps every record. Verbose capture in lower envs, redacted in prod.
- **Conversational router:** the agent classifies intent inline, asks clarifying questions,
  answers Lane C live, and collects evidence for Lanes A/B before filing.

---

## 6. Public-endpoint security model (anonymous-prod hardening)

The submit endpoint is unauthenticated (anonymous prod reporting is allowed) → it is the
attack surface. Defenses:

1. **Key + origin gate:** accept only if `(publishableKey, Origin)` matches a registered active
   project.
2. **Rate limiting** per IP + per publishable key.
3. **Payload caps** — replay blobs can be MB; enforce size limits, reject oversized.
4. **Screening before enrichment:** `NEW → SCREENED → TRIAGED`. A cheap classifier decides
   whether a report is worth the _expensive_ enrichment (localize/reproduce cost tokens). Spam
   never auto-enriches.
5. **Dedup-first cost control:** embed (cheap) before localize/reproduce (expensive). A
   duplicate just increments a cluster count and skips re-enrichment — and "reported 47 times"
   becomes a priority signal for free.

---

## 7. Resolution paths

### 7.1 Lane A — `bug-fix` workflow (new daemon job type)

Specialized, repro-test-first, narrow scope, human-gated:

```
SUBMIT → INTAKE (normalize, classify, redact, userFeltSeverity)
       → DEDUP (embed → similarity over clusters; merge or new cluster)
       → LOCALIZE (Memgraph: map route/stack frames → code nodeIds → walk
                   REFERENCES for blast radius → follow PROPOSES to authoring plan/epic)
       → REPRODUCE (replay rrweb headless → failing test + reproConfidence)
       → status TRIAGED  (fully enriched, waiting on the human gate)
       → [human clicks "Fix this"]  → mints PENDING bug-fix job
       → daemon picks up → Claude CLI fixes (repro-test-first)
       → VERIFY (VQA/QA gates) → deploy → notify reporter "fixed in build N"
```

### 7.2 Lane B — `feature-build` workflow (new daemon job type)

**Decision (locked):** dedicated pipeline, _not_ the existing plan pipeline (features here need
spec → design → build framing distinct from both plans and bug-fix).

```
SUBMIT → INTAKE → CLUSTER (merge similar requests, accumulate demand count)
       → BACKLOG (per-project, ranked by demand + value)
       → [human clicks "Promote"]  → mints PENDING feature-build job
       → SPEC → DESIGN → BUILD → VERIFY → deploy → notify requesters
```

### 7.3 Lane C — graph-RAG + doc-gap loop (synchronous, no pipeline)

```
QUESTION → graph-traversed retrieval over curated god-docs (Agentic Document Center)
           + code graph nodes (Voyage embeddings + Memgraph traversal)
         → answer inline with citations (citedNodeIds)
         → persist {question, answer, answerConfidence}
         → if answerConfidence low → emit doc-gap signal → Document Center improves god-docs
```

The **self-improving knowledge flywheel**: every weak answer makes the god-docs better. A
compounding asset no competitor has.

---

## 8. Graph-localization design (the moat)

When a bug arrives, Signal maps the failure to graph nodes and walks edges:

- **Entry:** failing `route` / component name / stack-trace frames → resolve to code nodeIds
  (`code/src--x.ts#fn` convention).
- **Blast radius:** traverse `REFERENCES` (and `DEFINES`) edges N hops to find code that could
  be implicated by the change.
- **Provenance:** follow `PROPOSES` edges back to the **authoring plan/epic** → answers "which
  plan created this bug?"
- **Output:** `rootCause = { suspectFiles[], graphNodeIds[], authoringPlanId, epicId }` attached
  to the bug _before_ the human gate.

The bug itself becomes a **new graph node** linking to the code it implicates and back to its
authoring plan — closing the loop on the ledger-as-source-of-truth vision.

---

## 9. Epic / story breakdown (sequenced by capability tier)

> Built to feed the build-from-epics-directly flow. Sequence honors the deterministic-first law:
> ship capture + intake before the expensive agentic lanes.

### Epic E1 — Signal service foundation (Tier 0)

- S1.1 `signal-conversations` table + repository (follow agent-jobs-repository pattern)
- S1.2 Project Registry + publishable key + origin allowlist
- S1.3 Public `POST /api/public/widget/conversations` (rate-limit, key+origin gate, screening)
- S1.4 Widget bundle MVP: rrweb capture, PII masking, env-aware config, slide-out panel
- S1.5 Embed snippet + per-project config fetch
- **Exit:** drop the widget on any registered app, capture bug/feature/question to storage.

### Epic E2 — Admin intake & triage UI

- S2.1 `/src/app/signal/` list + `[id]` detail pages, `use-signal.ts` hook
- S2.2 Conversation viewer (transcript + replay + console/network)
- S2.3 Bug / feature / question typed views; manual status transitions

### Epic E3 — Bug lane resolution (Tier 1–3)

- S3.1 `bug-reports` table + dedup (Voyage embeddings + clustering)
- S3.2 Graph-localization (Memgraph queries) → `rootCause`
- S3.3 Reproduce (headless rrweb replay → failing test)
- S3.4 `bug-fix` daemon job type + "Fix this" gate → dispatch
- S3.5 Verify (VQA/QA) → deploy → reporter notification

### Epic E4 — Feature lane (Tier 1–3)

- S4.1 `feature-requests` table + clustering + backlog ranking
- S4.2 `feature-build` daemon job type + "Promote" gate → dispatch
- S4.3 Spec → design → build → verify → notify

### Epic E5 — Question lane + doc-gap loop (Tier 2+)

- S5.1 Graph-RAG over god-docs + code graph; inline cited answers
- S5.2 Persist Q&A + confidence; doc-gap signal → Agentic Document Center
- S5.3 Question analytics (what users ask, answer quality)

### Epic E6 — Multi-tenant hardening & onboarding

- S6.1 Onboarding state machine + tier gating across the stack
- S6.2 Versioned CDN bundle + per-project theming
- S6.3 Brownfield onboarding runbook (applicator first)

---

## 10. Spike plan (before building the module)

Validate the loop with one real bug end-to-end, manually-as-agent, then design the `bug-fix`
workflow around what the spike proves:

1. Wire a minimal widget + public endpoint + `signal-conversations` table.
2. File one real bug from a running app (capture + replay).
3. Manually run the enrich → localize (graph) → reproduce → fix → verify loop as an agent.
4. Capture: what context was missing, where the graph helped, repro success rate, token cost.
5. Let that shape the `bug-fix` workflow shape and the screening/dedup thresholds.

---

## 11. Open questions (next round)

- Reporter feedback channel for anonymous prod users ("fixed in build N") — email opt-in vs.
  in-widget status check by conversationId.
- Confidence-threshold auto-dispatch in dev/staging later (currently all human-gated).
- Spam/abuse escalation beyond rate-limit (proof-of-work? captcha? trust scoring?).
- Cross-project dedup — should a bug in shared infra surface across tenants?
- Lane C answer guardrails — refuse / hedge when confidence is low rather than hallucinate.
