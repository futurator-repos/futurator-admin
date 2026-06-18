/**
 * labeling.ts — Skills Institution, Story 2.3. The gate's label step.
 *
 * Assigns the system-owned facets to a candidate skill. Only `trustTier` is the
 * human-owned facet, and the gate ALWAYS sets it to `draft` — a proposal becomes
 * `trusted` only when an operator ratifies it (Story 3.5). The scanner's verdict
 * is copied verbatim into `securityStatus`; `provenanceClass` is inferred from
 * the entry source (the access-control boundary, vision §6); quality grading is
 * deferred so everything emits `ungraded`.
 *
 * Pure: same inputs → same labels.
 */

import type { ProposalSource } from '../schemas/skill-proposal-schema';
import type {
  ProvenanceClass,
  SecurityStatus,
  QualityGrade,
  TrustTier,
  SkillLineage,
} from '../schemas/skill-index-entry-schema';

/**
 * Default provenance class per entry source — the access-control boundary:
 *   reflect-graduate → app-evolved (born inside an app's reflector loop)
 *   create           → third-party (operator hand-authored, not platform-owned)
 *   paste-url / bulk  → vendored   (pulled from upstream, should be origin-hashed)
 * A caller may override (e.g. an operator marking a hand-authored platform skill).
 */
const PROVENANCE_BY_SOURCE: Record<ProposalSource, ProvenanceClass> = {
  'reflect-graduate': 'app-evolved',
  create: 'third-party',
  'paste-url': 'vendored',
  bulk: 'vendored',
};

export interface LabelInput {
  source: ProposalSource;
  securityStatus: Extract<SecurityStatus, 'clean' | 'flagged' | 'quarantined'>;
  /** Explicit override for the inferred provenance class. */
  provenanceClass?: ProvenanceClass;
  /** Partial lineage from the adapter (e.g. graduatedFrom for reflect). */
  lineage?: Partial<SkillLineage>;
}

export interface SkillLabels {
  provenanceClass: ProvenanceClass;
  securityStatus: SecurityStatus;
  qualityGrade: QualityGrade;
  trustTier: TrustTier;
  maturity: number;
  lineage: SkillLineage;
}

export function labelProposal(input: LabelInput): SkillLabels {
  return {
    provenanceClass: input.provenanceClass ?? PROVENANCE_BY_SOURCE[input.source],
    securityStatus: input.securityStatus,
    qualityGrade: 'ungraded',
    // The hard invariant: the gate NEVER mints trust. Ratify does.
    trustTier: 'draft',
    maturity: 0,
    lineage: {
      adaptedFrom: input.lineage?.adaptedFrom ?? null,
      graduatedFrom: input.lineage?.graduatedFrom ?? null,
      supersededBy: input.lineage?.supersededBy ?? null,
    },
  };
}
