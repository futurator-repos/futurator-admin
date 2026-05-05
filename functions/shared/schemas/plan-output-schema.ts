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

export const storyOutputSchema = z.object({
  id: localStoryIdSchema,
  title: z.string().min(3),
  description: z.string().min(10),
  /** Local story IDs within THIS epic that must finish first. */
  dependsOn: z.array(localStoryIdSchema).default([]),
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
