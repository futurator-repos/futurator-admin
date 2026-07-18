import { describe, it, expect } from 'vitest';
import { mintPhaseSteps } from '../planning-view';

describe('mintPhaseSteps', () => {
  it('marks every step pending when the job has no phase (absent job)', () => {
    const steps = mintPhaseSteps(null);
    expect(steps.map((s) => s.state)).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
    expect(steps.map((s) => s.id)).toEqual([
      'planner',
      'parallelism-repair',
      'critique',
      'critique-repair',
      'ingest',
    ]);
  });

  it('marks every step pending on an unrecognized phase value', () => {
    const steps = mintPhaseSteps({ phase: 'some-unknown-phase' });
    expect(steps.every((s) => s.state === 'pending')).toBe(true);
  });

  it('marks the current phase active, earlier phases done, later phases pending', () => {
    const steps = mintPhaseSteps({ phase: 'critique' });
    expect(steps.find((s) => s.id === 'planner')?.state).toBe('done');
    expect(steps.find((s) => s.id === 'parallelism-repair')?.state).toBe('done');
    expect(steps.find((s) => s.id === 'critique')?.state).toBe('active');
    expect(steps.find((s) => s.id === 'critique-repair')?.state).toBe('pending');
    expect(steps.find((s) => s.id === 'ingest')?.state).toBe('pending');
  });

  it('marks the first phase active with nothing done yet', () => {
    const steps = mintPhaseSteps({ phase: 'planner' });
    expect(steps[0].state).toBe('active');
    expect(steps.slice(1).every((s) => s.state === 'pending')).toBe(true);
  });

  it('marks every phase done once ingest is active (last step is never "done")', () => {
    const steps = mintPhaseSteps({ phase: 'ingest' });
    expect(steps.slice(0, 4).every((s) => s.state === 'done')).toBe(true);
    expect(steps[4].state).toBe('active');
  });
});
