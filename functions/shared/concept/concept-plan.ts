import type { PlanRigor } from '../types/plan';

/**
 * Concept v2 (E7.1 / §3.2) — the `conceptPlan` DAG emitted by the Concept Router
 * (Analyst/Mary persona, an LLM classifier run right after intent). It decides
 * *which* upstream artifacts apply (applicability axis) and in what order, before
 * any artifact-gen spends tokens. Persisted on the Plan row; rendered as the
 * Concept rail (E12). `rigor` still owns depth; this owns applicability.
 *
 * See `docs/concepts/pipeline-v3/concept-stage-v2-bmad.md` §3.2.
 */

export type ConceptArtifactKind = 'prd' | 'ux' | 'architecture';
export type ConceptArtifactDepth = 'lite' | 'light' | 'full';
export type ConceptGate = 'noop' | 'light' | 'strict';
export type ConceptComplexity = 'low' | 'medium' | 'high';

export interface ConceptPlanArtifact {
  kind: ConceptArtifactKind;
  depth: ConceptArtifactDepth;
  /** Upstream artifacts this one consumes (e.g. architecture dependsOn ['prd','ux']). */
  dependsOn?: ConceptArtifactKind[];
}

export interface ConceptPlan {
  /** Drives UX activation + the serial PRD→UX→Arch ordering (§7). */
  uiBearing: boolean;
  /** Hint for arch activation + story sizing; may be graph-refined for `change` plans (E7.3). */
  complexity: ConceptComplexity;
  artifacts: ConceptPlanArtifact[];
  /** Readiness-gate strictness, derived from rigor. */
  gate: ConceptGate;
  /** One-line classifier justification — logged + shown on the rail (auditable). */
  rationale: string;
}

/**
 * W8 — `prototype` BYPASSES the Concept Router entirely: no inference, no
 * Plan-row write, zero added latency (today's single PM shot, byte-identical).
 * Every v2 branch guards on the conceptPlan's PRESENCE, treating *absent*
 * (prototype) as the v1 path. This is that guard.
 */
export function shouldRunConceptRoute(plan: { rigor?: PlanRigor }): boolean {
  return plan.rigor !== 'prototype';
}

/** Gate strictness derived from rigor (the Router copies this onto the conceptPlan). */
export function gateForRigor(rigor: PlanRigor | undefined): ConceptGate {
  if (rigor === 'production') return 'strict';
  if (rigor === 'mvp') return 'light';
  return 'noop';
}

/** Whether an artifact of `kind` is present in the conceptPlan (the v2-branch guard). */
export function artifactPlanned(plan: ConceptPlan | undefined, kind: ConceptArtifactKind): boolean {
  return !!plan?.artifacts.some((a) => a.kind === kind);
}
