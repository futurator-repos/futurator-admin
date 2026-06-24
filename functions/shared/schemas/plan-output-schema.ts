import { z } from 'zod';
import { PLAN_NAME_REGEX } from './plan-schema';
import { hasSection, type SectionManifest } from '../concept/section-manifest';

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

/**
 * Concept v2 — PM-set verify intent + closed manual-reason enum. Mirrors the
 * `VerifyIntent` / `ManualReason` unions in `functions/shared/types/epic-workflow.ts`.
 * Keep the two in sync (the type is the source of truth; this is the wire validator).
 */
export const verifyIntentSchema = z.enum(['build', 'appearance', 'state', 'behavior', 'manual']);
export const manualReasonSchema = z.enum([
  'real-payment',
  'oauth-consent',
  'captcha',
  'native-device',
  'email-sms-loop',
  'subjective-quality',
  'video-audio-perception',
  'no-stub-possible',
]);

/**
 * One acceptance criterion. The legacy `{id, text, needsBrowser}` shape stays
 * the required core; Concept v2 adds optional BDD structure + verify intent so
 * old PM outputs and hand-written imports still parse. The `manual` ⇒ require
 * `manualReason` rule is enforced via `.superRefine` (Concept §8 anti-escape-hatch).
 */
export const acceptanceCriterionSchema = z
  .object({
    id: z.string(),
    text: z.string().min(5),
    needsBrowser: z.boolean().default(false),
    // ── Concept v2 (BMAD BDD) — all optional ──
    given: z.string().optional(),
    when: z.string().optional(),
    then: z.string().optional(),
    thenObservable: z.string().optional(),
    verify: verifyIntentSchema.optional(),
    manualReason: manualReasonSchema.optional(),
  })
  .superRefine((ac, ctx) => {
    if (ac.verify === 'manual' && !ac.manualReason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['manualReason'],
        message: "A 'manual' acceptance criterion requires a manualReason from the closed enum.",
      });
    }
    // CS-1 coherence rule (safe in the always-on schema because legacy ACs
    // carry NO `verify`, so this never fires on round-tripped legacy plans):
    // `build` is a non-visual check (lint/typecheck/unit/HTTP-200) — it must
    // never claim a browser. Mirrors `deriveNeedsBrowser('build') === false`.
    // The MANDATORY-`verify`-on-browser-ACs rule lives in
    // `validateVerifyCoverage` (gate-only) — NOT here — so the export
    // round-trip of pre-Concept-v2 plans (which lack `verify`) still parses.
    if (ac.verify === 'build' && ac.needsBrowser === true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['needsBrowser'],
        message:
          "verify:'build' is a non-visual check and must not set needsBrowser:true. Use appearance|state|behavior for browser-verified criteria.",
      });
    }
  });

/** Concept v2 — AC-mapped task in the DEV checklist. */
export const storyTaskSchema = z.object({
  id: z.string(),
  text: z.string().min(1),
  acRefs: z.array(z.string()).default([]),
  done: z.boolean().optional(),
});

/**
 * Concept v2 — citation into an upstream artifact section or the harness seam.
 * `section` membership against the artifact manifest is enforced in Epic E4
 * (here it's a free string so prototype/legacy imports still parse).
 */
export const storyReferenceSchema = z.object({
  source: z.enum(['prd', 'architecture', 'ux', 'harness']),
  section: z.string().min(1),
  note: z.string().optional(),
});

export const storyOutputSchema = z.object({
  id: localStoryIdSchema,
  title: z.string().min(3),
  description: z.string().min(10),
  /** Local story IDs within THIS epic that must finish first. */
  dependsOn: z.array(localStoryIdSchema).default([]),
  // ── Concept v2 (BMAD-grade definition) — all optional ──
  userStory: z.object({ role: z.string(), action: z.string(), benefit: z.string() }).optional(),
  technicalNotes: z.string().optional(),
  tasks: z.array(storyTaskSchema).optional(),
  references: z.array(storyReferenceSchema).optional(),
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
    .array(acceptanceCriterionSchema)
    .min(1, 'Each story must have at least one acceptance criterion'),
});

export const epicOutputSchema = z.object({
  id: localEpicIdSchema,
  title: z.string().min(3),
  goal: z.string().min(10),
  acceptanceCriteria: z.string().default(''),
  /** Concept v2 — PRD functional-requirement ids this epic covers (traceability spine). */
  requirementRefs: z.array(z.string()).optional(),
  /** Local epic IDs that must complete first. */
  dependsOn: z.array(localEpicIdSchema).default([]),
  stories: z.array(storyOutputSchema).min(1, 'Each epic must have at least one story'),
});

/**
 * Stage C (qa-review-delivery-rethink §4) — a DELIVERY JOURNEY: a headline,
 * user-facing flow the FINAL QA stage verifies on the merged plan (dev). The PM
 * declares 2–5 of these by CLUSTERING the plan's acceptance criteria into the
 * integrated paths a real user walks ("load & start", "play & score", "win/lose")
 * — so final QA is journey-driven, not a replay of every per-AC test grouped by
 * epic. Optional + additive: a plan without journeys falls back to the heuristic
 * delivery selector (Stage B). `acRefs` cite the ACs the journey covers.
 */
export const deliveryJourneySchema = z.object({
  id: z.string().min(1),
  title: z.string().min(3),
  /** One-line narrative of the integrated path a user walks. */
  narrative: z.string().optional(),
  /** AC ids this journey exercises end-to-end (must resolve to real criteria). */
  acRefs: z.array(z.string()).default([]),
});

export const planOutputSchema = z.object({
  plan: z.object({
    name: z.string().regex(PLAN_NAME_REGEX),
    description: z.string().min(20),
    epics: z.array(epicOutputSchema).min(1, 'Plan must have at least one epic'),
    /** Stage C — optional PM-declared delivery journeys for final QA (see schema above). */
    deliveryJourneys: z.array(deliveryJourneySchema).optional(),
  }),
});

export type DeliveryJourney = z.infer<typeof deliveryJourneySchema>;
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

/**
 * CS-1 (Concept v2.1 / agentic-l2-autonomy-backlog §2) — `verify` is MANDATORY
 * on every browser-bearing AC, enforced at the CONCEPT GATE (not in the
 * always-on schema, so the export round-trip of pre-Concept-v2 plans still
 * parses). The pamcan6 disease: a plan shipped `needsBrowser:true` ACs with NO
 * `verify` intent, so the QA classifier's oracle routing (`deriveLevelFromVerify`)
 * stayed dormant and every dynamic AC collapsed to a blind idle-frame vision
 * judge → false pass/fail. The PM owns the INTENT (build|appearance|state|
 * behavior|manual); the QA-AUTHOR later compiles it into the concrete L-level +
 * probe (altitude rule). Returns one error per offending AC so the gate can
 * reject/repair the freshly generated plan before it reaches story-dev.
 */
export function validateVerifyCoverage(output: PlanOutput): string[] {
  const errors: string[] = [];
  for (const epic of output.plan.epics) {
    for (const story of epic.stories) {
      for (const ac of story.criteria) {
        if (ac.needsBrowser === true && !ac.verify) {
          errors.push(
            `Story ${story.id} (epic ${epic.id}) criterion ${ac.id} is needsBrowser:true but has no \`verify\` intent — add one of appearance|state|behavior|manual so QA can route it to the right oracle (a browser AC with no verify collapses to a blind idle-frame judge).`,
          );
        }
      }
    }
  }
  return errors;
}

/**
 * CS-2 (Concept v2.1 / agentic-l2-autonomy-backlog §2) — collect every
 * `verify:'manual'` AC so the concept gate can SURFACE them to the operator for
 * confirmation (with the `manualReason`), without reclassifying them — the W5
 * altitude rule: Concept only FLAGS `manual`; the `manual→behavior` downgrade is
 * the QA-AUTHOR's call at story-dev (when a stub seam is known). Non-blocking:
 * these are valid ACs, surfaced for a human decision, not rejected.
 */
export interface ManualAcFlag {
  epicId: string;
  storyId: string;
  acId: string;
  text: string;
  manualReason?: string;
}

export function collectManualAcs(output: PlanOutput): ManualAcFlag[] {
  const flags: ManualAcFlag[] = [];
  for (const epic of output.plan.epics) {
    for (const story of epic.stories) {
      for (const ac of story.criteria) {
        if (ac.verify === 'manual') {
          flags.push({
            epicId: epic.id,
            storyId: story.id,
            acId: ac.id,
            text: ac.text,
            manualReason: ac.manualReason,
          });
        }
      }
    }
  }
  return flags;
}

/**
 * Stage C — validate PM-declared delivery journeys: every `acRefs` entry must
 * resolve to a real acceptance-criterion id somewhere in the plan, and each
 * journey must cite at least one AC. Additive (no journeys → no errors), so it
 * never breaks legacy plans. Returns one error per dangling reference.
 */
export function validateDeliveryJourneys(output: PlanOutput): string[] {
  const journeys = output.plan.deliveryJourneys;
  if (!journeys || journeys.length === 0) return [];
  const acIds = new Set<string>();
  for (const epic of output.plan.epics) {
    for (const story of epic.stories) {
      for (const ac of story.criteria) acIds.add(ac.id);
    }
  }
  const errors: string[] = [];
  for (const j of journeys) {
    if (!j.acRefs || j.acRefs.length === 0) {
      errors.push(`Delivery journey "${j.id}" cites no acRefs — a journey must cover ≥1 AC.`);
      continue;
    }
    for (const ref of j.acRefs) {
      if (!acIds.has(ref)) {
        errors.push(
          `Delivery journey "${j.id}" references AC "${ref}", which is not an acceptance criterion in this plan.`,
        );
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

/**
 * Concept v2 (E4.2 / W2) — validate that every story `references[]` into a doc
 * artifact (prd / architecture / ux) cites a section that EXISTS in that
 * artifact's section manifest. This is the mechanizable form of "every
 * reference resolves" — set-membership against the locked manifest (§6.2),
 * reused verbatim by the §8 readiness gate (E9.3).
 *
 * `source: 'harness'` references are NOT checked here — they resolve against
 * `__harness.schema.json` (shipped in Epic E5) and are cross-checked at the gate
 * (E9). A missing manifest for a cited doc source is itself an error (the PM
 * cited an artifact that wasn't generated).
 */
export function validateReferenceSections(
  output: PlanOutput,
  manifests: Partial<Record<'prd' | 'architecture' | 'ux', SectionManifest>>,
): string[] {
  const errors: string[] = [];
  for (const epic of output.plan.epics) {
    for (const story of epic.stories) {
      for (const ref of story.references ?? []) {
        if (ref.source === 'harness') continue; // checked against the harness schema at the gate
        const manifest = manifests[ref.source];
        if (!manifest) {
          errors.push(
            `Story ${story.id} (epic ${epic.id}) references ${ref.source}#${ref.section}, but no ${ref.source} artifact/manifest exists`,
          );
          continue;
        }
        if (!hasSection(manifest, ref.section)) {
          errors.push(
            `Story ${story.id} (epic ${epic.id}) references ${ref.source}#${ref.section}, which is not a section in ${ref.source}.md`,
          );
        }
      }
    }
  }
  return errors;
}
