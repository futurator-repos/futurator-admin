import { describe, it, expect } from 'vitest';
import { buildObservation } from '../../hooks/posttool-observe.mjs';
import { distill } from '../instinct-distiller.mjs';

describe('buildObservation — additive TDD signals', () => {
  it('is shape-identical when no signals present', () => {
    const o = buildObservation({ tool_name: 'Edit' }, {});
    expect(o.tamper).toBeUndefined();
    expect(o.coverageGap).toBeUndefined();
    expect(Object.keys(o).sort()).toEqual(['at', 'exitOutcome', 'role', 'session', 'sha', 'target', 'tool'].sort());
  });
  it('captures a TDD signal from env when present', () => {
    const o = buildObservation({ tool_name: 'Edit', tool_input: { file_path: 'src/x.ts' } }, { FUTURATOR_TAMPER: '1' });
    expect(o.tamper).toBe('1');
  });
});

describe('distill — TDD signals become instincts', () => {
  it('distills recurring tamper events into an instinct', () => {
    const obs = [
      { role: 'implementer', tool: 'Edit', target: 'src/login.test.ts', tamper: '1' },
      { role: 'implementer', tool: 'Edit', target: 'src/login.test.ts', tamper: '1' },
    ];
    const out = distill(obs, { minSupport: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].text).toMatch(/never touch the tests/);
  });
  it('does not distill routine success', () => {
    const obs = [{ role: 'dev', tool: 'Edit', target: 'src/a.ts', exitOutcome: 'ok' }];
    expect(distill(obs, { minSupport: 1 })).toHaveLength(0);
  });
});
