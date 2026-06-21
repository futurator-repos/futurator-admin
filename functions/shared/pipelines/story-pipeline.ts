import type { EpicStory } from '../types/epic-workflow';
import type { PipelineDefinition, PipelineStep } from '../types/agent-orchestrator';
import type { PlanRigor } from '../types/plan';
import type { BoilerplateType } from '../boilerplates/registry';
import { BOILERPLATE_REGISTRY } from '../boilerplates/registry';
import { buildAgentConfig } from './role-policy';
import { buildFrameworkDetectSnippet, buildPortDrainLines } from './framework-detect';
// PR-91-followup (Story 2-A-3-1) — API-AUTHOR step before test-author.
import { buildApiAuthorPrompt } from '../prompts/api-author-prompt';
// PR-73 + PR-85 wired in: shell-time trailer emission for the per-story
// commit (Skills-Used / Skills-Manifest-Sha). Previously the helpers lived
// in the daemon and were never imported; now they live here so the
// Lambda-built compile-commit-on-pass actually emits them under mvp+.
import { buildCommitShellSnippet } from './commit-metadata';
import { deriveProjectId } from './derive-project-id';

/**
 * PR-91-followup gate. Stub boilerplates (sst / vite / mobile) don't ship
 * a test infrastructure today; running API-AUTHOR against them would
 * produce a `.d.ts` no test imports from. Local mirror of the same
 * decision in `api-author-pipeline.ts::shouldRunApiAuthor` — duplicated
 * here so this file doesn't take a dep on api-author-pipeline.ts at the
 * step-construction boundary.
 */
function shouldRunApiAuthorForKind(kind: BoilerplateType): boolean {
  return kind !== 'sst' && kind !== 'vite' && kind !== 'mobile';
}

/**
 * Story E.1 — feature flag for the wave-close knowledge compiler. When
 * `true`, the per-story `compile-knowledge` + `compile-sync` steps are
 * excluded from the story pipeline; the story ends after `compile-diff`
 * and a separate wave-compile job (Epic E.2) batches all of the wave's
 * knowledge work into a single Haiku turn. Default `false` keeps the
 * legacy per-story flow until E.2's cron dispatcher is wired live.
 *
 * Read at pipeline-build time (the API Lambda + cron build pipelines).
 * Exposed via a getter so tests can flip the env var per-case.
 */
export function isWaveCloseCompilerEnabled(): boolean {
  return process.env.WAVE_CLOSE_COMPILER_ENABLED === 'true';
}

/**
 * Per-story step-based pipeline.
 *
 * Phase C.3 extended this with rigor-gated test steps:
 *   prototype: dev → review → retry → compile-*
 *   mvp:      test-author → dev → test-verify → review → retry → compile-*
 *   production:test-author → test-gate-red → dev → test-verify → tamper-check
 *              → review → retry → compile-*
 *
 * Steps other than dev/review/retry are always no-op for prototype. The
 * tamper-check step auto-reverts unauthorized edits to test files and
 * increments a per-story tamperCount (Phase C.4).
 *
 * Story 16.2 extracted this out of `functions/api/index.ts` so the cron-driven
 * wave-completion reducer can invoke `launchPipelineWave` for wave N+1 without
 * bundling the whole Hono app into the cron Lambda.
 */
export function generateStoryPipeline(
  story: EpicStory,
  epicTitle: string,
  workingDir: string,
  opts: {
    devModel?: string;
    devEffort?: string;
    reviewerModel?: string;
    reviewerEffort?: string;
    testModel?: string;
    epicId?: string;
    /** Plan rigor dial — drives which test steps are included. Defaults to 'mvp'. */
    rigor?: PlanRigor;
    /**
     * Boilerplate kind — drives the typed RolePolicy resolver (PR-32). Today
     * the resolver doesn't branch on kind, but the field exists so future
     * Phase 2-D work (per-stack test runners, Vite vs Next.js conventions)
     * can plug in without touching every call site.
     */
    boilerplateKind?: BoilerplateType;
    /** When true, also author Playwright browser tests (not just unit). */
    hasBrowserTests?: boolean;
    /**
     * Story A.6: how the deployed project is started for runtime verification
     * (e.g. `python3 -m http.server 8080`, `npm run dev`, `vite`). Surfaced
     * to DEV/REVIEWER/COMPILER prompts via `<run_command>` so the DEV does
     * NOT spin up its own ad-hoc `npm run dev` / `node --check` loops just
     * to confirm syntax. Defaults to a vanilla static server.
     */
    runCommand?: string;
    /**
     * Pipeline v2.0 T0.2 — daemon-side pre-DEV gate.
     * ISO timestamp passed verbatim to `git log --since=` when the gate
     * checks for recent commits in the story's touchPoints. Plan-build /
     * launcher should set this to `plan.createdAt`. Optional; absent
     * disables Signal 1 (commits) and the gate falls through to spawn DEV.
     */
    planStartTime?: string;
    /**
     * 2026-05-19 — kebab-case plan slug. When set, compile-commit-on-pass
     * switches the worktree to `plan/<slug>` before staging — so daemon
     * commits land on a per-plan branch instead of the worktree's default
     * branch (typically `main` for brownfield). Idempotent for parallel
     * stories; absent → commits to current branch (legacy).
     *
     * Also stamped into commit-message trailer (`Plan: <slug>`).
     */
    planSlug?: string;
    /**
     * 2026-05-19 — DDB Plan row id. Stamped into commit-message trailer
     * (`Plan-Id: <id>`). The plan-delete cascade greps `main` for residual
     * commits with this id and reports the count to the operator.
     */
    planId?: string;
    /**
     * Story 20.12 (party-push Epic 20) — pin the per-story worktree to an
     * exact commit SHA at pipeline-baking time. When set,
     * `compile-commit-on-pass` runs `git checkout <sha>` BEFORE creating
     * the plan branch — so the plan branch starts at the pinned SHA, not
     * main's current HEAD. Caller (the launcher / API route) is
     * responsible for validating `/^[a-f0-9]{40}$/`. Optional: when
     * absent, the plan branch starts at the worktree's current HEAD
     * (current behavior).
     */
    sourceCommitSha?: string;
  },
): PipelineDefinition {
  // 2026-05-30 — worktree-aware. Under the per-story worktree model workingDir
  // is /home/ubuntu/worktrees/<appId>/<planSlug>/<storyId>, whose last segment
  // is the STORY id — deriving projectId from it keyed knowledge by storyId
  // (knowledge-live/<storyId>/ + Memgraph per-story) so the graph-viewer's
  // knowledge-live/<appSlug>/ fetch 404'd and the graph never grew. This helper
  // returns the appId for both worktree + legacy /projects/<appId> layouts.
  const projectId = deriveProjectId(workingDir);
  const rigor: PlanRigor = opts.rigor || 'mvp';
  const boilerplateKind: BoilerplateType = opts.boilerplateKind || 'nextjs-base';
  // VQA v3 E8.1 — the verifiability seam for this app (if any). When present,
  // the VISUAL_TESTS prompt teaches the probe model (reach→act→assert against
  // window.__harness) for behavior/state ACs instead of idle-screenshot judging.
  const seam = BOILERPLATE_REGISTRY[boilerplateKind]?.testHarness;
  const seamSnapshotKeys = seam
    ? Object.keys(seam.snapshotShape).map((k) => k.replace(/^snapshot\./, ''))
    : [];
  const testsOn = rigor !== 'prototype';
  // PR-41 (Story 2-A-5-1): tamper-check promoted from production-only to
  // mvp+. The Phase 1 implementation gated this to production rigor because
  // it was untested at lower rigors; v2.5 §16 specifies mvp+ scope and the
  // brick-breaker incident class fires regardless of rigor. The shell
  // snippet below is unchanged in mechanics — `git diff --name-only HEAD`
  // against the TEST-authored file set, auto-revert on detection.
  const tamperOn = testsOn;
  const redGateOn = rigor === 'production';
  // Story A.6: <run_command> default (Python static server) — overridable at
  // plan creation. Wired into the DEV prompt's VERIFICATION section so the
  // dev knows the canonical "how do I run this" command instead of guessing.
  const runCommand = opts.runCommand || 'python3 -m http.server 8080';
  // Story E.1: gate the per-story compile-knowledge + compile-sync steps
  // behind the wave-close-compiler feature flag. compile-commit-on-pass and
  // compile-diff still run — they collect the data the wave-close compiler
  // (Epic E.2) consumes from each story.
  const waveCloseEnabled = isWaveCloseCompilerEnabled();

  // 2026-06-02 (#2) — a verification-only story (ALL acceptance criteria are
  // browser checks, no code deliverable) legitimately produces no committable
  // source. The commit gate must NOT hard-fail it (that blocked plan-3 on a
  // PM-generated "Browser smoke test" story). For these, commit --allow-empty
  // and record the story done. Normal code stories keep the empty-commit guard
  // (the sibling-sweep / dead-DEV protection). #1 (PM prompt) stops these from
  // being generated; this is the safety net for any that slip through.
  // Narrow (2026-06-02): require BOTH a verification-y TITLE and all-browser
  // ACs. Earlier `every(needsBrowser)` alone mis-classified normal UI code
  // stories (e.g. "Wire W jump and S duck keys…") — whose ACs are naturally
  // all screen-observable — as verification-only, which would let a genuine
  // no-source DEV failure commit empty and silently lose code. A real feature
  // story keeps the hard empty-commit guard; only an explicit smoke/verify/e2e
  // story (which #1 tells the PM not to create anyway) gets the allow-empty.
  const verificationTitle =
    /\b(smoke[\s-]?test|e2e|end[\s-]?to[\s-]?end|integration[\s-]?test|qa[\s-]?pass|verification|verify)\b/i.test(
      story.title || '',
    );
  const verificationOnly =
    verificationTitle &&
    Array.isArray(story.criteria) &&
    story.criteria.length > 0 &&
    story.criteria.every((c) => c.needsBrowser === true);

  // P1 (pong1 2026-06-12): the declared touchPoints ARE the story's ship
  // contract. The commit step's snapshot-diff staging (comm -23 vs
  // capture-dev-baseline) subtracts everything already present at baseline —
  // and on a RETRY job reusing the same worktree, the FIRST attempt's
  // untracked output IS the baseline, so it was permanently un-stageable:
  // pong1 wave-0 shipped without court-preview.feature.tsx while the smoke
  // validated it sitting on disk (validated ≠ shipped, story edition).
  // Fix: stage every declared touchPoint that exists on disk UNCONDITIONALLY
  // after the snapshot-diff (covers the retry case without retry detection),
  // and trip STORY_COMMIT_INCOMPLETE post-commit if any touchPoint on disk is
  // still absent from HEAD. Sentinels like '<EPIC_WIDE>' are not paths.
  const shipTouchPoints = (story.touchPoints || []).filter(
    (tp): tp is string => typeof tp === 'string' && tp.length > 0 && !tp.startsWith('<'),
  );
  const quotedTouchPoints = shipTouchPoints.map((tp) => `'${tp.replace(/'/g, "'\\''")}'`).join(' ');

  return {
    initialVariables: {
      STORY_ID: story.storyId,
      EPIC_ID: opts.epicId || '(not provided)',
      PROJECT_ID: projectId,
      // Pipeline v2.0 T0.2 — daemon-side pre-DEV gate inputs. The daemon's
      // executePipeline reads these BEFORE spawning the dev step; if all
      // three signals (recent commits + AC exports + tsc clean) pass, the
      // job short-circuits to COMPLETED_VIA_PREWORK without spawning the
      // LLM. Empty / unset values disable individual signals (gate falls
      // through to spawn DEV normally).
      AC_TEXT: story.description || '',
      TOUCH_POINTS: JSON.stringify(story.touchPoints || []),
      PLAN_START_TIME: opts.planStartTime || '',
      // Surface runCommand for the daemon's cached typecheck (Signal 3) so
      // it doesn't have to default to `npx tsc --noEmit`.
      RUN_COMMAND: runCommand,
    },
    maxIterations: 3,
    agents: {
      // PR-32 — agent allowlists resolved from the typed RolePolicy at spawn
      // time. The resolver carries forward Phase 1 PR-3's tightening (PR-3
      // baseline deny: Task / Agent / WebFetch / WebSearch on every role) and
      // adds the v2.5 §10 read-only stance for REVIEWER/COMPILER. Tunable in
      // one place (`role-policy.ts`); call sites stay declarative.
      DEV: buildAgentConfig({
        boilerplateKind,
        rigor,
        role: 'DEV',
        name: 'Developer',
        model: opts.devModel || undefined,
      }),
      REVIEWER: buildAgentConfig({
        boilerplateKind,
        rigor,
        role: 'REVIEWER',
        name: 'Code Reviewer',
        model: opts.reviewerModel || undefined,
      }),
      // Phase C.3: TEST agent (Tier 1). Scoped to writing test files only —
      // unit tests in `*.test.*` / `__tests__/**` and browser tests in
      // `e2e/**` / `tests/**`. The tamper-check step (C.4) enforces that
      // Dev doesn't edit these outputs.
      TEST: buildAgentConfig({
        boilerplateKind,
        rigor,
        role: 'TEST',
        name: 'Test Author',
        model: opts.testModel || 'sonnet',
      }),
      // PR-91-followup (Story 2-A-3-1) — API-AUTHOR agent. Emits the
      // frozen `.d.ts` between PM and TEST so both TEST and DEV import
      // names from the same surface. Skipped under prototype rigor; the
      // step itself is conditional (see steps[] below).
      API_AUTHOR: buildAgentConfig({
        boilerplateKind,
        rigor,
        role: 'API_AUTHOR',
        name: 'API Author',
      }),
      COMPILER: buildAgentConfig({
        boilerplateKind,
        rigor,
        role: 'COMPILER',
        name: 'Knowledge Compiler',
        // Story A.1: env-gated, default 'haiku'. Set COMPILER_MODEL=sonnet to
        // roll back if Haiku output quality regresses on a given epic.
        // Haiku is also kinder on t2.micro memory than Sonnet.
        model: process.env.COMPILER_MODEL || 'haiku',
      }),
    },
    steps: [
      // pacman1 root-cause (2026-06-11) — capture the commit baseline as the
      // FIRST pipeline step, before ANY agent runs. It used to sit just
      // before DEV, which silently excluded everything api-author and
      // test-author wrote (the frozen `index.d.ts` interface surface,
      // vitest.config.ts, package.json test script + deps) from the story
      // commit: the story validated green against files it never shipped,
      // and the wave-merge candidate — built from committed branches only —
      // failed typecheck on imports of the uncommitted contract file.
      // Invariant restored: in a per-story worktree, every file any agent
      // writes after this snapshot is this story's work and ships with it.
      // (The original post-test-author placement guarded the legacy SHARED
      // worktree subsumption race; per-story worktrees made that obsolete.)
      {
        id: 'capture-dev-baseline',
        stepType: 'shell' as const,
        command:
          `cd ${workingDir} && ` +
          `mkdir -p .pipeline && ` +
          `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then ` +
          `  git diff --name-only > .pipeline/${story.storyId}-baseline-dirty.txt 2>/dev/null || true; ` +
          `  git ls-files --others --exclude-standard > .pipeline/${story.storyId}-baseline-untracked.txt 2>/dev/null || true; ` +
          `  DIRTY_COUNT=$(wc -l < .pipeline/${story.storyId}-baseline-dirty.txt); ` +
          `  UNTRACKED_COUNT=$(wc -l < .pipeline/${story.storyId}-baseline-untracked.txt); ` +
          `  echo "BASELINE_CAPTURED story=${story.storyId} baseline_dirty=$DIRTY_COUNT baseline_untracked=$UNTRACKED_COUNT"; ` +
          `else ` +
          `  echo "BASELINE_SKIPPED_NOT_A_REPO story=${story.storyId}"; ` +
          `fi`,
        timeout: 10000,
        captureAs: 'CAPTURE_DEV_BASELINE_OUTPUT',
        onFail: { action: 'continue' as const },
      } as unknown as PipelineStep,

      // PR-91-followup (Story 2-A-3-1) — API-AUTHOR step runs BEFORE
      // test-author so TEST and DEV both `import type { ... } from
      // './index'` against the same frozen surface. Skipped under
      // prototype rigor (no test infrastructure to anchor names to);
      // skipped for stub boilerplates that haven't shipped tests.
      // Module dir is inferred from the story's touch points at
      // dispatch time — wiring threads `opts.apiAuthorModuleDir`.
      ...(testsOn && shouldRunApiAuthorForKind(boilerplateKind)
        ? ([
            {
              id: 'api-author',
              agentId: 'API_AUTHOR',
              prompt: buildApiAuthorPrompt({
                storyId: story.storyId,
                storyTitle: story.title,
                acceptanceCriteria: story.description || '',
                // Touch-point inference happens daemon-side at dispatch;
                // when absent, the daemon emits attention.api-author-
                // ambiguous-module and the operator picks. Until the
                // inference wire-in lands, the empty string causes the
                // agent to declare the module relative to the story id.
                moduleDir: 'src',
                existingExports: { types: [], constants: [] },
              }),
              extractors: {},
              validations: [],
            },
            // v3 E4-S2 — ENFORCED contract freeze, scoped to "validate IF a
            // contract exists" (fixed 2026-06-20 after pacmanv3 wedged on it).
            //
            // api-author is BEST-EFFORT: it legitimately writes NO contract when
            // the types already exist — e.g. the nextjs-canvas-game boilerplate
            // pre-bakes `src/game/types.ts`, so a redundant top-level
            // `src/index.d.ts` is correctly skipped (it only Read/Glob'd, never
            // Wrote). The first cut FAILED hard on an absent contract and looped
            // api-author forever (it re-made the same read-only decision), so the
            // foundation story — and the whole plan — was blocked.
            //
            // Correct scope (REPORT-ONLY — always exits 0, never blocks the
            // story). An ABSENT/empty contract is the tolerated no-frozen-surface
            // case (the pre-E4-S2 behavior) → pass, dev uses the existing types.
            // When api-author DID write a contract, run the project's LOCAL tsc
            // (never `npx` — that fetches the decoy `tsc` npm package when
            // typescript isn't resolvable) and merely WARN in the log if it does
            // not typecheck. The first cut hard-failed on both absence AND
            // isolated-`.d.ts` tsc fragility (relative-import resolution), wedging
            // the foundation story and the whole plan. Re-hardening to enforcement
            // needs a proven isolated typecheck (or a wave-level check); until
            // then, surfacing beats wedging. Pacman1-safe either way.
            {
              id: 'api-contract-freeze',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                `CONTRACT="src/index.d.ts"; ` +
                `if [ ! -s "$CONTRACT" ]; then ` +
                `  echo "API_CONTRACT_ABSENT: no $CONTRACT — story has no frozen contract surface (pre-baked/existing types); nothing to freeze, continuing to dev"; exit 0; ` +
                `fi; ` +
                `TSC="./node_modules/.bin/tsc"; ` +
                `if [ -x "$TSC" ] && [ -f tsconfig.json ]; then ` +
                `  if "$TSC" --noEmit --skipLibCheck "$CONTRACT" > /tmp/contract-tsc.log 2>&1; then ` +
                `    echo "API_CONTRACT_FROZEN_OK sha=$(sha256sum "$CONTRACT" 2>/dev/null | cut -d' ' -f1)"; ` +
                `  else ` +
                `    echo "API_CONTRACT_TSC_WARN — the contract did not typecheck in isolation (may be import resolution, not a real defect) — surfaced, NOT blocking (E4-S2):"; ` +
                `    tail -20 /tmp/contract-tsc.log; ` +
                `  fi; ` +
                `else echo "API_CONTRACT_FROZEN_OK (local tsc/tsconfig unavailable — typecheck skipped)"; fi`,
              timeout: 120000,
              captureAs: 'API_CONTRACT_FREEZE_OUTPUT',
            },
          ] as unknown as PipelineStep[])
        : ([] as PipelineStep[])),
      // Phase C.3: TEST agent authors failing tests BEFORE dev runs (mvp +
      // production). Skipped for prototype.
      ...(testsOn
        ? ([
            {
              id: 'test-author',
              agentId: 'TEST',
              prompt: `<project_context>
{{PROJECT_CONTEXT}}
</project_context>

You are the TEST agent authoring tests for story ${story.storyId}.

Working directory: ${workingDir}

## Story
${story.title}

${story.description}

## DISCOVERY (dino4 fix 2026-04-27 — extends Story A.6 hygiene to TEST):
- Project tree, plan, story spec, AC, knowledge index, recent diffs, and prior story work summaries are inlined in your \`<project_context>\` block above. Read it FIRST before any tool call.
- Do NOT spawn the Task / Agent / Explore subagents. They re-read the codebase and burn 10–25 tool calls per turn for context you already have.
- Do NOT run \`ls\`, \`find\`, \`tree\`, or \`Bash cat\` on the project directory.
- Read at most the existing test files you intend to UPDATE (in ONE message with parallel Read calls). Do NOT speculatively Read source files — the dev will write them next, and your job is the tests, not the source.

## VERIFICATION (dino4 fix):
- Do NOT run \`npm test\`, \`npx vitest\`, \`npm run dev\`, or any test/build runner. The downstream \`test-gate-red\` (production rigor only) and \`test-verify\` (mvp+) shell steps run them for you. Your job is to author tests, not verify they fail.
- Do NOT Read a file you just Wrote — Write/Edit error on failure; their silent return IS the verification.

## EARLY-EXIT (dino4 fix — no-op detection):
If the story's acceptance criteria are ALREADY covered by existing test files in this project (e.g. a prior TEST-agent run left behind \`src/foo.story.test.ts\`), DO NOT re-author them. Instead emit:

\`\`\`
---TEST_FILES---
[paths of existing files that cover this story's ACs]
---END_TEST_FILES---

---AC_TEST_MAP---
AC-1: <test file> :: "<case name that asserts AC-1>"
---END_AC_TEST_MAP---

---WORK_SUMMARY---
No changes required — tests for story ${story.storyId} already authored: <list paths>. Each AC is mapped: AC-1 → <test file:line range>, etc.
---END_WORK_SUMMARY---
\`\`\`

…and stop. The dev agent will run those existing tests as the contract. Do NOT keep editing or "improving" tests that already cover the AC — that's the loop that burned $20+ per attempt on dino4 e2w0s1.

## Your job (when tests do NOT already exist)
1. Write unit tests that cover the acceptance criteria of this story.
2. Put unit tests beside the code they cover (e.g. \`src/foo/bar.test.ts\`) or under \`__tests__/\`.${
                opts.hasBrowserTests
                  ? `
3. **PR-64 (integration test contract)** — Because this story has
   browser-testable ACs, you MUST also author at least ONE integration
   test that exercises the framework's actual entry point with realistic
   wiring. Unit tests that mock the DOM/canvas/framework cannot catch
   "module exists but is never imported from the entry" — only an
   integration test that boots the real app can. This is the bug class
   that lets stories ship green while their code is orphaned.

   The integration test must, at minimum:

     (a) Import or invoke the FRAMEWORK ENTRY POINT — not the unit under
         test directly. Look at the project's \`index.html\`,
         \`src/main.{ts,tsx,jsx,js}\`, \`app/layout.tsx\`, or equivalent.
     (b) Use the framework's standard testing harness:
         • React (Vite/Next/Remix): \`@testing-library/react\` + jsdom
           or happy-dom. \`render(<App />)\`; assert with \`screen.getBy*\`.
         • Vue/Nuxt: \`@vue/test-utils\` + happy-dom.
         • Solid: \`@solidjs/testing-library\`.
         • Svelte/SvelteKit: \`@testing-library/svelte\` + jsdom.
         • Canvas/game: jsdom + \`canvas\` (or \`canvas-mock\`); run the
           game loop for N ticks via \`requestAnimationFrame\` polyfill
           or \`vi.useFakeTimers()\`, then inspect observable state
           (\`game.entities.length\`, \`ctx.drawImage\` call args).
         • Plain DOM/no framework: jsdom; assert via \`document.querySelector\`.
     (c) Assert OBSERVABLE state, not internal mocks. Examples per kind:
         • Form: assert the rendered DOM has the expected inputs by label,
           that submitting fires \`fetch\` to the right URL with expected
           body, that error messages appear in the right \`<div>\`.
         • Dashboard: assert the chart's SVG has the expected number of
           \`<rect>\` or \`<path>\` elements; assert the panel header text
           matches.
         • Animation: advance fake timers; assert the element's class or
           style differs between t=0 and t=500ms.
         • Game: spin frames for ~1 second of simulated time; assert
           entity counts / state-machine state advances as the AC
           describes.
         • Marketing site: \`render(<Page />)\`; assert the H1 text matches
           the spec.

   ❌ Anti-patterns the integration test must NOT use:
     • Mocking the framework's render function so calls are observed
       without rendering happening.
     • Asserting only "function X was called once" — that's a unit
       guarantee, not an integration one.
     • Testing the module in isolation when the AC describes what the
       USER sees on screen.

   Put integration tests under \`src/__tests__/integration/\` (or
   \`tests/integration/\` if the project already has that root). Name the
   file after the AC it verifies. ONE integration test for the story's
   primary user-visible AC is sufficient; unit tests still cover the
   detailed sub-cases.

4. (Optional) Additionally, write Playwright browser tests under \`e2e/\` covering the [needs_browser=true] criteria when the project already has Playwright wired up.`
                  : ''
              }
5. DO NOT implement the feature code — only the tests.
6. Tests MUST initially fail (red state). The Dev agent will make them pass.

## Rules
- Only write in test paths: \`**/*.test.*\`, \`__tests__/**\`, \`e2e/**\`, \`tests/**\`.
- Output the list of test files you authored (or recognized as already covering the AC) at the end:

---TEST_FILES---
src/foo.test.ts
e2e/home.spec.ts
---END_TEST_FILES---

---AC_TEST_MAP---
AC-1: src/foo.test.ts :: "renders the score HUD at 0"
AC-2: src/__tests__/integration/game-loop.test.ts :: "obstacle x decreases over 240 ticks"
---END_AC_TEST_MAP---

---WORK_SUMMARY---
[What tests you wrote and why — OR "No changes required" per EARLY-EXIT above]
---END_WORK_SUMMARY---

The AC_TEST_MAP block (Step-0.5) is REQUIRED: one line per AC id this
story's tests ASSERT, in the exact form \`<AC-id>: <test file> :: "<case
name>"\`. Only list an AC when a test case genuinely asserts that AC's
condition — the runtime visual review treats mapped ACs as verified by the
suite and skips screenshot-judging them, so a dishonest mapping ships an
unverified AC. Leave an AC out when no test asserts it (the screenshot
judge keeps jurisdiction). Browser ACs about dynamic behaviour (motion,
spawning, score over time) SHOULD be mapped — drive the game loop N ticks
in an integration test and assert observable state; a static screenshot
can never verify them.`,
              extractors: {
                TEST_FILES: {
                  type: 'between' as const,
                  startDelimiter: '---TEST_FILES---',
                  endDelimiter: '---END_TEST_FILES---',
                },
                AC_TEST_MAP: {
                  type: 'between' as const,
                  startDelimiter: '---AC_TEST_MAP---',
                  endDelimiter: '---END_AC_TEST_MAP---',
                },
                WORK_SUMMARY: {
                  type: 'between' as const,
                  startDelimiter: '---WORK_SUMMARY---',
                  endDelimiter: '---END_WORK_SUMMARY---',
                },
              },
              validations: [],
            },
          ] as PipelineStep[])
        : []),

      // 2026-05-19 — stage-test-files. Runs immediately after test-author so
      // tamper-check's baseline is "what test files looked like when TEST
      // finished", not "what they looked like at HEAD". Without this step the
      // snake-4 Wave-0 failure pattern fires — test-author legitimately
      // `Edit`s an existing tracked test file, the diff vs HEAD shows the
      // change, tamper-check misattributes it to DEV.
      //
      // `git add -f` because a test path could be gitignored (e.g. e2e/).
      // Best-effort: missing files are skipped silently. EARLY-EXIT from
      // test-author (no new tests authored) drops through with no work.
      ...(testsOn
        ? ([
            {
              id: 'stage-test-files',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                `mkdir -p .pipeline && ` +
                `cat > .pipeline/tamper-input.txt << 'EOF_TAMPER'\n` +
                `{{TEST_FILES}}\n` +
                `EOF_TAMPER\n` +
                `grep -E '\\.(test|spec)\\.[jt]sx?$|^e2e/|^tests/' .pipeline/tamper-input.txt > /tmp/tamper-expected.txt 2>/dev/null || true; ` +
                `if [ ! -s /tmp/tamper-expected.txt ]; then ` +
                `  echo 'STAGE_TEST_FILES_SKIPPED: no test files extracted (test-author EARLY-EXIT or empty TEST_FILES)'; ` +
                `  exit 0; ` +
                `fi; ` +
                // pacman4 deadlock fix (2026-06-19) — VALIDATE the authored test
                // files BEFORE they become the tamper baseline. They are the
                // contract, owned by test-author; a lint/parse error inside one
                // cannot be repaired by DEV (tamper-check reverts any DEV edit to
                // a test file), so lint-verify→lint-fix would deadlock forever
                // (the pacman4 collision story: `it('pac-man's …')` — apostrophe
                // in a single-quoted string — looped lint-fix→tamper-revert until
                // retries exhausted). `eslint --fix` folds auto-fixables into the
                // staged blob; any REMAINING error exits 1 and loops back to
                // `test-fix-author` (resumeFromStep: test-author) so the contract
                // owner — never DEV — repairs its own files. Lint only the test
                // files that exist on disk; brownfield apps without a flat config
                // skip the check and just stage (legacy behaviour).
                `EXIST=$(mktemp); ` +
                `while IFS= read -r f; do [ -n "$f" ] && [ -f "$f" ] && echo "$f"; done < /tmp/tamper-expected.txt > "$EXIST"; ` +
                `if [ -s "$EXIST" ] && [ -f eslint.config.mjs ]; then ` +
                `  LINT_RC=0; ` +
                `  tr '\\n' '\\0' < "$EXIST" | xargs -0 npx eslint --fix > /tmp/stage-test-lint.log 2>&1 || LINT_RC=$?; ` +
                `  if [ "$LINT_RC" -ne 0 ]; then ` +
                `    echo 'TEST_AUTHOR_LINT_FAILED — authored test files do not lint/parse. They are the contract; DEV may not edit test files (tamper-check reverts them), so test-author must fix its own files:'; ` +
                `    tail -80 /tmp/stage-test-lint.log; ` +
                `    exit 1; ` +
                `  fi; ` +
                `fi; ` +
                `STAGED=0; SKIPPED=0; ` +
                `while IFS= read -r f; do ` +
                `  if [ -n "$f" ] && [ -f "$f" ]; then ` +
                `    git add -f -- "$f" 2>/dev/null && STAGED=$((STAGED+1)) || SKIPPED=$((SKIPPED+1)); ` +
                `  else SKIPPED=$((SKIPPED+1)); ` +
                `  fi; ` +
                `done < /tmp/tamper-expected.txt; ` +
                `echo "STAGE_TEST_FILES_OK staged=$STAGED skipped=$SKIPPED"`,
              timeout: 60000,
              captureAs: 'STAGE_TEST_FILES_OUTPUT',
              expectExitCode: 0,
              // Hard gate WITH a loop: a lint failure routes to test-fix-author
              // (the contract owner) and re-checks; if still failing after the
              // fix loop the daemon fails the job (story retry is the backstop).
              onFail: { action: 'fail' as const, injectAs: 'TEST_LINT_ERROR' },
              loopTo: 'test-fix-author',
            },
            // pacman4 deadlock fix (2026-06-19) — loop-only fixer for the
            // stage-test-files lint gate. Runs ONLY as the loopTo target
            // (skipped in linear flow, daemon collects loopTargetIds). Resumes
            // the TEST session so it fixes the SAME files it authored, carrying
            // the captured eslint error. Mirrors the lint-fix/test-fix pattern
            // but stays on the TEST agent — DEV must never touch test files.
            {
              id: 'test-fix-author',
              agentId: 'TEST',
              resumeFromStep: 'test-author',
              prompt: `The test files you authored for story ${story.storyId} FAILED lint/parse validation (attempt {{ITERATION}} of {{MAX_ITERATIONS}}) — so they cannot become the test contract.

This is the \`eslint --fix\` output for YOUR test files. Auto-fixable problems were already repaired; everything below is a real error you must fix:

{{TEST_LINT_ERROR}}

Fix every error in the test files you authored, then re-emit the file list so the contract is re-staged.
- These are usually parse/syntax errors. The most common: an apostrophe inside a SINGLE-quoted string, e.g. \`it('returns X when pac-man's tile …')\` — the \`'\` closes the string early. Switch that \`it(...)\` description to DOUBLE quotes (\`it("…pac-man's…")\`) or escape the apostrophe.
- Other common causes: an unused import/variable, or a type-only import not using \`import type\`.
- Do NOT add \`eslint-disable\` comments and do NOT edit \`eslint.config.*\` — suppressing a rule is not a fix.
- Do NOT weaken or delete assertions; only fix what makes the file fail to lint/parse.
- Edit ONLY the test files. Do not write implementation code.

Re-emit the authored test file list (REQUIRED — the pipeline re-stages exactly these):

---TEST_FILES---
[the test file paths you fixed]
---END_TEST_FILES---

---WORK_SUMMARY---
[what you fixed]
---END_WORK_SUMMARY---`,
              extractors: {
                TEST_FILES: {
                  type: 'between' as const,
                  startDelimiter: '---TEST_FILES---',
                  endDelimiter: '---END_TEST_FILES---',
                },
                WORK_SUMMARY: {
                  type: 'between' as const,
                  startDelimiter: '---WORK_SUMMARY---',
                  endDelimiter: '---END_WORK_SUMMARY---',
                },
              },
              validations: [],
            },
          ] as unknown as PipelineStep[])
        : ([] as PipelineStep[])),

      // v3 E4-S3 — AC-coverage gate. test-author emits an AC_TEST_MAP (one line
      // per AC a test asserts) but NO deterministic step consumed it, so a
      // mapping that named a test file the author never wrote shipped an
      // unverified AC (the runtime visual review trusts mapped ACs and skips
      // screenshot-judging them). This gate parses the map and fails when any
      // MAPPED AC points at a test file that does not exist on disk — an
      // unambiguous dishonest mapping, so it never false-positives on an honest
      // plan (unmapped ACs are fine; the screenshot judge keeps jurisdiction).
      ...(testsOn
        ? ([
            {
              id: 'ac-coverage-gate',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && mkdir -p .pipeline && ` +
                `cat > .pipeline/${story.storyId}-ac-test-map.txt << 'EOF_ACMAP'\n` +
                `{{AC_TEST_MAP}}\n` +
                `EOF_ACMAP\n` +
                `MAPPED=0; MISSING=0; MISSING_LIST=""; ` +
                `while IFS= read -r line; do ` +
                `  case "$line" in *"::"*) ;; *) continue;; esac; ` +
                `  f=$(printf '%s' "$line" | awk -F'::' '{print $1}' | sed -E 's/^[[:space:]]*[A-Za-z0-9_-]+:[[:space:]]*//' | tr -d '[:space:]'); ` +
                `  [ -z "$f" ] && continue; ` +
                `  MAPPED=$((MAPPED+1)); ` +
                `  if [ ! -f "$f" ]; then MISSING=$((MISSING+1)); MISSING_LIST="$MISSING_LIST $f"; fi; ` +
                `done < .pipeline/${story.storyId}-ac-test-map.txt; ` +
                `if [ "$MISSING" -gt 0 ]; then ` +
                `  echo "AC_COVERAGE_FAILED — $MISSING AC→test mapping(s) name a test file that does not exist:$MISSING_LIST. A mapped AC is treated as verified-by-suite, so a missing file ships an unverified AC (E4-S3)."; exit 1; ` +
                `fi; ` +
                `echo "AC_COVERAGE_OK mapped=$MAPPED"`,
              timeout: 30000,
              captureAs: 'AC_COVERAGE_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'AC_COVERAGE_ERROR' },
            },
          ] as unknown as PipelineStep[])
        : ([] as PipelineStep[])),

      // Phase C.3: red-gate (production only). Runs tests and asserts they
      // FAIL — i.e. test-author wrote real tests, not tautologies that pass
      // without the feature code.
      // Shell contract: command is OK when tests fail (exit != 0). We invert
      // via `!`. The daemon step's expectExitCode (0) now corresponds to
      // "tests did fail", which is the green state for this gate.
      ...(redGateOn
        ? ([
            {
              id: 'test-gate-red',
              stepType: 'shell' as const,
              command: `cd ${workingDir} && ! npm test --silent > /tmp/test-gate-red.log 2>&1; tail -40 /tmp/test-gate-red.log || true`,
              timeout: 180000,
              captureAs: 'RED_GATE_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'RED_GATE_ERROR' },
            },
          ] as PipelineStep[])
        : []),

      // 1. Dev implements story
      // (capture-dev-baseline moved to the TOP of steps[] — see the
      // pacman1 root-cause note there. The commit step's snapshot-diff now
      // includes api-author's and test-author's writes in the story delta.)
      {
        id: 'dev',
        agentId: 'DEV',
        // Story B.2: <project_context> sits at the very top of the prompt so
        // the daemon's per-story serialized context pack is in the cacheable
        // prefix — DEV / REVIEWER / COMPILER all see the byte-identical block
        // and the prompt cache hits across roles. Daemon populates
        // PROJECT_CONTEXT before any step runs.
        prompt: `<project_context>
{{PROJECT_CONTEXT}}
</project_context>

You are a senior developer working on the "${epicTitle}" project.

This is attempt {{ITERATION}} of {{MAX_ITERATIONS}} for this story.

## Story to implement:
${story.title}

${story.description}

## Instructions:
- Implement ONLY this story. Do not work on other stories.
- Working directory: ${workingDir}
- If this is the first story, set up the project structure.
- Output a brief summary of what you did (not full file contents, show diffs or summaries).
- BEFORE implementing: your system prompt lists this project's vendored
  skills with the reason each was pinned. If one covers this story's domain
  (visual/canvas work, UI components, testing, domain workflows), invoke it
  via the Skill tool FIRST — it loads project-pinned conventions your
  implementation must follow. One Skill call; skip only if genuinely none apply.
- REQUIRED: the FIRST line of your final summary must be
  \`SKILL_DECISION: <skill-name> — <one-line why>\` or
  \`SKILL_DECISION: none — <one-line why no pinned skill applies>\`.
  If you name a skill you must have actually invoked it via the Skill tool
  before writing code — invocations are recorded in the commit trailer and
  audited against this line. A story touching UI, canvas, layout, or visual
  behavior on a project that pins a design/frontend skill should almost
  never be \`none\`.

## DISCOVERY (Stories A.6 + B.2):
- Your \`<project_context>\` block above already contains the project tree, plan, story spec, acceptance criteria, touch points, adjacent file heads, knowledge index, recent diffs, and prior story work summaries. Read it before doing anything else.
- Do NOT re-read what's already in \`<project_context>\`. Do NOT run \`ls\`, \`find\`, \`tree\`, or \`Bash cat\` on the project directory.
- Do NOT spawn the Task / Agent / Explore subagents — they re-read the codebase from scratch and burn 10–25 tool calls per turn for context you already have.
- Read at most the files you intend to modify. Do them in ONE message with parallel Read calls — never one Read per turn.

## VERIFICATION (Story A.6 + PR-40 Story 2-A-6-1):
- Do NOT Read a file you just Wrote or Edited. The Write/Edit tools error when they fail; their absence of an error IS the verification.
- Do NOT run \`npm run dev\`, \`node --check\`, or \`node --input-type=module\` for ad-hoc syntax checks. The project's runtime command is: \`${runCommand}\`. The build/test gates downstream of this step will catch real regressions.
- Do NOT run \`npm test\`, \`npx vitest\`, or any test runner. The pipeline's \`test-verify\` step (single-pass per v2.5 §17) runs the suite immediately after this step and is authoritative. Running tests yourself doubles cost and turn count for the same signal.
- Visual tests live at \`${workingDir}/visual-tests.md\` (the daemon merges your \`---VISUAL_TESTS---\` block into that file automatically, Story A.2). Treat it as the contract — your code must make every entry pass at runtime.${
          testsOn
            ? `

## Test contract (CRITICAL — tests already exist)

The TEST agent has already authored the failing tests for this story. They
are the source of truth for function names, field names, and signatures.

\`\`\`
{{TEST_FILES}}
\`\`\`

Rules:
1. **Do NOT create, overwrite, or edit any file listed above.** The tests
   are fixed; your code must conform to them, not the other way around.
2. **Read each test file first** before writing your implementation so
   you match the exact exported names and type shapes the tests import.
3. If the story wording contradicts the tests (e.g. story says
   "destroyedBrickIds", test imports "destroyedIds"), **follow the test**.
4. Tamper-check ${tamperOn ? '(enabled)' : '(disabled at this rigor)'} will ${tamperOn ? 'auto-revert any edits to test files and fail the step' : 'be skipped, but the next rigor tier would catch violations — treat the rule as binding anyway'}.`
            : ''
        }${
          story.hasBrowserTests
            ? `
## VISUAL TESTS (CRITICAL — PR-63 contract)

This story has browser-testable criteria (marked [needs_browser=true]). Each
such criterion MUST have a corresponding visual-test entry emitted between
the fences below.${
                seam
                  ? `

### Route each criterion by its [verify=…] tag (VQA v3 probe model)

A static idle screenshot cannot observe interaction, elapsed time, or
post-action state. This app ships a test-only verifiability seam at
\`${seam.globalKey}\` — author each criterion as a PROBE, not an idle frame:

  - **[verify=appearance]** → ONE screenshot + \`judge:\` (the L1 form below).
  - **[verify=state] / [verify=behavior]** → an **L2** entry with a \`flow:\`
    that REACHES the state, ACTS, then OBSERVES deterministically:
      • drive with \`press\`/\`hold\`/\`click\`/\`pointer\`; advance time with
        \`clock\` (NEVER a real \`wait\` for synchronization);
      • take a \`screenshot\` (paired vision — REQUIRED for UI-bearing ACs so a
        right-state/broken-UI defect can't pass on state alone); and
      • \`assert\` against the seam for a deterministic verdict.
  - **[verify=build]** → no visual test (a unit/typecheck covers it).

The seam's \`snapshot()\` exposes: ${seamSnapshotKeys.map((k) => `\`${k}\``).join(', ')}
(+ any field you add to the app's state — conform to the shape; do NOT author
the seam, it is pre-baked). Cite snapshot keys as \`snapshot.<key>\` in \`expr\`.

Worked behavior probe (start → advance time → observe + assert):
\`\`\`
- id: VT-${story.storyId}-1
  criteriaRef: AC-S<storyNum>-<n>
  description: <one sentence>
  setup: load the app
  expect: <concrete post-action result>
  level: L2
  flow:
    - { action: press, key: "Space" }
    - { action: clock, clockMode: runFor, ms: 5000 }
    - { action: screenshot, label: "mid-play" }
    - { action: assert, expr: "snapshot.${seamSnapshotKeys[0] ?? 'status'}", op: eq, expected: <value> }
  judge: |
    <what the mid-play screenshot must show; explicit FAIL conditions>
\`\`\`
`
                  : ''
              } The QA pipeline routes every entry to an LLM judge that
will look at a screenshot of your built code and decide pass/fail from the
PIXELS — not from your tests, not from your diff. So **the test's \`judge:\`
block is what your code is actually graded against.**

Required fields per entry:

  - \`id:\` — unique within the story, e.g. \`VT-${story.storyId}-1\`
  - \`criteriaRef:\` — the AC id this verifies (e.g. \`AC-S5-2\`)
  - \`description:\` — what to verify, in one sentence
  - \`setup:\` — how to get the page to the testable state
  - \`expect:\` — what the correct visual result looks like (concrete, no
    "looks fine" / "renders correctly" — the classifier rejects vague text)
  - \`level:\` — one of \`L0\` / \`L1\` / \`L2\`:
      • \`L0\` — bash-only check (HTTP 200, console-error scan, expectText
        substring). Use ONLY for non-visual ACs that happen to be browser-
        reachable (e.g., "the API returns 200 when called from the page").
      • \`L1\` — single-screenshot Haiku judge. **The default for any AC that
        describes how something LOOKS on screen.** ~$0.005/test.
      • \`L2\` — multi-step Sonnet judge with a flow. Use when the AC
        requires interacting before judging (click → screenshot → verify).
  - \`judge:\` — REQUIRED for L1 + L2. Plain-English success criteria that a
    person looking at the screenshot can apply. Phrase it as a check, not
    a description. Bad: "the chart renders correctly". Good: "a bar chart
    with exactly 3 vertical blue bars (#1E88E5) appears in the center of
    the page; if any of: chart missing / wrong number of bars / wrong
    color → FAIL."

If the criterion only checks something that happens to render text (e.g.
"the error message 'Invalid input' appears in red"), prefer \`L1\` over
\`L0\` — L0's \`expectText:\` doesn't verify color, position, or visibility,
just that the substring exists in the page source.

Output format:

---VISUAL_TESTS---
- id: VT-${story.storyId}-1
  criteriaRef: AC-S<storyNum>-<n>
  description: <one sentence>
  setup: <how to reach the state>
  expect: <concrete description of correct result>
  level: L1
  judge: |
    <one-line success criterion phrased as a check; describe what is
    visible (element, color, position, count, text) and explicit FAIL
    conditions. The judge sees ONLY the screenshot + this text.>
---END_VISUAL_TESTS---

Examples of GOOD \`judge:\` text (framework-agnostic):
  • Form button:    "the form's primary CTA labeled 'Save' is visible, has a
                     filled background distinct from the page background,
                     and is positioned below the input fields. FAIL if
                     missing, hidden, or styled as plain text."
  • Data chart:     "a bar chart with at least 2 vertical bars of distinct
                     heights is visible. FAIL if the chart area is empty or
                     shows a 'no data' placeholder."
  • Animation:      "the loading spinner is positioned center-screen and
                     visibly rotated relative to its initial state (the
                     screenshot is taken after T+500ms). FAIL if static or
                     absent."
  • Game canvas:    "the canvas shows the player sprite AND at least one
                     enemy sprite simultaneously. FAIL if only the player
                     is visible or the canvas is empty."
  • Marketing hero: "the page's H1 reads exactly '<expected text>', styled
                     with the brand font and at least 32px in size. FAIL if
                     missing, wrong text, or styled as body copy."

Write ONE visual test per needs_browser=true criterion. The text in
\`judge:\` is what catches integration bugs the per-story unit tests cannot
(e.g., 'module exists but is never wired to the entry point').`
            : ''
        }
- End with:
---WORK_SUMMARY---
[Brief summary of files created/modified and what was done]
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
          ...(story.hasBrowserTests && {
            VISUAL_TESTS: {
              type: 'between' as const,
              startDelimiter: '---VISUAL_TESTS---',
              endDelimiter: '---END_VISUAL_TESTS---',
            },
          }),
        },
        validations: [],
      },

      // Phase C.3 + PR-40 (Story 2-A-6-1): test-verify (mvp + production).
      //
      // v2.5 §17 single-pass-verification — DEV is instructed to NOT run
      // tests itself (see DEV prompt); test-verify is the authoritative
      // single pass. Optimization: try the changed-files-only run first
      // (`vitest --changed HEAD~1`); if vitest can't determine the changed
      // set or the project doesn't use git history that way, fall back to
      // the full suite. Both modes use the same exit code semantics.
      //
      // The `npx vitest run` form is preferred over `npm test` for the
      // changed-files mode because npm wrapper scripts often don't pass
      // `--changed` through cleanly. The fallback to `npm test` after the
      // `||` keeps the gate honest if vitest CLI flags drift.
      ...(testsOn
        ? ([
            {
              id: 'test-verify',
              stepType: 'shell' as const,
              // pacman4 fix (2026-06-19) — propagate the runner's exit code.
              // The previous form ended `; tail -80 … || true`, so the step's
              // exit code was always `tail`'s 0: the daemon decides pass/fail
              // purely on exit code (agent-daemon.mjs `passed = code ===
              // expectCode`), so the gate could NEVER fail and `loopTo:
              // test-fix` never fired — a non-parsing / failing suite shipped
              // green. Capture the real status in RC and `exit $RC` after the
              // tail. The `( vitest --changed || npm test )` fallback is
              // preserved: RC reflects the subshell (0 if either path passes).
              command:
                `cd ${workingDir} && ` +
                `RC=0; ` +
                `( npx vitest run --changed HEAD~1 --silent > /tmp/test-verify.log 2>&1 || ` +
                `npm test --silent > /tmp/test-verify.log 2>&1 ) || RC=$?; ` +
                `tail -80 /tmp/test-verify.log; ` +
                `exit $RC`,
              timeout: 180000,
              captureAs: 'TEST_VERIFY_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'TEST_VERIFY_ERROR' },
              // dino1 (2026-06-13) — loop the DEV back in-pipeline (carrying
              // TEST_VERIFY_ERROR) instead of hard-failing into a fresh
              // daemon-retry job that loses the error context. Exhaustion
              // still fails the job (daemon retry is the backstop).
              loopTo: 'test-fix',
            },
            // pacman1 F1 (2026-06-12) — lint at CONSTRUCTION time, not just at
            // the wave gate. The pacman1 final-assembly story shipped a
            // react-hooks/refs ERROR that no story-level step could see (lint
            // lived only in the gate's blocking tier), so the burden landed on
            // the gate's one-shot fixer — which had already spent its attempt
            // on a test failure. Operator decision: mvp code is reused
            // (prototype-on-top, refactors), so eslint runs at mvp+ in the
            // story worktree where the DEV that wrote the code fixes its own
            // findings via the standard retry injection (LINT_ERROR).
            //   - `--fix` first: auto-fixables land silently and ride the
            //     story commit (same philosophy as the gate's mechanical tier).
            //   - mvp: ERRORS block, warnings tolerated (eslint's default
            //     exit semantics — no --max-warnings flag).
            //   - production: zero warnings (--max-warnings 0), matching the
            //     gate's production tier.
            //   - file-guarded: brownfield apps without eslint.config.mjs
            //     skip cleanly (same guard the wave gate uses).
            {
              id: 'lint-verify',
              stepType: 'shell' as const,
              // dino1 root-cause (2026-06-13) — SCOPE lint to the story's own
              // files. The prior `npx eslint .` linted the WHOLE repo, so a
              // types-only story (S1: src/game/types.ts) was failed by
              // pre-existing react-hooks errors in scaffold files it never
              // touched (useGameLoop.ts) and is not scoped to fix — the fixer
              // loop then burned its attempts on files outside its touch
              // points and the candidate was reaped. F1's intent is "the DEV
              // that wrote the code fixes ITS findings", so we lint only the
              // per-story delta (same baseline-subtraction the commit step
              // uses) plus the declared touch points. Whole-repo lint stays
              // at the wave gate, where cross-file assembly is the contract.
              command:
                `cd ${workingDir} && ` +
                `if [ -f eslint.config.mjs ]; then ` +
                `  BASELINE_DIRTY=".pipeline/${story.storyId}-baseline-dirty.txt"; ` +
                `  BASELINE_UNTRACKED=".pipeline/${story.storyId}-baseline-untracked.txt"; ` +
                `  LINT_LIST=$(mktemp); ` +
                `  if [ -f "$BASELINE_DIRTY" ] && [ -f "$BASELINE_UNTRACKED" ]; then ` +
                `    POST_DIRTY=$(mktemp); POST_UNTRACKED=$(mktemp); DELTA=$(mktemp); ` +
                `    git diff --name-only > "$POST_DIRTY" 2>/dev/null || true; ` +
                `    git ls-files --others --exclude-standard > "$POST_UNTRACKED" 2>/dev/null || true; ` +
                `    sort -o "$BASELINE_DIRTY" "$BASELINE_DIRTY" 2>/dev/null || true; ` +
                `    sort -o "$BASELINE_UNTRACKED" "$BASELINE_UNTRACKED" 2>/dev/null || true; ` +
                `    sort -o "$POST_DIRTY" "$POST_DIRTY" 2>/dev/null || true; ` +
                `    sort -o "$POST_UNTRACKED" "$POST_UNTRACKED" 2>/dev/null || true; ` +
                `    comm -23 "$POST_DIRTY" "$BASELINE_DIRTY" > "$DELTA" 2>/dev/null || true; ` +
                `    comm -23 "$POST_UNTRACKED" "$BASELINE_UNTRACKED" >> "$DELTA" 2>/dev/null || true; ` +
                `    cat "$DELTA" >> "$LINT_LIST" 2>/dev/null || true; ` +
                `  fi; ` +
                // touch points are the ship contract — always candidate to lint.
                (quotedTouchPoints
                  ? `  for TP in ${quotedTouchPoints}; do echo "$TP" >> "$LINT_LIST"; done; `
                  : '') +
                // keep only lintable, on-disk source files; drop infra paths.
                `  FINAL=$(mktemp); ` +
                `  grep -E '\\.(ts|tsx|js|jsx|mjs|cjs)$' "$LINT_LIST" 2>/dev/null ` +
                `    | grep -vE '^(node_modules/|\\.pipeline/|\\.mycelium/|knowledge/|\\.context/)' ` +
                // pacman4 deadlock fix (2026-06-19) — DROP tamper-frozen test
                // files from the per-story lint set. They are the contract,
                // authored by test-author and frozen by stage-test-files; DEV/
                // lint-fix is forbidden from editing them (tamper-check reverts
                // any edit). Linting them HERE meant a lint error inside a test
                // file routed to lint-fix → DEV edited it → tamper-check reverted
                // it and failed → unbreakable loop (the pacman4 collision story).
                // Test files are lint-validated at stage-test-files instead, where
                // the failure loops back to their author. Same path-shape as the
                // tamper regex (+ __tests__/).
                `    | grep -vE '\\.(test|spec)\\.[jt]sx?$|(^|/)__tests__/|^e2e/|^tests/' ` +
                `    | sort -u | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done > "$FINAL" 2>/dev/null || true; ` +
                `  if [ -s "$FINAL" ]; then ` +
                // null-delimited xargs: portable across GNU + BSD (`xargs -a -d`
                // are GNU-only and broke on macOS hosts).
                `    if tr '\\n' '\\0' < "$FINAL" | xargs -0 npx eslint --fix${rigor === 'production' ? ' --max-warnings 0' : ''} > /tmp/lint-verify.log 2>&1; then ` +
                `      echo "LINT_VERIFY_OK files=$(wc -l < "$FINAL")"; ` +
                `    else ` +
                `      echo "LINT_VERIFY_FAILED — fix the eslint problems below in THIS story's files (errors block at ${rigor}; do NOT disable rules):"; ` +
                `      tail -80 /tmp/lint-verify.log; ` +
                `      exit 1; ` +
                `    fi; ` +
                `  else ` +
                `    echo "LINT_VERIFY_SKIPPED: no changed source files for this story"; ` +
                `  fi; ` +
                `else ` +
                `  echo "LINT_VERIFY_SKIPPED: no eslint.config.mjs"; ` +
                `fi`,
              timeout: 120000,
              captureAs: 'LINT_VERIFY_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'LINT_ERROR' },
              // dino1 (2026-06-13) — loop the DEV back in-pipeline carrying
              // LINT_ERROR so it fixes the SPECIFIC eslint findings (the
              // react-hooks/refs error it just wrote), instead of a fresh
              // retry job that loses the error and concludes "no changes".
              loopTo: 'lint-fix',
            },
            // dino1 (2026-06-13) — loop-only fix steps for the two construction
            // gates. They run ONLY as loopTo targets (skipped in linear flow),
            // resume the DEV session, and surface the exact captured error.
            // The DEV is scoped to this story's files (same as the gate), so it
            // fixes its OWN findings — closing the "why can't it fix itself"
            // gap from the pacman1/dino1 forensics.
            {
              id: 'test-fix',
              agentId: 'DEV',
              resumeFromStep: 'dev',
              prompt: `Your implementation (attempt {{ITERATION}} of {{MAX_ITERATIONS}}) FAILED the test suite.

This is the authoritative \`test-verify\` output (the single-pass runner — do NOT run tests yourself):

{{TEST_VERIFY_ERROR}}

Fix the IMPLEMENTATION so these tests pass.
- Do NOT edit or delete the test files — they are the contract (tamper-check reverts edits and fails the step).
- If the story wording contradicts a test, follow the test.
- Stay within this story's declared touch points; if a real fix needs a file outside them, say so in WORK_SUMMARY rather than editing it.

Output only what you changed, then:
---WORK_SUMMARY---
[Updated summary of changes]
---END_WORK_SUMMARY---`,
              extractors: {
                WORK_SUMMARY: {
                  type: 'between' as const,
                  startDelimiter: '---WORK_SUMMARY---',
                  endDelimiter: '---END_WORK_SUMMARY---',
                },
              },
              validations: [],
            },
            {
              id: 'lint-fix',
              agentId: 'DEV',
              resumeFromStep: 'dev',
              prompt: `Your implementation (attempt {{ITERATION}} of {{MAX_ITERATIONS}}) FAILED eslint on THIS story's files.

This is the \`lint-verify\` output. Auto-fixable problems were already repaired by \`--fix\`, so everything below needs a real code change:

{{LINT_ERROR}}

Fix every error.
- Do NOT add \`eslint-disable\` comments and do NOT edit \`eslint.config.*\` — suppressing a rule is not a fix.
- react-hooks errors require restructuring, not silencing. In particular, "Cannot access refs during render" means a \`someRef.current\` is being READ in the component body / JSX (e.g. passed as a prop or used to compute markup). Refs are only safe to read inside event handlers or effects. Fix it by deriving that value from state/props, or move the read into a \`useEffect\`/handler — never read \`.current\` during render.
- Stay within this story's declared touch points; if a real fix needs a file outside them, say so in WORK_SUMMARY rather than editing it.

Output only what you changed, then:
---WORK_SUMMARY---
[Updated summary of changes]
---END_WORK_SUMMARY---`,
              extractors: {
                WORK_SUMMARY: {
                  type: 'between' as const,
                  startDelimiter: '---WORK_SUMMARY---',
                  endDelimiter: '---END_WORK_SUMMARY---',
                },
              },
              validations: [],
            },
          ] as PipelineStep[])
        : []),

      // Phase C.4 + PR-41 (mvp+): tamper-check. If the dev agent edited
      // test files authored in test-author, revert those files and fail
      // the step so the loop can retry with a fresh attempt.
      //
      // PR-46 (2026-05-06) — heredoc rewrite. The previous inline
      // `echo "{{TEST_FILES}}" | tr ... | grep -vE '^---' | grep -E '...'`
      // chain failed on Linux bash with "syntax error near unexpected
      // token `('" when the multi-line {{TEST_FILES}} value (which
      // includes the fence markers per the 'between' extractor's
      // inclusive semantics, agent-daemon.mjs:475) interacted with the
      // surrounding single-quoted regexes. Confirmed on brick-breaker-2
      // 2026-05-06 with mvp rigor.
      //
      // Robust pattern: write the raw {{TEST_FILES}} block (fence
      // markers + paths + blanks) to .pipeline/tamper-input.txt via a
      // quoted-delimiter heredoc — the heredoc body is NOT subject to
      // shell expansion or quote interpretation (POSIX guarantee), so
      // arbitrary multi-line content lands verbatim. Then a single grep
      // filters the actual paths and the rest of the logic proceeds
      // unchanged.
      ...(tamperOn
        ? ([
            {
              id: 'tamper-check',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                `mkdir -p .pipeline && ` +
                // Write {{TEST_FILES}} verbatim to disk. The quoted
                // 'EOF_TAMPER' delimiter prevents shell expansion inside
                // the heredoc body — multi-line + paren + quote content
                // all land literally.
                `cat > .pipeline/tamper-input.txt << 'EOF_TAMPER'\n` +
                `{{TEST_FILES}}\n` +
                `EOF_TAMPER\n` +
                // Filter to actual test file paths (drops fence markers,
                // blank lines, anything not matching a test-path regex).
                `grep -E '\\.(test|spec)\\.[jt]sx?$|^e2e/|^tests/' .pipeline/tamper-input.txt > /tmp/tamper-expected.txt 2>/dev/null || true; ` +
                `if [ ! -s /tmp/tamper-expected.txt ]; then ` +
                `  echo __TAMPER_CLEAN__ '(no test files extracted)'; ` +
                `  exit 0; ` +
                `fi; ` +
                // 2026-05-19 — baseline fix. Pre-fix this was
                //   `git diff --name-only HEAD -- $(cat ...)`
                // i.e. diff working tree against the PRIOR STORY's commit,
                // which falsely flags test-author's own edits as "DEV
                // tampered". snake-4 Wave-0 forensic confirmed all three
                // failures were test-author Edits, not DEV writes.
                //
                // New baseline: stage-test-files (runs after test-author)
                // stages every authored path. We now diff working tree
                // against the INDEX (no ref arg) — anything in the diff
                // is necessarily a post-stage modification, which is the
                // exact DEV-tampering signal the gate is meant to catch.
                `git --no-pager diff --name-only -- $(cat /tmp/tamper-expected.txt) 2>/dev/null > /tmp/tamper-dirty.txt || true; ` +
                `if [ -s /tmp/tamper-dirty.txt ]; then ` +
                `  echo __TAMPER_DETECTED__; cat /tmp/tamper-dirty.txt; ` +
                // Restore from index (stage-test-files baseline), NOT HEAD.
                // `checkout-index -f --` overwrites the working tree with
                // the staged blob — undoing DEV's edit while preserving
                // test-author's legitimate authorship.
                `  while IFS= read -r f; do [ -n "$f" ] && git checkout-index -f -- "$f" 2>/dev/null || true; done < /tmp/tamper-dirty.txt; ` +
                `  exit 1; ` +
                `else ` +
                `  echo __TAMPER_CLEAN__; ` +
                `fi`,
              timeout: 30000,
              captureAs: 'TAMPER_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'TAMPER_ERROR' },
            },
            // VQA v3 E5.5 (H1/FR-30) — SEAM-shape tamper-check. The verifiability
            // seam's shape is generator-owned (`__harness.schema.json`, shipped as
            // a committed scaffold file). DEV/fixer may conform the running app to
            // the shape + populate values, but MUST NOT edit the schema — else DEV
            // authors the oracle that grades DEV. Unlike test files (staged
            // mid-pipeline), the schema is a static scaffold file, so the baseline
            // is HEAD. No-op for apps without a seam (file absent). This guards the
            // SHAPE only; the assertion expressions are QA-AUTHOR-owned (E8).
            {
              id: 'seam-tamper-check',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                `if [ ! -f __harness.schema.json ]; then echo __SEAM_TAMPER_SKIP__ '(no seam in this app)'; exit 0; fi; ` +
                `if ! git ls-files --error-unmatch __harness.schema.json >/dev/null 2>&1; then echo __SEAM_TAMPER_SKIP__ '(seam schema untracked)'; exit 0; fi; ` +
                `git --no-pager diff --name-only HEAD -- __harness.schema.json 2>/dev/null > /tmp/seam-dirty.txt || true; ` +
                `if [ -s /tmp/seam-dirty.txt ]; then ` +
                `  echo __SEAM_TAMPER_DETECTED__; cat /tmp/seam-dirty.txt; ` +
                // Revert the generator-owned shape from HEAD, undoing the edit.
                `  git checkout HEAD -- __harness.schema.json 2>/dev/null || true; ` +
                `  exit 1; ` +
                `else echo __SEAM_TAMPER_CLEAN__; fi`,
              timeout: 15000,
              captureAs: 'SEAM_TAMPER_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'SEAM_TAMPER_ERROR' },
            },
          ] as PipelineStep[])
        : []),

      // PR-36 — baseline-diff regression gate (Story 2-A-4-3). v2.5 §14.
      //
      // Runs `scripts/check-regressions.sh` against the wave's baseline. The
      // script handles three exit cases:
      //   - exit 0 + "BASELINE_OK"             → no regressions
      //   - exit 0 + "BASELINE_EMPTY"          → no baseline yet (first
      //     wave or brownfield app — the gate is no-op until PR-36b ships
      //     the wave-start capture hook)
      //   - exit 1 + "BASELINE_REGRESSION_DETECTED REGRESSION_COUNT=<n>"
      //     → previously-passing tests now fail. mvp+ rigor blocks; the
      //     rigor branching lives inside the script.
      //   - exit 2 + "TEST_RUNNER_FAILURE"     → runner crash; distinct
      //     attention category. PR-36b wires the per-exit-code attention
      //     surface; today the daemon falls through to its generic
      //     `step-failed` attention.
      //
      // Skipped under prototype rigor (the script also short-circuits
      // there, but skipping here saves a shell spawn). Skipped when the
      // boilerplate's `baselineCapture` is null — encoded by the daemon
      // dispatching with a `BASELINE_GATE_DISABLED` env flag (PR-36b);
      // for now mvp+ runs the step unconditionally and relies on the
      // script's BASELINE_EMPTY path.
      ...(testsOn
        ? ([
            {
              id: 'baseline-regression',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                // Skip the gate entirely if check-regressions.sh hasn't been
                // written to the worktree yet. Brownfield apps created
                // before PR-35 don't have it; the boilerplate-sync action
                // (v2.5 §13.2) is the supported recovery. Until then,
                // BASELINE_GATE_SKIPPED is a clean log marker.
                `if [ ! -f scripts/check-regressions.sh ]; then ` +
                `  echo 'BASELINE_GATE_SKIPPED: scripts/check-regressions.sh not found ' \\` +
                `       '(brownfield app — sync from boilerplate to enable)'; ` +
                `  exit 0; ` +
                `fi; ` +
                `PROJECT_DIR=${workingDir} RIGOR=${rigor} ` +
                `bash scripts/check-regressions.sh`,
              timeout: 240000,
              captureAs: 'BASELINE_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'BASELINE_ERROR' },
            },
          ] as PipelineStep[])
        : []),

      // 2. Code review
      // Story B.3: REVIEWER prompt opens with the same `<project_context>`
      // block as DEV (B.2). Same byte position → prompt cache hits across
      // DEV→REVIEWER for the same story. The story spec inside
      // `<project_context>.storySpec` is the single source of truth — the
      // old inline `## Story:` block is removed.
      // Stories C.1/C.3/C.4: REVIEWER now emits a structured
      // `---REVIEW_CRITERIA---` block (one verdict per AC). Daemon parses
      // it deterministically. CONSTRAINTS section caps tool use at 5 calls
      // and bans Glob / find / Bash ls / Read-on-dir. Story spec lives in
      // <project_context>; the worker has no story files on disk.
      {
        id: 'review',
        agentId: 'REVIEWER',
        prompt: `<project_context>
{{PROJECT_CONTEXT}}
</project_context>

You are a code reviewer (attempt {{ITERATION}} of {{MAX_ITERATIONS}}).

The story spec, acceptance criteria, touch points, plan, project tree, knowledge index, and recent diffs are all in your \`<project_context>\` block above. Use them.

## Developer's summary:
{{WORK_SUMMARY}}

## DISCOVERY (Stories B.3 + C.4):
- Story spec, AC, project tree, adjacent file heads, and recent diffs are in \`<project_context>\`. Do NOT re-read them from disk.
- The complete story spec is in \`<project_context>.storySpec\`. The story spec is NOT stored on the project box (the EC2 worker). Do NOT search the filesystem for \`**/*.story.md\`, \`**/*acceptance*\`, \`**/*test*.md\`, or any other story-spec lookalike.
- The only canonical visual-tests path is \`${workingDir}/visual-tests.md\` (written by the daemon from the dev's \`---VISUAL_TESTS---\` block, Story A.2). There is no \`knowledge/tests/visual-tests.md\` — do not look there.
- The changed-file list is in \`<project_context>.recentDiffs\` and the touch points are in \`<project_context>.storySpec.touchPoints\`.

## CONSTRAINTS (Story C.3):
- Hard tool budget: 5 tool calls maximum for the whole review.
- Do all reads in ONE message with parallel calls. Never sequential.
- Do NOT use Glob, find, or Bash ls.
- Do NOT Read directories — Read takes file paths only.
- Do NOT re-grep for symbols you can already see in the diff.
- A loop detector force-escalates at 6 repeated tool calls (defense in depth).

## Review checklist:
1. Do all files mentioned in the acceptance criteria exist?
2. Does the code follow the project structure?
3. Are the acceptance criteria met?
4. Is the code quality acceptable (no obvious bugs, proper types)?${
          story.hasBrowserTests
            ? `
5. This story has browser-testable criteria. Visual tests live at \`${workingDir}/visual-tests.md\` — the daemon writes this file from the dev's \`---VISUAL_TESTS---\` block automatically (Story A.2). Verify each [needs_browser=true] criterion (see \`<project_context>.storySpec.acceptanceCriteria\`) has a matching entry there with id, criteriaRef, description, setup, and expect fields. Do NOT FAIL the story for "missing visual-tests block in dev output" — that block is consumed and persisted by the daemon, not retained in the dev's text.`
            : ''
        }

─────────────────────────────────────────────────────────────────
OUTPUT CONTRACT — REQUIRED (Story C.1):

Emit one line per acceptance criterion inside this envelope:

  ---REVIEW_CRITERIA---
  AC-1: pass
  AC-2: fail — <one-line reason, ≤120 chars>
  AC-3: needs-human — <one-line question to the operator>
  ---END_REVIEW_CRITERIA---

Verdict values: pass | fail | needs-human. Use \`needs-human\` for
subjective acceptance criteria you cannot deterministically check
(visual aesthetic, "is this enough?", domain judgement). The daemon
aggregates: any fail → retry; any needs-human → operator handoff.

Do NOT also emit "VERDICT: PASS/FAIL" prose — the daemon derives the
overall verdict from the structured block above. Free-form prose
after the envelope is fine for context but is ignored by the parser.
─────────────────────────────────────────────────────────────────

Be constructive. If the code is close but has minor issues, mark the affected ACs \`pass\` and write your suggestions as free-form prose AFTER the closing envelope.`,
        extractors: {
          // Story C.1/C.2: structured per-AC verdicts. The daemon parses
          // this block (review-criteria-parser.mjs) and synthesizes
          // VERDICT + FEEDBACK from the result.
          REVIEW_CRITERIA: {
            type: 'between',
            startDelimiter: '---REVIEW_CRITERIA---',
            endDelimiter: '---END_REVIEW_CRITERIA---',
          },
        },
        validations: [
          { type: 'equals', left: 'VERDICT', right: 'PASS', label: 'Code review approved' },
        ],
        loopTo: 'retry',
      },

      // 2.5. PR-65 (2026-05-15), reshaped by v2.6 M3 (2026-06-11) —
      // review-runtime is now a STORY SMOKE, not a judge.
      //
      // Three generations of per-story judged VQA failed for one structural
      // reason: a story worktree contains a PARTIAL world (dino1 judged the
      // starter page; pacman1's DEV invented demo harnesses to satisfy the
      // camera; pacman2's scroll-0 viewport showed a SIBLING's stacked
      // preview). Judged AC verification therefore moved to the WAVE GATE,
      // where the merged candidate — the first real integrated product —
      // is captured per-feature via `/?feature=<slug>` isolation (see
      // daemon/lib/wave-vqa-runner.mjs). What remains here is the cheap,
      // high-signal part:
      //
      //   • boot the dev server (framework-agnostic via
      //     buildFrameworkDetectSnippet), regenerate generated wiring first;
      //   • one screenshot, uploaded to S3 (operator evidence + DEV sanity);
      //   • ONE tiny Haiku call classifying PAGE_STATE
      //     (rendered|blank|error-overlay) — NO AC judging, NO verdict
      //     block, NO story-vqa-failed/unverifiable/ac-coverage-gap cards.
      //
      // Failure modes:
      //   • Dev server no-boot / screenshot fail / classifier crash —
      //     exit 0 + machine-grepable `RUNTIME_REVIEW_SKIPPED: cause=…`
      //     marker (daemon writes the low-severity story-vqa-skipped card;
      //     never a silent pass).
      //   • PAGE_STATE blank/error-overlay — exit 1 into the retry loop
      //     WITH the dev-server log tail (the dino1 corrupted-Turbopack-
      //     cache class: the fix is usually environmental — this recovery
      //     path has caught real infra bugs and is kept verbatim).
      //   • PAGE_STATE rendered — exit 0; judged verification happens at
      //     the wave gate.
      //
      // Token/time effect vs the old judge: ~1-2 min less per story and
      // zero judged false-negatives in-story (the false-FAIL→code-mutation
      // path is structurally gone).
      ...(testsOn && story.hasBrowserTests && story.criteria
        ? ([
            {
              id: 'review-runtime',
              stepType: 'shell' as const,
              command: [
                buildFrameworkDetectSnippet({ cwd: workingDir }),
                `mkdir -p /tmp/review-${story.storyId}`,
                // dino1 (2026-06-10): SIGTERM + fixed 1s was not enough — a
                // previous review's server still flushing its build cache when
                // the next boot started left the cache corrupted (Turbopack SST
                // panic → blank page on every subsequent review). Wait until the
                // port actually frees (up to 10s) before booting, then escalate
                // to SIGKILL only if the old process ignored TERM.
                // pong1 (2026-06-12) — lsof is BLIND to Next 16's listening
                // socket on the EC2 host (ss sees it; lsof -ti returns rc=1),
                // so this drain was a silent no-op: the fresh boot died with
                // EADDRINUSE and the screenshot judged a SQUATTER's page.
                // fuser/ss are the ground truth (see buildPortDrainLines).
                ...buildPortDrainLines('$QA_PORT'),
                `sleep 1`,
                // dino1 root-cause (2026-06-10): if the boilerplate generates
                // its wiring (src/app/page.tsx from src/features/*), a story
                // worktree that only ADDED a feature file still serves the
                // starter page — the generator only ran at the wave-merge
                // gate. Run it before boot so VQA judges the integrated app,
                // not the scaffold. File-existence guard = no-op for apps
                // without a generator.
                `cd ${workingDir} && { [ -f scripts/generate-wiring.mjs ] && node scripts/generate-wiring.mjs || true; }`,
                `cd ${workingDir} && (nohup $QA_DEV_CMD > /tmp/review-${story.storyId}/devserver.log 2>&1 </dev/null &)`,
                `STATUS=000`,
                // 60 tries (was 30): Next 16 + Turbopack cold-start in a fresh
                // story worktree regularly exceeds 30s, which made review-runtime
                // RUNTIME_REVIEW_SKIPPED (no screenshot) even when the app boots.
                `for i in $(seq 1 60); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$QA_PORT$QA_HEALTH_PATH 2>/dev/null); [ "$STATUS" = "200" ] && break; done`,
                `if [ "$STATUS" != "200" ]; then echo "RUNTIME_REVIEW_SKIPPED: cause=dev-server-no-boot status=$STATUS framework=$QA_FRAMEWORK port=$QA_PORT. This is normal for foundation stories that don't yet render a UI."; tail -30 /tmp/review-${story.storyId}/devserver.log >&2 || true; fuser -k -KILL $QA_PORT/tcp 2>/dev/null; exit 0; fi`,
                // pong1 tripwire (2026-06-12) — if OUR boot died with EADDRINUSE,
                // the 200 above came from a SQUATTER: screenshotting it judges a
                // DIFFERENT server's page (that loop convinced a retry DEV that
                // "GET / 200" meant the app was fine). Loud skip, never judge it.
                `if grep -q "EADDRINUSE" /tmp/review-${story.storyId}/devserver.log 2>/dev/null; then echo "RUNTIME_REVIEW_SKIPPED: cause=port-squatter — our dev server died with EADDRINUSE; the HTTP 200 came from another process on $QA_PORT. Refusing to screenshot the wrong server."; fuser -k -KILL $QA_PORT/tcp 2>/dev/null; exit 0; fi`,
                `# Take overview screenshot of the running app.`,
                `npx playwright screenshot --viewport-size=1280,720 --wait-for-timeout=2000 http://localhost:$QA_PORT$QA_HEALTH_PATH /tmp/review-${story.storyId}/overview.png 2>&1 || { echo "RUNTIME_REVIEW_SKIPPED: cause=screenshot-failed — likely a framework that doesn't render at /"; fuser -k -KILL $QA_PORT/tcp 2>/dev/null; exit 0; }`,
                `# Upload to S3 so the operator can see it post-mortem AND so Haiku can fetch it.`,
                `SCREENSHOT_KEY="review-screenshots/${story.storyId}/$(date -u +%s).png"`,
                // snake3 forensic (2026-06-10): this upload had failed SILENTLY on
                // every run since PR-65 — the EC2 role lacked PutObject on the
                // review-screenshots/* prefix and '|| true' swallowed the
                // AccessDenied. The prefix had ZERO objects ever; operator links
                // 404'd through to the homepage. Keep non-blocking but LOUD.
                `if ! timeout 30 aws s3 cp /tmp/review-${story.storyId}/overview.png "s3://futurator-ai-website/$SCREENSHOT_KEY" --content-type image/png 2>/tmp/review-${story.storyId}/s3err.txt > /dev/null; then echo "SCREENSHOT_UPLOAD_FAILED: $(head -c 200 /tmp/review-${story.storyId}/s3err.txt)"; fi`,
                `SCREENSHOT_URL="https://futurator.ai/$SCREENSHOT_KEY"`,
                `# Kill dev server BEFORE the Haiku call so we don't hold the port for ~30s of inference.`,
                `fuser -k -KILL $QA_PORT/tcp 2>/dev/null || true`,
                `echo "[review-runtime] screenshot at $SCREENSHOT_URL"`,
                `# v2.6 M3 — story-smoke PAGE_STATE classifier. ONE tiny Haiku
                # call classifies the frame (rendered|blank|error-overlay).
                # NO AC judging — judged verification happens at the wave gate
                # against the merged candidate (daemon/lib/wave-vqa-runner.mjs).`,
                `LOCAL_SHOT="/tmp/review-${story.storyId}/overview.png" SCREENSHOT_URL="$SCREENSHOT_URL" DEVSERVER_LOG="/tmp/review-${story.storyId}/devserver.log" node -e "$(cat <<'NODE_EOF'`,
                `const { spawn } = require('child_process');`,
                `const fs = require('fs');`,
                `const localShot = process.env.LOCAL_SHOT;`,
                `const screenshotUrl = process.env.SCREENSHOT_URL;`,
                `const prompt = [`,
                // 2026-06-02 lesson kept: the classifier MUST read the LOCAL
                // screenshot via the Read tool (S3 URLs are unfetchable from
                // the sandbox — the judge "saw nothing" and silently passed).
                `  'You are a smoke-level page-state classifier for a dev server screenshot.',`,
                `  'Use the Read tool to open the screenshot image file at ' + localShot + ' and inspect it.',`,
                `  '',`,
                `  'Output EXACTLY one line:',`,
                `  'PAGE_STATE: rendered|blank|error-overlay — <one-line description of what the frame shows>',`,
                `  '  (rendered = the app drew meaningful UI; blank = empty/near-empty canvas or page;',`,
                `  '   error-overlay = a framework error or stack-trace overlay is visible)',`,
                `].join('\\n');`,
                `const child = spawn('claude', ['--print', '--model', 'haiku', '--output-format', 'text', '--allowedTools', 'Read'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 60000 });`,
                `let out = '', err = '';`,
                `child.stdin.write(prompt); child.stdin.end();`,
                `child.stdout.on('data', d => { out += d.toString(); });`,
                `child.stderr.on('data', d => { err += d.toString(); });`,
                `child.on('close', (code) => {`,
                // Step-0.4 lesson kept — every failure-to-observe is a LOUD
                // machine-grepable marker (daemon writes story-vqa-skipped),
                // never a silent pass that looks identical to a healthy run.
                `  if (code !== 0) { console.log('RUNTIME_REVIEW_SKIPPED: cause=page-state-crash exit=' + code + ' ' + err.slice(0, 200)); process.exit(0); }`,
                `  const psMatch = out.match(/PAGE_STATE:\\s*(rendered|blank|error-overlay)/i);`,
                `  if (!psMatch) { console.log('RUNTIME_REVIEW_SKIPPED: cause=page-state-unparseable ' + out.slice(0, 300)); process.exit(0); }`,
                `  const pageState = psMatch[1].toLowerCase();`,
                `  console.log('PAGE_STATE_PARSED: ' + pageState);`,
                `  if (pageState === 'rendered') {`,
                `    console.log('STORY_SMOKE_OK: page rendered — judged AC verification happens at the wave gate against the merged candidate.');`,
                `    process.exit(0);`,
                `  }`,
                // dino1 forensic (2026-06-10), kept verbatim in spirit: a blank
                // page is often the DEV SERVER failing (corrupted gitignored
                // build cache → Turbopack panic on every boot), not the product
                // code. Attach the server's own log so the fix-cycle DEV
                // diagnoses the ENVIRONMENT instead of mutating correct code.
                `  let serverLog = '';`,
                `  try { serverLog = fs.readFileSync(process.env.DEVSERVER_LOG, 'utf8').slice(-2500); } catch (e) {}`,
                `  const obs = 'PAGE_STATE: ' + pageState + ' — the app rendered nothing judgeable; likely entry-point wiring, a runtime error, a build failure, OR the dev server itself crashing.' + (serverLog ? '\\n\\n--- dev server log (tail) ---\\n' + serverLog : '');`,
                `  try { fs.mkdirSync('.context', { recursive: true }); fs.writeFileSync('.context/vqa-observations.txt', obs); } catch (e) {}`,
                `  console.error('STORY_SMOKE_FAILED: page state is ' + pageState + ' — the app did not render a judgeable UI.');`,
                `  if (serverLog) { console.error(''); console.error('Dev server log (tail) — read this FIRST. If it shows the SERVER crashing (panic, corrupted cache, port clash), the fix is environmental (e.g., delete the stale gitignored build-cache directory it names and let the server rebuild) — do NOT change product code for an infra crash:'); console.error(serverLog); }`,
                `  console.error('Screenshot: ' + screenshotUrl);`,
                `  process.exit(1);`,
                `});`,
                `NODE_EOF`,
                `)"`,
              ].join('\n'),
              timeout: 180000,
              captureAs: 'RUNTIME_REVIEW_OUTPUT' as const,
              captureStderrAs: 'RUNTIME_REVIEW_ERROR' as const,
              onFail: {
                action: 'retry_step' as const,
                targetStep: 'retry',
                injectAs: 'FEEDBACK',
              },
              loopTo: 'retry',
            },
          ] as PipelineStep[])
        : []),

      // 3. Dev retry on review failure
      //
      // Step-0.3b (2026-06-05) — AC_CONTEST path. A reviewer/VQA FAIL no
      // longer has absolute authority over DEV: when the failing AC describes
      // a state the verification instrument cannot observe, DEV contests it
      // (structured block → operator attention, loop stops) instead of
      // mutating the product to appease the screenshot. The horse-runner1
      // forensic (correct obstacles.ts + false VQA FAIL → DEV grafted an
      // obstacle-preview gallery into the game page) is the incident class
      // this closes. Scope ban is explicit: no new surfaces to satisfy VQA.
      {
        id: 'retry',
        agentId: 'DEV',
        resumeFromStep: 'dev',
        prompt: `The code reviewer checked your work (attempt {{ITERATION}} of {{MAX_ITERATIONS}}).

Feedback: {{FEEDBACK}}
Verdict: {{VERDICT}}

Fix the issues mentioned. Output only what you changed, then:
---WORK_SUMMARY---
[Updated summary of changes]
---END_WORK_SUMMARY---

## If the feedback is a VISUAL-review FAIL you believe is wrong

The visual reviewer judges ONE static screenshot of the app's idle initial
state. If a failing AC describes a state that screenshot physically cannot
show (requires interaction, elapsed time, motion, another route, or a
composite arrangement the app never renders at start), do NOT change code
to appease it. Instead emit, INSTEAD of a fix:

---AC_CONTEST---
<AC-id>: <one-line reason the idle screenshot cannot show this state>
---END_AC_CONTEST---

The contest is routed to the operator for adjudication and the retry loop
stops — an unverifiable verdict must never drive code changes. Contest an
AC at most once; if the same AC was already contested, fix what IS fixable
or restate the contest reason in WORK_SUMMARY without the block.

## If the feedback shows the DEV SERVER itself crashed (blank page)

When the feedback includes a dev-server log showing the server crashing or
panicking (e.g., a corrupted gitignored build cache it names by path), the
product code is probably fine — fix the ENVIRONMENT: delete the stale
cache/artifact directory the log points at (only gitignored build output,
never source or node_modules) so the next boot rebuilds clean. State what
you removed and why in WORK_SUMMARY. Do not change product code for an
infra crash.

## Hard scope rules (always)

- NEVER add new routes, pages, demo galleries, preview surfaces, or UI the
  story did not ask for in order to make a screenshot match an AC.
- Stay within this story's declared touch points; if a real fix requires
  files outside them, say so in WORK_SUMMARY instead of editing them.`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
          },
          AC_CONTEST: {
            type: 'between',
            startDelimiter: '---AC_CONTEST---',
            endDelimiter: '---END_AC_CONTEST---',
          },
        },
        validations: [],
      },

      // ── COMPILE phase (non-blocking: failures do NOT fail the story pipeline) ──
      // Note: these inline definitions mirror daemon/pipelines/compile-pipeline.mjs

      // Epic 5 wire-in (2026-05-20) — DEV appends an Architecture
      // decision to CLAUDE.md on milestone stories. Gating: wave === 0
      // (foundation stories are by definition architecture-shaping) OR
      // the AC text begins with "Architecture:" (operator-tagged opt-in
      // for non-wave-0 stories that still encode a decision).
      //
      // Non-blocking: a CLAUDE.md write failure should NEVER fail the
      // story pipeline. The writer module is itself idempotent + soft-
      // fails on missing files/sections.
      //
      // Position: AFTER review (which we know passed by virtue of
      // reaching the compile phase) and BEFORE compile-commit-on-pass,
      // so the CLAUDE.md edit gets bundled into the story commit and
      // shows up in `git log` alongside the story's code changes.
      ...(() => {
        const isMilestone =
          story.wave === 0 ||
          (typeof story.description === 'string' &&
            /^architecture:/i.test(story.description.trim()));
        if (!isMilestone) return [] as PipelineStep[];

        // JSON-stringify each value to survive shell + Node `-e` round-
        // trip. The writer's idempotency-key prevents duplicates on retry.
        const decisionText = story.title || `Wave-${story.wave ?? 0} foundation`;
        // Pull the first ~120 chars of AC as the rationale (skipping the
        // "Architecture:" prefix if present).
        const rationaleRaw =
          String(story.description ?? '')
            .replace(/^architecture:\s*/i, '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 200) || 'foundation milestone';
        // 2026-05-27 (brick-breaker-11 Bug 3) — base64-encode the args.
        // The previous build inlined `JSON.stringify(...)` (full of `"`)
        // INSIDE a double-quoted `node -e "..."`, so the first `{"` closed
        // the -e string and bash threw `syntax error near unexpected token
        // '('` (exit 2). base64 is [A-Za-z0-9+/=] — no quotes, no `$`, no
        // backslashes — so it survives the shell round-trip cleanly. The
        // node script is SINGLE-quoted for the shell (base64 has no single
        // quotes), and inside it we use double quotes freely.
        const argsB64 = Buffer.from(
          JSON.stringify({
            workingDir: '.',
            storyId: story.storyId,
            decision: decisionText.slice(0, 200),
            rationale: rationaleRaw,
            storyTitle: decisionText.slice(0, 200),
          }),
        ).toString('base64');

        return [
          {
            id: 'claude-md-append-decision',
            stepType: 'shell' as const,
            // `cd <workingDir>` + a single-quoted `node -e` that imports
            // the daemon-resident writer (the daemon rsyncs to
            // /opt/futurator-daemon/ — see scripts/rsync-daemon.sh). The
            // file:// URL form is the unambiguous way to dynamic-import an
            // absolute path. Args arrive base64-encoded + JSON.parse'd
            // back inside node.
            command:
              `cd ${workingDir} && ` +
              `node -e 'import("file:///opt/futurator-daemon/lib/claude-md-writer.mjs")` +
              `.then(m => m.appendArchitectureDecision(` +
              `JSON.parse(Buffer.from("${argsB64}", "base64").toString("utf8"))` +
              `).then(r => console.log("claude-md-append-decision:", JSON.stringify(r))))' ` +
              `2>&1 || true`,
            timeout: 8000,
            // Non-blocking by default: the daemon's executeShellStep
            // only fails the job when `onFail.action === 'fail'`. We
            // omit onFail entirely so a node error or module-resolution
            // miss is logged as step_error but doesn't fail the story.
            // The shell `|| true` is belt-and-suspenders.
          } satisfies PipelineStep,
        ];
      })(),

      // Story A.3: per-story commit. Runs after the review loop terminates so
      // HEAD~1..HEAD always scopes to a single story's edits — kills the old
      // `find -newer .mycelium/last-compile-marker` fallback that swept node_modules.
      // --allow-empty so degenerate stories (no edits) still produce a commit
      // and the next story's HEAD~1..HEAD remains story-scoped.
      // The shell-quote escape on title (`replace(/'/g, "'\\''")`) is what lets
      // titles with apostrophes survive bash single-quoting.
      // Story A.3 + dino4 fix (2026-04-27): self-bootstrap. Plans don't
      // always have a `.git/` (the plan-folder bootstrap doesn't `git init`),
      // and the daemon has no other place to call `git init` deterministically.
      // We make compile-commit-on-pass idempotent: if the cwd isn't a git
      // tree yet, init it and stamp a baseline commit so the per-story
      // commit always has a HEAD~1 for `compile-diff` to compare against.
      // Without this, every story's compile phase exited 128 ("not a git
      // repository") and the runaway-retry path burned $20+ per attempt.
      {
        id: 'compile-commit-on-pass',
        stepType: 'shell' as const,
        command:
          `cd ${workingDir} && ` +
          // Bootstrap: init repo + baseline commit if needed.
          `if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then ` +
          `  git init -q && ` +
          `  git -c user.email=daemon@futurator.local -c user.name='Daemon' add -A && ` +
          `  git -c user.email=daemon@futurator.local -c user.name='Daemon' ` +
          `    commit --allow-empty -q -m 'baseline (auto-bootstrap by daemon)'; ` +
          `fi && ` +
          // Story 20.12 — source-commit pin (party-push Epic 20). When the
          // launcher passed `sourceCommitSha`, check out that exact SHA in
          // detached-HEAD mode FIRST, so the subsequent plan-branch checkout
          // creates `plan/<slug>` starting from the pinned SHA instead of
          // main's current HEAD. Idempotent: a second story in the same
          // wave finds the branch already at the pinned SHA's history and
          // the checkout is a no-op fast-forward.
          (opts.sourceCommitSha ? `git checkout ${opts.sourceCommitSha} 2>/dev/null && ` : '') +
          // 2026-05-19 — per-plan branch. When the launcher passed planSlug,
          // commits land on `plan/<slug>` instead of the worktree's default
          // (typically `main` for brownfield). No-op when planSlug is absent.
          //
          // 2026-05-27 BUGFIX (brick-breaker-11) — per-story worktree
          // compatibility. Slice C runs each wave story in its OWN git
          // worktree on its OWN `wip/<storyId>` branch (story-worktree.mjs
          // `git worktree add -B wip/<storyId>`). Git allows a branch to be
          // checked out in only ONE worktree at a time, so N parallel
          // wave-0 stories all running `git checkout plan/<slug>` collide:
          // the first wins, the rest die with
          //   `fatal: 'plan/<slug>' is already used by worktree at <other>`
          // (exit 128 → story FAILED; the daemon mislabels it "refused
          // empty commit"). The pre-2026-05-27 comment claimed this was
          // "idempotent across parallel stories" — true for the SHARED
          // worktree model (stories serialize on one worktree), false for
          // per-story worktrees.
          //
          // Fix: when we're already on a `wip/*` branch (per-story worktree),
          // commit THERE — never touch `plan/<slug>`. Wave-merge (PR-95)
          // fast-forwards `wip/<storyId>` → `plan/<slug>` serially behind the
          // distributed merge lock afterwards. Only the legacy shared-worktree
          // path (current branch is NOT `wip/*` — e.g. `main` or detached
          // HEAD from a sourceCommitSha pin) checks out `plan/<slug>`.
          (opts.planSlug
            ? `PLAN_BRANCH='plan/${opts.planSlug}' && ` +
              `CUR_BRANCH="$(git symbolic-ref --short HEAD 2>/dev/null || echo '')" && ` +
              `case "$CUR_BRANCH" in ` +
              `  wip/*) : ;; ` +
              `  *) if [ "$CUR_BRANCH" != "$PLAN_BRANCH" ]; then ` +
              `       git checkout "$PLAN_BRANCH" 2>/dev/null || git checkout -b "$PLAN_BRANCH" 2>/dev/null || git checkout "$PLAN_BRANCH"; ` +
              `     fi ;; ` +
              `esac && `
            : '') +
          // PR-67 + snake-4 2026-05-19 fix: snapshot-diff staging.
          // capture-dev-baseline (step inserted before `dev`) wrote two
          // baseline files. Compute the post-DEV delta and stage ONLY
          // files this story's DEV touched. Falls back to `git add -A` if
          // the baseline files are missing (bootstrap path).
          `BASELINE_DIRTY=".pipeline/${story.storyId}-baseline-dirty.txt" && ` +
          `BASELINE_UNTRACKED=".pipeline/${story.storyId}-baseline-untracked.txt" && ` +
          `if [ -f "$BASELINE_DIRTY" ] && [ -f "$BASELINE_UNTRACKED" ]; then ` +
          `  POST_DIRTY=$(mktemp) && POST_UNTRACKED=$(mktemp) && DELTA=$(mktemp) && ` +
          `  git diff --name-only > "$POST_DIRTY" 2>/dev/null || true; ` +
          `  git ls-files --others --exclude-standard > "$POST_UNTRACKED" 2>/dev/null || true; ` +
          `  sort -o "$BASELINE_DIRTY" "$BASELINE_DIRTY" 2>/dev/null || true; ` +
          `  sort -o "$BASELINE_UNTRACKED" "$BASELINE_UNTRACKED" 2>/dev/null || true; ` +
          `  sort -o "$POST_DIRTY" "$POST_DIRTY" 2>/dev/null || true; ` +
          `  sort -o "$POST_UNTRACKED" "$POST_UNTRACKED" 2>/dev/null || true; ` +
          `  comm -23 "$POST_DIRTY" "$BASELINE_DIRTY" > "$DELTA" 2>/dev/null || true; ` +
          `  comm -23 "$POST_UNTRACKED" "$BASELINE_UNTRACKED" >> "$DELTA" 2>/dev/null || true; ` +
          `  SOURCE_DELTA=$(mktemp) && ` +
          `  grep -vE '^(node_modules/|\\.pipeline/|\\.mycelium/|knowledge/|visual-tests(-draft)?\\.md$|\\.context/)' "$DELTA" > "$SOURCE_DELTA" 2>/dev/null || true; ` +
          `  if [ -s "$SOURCE_DELTA" ]; then ` +
          `    xargs -a "$SOURCE_DELTA" -d '\\n' -r git add -- 2>/dev/null || true; ` +
          `  fi; ` +
          `  git add -- .mycelium 2>/dev/null || true; ` +
          `  git add -- knowledge 2>/dev/null || true; ` +
          `  git add -- .context 2>/dev/null || true; ` +
          `  git add -- .pipeline 2>/dev/null || true; ` +
          `  DELTA_COUNT=$(wc -l < "$SOURCE_DELTA"); ` +
          `  echo "SNAPSHOT_DIFF_STAGED story=${story.storyId} source_delta=$DELTA_COUNT"; ` +
          `else ` +
          `  echo "SNAPSHOT_DIFF_FALLBACK story=${story.storyId} reason=baseline_missing"; ` +
          `  git add -A; ` +
          `fi && ` +
          // P1 (pong1 2026-06-12): touchPoints are the ship contract — stage
          // them unconditionally AFTER the snapshot-diff so a retry's
          // baseline-subtracted (first-attempt) files still land. A no-op for
          // files already committed and unchanged; check-ignore skips paths
          // gitignore excludes on purpose.
          (quotedTouchPoints
            ? `for TP in ${quotedTouchPoints}; do ` +
              `if [ -e "$TP" ] && ! git check-ignore -q "$TP" 2>/dev/null; then git add -- "$TP" 2>/dev/null || true; fi; ` +
              `done && ` +
              `echo "TOUCHPOINTS_STAGED story=${story.storyId} declared=${shipTouchPoints.length}" && `
            : '') +
          // PR-67 guard preserved.
          `SOURCE_CHANGES=$(git diff --cached --name-only | grep -vE '^(node_modules/|\\.pipeline/|\\.mycelium/|knowledge/|visual-tests(-draft)?\\.md$|\\.context/)' | wc -l) && ` +
          `if [ "$SOURCE_CHANGES" -eq 0 ]; then ` +
          (verificationOnly
            ? `  echo "STORY_COMMIT_EMPTY_TOLERATED: verification-only story ${story.storyId} (all-browser ACs) produced no committable source — recording an empty commit so the epic isn't blocked." >&2; `
            : // dino1 forensic (2026-06-10): the commit step can run MORE THAN
              // ONCE per story (it sits inside the VQA fix-cycle loop). When an
              // earlier iteration already committed the story's work and the
              // final fix-cycle iteration rightly changed nothing (e.g., the
              // VQA failure was environmental), hard-failing here burned a full
              // job retry + a HIGH attention card for work that HAD landed.
              // If this story's commit is already in branch history, a second
              // empty pass is a no-op success, not a failure.
              `  if git log --format=%s -50 2>/dev/null | grep -qF "story: ${story.storyId}"; then ` +
              `    echo "STORY_COMMIT_ALREADY_LANDED: no new changes staged, but story ${story.storyId} already has a commit on this branch from an earlier iteration — no-op success."; ` +
              `    exit 0; ` +
              `  fi; ` +
              `  echo "STORY_COMMIT_EMPTY: no source-code changes staged for story ${story.storyId}." >&2; ` +
              `  echo "Working tree status:" >&2; git status --short >&2; ` +
              `  echo "Staged for commit:" >&2; git diff --cached --name-only >&2; ` +
              `  echo "Likely cause: snapshot-diff filtered out DEV's writes (sibling story took them), or DEV produced no source changes." >&2; ` +
              `  exit 1; `) +
          `fi && ` +
          // PR-73 + PR-85 + 2026-05-19 — commit-message trailers including
          // Plan-Id/Plan/Epic-Id/Wave (v2.5 §23). The buildCommitShellSnippet
          // helper consumes opts.planId/planSlug for the structured block.
          buildCommitShellSnippet({
            storyId: story.storyId,
            storyTitle: story.title,
            rigor,
            planId: opts.planId,
            planSlug: opts.planSlug,
            epicId: opts.epicId,
            wave: typeof story.wave === 'number' ? story.wave : undefined,
            allowEmpty: verificationOnly,
          }) +
          // P1 tripwire: every declared touchPoint present on disk (and not
          // gitignored) must exist in HEAD after the commit. With the
          // unconditional staging above this should never fire — if it does,
          // validated-on-disk work failed to ship and the story must NOT
          // pass green. The daemon maps STORY_COMMIT_INCOMPLETE to a HIGH
          // 'story-commit-incomplete' attention card via the
          // compile-commit-on-pass onFail='fail' path.
          (quotedTouchPoints
            ? ` && MISSING_TP=""; for TP in ${quotedTouchPoints}; do ` +
              `if [ -e "$TP" ] && ! git check-ignore -q "$TP" 2>/dev/null && ! git ls-tree --name-only HEAD -- "$TP" 2>/dev/null | grep -q .; then MISSING_TP="$MISSING_TP $TP"; fi; ` +
              `done; ` +
              `if [ -n "$MISSING_TP" ]; then ` +
              `echo "STORY_COMMIT_INCOMPLETE story=${story.storyId} missing_touchpoints:$MISSING_TP" >&2; ` +
              `echo "These files exist in the worktree (the smoke validated them) but are NOT in HEAD — validated != shipped." >&2; ` +
              `git status --short >&2; ` +
              `exit 1; ` +
              `fi`
            : ''),
        timeout: 30000,
        captureAs: 'STORY_COMMIT_OUTPUT',
        onFail: { action: 'fail' as const, injectAs: 'STORY_COMMIT_ERROR' },
      },

      // 4. Diff extraction -- identifies changed files
      // Story A.3: simplified. The per-story commit above guarantees HEAD~1
      // points at the prior-story tip, so `git diff --name-status HEAD~1 HEAD`
      // is the only diff source we need.
      //
      // PR-52 (2026-05-07) — empty-diff classification softened. Pre-PR-52
      // an empty diff failed the step loud, surfacing a `compile-failed`
      // attention item. brick-breaker-3 retry showed this fires falsely
      // when a story is RETRIED after a tamper-check failure: the retry's
      // DEV correctly says "no changes needed" (files already exist from
      // prior attempt's writes), the per-story commit is `--allow-empty`,
      // HEAD~1..HEAD has no diff, and the loud-fail fired on a healthy
      // pipeline path. With PR-52, an empty diff prints
      // `EMPTY_DIFF_BY_DESIGN` and exits 0 — compile-knowledge has
      // nothing to catalog (DIFF_MANIFEST is the empty marker), but the
      // pipeline continues without the false attention.
      //
      // The original loud-fail intent (catch node_modules sweeps via the
      // old `find -newer` fallback) is preserved by Story A.3's removal
      // of that fallback — the `find -newer` code path is gone, so an
      // empty diff today is genuinely empty, not a sweep miss.
      {
        id: 'compile-diff',
        stepType: 'shell' as const,
        // Task #55 (2026-05-16) — defensive rewrite. The original shell
        // intermittently exited non-zero in production (job a895fc71
        // dino-5 plan) even though the same command verbatim ran fine
        // when replayed against the worktree afterwards. Root cause never
        // pinned — could be transient fs lock, a HEAD~1 race during the
        // tail end of compile-commit-on-pass, or output capture quirks
        // under daemon load. This step is purely informational (it
        // populates DIFF_MANIFEST for compile-knowledge to read); a
        // failure here should never break the pipeline. The new shell:
        //
        //   - handles the no-parent (first commit) case via empty-tree
        //     fallback (`git hash-object -t tree /dev/null`)
        //   - ALWAYS exits 0 (downstream tolerates empty DIFF_MANIFEST)
        //   - keeps PR-52's EMPTY_DIFF_BY_DESIGN marker so retried stories
        //     stay grep-able as the "no-op success" case
        //
        // The daemon already classified prior compile-diff failures as
        // non-blocking (`compilation-failed` event with no story-error),
        // so codifying that intent in shell removes a class of false-
        // alarm attention items.
        // Hand-formatted because `if … then … else … fi` cannot be joined
        // with `;` separators — bash treats `then;` and `else;` as syntax
        // errors. Each `;` below sits BETWEEN commands, never adjacent to
        // a control-flow keyword.
        command:
          `cd ${workingDir} || exit 0; ` +
          `mkdir -p .mycelium || true; ` +
          `if git rev-parse --verify HEAD~1 >/dev/null 2>&1; then ` +
          `  BASE_REF="HEAD~1"; ` +
          `else ` +
          `  BASE_REF=$(git hash-object -t tree /dev/null 2>/dev/null); ` +
          `fi; ` +
          `DIFF=$(git diff --name-status "$BASE_REF" HEAD 2>/dev/null | ` +
          `{ grep -v -E 'node_modules/|\\.git/|knowledge/|\\.mycelium/' || true; }); ` +
          `if [ -z "$DIFF" ]; then ` +
          `  echo 'EMPTY_DIFF_BY_DESIGN: per-story commit produced no in-scope changes (retry / no-op story); compile phase will emit nothing'; ` +
          `else ` +
          `  printf '%s\\n' "$DIFF"; ` +
          `fi; ` +
          `exit 0`,
        timeout: 15000,
        captureAs: 'DIFF_MANIFEST',
        // No `onFail.action: 'fail'` — the shell can no longer exit
        // non-zero; if the daemon's spawn fails outright the daemon
        // still records it as step_error and the rest of the pipeline
        // proceeds (compile-knowledge tolerates missing DIFF_MANIFEST).
      },
      // Slice A — tree-sitter AST grounding for the COMPILER.
      // Runs ast-extract.mjs over every Added/Modified file in DIFF_MANIFEST
      // and writes the structural facts (functions, classes, imports, calls)
      // to .mycelium/ast-facts.json. The Compiler prompt below splices these
      // facts into a <ground_truth> block so the agent stops re-deriving
      // structure and focuses on Purpose/Decisions/Signals.
      //
      // Non-blocking: ast-extract.mjs always exits 0 (best-effort), and the
      // step itself uses `onFail: continue` so a missing grammar or a parse
      // error in one file never blocks compile-knowledge. The Compiler
      // simply falls through to its pre-Slice-A behaviour when AST_FACTS
      // is empty.
      //
      // Fast: tree-sitter is sub-100ms even on hundreds of files; no Voyage
      // / Claude / Memgraph calls here.
      ...(waveCloseEnabled
        ? ([] as PipelineStep[])
        : ([
            {
              id: 'compile-ast',
              stepType: 'shell' as const,
              command:
                // Best-effort: this shell always exits 0 so the step never
                // fails — when tree-sitter is missing, a parse blows up, or
                // node itself crashes, we still emit a minimal JSON shell so
                // the Compiler prompt's `{{AST_FACTS}}` interpolation has
                // something to consume. The `|| true` after `node ... .mjs`
                // swallows ast-extract's `process.exit(1)` fatal path.
                `cd ${workingDir} && mkdir -p .mycelium && ` +
                `if [ -f /opt/futurator-daemon/scripts/ast-extract.mjs ]; then ` +
                `  node /opt/futurator-daemon/scripts/ast-extract.mjs ` +
                `    --root ${workingDir} ` +
                `    --diff-manifest "{{DIFF_MANIFEST}}" ` +
                `    > .mycelium/ast-facts.json 2>/tmp/ast-extract-err.log || true; ` +
                `  cat .mycelium/ast-facts.json 2>/dev/null || ` +
                `    echo '{"fileCount":0,"files":[],"error":"ast-facts.json missing"}'; ` +
                `else ` +
                `  echo '{"fileCount":0,"files":[],"error":"ast-extract.mjs not deployed"}'; ` +
                `fi`,
              timeout: 60000,
              captureAs: 'AST_FACTS',
              onFail: { action: 'fail' as const, injectAs: 'AST_FACTS_ERROR' },
            },
          ] as PipelineStep[])),
      // Story B.4: COMPILER prompt opens with the same `<project_context>`
      // block as DEV (B.2) and REVIEWER (B.3) — byte-identical prefix → cache
      // hits across all three roles for this story. The diff + dev work
      // summary (DEV's post-state) live in `<step_input>` AFTER the context
      // block, so the compiler doesn't have to re-Read the source files DEV
      // just edited.
      // Story B.5: knowledge/index.md must use the tight one-line-purpose
      // format (`<path> — <one-line-purpose>`).
      // Story E.1: skipped entirely when WAVE_CLOSE_COMPILER_ENABLED — the
      // wave-compile job (Epic E.2) handles knowledge for the whole wave.
      ...(waveCloseEnabled
        ? ([] as PipelineStep[])
        : ([
            {
              id: 'compile-knowledge',
              stepType: 'agent' as const,
              agentId: 'COMPILER',
              prompt: `<project_context>
{{PROJECT_CONTEXT}}
</project_context>

You are the Knowledge Compiler for the "${epicTitle}" project.

The plan, story spec, project tree, knowledge index, and prior-wave WORK_SUMMARYs are in your \`<project_context>\` block above. The story's diff + DEV's WORK_SUMMARY (the post-state of this story's edits) are in \`<step_input>\` below.

<step_input>
## Changed files (git diff --name-status HEAD~1 HEAD)
\`\`\`
{{DIFF_MANIFEST}}
\`\`\`

## DEV WORK_SUMMARY
{{WORK_SUMMARY}}

## REVIEWER VERDICT
{{VERDICT}}

## REVIEWER FEEDBACK
{{FEEDBACK}}
</step_input>

<ground_truth>
## AST facts (tree-sitter, deterministic — Slice A)

For each Added/Modified file in DIFF_MANIFEST, the structural facts below
were extracted by tree-sitter (NOT by an LLM). They are the canonical
source for imports, exported functions/classes, and call sites. **Do not
re-derive these by reading the source files — use them as-is.** Focus
your wiki article authoring on Purpose, Decisions, Signals, and Missing
Signals; let the AST facts tell the story of *what's defined* and *what
calls what*.

If the block is empty or absent (\`fileCount: 0\`), tree-sitter was
unavailable or all changed files were non-code (markdown, config, etc.).
In that case fall back to the diff-only behaviour.

\`\`\`json
{{AST_FACTS}}
\`\`\`
</ground_truth>

## DISCOVERY (Story B.4 + Slice A):
- Do NOT re-Read the source files DEV just edited — their post-state is summarized in \`<step_input>\` above AND their structural facts are in \`<ground_truth>\` above. Read source only when you need a precise quote that the AST facts don't cover.
- Do NOT Read \`knowledge/log.md\`, \`knowledge/system/dependency-map.md\`, or \`knowledge/code/*.md\` unless you intend to edit them. The article catalog is in \`<project_context>.knowledgeIndex\` (one line per article).
- Do NOT Glob, find, or Bash ls.
- When you write \`Dependencies\` / \`Dependents\` / \`Key Exports\` sections in a wiki article, prefer the names that appear in \`<ground_truth>.files[].imports/functions/classes\` over names you remember from the diff — the AST is correct, your memory might not be.

## Compilation rules

For each changed file listed in \`<step_input>.DIFF_MANIFEST\`:

1. If a wiki article already exists in \`knowledge/code/\` for this file:
   - UPDATE it: revise Purpose, Dependencies, Dependents, Signals, Missing Signals
   - Update frontmatter: lastMutatedByStory: "${story.storyId}", updated date, maturity score

2. If no article exists:
   - CREATE one following the standard article format
   - Set frontmatter: createdByStory: "${story.storyId}", createdByEpic: "${opts.epicId || '(not provided)'}", type: code, phase: implementation, status: active

3. For deleted files (D status): mark their article status: superseded

4. Extract any architectural DECISIONS from WORK_SUMMARY:
   - Library choices, pattern selections, API design decisions
   - Create/update articles in \`knowledge/decisions/\`
   - Link to the code articles that implement them

5. Update \`knowledge/system/dependency-map.md\` with new import relationships

6. Update \`knowledge/index.md\` — add new articles, update changed entries.
   **Required format (Story B.5):** every entry is one line of the form
   \`- <path> — <one-line-purpose>\` (≤120 chars total). Example:
   \`- code/main.js.md — Game loop, state machine, drawScene orchestrator.\`
   Anything before the \` — \` separator is the path; anything after is the
   one-line purpose. Migrate any existing entries that lack this shape.

7. Append a compilation record to \`knowledge/log.md\`:
   | {ISO timestamp} | ${story.storyId} | success | {created}/{updated}/{superseded} | OK |

Use [[wikilinks]] for ALL cross-references (e.g., [[code/src--components--auth.tsx]]).
File naming: \`knowledge/code/{slug}.md\` where slug uses \`--\` for path separators.
Article frontmatter fields: title, type, phase, status, maturity, created, updated, createdByEpic, createdByStory, lastMutatedByStory, tags.
Article sections: Purpose, Key Exports, Dependencies (with [[wikilinks]]), Dependents (with [[wikilinks]]), Signals, Missing Signals, Notes.

Working directory: ${workingDir}`,
              captureAs: 'COMPILE_RESULT',
              extractors: {},
              validations: [],
              onFail: { action: 'fail' as const },
            },
          ] as PipelineStep[])),
      // Story A.4: verify post-sync. Drop the legacy `|| echo "skipped"`
      // patterns that swallowed errors silently — if graph-sync or s3 sync
      // fails (or sync succeeds but the target bucket is empty), the step now
      // exits non-zero and the daemon writes a `compile-sync-failed`
      // attention item (see daemon/agent-daemon.mjs compile catch-block).
      // Memgraph node-count verification is intentionally deferred — mgconsole
      // is slower and adds run-time variability; the wave-close compiler
      // (Epic E) will fold it into a single async post-wave check.
      // Story E.1: skipped entirely when WAVE_CLOSE_COMPILER_ENABLED — the
      // wave-compile job (Epic E.2) does the sync for the whole wave atomically.
      ...(waveCloseEnabled
        ? ([] as PipelineStep[])
        : ([
            {
              id: 'compile-sync',
              stepType: 'shell' as const,
              command:
                // graph-sync.mjs ships with the daemon at
                // /opt/futurator-daemon/scripts/graph-sync.mjs (rsync target).
                // Existence check kept as a safety net for fresh hosts where
                // rsync hasn't run yet — logs a warning and continues with the
                // S3 sync rather than failing the step.
                `set -e; ` +
                `cd ${workingDir} && ` +
                `if [ -f /opt/futurator-daemon/scripts/graph-sync.mjs ]; then ` +
                // 2026-05-17 snake-3 fix — tolerate graph-sync failures. The
                // script currently imports neo4j-driver via memgraph-driver.mjs
                // but daemon/package.json doesn't list it as a dep, so node
                // crashes with ERR_MODULE_NOT_FOUND. With `set -e` that killed
                // compile-sync before the (working) aws s3 sync ran, leaving
                // every story's knowledge graph absent from S3. The Memgraph
                // upsert is documented as non-critical secondary index — files
                // on disk + S3 are the source of truth — so a `|| echo` here
                // lets the S3 sync proceed even when Memgraph is unreachable
                // or the driver is missing.
                `  node /opt/futurator-daemon/scripts/graph-sync.mjs ` +
                `    --project ${projectId} ` +
                `    --knowledge-dir ${workingDir}/knowledge ` +
                `    --state-file ${workingDir}/.mycelium/compile-state.json ` +
                `    || echo "[compile-sync] graph-sync crashed (non-critical) — proceeding with S3 sync"; ` +
                `else ` +
                `  echo "[compile-sync] graph-sync.mjs not deployed — skipping Memgraph upsert (non-critical)"; ` +
                `fi && ` +
                `aws s3 sync ${workingDir}/knowledge/ ` +
                `s3://futurator-ai-website/knowledge-live/${projectId}/ && ` +
                `S3_COUNT=$(aws s3 ls s3://futurator-ai-website/knowledge-live/${projectId}/ ` +
                `--recursive --summarize 2>/dev/null | awk '/Total Objects:/ {print $3}'); ` +
                `if [ -z "$S3_COUNT" ] || [ "$S3_COUNT" -eq 0 ]; then ` +
                `  echo 'EMPTY_S3_MIRROR: knowledge-live/${projectId} has 0 objects after sync' >&2; ` +
                `  exit 1; ` +
                `fi; ` +
                `echo "S3 mirror verified: $S3_COUNT objects under knowledge-live/${projectId}/"`,
              timeout: 60000,
              onFail: { action: 'fail' as const, injectAs: 'COMPILE_SYNC_ERROR' },
            },
            // C1 (pacman1 audit, 2026-06-12) — COMMIT THE COMPILER'S OUTPUT.
            // The COMPILER writes knowledge/ + .mycelium AFTER the story
            // commit (compile-commit-on-pass runs first so HEAD~1..HEAD is
            // story-scoped). In the shared-worktree era the NEXT story's
            // commit swept these files in; per-story worktrees (Slice C)
            // are REAPED after the wave merges, so every article ever
            // written was silently lost — the pacman1 plan branch had ZERO
            // knowledge files while compile-knowledge completed on every
            // story. The compiler was write-only: Memgraph/S3 got a
            // transient copy, git got nothing, and the knowledgeIndex
            // context injection stayed permanently empty.
            //
            // This step commits the compile artifacts as their own commit
            // (kept separate from the story commit so HEAD~1..HEAD diff
            // semantics for the NEXT story remain code-scoped is NOT a
            // concern — compile-diff resolves BASE_REF before this runs,
            // and the next story diffs its own commit). compile-push right
            // after carries it to origin; wave-merge carries it to the
            // plan branch.
            {
              id: 'compile-knowledge-commit',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                `for d in knowledge .mycelium .context; do ` +
                `  [ -e "$d" ] && git add -- "$d" 2>/dev/null; ` +
                `done; ` +
                `if git diff --cached --quiet 2>/dev/null; then ` +
                `  echo "KNOWLEDGE_COMMIT_SKIPPED: no new compile artifacts"; ` +
                `else ` +
                `  git -c user.email=daemon@futurator.local -c user.name='Daemon' ` +
                `    commit -q -m 'knowledge: story ${story.storyId} compile artifacts' && ` +
                `  echo "KNOWLEDGE_COMMITTED story=${story.storyId}" || ` +
                `  echo 'KNOWLEDGE_COMMIT_WARN: commit failed — compiler output will be lost with the worktree' >&2; ` +
                `fi; ` +
                // Ship-tripwire (same validated≠shipped class as P1): the
                // wiki exists on disk but not in HEAD ⇒ loud warning.
                `if [ -d knowledge ] && ! git ls-tree --name-only HEAD -- knowledge 2>/dev/null | grep -q .; then ` +
                `  echo 'KNOWLEDGE_COMMIT_WARN: knowledge/ exists on disk but is NOT in HEAD' >&2; ` +
                `fi; true`,
              timeout: 30000,
              captureAs: 'KNOWLEDGE_COMMIT_OUTPUT',
              onFail: { action: 'continue' as const },
            },
            // PR-19 — push the per-story commit to GitHub.
            //
            // 2026-05-04 dino-runner-1 forensic: the daemon's
            // `compile-commit-on-pass` step was committing locally but the
            // commits never made it to the GitHub remote. The bootstrap
            // saga's commit-and-push.mjs runs once at App-creation; per-
            // story compile commits had no pusher until this step.
            //
            // Soft-fail by design: a push conflict (network blip, manual
            // operator commit, fast-forward issue) shouldn't stall the
            // pipeline. The next story's compile-push or a manual
            // `git push` resolves drift. We log a GIT_PUSH_WARN sentinel
            // so operators can grep for it in logs if commits ever stop
            // landing on origin.
            {
              id: 'compile-push',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                `git push origin HEAD 2>&1 || ` +
                `(echo 'GIT_PUSH_WARN: push failed (network/conflict/auth) — local commit retained' >&2 ; ` +
                `echo "[compile-push] continuing — next compile-push will retry"; true)`,
              timeout: 30000,
              captureAs: 'GIT_PUSH_OUTPUT',
              onFail: { action: 'continue' as const },
            },
          ] as PipelineStep[])),
    ],
  };
}
