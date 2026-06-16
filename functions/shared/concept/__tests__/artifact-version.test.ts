import { describe, it, expect } from 'vitest';
import {
  recordApproval,
  applyEdit,
  staleCascade,
  railIsConsistent,
  staleArtifacts,
  type ConceptArtifact,
} from '../artifact-version';

/**
 * Concept v2 — Story E4.4 (W1): editing an upstream artifact flips every
 * transitive dependent approved→stale. The chain: prd ← ux ← architecture.
 */
function chain(): ConceptArtifact[] {
  return [
    { kind: 'prd', rev: 1, contentHash: 'sha256:prd-1', status: 'draft', dependsOn: [] },
    { kind: 'ux', rev: 1, contentHash: 'sha256:ux-1', status: 'draft', dependsOn: ['prd'] },
    {
      kind: 'architecture',
      rev: 1,
      contentHash: 'sha256:arch-1',
      status: 'draft',
      dependsOn: ['prd', 'ux'],
    },
  ];
}

function approveAll(arts: ConceptArtifact[]): ConceptArtifact[] {
  // Approve in dependency order so each records its deps' current hashes.
  let a = recordApproval(arts, 'prd');
  a = recordApproval(a, 'ux');
  a = recordApproval(a, 'architecture');
  return a;
}

describe('artifact-version — approved→stale cascade (Concept v2 — E4.4/W1)', () => {
  it('AC1 — recordApproval snapshots the dep hashes it was approved against', () => {
    const a = approveAll(chain());
    const arch = a.find((x) => x.kind === 'architecture')!;
    expect(arch.status).toBe('approved');
    expect(arch.dependsOnHashes).toEqual({ prd: 'sha256:prd-1', ux: 'sha256:ux-1' });
  });

  it('AC2 — editing the PRD flips BOTH ux and architecture stale (transitive)', () => {
    const approved = approveAll(chain());
    expect(railIsConsistent(approved)).toBe(true);

    const edited = applyEdit(approved, 'prd', 'sha256:prd-2');
    const m = Object.fromEntries(edited.map((x) => [x.kind, x]));
    expect(m.prd.status).toBe('draft'); // the edited one resets to draft
    expect(m.prd.rev).toBe(2);
    expect(m.ux.status).toBe('stale'); // direct consumer — hash drift
    expect(m.architecture.status).toBe('stale'); // transitive via ux
    expect(railIsConsistent(edited)).toBe(false);
    expect(staleArtifacts(edited).sort()).toEqual(['architecture', 'ux']);
  });

  it('editing UX flips only architecture (PRD is upstream, unaffected)', () => {
    const approved = approveAll(chain());
    const edited = applyEdit(approved, 'ux', 'sha256:ux-2');
    const m = Object.fromEntries(edited.map((x) => [x.kind, x]));
    expect(m.prd.status).toBe('approved');
    expect(m.ux.status).toBe('draft');
    expect(m.architecture.status).toBe('stale');
  });

  it('re-approving the chain after an edit restores consistency', () => {
    let a = approveAll(chain());
    a = applyEdit(a, 'prd', 'sha256:prd-2');
    // Re-approve in dependency order.
    a = recordApproval(a, 'prd');
    a = recordApproval(a, 'ux');
    a = recordApproval(a, 'architecture');
    expect(railIsConsistent(a)).toBe(true);
    const arch = a.find((x) => x.kind === 'architecture')!;
    expect(arch.dependsOnHashes!.prd).toBe('sha256:prd-2'); // re-bound to the new hash
  });

  it('staleCascade is idempotent on an already-consistent rail', () => {
    const approved = approveAll(chain());
    expect(staleCascade(approved)).toEqual(approved);
  });
});
