import { describe, it, expect } from 'vitest';
import { distill, pathPattern } from '../instinct-distiller.mjs';
import { mergeInstincts, activeInstinctsFor, activeInstinctTexts, isActive } from '../instinct-store.mjs';
import { selectPromotable, toMyceliumNode, promoteInstincts } from '../instinct-promote.mjs';
import { buildInjectionWithInstincts, instinctInjectionArgs } from '../instinct-injector.mjs';
import { buildObservation, appendObservation, readObservations } from '../../hooks/posttool-observe.mjs';

const obs = (over = {}) => ({ role: 'dev', tool: 'Edit', target: 'functions/shared/auth.ts', scopeViolation: true, ...over });

describe('instinct-distiller', () => {
  it('pathPattern generalizes a concrete file to a 2-seg glob', () => {
    expect(pathPattern('functions/shared/auth.ts')).toBe('functions/shared/**');
    expect(pathPattern('top.ts')).toBe('top.ts');
  });
  it('distills recurring NEGATIVE observations into scored instincts', () => {
    const observations = [obs(), obs(), obs(), { role: 'dev', tool: 'Read', target: 'x', exitOutcome: 'ok' }];
    const instincts = distill(observations, { minSupport: 2 });
    expect(instincts).toHaveLength(1);
    expect(instincts[0].support).toBe(3);
    expect(instincts[0].confidence).toBeCloseTo(0.6, 5);
    expect(instincts[0].text).toMatch(/scope/i);
  });
  it('ignores routine success and below-support groups', () => {
    expect(distill([{ tool: 'Edit', target: 'a', exitOutcome: 'ok' }], { minSupport: 2 })).toEqual([]);
    expect(distill([obs()], { minSupport: 2 })).toEqual([]); // support 1 < 2
  });
});

describe('instinct-store', () => {
  it('mergeInstincts accretes support/confidence immutably', () => {
    const a = distill([obs(), obs()], { minSupport: 2 });
    const b = distill([obs(), obs(), obs(), obs()], { minSupport: 2 });
    const merged = mergeInstincts(a, b);
    expect(merged[0].support).toBe(4);
    expect(merged[0].confidence).toBeGreaterThanOrEqual(a[0].confidence);
  });
  it('activeInstinctsFor scopes by role + touches overlap', () => {
    const instincts = distill([obs(), obs(), obs()], { minSupport: 2 }); // confidence 0.6 → active
    expect(isActive(instincts[0])).toBe(true);
    const match = activeInstinctsFor(instincts, { role: 'dev', touches: ['functions/shared/**'] });
    expect(match).toHaveLength(1);
    const noMatch = activeInstinctsFor(instincts, { role: 'dev', touches: ['src/ui/**'] });
    expect(noMatch).toHaveLength(0);
    const wrongRole = activeInstinctsFor(instincts, { role: 'reviewer', touches: ['functions/shared/**'] });
    expect(wrongRole).toHaveLength(0);
  });
  it('low-confidence instincts are not active', () => {
    const low = [{ id: 'x', confidence: 0.4, status: 'candidate', touchesGlob: '*' }];
    expect(activeInstinctsFor(low, {})).toHaveLength(0);
  });
});

describe('instinct-promote', () => {
  it('selectPromotable escalates enforcement to gate at high confidence', () => {
    const instincts = [
      { id: 'a', confidence: 0.65, enforcement: 'advisory', status: 'active' },
      { id: 'b', confidence: 0.9, enforcement: 'advisory', status: 'active' },
      { id: 'c', confidence: 0.3, enforcement: 'advisory', status: 'active' },
    ];
    const p = selectPromotable(instincts);
    expect(p.map((i) => i.id).sort()).toEqual(['a', 'b']);
    expect(p.find((i) => i.id === 'a').enforcement).toBe('advisory');
    expect(p.find((i) => i.id === 'b').enforcement).toBe('gate');
    expect(p.every((i) => i.status === 'promoted')).toBe(true);
  });
  it('toMyceliumNode shapes an Instinct node with edges (graph write, no IAM)', () => {
    const node = toMyceliumNode({ id: 'i1', text: 't', touchesGlob: 'functions/shared/**', enforcement: 'gate', confidence: 0.9, support: 5, sample: { session: 's1' } });
    expect(node.type).toBe('Instinct');
    expect(node.edges.find((e) => e.kind === 'DERIVED_FROM').to).toBe('s1');
    expect(node.edges.find((e) => e.kind === 'CONSTRAINS').to).toBe('functions/shared/**');
  });
  it('promoteInstincts writes via injected graph writer; a failure does not abort the batch', async () => {
    const written = [];
    const promoted = await promoteInstincts({
      instincts: [
        { id: 'ok', confidence: 0.7, enforcement: 'advisory' },
        { id: 'bad', confidence: 0.7, enforcement: 'advisory' },
      ],
      writeNode: async (node) => { if (node.id === 'bad') throw new Error('graph down'); written.push(node.id); },
    });
    expect(written).toEqual(['ok']);
    expect(promoted.map((i) => i.id)).toEqual(['ok']);
  });
});

describe('instinct-injector', () => {
  it('folds active instincts into the injection text', () => {
    const instincts = distill([obs(), obs(), obs()], { minSupport: 2 });
    const text = buildInjectionWithInstincts({ instincts, role: 'dev', touches: ['functions/shared/**'], p3Flags: { P3_LAZY_MODE: 'full' } });
    expect(text).toMatch(/ACTIVE INSTINCTS/);
    expect(text).toMatch(/LAZY DEV MODE/);
  });
  it('returns [] args when no instincts apply and laziness off', () => {
    expect(instinctInjectionArgs({ instincts: [], role: 'dev', touches: ['x'] })).toEqual([]);
  });
});

describe('posttool-observe', () => {
  it('builds an observation from a PostToolUse payload', () => {
    const o = buildObservation(
      { session_id: 's1', tool_name: 'Edit', tool_input: { file_path: 'a.ts' }, tool_response: { exitCode: 0 } },
      { FUTURATOR_AGENT_ROLE: 'dev', FUTURATOR_HEAD_SHA: 'SHA' },
    );
    expect(o).toMatchObject({ session: 's1', role: 'dev', tool: 'Edit', target: 'a.ts', exitOutcome: 'ok', sha: 'SHA' });
  });
  it('round-trips observations.jsonl', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const fs = await import('node:fs');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'obs-')), 'observations.jsonl');
    appendObservation(file, { tool: 'Edit', target: 'a' });
    appendObservation(file, { tool: 'Write', target: 'b' });
    expect(readObservations(file)).toHaveLength(2);
  });
});
