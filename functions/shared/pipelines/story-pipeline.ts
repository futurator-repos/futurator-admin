import type { EpicStory } from '../types/epic-workflow';
import type { PipelineDefinition, PipelineStep } from '../types/agent-orchestrator';
import type { PlanRigor } from '../types/plan';

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
  },
): PipelineDefinition {
  // Derive projectId from workingDir: /home/ubuntu/projects/{name}/
  // Strip trailing slashes before splitting to avoid empty string from pop()
  const projectId = workingDir.replace(/\/+$/, '').split('/').filter(Boolean).pop() || 'unknown';
  const rigor: PlanRigor = opts.rigor || 'mvp';
  const testsOn = rigor !== 'prototype';
  const tamperOn = rigor === 'production';
  const redGateOn = rigor === 'production';
  // Story A.6: <run_command> default (Python static server) — overridable at
  // plan creation. Wired into the DEV prompt's VERIFICATION section so the
  // dev knows the canonical "how do I run this" command instead of guessing.
  const runCommand = opts.runCommand || 'python3 -m http.server 8080';

  return {
    initialVariables: {
      STORY_ID: story.storyId,
      EPIC_ID: opts.epicId || '(not provided)',
      PROJECT_ID: projectId,
    },
    maxIterations: 3,
    agents: {
      DEV: {
        name: 'Developer',
        allowedTools: 'Bash,Read,Edit,Write,Glob,Grep',
        model: opts.devModel || undefined,
      },
      REVIEWER: {
        name: 'Code Reviewer',
        allowedTools: 'Read,Grep,Glob',
        disallowedTools: 'Write,Edit',
        model: opts.reviewerModel || undefined,
      },
      // Phase C.3: TEST agent (Tier 1). Scoped to writing test files only —
      // unit tests in `*.test.*` / `__tests__/**` and browser tests in
      // `e2e/**` / `tests/**`. The tamper-check step (C.4) enforces that
      // Dev doesn't edit these outputs.
      TEST: {
        name: 'Test Author',
        allowedTools: 'Bash,Read,Write,Edit,Glob,Grep',
        model: opts.testModel || 'sonnet',
      },
      COMPILER: {
        name: 'Knowledge Compiler',
        allowedTools: 'Read,Write,Edit,Glob,Grep',
        // Story A.1: env-gated, default 'haiku'. Set COMPILER_MODEL=sonnet to
        // roll back if Haiku output quality regresses on a given epic.
        // Haiku is also kinder on t2.micro memory than Sonnet.
        model: process.env.COMPILER_MODEL || 'haiku',
      },
    },
    steps: [
      // Phase C.3: TEST agent authors failing tests BEFORE dev runs (mvp +
      // production). Skipped for prototype.
      ...(testsOn
        ? ([
            {
              id: 'test-author',
              agentId: 'TEST',
              prompt: `You are the TEST agent authoring tests for story ${story.storyId}.

Working directory: ${workingDir}

## Story
${story.title}

${story.description}

## Your job
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
- Output the list of test files you authored at the end:

---TEST_FILES---
src/foo.test.ts
e2e/home.spec.ts
---END_TEST_FILES---

---WORK_SUMMARY---
[What tests you wrote and why]
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
        prompt: `You are a senior developer working on the "${epicTitle}" project.

This is attempt {{ITERATION}} of {{MAX_ITERATIONS}} for this story.

## Story to implement:
${story.title}

${story.description}

## Instructions:
- Implement ONLY this story. Do not work on other stories.
- Working directory: ${workingDir}
- If this is the first story, set up the project structure.
- Output a brief summary of what you did (not full file contents, show diffs or summaries).

## DISCOVERY (Story A.6):
- The story title, description, and acceptance criteria are inline above. The plan and adjacent files are part of the working directory at ${workingDir}.
- Do NOT run \`ls\`, \`find\`, \`tree\`, or \`Bash cat\` on the project directory. The story spec tells you exactly which files to create/edit.
- Do NOT spawn the Task / Agent / Explore subagents — they re-read the codebase from scratch and burn 10–25 tool calls per turn for context you already have.
- Read at most the files you intend to modify. Do them in ONE message with parallel Read calls — never one Read per turn.

## VERIFICATION (Story A.6):
- Do NOT Read a file you just Wrote or Edited. The Write/Edit tools error when they fail; their absence of an error IS the verification.
- Do NOT run \`npm run dev\`, \`node --check\`, or \`node --input-type=module\` for ad-hoc syntax checks. The project's runtime command is: \`${runCommand}\`. The build/test gates downstream of this step will catch real regressions.
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

      // Phase C.3: test-verify (mvp + production). Assert tests now pass
      // after dev's changes. Skipped for prototype.
      ...(testsOn
        ? ([
            {
              id: 'test-verify',
              stepType: 'shell' as const,
              command: `cd ${workingDir} && npm test --silent > /tmp/test-verify.log 2>&1; tail -80 /tmp/test-verify.log || true`,
              timeout: 180000,
              captureAs: 'TEST_VERIFY_OUTPUT',
              expectExitCode: 0,
              onFail: { action: 'fail' as const, injectAs: 'TEST_VERIFY_ERROR' },
            },
          ] as PipelineStep[])
        : []),

      // Phase C.4: tamper-check (production only). If the dev agent edited
      // test files authored in test-author, revert those files and fail
      // the step so the loop can retry with a fresh attempt. Implemented
      // as a self-contained shell snippet so the daemon doesn't need a
      // bespoke step type.
      ...(tamperOn
        ? ([
            {
              id: 'tamper-check',
              stepType: 'shell' as const,
              command:
                `cd ${workingDir} && ` +
                // Compute the set of test files TEST agent authored. The
                // {{TEST_FILES}} var is the raw capture BETWEEN the fence
                // markers — which INCLUDES the fences themselves. Strip
                // the fence lines, blanks, and any line that doesn't look
                // like a filesystem path before feeding to git.
                `echo "{{TEST_FILES}}" | tr '\\n' '\\0' | xargs -0 -n1 ` +
                `| grep -vE '^\\s*$' ` +
                `| grep -vE '^---' ` +
                `| grep -E '\\.(test|spec)\\.[jt]sx?$|^e2e/|^tests/' ` +
                `> /tmp/tamper-expected.txt 2>/dev/null || true; ` +
                `if [ ! -s /tmp/tamper-expected.txt ]; then ` +
                `  echo __TAMPER_CLEAN__ '(no test files extracted)'; ` +
                `  exit 0; ` +
                `fi; ` +
                // Check for unstaged or staged edits to those files since
                // TEST committed them. `diff --name-only HEAD` covers both.
                `git --no-pager diff --name-only HEAD -- \\$(cat /tmp/tamper-expected.txt) 2>/dev/null > /tmp/tamper-dirty.txt || true; ` +
                `if [ -s /tmp/tamper-dirty.txt ]; then ` +
                `  echo __TAMPER_DETECTED__; cat /tmp/tamper-dirty.txt; ` +
                `  git checkout -- \\$(cat /tmp/tamper-dirty.txt) || true; ` +
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

      // 2. Code review
      {
        id: 'review',
        agentId: 'REVIEWER',
        prompt: `You are a code reviewer (attempt {{ITERATION}} of {{MAX_ITERATIONS}}).

Review the work done for this story in the project at ${workingDir}.

## Story:
${story.title}

${story.description}

## Developer's summary:
{{WORK_SUMMARY}}

## Review checklist:
1. Do all files mentioned in the acceptance criteria exist?
2. Does the code follow the project structure?
3. Are the acceptance criteria met?
4. Is the code quality acceptable (no obvious bugs, proper types)?${
          story.hasBrowserTests
            ? `
5. This story has browser-testable criteria. Visual tests are at \`${workingDir}/visual-tests.md\` — the daemon writes this file from the dev's \`---VISUAL_TESTS---\` block automatically (Story A.2). Verify each [needs_browser=true] criterion has a matching entry there with id, criteriaRef, description, setup, and expect fields. Do NOT FAIL the story for "missing visual-tests block in dev output" — that block is consumed and persisted by the daemon, not retained in the dev's text.`
            : ''
        }

Output: VERDICT: PASS or VERDICT: FAIL
Then: FEEDBACK: [specific findings — what passed, what needs fixing]

Be constructive. If the code is close but has minor issues, PASS with suggestions.`,
        extractors: {
          VERDICT: { type: 'regex', pattern: 'VERDICT:\\s*\\*{0,2}(PASS|FAIL)\\*{0,2}' },
          // Story A.5: tolerate markdown variants the reviewer occasionally
          // emits (`**FEEDBACK:**`, `**FEEDBACK**:`, `*FEEDBACK*:`). Without
          // this, the extractor missed the label entirely → variables had no
          // FEEDBACK → the retry prompt rendered literal `{{FEEDBACK}}` and
          // burned a turn while the dev asked the operator for the missing
          // text (dino3 e3w0s3 incident).
          FEEDBACK: {
            type: 'regex',
            pattern: '\\*{0,2}FEEDBACK\\*{0,2}\\s*:\\s*([\\s\\S]+?)$',
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
      {
        id: 'compile-commit-on-pass',
        stepType: 'shell' as const,
        command:
          `cd ${workingDir} && git add -A && ` +
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
      {
        id: 'compile-knowledge',
        stepType: 'agent' as const,
        agentId: 'COMPILER',
        prompt: `You are the Knowledge Compiler for the "${epicTitle}" project.

For each changed file listed in DIFF_MANIFEST below:

1. If a wiki article already exists in knowledge/code/ for this file:
   - UPDATE it: revise Purpose, Dependencies, Dependents, Signals, Missing Signals
   - Update frontmatter: lastMutatedByStory: "${story.storyId}", updated date, maturity score

2. If no article exists:
   - CREATE one following the standard article format
   - Set frontmatter: createdByStory: "${story.storyId}", createdByEpic: "${opts.epicId || '(not provided)'}", type: code, phase: implementation, status: active

3. For deleted files (D status): mark their article status: superseded

4. Extract any architectural DECISIONS from WORK_SUMMARY:
   - Library choices, pattern selections, API design decisions
   - Create/update articles in knowledge/decisions/
   - Link to the code articles that implement them

5. Update knowledge/system/dependency-map.md with new import relationships

6. Update knowledge/index.md — add new articles, update changed entries

7. Append a compilation record to knowledge/log.md:
   | {ISO timestamp} | ${story.storyId} | success | {created}/{updated}/{superseded} | OK |

Use [[wikilinks]] for ALL cross-references (e.g., [[code/src--components--auth.tsx]]).
File naming: knowledge/code/{slug}.md where slug uses -- for path separators.
Article frontmatter fields: title, type, phase, status, maturity, created, updated, createdByEpic, createdByStory, lastMutatedByStory, tags.
Article sections: Purpose, Key Exports, Dependencies (with [[wikilinks]]), Dependents (with [[wikilinks]]), Signals, Missing Signals, Notes.

Working directory: ${workingDir}
Read source files to understand purpose, exports, and imports before writing articles.

## Story Acceptance Criteria
${story.description}

## Changed Files (DIFF_MANIFEST)
\`\`\`
{{DIFF_MANIFEST}}
\`\`\`

## Developer Work Summary
{{WORK_SUMMARY}}`,
        captureAs: 'COMPILE_RESULT',
        extractors: {},
        validations: [],
        onFail: { action: 'fail' as const },
      },
      // Story A.4: verify post-sync. Drop the legacy `|| echo "skipped"`
      // patterns that swallowed errors silently — if graph-sync or s3 sync
      // fails (or sync succeeds but the target bucket is empty), the step now
      // exits non-zero and the daemon writes a `compile-sync-failed`
      // attention item (see daemon/agent-daemon.mjs compile catch-block).
      // Memgraph node-count verification is intentionally deferred — mgconsole
      // is slower and adds run-time variability; the wave-close compiler
      // (Epic E) will fold it into a single async post-wave check.
      {
        id: 'compile-sync',
        stepType: 'shell' as const,
        command:
          `set -e; ` +
          `cd ${workingDir} && ` +
          `node /home/ubuntu/scripts/graph-sync.mjs ` +
          `--project ${projectId} ` +
          `--knowledge-dir ${workingDir}/knowledge ` +
          `--state-file ${workingDir}/.mycelium/compile-state.json && ` +
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
    ],
  };
}
