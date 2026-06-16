import type { Plan, ConceptInteraction } from '../types/plan';
import type { ConceptArtifactKind } from '../concept/concept-plan';
import type { ConceptArtifact } from '../concept/artifact-version';
import { resolveConceptInteraction } from './resolve-concept-interaction';

/**
 * Concept v2 (E3 / Story 3.1) — the Concept Reducer.
 *
 * A PURE function over `(conceptPlan, conceptArtifacts[], conceptInteraction)`
 * that returns the SINGLE next action to advance the spec-development DAG:
 * generate the next applicable artifact, wait for a human Approve (interactive),
 * enqueue the PM plan once every artifact is approved, or no-op (prototype/
 * legacy — the v1 path is untouched, W8).
 *
 * Determinism + purity are the point: no I/O, table-testable, and exactly one
 * action per call (serial DAG, D5). The thin lock-guarded driver (Story 3.2)
 * turns the action into an enqueue under the per-plan reduce lock; the driver —
 * not the reducer — dedups against in-flight generator FKs.
 *
 * Dependency order: the Router emits `conceptPlan.artifacts` topologically
 * (prd → ux → arch), so the first non-approved artifact in that order whose deps
 * are all approved is the one to act on.
 */

export type ConceptReduceAction =
  | { type: 'noop'; reason: string }
  | { type: 'enqueue-artifact'; kind: ConceptArtifactKind; interaction: ConceptInteraction }
  | { type: 'awaiting-approval'; kind: ConceptArtifactKind }
  | { type: 'enqueue-pm-plan' };

type ReducerPlan = Pick<Plan, 'conceptPlan' | 'conceptArtifacts' | 'conceptInteraction' | 'rigor'>;

function byKind(
  artifacts: ConceptArtifact[],
  kind: ConceptArtifactKind,
): ConceptArtifact | undefined {
  return artifacts.find((a) => a.kind === kind);
}

export function reduceConcept(plan: ReducerPlan): ConceptReduceAction {
  // W8 — prototype / legacy: no conceptPlan ⇒ the v1 single-PM-shot path owns
  // advancement. The reducer must never synthesize a chain here.
  if (!plan.conceptPlan) return { type: 'noop', reason: 'no conceptPlan (prototype/legacy)' };

  const planned = plan.conceptPlan.artifacts ?? [];
  if (planned.length === 0) return { type: 'noop', reason: 'conceptPlan has no artifacts' };

  const artifacts = plan.conceptArtifacts ?? [];
  const interaction = resolveConceptInteraction(plan);

  for (const p of planned) {
    const row = byKind(artifacts, p.kind);
    // Registry not seeded for a planned artifact (shouldn't happen post-apply,
    // but defensively): it needs generating.
    if (!row) return { type: 'enqueue-artifact', kind: p.kind, interaction };

    if (row.status === 'approved') continue; // done — advance to the next planned artifact

    // First non-approved artifact in dependency order. Confirm its upstreams are
    // approved (they appear earlier in the topological list, so normally yes).
    const deps = p.dependsOn ?? row.dependsOn ?? [];
    const depsApproved = deps.every((d) => byKind(artifacts, d)?.status === 'approved');
    if (!depsApproved) {
      return { type: 'noop', reason: `waiting on upstream deps of ${p.kind}` };
    }

    // Interactive convergence that has already produced a draft (rev>0) is
    // BLOCKED on the operator's Approve — never auto-advance past a human gate.
    // (status is already narrowed to draft|stale by the `continue` above.)
    if (interaction === 'interactive' && row.rev > 0) {
      return { type: 'awaiting-approval', kind: p.kind };
    }

    // Otherwise generate it: autopilot one-shot, or an interactive session not
    // yet drafted (rev 0). A `stale` row (upstream edited) re-activates the same
    // way — status !== 'approved' ⇒ re-generate.
    return { type: 'enqueue-artifact', kind: p.kind, interaction };
  }

  // Every planned artifact is approved → the consistency contract is ready; the
  // PM plan can be enqueued to cite the real sections.
  return { type: 'enqueue-pm-plan' };
}
