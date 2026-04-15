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
 * @returns {{ COMPILER: { name: string, allowedTools: string, model: string } }}
 */
export function getCompilerAgent() {
  return {
    COMPILER: {
      name: 'Knowledge Compiler',
      allowedTools: 'Read,Write,Edit,Glob,Grep',
      model: 'sonnet',
    },
  };
}

/**
 * Returns the 3-step COMPILE phase as a PipelineStep array.
 *
 * Step A: compile-diff   (shell)  — git diff extraction, produces DIFF_MANIFEST
 * Step B: compile-knowledge (agent) — Knowledge Compiler creates/updates wiki articles
 * Step C: compile-sync   (shell)  — embeds articles via Voyage AI, upserts to Memgraph, S3 backup
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

  return [
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
  ];
}

/**
 * Identifies whether a pipeline step belongs to the COMPILE phase.
 * Used by the daemon to implement non-blocking error handling.
 *
 * @param {string} stepId — the pipeline step ID
 * @returns {boolean}
 */
export function isCompileStep(stepId) {
  return ['compile-diff', 'compile-knowledge', 'compile-sync'].includes(stepId);
}

/**
 * All compile step IDs in execution order.
 */
export const COMPILE_STEP_IDS = ['compile-diff', 'compile-knowledge', 'compile-sync'];
