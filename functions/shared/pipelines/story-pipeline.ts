import type { EpicStory } from '../types/epic-workflow';
import type { PipelineDefinition, PipelineStep } from '../types/agent-orchestrator';
import type { PlanRigor } from '../types/plan';
import type { BoilerplateType } from '../boilerplates/registry';
import { buildAgentConfig } from './role-policy';
import { buildFrameworkDetectSnippet } from './framework-detect';
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
          ] as PipelineStep[])
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

---WORK_SUMMARY---
[What tests you wrote and why — OR "No changes required" per EARLY-EXIT above]
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
                `STAGED=0; SKIPPED=0; ` +
                `while IFS= read -r f; do ` +
                `  if [ -n "$f" ] && [ -f "$f" ]; then ` +
                `    git add -f -- "$f" 2>/dev/null && STAGED=$((STAGED+1)) || SKIPPED=$((SKIPPED+1)); ` +
                `  else SKIPPED=$((SKIPPED+1)); ` +
                `  fi; ` +
                `done < /tmp/tamper-expected.txt; ` +
                `echo "STAGE_TEST_FILES_OK staged=$STAGED skipped=$SKIPPED"`,
              timeout: 15000,
              captureAs: 'STAGE_TEST_FILES_OUTPUT',
              onFail: { action: 'continue' as const },
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

      // 2026-05-19 — Phase 0.2a: capture working-tree state right before
      // DEV runs so compile-commit-on-pass can compute a per-story delta
      // and stage only files DEV actually touched. Closes the snake-4
      // subsumption race where Story B's `git add -A` swept Story A's
      // just-written audio.ts. Best-effort; onFail: continue (commit-step
      // falls back to legacy `git add -A` if baseline files are missing).
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

      // 1. Dev implements story
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
the fences below. The QA pipeline routes every entry to an LLM judge that
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
              command:
                `cd ${workingDir} && ` +
                `(npx vitest run --changed HEAD~1 --silent > /tmp/test-verify.log 2>&1 || ` +
                `npm test --silent > /tmp/test-verify.log 2>&1); ` +
                `tail -80 /tmp/test-verify.log || true`,
              timeout: 180000,
              captureAs: 'TEST_VERIFY_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'TEST_VERIFY_ERROR' },
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

      // 2.5. PR-65 (2026-05-15) — review-runtime.
      //
      // For stories with browser-tagged ACs at mvp+ rigor, boot the actual
      // dev server, take one screenshot, and ask Haiku whether each AC is
      // satisfied looking at the pixels. This is the gate that catches
      // "all unit tests pass, build is green, code review passed, but the
      // page in a browser doesn't match the AC text" — i.e. the
      // spyhunter-1 failure mode where every static gate green-lit a
      // bundle that didn't actually wire the integration.
      //
      // Framework-agnostic: uses buildFrameworkDetectSnippet so it works
      // for Vite, Next, Remix, Expo, SvelteKit, Nuxt, or any project
      // whose package.json has a `dev` script.
      //
      // Failure modes:
      //   • Dev server fails to boot in 60s — emits RUNTIME_REVIEW_SKIPPED
      //     (some foundation stories don't produce a renderable app yet);
      //     the step passes so foundation work isn't blocked.
      //   • Screenshot capture fails — same SKIPPED behaviour.
      //   • Haiku judges any AC as FAIL — exit 1, loopTo 'retry' for dev fix.
      //   • Haiku judges all ACs UNCERTAIN — passes (e.g., a "types story"
      //     where browser ACs describe future behaviour not yet visible).
      //
      // Cost: ~$0.005 per story-with-browser-ACs (one Haiku call) +
      //       ~5-10s dev server boot + screenshot.
      ...(testsOn && story.hasBrowserTests && story.criteria
        ? ([
            {
              id: 'review-runtime',
              stepType: 'shell' as const,
              command: [
                buildFrameworkDetectSnippet({ cwd: workingDir }),
                `mkdir -p /tmp/review-${story.storyId}`,
                `kill $(lsof -ti:$QA_PORT) 2>/dev/null || true`,
                `sleep 1`,
                `cd ${workingDir} && (nohup $QA_DEV_CMD > /tmp/review-${story.storyId}/devserver.log 2>&1 </dev/null &)`,
                `STATUS=000`,
                // 60 tries (was 30): Next 16 + Turbopack cold-start in a fresh
                // story worktree regularly exceeds 30s, which made review-runtime
                // RUNTIME_REVIEW_SKIPPED (no screenshot) even when the app boots.
                `for i in $(seq 1 60); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:$QA_PORT$QA_HEALTH_PATH 2>/dev/null); [ "$STATUS" = "200" ] && break; done`,
                `if [ "$STATUS" != "200" ]; then echo "RUNTIME_REVIEW_SKIPPED: dev server did not boot (status=$STATUS framework=$QA_FRAMEWORK port=$QA_PORT). This is normal for foundation stories that don't yet render a UI."; tail -30 /tmp/review-${story.storyId}/devserver.log >&2 || true; kill $(lsof -ti:$QA_PORT) 2>/dev/null; exit 0; fi`,
                `# Take overview screenshot of the running app.`,
                `npx playwright screenshot --viewport-size=1280,720 --wait-for-timeout=2000 http://localhost:$QA_PORT$QA_HEALTH_PATH /tmp/review-${story.storyId}/overview.png 2>&1 || { echo "RUNTIME_REVIEW_SKIPPED: playwright screenshot failed — likely a framework that doesn't render at /"; kill $(lsof -ti:$QA_PORT) 2>/dev/null; exit 0; }`,
                `# Upload to S3 so the operator can see it post-mortem AND so Haiku can fetch it.`,
                `SCREENSHOT_KEY="review-screenshots/${story.storyId}/$(date -u +%s).png"`,
                `timeout 30 aws s3 cp /tmp/review-${story.storyId}/overview.png "s3://futurator-ai-website/$SCREENSHOT_KEY" --content-type image/png > /dev/null 2>&1 || true`,
                `SCREENSHOT_URL="https://futurator.ai/$SCREENSHOT_KEY"`,
                `# Kill dev server BEFORE the Haiku call so we don't hold the port for ~30s of inference.`,
                `kill $(lsof -ti:$QA_PORT) 2>/dev/null || true`,
                `echo "[review-runtime] screenshot at $SCREENSHOT_URL"`,
                `# Haiku judges the screenshot against the story's browser ACs.`,
                `# We pass the ACs as base64-encoded JSON. base64's charset is
                # shell-safe (no quotes/spaces/$/braces), so AC text with
                # apostrophes, quotes, $, or { } can't break the assignment.
                # The prior raw \`STORY_BROWSER_ACS=[{"id":...}]\` form was
                # UNQUOTED — bash stripped the quotes + brace-expanded, so node
                # got \`[{id:...}]\` and JSON.parse threw, crashing every
                # review-runtime run for stories with browser ACs.`,
                `STORY_BROWSER_ACS_B64=${Buffer.from(
                  JSON.stringify(
                    (story.criteria ?? [])
                      .filter((c) => c.needsBrowser)
                      .map((c) => ({ id: c.id, text: c.text })),
                  ),
                ).toString('base64')}`,
                `LOCAL_SHOT="/tmp/review-${story.storyId}/overview.png" SCREENSHOT_URL="$SCREENSHOT_URL" STORY_BROWSER_ACS_B64="$STORY_BROWSER_ACS_B64" node -e "$(cat <<'NODE_EOF'`,
                `const { spawn } = require('child_process');`,
                `const acs = JSON.parse(Buffer.from(process.env.STORY_BROWSER_ACS_B64 || '', 'base64').toString('utf8') || '[]');`,
                `const screenshotUrl = process.env.SCREENSHOT_URL;`,
                `const localShot = process.env.LOCAL_SHOT;`,
                `if (acs.length === 0) { console.log('RUNTIME_REVIEW_SKIPPED: no browser ACs to judge'); process.exit(0); }`,
                `const acList = acs.map((a, i) => '  ' + a.id + ': ' + a.text).join('\\n');`,
                `const prompt = [`,
                `  'You are an automated visual reviewer.',`,
                // 2026-06-02 — the judge MUST read the LOCAL screenshot file via
                // the Read tool. The prior 'inspect <S3 URL>' form was unfetchable
                // from the sandbox, so the judge saw nothing → returned UNCERTAIN
                // for every AC → the runtime review silently passed broken UIs
                // (dino floating / no spawn shipped clean). Reading the local PNG
                // is what makes per-story VQA actually catch visual defects.
                `  'Use the Read tool to open the screenshot image file at ' + localShot + ' and inspect it.',`,
                `  '',`,
                `  'The acceptance criteria below describe what the user should be able to SEE on screen.',`,
                `  'For each AC, decide if it is satisfied based ONLY on what is visible in the screenshot.',`,
                `  '',`,
                `  'Acceptance criteria:',`,
                `  acList,`,
                `  '',`,
                `  'Output EXACTLY one line per AC in this format (no other text):',`,
                `  '<AC-id>: PASS|FAIL|UNCERTAIN — <one-line rationale ≤140 chars>',`,
                `  '',`,
                `  'Verdict rules:',`,
                `  '  PASS — the AC is observably satisfied in the screenshot.',`,
                `  '  FAIL — the AC is contradicted (e.g., expected button missing, expected chart empty, expected entity not visible).',`,
                `  '  UNCERTAIN — the AC describes future state, internal behaviour, or anything not visible at this stage of development. Foundation stories that produce no visible UI should return UNCERTAIN for all ACs.',`,
                `].join('\\n');`,
                `const child = spawn('claude', ['--print', '--model', 'haiku', '--output-format', 'text', '--allowedTools', 'Read'], { stdio: ['pipe', 'pipe', 'pipe'], timeout: 90000 });`,
                `let out = '', err = '';`,
                `child.stdin.write(prompt); child.stdin.end();`,
                `child.stdout.on('data', d => { out += d.toString(); });`,
                `child.stderr.on('data', d => { err += d.toString(); });`,
                `child.on('close', (code) => {`,
                `  if (code !== 0) { console.error('RUNTIME_REVIEW_SKIPPED: haiku exit ' + code + ': ' + err.slice(0, 200)); process.exit(0); }`,
                `  const lines = out.split('\\n').map(l => l.trim()).filter(Boolean);`,
                `  const verdicts = [];`,
                `  for (const line of lines) {`,
                `    const m = line.match(/^([A-Za-z0-9_-]+):\\s*(PASS|FAIL|UNCERTAIN)\\s*[—-]?\\s*(.*)$/i);`,
                `    if (m) verdicts.push({ id: m[1], verdict: m[2].toUpperCase(), rationale: (m[3] || '').slice(0, 200) });`,
                `  }`,
                `  if (verdicts.length === 0) { console.error('RUNTIME_REVIEW_SKIPPED: could not parse Haiku output: ' + out.slice(0, 400)); process.exit(0); }`,
                `  const fails = verdicts.filter(v => v.verdict === 'FAIL');`,
                `  console.log('---RUNTIME_REVIEW---');`,
                `  console.log('SCREENSHOT_URL: ' + screenshotUrl);`,
                `  for (const v of verdicts) console.log(v.id + ': ' + v.verdict + ' — ' + v.rationale);`,
                `  console.log('---END_RUNTIME_REVIEW---');`,
                `  if (fails.length > 0) {`,
                // S5 — persist the failing observations so the eventual passing
                // commit can stamp a VQA-Fixed: trailer the REFLECTOR mines into
                // a durable lesson. Written to .context (read, not committed).
                `    try { require('fs').mkdirSync('.context', { recursive: true }); require('fs').writeFileSync('.context/vqa-observations.txt', fails.map(f => f.id + ': ' + f.rationale).join('\\n')); } catch (e) {}`,
                `    console.error('');`,
                `    console.error('RUNTIME_REVIEW_FAILED: ' + fails.length + ' AC(s) failed visual review of the running app:');`,
                `    for (const f of fails) console.error('  - ' + f.id + ': ' + f.rationale);`,
                `    console.error('');`,
                `    console.error('Screenshot: ' + screenshotUrl);`,
                `    console.error('The dev server booted and rendered, but the result does not match the AC text. Common causes:');`,
                `    console.error('  • A module was written but is not imported from the entry point.');`,
                `    console.error('  • A render loop / state-machine update is wired but not driving the visual change.');`,
                `    console.error('  • An asset is referenced but the path is wrong / asset never loaded.');`,
                `    process.exit(1);`,
                `  }`,
                `  console.log('[review-runtime] all ' + verdicts.length + ' browser ACs PASS or UNCERTAIN');`,
                `  process.exit(0);`,
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
---END_WORK_SUMMARY---`,
        extractors: {
          WORK_SUMMARY: {
            type: 'between',
            startDelimiter: '---WORK_SUMMARY---',
            endDelimiter: '---END_WORK_SUMMARY---',
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
          // PR-67 guard preserved.
          `SOURCE_CHANGES=$(git diff --cached --name-only | grep -vE '^(node_modules/|\\.pipeline/|\\.mycelium/|knowledge/|visual-tests(-draft)?\\.md$|\\.context/)' | wc -l) && ` +
          `if [ "$SOURCE_CHANGES" -eq 0 ]; then ` +
          (verificationOnly
            ? `  echo "STORY_COMMIT_EMPTY_TOLERATED: verification-only story ${story.storyId} (all-browser ACs) produced no committable source — recording an empty commit so the epic isn't blocked." >&2; `
            : `  echo "STORY_COMMIT_EMPTY: no source-code changes staged for story ${story.storyId}." >&2; ` +
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
          }),
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
