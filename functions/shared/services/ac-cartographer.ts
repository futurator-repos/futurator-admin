// ac-cartographer — W1.3 (implementation-plan). Deterministic, pure normalization
// of free-form acceptance criteria into a testable shape: an EARS-normative
// restatement, a structured Given-When-Then echo, and a BMAD P0–P3 risk tier.
//
// SAFETY (the safety review's key mitigation): this ONLY writes SHADOW fields
// (`normalizedText`/`normalizedGwt`/`riskTag`) and NEVER overwrites the operator-
// authored `text`/`given`/`when`/`then`. The caller runs it only when
// AC_CARTOGRAPHER=on, so with the flag off no AC content changes and the
// existing solutioning-gate BDD check (on the original fields) is untouched.
//
// This is a deterministic v1 (heuristic EARS + rule-based risk tier). An
// LLM-backed normalizer can later refine the same shadow fields without changing
// the contract.

import type { AcceptanceCriterion } from '../types/epic-workflow';

export type RiskTag = 'P0' | 'P1' | 'P2' | 'P3';

const NORMATIVE_RE = /\b(shall|must)\b/i;

/** Read `acClass` if the AC carries one (present on bound ACs, absent on plain ones). */
function acClassOf(ac: AcceptanceCriterion): string | undefined {
  return (ac as { acClass?: string }).acClass;
}

/**
 * Deterministic risk tier: security-critical → P0; user-facing behavior → P1;
 * has a structured (BDD) scenario → P2; otherwise P3.
 */
export function deriveRiskTag(ac: AcceptanceCriterion): RiskTag {
  if (acClassOf(ac) === 'advisory-security') return 'P0';
  if (ac.verify === 'behavior' || ac.verify === 'appearance' || ac.needsBrowser) return 'P1';
  if (ac.given || ac.when || ac.then) return 'P2';
  return 'P3';
}

/** EARS-normative restatement of the AC's prose (idempotent when already normative). */
export function normalizeText(ac: AcceptanceCriterion): string {
  const text = (ac.text || '').trim();
  if (NORMATIVE_RE.test(text)) return text; // already SHALL/MUST — keep as-is
  const when = (ac.when || '').trim();
  const then = (ac.then || ac.thenObservable || '').trim();
  if (when && then) return `When ${when}, the system shall ${then}.`;
  if (then) return `The system shall ${then}.`;
  return text ? `The system shall ${text}.` : text;
}

/** Normalize one AC → same AC + shadow fields. Manual ACs get a risk tag only. */
export function normalizeCriterion(ac: AcceptanceCriterion): AcceptanceCriterion {
  if (ac.verify === 'manual') return { ...ac, riskTag: deriveRiskTag(ac) };
  return {
    ...ac,
    normalizedText: normalizeText(ac),
    normalizedGwt: {
      given: (ac.given || '').trim(),
      when: (ac.when || '').trim(),
      then: (ac.then || ac.thenObservable || '').trim(),
    },
    riskTag: deriveRiskTag(ac),
  };
}

/** Pure: normalize a list of ACs (immutable — returns a new array). */
export function normalizeCriteria(criteria: AcceptanceCriterion[] = []): AcceptanceCriterion[] {
  return criteria.map(normalizeCriterion);
}
