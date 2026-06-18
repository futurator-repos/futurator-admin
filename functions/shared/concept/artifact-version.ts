import type { ArtifactKind } from './section-manifest';
import type { ConceptPlanArtifact } from './concept-plan';

/**
 * Concept v2 (E4.4 / W1) — artifact versioning + the approved→stale cascade.
 *
 * The danger W1 closes: a PRD is approved, UX/Architecture/stories cite it, then
 * the PRD is edited — the rail stays green and the "consistency contract"
 * silently becomes a *stale inconsistency* contract (worse than none). The fix:
 * every artifact carries `{rev, contentHash}`; consumers record the dep hashes
 * they were approved against (`dependsOnHashes`); editing an upstream artifact
 * flips every transitive dependent `approved → stale` (topological re-approval).
 *
 * This module is the pure state machine. The two-phase on-disk commit
 * (tmp → fsync → atomic-rename → flip the Plan row) is the I/O wiring that lands
 * with the artifact-gen jobs in Epic E7.6 (daemon-side); it MUST run the cascade
 * here whenever it bumps a `contentHash`. See concept-stage-v2-bmad.md §7.1/§13 W1.
 */

export type ArtifactStatus = 'draft' | 'approved' | 'stale';

export interface ConceptArtifact {
  kind: ArtifactKind;
  rev: number;
  contentHash: string;
  status: ArtifactStatus;
  /** Which artifacts this one consumes (e.g. architecture dependsOn ['prd','ux']). */
  dependsOn: ArtifactKind[];
  /** The dep contentHashes captured at approval time — the binding W1 enforces. */
  dependsOnHashes?: Partial<Record<ArtifactKind, string>>;
}

function byKind(artifacts: ConceptArtifact[], kind: ArtifactKind): ConceptArtifact | undefined {
  return artifacts.find((a) => a.kind === kind);
}

/**
 * Concept v2 (E1.1 / W1) — seed the Plan-row version registry from the Concept
 * Router's applicability DAG. One `ConceptArtifact` row per planned artifact, at
 * the genesis state: `rev:0`, empty `contentHash` (no document on disk yet),
 * `status:'draft'`, `dependsOn` copied verbatim from the `ConceptPlanArtifact`.
 *
 * Called once at `apply-concept-plan` time. The rows then drive the Concept
 * Reducer (E3), the rail (E4), and the stale cascade (W1); generators bump each
 * row to `rev≥1` with a real `contentHash` via the apply-service (E1.3). For a
 * prototype/legacy plan there is no `conceptPlan`, so this is never called and
 * `conceptArtifacts` stays absent (W8 byte-identical).
 */
export function seedConceptArtifacts(planned: ConceptPlanArtifact[]): ConceptArtifact[] {
  return planned.map((a) => ({
    kind: a.kind,
    rev: 0,
    contentHash: '',
    status: 'draft' as ArtifactStatus,
    dependsOn: a.dependsOn ? [...a.dependsOn] : [],
  }));
}

/**
 * Approve an artifact: mark it `approved` and snapshot the current contentHash of
 * each dependency, so a later edit to any of them can be detected as drift.
 */
export function recordApproval(
  artifacts: ConceptArtifact[],
  kind: ArtifactKind,
): ConceptArtifact[] {
  return artifacts.map((a) => {
    if (a.kind !== kind) return a;
    const dependsOnHashes: Partial<Record<ArtifactKind, string>> = {};
    for (const dep of a.dependsOn) {
      const d = byKind(artifacts, dep);
      if (d) dependsOnHashes[dep] = d.contentHash;
    }
    return { ...a, status: 'approved', dependsOnHashes };
  });
}

/**
 * Apply an edit to one artifact: bump its `rev`, set the new `contentHash`, reset
 * it to `draft`, then run the stale cascade so every transitive dependent that
 * was approved against the old content flips to `stale`.
 */
export function applyEdit(
  artifacts: ConceptArtifact[],
  kind: ArtifactKind,
  newContentHash: string,
): ConceptArtifact[] {
  const edited = artifacts.map((a) =>
    a.kind === kind
      ? { ...a, rev: a.rev + 1, contentHash: newContentHash, status: 'draft' as ArtifactStatus }
      : a,
  );
  return staleCascade(edited);
}

/**
 * Flip any `approved` artifact to `stale` when a dependency's content changed
 * since approval (hash mismatch) OR a dependency is itself `stale` (transitive).
 * Iterates to a fixpoint so the cascade is topological without sorting.
 */
export function staleCascade(artifacts: ConceptArtifact[]): ConceptArtifact[] {
  let cur = artifacts.map((a) => ({ ...a }));
  // At most N passes for an N-node DAG to reach a fixpoint.
  for (let pass = 0; pass <= cur.length; pass += 1) {
    let changed = false;
    cur = cur.map((a) => {
      if (a.status !== 'approved' || a.dependsOn.length === 0) return a;
      for (const dep of a.dependsOn) {
        const d = byKind(cur, dep);
        if (!d) continue;
        const recorded = a.dependsOnHashes?.[dep];
        const driftedHash = recorded !== undefined && recorded !== d.contentHash;
        if (driftedHash || d.status === 'stale') {
          changed = true;
          return { ...a, status: 'stale' as ArtifactStatus };
        }
      }
      return a;
    });
    if (!changed) break;
  }
  return cur;
}

/**
 * Concept v2 (E3.3) — mark an artifact for regeneration: flip it to `stale`
 * (keeping its rev/contentHash as history) and cascade so every transitive
 * dependent goes `stale` too. The reducer then re-activates the chain in
 * dependency order. When the fresh content lands via `applyEdit`, the rev bumps
 * and the cascade re-settles. `stale` is the "needs regeneration" state — the
 * reducer never treats it as a human-approval gate (Story 3.3).
 */
export function markForRegen(artifacts: ConceptArtifact[], kind: ArtifactKind): ConceptArtifact[] {
  const marked = artifacts.map((a) =>
    a.kind === kind ? { ...a, status: 'stale' as ArtifactStatus } : a,
  );
  return staleCascade(marked);
}

/** True iff the whole rail is consistent — nothing stale, everything that should be approved is. */
export function railIsConsistent(artifacts: ConceptArtifact[]): boolean {
  return artifacts.every((a) => a.status !== 'stale');
}

/** The artifacts that must be re-approved (topological order is the caller's via dependsOn). */
export function staleArtifacts(artifacts: ConceptArtifact[]): ArtifactKind[] {
  return artifacts.filter((a) => a.status === 'stale').map((a) => a.kind);
}
