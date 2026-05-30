import type {
  PipelineDefinition,
  PipelineStep,
  ConcurrencyClass,
} from '../types/agent-orchestrator';
import type { EpicStory } from '../types/epic-workflow';
import { buildAgentConfig } from './role-policy';
import { deriveProjectId } from './derive-project-id';

/**
 * Wave-compile pipeline — Epic E.2 / E.3 / E.4 (pipeline-v1 dev correction).
 *
 * One pipeline per WAVE (not per story). The cron wave-completion-check
 * dispatches a single `wave-compile` job after every story in a wave has
 * reached DONE and the build/server gate passes. The pipeline runs all
 * knowledge compilation in one Haiku turn — no parallel-write race on
 * shared knowledge files (one writer), and the per-story compile-knowledge
 * step is skipped (E.1) so each story terminates faster.
 *
 * Steps:
 *   1. wave-compile-prepare (shell)
 *      - Builds the combined wave diff (`git diff <wave-start-sha> HEAD`)
 *      - Captures the per-story WORK_SUMMARYs into a single context blob
 *
 *   2. wave-compile-knowledge (agent, COMPILER, Haiku)
 *      - Same `<project_context>` block as Epic B → cache reuse with
 *        DEV/REVIEWER for the same plan
 *      - Receives `<wave_input>` with all stories' diffs + WORK_SUMMARYs
 *      - Emits a single `---WAVE_KNOWLEDGE_OUTPUT---` block; the daemon
 *        writes each `---FILE: …---` sub-block atomically
 *
 *   3. wave-compile-sync (shell)
 *      - Memgraph upsert via graph-sync.mjs (relocated from the per-story
 *        compile-sync that A.4 hardened)
 *      - S3 mirror to `s3://futurator-ai-website/knowledge-live/<projectId>/`
 *      - Verifies the S3 mirror is non-empty after sync
 *
 * Concurrency: pipeline-level `concurrencyClass: 'background'` (E.4) so the
 * wave-compile job yields slots to interactive/critical jobs (active dev /
 * review work) instead of competing for memory.
 */

export interface WaveCompilePipelineInput {
  /** Plan-level project ID — used for S3 mirror path + graph-sync. */
  projectId?: string;
  /** Absolute project root on the worker (e.g. `/home/ubuntu/projects/foo`). */
  workingDir: string;
  /** Epic this wave belongs to. */
  epicId: string;
  /** Epic title (rendered into prompt for context only). */
  epicTitle?: string;
  /** Wave number (0-indexed) the compile-job covers. */
  wave: number;
  /**
   * Stories that finished in this wave, in declaration order. Each story's
   * `workSummary` (Epic B.6) is forwarded to the compiler so it can produce
   * coherent articles without re-reading source files the dev just edited.
   */
  stories: EpicStory[];
  /**
   * Wave-start git SHA — the commit immediately before the first story in
   * this wave landed. The combined wave diff is `git diff <waveStartSha> HEAD`.
   * If unknown, the prepare step falls back to `HEAD~<N>` where N is the
   * story count.
   */
  waveStartSha?: string;
  /** Override the COMPILER agent's model. Defaults to env COMPILER_MODEL or 'haiku'. */
  compilerModel?: string;
  /** Override the slot class. Defaults to 'background' per Story E.4. */
  concurrencyClass?: ConcurrencyClass;
}

const WAVE_PIPELINE_VERSION = 1;

/**
 * Construct the wave-compile pipeline definition. The shape mirrors
 * `generateStoryPipeline` so the daemon's existing executePipeline can
 * consume it without special-casing.
 */
export function generateWaveCompilePipeline(input: WaveCompilePipelineInput): PipelineDefinition & {
  pipelineKind: 'wave-compile';
  pipelineVersion: number;
  concurrencyClass: ConcurrencyClass;
} {
  const {
    projectId = deriveProjectId(input.workingDir),
    workingDir,
    epicId,
    epicTitle,
    wave,
    stories,
    waveStartSha,
    compilerModel,
    concurrencyClass = 'background',
  } = input;

  const compileSinceArg = waveStartSha
    ? quoteShell(waveStartSha)
    : `HEAD~${Math.max(1, stories.length)}`;

  return {
    initialVariables: {
      EPIC_ID: epicId,
      EPIC_TITLE: epicTitle || '(unknown)',
      WAVE_NUMBER: String(wave),
      PROJECT_ID: projectId,
      STORY_COUNT: String(stories.length),
      // The serialized story manifest (storyId, title, touchPoints, workSummary)
      // is captured here so the daemon-side prompt builder
      // (wave-knowledge-output-parser.mjs::buildWaveCompilePrompt) can
      // assemble <wave_input> without re-pulling from DDB.
      WAVE_STORY_MANIFEST: JSON.stringify(
        stories.map((s) => ({
          storyId: s.storyId,
          title: s.title || '',
          description: s.description || '',
          touchPoints: Array.isArray(s.touchPoints) ? s.touchPoints : [],
          workSummary: s.workSummary || '',
        })),
      ),
    },
    maxIterations: 1,
    agents: {
      // PR-32 — wave COMPILER policy resolved from RolePolicy. Note: this
      // closes a Phase-1 oversight where the wave-compile COMPILER had no
      // `disallowedTools` (the story-pipeline COMPILER did via PR-3). The
      // resolver normalizes both to deny `Bash,Task,Agent,WebFetch,WebSearch`.
      // Boilerplate kind + rigor default — wave-compile runs after the wave
      // has completed and doesn't carry plan context yet (Story 2-A-1-2 will
      // thread these through).
      COMPILER: buildAgentConfig({
        boilerplateKind: 'nextjs-base',
        rigor: 'mvp',
        role: 'COMPILER',
        name: 'Wave Knowledge Compiler',
        // Story A.1 / E.4: env-gated, default 'haiku'. Sonnet caused OOM
        // when running on t2.micro alongside dev work.
        model: compilerModel || process.env.COMPILER_MODEL || 'haiku',
      }),
    },
    steps: [
      // Step 1: collect the wave diff into a single string the compiler agent
      // can read in <step_input>. The wave-start SHA is preferred when known.
      {
        id: 'wave-compile-prepare',
        stepType: 'shell' as const,
        command:
          `cd ${workingDir} && ` +
          // Combined wave diff (post-A.3 per-story commits make this stable).
          `git diff --name-status ${compileSinceArg} HEAD 2>/dev/null | ` +
          `{ grep -v -E 'node_modules/|\\.git/|knowledge/|\\.mycelium/' || true; }`,
        timeout: 15000,
        captureAs: 'WAVE_DIFF',
        onFail: { action: 'fail' as const, injectAs: 'WAVE_PREPARE_ERROR' },
      },

      // Step 2: agent-side compilation. The full prompt body is built by
      // `buildWaveCompilePrompt` in daemon/pipelines/lib/wave-knowledge-output-parser.mjs
      // — we set a thin marker prompt here and let the daemon swap it in
      // after PROJECT_CONTEXT is resolved. This keeps the API/lambda free
      // of the .mjs prompt builder import (the daemon owns runtime concerns).
      {
        id: 'wave-compile-knowledge',
        stepType: 'agent' as const,
        agentId: 'COMPILER',
        prompt: WAVE_COMPILE_PROMPT_PLACEHOLDER,
        captureAs: 'WAVE_KNOWLEDGE_RESULT',
        extractors: {
          WAVE_KNOWLEDGE_OUTPUT: {
            type: 'between' as const,
            startDelimiter: '---WAVE_KNOWLEDGE_OUTPUT---',
            endDelimiter: '---END_WAVE_KNOWLEDGE_OUTPUT---',
          },
        },
        validations: [],
        onFail: { action: 'fail' as const },
      } satisfies PipelineStep,

      // Step 3: post-compile sync. Mirrors the A.4-hardened sync — graph-sync
      // → S3 sync → verify non-empty mirror. Failures bubble up as
      // `compile-sync-failed` attention items via the daemon's compile catch
      // block (story-pipeline.ts pattern).
      {
        id: 'wave-compile-sync',
        stepType: 'shell' as const,
        command:
          // Pipeline v2.0 PR-6 (E) — graph-sync.mjs may not be deployed.
          // Skip cleanly when missing rather than fail the step.
          `set -e; ` +
          `cd ${workingDir} && ` +
          `if [ -f /home/ubuntu/scripts/graph-sync.mjs ]; then ` +
          `  node /home/ubuntu/scripts/graph-sync.mjs ` +
          `    --project ${projectId} ` +
          `    --knowledge-dir ${workingDir}/knowledge ` +
          `    --state-file ${workingDir}/.mycelium/compile-state.json; ` +
          `else ` +
          `  echo "[wave-compile-sync] graph-sync.mjs not deployed — skipping Memgraph upsert (non-critical)"; ` +
          `fi && ` +
          `aws s3 sync ${workingDir}/knowledge/ ` +
          `s3://futurator-ai-website/knowledge-live/${projectId}/ && ` +
          `S3_COUNT=$(aws s3 ls s3://futurator-ai-website/knowledge-live/${projectId}/ ` +
          `--recursive --summarize 2>/dev/null | awk '/Total Objects:/ {print $3}'); ` +
          `if [ -z "$S3_COUNT" ] || [ "$S3_COUNT" -eq 0 ]; then ` +
          `  echo 'EMPTY_S3_MIRROR: knowledge-live/${projectId} has 0 objects after wave-compile sync' >&2; ` +
          `  exit 1; ` +
          `fi; ` +
          `echo "Wave knowledge mirror verified: $S3_COUNT objects under knowledge-live/${projectId}/"`,
        timeout: 90000,
        onFail: { action: 'fail' as const, injectAs: 'WAVE_COMPILE_SYNC_ERROR' },
      },
    ],
    pipelineKind: 'wave-compile',
    pipelineVersion: WAVE_PIPELINE_VERSION,
    concurrencyClass,
  };
}

/**
 * Sentinel prompt the daemon swaps for the real `buildWaveCompilePrompt`
 * output once the per-job PROJECT_CONTEXT is resolved. Keeping this as a
 * detectable string means the daemon can assert "I must replace this before
 * spawning the agent" and surface a clear error if the wiring drifts.
 */
export const WAVE_COMPILE_PROMPT_PLACEHOLDER = '<wave-compile-prompt-pending-substitution>';

// 2026-05-30 — uses the shared worktree-aware deriveProjectId (was a local
// last-segment derivation that keyed knowledge by storyId under worktrees).

function quoteShell(value: string): string {
  if (!/[\s'"$`\\!]/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
