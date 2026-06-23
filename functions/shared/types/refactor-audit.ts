/**
 * Refactoring Assessment Module — recon artifact contract (Epic B/D).
 *
 * The shape of `graphify-out/hotspots.json` emitted by the deterministic recon
 * chain (`daemon/scripts/refactor-recon/hotspot-detect.mjs`). The daemon reads
 * it on `assess.completed`; the UI renders it on the hotspot dashboard (FR32).
 *
 * KEEP IN SYNC with `src/types/refactor-audit.ts` (the frontend mirror, FR34)
 * and with `hotspot-detect.mjs`'s emit shape (validated against a real
 * applicator run: counts {god-object, duplicate-subsystem,
 * design-system-consolidation, dead-code}).
 */

/** The five hotspot kinds the detector emits (`hotspot-detect.mjs:13-14`). */
export type HotspotKind =
  | 'god-object'
  | 'duplicate-subsystem'
  | 'design-system-consolidation'
  | 'low-cohesion-split'
  | 'dead-code';

/**
 * Severity buckets, keyed off `score` (`hotspot-detect.mjs:57`):
 * `≥80 critical · ≥55 high · ≥30 medium · else low`.
 */
export type HotspotSeverity = 'critical' | 'high' | 'medium' | 'low';

/**
 * Per-kind evidence — a small, structured pointer (never a code dump, FR33).
 * The detector writes a different subset per kind; all fields are optional so
 * the one object type covers every kind. Examples by kind:
 *   - god-object:                  { methods, importers, community }
 *   - duplicate-subsystem:         { copies[] } | { count }
 *   - design-system-consolidation: { canonical, byDir, duplicatedComponents[] }
 *   - low-cohesion-split:          { size, cohesion, community }
 *   - dead-code:                   { knipFlagged, confirmedZeroFanIn }
 */
export interface HotspotEvidence {
  methods?: number;
  importers?: number;
  community?: number | string;
  copies?: Array<{ f: string; imp: number }>;
  count?: number;
  canonical?: string;
  byDir?: Record<string, number>;
  duplicatedComponents?: Array<{ name: string; copies: number; importers: number }>;
  size?: number;
  cohesion?: number;
  knipFlagged?: number;
  confirmedZeroFanIn?: number;
}

/** One ranked hotspot row (`hotspot-detect.mjs:65-70` et al.). */
export interface AuditHotspot {
  kind: HotspotKind;
  /** 0–100 fused score; drives `severity` and the sort order. */
  score: number;
  severity: HotspotSeverity;
  /** Human one-liner, e.g. "God-object: AWSProfileStorage (44 methods, 38 importers)". */
  title: string;
  /** Real relative paths (or UI-dir roots) implicated — never absolute. */
  files: string[];
  evidence: HotspotEvidence;
  /** The extract→repoint→delete sketch the L4 judge / Create-plan expands. */
  suggestedAction: string;
}

/**
 * The full `hotspots.json` document. `counts` is the per-kind tally over the
 * (pre-`--top`) hotspot set; `hotspots` is the ranked, capped list.
 * `generatedAt` is written as `null` by the detector (deterministic — no
 * wall-clock in the artifact); the daemon stamps time on the job row instead.
 */
export interface HotspotsReport {
  generatedAt: string | null;
  repo: string;
  graphifyOutDir: string;
  counts: Partial<Record<HotspotKind, number>>;
  hotspots: AuditHotspot[];
}
