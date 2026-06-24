/**
 * Refactoring Assessment Module — frontend type mirror (Epic D, FR34).
 *
 * KEEP IN SYNC with `functions/shared/types/refactor-audit.ts`. These are the
 * operator-facing shapes the hotspot dashboard (FR32) renders from the
 * `hotspots.json` recon artifact. Severity pairs a color chip with a text label
 * (NFR16) — never color alone.
 */

/** The five hotspot kinds the detector emits. */
export type HotspotKind =
  | 'god-object'
  | 'duplicate-subsystem'
  | 'design-system-consolidation'
  | 'low-cohesion-split'
  | 'dead-code';

/** Severity buckets: `≥80 critical · ≥55 high · ≥30 medium · else low`. */
export type HotspotSeverity = 'critical' | 'high' | 'medium' | 'low';

/** Per-kind structured evidence pointer (never a code dump). */
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

/** One ranked hotspot row. */
export interface AuditHotspot {
  kind: HotspotKind;
  score: number;
  severity: HotspotSeverity;
  title: string;
  files: string[];
  evidence: HotspotEvidence;
  suggestedAction: string;
}

/** The full `hotspots.json` document. */
export interface HotspotsReport {
  generatedAt: string | null;
  repo: string;
  graphifyOutDir: string;
  counts: Partial<Record<HotspotKind, number>>;
  hotspots: AuditHotspot[];
}

/** One L3 adjudication verdict (mirror of the backend type). */
export interface HotspotVerdict {
  hotspotTitle: string;
  kind: HotspotKind;
  verdict: 'confirmed' | 'rejected';
  rationale: string;
  confidence?: number;
}

// ── Data Privacy Assessment lane (mirror of backend) ──

export interface PrivacyHotspot {
  category: string;
  regulation: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  score: number;
  confidence?: number;
  title: string;
  file: string;
  snippet?: string;
  remediation?: string;
  solution_ceiling?: string;
  citation?: string[];
  card?: string;
}

export interface PrivacyCategory {
  category: string;
  regulation: string;
  severity: 'critical' | 'high' | 'medium' | 'low' | 'info';
  score: number;
  fileCount: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  remediation?: string;
  solutionCeiling?: string;
  citation?: string[];
  card?: string;
  sampleFiles: Array<{ file: string; score: number }>;
}

export interface PrivacyRegulationSlice {
  scannedFiles: number;
  summary: Partial<Record<'critical' | 'high' | 'medium' | 'low' | 'info' | 'total', number>>;
  detectedCount: number;
  categoryCount: number;
  categories: PrivacyCategory[];
}

export interface PrivacyAuditSummary {
  failed?: boolean;
  reason?: string;
  error?: string;
  tier?: string;
  rulepackVersion?: string | null;
  cardsLoaded?: number;
  regulations?: string[];
  totalDetected?: number;
  durationMs?: number | null;
  fullReportAvailable?: boolean;
  byRegulation?: Record<string, PrivacyRegulationSlice>;
}

/**
 * A durable audit record (`futurator-refactor-audits`) — what the CRUD/history
 * endpoints return. Mirror of `functions/shared/types/refactor-audit.ts`.
 */
export interface RefactorAuditRecord {
  auditId: string;
  projectId: string;
  projectPath: string;
  jobId: string;
  status: 'recon-only' | 'adjudicated';
  counts: Partial<Record<HotspotKind, number>>;
  hotspots: AuditHotspot[];
  verdicts?: HotspotVerdict[];
  plan?: unknown;
  /** Whether the file-level graph projection was uploaded to S3. */
  graphAvailable?: boolean;
  detectedCount?: number;
  shownCount?: number;
  toolStatus?: Record<string, string>;
  privacy?: PrivacyAuditSummary;
  createdAt: string;
  createdBy: string;
}

/**
 * The hotspot workstreams the dashboard groups by (FR32). The detector kinds
 * fold into four operator-facing workstreams.
 */
export type HotspotWorkstream = 'design-system' | 'god-objects' | 'legacy' | 'dead-code';

/** Map a detector kind → its dashboard workstream. */
export const WORKSTREAM_OF: Record<HotspotKind, HotspotWorkstream> = {
  'design-system-consolidation': 'design-system',
  'god-object': 'god-objects',
  'duplicate-subsystem': 'legacy',
  'low-cohesion-split': 'legacy',
  'dead-code': 'dead-code',
};
