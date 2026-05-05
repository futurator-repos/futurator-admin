import type { Plan } from '../types/plan';
import type { EpicWorkflow, EpicStory } from '../types/epic-workflow';
import type { AgentJob } from '../types/agent-orchestrator';
import { planOutputSchema, validatePlanReferences, type PlanOutput } from '../schemas/plan-output-schema';
import { computeStoryWaves } from './story-waves';
import { computePlanWaves } from './plan-waves';

/**
 * Service for applying a PM-agent's PLAN_JSON output to a Plan row.
 *
 * Responsibilities:
 *   1. Parse + validate the JSON from `job.variables.PLAN_JSON`.
 *   2. Create Epic rows (one per output epic), resolving local IDs to real UUIDs.
 *   3. Create Story rows on each Epic with resolved dependsOn references.
 *   4. Update the Plan row with `epicIds`, `description`, `totalStories`.
 *
 * Returns the refreshed Plan + epics for the caller to render or sync plan.md.
 */

export interface PlanGenerationDeps {
  createEpic: (epic: EpicWorkflow) => Promise<EpicWorkflow>;
  updatePlanFields: (planId: string, patch: Partial<Plan>) => Promise<void>;
  uuid: () => string;
  now: () => string;
}

export interface ApplyPlanOutputResult {
  plan: Plan;
  epics: EpicWorkflow[];
}

/**
 * Parse & validate the PLAN_JSON captured in a completed PM-plan job.
 * Throws with a descriptive error if invalid.
 */
export function parsePlanOutput(job: AgentJob): PlanOutput {
  const raw = job.variables?.PLAN_JSON;
  if (!raw) {
    throw new Error('Job has no PLAN_JSON variable — PM agent did not emit the expected fenced output.');
  }

  // Robustness: strip fence markers if the daemon's extractor retained them,
  // and trim any leading/trailing whitespace or markdown fencing (```json … ```).
  const cleaned = raw
    .replace(/---PLAN_JSON---/g, '')
    .replace(/---END_PLAN_JSON---/g, '')
    .replace(/^```(?:json)?\s*/im, '')
    .replace(/\s*```\s*$/im, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    // 2026-05-02 dino-runner-1 incident: Claude Opus occasionally emits a JSON
    // VALUE wrapped in backticks instead of double-quotes (template-literal
    // muscle memory): `"text":\`...\`,`. Repair that one specific pattern and
    // retry — backticks INSIDE existing double-quoted strings (markdown code
    // spans like \`src/game/types.ts\`) are left alone because the regex only
    // matches when the backtick is immediately preceded by `:` + whitespace.
    const repaired = cleaned.replace(
      /:(\s*)`([^`]+)`(\s*[,\]}])/g,
      (_, before, content, after) => `:${before}${JSON.stringify(content)}${after}`,
    );
    if (repaired !== cleaned) {
      try {
        parsed = JSON.parse(repaired);
      } catch (err2) {
        const message = err2 instanceof Error ? err2.message : String(err2);
        throw new Error(
          `PLAN_JSON is not valid JSON (after backtick repair): ${message}. Raw: ${raw.slice(0, 200)}...`,
        );
      }
    } else {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`PLAN_JSON is not valid JSON: ${message}. Raw: ${raw.slice(0, 200)}...`);
    }
  }

  const result = planOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`PLAN_JSON fails schema: ${issues}`);
  }

  const refErrors = validatePlanReferences(result.data);
  if (refErrors.length > 0) {
    throw new Error(`PLAN_JSON reference errors: ${refErrors.join('; ')}`);
  }

  return result.data;
}

/**
 * Persist a parsed PLAN_JSON to DDB.
 *
 * Creates one epic row per output epic with real UUIDs + planId set, resolves
 * local dep IDs (E1 → epic-A's UUID), and updates the parent Plan's rollup.
 */
export async function applyPlanOutput(
  plan: Plan,
  output: PlanOutput,
  deps: PlanGenerationDeps,
): Promise<ApplyPlanOutputResult> {
  // Allocate a real UUID for each epic (preserves output order so dep resolution works).
  const epicIdsByLocalId = new Map<string, string>();
  for (const epicOut of output.plan.epics) {
    epicIdsByLocalId.set(epicOut.id, deps.uuid());
  }

  const now = deps.now();
  const createdEpics: EpicWorkflow[] = [];
  let totalStories = 0;

  for (const epicOut of output.plan.epics) {
    const epicId = epicIdsByLocalId.get(epicOut.id)!;
    const resolvedDeps = epicOut.dependsOn
      .map((localId) => epicIdsByLocalId.get(localId))
      .filter((id): id is string => !!id);

    // Allocate story UUIDs + build dep resolution map within this epic.
    const storyIdsByLocalId = new Map<string, string>();
    for (const storyOut of epicOut.stories) {
      storyIdsByLocalId.set(storyOut.id, deps.uuid());
    }

    // Pre-compute dep resolution so we can then compute waves over the
    // resolved story list (dep IDs as real UUIDs).
    const preStories = epicOut.stories.map((storyOut, order) => {
      const storyId = storyIdsByLocalId.get(storyOut.id)!;
      const storyDeps = storyOut.dependsOn
        .map((localId) => storyIdsByLocalId.get(localId))
        .filter((id): id is string => !!id);
      return { storyId, order, storyOut, storyDeps };
    });

    // Topologically assign wave numbers based on dependsOn.
    // Stories with empty dependsOn → wave 0 (can run in parallel).
    // Stories that depend on others → wave = max(dep waves) + 1.
    const waves = computeStoryWaves(
      preStories.map(({ storyId, storyDeps }) => ({ storyId, dependsOn: storyDeps })),
    );

    const stories: EpicStory[] = preStories.map(({ storyId, order, storyOut, storyDeps }) => ({
      storyId,
      order,
      title: storyOut.title,
      description: storyOut.description,
      status: 'pending',
      wave: waves.get(storyId) ?? 0,
      touchPoints: [],
      complexity: 'standard',
      reviewRigor: 'standard',
      criteria: storyOut.criteria.map((c) => ({
        id: c.id,
        text: c.text,
        needsBrowser: c.needsBrowser,
      })),
      hasBrowserTests: storyOut.criteria.some((c) => c.needsBrowser),
      dependsOn: storyDeps,
    }));

    const epic: EpicWorkflow = {
      epicId,
      planId: plan.planId,
      dependsOnEpics: resolvedDeps,
      title: epicOut.title,
      description: epicOut.goal,
      acceptanceCriteria: epicOut.acceptanceCriteria,
      workingDir: plan.workingDir,
      status: 'draft',
      stories,
      devModel: plan.devModel,
      devEffort: plan.devEffort,
      reviewerModel: plan.reviewerModel,
      reviewerEffort: plan.reviewerEffort,
      yoloMode: plan.yoloMode,
      useEpicOrchestrator: plan.executionMode === 'orchestrator',
      createdAt: now,
      updatedAt: now,
      createdBy: plan.createdBy,
    };

    createdEpics.push(epic);
    totalStories += stories.length;
  }

  // Compute epicWave for each epic (plan-level topological sort), then
  // persist every epic. Done in a second pass so each epic has its real
  // dependsOnEpics populated before wave computation sees it.
  const epicWaves = computePlanWaves(createdEpics);
  for (const epic of createdEpics) {
    epic.epicWave = epicWaves[epic.epicId] ?? 0;
    await deps.createEpic(epic);
  }

  // Update the plan row with the new epic list + rollup.
  const updatedPlan: Plan = {
    ...plan,
    description: output.plan.description,
    epicIds: createdEpics.map((e) => e.epicId),
    totalStories,
    doneStories: 0,
    updatedAt: now,
  };
  await deps.updatePlanFields(plan.planId, {
    description: updatedPlan.description,
    epicIds: updatedPlan.epicIds,
    totalStories: updatedPlan.totalStories,
    doneStories: 0,
  });

  return { plan: updatedPlan, epics: createdEpics };
}
