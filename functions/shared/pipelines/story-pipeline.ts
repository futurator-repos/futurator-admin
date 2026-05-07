import type { EpicStory } from '../types/epic-workflow';
import type { PipelineDefinition, PipelineStep } from '../types/agent-orchestrator';
import type { PlanRigor } from '../types/plan';
import type { BoilerplateType } from '../boilerplates/registry';
import { buildAgentConfig } from './role-policy';

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
  },
): PipelineDefinition {
  // Derive projectId from workingDir: /home/ubuntu/projects/{name}/
  // Strip trailing slashes before splitting to avoid empty string from pop()
  const projectId = workingDir.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'unknown';
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
3. Additionally, write Playwright browser tests under \`e2e/\` covering the [needs_browser=true] criteria.`
                  : ''
              }
4. DO NOT implement the feature code — only the tests.
5. Tests MUST initially fail (red state). The Dev agent will make them pass.

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
- This story has browser-testable criteria (marked [needs_browser=true]). After implementing the code, also output visual test definitions describing how to verify each browser criterion:

---VISUAL_TESTS---
- id: VT-${story.storyId}-1
  criteriaRef: AC-1
  description: "What to verify visually"
  setup: "How to reach the testable state (e.g., load page, navigate to section)"
  action: "none | keypress:Space | click:.selector"
  expect: "What the correct result looks like"
---END_VISUAL_TESTS---

Write one test per needs_browser=true criterion. Be specific about what the visual result should look like.`
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
                // Check for unstaged or staged edits to those files since
                // TEST committed them. `diff --name-only HEAD` covers both.
                //
                // PR-47 (2026-05-07) — removed the `\\$` escape on the
                // command substitutions. The original `\\$(cat ...)` was a
                // misguided attempt to escape the dollar sign at the
                // template-literal layer, but it produces `\$(...)` in
                // bash, which is parsed as `\` (escape) + `$(...)`
                // (subshell). After a heredoc closes, bash treats the
                // following `(` as an unexpected token. This was a
                // dormant bug since C.4 — the step was production-only
                // until PR-41 promoted it to mvp+, and no production
                // plan had ever exercised it.
                `git --no-pager diff --name-only HEAD -- $(cat /tmp/tamper-expected.txt) 2>/dev/null > /tmp/tamper-dirty.txt || true; ` +
                `if [ -s /tmp/tamper-dirty.txt ]; then ` +
                `  echo __TAMPER_DETECTED__; cat /tmp/tamper-dirty.txt; ` +
                `  git checkout -- $(cat /tmp/tamper-dirty.txt) || true; ` +
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
          // Story commit (always)
          `git add -A && ` +
          `git -c user.email=daemon@futurator.local -c user.name='Daemon' ` +
          `commit --allow-empty -m 'story: ${story.storyId} — ${story.title.replace(/'/g, "'\\''")}'`,
        timeout: 30000,
        captureAs: 'STORY_COMMIT_OUTPUT',
        onFail: { action: 'fail' as const, injectAs: 'STORY_COMMIT_ERROR' },
      },

      // 4. Diff extraction -- identifies changed files
      // Story A.3: simplified. The per-story commit above guarantees HEAD~1
      // points at the prior-story tip, so `git diff --name-status HEAD~1 HEAD`
      // is the only diff source we need. Empty output here means the dev
      // produced zero in-scope edits — surfaced as a loud failure so the
      // operator sees a `compile-sync-failed` attention item instead of
      // silently documenting node_modules via the old `find -newer` fallback.
      {
        id: 'compile-diff',
        stepType: 'shell' as const,
        command:
          `cd ${workingDir} && mkdir -p .mycelium && ` +
          `DIFF=$(git diff --name-status HEAD~1 HEAD 2>/dev/null | ` +
          `{ grep -v -E 'node_modules/|\\.git/|knowledge/|\\.mycelium/' || true; }); ` +
          `if [ -z "$DIFF" ]; then ` +
          `  echo 'EMPTY_DIFF: per-story commit produced no in-scope changes' >&2; ` +
          `  exit 1; ` +
          `fi; ` +
          `printf '%s\\n' "$DIFF"`,
        timeout: 15000,
        captureAs: 'DIFF_MANIFEST',
        onFail: { action: 'fail' as const, injectAs: 'COMPILE_DIFF_ERROR' },
      },
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

## DISCOVERY (Story B.4):
- Do NOT re-Read the source files DEV just edited — their post-state is summarized in \`<step_input>\` above. Read source only when you need a precise quote for a knowledge article.
- Do NOT Read \`knowledge/log.md\`, \`knowledge/system/dependency-map.md\`, or \`knowledge/code/*.md\` unless you intend to edit them. The article catalog is in \`<project_context>.knowledgeIndex\` (one line per article).
- Do NOT Glob, find, or Bash ls.

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
                // Pipeline v2.0 PR-6 (E) — graph-sync.mjs is optional Mycelium
                // tooling that may not be deployed on every EC2 host. Skip
                // cleanly with a logged warning instead of failing the step
                // when the script is missing. The S3 mirror sync still runs.
                `set -e; ` +
                `cd ${workingDir} && ` +
                `if [ -f /home/ubuntu/scripts/graph-sync.mjs ]; then ` +
                `  node /home/ubuntu/scripts/graph-sync.mjs ` +
                `    --project ${projectId} ` +
                `    --knowledge-dir ${workingDir}/knowledge ` +
                `    --state-file ${workingDir}/.mycelium/compile-state.json; ` +
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
