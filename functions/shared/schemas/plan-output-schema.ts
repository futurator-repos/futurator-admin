import { z } from 'zod';
import { PLAN_NAME_REGEX } from './plan-schema';

/**
 * JSON the PM agent produces when given an intent.
 *
 * Uses LOCAL IDs (E1, E2, S1, S2) rather than UUIDs so the agent can write
 * cross-references readably. The server resolves local IDs to real UUIDs
 * when persisting via `applyPlanOutput` in plan-generation-service.
 */

const localEpicIdSchema = z.string().regex(/^E\d+$/, 'Epic local IDs must be like "E1"');
const localStoryIdSchema = z.string().regex(/^S\d+$/, 'Story local IDs must be like "S1"');

/**
 * pacman1 disease (2026-06-11) — sentinel for cross-cutting stories that
 * cannot declare a precise file set (integration/refactor stories). A story
 * carrying it is excluded from parallel waves entirely: the touch-point
 * serializer gives it a wave of its own. Mirrors the BMAD
 * create-epics-and-stories contract ("touchPoints: ['<EPIC_WIDE>']").
 */
export const EPIC_WIDE_TOUCH_POINT = '<EPIC_WIDE>';

export const storyOutputSchema = z.object({
  id: localStoryIdSchema,
  title: z.string().min(3),
  description: z.string().min(10),
  /** Local story IDs within THIS epic that must finish first. */
  dependsOn: z.array(localStoryIdSchema).default([]),
  /**
   * pacman1 disease (2026-06-11) — the file paths this story will create or
   * modify. The BMAD workflow contract always REQUIRED this ("the
   * wave-conflict resolver uses this to serialize stories that would collide
   * on the same file") but the schema never carried it and apply hardcoded
   * `[]` — so the promised serialization never existed and parallel siblings
   * collided at every merge gate. The PM prompt requires it; `.default([])`
   * keeps old PM outputs and hand-written imports parseable (empty = no
   * serialization information, waves fall back to dependsOn only).
   */
  touchPoints: z.array(z.string().min(1)).default([]),
  criteria: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().min(5),
        needsBrowser: z.boolean().default(false),
      }),
    )
    .min(1, 'Each story must have at least one acceptance criterion'),
});

export const epicOutputSchema = z.object({
  id: localEpicIdSchema,
  title: z.string().min(3),
  goal: z.string().min(10),
  acceptanceCriteria: z.string().default(''),
  /** Local epic IDs that must complete first. */
  dependsOn: z.array(localEpicIdSchema).default([]),
  stories: z.array(storyOutputSchema).min(1, 'Each epic must have at least one story'),
});

export const planOutputSchema = z.object({
  plan: z.object({
    name: z.string().regex(PLAN_NAME_REGEX),
    description: z.string().min(20),
    epics: z.array(epicOutputSchema).min(1, 'Plan must have at least one epic'),
  }),
});

export type PlanOutput = z.infer<typeof planOutputSchema>;
export type EpicOutput = z.infer<typeof epicOutputSchema>;
export type StoryOutput = z.infer<typeof storyOutputSchema>;

/**
 * Cross-reference validations that Zod can't express structurally.
 *
 * - Epic dependsOn references must point at epics earlier in the array.
 * - Story dependsOn references must point at stories earlier in the same epic.
 * - No duplicate epic IDs; no duplicate story IDs within an epic.
 */
/**
 * pacman1 disease (2026-06-11) — story-immutable shared infrastructure.
 *
 * Stories run in parallel worktrees; any story that edits a project-global
 * file (dependency manifest, lockfile, build/test/runtime config) collides
 * with siblings and drifts the shared world-view between waves. These are
 * pipeline-platform invariants (every boilerplate ships and owns them — the
 * project CLAUDE.md states the same rule to the agents), not app-domain
 * knowledge. A plan whose touchPoints claim them is mis-scoped: the route
 * rejects it with this message so the operator regenerates.
 */
const INFRA_TOUCH_POINT_RE =
  /(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|vitest\.config\.[cm]?[jt]s|jest\.config\.[cm]?[jt]s|next\.config\.[cm]?[jt]s|tsconfig(\..+)?\.json|eslint\.config\.[cm]?[jt]s|\.eslintrc(\..+)?|postcss\.config\.[cm]?[jt]s|\.prettierrc(\..+)?|\.prettierignore|knip\.json|lint-staged\.config\.[cm]?js)$|(^|\/)(node_modules|\.husky)(\/|$)/;

export function validateTouchPointHygiene(output: PlanOutput): string[] {
  const errors: string[] = [];
  for (const epic of output.plan.epics) {
    for (const story of epic.stories) {
      for (const tp of story.touchPoints) {
        if (tp === EPIC_WIDE_TOUCH_POINT) continue;
        if (tp.startsWith('/') || tp.includes('..')) {
          errors.push(
            `Story ${story.id} (epic ${epic.id}) touch point "${tp}" must be a relative path inside the project`,
          );
          continue;
        }
        if (INFRA_TOUCH_POINT_RE.test(tp)) {
          errors.push(
            `Story ${story.id} (epic ${epic.id}) touch point "${tp}" is template-owned shared infrastructure — stories must never modify dependency manifests, lockfiles, or build/test config. Re-scope the story to use what the scaffold provides.`,
          );
        }
      }
    }
  }
  return errors;
}

export function validatePlanReferences(output: PlanOutput): string[] {
  const errors: string[] = [];

  const seenEpicIds = new Set<string>();
  output.plan.epics.forEach((epic, idx) => {
    if (seenEpicIds.has(epic.id)) errors.push(`Duplicate epic id ${epic.id}`);
    seenEpicIds.add(epic.id);

    // Epic deps must be earlier epics
    for (const dep of epic.dependsOn) {
      if (!seenEpicIds.has(dep) || dep === epic.id) {
        errors.push(`Epic ${epic.id} depends on ${dep} which is not an earlier epic`);
      }
    }

    // Story deps must reference earlier stories in the same epic
    const seenStoryIds = new Set<string>();
    epic.stories.forEach((story, sidx) => {
      if (seenStoryIds.has(story.id)) {
        errors.push(`Duplicate story id ${story.id} in epic ${epic.id}`);
      }
      seenStoryIds.add(story.id);

      for (const dep of story.dependsOn) {
        if (!seenStoryIds.has(dep) || dep === story.id) {
          errors.push(
            `Story ${story.id} (epic ${epic.id}) depends on ${dep} which is not an earlier story in the same epic`,
          );
        }
      }

      void sidx;
    });
    void idx;
  });

  return errors;
}
