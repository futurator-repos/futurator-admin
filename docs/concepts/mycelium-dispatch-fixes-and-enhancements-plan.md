# Mycelium → Futurator Dispatch: Consolidated Fix + Enhancement Plan

**Status:** build-ready (assessment complete, no code changed)
**Date:** 2026-07-23
**Trigger:** first live Mycelium→Futurator SEAL-dispatch experiment (app `myc-1b5cecf3-…`, two plans: greenfield "dispatch" + brownfield "v0.0.0")
**Scope law:** every cure below is **app-agnostic** — keyed on `appId` / plan-status / AC-kind / whatever-arrives. Nothing pacman- or game- or Mycelium-content-specific. Each fix carries an explicit anti-hardcoding guard. The loop repeats between the two apps until smooth, so any experiment-shaped patch is a defect, not a fix.

---

## 1. Executive summary & coherent problem model

Mycelium drove Futurator through its **machine-callable dispatch surface** (`POST /api/pipeline/dispatch`, `x-queue-key`) for the first time in anger. Every observed problem is one instance of a **single structural disease**:

> **Futurator's machine-facing path is a second-class citizen of the operator-UI path, and it does not exercise the authority, audit surfaces, and generic models it has ALREADY BUILT for the operator path.**

The guards, tables, and provider-agnostic fleet model needed to make this loop smooth **all already exist in the codebase** — they are simply wired only to the operator/legacy path:

| Capability that exists                                            | Where it lives                                                                                                                                                          | Why the machine path didn't get it                                                                                                                                                                                                            |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "One non-terminal plan per app" invariant                         | `getActivePlanForApp` at `plan-repository.ts:310`; `NON_TERMINAL_STATUSES` at `:263`; enforced on operator path as `PLAN_ALREADY_ACTIVE` 409 (`functions/api/index.ts`) | `pipeline-dispatch.ts` never calls it, and `grep` proves **the daemon never calls it either** — despite `plan-repository.ts:308` documenting it as used "by the daemon's dispatch guard". That guard was never wired.                         |
| Queue-requests audit table + Queues tab                           | `queue-requests-repository.ts`; `queues-tab.tsx`; rendered by `listAllRequests` (`index.ts:6368-6372`)                                                                  | `handleDispatch` (`pipeline-dispatch.ts:565`) creates a Plan + jobs directly and **never calls `createRequest`** — the two SEAL orders are structurally invisible in `/development/queues`.                                                   |
| Generic provider fleet model (`local\|aws\|gcp\|hetzner\|oracle`) | `futurator-servers`, `useServers()`, `deriveServerState()`; GCP box heartbeats correctly (`agent-daemon.mjs:1793-1837`)                                                 | Header daemon widget + Queues CapStrip still read the legacy singleton `DAEMON_HEARTBEAT` row that fleet daemons deliberately **don't** write (`agent-daemon.mjs:1668-1744`) → operator sees "local · offline" while a GCP box runs the work. |
| The received order (`plan.intent`)                                | Captured verbatim at dispatch (`pipeline-dispatch.ts:127`), round-tripped by `GET /api/plans/:id`                                                                       | Rendered **only** in the transient RUNNING branch of `planning-view.tsx:538-548` — invisible for ~the whole plan life.                                                                                                                        |

### The critical cross-cutting insight (two-mechanism gap)

There are **two different dispatch mechanisms**, and they must not be conflated:

1. **The plan/frontier path** — `handleDispatch` → `dispatchPipelineRun` creates a `Plan` + `agent-jobs`; the daemon frontier scan (`agent-daemon.mjs:1891-1967`) mints story-dev jobs stamped with `planAffinityStamp` → `assignedServerId`. **This is the mechanism that actually built pacman.** It does **not** touch `queue-requests-repository` at all.
2. **The queue-request path** — `POST /api/queue/ingest` / `/test` write `queue-requests` rows carrying the `target` enum; `isJobClaimableBySource` matches on it. **The pacman run never used this path.**

Consequence for this plan: the audit/attribution/authority cures must be applied to the **plan/frontier path specifically**. Fixing only the queue-request module leaves the mechanism that built pacman untouched. This directly re-points several fixes below (A4/A6 are downstream of A1; the frontier guard C1 is the authoritative sequencing fix — not a queue-target tweak).

### Why Plan 2 developed before Plan 1 finished (the headline sequencing bug)

`runFrontierScan` (`agent-daemon.mjs:1903-1967`) `ScanCommand`s the whole plan-spec-graph table for **all distinct planIds** and calls `runFrontierTick` per planId **independently** — zero cross-plan or same-app awareness (the `appId` is right there at `:1919`, unused for precedence). Both plans' StoryNodes live in that one table, so both dispatch concurrently. `nextStatusOnDispatch` flips each plan concept→developing on its own first dispatch with no sibling check (`:2320`). That is the direct, code-level root cause of Plan 2 (brownfield) developing against Plan 1's half-built worktree.

---

## 2. The four themes

Each theme states the **disease-level root cause (evidence file:line)**, the **app-agnostic cure**, **exact files to touch**, and **acceptance criteria**. Critic challenges are reconciled inline (marked **[reconciled]**).

---

### THEME A — Queue audit: capture every inbound dispatch, with its original body + a call/body inspector; fix Target "EC2" → true active server

**Two-mechanism note (drives ordering):** the dispatch/frontier path writes **no** queue-request row today, so the Target-column and inspector fixes are inert until an audit row exists. **A1 is the prerequisite for A4.** [reconciled — critic minor on D7 coverage]

#### A1 — Write an audit row for every inbound dispatch (D5)

- **Root cause:** `handleDispatch` parses the body at `pipeline-dispatch.ts:569`, calls `dispatchPipelineRun` at `:583`, and **never** calls `queueRequestsRepo.createRequest`. Only `/api/queue/ingest` and `/api/queue/test` write rows (`index.ts:6258` region). The two Mycelium orders are absent from `/development/queues`.
- **App-agnostic cure:** in `handleDispatch`, after `safeParse` succeeds, write an audit-only `queue-requests` row via `queueRequestsRepo.createRequest`, with a `kind:'dispatch'` discriminator, linked to the created run by a new `runId`/`planId` field, and its display status resolved from the linked plan (store the `derivePipelineStage` result on the row, or resolve at read time). Carry the **executing** `assignedServerId` when the frontier mints jobs (see A4).
- **Anti-hardcoding guard:** persist whatever the caller sent; no seal-specific or app-specific columns — the row is a generic `{source, kind, runId, planId, body, status}` envelope.
- **Files:** `functions/shared/services/pipeline-dispatch.ts` (handleDispatch), `functions/shared/repositories/queue-requests-repository.ts` (row shape: add `kind`, `runId`, `planId`), `functions/shared/schemas/queue-request*.ts` (row type).
- **AC:** every `POST /api/pipeline/dispatch` (greenfield or brownfield, any source) produces exactly one `queue-requests` row that appears in `/development/queues`, linked to its plan, with an honest status derived from the plan/stage.

#### A2 — Persist the raw inbound handoff body + sanitized headers (D6a)

- **Root cause:** `dispatchPipelineRun` distills the payload to `document = seal.document ?? intent` (`pipeline-dispatch.ts:127`) plus a partial provenance subset; the full POSTed JSON body is discarded (parsed at `:569`, never stored).
- **App-agnostic cure:** capture the **raw parsed JSON body** + `method` + `path` + `source` + **sanitized headers** onto the A1 audit row.
- **Anti-hardcoding guard:** store the whole body verbatim; no field allow-list.
- **Security guard (open-gap resolved):** **strip `x-queue-key`** (and any `authorization`) from headers before persistence — mirror the ingest path's "secret stripped" contract.
- **Files:** `functions/shared/services/pipeline-dispatch.ts`, `queue-requests-repository.ts`.
- **AC:** the stored row contains the exact JSON Mycelium sent, minus the auth secret; re-serializing it reproduces the request body byte-for-byte (modulo key ordering).

#### A3 — Render the body in a call/body inspector (D6b)

- **Root cause:** even the ingest path stores `body/method/path/headers` but `queue-detail.tsx` renders only `req.prompt` (`:239`), never `req.body`.
- **App-agnostic cure:** render `req.body` as pretty-printed, collapsible JSON in `queue-detail.tsx`, plus `method`/`path`/`source`/sanitized-headers. One change serves **both** ingest and dispatch rows.
- **Anti-hardcoding guard:** pure JSON pretty-print of whatever is stored; no schema assumptions.
- **Files:** `src/components/development/queues/queue-detail.tsx`.
- **AC:** opening any queue row (ingest or dispatch) shows the full request payload and headers in a readable inspector.

#### A4 — Target column: declared "requested" intent → promote true "executed on" server (D7)

- **Root cause:** the column renders `r.target` (`queues-tab.tsx:81`), the `'ec2'|'local'` enum defaulting to the literal `'ec2'` (`index.ts` `target ?? 'ec2'`). It denotes desired routing, not the executing host, and EC2 is decommissioned. The true machine is already resolvable — `queue-detail.tsx:181` uses `useServers()` and joins `job.assignedServerId → server name` at `:219-223`.
- **App-agnostic cure:** keep `target` as the declared request-time intent, **relabel it "requested"**; add an **"executed on"** primary value per row resolved from `job.assignedServerId` (the frontier's `planAffinityStamp` → `assignedServerId`) via the same `useServers()` join `queue-detail` already does. Generalize the `QueueTarget`/`DAEMON_SOURCE` vocabulary from a 2-value enum toward the `serverId` namespace already used for `assignedServerId`.
- **Anti-hardcoding guard:** the executing value is read from the job/server join, never a literal; unknown → show the raw serverId, never a hardcoded provider.
- **Dependency:** requires A1 (dispatch rows must exist and carry/link `assignedServerId`). [reconciled — critic minor]
- **Files:** `src/components/development/queues/queues-tab.tsx`, shared `useServers()` join helper (reuse `queue-detail`'s).
- **AC:** for the two SEAL orders, the Queues tab shows Requested = (declared or "—") and Executed-on = the GCP fleet host name, never "ec2".

#### A5 — One source of truth for "current active server": the fleet model, not the singleton heartbeat (D8)

- **Root cause (the disease, not the "local·offline" symptom):** `GET /api/ec2/status` reads only the single fixed-key `DAEMON_HEARTBEAT` row (`index.ts` ec2/status region), which fleet daemons (`IS_FLEET_DAEMON`, `agent-daemon.mjs:1675`) are **forbidden** to write (`:1742-1749`) after a prior hijack incident. The header `DaemonPanel` and Queues `CapStrip` both consume that endpoint via `useEc2Status` (`queues-tab.tsx:4`), so they reflect whichever legacy source last wrote the one row — "local · offline" while a GCP box runs. The correct generic model already exists and the GCP box heartbeats into it (`agent-daemon.mjs:1793-1837`); only `queue-detail`'s Machine row consumes it. **[reconciled]** — investigators disagreed on whether "local·offline" is a disease; adopted resolution: the disease is the **two-source-of-truth split**; the label is its symptom.
- **App-agnostic cure:** make `futurator-servers` / `useServers()` / `deriveServerState()` the single source of truth for "current active/executing server" in the header widget and CapStrip (not just `queue-detail`). Show `provider + name` generically. Keep genuinely AWS-only controls (SSM start-daemon, Stop EC2) scoped to the `provider === 'aws'` row rather than as the only daemon control. Then retire the legacy singleton read/write path (already commented "kept during migration").
- **Anti-hardcoding guard:** render provider/name from the server row; never special-case a provider except to gate provider-specific actions behind `provider === <that provider>`.
- **Files:** `src/hooks/use-servers.ts` (consume), header `DaemonPanel` component, `queues-tab.tsx` CapStrip, `use-ec2-daemon.ts` (deprecate), `daemon/agent-daemon.mjs` (retire singleton write, guarded).
- **AC:** with only the GCP fleet box heartbeating, the header + CapStrip show that box as active with its provider; no surface reads `DAEMON_HEARTBEAT`.

#### A6 — Ingest target-less default → live server, not dormant "ec2" (D9) — LATENT

- **Root cause:** `POST /api/queue/ingest` sets `target: input.target ?? 'ec2'` (`index.ts:6326/6351`); `isJobClaimableBySource` requires exact `target === daemonSource` (`job-router.mjs`). A target-less call routes to a provider no daemon runs as; the live GCP fleet never claims it.
- **[reconciled — critic major on D9]:** the pacman run used the **plan/frontier path, not ingest**, so this is a **latent** strand-work bug on a path this loop did not exercise — **not** a root cause of the observed problems. Include it, tagged LATENT, gated on the open question "does Mycelium ever call ingest / ever pass an explicit target?".
- **App-agnostic cure:** default an unset target to the live dispatch policy (`dispatch.priorityOrder` / a currently-heartbeating server) instead of the literal `'ec2'`, and route via the `serverId`/assignment path story-dev jobs already use rather than the binary enum match.
- **Anti-hardcoding guard:** the default is computed from live server state, never a provider literal.
- **Files:** `functions/api/index.ts` (ingest handlers), `daemon/pipelines/job-router.mjs`.
- **AC:** a target-less ingest call is claimed by whatever server is currently live, or is honestly reported as "no eligible server" — never silently stranded PENDING against "ec2".

---

### THEME B — Concept-stage UX: surface the Mycelium intent body; single intent→plan→visual flow with the plan always visible

#### B1 — Always-rendered Intent card (D10)

- **Root cause:** `plan.intent` — the entire Mycelium `seal.document` captured verbatim at dispatch (`pipeline-dispatch.ts:127`, stamped for greenfield/brownfield) and already round-tripped by `GET /api/plans/:id` — is referenced **once**, inside the RUNNING branch at `planning-view.tsx:538-548`. The "stories ingested" branch (`:422`) and FAILED branch (`:470-499`) render nothing about intent, and a mint job completes in well under a minute, so the operator sees the branch that never shows the order for effectively the whole plan life.
- **App-agnostic cure:** add an always-rendered **"Intent" card** at the top of the concept-stage panel showing `plan.intent` verbatim in **every** state, reusing the existing collapsible monospace `PlannerNarrativePanel` pattern (a seal document can be long markdown). Optionally mirror `sealProvenance` onto the client `Plan` type for a provenance chip.
- **Anti-hardcoding guard:** renders whatever `plan.intent` holds; no assumption about caller or content. Pure front-end; zero backend change.
- **Files:** `src/components/labs3/views/planning-view.tsx`; `src/types/plan.ts` (add optional `sealProvenance` to mirror the backend type at `functions/shared/types/plan.ts` — a type-mirror gap, safe to add now, unblocks the provenance chip without an unsafe cast).
- **AC:** the received order text is visible in concept/planning/FAILED/developing states, not just the sub-minute RUNNING window.

#### B2 — Collapse concept to a single continuous subtab (D11)

- **Root cause:** `STAGE_DEFS` gives concept subtabs `['plan-stage','graph']` (`constants.ts`) — the only content stage besides development with >1 subtab — yet both views render the SAME `PlannerNarrativePanel` (`planning-view.tsx:422`, `spec-graph-view.tsx:1180`) and mainly cross-link each other. The dashboard **already** hides the tab row for single-subtab stages via the `stageSubtabs.length > 1` gate (`index.tsx:290`); concept just isn't configured to use it.
- **App-agnostic cure:** set concept to a single subtab in `STAGE_DEFS` (`subtabs:['plan-stage']`); the length>1 gate removes the tab row automatically with no new shell code. Render one continuous concept panel: **Intent card (always) → mint/planner status (unchanged) → dependency graph inline**. `graph` remains valid for development via the existing multi-owner `stageForSubtab` resolution.
- **Anti-hardcoding guard:** pure declarative config change; no app-specific branching.
- **Files:** `src/components/labs3/plan-spec-dashboard/constants.ts`, `planning-view.tsx` (inline the graph), `spec-graph-view.tsx`.
- **AC:** concept stage shows no subtab row; the plan/graph is always visible below the intent; a `?subtab=graph` deep-link still resolves (to development) — see open decision O-5.

---

### THEME C — Dependency-aware dispatch & Futurator authority

**Design stance [reconciled — critic over-engineering on D2/D3/D4]:** the **authoritative** enforcement is a single same-app precedence check at the frontier (C1) — "the one place dev work actually starts." Admission-time behavior (C2) is a **thin honest-status layer**, not a full HELD-state scheduler with promotion sweeps. The schema field (C4) is **advisory only** — Futurator must never rely on it. D3 ("brownfield bootstrap barrier") is **folded** into C1/C2: it is the same predecessor-plan-status predicate, not a separate cure (a brownfield iteration correctly has no scaffold to wait for; the real defect is the missing predecessor-plan barrier).

#### C1 — Same-app predecessor precedence at the frontier (D1) — KEYSTONE, authoritative

- **Root cause:** `runFrontierScan` iterates all planIds independently with zero same-app awareness (`agent-daemon.mjs:1903-1967`); `plan.appId` is available at `:1919` but unused for precedence. `plan-repository.ts:308` documents `getActivePlanForApp` as the daemon's dispatch guard; `grep daemon/ → zero calls`.
- **App-agnostic cure:** before dispatching a plan's frontier, **skip it** if `listPlansByApp(appId)` (ordered by `createdAt`, tie-broken deterministically — see open decision O-7) shows an **earlier non-terminal same-app plan**. Closes the hole for BOTH dispatch and operator paths and BOTH greenfield+brownfield. Keys on `appId` only.
- **Anti-hardcoding guard:** predicate is `appId` + plan-status only; no app content, no per-app logic.
- **Files:** `daemon/agent-daemon.mjs` (`runFrontierScan`), reusing `getActivePlanForApp`/`listPlansByApp` from `plan-repository.ts` (import into daemon).
- **AC:** given two non-terminal same-app plans, only the earlier one's frontier dispatches; the successor's stories stay off the frontier until the predecessor is terminal.

#### C2 — Admission-time honest "held" status (thin D2, not a scheduler)

- **Root cause:** `dispatchPipelineRun` → `createIterationPlan`/`createGreenfieldRun` unconditionally creates a plan for an existing app, never calling `getActivePlanForApp` (`pipeline-dispatch.ts:159-178, 291-356`), while the operator path refuses with `PLAN_ALREADY_ACTIVE` 409. A machine caller can't gracefully retry a 409.
- **App-agnostic cure (thin):** at admission, if `getActivePlanForApp(appId)` returns a non-terminal predecessor, still admit the plan but mark it **held** (stays `concept`; `derivePipelineStage` already has a `queued`/`blocked` stage to report it honestly). C1 already keeps its stories off the frontier — C2 only makes the **status honest** in the UI/status endpoint. **Do NOT** build promotion sweeps / plan sub-states in the MVP; release is a piggyback (open decision O-6).
- **Anti-hardcoding guard:** held decision is `appId` + predecessor-status only.
- **Files:** `functions/shared/services/pipeline-dispatch.ts` (admission), `derivePipelineStage` (surface held), status endpoint echo.
- **AC:** dispatching a second same-app plan while the first is non-terminal returns 202 with an honest `held/queued` status, not a silent concurrent developing plan.

#### C3 — Remove the game-shaped boilerplate hardcode in the dispatch path (MISSED by synthesis)

- **Root cause:** `createGreenfieldRun` hardcodes `boilerplateType = normalizeBoilerplateType('nextjs-canvas-game')` (`pipeline-dispatch.ts:196`). **Every** greenfield dispatch — the general "build me an app" machine surface — is scaffolded as a canvas **game**. A non-game SEAL order gets a game template. This is the clearest app-agnostic-law violation in the whole surface, sitting inside the dispatch path under review. **[added — critic hardcoding finding]**
- **App-agnostic cure (MVP):** honor an explicit `boilerplateType` from the seal/contract if present; otherwise default to a **neutral** base (`'nextjs-base'`), **not** a game template. (Richer NL-intent→template inference is a fable enhancement, open decision O-8.)
- **Anti-hardcoding guard:** the template is either caller-declared or a neutral default; never a domain-specific literal.
- **Files:** `functions/shared/services/pipeline-dispatch.ts` (`createGreenfieldRun`), `dispatchPipelineSchema` (optional `boilerplateType`).
- **AC:** a greenfield dispatch with no template hint scaffolds the neutral base; a dispatch that declares a template gets that template; no dispatch is silently forced into a game scaffold.

#### C4 — Optional advisory `dependsOn` contract field (D4)

- **Root cause:** `dispatchPipelineSchema` accepts `source/app/seal/intent/git/name` only (`pipeline-dispatch-schema.ts:24-63`); `sealProvenance` carries `sealVersion` but nothing orders versions into a wait chain; unknown keys are silently stripped. Even when Mycelium KNOWS plan 2 depends on plan 1, it cannot express it.
- **App-agnostic cure:** add optional `dependsOn?: string[]` (prior seal ids / runIds that must be terminal first) and/or `priorPlan?:{sealId,version}`; stamp into `sealProvenance`; echo on the status endpoint. `deriveRunId` is deterministic from seal+version, so a named predecessor resolves to a planId without a mapping table. **Advisory only** — stacked on top of C1's implicit same-app precedence; Futurator must not rely on it for correctness. **[reconciled — critic over-engineering: defer if C1 suffices; ship only when a real cross-app (not same-app) ordering caller needs it — see O-4.]**
- **Anti-hardcoding guard:** the field carries opaque ids; no content interpretation.
- **Files:** `functions/shared/schemas/pipeline-dispatch-schema.ts`, `pipeline-dispatch.ts` (stamp + echo), contract doc.
- **AC:** a dispatch carrying `dependsOn` is accepted, the value is stamped and echoed on status, and it never overrides C1's authoritative gate.

---

### THEME D — Pipeline story-verification disease: single-shot browser-AC failures wedge plans (NOT a pacman patch)

**Corrected root-cause narrative [reconciled — critic MAJOR on D12].** The synthesis analyzed the wrong executor. The wired story-completion path is `makeBrowserExecutor → runBrowserJourney` (docstring `browser-probe-executor.mjs:788` explicitly says it replaced "the legacy single-read `runBrowserProbe`"). In `runBrowserJourney` a bad key throws inside `replayAction` but is **caught at `:610-612`** and pushed as a _step failure_; **the loop CONTINUES**, so the subsequent ArrowRight-hold step (which carries the assertions) DOES fire. The false-fail is therefore a **poisoned-step artifact** (a spurious `'and'` step failure contaminating an otherwise-passing journey) — **not** "ArrowRight never fired". Certainty: the parser demonstrably emits a spurious `'and'` action, but whether the ArrowRight movement assertion itself passed is **not provable from code** — **PLAUSIBLE, not CONFIRMED**, pending the run transcript for job `f3cf3c23` (host `srv_gcp_t4shwd`).

#### D-fix-1 — NL probe-parser: index-precedence + real-key validation + fail-open (D12)

- **Root cause:** the parser regex `/(?:press(?:es|ing)?\s+(?:the\s+)?(\w+))/gi` (`browser-probe-executor.mjs:122`) greedily binds the first word after "press", so `"…presses and holds ArrowRight"` emits `key='and'`. `normalizeKeyName` (`:66-69`) **deliberately passes unknown tokens through** (comment `:56-57`) so real single-letter keys ('W'/'P') and named keys ('Enter'/'ArrowUp') survive — so `'and'` → `page.keyboard.press('and')` → throws → caught → poisons the journey.
- **App-agnostic cure (three parts):**
  1. **Index-precedence:** where a hold-branch match (`holdRe`, `:132`) and a bare-press match overlap in the source string, the **hold branch wins** (compare `m.index`), so `"presses and holds ArrowRight"` resolves to the ArrowRight hold, not `'and'`.
  2. **Real-key validation (NOT blanket discard) [reconciled — critic MAJOR]:** validate a captured token against a _real DOM-key predicate_ — it is a key iff it is a `KEY_ALIASES` value, a single alphanumeric char, or a `codeFor`-known named key (`:346`). A token that fails the predicate (`'and'`, `'then'`, `'start'`) is **dropped as a spurious action**, never emitted. This preserves legitimate `'press W'`/`'press P'`. **Reject** a blanket "discard non-alias tokens" (would drop single-letter keys) and **reject** a stopword-list / ArrowRight special-case (phrasing-specific).
  3. **Fail-open, never throw mid-run:** if the _primary_ captured token for a step is genuinely unresolvable, return `interpretable:false` (route to human review) instead of throwing inside the journey and booking a false AC failure — reuse the existing `interpretable:false` seam (`:225`).
- **Anti-hardcoding guard:** validation is against the generic DOM key map (`KEY_ALIASES` + `codeFor`), not any app's vocabulary; no arrow/space/game literals added.
- **Files:** `daemon/lib/browser-probe-executor.mjs` (parser at `:122-132`, `normalizeKeyName`, journey step handling).
- **AC:** `"presses and holds ArrowRight"` produces exactly one held-ArrowRight action and no `'and'` step failure; `"press W to move"` still produces a `W` press; an unresolvable primary token yields `interpretable:false` (human review), never a thrown false-fail.

#### D-fix-2 — Create the browser-AC escalation lane; gate retryability on whether the probe RAN (D13)

- **Root cause:** `completion-gate.mjs` routes every `needsBrowser` AC into the deterministic bucket (`:238-247`); a failing one lands in `failing` → status `'failing'` (`:369-376`). `needs-human` is only reachable from the external `needsHuman[]` param or unresolved MANUAL ACs — **no code path escalates a browser deterministic failure**. Meanwhile `story-retry.mjs:15` `NON_RETRYABLE_KINDS` includes `'browser'` with a now-**stale** "not wired / escalate, do not loop" justification (`:194`) — but the escalation it references **does not exist**. Net: the one AC kind that can kill a story has no fix-forward and no human-accept lane. Both stories' jobs (`f3cf3c23`, `b00674df`) are FAILED after a single attempt.
- **App-agnostic cure:**
  1. **Create the lane:** a browser/behavior AC that _ran and failed_ (produced before/after snapshots) routes to a **`needs-human` "Accept for interaction-gated VQA false-negative"** verdict — the operator's documented adjudication lane (`project_qa_remediation_model`) — instead of a hard fail-closed `'failing'`. The escalation currently only aspirational (the retry comment) must be **built** in `completion-gate.mjs`, not merely "un-blocked".
  2. **Gate retryability on probe-ran:** remove the blanket `'browser'` non-retryable rule; make retryability depend on whether the probe _actually ran_ (has snapshots) vs was truly un-wired.
  3. **Do NOT hand-mark stories done.**
- **Anti-hardcoding guard:** classification keys on AC-kind + probe-ran, never on app/story identity.
- **Files:** `daemon/lib/completion-gate.mjs` (add browser→needs-human routing), `daemon/pipelines/lib/story-retry.mjs` (`NON_RETRYABLE_KINDS` + `:191`), the operator "Accept" UI (reuse the QA remediation "Accept" verdict — `QaReviewView`).
- **AC:** a story whose only failure is a ran-and-failed browser AC lands in `needs-human` (operator can Accept), not `failing`; retryable browser fails can re-run; no story is auto-marked done.

#### D-fix-3 — Cascade correctness follows upstream; the "units passed ⇒ don't block" heuristic is REJECTED (D14)

- **Observed:** in Plan 1 the two Movement&AI stories false-failed and immediately wedged the two Rules&scoring stories into `state='blocked'` (dependents of the false-failed stories) → 2/6 done. Downstream blocking triggers on any dependency in `state='failed'`.
- **[reconciled — critic MAJOR + false-green risk]:** the synthesis's D14 cure ("a story failing ONLY on browser ACs while its unit ACs pass should quarantine rather than block dependents") is **REJECTED**. Unit ACs test movement LOGIC against a mocked seam — they do **not** prove integrated in-browser behavior. Treating "units passed" as proof the browser fail is spurious is exactly the false-green pattern `project_qa_false_green_forensics` warned about; it would let a genuinely-broken integration through to dependents. It is app-agnostic in wording but **experiment-shaped in effect** (fits pacman only because its units happened to pass).
- **Correct cure:** **do not add a new cascade heuristic.** Cascade correctness follows automatically once D-fix-1 makes the probe trustworthy and D-fix-2 routes a ran-and-failed browser AC to `needs-human` (quarantine) instead of `failing`. A quarantined (needs-human) story does not sit in `state='failed'`, so it does not hard-block dependents; a _genuinely_ failing unit/integration/invariant AC still blocks, as it must. The DAG's real dependency enforcement is **not** lowered.
- **Anti-hardcoding guard:** no new classification; relies on the AC-kind routing from D-fix-2.
- **Files:** none beyond D-fix-1/D-fix-2 (this is a _decision_, not a code path). Verify the `state='blocked'` trigger reads the post-D-fix-2 status.
- **AC:** after D-fix-1+D-fix-2, a browser-only false-negative quarantines to needs-human and dependents are not auto-blocked; a real unit/integration failure still blocks dependents.

---

## 3. Phased, model-routed story list

**Routing key:** `sonnet` = mechanical · `opus` = complex · `fable` = high-cognition.
**FABLE is DEACTIVATED on the Max daemon pipeline** — any fable-tagged item runs **operator-attended** (opus authors, operator supervises the reasoning-heavy step), never dispatched to the autonomous fleet.

**Two deploy / daemon-restart points** are marked ⏏.

### Phase 0 — Sequencing + verification keystones (backend + daemon)

| ID      | Fix                                                       | Theme | Model  | App-agnostic                 | Depends on |
| ------- | --------------------------------------------------------- | ----- | ------ | ---------------------------- | ---------- |
| C1      | Same-app predecessor precedence at frontier (KEYSTONE)    | C     | opus   | ✅ (appId+status)            | —          |
| C2      | Admission-time honest "held" status (thin)                | C     | opus   | ✅ (appId+status)            | C1         |
| C3      | Remove game-shaped boilerplate hardcode; neutral default  | C     | opus   | ✅ (caller-declared/neutral) | —          |
| D-fix-2 | Create browser-AC needs-human lane + probe-ran retry gate | D     | opus   | ✅ (AC-kind+probe-ran)       | —          |
| A1      | Write audit row per dispatch                              | A     | opus   | ✅ (generic envelope)        | —          |
| A2      | Persist raw body + sanitized headers (strip secret)       | A     | sonnet | ✅ (verbatim)                | A1         |
| A6      | Ingest target-less → live server (LATENT)                 | A     | opus   | ✅ (live state)              | —          |
| C4      | Advisory `dependsOn` schema field (defer per O-4)         | C     | sonnet | ✅ (opaque ids)              | C1         |

**⏏ Deploy/restart point 1:** `sst deploy` (backend: A1/A2/A6/C3/C4 handlers + schema) **and** daemon restart on all fleet hosts (C1/C2/D-fix-2 live in `agent-daemon.mjs` / `daemon/lib` / `daemon/pipelines`). Both required — backend and daemon changes ship together.

### Phase 1 — Observability + concept UX (frontend, static export)

| ID      | Fix                                                                       | Theme | Model  | App-agnostic             | Depends on                                |
| ------- | ------------------------------------------------------------------------- | ----- | ------ | ------------------------ | ----------------------------------------- |
| A3      | Body/call inspector in queue-detail                                       | A     | sonnet | ✅ (JSON print)          | A1/A2                                     |
| A4      | Target "requested" + promote "executed on" server                         | A     | sonnet | ✅ (server join)         | A1                                        |
| A5      | Fleet model as single source of truth (header+CapStrip); retire singleton | A     | opus   | ✅ (provider-generic)    | — (daemon singleton-retire rides Phase 0) |
| B1      | Always-rendered Intent card + client `sealProvenance` mirror              | B     | sonnet | ✅ (renders plan.intent) | —                                         |
| B2      | Collapse concept to single continuous subtab                              | B     | sonnet | ✅ (declarative)         | B1                                        |
| D-fix-3 | Operator "Accept" verdict UI for quarantined browser-fail stories         | D     | opus   | ✅ (reuse QA lane)       | D-fix-2                                   |

**⏏ Deploy/restart point 2:** `sst deploy` (static export for A3/A4/A5-UI/B1/B2/D-fix-3-UI). A5's daemon-side singleton retirement rides **point 1**; the UI switch to `useServers()` ships here. No separate daemon restart unless A5's retirement is split out.

### Phase 2 — High-cognition parser (operator-attended)

| ID      | Fix                                                                 | Theme | Model                                            | App-agnostic             | Depends on                      |
| ------- | ------------------------------------------------------------------- | ----- | ------------------------------------------------ | ------------------------ | ------------------------------- |
| D-fix-1 | NL probe-parser: index-precedence + real-key validation + fail-open | D     | **fable** (operator-attended — FABLE off on Max) | ✅ (generic DOM key map) | D-fix-2 (lane must exist first) |

**Daemon restart** after D-fix-1 lands in `browser-probe-executor.mjs` (folds into a follow-up daemon restart; can co-ship with a Phase-0 hotfix window if timing allows).

> **Sequencing rationale:** C1 (keystone) + D-fix-2 (escalation lane) must land before the loop is re-run, or the next dispatch reproduces both the concurrency and the wedge. D-fix-1 (parser) is last because it is the reasoning-heavy, operator-attended step and depends on the escalation lane existing so a mis-parse fails _open to human_ rather than hard.

---

## 4. Open decisions for the operator

- **O-1 (D9 live-vs-latent):** does Mycelium ever call `POST /api/queue/ingest`, or always the dispatch path? If never ingest, A6 stays LATENT (deprioritize); if it does, A6 becomes live. _Determines A6 priority._
- **O-2 (D8 EC2 status):** is EC2 (`srv_ec2_main`) fully decommissioned, or a dormant-but-valid provider? Removes vs merely deprioritizes AWS-specific daemon controls in A5. _Determines A5 scope._
- **O-3 (C2 held modeling):** (a) defer creating the successor's quick-planspec job until predecessor terminal (simpler, and desirable for brownfield "plan against real code") vs (b) ingest StoryNodes but hold them off the frontier via a plan-level flag. Recommendation: (a) — matches the brownfield premise and avoids half-built-worktree planning.
- **O-4 (C4 advisory field):** ship `dependsOn` now, or defer until a real **cross-app** (not same-app) ordering caller exists? Recommendation: **defer** — C1 is authoritative for the same-app case; advisory surface Futurator ignores risks implying a guarantee it doesn't honor.
- **O-5 (B2 back-compat):** does any external caller (Mycelium status page, saved bookmark) rely on `?subtab=graph` landing on concept before we drop it from `concept.subtabs`? Confirm before removing.
- **O-6 (C2 release trigger):** which terminal statuses release the next held same-app plan (delivered only, or review-passed/deployment), and via which sweep (piggyback the existing all-resolved/integrate sweep vs a dedicated promotion sweep)? Kept out of the MVP.
- **O-7 (C1 ordering reliability):** `getActivePlanForApp` orders by `listPlansByApp`/`createdAt`; confirm `createdAt` is stable/monotonic when two seals arrive within one clock tick (deterministic tie-break, e.g. by runId, to make "earlier non-terminal plan" reliable).
- **O-8 (C3 template inference):** MVP defaults greenfield to a neutral base. Do we want a fable-tagged enhancement that infers `boilerplateType` from the NL intent (game vs dashboard vs API)? Higher-cognition, operator-attended if so.
- **O-9 (D-fix-1 certainty):** pull the run transcript for job `f3cf3c23` (host `srv_gcp_t4shwd`) to confirm the ArrowRight assertion actually passed in the poisoned journey — upgrades D12 from PLAUSIBLE to CONFIRMED and tells us whether the ghost-AI `ac1` false-negative (story `fafa42a8`) is the same parser bug or a distinct start-gesture/settle-window issue.
- **O-10 (missing capability):** should a probe _parse_ failure surface as its own `errored` binding-fault (like `completion-gate.mjs:337` `tb.errored`) — distinguishing "probe un-runnable" from "app defect" — rather than folding into a plain AC `failing`? `classifyProbeFailure` already does this for boot failures but not parse failures.

---

## Appendix — Diseases folded / rejected / added vs the synthesis

- **Folded:** D3 (brownfield bootstrap barrier) → into C1/C2 (same predecessor-plan-status predicate; a brownfield iteration correctly omits `appBootstrapJobId`).
- **Rejected:** D14's "units-passed ⇒ don't cascade-block" heuristic (false-green risk; experiment-shaped). Cascade correctness instead follows from D-fix-1 + D-fix-2.
- **Corrected:** D12 root cause re-pointed from `runBrowserProbe`'s uncaught-throw to `runBrowserJourney`'s caught-and-continue poisoned-step (`:610-612`); false-negative downgraded to PLAUSIBLE.
- **Re-pointed:** D7/D9 (queue-request/ingest mechanism) are downstream of / latent-relative-to the plan-frontier path that actually built pacman; A4 depends on A1, A6 tagged LATENT.
- **Added (missed by synthesis):** C3 — the game-shaped `boilerplateType='nextjs-canvas-game'` hardcode at `pipeline-dispatch.ts:196`, the clearest app-agnostic-law violation in the audited surface.
- **De-scoped to thin MVP:** D2's full HELD-state scheduler → C2 honest-status only; promotion/release sweeps deferred (O-6).

---

## 5. Operator decision resolutions + O-9 transcript forensics (2026-07-23)

### 5.1 Decisions resolved

- **O-1 RESOLVED — Mycelium ONLY ever calls `POST /api/pipeline/dispatch`** (verified in Mycelium's `src/lib/futurator-handoff.ts:208`; `queue/ingest` appears nowhere; no status polling). ⇒ **A6 is pure LATENT — dropped from the near-term build** (kept as a noted latent strand-work bug on an unexercised path).
- **O-2 RESOLVED — EC2 is decommissioned FOR NOW but AWS/EC2 may return** alongside GCP and other providers. ⇒ **A5 is confirmed and load-bearing: server attribution + the queue list must be DYNAMIC from live `futurator-servers`, provider-agnostic. Never hardcode a provider and never REMOVE AWS support — only gate provider-specific controls behind `provider==='aws'`.** (No provider deletion; `srv_ec2_main` stays a valid-but-dormant row.)
- **O-4 RESOLVED — ship `dependsOn` NOW.** C4 moves from "defer" to Phase 0, live (advisory-only stance unchanged: C1 remains authoritative; Futurator never relies on the field for correctness).
- **O-9 RESOLVED — transcript pulled (below).**

### 5.2 O-9 forensics — the REAL failure, from the live records

Pulled `agent-jobs` + `agent-events` + `plan-spec-graph` for both failed jobs (host `srv_gcp_t4shwd`):

| Story                         | Job        | dev outcome (from events)                                | Failing AC     | ac1 kind    | ac1 probe text                                                                                            |
| ----------------------------- | ---------- | -------------------------------------------------------- | -------------- | ----------- | --------------------------------------------------------------------------------------------------------- |
| Pac-Man movement (`1081b72b`) | `b00674df` | **"All 3 tests pass"** (unit ACs green)                  | **only `ac1`** | **browser** | _"user presses Space to start then **presses and holds ArrowRight**; thenObservable: pacman.x > spawn x"_ |
| Ghost AI (`fafa42a8`)         | `f3cf3c23` | **"All 20 tests across 11 files pass"** (unit ACs green) | **only `ac1`** | **browser** | _"user presses Space to start **and** lets the clock advance ~3s → at least one ghost position ≠ spawn"_  |

Story-node verdict for BOTH: `state=failed`, `verdict.failing=[ac1]`, reason = **`"deterministic AC not passing (status=failing)"`** — nothing more.

**Four confirmed facts:**

1. **The implementations are correct.** Every unit AC passed; dev committed working code. The ONLY failure in each story is the single `needsBrowser` behavioral AC (`ac1`). The pipeline failed _correct code_ on its behavioral-verification layer.
2. **D12 CONFIRMED as implicated (movement).** The movement `ac1` probe literally contains _"presses **and** holds ArrowRight"_ — the exact phrase the parser regex mis-binds (`and`→key). Certainty upgraded PLAUSIBLE→**CONFIRMED-trigger-present** (the mis-bind is guaranteed by the phrase + regex; whether ArrowRight ultimately fired is still unlogged — see fact 4).
3. **Ghost-AI is a DISTINCT cause, NOT the parser.** Its probe is _"presses Space … and lets the clock advance ~3s → a ghost moved"_ — `and` does not follow `press`, so the parser binds `Space` correctly. This failure is a **start-gesture / settle-window / autonomous-motion-observation** issue, not D12. ⇒ **Two failed stories, one symptom, two different root causes** — vindicating the rejection of any single narrow fix, and confirming the escalation lane (D-fix-2) is the correct common cure.
4. **THE DEEPEST DISEASE — browser-AC verification is a BLACK BOX (new; the assessment under-weighted this).** `agent-events` for both jobs **end at `story-dev` step_complete**; the completion-gate + browser-probe phase emits **zero events** and persists **no probe detail** on the verdict — only `"deterministic AC not passing"`. Neither the operator nor this O-9 investigation could see _why_ `ac1` failed (parse result, journey steps, snapshots, per-assertion pass/fail are all unrecorded). This is [[project_pipeline_debug_dossier]] "reasons invisible in UI" recurring at the probe layer. **D-fix-2's human-accept lane is blind without this**, and it is why diagnosing a one-line parser bug required a multi-agent forensic run.

### 5.3 NEW fix — D-fix-4: Browser-probe observability (PROMOTED to Phase 0 keystone)

- **Root cause:** the completion-gate/browser-probe path streams no `agent-events` and writes no probe artifact; the story verdict carries only a terminal `status=failing` string (`plan-spec-graph` node `verdict`).
- **App-agnostic cure:** the browser-probe executor + completion-gate must (a) **stream** probe lifecycle events (parse result incl. the interpreted action list, each journey step + ok/err, snapshot before/after, per-assertion verdict) into `agent-events` under the story-dev job, and (b) **persist** the structured probe result onto the story verdict (or an S3 `_qa/` artifact keyed by story) so the human-accept lane and the operator UI can render _why_ a browser AC failed.
- **Anti-hardcoding guard:** logs whatever the probe produced; no app/story/probe-content assumptions.
- **Files:** `daemon/lib/browser-probe-executor.mjs`, `daemon/lib/completion-gate.mjs` (emit + persist), the agent-events writer, and the QA/verdict read surface.
- **AC:** after a browser AC fails, `agent-events` for the job contains the probe's interpreted actions + per-assertion verdict, and the operator can read the failure reason without SSHing a fleet host.
- **Model:** opus. **Sequencing:** land in Phase 0 alongside D-fix-2 — it is the _enabler_ that makes the escalation lane usable and makes D-fix-1's success verifiable. D-fix-1 (parser) certainty (O-9 fact 2/3) now needs no further transcript; ghost-AI's distinct cause becomes diagnosable _once D-fix-4 ships_.

### 5.4 Net build-list deltas

- **+ D-fix-4** (opus, Phase 0 keystone) — probe observability.
- **A6 → dropped** (latent; O-1). **C4 → Phase 0 live** (O-4). **A5 → confirmed load-bearing, provider-dynamic, keep-AWS** (O-2).
- Ghost-AI real fix (start-gesture/settle) is **deferred until D-fix-4 makes it visible** — do NOT guess it now (would risk a pacman-shaped patch).
