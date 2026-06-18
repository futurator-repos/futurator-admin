/**
 * verify-graph.test.mjs — the pure layer classifier behind the health probe.
 */

import { describe, it, expect } from 'vitest';
import { classifyGraph } from '../verify-graph.mjs';

describe('classifyGraph', () => {
  it('buckets kinds into layers and totals them', () => {
    const s = classifyGraph([
      { kind: 'function', count: 216 },
      { kind: 'file', count: 68 },
      { kind: '<null>', count: 80 },
      { kind: 'class', count: 1 },
    ]);
    expect(s.totals.ast).toBe(285); // function + file + class
    expect(s.totals.wiki).toBe(80);
    expect(s.total).toBe(365);
    expect(s.hasSystemGraph).toBe(false); // the current production reality
    expect(s.hasContractSpine).toBe(false);
  });

  it('flags the system-graph layer once infra/service/endpoint nodes exist', () => {
    const s = classifyGraph([
      { kind: 'function', count: 10 },
      { kind: 'table', count: 3 },
      { kind: 'endpoint', count: 5 },
      { kind: 'service', count: 1 },
    ]);
    expect(s.hasSystemGraph).toBe(true);
    expect(s.totals.systemGraph).toBe(9);
  });

  it('flags the contract spine once capability/contract nodes exist', () => {
    const s = classifyGraph([
      { kind: 'capability', count: 2 },
      { kind: 'contract', count: 4 },
      { kind: 'contractRevision', count: 7 },
    ]);
    expect(s.hasContractSpine).toBe(true);
    expect(s.totals.contractSpine).toBe(13);
  });

  it('routes unknown kinds to "other" without throwing', () => {
    const s = classifyGraph([{ kind: 'mystery', count: 4 }]);
    expect(s.totals.other).toBe(4);
  });
});
