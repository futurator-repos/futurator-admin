import type { Plan } from '../types/plan';
import type { EpicWorkflow, EpicStory } from '../types/epic-workflow';
import type { AgentJob } from '../types/agent-orchestrator';
import {
  planOutputSchema,
  validatePlanReferences,
  validateTouchPointHygiene,
  type PlanOutput,
} from '../schemas/plan-output-schema';
import { computeStoryWavesWithTouchPoints } from './story-waves';
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
    throw new Error(
      'Job has no PLAN_JSON variable — PM agent did not emit the expected fenced output.',
    );
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

  return validatePlanOutputJson(parsed);
}

/**
 * pacman1 disease (2026-06-11) — single validation funnel for a parsed plan
 * JSON value, shared by the PM-job path (parsePlanOutput) and the operator
 * import path (POST /plans/:id/import-plan, including externally-LLM-
 * generated plans pasted into the Concept UI). Schema → cross-references →
 * touch-point hygiene (story-immutable shared infrastructure).
 */
export function validatePlanOutputJson(parsed: unknown): PlanOutput {
  const result = planOutputSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`PLAN_JSON fails schema: ${issues}`);
  }

  const refErrors = validatePlanReferences(result.data);
  if (refErrors.length > 0) {
    throw new Error(`PLAN_JSON reference errors: ${refErrors.join('; ')}`);
  }

  const hygieneErrors = validateTouchPointHygiene(result.data);
  if (hygieneErrors.length > 0) {
    throw new Error(`PLAN_JSON touch-point errors: ${hygieneErrors.join('; ')}`);
  }

  return result.data;
}

/**
 * dragon1 (2026-06-10) — structural visual-coverage gate.
 *
 * The PM emitted a canvas-game plan (sprites, obstacles, HUD) with ZERO
 * `needsBrowser: true` criteria — every AC was unit-testable. Downstream
 * that silently disabled the ENTIRE visual-QA surface: no DEV ever emits
 * VISUAL_TESTS, per-story runtime review never runs, and the plan-level
 * QA Review stage has nothing to execute. For a UI-bearing app that is a
 * planning DEFECT, not a valid decomposition — and a prompt instruction
 * alone cannot guarantee it never recurs.
 *
 * `uiBearing` is data-driven: a boilerplate that declares `qaContext`
 * (dev-server port + healthcheck for screenshots) IS a screenshotable UI
 * app by definition — no keyword matching on the intent. Prototype rigor
 * is exempt (visual QA is explicitly skipped at that rigor).
 *
 * Returns an operator-facing error string (regenerate the plan; the PM
 * prompt demands idle-visible browser ACs on UI-bearing stories), or
 * null when coverage is fine.
 */
export function validateVisualCoverage(
  output: PlanOutput,
  opts: { uiBearing: boolean; rigor?: string },
): string | null {
  if (!opts.uiBearing || opts.rigor === 'prototype') return null;
  const browserAcCount = output.plan.epics
    .flatMap((e) => e.stories)
    .flatMap((s) => s.criteria)
    .filter((c) => c.needsBrowser).length;
  if (browserAcCount > 0) return null;
  return (
    'Plan has ZERO needsBrowser acceptance criteria, but this app is UI-bearing ' +
    '(its boilerplate boots a dev server that gets screenshotted). This would ' +
    'disable visual QA for the whole plan: no VISUAL_TESTS, no per-story runtime ' +
    'review, nothing for the QA Review stage to run. Regenerate the plan — every ' +
    'story that renders something must carry at least one idle-visible ' +
    'needsBrowser AC (e.g. "at load the canvas shows the player sprite on the ' +
    'ground band", "the HUD reads Score: 0").'
  );
}

/**
 * pacman1 disease (2026-06-11) — inverse of applyPlanOutput: map persisted
 * EpicWorkflow rows back to the PM-output JSON shape (local E1/Sn ids).
 * Powers the Concept UI's Export-JSON and Edit-plan round-trip: export →
 * (operator or external LLM edits) → import re-validates through the same
 * funnel and re-applies. UUIDs are intentionally dropped; import allocates
 * fresh ones, exactly like a regenerate.
 *
 * Story local IDs are GLOBALLY sequential across epics (S1..Sn in epic
 * order) to match how the PM numbers them; dependsOn references resolve
 * within the same epic per the schema contract.
 */
export function epicsToPlanOutput(plan: Plan, epics: EpicWorkflow[]): PlanOutput {
  const orderedEpics = [...epics].sort(
    (a, b) => plan.epicIds.indexOf(a.epicId) - plan.epicIds.indexOf(b.epicId),
  );
  const epicLocalById = new Map<string, string>();
  orderedEpics.forEach((e, i) => epicLocalById.set(e.epicId, `E${i + 1}`));

  let storyCounter = 0;
  return {
    plan: {
      name: plan.name,
      description: plan.description || plan.intent || '',
      epics: orderedEpics.map((epic) => {
        const storyLocalById = new Map<string, string>();
        const orderedStories = [...epic.stories].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        for (const s of orderedStories) {
          storyCounter += 1;
          storyLocalById.set(s.storyId, `S${storyCounter}`);
        }
        return {
          id: epicLocalById.get(epic.epicId)!,
          title: epic.title,
          goal: epic.description || '',
          acceptanceCriteria: epic.acceptanceCriteria || '',
          dependsOn: (epic.dependsOnEpics ?? [])
            .map((id) => epicLocalById.get(id))
            .filter((id): id is string => !!id),
          stories: orderedStories.map((s) => ({
            id: storyLocalById.get(s.storyId)!,
            title: s.title,
            description: s.description,
            dependsOn: (s.dependsOn ?? [])
              .map((id) => storyLocalById.get(id))
              .filter((id): id is string => !!id),
            touchPoints: s.touchPoints ?? [],
            criteria: (s.criteria ?? []).map((c) => ({
              id: c.id,
              text: c.text,
              needsBrowser: !!c.needsBrowser,
            })),
          })),
        };
      }),
    },
  };
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

    // pacman1 disease (2026-06-11) — waves now honor BOTH constraints:
    // dependsOn order AND touch-point disjointness. Two siblings that
    // declared the same file are serialized into different waves here, at
    // plan time, instead of colliding at the merge gate. `<EPIC_WIDE>`
    // stories get a wave to themselves.
    const waves = computeStoryWavesWithTouchPoints(
      preStories.map(({ storyId, storyDeps, storyOut, order }) => ({
        storyId,
        dependsOn: storyDeps,
        touchPoints: storyOut.touchPoints,
        order,
      })),
    );

    const stories: EpicStory[] = preStories.map(({ storyId, order, storyOut, storyDeps }) => ({
      storyId,
      order,
      title: storyOut.title,
      description: storyOut.description,
      status: 'pending',
      wave: waves.get(storyId) ?? 0,
      // PM-declared file scope (was hardcoded [] — the declared touch
      // points never reached the story row, so the DEV prompt's
      // TOUCH_POINTS and the reviewer scope check ran blind).
      touchPoints: storyOut.touchPoints ?? [],
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
