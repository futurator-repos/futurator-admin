import { describe, it, expect } from 'vitest';
import {
  parseBindingManifest,
  classifyAcs,
  bindAc,
  applyBindings,
  evaluateCompletion,
  requiresBrowser,
} from '../completion-gate.mjs';

const ac = (id, over = {}) => ({ id, text: `${id} text`, acClass: 'deterministic', testBinding: { status: 'unbound' }, ...over });
const passing = (id, sha, over = {}) => ac(id, { testBinding: { status: 'passing', lastRunSha: sha }, ...over });

describe('parseBindingManifest', () => {
  it('parses a <BINDING> JSON object', () => {
    const text = `blah\n<BINDING>\n{ "ac-1": { "testRef": "t.test.ts -t x", "testKind": "unit" }, "ac-2": "probe:reach" }\n</BINDING>\ndone`;
    const m = parseBindingManifest(text);
    expect(m['ac-1']).toEqual({ testRef: 't.test.ts -t x', testKind: 'unit' });
    expect(m['ac-2']).toEqual({ testRef: 'probe:reach' });
  });
  it('tolerates a bare JSON object and fenced json', () => {
    expect(parseBindingManifest('```json\n{"a":{"testRef":"x"}}\n```')['a'].testRef).toBe('x');
    expect(parseBindingManifest('{"a":"y"}')['a'].testRef).toBe('y');
  });
  it('returns {} when absent/unparseable', () => {
    expect(parseBindingManifest('no manifest here')).toEqual({});
    expect(parseBindingManifest('<BINDING>not json</BINDING>')).toEqual({});
  });
});

describe('classifyAcs', () => {
  it('partitions by class and pulls out manual', () => {
    const b = classifyAcs([
      ac('d'),
      ac('s', { acClass: 'advisory-security' }),
      ac('t', { acClass: 'advisory-taste' }),
      ac('m', { verify: 'manual' }),
    ]);
    expect(b.deterministic.map((x) => x.id)).toEqual(['d']);
    expect(b.advisorySecurity.map((x) => x.id)).toEqual(['s']);
    expect(b.advisoryTaste.map((x) => x.id)).toEqual(['t']);
    expect(b.manual.map((x) => x.id)).toEqual(['m']);
  });

  it('advisory class WINS over the manual/browser routing (stays non-blocking)', () => {
    // A browser/appearance advisory AC bound as manual must NOT fall into the
    // manual bucket — else it routes to pending → needs-human and fails the story.
    const b = classifyAcs([
      ac('vt', { acClass: 'advisory-taste', verify: 'manual' }),
      ac('vs', { acClass: 'advisory-security', testBinding: { testKind: 'manual' } }),
      ac('bm', { acClass: 'deterministic', verify: 'manual' }),
    ]);
    expect(b.advisoryTaste.map((x) => x.id)).toEqual(['vt']);
    expect(b.advisorySecurity.map((x) => x.id)).toEqual(['vs']);
    expect(b.manual.map((x) => x.id)).toEqual(['bm']); // only the deterministic-manual AC
  });
});

describe('evaluateCompletion — advisory browser AC does not stall the story', () => {
  const SHA = 'sha1';
  it('deterministic pass + failing advisory-taste browser AC → done (not needs-human)', () => {
    const r = evaluateCompletion({
      acceptanceCriteria: [
        passing('det', SHA),
        ac('vis', {
          acClass: 'advisory-taste',
          needsBrowser: true,
          verify: 'appearance',
          testBinding: { status: 'failing', testKind: 'manual' },
        }),
      ],
      currentHeadSha: SHA,
    });
    expect(r.status).toBe('done'); // advisory visual defers to the VQA wave gate
    expect(r.done).toBe(true);
    expect(r.pending).toEqual([]);
  });
});

describe('bindAc / applyBindings', () => {
  it('binds immutably, flips unbound→bound', () => {
    const original = ac('a');
    const bound = bindAc(original, { testRef: 'r', testKind: 'unit' });
    expect(bound.testBinding.status).toBe('bound');
    expect(bound.testBinding.testRef).toBe('r');
    expect(original.testBinding.status).toBe('unbound');
  });
  it('applyBindings maps a manifest over the AC list', () => {
    const acs = applyBindings([ac('a'), ac('b')], { a: { testRef: 'ra' } });
    expect(acs[0].testBinding.status).toBe('bound');
    expect(acs[1].testBinding.status).toBe('unbound');
  });
});

describe('behavior-AC browser enforcement (Slice C — close the mocked-unit hole)', () => {
  const SHA = 'sha-beh';
  const behaviorAc = (id, over = {}) => ac(id, { verify: 'behavior', needsBrowser: true, ...over });

  it('requiresBrowser: behavior/needsBrowser yes; state/build no; advisory excluded', () => {
    expect(requiresBrowser({ verify: 'behavior' })).toBe(true);
    expect(requiresBrowser({ needsBrowser: true })).toBe(true);
    expect(requiresBrowser({ verify: 'state' })).toBe(false);
    expect(requiresBrowser({ verify: 'build' })).toBe(false);
    // advisory ACs are non-blocking / VQA-gated — never forced browser here
    expect(requiresBrowser({ verify: 'behavior', acClass: 'advisory-taste' })).toBe(false);
    expect(requiresBrowser({ needsBrowser: true, acClass: 'advisory-security' })).toBe(false);
  });

  it('bindAc REJECTS a behavior AC bound testKind:unit → misbound (not bound)', () => {
    const bound = bindAc(behaviorAc('b'), { testRef: 'x.test.ts', testKind: 'unit' });
    expect(bound.testBinding.status).toBe('misbound');
    expect(bound.testBinding.detail).toMatch(/browser/);
  });

  it('bindAc REJECTS an omitted testKind for a behavior AC → misbound', () => {
    const bound = bindAc(behaviorAc('b'), { testRef: 'probe' });
    expect(bound.testBinding.status).toBe('misbound');
  });

  it('bindAc ACCEPTS a behavior AC bound testKind:browser → bound', () => {
    const bound = bindAc(behaviorAc('b'), { testRef: 'probe:reach', testKind: 'browser' });
    expect(bound.testBinding.status).toBe('bound');
    expect(bound.testBinding.testKind).toBe('browser');
  });

  it('a pure verify:state AC still binds testKind:unit fine (do NOT force browser)', () => {
    const bound = bindAc(ac('s', { verify: 'state' }), { testRef: 's.test.ts -t x', testKind: 'unit' });
    expect(bound.testBinding.status).toBe('bound');
    expect(bound.testBinding.testKind).toBe('unit');
  });

  it('classifyAcs keeps a behavior AC DETERMINISTIC even when mis-declared manual', () => {
    const b = classifyAcs([behaviorAc('beh', { testBinding: { testKind: 'manual' } })]);
    expect(b.deterministic.map((x) => x.id)).toEqual(['beh']); // never routes to manual
    expect(b.manual).toEqual([]);
  });

  it('evaluateCompletion: a "passing" behavior AC bound unit does NOT count as done', () => {
    // Even if some runner recorded status:passing, a non-browser testKind fails closed.
    const r = evaluateCompletion({
      acceptanceCriteria: [behaviorAc('beh', { testBinding: { status: 'passing', lastRunSha: SHA, testKind: 'unit' } })],
      currentHeadSha: SHA,
    });
    expect(r.status).toBe('failing');
    expect(r.failing).toContain('beh');
    expect(r.reasons.join(' ')).toMatch(/misbound/);
  });

  it('evaluateCompletion: a behavior AC passing via testKind:browser IS done', () => {
    const r = evaluateCompletion({
      acceptanceCriteria: [behaviorAc('beh', { testBinding: { status: 'passing', lastRunSha: SHA, testKind: 'browser' } })],
      currentHeadSha: SHA,
    });
    expect(r.status).toBe('done');
  });
});

describe('evaluateCompletion truth table', () => {
  const SHA = 'abc123';
  it('all deterministic passing & fresh → done', () => {
    const r = evaluateCompletion({ acceptanceCriteria: [passing('a', SHA), passing('b', SHA)], currentHeadSha: SHA });
    expect(r.status).toBe('done');
    expect(r.done).toBe(true);
  });
  it('one unbound deterministic → failing', () => {
    const r = evaluateCompletion({ acceptanceCriteria: [passing('a', SHA), ac('b')], currentHeadSha: SHA });
    expect(r.status).toBe('failing');
    expect(r.failing).toContain('b');
  });
  it('stale SHA → failing', () => {
    const r = evaluateCompletion({ acceptanceCriteria: [passing('a', 'OLD')], currentHeadSha: SHA });
    expect(r.status).toBe('failing');
  });
  it('advisory-taste reviewer fail → done + attention (non-blocking)', () => {
    const r = evaluateCompletion({
      acceptanceCriteria: [passing('a', SHA), ac('t', { acClass: 'advisory-taste', testBinding: { status: 'passing', lastRunSha: SHA } })],
      currentHeadSha: SHA,
      reviewerVerdicts: { t: 'fail' },
    });
    expect(r.status).toBe('done');
    expect(r.attention).toContain('t');
  });
  it('advisory-security reviewer fail → blocked', () => {
    const r = evaluateCompletion({
      acceptanceCriteria: [passing('a', SHA), ac('s', { acClass: 'advisory-security', testBinding: { status: 'passing', lastRunSha: SHA } })],
      currentHeadSha: SHA,
      reviewerVerdicts: { s: 'fail' },
    });
    expect(r.status).toBe('blocked');
    expect(r.blocking).toContain('s');
  });
  it('needs-human takes precedence over everything', () => {
    const r = evaluateCompletion({
      acceptanceCriteria: [ac('a')], // would be failing
      currentHeadSha: SHA,
      needsHuman: ['a'],
    });
    expect(r.status).toBe('needs-human');
  });
  it('unresolved manual AC routes to needs-human', () => {
    const r = evaluateCompletion({
      acceptanceCriteria: [passing('a', SHA), ac('m', { verify: 'manual', testBinding: { status: 'bound' } })],
      currentHeadSha: SHA,
    });
    expect(r.status).toBe('needs-human');
    expect(r.pending).toContain('m');
  });
});
