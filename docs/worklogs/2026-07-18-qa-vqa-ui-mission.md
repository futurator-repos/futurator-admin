# 2026-07-18 — QA-Review VQA + Stage-Aware UI Mission

**Operator brief (interpreted):**

1. Run a **greenfield plan 0** then a **brownfield plan 1** on the same app, watching every
   pipeline step (intent seed → plan quality → dev → QA), per the earlier "green field >
   brownfield, assess+fix in capped loops" example.
2. **Rebuild the QA-review stage**: after development completes, run tests AND visual QA with
   screenshots. Integrate the operator's **BrowserAgent** project
   (`~/GetReal/elevenLabsConcepts/BrowserAgent`) — a self-hosted Claude-in-Chrome-style agent
   with one brain and three backends (headless Chromium / headed Chromium / real-Chrome MV3
   extension). Requirement: VQA must run **headlessly on server boxes** (Playwright Chromium),
   and **optionally through the extension** when the operator wants to watch it live in Chrome.
3. Fix the QA defects from the Pacman runs — advisory visual ACs (canvas renders, pixel-art
   sprites, HUD) sit at FAILING because nothing visual ever runs on quick plans
   (known from qa-false-green forensics: 0 visual-QA jobs on quick plans).
4. **Labs3 UI redesign**: restore the legacy app-centric view (apps grid) + per-app plan
   timeline; remove the PIPELINE V2 ROADMAP panel; make tabs **stage-aware** (planning panel /
   dev tabs / QA-review panel / deployment panel); rethink the planning-stage view.
5. ultracode: assess → plan → develop → review. Then loop for hours running plans, fixing the
   pipeline until it works 100%.

**Model policy:** sonnet-5 normal, opus-4.8 hard, fable-5 (me) heavy redesign. BrowserAgent
loop models: computer-use requires sonnet-5/opus-4.x — Fable 5 has no computer-use support.

---

## Iteration log

### I0 — Assess (started)

- Recovered the truncated pasted example from paste-cache (`d1a7479d`): green plan first,
  observe intent seed → fan-out → node/doc quality → decisions → SDD specs; then brownfields;
  assess UX, fix, loop capped, record worklog.
- Read BrowserAgent README + DESIGN.md first-hand. Key integration facts:
  - ESM, deps: `@anthropic-ai/sdk`, `playwright`, `express`, `ws`, `dotenv`. ~1.8k LOC server.
  - Library seam: `runAgentLoop({session, executor, instruction, url, model, apiKey, baseURL,
maxSteps})`; executor interface `start/execute/screenshot/stop`; actions mirror Anthropic
    computer-use tool; screenshots journaled to `runs/<sessionId>/step-NNN.png`.
  - HTTP seam: `POST /api/run {mode, url, instruction, tier}` → SSE stream
    (`thought|action|screenshot|done|error|status`), `GET /api/status` (extensionConnected).
  - Extension bridge: WS `/extension`, cmds attach/navigate/screenshot/input/detach; always a
    NEW tab; 1280×800 viewport contract.
  - Needs `ANTHROPIC_API_KEY` (computer-use beta) — per-token; keep runs on `normal`
    (sonnet-5) tier to control cost. Fable 5 rejected by design for the loop.
- Launched assess workflow `wf_6e395213-a1a` — 5 readers: BrowserAgent map, QA-pipeline map,
  Labs3 UI map, planning-stage map, deployment-stage map.

### I1 — Assessment findings (workflow wf_6e395213-a1a, 5 maps)

**QA-review reality:** P3/quick plans already run "QA-Review W2" (LIVE, `P3_QA_REVIEW='on'`):
cron auto dev-deploys on `status==='review'` → `p3-qa` daemon job → `p3-qa-runner.mjs`
journeys (Lane 1 deterministic `__harness` probes; Lane 2 confirmatory 2-frame VQA via claude
CLI vision judge) → wiring check → `p3QaVerdict` (SHA-guarded, never clobbers human) →
approve / send-back / Integrator+fix-minter autofix. **Root cause of the FAILING advisory
visual ACs:** `completion-gate.mjs::requiresBrowser()` excludes `advisory-taste` from
per-story browser tests AND `p3-journey-source.mjs::isBrowserShaped()` requires `when` +
`then`, so a pure-appearance AC ("maze walls render on canvas") never becomes a step in ANY
lane — testBinding stays unbound/failing forever, fix-minter can never react. There is no
observe-only step primitive. Also: VQA judge gets no real git diff; playwright absence
degrades to a generic seam-unreachable fail; legacy epic QA path is dead code for P3 plans.

**Labs3 UI reality:** three surfaces — legacy /labs (Apps grid → AppDetailView w/ Overview
(PlanTimeline)/Source/… tabs), /labs3 (plan-only PlanSpecDashboard, no app home), and
V2RoadmapStrip (the "PIPELINE V2 ROADMAP" panel — mounted in _legacy_ AppDetailView:119).
All 7 labs3 subtabs render unconditionally; STAGE_KEY constant is dead; stage→subtab mapping
half-exists in lifecycle-strip STAGES. Planning stage is fire-and-forget: launcher discards
the mint jobId, EmptyState shows stale copy, no phase/elapsed/failure surface, narrative
buried collapsed in Graph tab. Deploy stage: rich legacy environment-ladder/release-strip
exist but were never ported to labs3; Deployed chip label is static.

### I2 — DESIGN (fable tier)

#### Track Q — QA-review engine

**Q1. Observe-only journey steps (closes the advisory-AC hole).**

- `p3-journey-source.mjs`: `resolveSteps()` additionally emits `{kind:'observe', acId, spec}`
  for ACs with `verify:'appearance'` (or acClass 'advisory-taste') having `then`/`thenObservable`
  but no `when`. `isBrowserShaped` untouched for action steps.
- `browser-probe-executor.mjs`: new observe mode — navigate (dev URL + route if the journey
  declares one) → settle 1200ms → capture single "after" frame. No assertions.
- `p3-qa-runner.mjs`: observe steps are **VQA-primary**: single-frame judge prompt
  ("does this frame satisfy: <AC text>") → verdict pass|attention (NEVER blocking — keeps the
  advisory-taste=attention-only contract). Result written back per-AC:
  `ac.advisoryVqa = { status:'pass'|'attention'|'error', judgedAt, sha, frameUrl, rationale }`
  persisted on the StoryNodeRow (daemon already writes story rows).
- UI (bound-ac-table/verdict-strip): ADV chips get real states — `VERIFIED` (green),
  `ATTENTION` (amber), `NEVER RUN` (grey — the current permanent-FAILING lie is retired).

**Q2. Agentic VQA lane (BrowserAgent integration) — the automated operator-play-test.**

- Vendor BrowserAgent core into `daemon/lib/browser-agent/` (loop.js, prompts.js,
  executors/actions.js, executors/playwrightExecutor.js — ESM, deps only
  `@anthropic-ai/sdk` + `playwright`; add `@anthropic-ai/sdk` to daemon/package.json).
  Header comment credits upstream `~/GetReal/elevenLabsConcepts/BrowserAgent`.
- New `daemon/lib/agentic-vqa-runner.mjs`:
  `runAgenticVqa({ plan, stories, devUrl, mode, spawnEnv, s3, log }) => AgenticReport`.
  Per delivery journey (cap `AGENTIC_VQA_MAX_JOURNEYS`, default 3): build instruction from
  journey narrative + expected outcomes + "finish with QA_VERDICT/QA_FINDINGS block";
  run `runAgentLoop` with headless PlaywrightExecutor (maxSteps `AGENTIC_VQA_MAX_STEPS`=25,
  model `AGENTIC_VQA_MODEL`=claude-sonnet-5); screenshots → S3
  `_qa/<planId>/<sha>/agentic/<journeyId>/step-NNN.png`; parse final text:
  `QA_VERDICT: pass|fail` + `QA_FINDINGS:\n- [blocking|attention] note`.
- **Extension lane:** `AGENTIC_VQA_MODE=auto|headless|extension` (default auto). auto probes
  `BROWSER_AGENT_URL` (default `http://127.0.0.1:3010`) `GET /api/status`; if reachable AND
  `extensionConnected`, drive via `POST /api/run {mode:'extension', url:devUrl, instruction}` +
  SSE, so the operator literally watches QA run in their Chrome. Else embedded headless.
  (Server boxes always headless; the Mac gets the show when BrowserAgent server is up.)
- **Blocking policy:** a `[blocking]` agentic finding (journey cannot be completed — the class
  of defect that shipped in every pacman plan) BLOCKS when `P3_AGENTIC_VQA='on'`; `'shadow'`
  records report only. New flag via pipeline-flags, default **shadow** until proven.
- Fix-minter: new finding kind `'agentic'` in `p3-fix-story-minter.ts` blockingFindings.
- Report schema (`functions/shared/types/qa-review-p3.ts`):
  `P3QaReport.agentic?: { mode, model, runs: AgenticRun[] }`,
  `AgenticRun = { journeyId, instruction, verdict, findings:[{severity,note}], frameUrls,
steps, durationMs, error? }`.
- ⚠️ **API-key isolation rule:** the SDK client gets `apiKey: process.env.BROWSER_AGENT_API_KEY`
  explicitly. NEVER export `ANTHROPIC_API_KEY` into the daemon's global env — the daemon
  spawns `claude` CLI on the Max subscription and a global key would silently flip it to
  per-token billing. Missing key ⇒ agentic lane reports `skipped: no-api-key` (never fails QA).

**Q3. Supporting fixes:** real git diff per AC into `qaContext.sourceDiffByAcId`
(daemon has the repo; `git show` story commits, same helper as story-reviewer);
playwright import failure ⇒ explicit `qa-engine-misconfigured` attention item (not a fake
app failure).

#### Track U — stage-aware Labs3 UI

**U1. App-centric home:** `/labs3` (no params) → apps grid (reuse legacy `AppsGrid`/`AppCard`
with labs3 hrefs); `/labs3?appId=X` → legacy `AppDetailView` REUSED with new optional
`planHref(appId, planId)` prop → labs3 plan links; `/labs3?planId=Y` unchanged. New
`src/lib/links3.ts` (`links3.home/app/plan(planId, subtab?)`). Launcher's QuickCreate stays
as the "+ New Plan" write path.
**U2. Roadmap panel removal:** un-mount + delete `v2-roadmap-strip.tsx`, `v2-phase-data.ts`,
`src/app/labs/roadmap/` (confirmed orphaned).
**U3. Stage-aware tabs:** `constants.ts` gets `stages` per subtab + `subtabsForStage(status)`

- new subtabs `'plan-stage'` (concept) and `'deploy'`; PlanSpecDashboard filters the tab row,
  invalid persisted subtab falls back to the stage default:
  concept → [plan-stage, graph]; developing/fixing → [graph, stories, gitgraph, stream,
  codegraph]; review → [qa, stories, gitgraph, stream, deploy]; delivered → [deploy, qa,
  codegraph, gitgraph, growth]. (growth stays reachable at review+delivered; exact sets are
  the dev agent's contract, edits localized to `subtabsForStage`.)
  **U4. PlanningView** (`'plan-stage'`): mint-job status via `plan.mintJobId` (persisted by
  quick-p3 route; `useAgentJob` polls) — phase stepper (planner → parallelism-repair → critique
  → critique-repair) from a new `phase` marker `updateJobFields()` written by
  quick-planspec-runner; elapsed timer; FAILED surface w/ errorMessage; brownfield "growing
  <app> — prior tests locked" banner (plan.kind==='change'); once ingested: planner narrative
  promoted front-and-center (shape badge, story count, critique/audit counts) above the DAG.
  Fix stale EmptyState copy.
  **U5. DeployView** (`'deploy'`): port legacy environment-ladder + release-strip + DevUrlCard +
  promote CTA (use-deploy-report, qa-actions promote) + qaReadiness evidence line; lifecycle
  strip gets `deployStageOverride()` (promoting/failed/live) replacing static 'promoted live'.
  **U6. QA view upgrades:** advisory-AC verified/attention/never-run states; new
  AgenticJourneysSection (filmstrip from frameUrls, verdict, findings, mode badge
  headless/extension); keep existing W2 sections.

#### Build slices & ownership (file-disjoint waves)

Wave A (parallel): A1=Q1 daemon (journey-source, probe-executor, tests) [opus] ·
A2=mintJobId+phase markers (quick-planspec-runner, api quick-p3, plan types) [sonnet] ·
A3=U1+U2 (labs3 page, AppDetailView planHref, links3, deletions) [sonnet] ·
A4=U3 (constants, developing-subtabs, index, lifecycle-strip U5-override) [sonnet] ·
B1=Q2 vendored core + agentic-vqa-runner + tests [opus].
Wave B (parallel, after A): B2=Q2/Q3 integration (p3-qa-runner, agent-daemon, flags, types,
fix-minter, git-diff, health) [opus] · B3=U4 PlanningView [sonnet] · B4=U6 QA view [sonnet] ·
A5=U5 DeployView [sonnet].
Verify: typecheck+lint+tests, 2 adversarial reviewers (correctness / integration), fix loop.
