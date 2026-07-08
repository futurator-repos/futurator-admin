/**
 * iac-phase-planner.test.mjs — locks the stack-aware IaC migration track. In
 * particular the `seq` display-ordinal contract: the canonical `phase` anchors skip
 * (a satisfied dimension is omitted) and repeat (envSep + modularity both = playbook
 * phase 3), so rendering `phase` raw produced "Phase 1, 3, 3, 4, 5, 6". `seq` must be
 * a clean 1..N sequence regardless.
 */

import { describe, it, expect } from 'vitest';
import { planIacTrack } from '../lib/iac-phase-planner.mjs';

// A Mycelium-shaped grade: state already at L2 (satisfied → skipped), the rest below
// target, and the data plane mostly undeclared (adoption step fires).
const myceliumLike = () => ({
  iacMaturity: {
    level: 1,
    dimensions: {
      state: { level: 2, gaps: [] }, // satisfied at target L2 → step omitted (the gap)
      envSeparation: { level: 1, gaps: ['separate stages'] }, // playbook phase 3
      modularity: { level: 1, gaps: ['extract modules'] }, //     playbook phase 3 (dup)
      testing: { level: 0, gaps: ['add tests'] },
      governance: { level: 0, gaps: ['add policy'] },
      driftCost: { level: 0, gaps: ['add drift check'] },
    },
  },
  iacCoverage: { resourceRatio: 0.06, undeclared: ['DynamoDB', 'S3'] },
  services: [{ name: 'SST', kind: 'iac', detectedBy: ['iac-declared'] }],
});

describe('planIacTrack — seq display ordinal', () => {
  it('emits a clean 1..N seq even when canonical phases skip and repeat', () => {
    const plan = planIacTrack(myceliumLike());
    expect(plan).toBeTruthy();
    const seqs = plan.track.map((s) => s.seq);
    expect(seqs).toEqual(seqs.map((_, i) => i + 1)); // strictly 1..N, no gaps/dupes
  });

  it('keeps the canonical `phase` anchors (which DO skip/repeat) distinct from seq', () => {
    const plan = planIacTrack(myceliumLike());
    // no Phase 2 (state satisfied), and two playbook-phase-3 steps — the divergence seq fixes
    const phases = plan.track.map((s) => s.phase);
    expect(phases).not.toContain(2);
    expect(phases.filter((p) => p === 3).length).toBe(2);
  });

  it('leads with adoption (data-plane undeclared) and unlocks the downstream modules', () => {
    const plan = planIacTrack(myceliumLike());
    expect(plan.track[0].dimension).toBe('adoption');
    expect(plan.track[0].seq).toBe(1);
    expect(plan.track[0].unlocks).toEqual(
      expect.arrayContaining(['finops', 'privacy', 'policy-as-code']),
    );
    // the satisfied `state` dimension never appears as a step
    expect(plan.track.some((s) => s.dimension === 'state')).toBe(false);
  });
});
