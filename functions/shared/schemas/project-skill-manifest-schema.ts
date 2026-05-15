/**
 * Project skill manifest schema — Pipeline v2 Phase 3 / Story 3-C-2-1.
 *
 * One file per project at `.claude/skills.manifest.yaml`. Equivalent of
 * `package-lock.json` for skills: machine-generated, reproducible, lockfile
 * semantics. Operators don't edit by hand — they edit by interacting with
 * SKILL-SCOUT (Story 3-C-3-1). v2.5 §36.
 *
 * Shape (per v2.5 §36 illustrative example):
 *   project: string                — slug matches App.appId
 *   manifest-version: 1            — bump on shape changes
 *   generated-by: string           — `skill-scout@<version>`
 *   core/stack/domain/vendor[]     — pinned skills by kind, source + name + version
 *   plans                          — per-plan overlay skills (plan-scoped)
 *   gaps                           — observed need + encounter count + suggested-action
 *
 * Each skill entry pins to `sha:<40-char>` (preferred, drift-proof) or
 * `tag:<semver>` (acceptable for stable upstream tags). PR-73 commit
 * metadata (Story 3-C-4-1) reads `Skills-Used` from the resolved set of
 * core/stack/domain/vendor entries.
 */

import { z } from 'zod';

/** Version pin: `sha:` (40-char hex) or `tag:` (semver-ish). */
const SkillVersionSchema = z.string().regex(/^(sha:[a-f0-9]{40}|tag:[A-Za-z0-9.+\-_]+)$/, {
  message: 'version must match sha:<40-char-hex> or tag:<version>',
});

const SkillEntrySchema = z.object({
  source: z.string().min(1),
  skill: z.string().min(1),
  version: SkillVersionSchema,
});

/**
 * Plan-scoped skill overlay. Skills installed for a specific plan with a
 * graduate-policy controlling promotion to the project-level set on plan
 * success. Per v2.5 §36 (plans block) and Story 3-C-7 (skill-creator
 * sub-plan automation).
 */
const PlanOverlaySchema = z.object({
  skills: z.array(
    z.object({
      skill: z.string().min(1),
      'graduate-policy': z.enum(['on-plan-success', 'always', 'never']),
    }),
  ),
});

/**
 * A skill gap COMPILER has observed but no federation source carries.
 * After `encounters >= 3` and rigor=production, the daemon spawns a
 * skill-creator sub-plan (Story 3-C-7-1).
 */
const SkillGapSchema = z.object({
  need: z.string().min(1),
  encounters: z.number().int().nonnegative(),
  'suggested-action': z.string().min(1).optional(),
});

export const ProjectSkillManifestSchema = z.object({
  project: z.string().min(1),
  'manifest-version': z.literal(1),
  'generated-by': z.string().min(1),
  core: z.array(SkillEntrySchema).default([]),
  stack: z.array(SkillEntrySchema).default([]),
  domain: z.array(SkillEntrySchema).default([]),
  vendor: z.array(SkillEntrySchema).default([]),
  plans: z.record(z.string(), PlanOverlaySchema).default({}),
  gaps: z.array(SkillGapSchema).default([]),
});

export type ProjectSkillManifest = z.infer<typeof ProjectSkillManifestSchema>;
export type SkillEntry = z.infer<typeof SkillEntrySchema>;
export type SkillKind = 'core' | 'stack' | 'domain' | 'vendor';
export type PlanOverlay = z.infer<typeof PlanOverlaySchema>;
export type SkillGap = z.infer<typeof SkillGapSchema>;

/**
 * Empty manifest scaffold for a fresh project. The bootstrap pipeline
 * writes this verbatim into `.claude/skills.manifest.yaml` before SKILL-
 * SCOUT T1 (Story 3-C-3-2) runs and proposes the first set of pins.
 */
export function emptyManifest(projectSlug: string): ProjectSkillManifest {
  return {
    project: projectSlug,
    'manifest-version': 1,
    'generated-by': 'bootstrap@v2.5',
    core: [],
    stack: [],
    domain: [],
    vendor: [],
    plans: {},
    gaps: [],
  };
}

/**
 * Flatten the four kind buckets to a single ordered list. Used by COMPILER
 * (Story 3-C-4-1) to compute the `Skills-Used:` commit metadata line. Sort
 * order: alphabetical by `<skill>@<source>` to produce deterministic
 * diff-friendly commit messages.
 */
export function flattenSkills(
  manifest: Pick<ProjectSkillManifest, 'core' | 'stack' | 'domain' | 'vendor'>,
): SkillEntry[] {
  return [...manifest.core, ...manifest.stack, ...manifest.domain, ...manifest.vendor].sort(
    (a, b) => `${a.skill}@${a.source}`.localeCompare(`${b.skill}@${b.source}`),
  );
}

/**
 * Format the `Skills-Used:` commit metadata value per v2.5 §40. Produces
 * a single comma+space-separated line of `<skill>@<source>` entries in
 * alphabetical order.
 */
export function skillsUsedCommitLine(
  manifest: Pick<ProjectSkillManifest, 'core' | 'stack' | 'domain' | 'vendor'>,
): string {
  return flattenSkills(manifest)
    .map((e) => `${e.skill}@${e.source}`)
    .join(', ');
}
