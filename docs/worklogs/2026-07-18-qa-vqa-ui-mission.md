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

### I3 — Build complete (workflow wf_06ed3039-098), committed

- 5 wave-A + 4 wave-B slices; 2 slices (B1 agentic runner, B2 QA integration) lost their
  structured status reports (retry-cap) but their WORK landed fully — verified on disk +
  by the gate that ran after them. Gate: typecheck 0, changed-file lint clean, next build OK.
- Adversarial review found 1 major: the new advisory chip treatment swallowed
  **advisory-security** ACs (a blocking reviewer fail would render as grey NEVER-RUN).
  Fixed: SEC stays on testBinding StatusChip; only advisory-taste gets advisoryVqa chips.
- Verified myself: 46/46 daemon node--test across the 5 new test files; 147/147 labs3
  vitest; key-isolation grep clean (no ANTHROPIC_API_KEY reads in daemon code paths);
  vitest.config exclusion of the node:test family is legitimate (they run under node --test).
- Commit: feat(qa-vqa) on feat/aws-migration-eu (64 files, +5733/−807).
- run-fleet-local.sh: BROWSER_AGENT_API_KEY sourced from the BrowserAgent .env at start
  (key value never committed); BROWSER_AGENT_URL + AGENTIC_VQA_MODE=auto defaults.
- Deploying: sst deploy (background) → daemon bundle upload → local daemon restart.

### I4 — Deployed + greenfield plan 0 minted (RUN PHASE start)

- sst deploy ✓ (hub.futurator.ai serves the new UI); daemon bundle uploaded to S3; local
  Mac daemon restarted on new code (pid 48238) with BROWSER_AGENT_API_KEY (sourced, count-
  verified, value never printed), BROWSER_AGENT_URL, AGENTIC_VQA_MODE=auto,
  P3_QUALITY_GATE=shadow. P3_AGENTIC_VQA defaults to shadow.
- UI verification on live hub: NEW app-centric /labs3 home renders (apps grid + Quick
  Create toggle + New App); QuickCreate flow worked; stage-aware tabs CONFIRMED (concept
  stage shows only PLANNING + PLAN); NEW PlanningView live — "Planning… · elapsed · opus-4.8
  · high effort" + intent echo. mintJobId telemetry wiring proven end-to-end.
- Greenfield plan 0: **snake-classic** (pixel-art Snake; grid movement, food/growth/score,
  speed-up, wall/self death, HUD, game-over + restart). planId b17ec708-05af-40ea-8811-
  9af6d0d2580b, app snake-classic-feda6e, QA autopilot ON (QA NOT bypassed this mission —
  the new QA engine is the subject under test).
- UX observations to date: (1) QuickCreate "name" field: first click at wrong y silently
  dropped typed text into void — field hitbox could be taller/labelled; (2) minor: launcher
  legacy-plan list shows 3 identical "pacman-fleet-0 — quick change" rows with 0/0 stories
  (delivered plans could be collapsed/archived by default).
- Monitor armed on daemon log (planspec/story-dev/p3-qa/agentic events).

### I5 — Plan 0 planning stage observed

- Planner: 9m, opus-4.8/high, planShape **coherent** — 6 stories, clean phased DAG:
  B0 walking-skeleton/contract → B1 stepping ∥ pixel-art render → B2 eat/grow/score ∥
  collision-death → B3 HUD+game-over. Width 2 matches fleet cap 2. 21 ACs. Phase marker
  `phase=planner→…→ingest` visible in job row (A2 wiring proven). Assigned srv_local_mac
  (local-first ✓).
- PlanningView live during mint (elapsed, model, intent echo) — worked as designed.
- **UI defect #1 (fix-round):** stories ingested but the open tab kept showing
  "Planning… 8m46s / 0/0 stories" until manual reload. Cause: TanStack refetchInterval
  pauses when the tab is unfocused (refetchIntervalInBackground defaults false) — hidden-tab
  polling freeze. Fix candidate: refetchIntervalInBackground:true on useStoryNodes /
  useAgentJob / usePlan polls (cheap), or visibilitychange refetch.
- Post-reload: stage-aware tabs switched to the developing set (PLAN/STORIES/GIT GRAPH/
  STREAM/GRAPH), frontier strip live (Batch 0 0/1 · live), narrative panel present.
- Dev phase running; monitors armed (daemon log + plan-row transitions).

### I6 — Plan 0 dev: story e5057037 (pixel-art render) failed ×2 → repaired + retried

- Skeleton story: RED-first correctly rejected an unrunnable binding, self-healed on retry.
- Stepping story (0005ff3a): done cleanly, merged.
- Render story failed both attempts. Diagnosis:
  - **Pipeline defect #2 (structural, fix-round): touches↔testRef mismatch.** Test-author
    bound ac2 to `renderSnake` in `src/game/snake/contract.ts`, but declared touches only
    covered `src/components/canvas/` — the implementer had NO legal file to turn the test
    green (its out-of-scope work was discarded → "integrate: nothing to commit" → RED both
    attempts). Nothing validates that a binding's implementation surface lies within
    touches. Fix candidate: test-author-time check `testRef imports ⊆ touches ∪ existing`,
    else auto-widen touches or re-author.
  - **Pipeline defect #3 (noise): advisory-taste ACs still get a per-story browser-probe
    binding attempt** ("browser probe not interpretable" ×3 for ac1, verify=appearance,
    acClass=advisory-taste). Non-blocking, but wasteful + confusing; story-level binding
    should skip advisory-taste entirely (the new wave-gate observe lane owns them now).
  - Implementer residue `src/app/page.tsx` left dirty (pacman defect #7 recurrence).
- Operator repair: cleaned tree (kept daemon dirs), widened story touches to include
  `src/game/snake/contract.ts`, POST /stories/:id/retry → 200, state=ready.
- Note: hub API is NOT proxied at hub.futurator.ai/api — the UI calls the Lambda URL
  directly; token store key is `futurator_tokens`.

### I7 — Pipeline defect #4: sibling RED-test contamination (the big one this run)

- Stepping story 0005ff3a implemented correctly (advance/turn committed) but its completion
  gate went red off the SIBLING render story's artifacts: the sibling's RED-authored
  contract test imports `renderSnake` (not yet implemented) → whole-tree
  `project-build.test.ts` (tsc --noEmit) fails + contract tests fail + browser journey
  FAILs (dev server sees the same tree). Batch-parallel stories poison each other's gates
  by design when RED-first authors tests before siblings implement. Terminal-failed at 1
  attempt (no retry for gate-red-not-attributable-to-own-diff).
- Fix candidates (fix-round): (a) completion gate scopes vitest to the story's own bound
  testRefs + invariants (not the whole suite) while sibling stories are in flight;
  (b) project-build/tsc test runs at wave-merge only, not per-story mid-batch;
  (c) failure attribution — if gate-red files ∉ story touches ∪ testRefs, classify as
  'sibling-contamination' and auto-requeue instead of terminal fail.
- Interim: render story done → retried stepping (state=ready). Implementer's own analysis
  in the job log correctly identified the contamination ("failures are from a sibling RED
  story — not my touch points") but the gate had no lane to express that.

### I8 — OPERATOR CORRECTION → stage-FIRST navigation redesign (design v2)

Operator: stage chips must BE the navigation (App > Plans > Stage), each stage owning its
own panel + subtabs; my v1 (one flat tab row filtered by current status) is wrong. New IA:

**URL: /labs3?planId=X&stage=<s>&subtab=<t>** (deep-linkable; legacy subtab-only URLs map
via stageForSubtab). localStorage STAGE_KEY finally used (per-plan suffix like SUBTAB_KEY).

**5 stages (all ALWAYS clickable — selection ≠ progress; chips show done/active/pending
progress state PLUS a distinct selected ring):**

1. concept — subtabs: planner (default) | plan
   · planner = phase stepper + elapsed + model + LIVE planner stream + failure card
   · plan = narrative front-and-center + spec DAG (existing SpecGraphView)
2. development — subtabs: stories (default) | graph | gitgraph | codegraph | stream | growth
   · Topological-frontier strip moves INSIDE this panel (no longer global)
3. qa — single panel (subtab row hidden when a stage has one subtab): qa-review-view as-is
4. deployment — DeploymentView: DevUrlCard + dev→staging ladder + promote-to-staging +
   release history
5. publish — PublishView (new): production card, promote-to-production CTA (gated on
   qaReadiness), live URL, published status, release history
   stageForStatus: concept→1, developing/fixing→2, review→3, delivered→(deployUrl?5:4).

**Planner stream (missing wire):** daemon quick-planspec-runner gets an onText(text)
callback per parsed assistant chunk → agent-daemon wires it to pushEvent(jobId, <phase>,
'planner', 'agent_text', {text}) (throttled, capped); UI reuses use-agent-events with
refetchIntervalInBackground:true. Also fixes UI defect #1 (background-tab poll freeze) on
useStoryNodes/useAgentJob/use-agent-events polls.

Vercel web-interface-guidelines fetched and applied (URL-synced tabs, focus-visible,
aria, loading…, purposeful empty states for pending stages).
