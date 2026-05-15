/**
 * Compile Pipeline — Step Definitions for the COMPILE phase
 *
 * Defines the 3-step COMPILE phase (diff-extract, compile-knowledge, embed-sync)
 * as a pipeline extension. These steps are appended after the REVIEWER step
 * in generateStoryPipeline().
 *
 * The COMPILE phase is NON-BLOCKING: failures do not prevent story completion.
 *
 * Usage:
 *   import { getCompileSteps, getCompilerAgent } from './compile-pipeline.mjs';
 *   const steps = getCompileSteps(projectId, workingDir, epicId, storyId);
 *   const agent = getCompilerAgent();
 */

import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { buildAgentConfig } from './lib/role-policy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Load the compiler prompt template from disk.
 * Falls back to an inline minimal prompt if the file is missing.
 */
function loadCompilerPrompt() {
  try {
    return readFileSync(join(__dirname, 'compiler-prompt.md'), 'utf8');
  } catch {
    // Fallback inline prompt if the file hasn't been deployed yet
    return `You are the Knowledge Compiler. Process each file in the DIFF_MANIFEST and create/update wiki articles in the knowledge/ directory. Use [[wikilinks]] for all cross-references.`;
  }
}

/**
 * Returns the COMPILER agent configuration for the pipeline definition.
 *
 * PR-32b — uses the daemon-side role-policy mirror so the allow/deny
 * strings stay byte-identical to the API Lambda's story-pipeline COMPILER
 * (parity test in functions/shared/pipelines/__tests__/role-policy-parity.test.ts).
 *
 * @returns {{ COMPILER: { name: string, allowedTools: string, disallowedTools: string, model: string } }}
 */
export function getCompilerAgent() {
  return {
    COMPILER: buildAgentConfig({
      role: 'COMPILER',
      name: 'Knowledge Compiler',
      // Haiku is sufficient for structured markdown templating.
      // Sonnet caused OOM on t2.micro when 5 compilers ran in parallel.
      model: 'haiku',
    }),
  };
}

/**
 * Returns the 5-step COMPILE phase as a PipelineStep array (PR-44).
 *
 * Step 0: compile-commit-on-pass (shell) — per-story local git commit so
 *         HEAD~1..HEAD always scopes to a single story's edits.
 * Step A: compile-diff       (shell) — git diff extraction → DIFF_MANIFEST.
 * Step B: compile-knowledge  (agent) — Knowledge Compiler creates/updates
 *         wiki articles.
 * Step C: compile-sync       (shell) — embed articles via Voyage AI, upsert
 *         to Memgraph, S3 backup.
 * Step D: compile-push       (shell, PR-44, soft-fail) — push origin HEAD so
 *         per-story commits reach GitHub. Mirrors PR-19 from the step-based
 *         pipeline. Soft-fail (network blip, conflict) shouldn't stall the
 *         pipeline; the next compile-push or a manual `git push` resolves.
 *
 * History — PR-44 (2026-05-06): added `compile-commit-on-pass` and
 * `compile-push` to the orchestrator path. brick-breaker forensic
 * (docs/concepts/logs/plan_brick-breaker_mou3l51l-forensic-review.md §F-3)
 * showed eleven stories' commits never reached GitHub because the
 * orchestrator path's compile sequence had no push step. Step-based
 * pipeline gained these via PR-A.3 + PR-19; orchestrator was missed.
 *
 * @param {string} projectId  — project identifier for graph-sync and S3 paths
 * @param {string} workingDir — absolute path to the project workspace
 * @param {string} epicId     — current epic ID for frontmatter context
 * @param {string} storyId    — current story ID for frontmatter context
 * @param {object} [storyContext] — optional story metadata
 * @param {string} [storyContext.title] — story title
 * @param {string} [storyContext.acceptanceCriteria] — story acceptance criteria text
 * @param {string} [storyContext.epicTitle] — epic title
 * @returns {Array} PipelineStep array for the COMPILE phase
 */
export function getCompileSteps(projectId, workingDir, epicId, storyId, storyContext = {}) {
  const compilerPrompt = loadCompilerPrompt();

  // Build the full prompt with context injections
  const fullPrompt = `${compilerPrompt}

## Context

- **Project ID:** ${projectId}
- **Epic ID:** ${epicId}
- **Story ID:** ${storyId}
- **Epic Title:** ${storyContext.epicTitle || '(unknown)'}
- **Story Title:** ${storyContext.title || '(unknown)'}
- **Working Directory:** ${workingDir}

## Story Acceptance Criteria

${storyContext.acceptanceCriteria || '(not provided)'}

## Changed Files (DIFF_MANIFEST)

\`\`\`
{{DIFF_MANIFEST}}
\`\`\`

## Developer Work Summary

{{WORK_SUMMARY}}

## Existing Knowledge Index

Read the file at ${workingDir}/knowledge/index.md to understand the current catalog before making changes.
`;

  // Escape single quotes in the story title for shell single-quoting.
  const escapedTitle = String(storyContext.title || storyId).replace(/'/g, "'\\''");

  return [
    // PR-44 — Step 0: Per-story commit. Runs before compile-diff so
    // HEAD~1..HEAD always scopes to a single story's edits and the next
    // wave has a clean git state to diff against. Mirrors PR-A.3 from the
    // step-based pipeline. Idempotent: if the cwd isn't a git tree yet,
    // init it and stamp a baseline commit. Without this, brick-breaker-
    // style runs land all eleven stories on the EC2 working tree without
    // any commits → nothing to push at compile-push.
    {
      id: 'compile-commit-on-pass',
      stepType: 'shell',
      command:
        `cd ${workingDir} && ` +
        // Bootstrap: init repo + baseline commit if needed.
        `if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then ` +
        `  git init -q && ` +
        `  git -c user.email=daemon@futurator.local -c user.name='Daemon' add -A && ` +
        `  git -c user.email=daemon@futurator.local -c user.name='Daemon' ` +
        `    commit --allow-empty -q -m 'baseline (auto-bootstrap by daemon)'; ` +
        `fi && ` +
        // Story commit. PR-67 (2026-05-15) — removed --allow-empty and
        // added a non-empty diff guard. spyhunter-1 forensic showed a
        // commit titled "Wire boss spawn, combat, and win/lose
        // conditions" whose actual diff contained only
        // .pipeline/tamper-input.txt + node_modules/.vite metadata +
        // visual-tests.md — zero source code. With --allow-empty the
        // story marked itself "done" while its implementation lived
        // only in the working tree (entire src/app/, src/components/
        // GameScene.ts, src/hooks/useGameLoop.ts untracked). Failing
        // loud forces the upstream orchestrator to handle the case
        // where the dev's writes didn't make it into git.
        `git add -A && ` +
        `SOURCE_CHANGES=$(git diff --cached --name-only | grep -vE '^(node_modules/|\\.pipeline/|\\.mycelium/|knowledge/|visual-tests(-draft)?\\.md$|\\.context/)' | wc -l) && ` +
        `if [ "$SOURCE_CHANGES" -eq 0 ]; then ` +
        `  echo "STORY_COMMIT_EMPTY: no source-code changes staged for story ${storyId}." >&2; ` +
        `  echo "Working tree contents:" >&2; git status --short >&2; ` +
        `  echo "Staged for commit:" >&2; git diff --cached --name-only >&2; ` +
        `  echo "Likely cause: the dev agent's writes weren't tracked by git (new top-level directories may have been added outside the staged paths, or the agent wrote to a different cwd). Investigate before marking the story done." >&2; ` +
        `  exit 1; ` +
        `fi && ` +
        `git -c user.email=daemon@futurator.local -c user.name='Daemon' ` +
        `commit -m 'story: ${storyId} — ${escapedTitle}'`,
      timeout: 30000,
      captureAs: 'STORY_COMMIT_OUTPUT',
      onFail: { action: 'fail', injectAs: 'STORY_COMMIT_ERROR' },
    },

    // Step A: Diff extraction (shell, ~2s, $0)
    {
      id: 'compile-diff',
      stepType: 'shell',
      command: `cd ${workingDir} && mkdir -p .mycelium && (git diff --name-status HEAD~1 HEAD 2>/dev/null | { grep -v -E 'node_modules/|\\.git/|knowledge/|\\.mycelium/' || true; } || find . -newer .mycelium/last-compile-marker -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './knowledge/*' -not -path './.mycelium/*' 2>/dev/null | sed 's|^\\./||' | sed 's/^/A\\t/') && touch .mycelium/last-compile-marker`,
      timeout: 15000,
      captureAs: 'DIFF_MANIFEST',
      onFail: {
        action: 'fail',
        injectAs: 'COMPILE_DIFF_ERROR',
      },
    },

    // Step B: Knowledge compilation (agent, ~$0.03-0.08)
    {
      id: 'compile-knowledge',
      stepType: 'agent',
      agentId: 'COMPILER',
      prompt: fullPrompt,
      captureAs: 'COMPILE_RESULT',
      extractors: {},
      validations: [],
      onFail: {
        action: 'fail',
      },
    },

    // Step C: Embed and sync (shell, ~3s, ~$0.001)
    {
      id: 'compile-sync',
      stepType: 'shell',
      command: [
        // Run graph-sync to embed articles and upsert to Memgraph
        `node /home/ubuntu/scripts/graph-sync.mjs`,
        `--project ${projectId}`,
        `--knowledge-dir ${workingDir}/knowledge`,
        `--state-file ${workingDir}/.mycelium/compile-state.json`,
        // S3 backup only runs after successful graph-sync (&&), without --delete
        // to prevent removing good files after a partial compilation
        `&& aws s3 sync ${workingDir}/knowledge/ s3://futurator-ai-website/knowledge-live/${projectId}/ 2>&1 || echo "S3 backup skipped (non-critical)"`,
      ].join(' '),
      timeout: 60000,
      onFail: {
        action: 'fail',
        injectAs: 'COMPILE_SYNC_ERROR',
      },
    },

    // PR-44 — Step D: Push the per-story commit to GitHub. Mirrors PR-19
    // from the step-based pipeline.
    //
    // Soft-fail by design: a push conflict (network blip, manual operator
    // commit, fast-forward issue, branch protection) shouldn't stall the
    // pipeline. The next story's compile-push or a manual `git push`
    // resolves drift. We log a GIT_PUSH_WARN sentinel so operators can
    // grep for it in logs if commits ever stop landing on origin.
    //
    // brick-breaker forensic §F-3 — eleven stories' work lived only on
    // the EC2 working tree. PR-44 closes that silent-data-loss gap for
    // operators on the orchestrator path (PR-43 redirects new Apps to
    // the step-based pipeline by default; this is the safety net for
    // existing Apps still on orchestrator).
    {
      id: 'compile-push',
      stepType: 'shell',
      command:
        `cd ${workingDir} && ` +
        `git push origin HEAD 2>&1 || ` +
        `(echo 'GIT_PUSH_WARN: push failed (network/conflict/auth) — local commit retained' >&2 ; ` +
        `echo "[compile-push] continuing — next compile-push will retry"; true)`,
      timeout: 30000,
      captureAs: 'GIT_PUSH_OUTPUT',
      onFail: { action: 'continue' },
    },
  ];
}

/**
 * Identifies whether a pipeline step belongs to the COMPILE phase.
 * Used by the daemon to implement non-blocking error handling.
 *
 * Story A.3 added `compile-commit-on-pass` — a per-story `git commit` that
 * runs immediately before compile-diff so HEAD~1..HEAD always scopes to a
 * single story's edits, killing the `find -newer` fallback.
 *
 * @param {string} stepId — the pipeline step ID
 * @returns {boolean}
 */
export function isCompileStep(stepId) {
  return [
    'compile-commit-on-pass',
    'compile-diff',
    'compile-knowledge',
    'compile-sync',
    'compile-push', // PR-19 — git push origin HEAD after the S3 mirror sync
  ].includes(stepId);
}

/**
 * All compile step IDs in execution order.
 */
export const COMPILE_STEP_IDS = [
  'compile-commit-on-pass',
  'compile-diff',
  'compile-knowledge',
  'compile-sync',
  'compile-push', // PR-19
];
