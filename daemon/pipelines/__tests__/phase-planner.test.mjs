/**
 * phase-planner.test.mjs — locks the v2 phased plan generator: heuristic band
 * assignment, deterministic dependency derivation, foundations-first topo order,
 * and a planOutput that PASSES the real characterization-net gate by construction.
 */

import { describe, it, expect } from 'vitest';
import {
  assignBand,
  deriveDependencies,
  planPhases,
  toPlanOutput,
  PHASE_NAMES,
} from '../lib/phase-planner.mjs';
import { findCharacterizationGateViolations } from '../refactor-audit-job-runner.mjs';

const f = (id, over = {}) => ({
  id,
  dimension: 'architecture',
  area: '§sys:src--lib',
  severity: 'High',
  effort: 'Medium',
  location: `src/lib/${id}.ts:1`,
  issue: `issue ${id}`,
  suggestion: `fix ${id}`,
  evidence: {},
  source: 'deterministic',
  dependsOn: [],
  ...over,
});

describe('assignBand — canonical 0..6 ladder', () => {
  it('Trivial dead code → Phase 0 (stop-the-bleeding)', () => {
    expect(assignBand(f('d', { effort: 'Trivial', evidence: { hotspotKind: 'dead-code' } }))).toBe(0);
  });
  it('mechanical fix → Phase 0', () => {
    expect(assignBand(f('m', { evidence: { mechanical: true } }))).toBe(0);
  });
  it('foundation contract → Phase 1', () => {
    expect(assignBand(f('c', { evidence: { foundationKind: 'contract' } }))).toBe(1);
  });
  it('duplicate-subsystem → Phase 2 (shared helpers)', () => {
    expect(assignBand(f('dup', { evidence: { hotspotKind: 'duplicate-subsystem' } }))).toBe(2);
  });
  it('UI / design-system → Phase 3', () => {
    expect(assignBand(f('ui', { area: 'UI', evidence: { hotspotKind: 'design-system-consolidation' } }))).toBe(3);
  });
  it('god-object → Phase 4', () => {
    expect(assignBand(f('g', { evidence: { hotspotKind: 'god-object' } }))).toBe(4);
  });
  it('correctness → Phase 5', () => {
    expect(assignBand(f('cor', { dimension: 'correctness' }))).toBe(5);
  });
  it('Large safety/scale → Phase 6', () => {
    expect(assignBand(f('sc', { effort: 'Large', dimension: 'safety-security', suggestion: 'add auth middleware' }))).toBe(6);
  });
});

// Regression lock against the first real-app run (applicator-onboarding) where
// these classes collapsed into Phase 5. LLM findings carry no evidence hints —
// routing must work off issue+suggestion text.
describe('assignBand — real-data rebalance (text-driven, no evidence hints)', () => {
  const llm = (over) => f('x', { source: 'llm', evidence: {}, ...over });

  it('magic-number / centralization LLM findings → Phase 1 (foundations)', () => {
    expect(assignBand(llm({ dimension: 'code-quality-refactoring', issue: 'Scattered magic numbers for section thresholds; no centralized constants', suggestion: 'centralize in constants', effort: 'Small' }))).toBe(1);
    expect(assignBand(llm({ dimension: 'code-quality-refactoring', issue: 'Magic number 500 (debounce delay in ms)', suggestion: 'should be a named constant', effort: 'Trivial' }))).toBe(1);
    expect(assignBand(llm({ dimension: 'code-quality-refactoring', issue: 'S3 cache constants hardcoded, not reusing centralized values', suggestion: 'reuse centralized config', effort: 'Medium' }))).toBe(1);
  });

  it('hand-rolled / inline-color UI LLM findings → Phase 3 (UI centralization)', () => {
    expect(assignBand(llm({ dimension: 'architecture', area: '§sys:src--components--onboarding-v2', issue: 'Proficiency badge colors hand-rolled with hardcoded inline color mappings', suggestion: 'extract a MaturityBadge', effort: 'Medium' }))).toBe(3);
    expect(assignBand(llm({ dimension: 'architecture', issue: 'Alert/callout boxes repeatedly hand-rolled across 51 files', suggestion: 'centralized Callout component', effort: 'Large' }))).toBe(3);
  });

  it('duplicated-logic LLM findings → Phase 2 (helpers)', () => {
    expect(assignBand(llm({ dimension: 'code-quality-refactoring', issue: 'calculateProfileCompleteness duplicated; same logic in two files', suggestion: 'extract a shared helper', effort: 'Small' }))).toBe(2);
  });

  it('High/Medium Trivial isolated bugs → Phase 0 (quick wins)', () => {
    expect(assignBand(llm({ dimension: 'safety-security', issue: 'API key fragments logged to console', suggestion: 'redact before logging', severity: 'High', effort: 'Trivial' }))).toBe(0);
    expect(assignBand(llm({ dimension: 'correctness', issue: 'Unsafe environment variable fallback to localhost in production', suggestion: 'throw if unset', severity: 'High', effort: 'Trivial' }))).toBe(0);
  });

  it('non-Trivial correctness/safety stays in Phase 5', () => {
    expect(assignBand(llm({ dimension: 'correctness', issue: 'API response parsed without schema validation', suggestion: 'validate with zod', severity: 'High', effort: 'Small' }))).toBe(5);
  });

  it('produces a populated Phase 0 + Phase 1 on a mixed real-ish set', () => {
    const set = [
      llm({ id: 'a', dimension: 'safety-security', issue: 'API key logged', suggestion: 'redact', severity: 'High', effort: 'Trivial' }),
      llm({ id: 'b', dimension: 'code-quality-refactoring', issue: 'Magic numbers scattered', suggestion: 'centralize constants', effort: 'Small' }),
      llm({ id: 'c', dimension: 'architecture', issue: 'badge colors hand-rolled inline', suggestion: 'Badge component', effort: 'Medium' }),
      f('d', { evidence: { hotspotKind: 'god-object', godFile: true }, effort: 'Large' }),
    ];
    const plan = planPhases(set);
    const phases = new Set(plan.phases.map((p) => p.phase));
    expect(phases.has(0)).toBe(true); // quick win
    expect(phases.has(1)).toBe(true); // constants
    expect(phases.has(3)).toBe(true); // UI
    expect(phases.has(4)).toBe(true); // god-file
  });
});

describe('deriveDependencies', () => {
  it('consumer → foundation (fan-in rule)', () => {
    const foundation = f('F', { evidence: { isFoundation: true, artifact: 'IMPACT_THRESHOLD', foundationKind: 'constant' } });
    const consumer = f('C', { evidence: { consumesArtifact: 'IMPACT_THRESHOLD' } });
    const out = deriveDependencies([foundation, consumer]);
    expect(out.find((x) => x.id === 'C').dependsOn).toContain('F');
  });
  it('Strangler-Fig: deletion dependsOn its extract', () => {
    const extract = f('X', {});
    const del = f('D', { evidence: { isDeletion: true, extractOf: 'X' } });
    const out = deriveDependencies([extract, del]);
    expect(out.find((x) => x.id === 'D').dependsOn).toContain('X');
  });
});

describe('planPhases', () => {
  it('orders foundations before consumers and buckets into named phases', () => {
    const findings = [
      f('dead', { effort: 'Trivial', evidence: { hotspotKind: 'dead-code' } }),
      f('const', { evidence: { isFoundation: true, foundationKind: 'constant', artifact: 'TH' } }),
      f('uses', { dimension: 'correctness', evidence: { consumesArtifact: 'TH' } }),
      f('god', { effort: 'Large', evidence: { hotspotKind: 'god-object' } }),
    ];
    const plan = planPhases(findings);
    const phaseOf = (id) => plan.phases.find((p) => p.items.includes(id))?.phase;
    expect(phaseOf('dead')).toBe(0);
    expect(phaseOf('const')).toBe(1);
    expect(phaseOf('god')).toBe(4);
    // global order: const (P1) before its consumer 'uses' (P5)
    expect(plan.order.indexOf('const')).toBeLessThan(plan.order.indexOf('uses'));
    // phase names present
    expect(plan.phases.every((p) => PHASE_NAMES[p.phase] === p.name)).toBe(true);
  });

  it('pulls a finding LATER when it depends on a later-band finding (never earlier)', () => {
    const later = f('L', { dimension: 'correctness' }); // band 5
    const dependent = f('E', { effort: 'Trivial', evidence: { hotspotKind: 'dead-code' }, dependsOn: ['L'] }); // band 0 normally
    const plan = planPhases([later, dependent]);
    const bandOf = (id) => plan.phases.find((p) => p.items.includes(id))?.phase;
    expect(bandOf('E')).toBeGreaterThanOrEqual(bandOf('L'));
  });
});

describe('toPlanOutput + characterization-net gate', () => {
  it('injects a net per mutating phase and PASSES findCharacterizationGateViolations', () => {
    const findings = [
      f('dead', { effort: 'Trivial', issue: 'delete dead file', suggestion: 'delete x.ts', evidence: { hotspotKind: 'dead-code' } }),
      f('dup', { issue: 'consolidate duplicated write', suggestion: 'extract upsertFileVersioned', evidence: { hotspotKind: 'duplicate-subsystem' } }),
      f('god', { issue: 'split god hook', suggestion: 'extract useProjects from use-mycelium', evidence: { hotspotKind: 'god-object' } }),
      f('safe', { dimension: 'correctness', issue: 'add res.ok check', suggestion: 'wrap in apiFetch' }),
    ];
    const plan = planPhases(findings);
    const byId = new Map(findings.map((x) => [x.id, x]));
    const out = toPlanOutput(plan, byId);
    // schema-shaped ids
    expect(out.plan.epics.every((e) => /^E\d+$/.test(e.id))).toBe(true);
    expect(out.plan.epics.every((e) => e.stories.every((s) => /^S\d+$/.test(s.id)))).toBe(true);
    // epics chain
    expect(out.plan.epics[0].dependsOn).toEqual([]);
    if (out.plan.epics[1]) expect(out.plan.epics[1].dependsOn).toEqual([out.plan.epics[0].id]);
    // THE invariant: the generated plan has zero char-net violations
    expect(findCharacterizationGateViolations(out)).toEqual([]);
  });

  it('a plan with NO net would violate (control) — proves the gate is real', () => {
    const bad = { plan: { epics: [{ id: 'E1', title: 't', goal: 'g', dependsOn: [], stories: [
      { id: 'S1', title: 'delete the old module', description: 'd', dependsOn: [], touchPoints: ['a.ts'], criteria: [{ id: 'C1', text: 'remove it', needsBrowser: false }] },
    ] }] } };
    expect(findCharacterizationGateViolations(bad).length).toBeGreaterThan(0);
  });
});
