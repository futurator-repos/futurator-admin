/**
 * api-author-pipeline.ts — Pipeline v2 Phase 2-A / Story 2-A-3-1 (PR-91).
 *
 * Single-step pipeline that runs API-AUTHOR. Inserted between PM and
 * TEST in `story-pipeline.ts` for mvp+ rigor (skipped under prototype
 * per v2.5 §15 + the per-rigor turn-cap matrix in role-policy).
 *
 * Output is a `.d.ts` file on disk, not a between-marker block — the
 * step's success criterion is that `${moduleDir}/index.d.ts` exists +
 * is non-empty after the agent exits. The daemon's frozen-file gate
 * (Story 2-A-5) SHA-256s the file at this point so DEV / TEST can't
 * mutate it.
 */

import type { PipelineDefinition } from '../types/agent-orchestrator';
import { buildApiAuthorPrompt } from '../prompts/api-author-prompt';
import type { BoilerplateType } from '../boilerplates/registry';
import type { PlanRigor } from '../types/plan';
import { buildAgentConfig } from './role-policy';

export interface ApiAuthorPipelineArgs {
  storyId: string;
  storyTitle: string;
  acceptanceCriteria: string;
  moduleDir: string;
  existingExports: {
    types: string[];
    constants: string[];
  };
  boilerplateKind: BoilerplateType;
  rigor: PlanRigor;
  model?: string;
}

/**
 * Build the API-AUTHOR step config. Caller's story-pipeline.ts handles
 * the "skip under prototype" branch — this builder only emits a
 * pipeline definition that runs unconditionally when called.
 */
export function generateApiAuthorPipeline(args: ApiAuthorPipelineArgs): PipelineDefinition {
  const prompt = buildApiAuthorPrompt({
    storyId: args.storyId,
    storyTitle: args.storyTitle,
    acceptanceCriteria: args.acceptanceCriteria,
    moduleDir: args.moduleDir,
    existingExports: args.existingExports,
  });

  return {
    maxIterations: 1,
    agents: {
      API_AUTHOR: buildAgentConfig({
        boilerplateKind: args.boilerplateKind,
        rigor: args.rigor,
        role: 'API_AUTHOR',
        name: 'API Author',
        model: args.model || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'api-author',
        agentId: 'API_AUTHOR',
        prompt,
        extractors: {},
        validations: [],
      },
    ],
  };
}

/**
 * Whether the api-author step runs for the given (rigor, boilerplate)
 * pair. v2.5 §15: skipped under prototype rigor; skipped for stub
 * boilerplates with no shipped tests.
 */
export function shouldRunApiAuthor(args: {
  rigor: PlanRigor;
  boilerplateKind: BoilerplateType;
}): boolean {
  if (args.rigor === 'prototype') return false;
  // Stub boilerplates (sst/vite/mobile) ship no test infrastructure yet.
  if (
    args.boilerplateKind === 'sst' ||
    args.boilerplateKind === 'vite' ||
    args.boilerplateKind === 'mobile'
  ) {
    return false;
  }
  return true;
}

/**
 * Compute the module dir for the .d.ts emit. Caller supplies the story's
 * touchPoints array; this picks the deepest common ancestor under `src/`
 * (or its boilerplate equivalent) so the .d.ts lands at the natural
 * module boundary.
 *
 * Falls back to `src/<storyId>` when touchPoints can't agree on a parent
 * — the daemon emits `attention.api-author-ambiguous-module` and the
 * operator picks.
 */
export function inferModuleDirFromTouchPoints(touchPoints: string[]): {
  moduleDir: string;
  ambiguous: boolean;
} {
  if (!Array.isArray(touchPoints) || touchPoints.length === 0) {
    return { moduleDir: '', ambiguous: true };
  }

  // Strip leading ./ and trailing slashes, normalize.
  const normalized = touchPoints
    .map((p) => p.replace(/^\.\/+/, '').replace(/\/+$/, ''))
    .filter((p) => p.length > 0);

  if (normalized.length === 0) return { moduleDir: '', ambiguous: true };

  // Split each into segments, drop the final filename segment.
  const segLists = normalized.map((p) => {
    const parts = p.split('/');
    // If the last segment looks like a file (has a `.`), drop it.
    if (parts[parts.length - 1].includes('.')) parts.pop();
    return parts;
  });

  // Find common prefix.
  const prefix = [];
  const shortest = Math.min(...segLists.map((l) => l.length));
  for (let i = 0; i < shortest; i++) {
    const seg = segLists[0][i];
    if (segLists.every((l) => l[i] === seg)) {
      prefix.push(seg);
    } else {
      break;
    }
  }

  // Ambiguous if common prefix is empty or trivially shallow (only the
  // source root like `src/` or `app/`).
  const SOURCE_ROOTS = new Set(['src', 'app', 'lib', 'functions', 'components']);
  if (prefix.length === 0) return { moduleDir: '', ambiguous: true };
  if (prefix.length === 1 && SOURCE_ROOTS.has(prefix[0])) {
    return { moduleDir: prefix.join('/'), ambiguous: true };
  }

  return { moduleDir: prefix.join('/'), ambiguous: false };
}
