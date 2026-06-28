import { z } from 'zod';

/**
 * Refactoring Scan Engine v2 — the canonical `ScanFinding` shape (design §3.1).
 *
 * ONE record that BOTH the deterministic detectors (hotspot-detect / knip /
 * privacy) and the LLM analyzers emit (or are mapped into on the way in), so a
 * `knip` dead-code row and an LLM `res.ok` finding union into a single sortable
 * pool. Additive over `AuditHotspot` — `effort`, `dimension`, and `dependsOn`
 * are the net-new axes the v1 report/plan lacked.
 *
 * `effort` is split into a canonical machine-sortable band (`effort`) plus an
 * optional human `effortNote` for the compound case ("Small (delete) / Medium
 * (wire)") — keeping the Priority Matrix sortable while preserving nuance.
 */

export const SCAN_DIMENSIONS = [
  'architecture',
  'safety-security',
  'compliance',
  'code-quality-refactoring',
  'correctness',
] as const;
export type ScanDimension = (typeof SCAN_DIMENSIONS)[number];

// Ordered High→Low so the matrix sort and theme-ranking are deterministic.
export const SCAN_SEVERITIES = ['High', 'Medium', 'Low–Med', 'Low'] as const;
export type ScanSeverity = (typeof SCAN_SEVERITIES)[number];

// Ordered cheap→expensive so it can tie-break within a phase band (cheap-high-value floats up).
export const SCAN_EFFORTS = ['Trivial', 'Small', 'Medium', 'Large'] as const;
export type ScanEffort = (typeof SCAN_EFFORTS)[number];

export const scanFindingSchema = z.object({
  /** Stable, location-keyed id. */
  id: z.string().min(1),
  dimension: z.enum(SCAN_DIMENSIONS),
  /** A `§sys:<dir>` shardKey | 'cross-cutting' | 'UI' | an 'A / B' overlap label. */
  area: z.string().min(1),
  severity: z.enum(SCAN_SEVERITIES),
  /** Canonical, machine-sortable band. */
  effort: z.enum(SCAN_EFFORTS),
  /** Human nuance, e.g. "Small (delete) / Medium (wire)". */
  effortNote: z.string().optional(),
  /** REAL relative path + ':line' — post-checked against graph.resolved.json. */
  location: z.string().min(1),
  /** ≤12 words ideal for the matrix cell; longer prose allowed elsewhere. */
  issue: z.string().min(1),
  /** Names exactly ONE centralized artifact (apiFetch<T>, batchPut, withErrorHandling…). */
  suggestion: z.string().min(1),
  /** Structured pointer (methods/importers/community/copies/cohesion) — NEVER a code dump. */
  evidence: z.record(z.unknown()).default({}),
  source: z.enum(['deterministic', 'llm']),
  /** Adjudicated findings only. */
  confidence: z.number().min(0).max(1).optional(),
  /** Other finding ids this remediation must follow (foundations-first). */
  dependsOn: z.array(z.string()).default([]),
  /** Dedupe back-refs to the same root finding. */
  overlaps: z.array(z.string()).optional(),
});

export type ScanFinding = z.infer<typeof scanFindingSchema>;

/** Rank (0 = most severe) for matrix sorting. Unknown → last. */
export function severityRank(s: string): number {
  const i = (SCAN_SEVERITIES as readonly string[]).indexOf(s);
  return i < 0 ? SCAN_SEVERITIES.length : i;
}

/** Rank (0 = cheapest) for in-band tie-breaking. Unknown → last. */
export function effortRank(e: string): number {
  const i = (SCAN_EFFORTS as readonly string[]).indexOf(e);
  return i < 0 ? SCAN_EFFORTS.length : i;
}

/**
 * Canonical Priority-Matrix order: severity High→Low, then cheapest effort first
 * (a High/Trivial floats above a High/Large), then stable by area+location.
 */
export function compareFindings(a: ScanFinding, b: ScanFinding): number {
  return (
    severityRank(a.severity) - severityRank(b.severity) ||
    effortRank(a.effort) - effortRank(b.effort) ||
    a.area.localeCompare(b.area) ||
    a.location.localeCompare(b.location)
  );
}
