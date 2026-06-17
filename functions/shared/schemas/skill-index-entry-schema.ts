/**
 * skill-index-entry-schema.ts — Skills Institution, Story 2.1 (2026-06-17).
 *
 * The canonical contract for one `index.json` skill entry, EXTENDED with the
 * curation facets the Skills Institution needs (FR5). The pre-institution shape
 * was seven loose fields read ad-hoc in `skill-catalog.ts` and `skill-authoring.ts`
 * (name, kind, framework, version, license, description, provenance?). This file
 * makes that shape a zod contract and adds six OPTIONAL facets so the registry
 * can be curated, filtered, and trust-gated.
 *
 * Backward-compatibility is the hard requirement: every existing `index.json`
 * entry (the 245 incumbents) lacks the new facets, and federation resolution +
 * the catalog must keep working unchanged for those. So:
 *
 *   - every facet is `.optional()` on the wire schema (a legacy entry parses);
 *   - `migrateIndexEntry()` stamps SAFE DEFAULTS for a read path that wants the
 *     facets present (securityStatus null/absent → `unverified`, trustTier
 *     absent → `draft`) WITHOUT mutating what's stored until a retro-scan
 *     (Story 4.1) or ratify (Story 3.5) writes real values back.
 *
 * Facet ownership (system-owned vs human-owned), per the vision doc's labeling
 * model: only `trustTier` is human-set (via ratify); the rest are written by the
 * gate/scanner/usage telemetry. The scout installs ONLY `trustTier: 'trusted'`
 * (enforced in Story 4.2) — this schema just carries the label.
 */

import { z } from 'zod';

/**
 * Provenance class = the access-control boundary for agents (vision §6).
 *   constitutional — platform-owned, read-only to agents
 *   vendored       — pulled from an upstream source, origin-hashed
 *   app-evolved    — authored by the reflector loop inside an app; the ONLY
 *                    class an agent may write
 *   third-party    — everything else admitted through the gate
 */
export const ProvenanceClassSchema = z.enum([
  'constitutional',
  'vendored',
  'app-evolved',
  'third-party',
]);
export type ProvenanceClass = z.infer<typeof ProvenanceClassSchema>;

/**
 * Security status = the Gate-1 scanner verdict (Story 2.2).
 *   unverified  — never scanned (legacy migration default)
 *   clean       — scanned, no blocking pattern hit
 *   flagged     — advisory concern (e.g. Gate-2 LLM note), not auto-blocked
 *   quarantined — a blocking pattern hit; not ratifiable without override
 */
export const SecurityStatusSchema = z.enum(['unverified', 'clean', 'flagged', 'quarantined']);
export type SecurityStatus = z.infer<typeof SecurityStatusSchema>;

/**
 * Quality grade — letter (A–F), numeric, or `ungraded`. Grading is deferred to a
 * later phase; Phase-1 proposals emit `ungraded`. Kept permissive on purpose.
 */
export const QualityGradeSchema = z.union([
  z.enum(['A', 'B', 'C', 'D', 'E', 'F', 'ungraded']),
  z.number(),
]);
export type QualityGrade = z.infer<typeof QualityGradeSchema>;

/**
 * Trust tier = the human-owned lifecycle label (vision §6). The ONLY facet a
 * human sets directly (via ratify). The scout installs only `trusted`;
 * `reviewed` is a browsable shelf.
 */
export const TrustTierSchema = z.enum(['draft', 'reviewed', 'trusted', 'deprecated']);
export type TrustTier = z.infer<typeof TrustTierSchema>;

/** Lineage pointers — how this skill relates to others across forks/graduations. */
export const SkillLineageSchema = z.object({
  /** App-evolved fork: the registry skill it was adapted from (null if original). */
  adaptedFrom: z.string().nullable().default(null),
  /** Promoted to global: the app/plan it graduated from (null if not graduated). */
  graduatedFrom: z.string().nullable().default(null),
  /** Deprecation pointer: the skill that replaced this one (null if current). */
  supersededBy: z.string().nullable().default(null),
});
export type SkillLineage = z.infer<typeof SkillLineageSchema>;

/**
 * The full extended index entry. The first seven fields are the pre-institution
 * shape (kept exactly); the rest are the new optional facets.
 */
export const SkillIndexEntrySchema = z.object({
  // --- existing shape (pre-institution) ---
  name: z.string().min(1),
  kind: z.string().default('core'),
  framework: z.boolean().default(false),
  version: z.string().default('sha:HEAD'),
  license: z.string().default('UNKNOWN'),
  description: z.string().default(''),
  /** Free-text origin URL/string (distinct from the structured `provenanceClass`). */
  provenance: z.string().optional(),
  // --- NEW curation facets (all optional → a legacy entry parses unchanged) ---
  provenanceClass: ProvenanceClassSchema.optional(),
  securityStatus: SecurityStatusSchema.optional(),
  qualityGrade: QualityGradeSchema.optional(),
  trustTier: TrustTierSchema.optional(),
  /** Usage-derived maturity score (populated by telemetry in a later phase). */
  maturity: z.number().optional(),
  lineage: SkillLineageSchema.optional(),
});
export type SkillIndexEntry = z.infer<typeof SkillIndexEntrySchema>;

/** The whole `index.json` document. */
export const SkillIndexSchema = z.object({
  skills: z.array(SkillIndexEntrySchema),
  'index-version': z.number().optional(),
  'generated-by': z.string().optional(),
});
export type SkillIndex = z.infer<typeof SkillIndexSchema>;

/**
 * Safe migration defaults for a read path that wants every facet present. A
 * legacy entry (no facets) becomes the most conservative interpretation:
 * unscanned + untrusted + third-party + ungraded. This NEVER upgrades trust —
 * only a retro-scan (4.1) or ratify (3.5) writes real values back to storage.
 */
export const FACET_MIGRATION_DEFAULTS = Object.freeze({
  provenanceClass: 'third-party' as ProvenanceClass,
  securityStatus: 'unverified' as SecurityStatus,
  qualityGrade: 'ungraded' as QualityGrade,
  trustTier: 'draft' as TrustTier,
  maturity: 0,
  lineage: Object.freeze({
    adaptedFrom: null,
    graduatedFrom: null,
    supersededBy: null,
  }) as SkillLineage,
});

/** An entry with every facet guaranteed present (post-migration read shape). */
export type MigratedSkillIndexEntry = SkillIndexEntry &
  Required<
    Pick<
      SkillIndexEntry,
      'provenanceClass' | 'securityStatus' | 'qualityGrade' | 'trustTier' | 'maturity' | 'lineage'
    >
  >;

/**
 * Fill missing facets with safe defaults for callers that need them present
 * (filters, badges, the scout's trust gate). Does NOT downgrade a facet that's
 * already set — `framework: true` skills, for example, may already carry a
 * `constitutional` provenanceClass. Pure: returns a new object.
 *
 * Note an operator-authored skill that predates the facets but already has a
 * real provenance string still defaults `provenanceClass` to `third-party`; the
 * retro-scan reclassifies. The one inference we make for safety: a framework
 * skill is `constitutional` and `trusted` by definition (bmad ships them), so we
 * don't quarantine the platform's own skills.
 */
export function migrateIndexEntry(entry: SkillIndexEntry): MigratedSkillIndexEntry {
  const frameworkDefaults = entry.framework
    ? { provenanceClass: 'constitutional' as ProvenanceClass, trustTier: 'trusted' as TrustTier }
    : {};
  return {
    ...entry,
    provenanceClass:
      entry.provenanceClass ??
      frameworkDefaults.provenanceClass ??
      FACET_MIGRATION_DEFAULTS.provenanceClass,
    securityStatus: entry.securityStatus ?? FACET_MIGRATION_DEFAULTS.securityStatus,
    qualityGrade: entry.qualityGrade ?? FACET_MIGRATION_DEFAULTS.qualityGrade,
    trustTier: entry.trustTier ?? frameworkDefaults.trustTier ?? FACET_MIGRATION_DEFAULTS.trustTier,
    maturity: entry.maturity ?? FACET_MIGRATION_DEFAULTS.maturity,
    lineage: entry.lineage
      ? {
          adaptedFrom: entry.lineage.adaptedFrom ?? null,
          graduatedFrom: entry.lineage.graduatedFrom ?? null,
          supersededBy: entry.lineage.supersededBy ?? null,
        }
      : { ...FACET_MIGRATION_DEFAULTS.lineage },
  };
}

/**
 * Document-level migration: return a copy of the index with every entry's facets
 * filled to safe defaults. Additive only — base fields are untouched and unknown
 * top-level keys (`index-version`, `generated-by`) are preserved — so federation
 * resolution (which reads name/version and ignores the rest) is unaffected.
 *
 * This is the pure core the retro-scan script (Story 4.1) wraps to write facets
 * back to the canonical `index.json`; it's also safe to apply on any read that
 * needs guaranteed-present facets.
 */
export function migrateSkillIndex(index: SkillIndex): SkillIndex {
  return { ...index, skills: index.skills.map(migrateIndexEntry) };
}

/**
 * Parse one raw entry (from `index.json`) into a validated `SkillIndexEntry`.
 * Tolerant by design: a legacy entry with only the original seven fields passes;
 * unknown extra keys are stripped. Returns `null` on a fundamentally invalid
 * entry (no string name) so the catalog can skip it instead of failing whole —
 * matching the existing `fetchSkillCatalog` "never throw on one bad source"
 * contract.
 */
export function parseIndexEntry(raw: unknown): SkillIndexEntry | null {
  const result = SkillIndexEntrySchema.safeParse(raw);
  return result.success ? result.data : null;
}
