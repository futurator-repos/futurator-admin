import type { PipelineDefinition, PipelineStep } from '../types/agent-orchestrator';
import type { BoilerplateType } from '../boilerplates/registry';

/**
 * Pipeline slot class — mirrors wave-compile-pipeline's `concurrencyClass`. The
 * shared `agent-orchestrator` types don't export a named union for this today
 * (wave-compile imports a non-existent `ConcurrencyClass`), so it's declared
 * locally to keep this file type-clean rather than propagating that gap.
 */
export type ConcurrencyClass = 'background' | 'interactive' | 'critical';
import type { PlanRigor } from '../types/plan';
import { buildAgentConfig } from './role-policy';
import { deriveProjectId } from './derive-project-id';
import { ARCH_SHARD_START_DELIMITER, ARCH_SHARD_END_DELIMITER } from '../prompts/arch-shard-prompt';

/**
 * Agentic Document Center (E3.3) — the subsystem arch-shard compile pipeline.
 *
 * Cloned from `wave-compile-pipeline.ts`: one Architect step that synthesizes a
 * single subsystem's god-doc SHARD from its member knowledge articles, emitting
 * the shard markdown between the arch-shard fences. The full prompt body is
 * built by the daemon (`buildArchShardPrompt` + `{{MEMBER_ARTICLES}}` filled
 * from `knowledge/code/*.md` on disk) — the Lambda CANNOT read EC2 disk, so it
 * enqueues this with a placeholder prompt and the daemon swaps in the real one
 * (the same WAVE_COMPILE_PROMPT_PLACEHOLDER seam, and the same `{{...}}`
 * substitution mechanism `loadPriorArtifacts`/`loadCitableSections` use).
 *
 * One job per subsystem shard. The post-completion daemon writes the shard via
 * `doc-shard-writer.writeShard`, and once a god doc's shards are all present
 * assembles + writes the projection via `doc-assembler` + `writeProjection`.
 *
 * Concurrency: `background` (E.4 reasoning) — shard compilation yields slots to
 * interactive/critical dev/review work, exactly like wave-compile.
 */

export interface ArchShardCompilePipelineInput {
  /** Plan-level project ID — used for the shard sync path. */
  projectId?: string;
  /** Absolute project root on the worker (e.g. `/home/ubuntu/projects/foo`). */
  workingDir: string;
  /** The god-doc family this shard belongs to (e.g. 'architecture'). */
  docType?: string;
  /** The subsystem's shardKey — e.g. `§sys:src--auth`. */
  shardKey: string;
  /** Human boundary path — e.g. `src/auth`. */
  boundary: string;
  /** Member code nodeIds in this subsystem. */
  members: string[];
  /** Other subsystems this one depends on (their shardKeys). */
  depends?: string[];
  /** Boilerplate kind for the agent policy bucket. */
  boilerplateType?: BoilerplateType;
  /** Plan rigor — feeds the agent policy. */
  rigor?: PlanRigor;
  /** Override the ARCHITECT model. Defaults to env or 'sonnet'. */
  model?: string;
  /** Override the slot class. Defaults to 'background'. */
  concurrencyClass?: ConcurrencyClass;
}

const ARCH_SHARD_PIPELINE_VERSION = 1;

/**
 * Sentinel prompt the daemon swaps for the real `buildArchShardPrompt` output
 * once the on-disk member articles are resolved. A detectable string so the
 * daemon can assert "I must replace this before spawning the agent".
 */
export const ARCH_SHARD_PROMPT_PLACEHOLDER = '<arch-shard-prompt-pending-substitution>';

export function generateArchShardCompilePipeline(
  input: ArchShardCompilePipelineInput,
): PipelineDefinition & {
  pipelineKind: 'arch-shard-compile';
  pipelineVersion: number;
  concurrencyClass: ConcurrencyClass;
} {
  const {
    projectId = deriveProjectId(input.workingDir),
    docType = 'architecture',
    shardKey,
    boundary,
    members,
    depends = [],
    boilerplateType = 'nextjs-base',
    rigor = 'mvp',
    model,
    concurrencyClass = 'background',
  } = input;

  return {
    initialVariables: {
      PROJECT_ID: projectId,
      DOC_TYPE: docType,
      SHARD_KEY: shardKey,
      SHARD_BOUNDARY: boundary,
      // Serialized so the daemon-side prompt builder
      // (buildArchShardPrompt) can assemble the prompt + fill
      // {{MEMBER_ARTICLES}} from disk without re-pulling from DDB.
      SHARD_MEMBERS: JSON.stringify(Array.isArray(members) ? members : []),
      SHARD_DEPENDS: JSON.stringify(Array.isArray(depends) ? depends : []),
    },
    maxIterations: 1,
    agents: {
      // The doc-author bucket (Read + WebSearch), same as arch-gen — but the
      // shard prompt forbids re-reading source, so this is effectively a
      // synthesis-only turn over inlined articles.
      ARCHITECT: buildAgentConfig({
        boilerplateKind: boilerplateType,
        rigor,
        role: 'DOC_GEN',
        name: 'Architect (Winston) — subsystem shard',
        model: model || process.env.COMPILER_MODEL || 'sonnet',
      }),
    },
    steps: [
      {
        id: 'arch-shard-compile',
        stepType: 'agent' as const,
        agentId: 'ARCHITECT',
        // Daemon swaps this for buildArchShardPrompt(...) with {{MEMBER_ARTICLES}}
        // filled from knowledge/code/*.md before spawning the agent.
        prompt: ARCH_SHARD_PROMPT_PLACEHOLDER,
        captureAs: 'ARCH_SHARD_RESULT',
        extractors: {
          ARCH_SHARD_MD: {
            type: 'between' as const,
            startDelimiter: ARCH_SHARD_START_DELIMITER,
            endDelimiter: ARCH_SHARD_END_DELIMITER,
          },
        },
        validations: [],
        onFail: { action: 'fail' as const },
      } satisfies PipelineStep,
    ],
    pipelineKind: 'arch-shard-compile',
    pipelineVersion: ARCH_SHARD_PIPELINE_VERSION,
    concurrencyClass,
  };
}
