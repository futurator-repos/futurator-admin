/**
 * story-persist.test.mjs — G1 unit tests.
 *
 * Tests cover:
 *   • Primary path: full field set → correct UpdateExpression shape
 *   • updatedAt appended EXACTLY ONCE (no duplicate path)
 *   • metrics{} flattening (metrics wins over same-named top-level fields)
 *   • Undefined fields are excluded from the expression
 *   • Every attribute name is aliased with a # prefix
 *   • Minimal call (state only) still produces a valid update
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildStoryStateUpdate,
  capStageSummaries,
  STAGE_SUMMARY_PREVIEW_CAP,
  STAGE_SUMMARIES_MAX_BYTES,
} from '../story-persist.mjs';

// ── Primary path ──────────────────────────────────────────────────────────────

describe('buildStoryStateUpdate — primary path', () => {
  it('returns UpdateExpression, ExpressionAttributeNames, ExpressionAttributeValues', () => {
    const result = buildStoryStateUpdate({ state: 'done' });
    expect(result).toHaveProperty('UpdateExpression');
    expect(result).toHaveProperty('ExpressionAttributeNames');
    expect(result).toHaveProperty('ExpressionAttributeValues');
  });

  it('UpdateExpression starts with SET', () => {
    const result = buildStoryStateUpdate({ state: 'done' });
    expect(result.UpdateExpression).toMatch(/^SET /);
  });

  it('includes state in the expression', () => {
    const result = buildStoryStateUpdate({ state: 'done' });
    expect(result.UpdateExpression).toContain('#state = :state');
    expect(result.ExpressionAttributeNames['#state']).toBe('state');
    expect(result.ExpressionAttributeValues[':state']).toBe('done');
  });

  it('includes all provided fields', () => {
    const acs = [{ id: 'ac-1', text: 'x', testBinding: { status: 'passing' }, acClass: 'deterministic' }];
    const verdict = { done: true, status: 'done', failing: [], blocking: [], attention: [], pending: [], reasons: [] };
    const result = buildStoryStateUpdate({
      state: 'done',
      verdict,
      acceptanceCriteria: acs,
      commitSha: 'abc123',
      costUsd: 0.05,
      inputTokens: 1000,
      outputTokens: 400,
      durationMs: 28000,
    });
    expect(result.ExpressionAttributeValues[':state']).toBe('done');
    expect(result.ExpressionAttributeValues[':verdict']).toEqual(verdict);
    expect(result.ExpressionAttributeValues[':acceptanceCriteria']).toEqual(acs);
    expect(result.ExpressionAttributeValues[':commitSha']).toBe('abc123');
    expect(result.ExpressionAttributeValues[':costUsd']).toBe(0.05);
    expect(result.ExpressionAttributeValues[':inputTokens']).toBe(1000);
    expect(result.ExpressionAttributeValues[':outputTokens']).toBe(400);
    expect(result.ExpressionAttributeValues[':durationMs']).toBe(28000);
  });

  it('writes the whole acceptanceCriteria array (post-run copy)', () => {
    const acs = [
      { id: 'ac-1', text: 'first', testBinding: { status: 'passing', lastRunSha: 'sha1' }, acClass: 'deterministic' },
      { id: 'ac-2', text: 'second', testBinding: { status: 'failing' }, acClass: 'advisory-taste' },
    ];
    const result = buildStoryStateUpdate({ state: 'failed', acceptanceCriteria: acs });
    expect(result.ExpressionAttributeValues[':acceptanceCriteria']).toHaveLength(2);
    expect(result.ExpressionAttributeValues[':acceptanceCriteria']).toEqual(acs);
  });
});

// ── updatedAt — exactly once ───────────────────────────────────────────────────

describe('buildStoryStateUpdate — updatedAt', () => {
  it('always appends updatedAt', () => {
    const result = buildStoryStateUpdate({ state: 'done' });
    expect(result.UpdateExpression).toContain('#updatedAt = :updatedAt');
    expect(result.ExpressionAttributeNames['#updatedAt']).toBe('updatedAt');
    expect(typeof result.ExpressionAttributeValues[':updatedAt']).toBe('string');
  });

  it('appends updatedAt EXACTLY ONCE even on full-field call', () => {
    const result = buildStoryStateUpdate({
      state: 'done',
      verdict: { done: true, status: 'done', failing: [], blocking: [], attention: [], pending: [], reasons: [] },
      acceptanceCriteria: [],
      commitSha: 'sha',
      costUsd: 0.01,
      inputTokens: 100,
      outputTokens: 50,
      durationMs: 5000,
    });
    const matches = result.UpdateExpression.match(/#updatedAt/g) || [];
    expect(matches).toHaveLength(1);
  });

  it('updatedAt value is a valid ISO timestamp', () => {
    const before = new Date().toISOString();
    const result = buildStoryStateUpdate({ state: 'done' });
    const after = new Date().toISOString();
    const ts = result.ExpressionAttributeValues[':updatedAt'];
    expect(ts >= before).toBe(true);
    expect(ts <= after).toBe(true);
  });
});

// ── metrics flattening ─────────────────────────────────────────────────────────

describe('buildStoryStateUpdate — metrics flattening', () => {
  it('flattens metrics into cost fields', () => {
    const result = buildStoryStateUpdate({
      state: 'done',
      metrics: { costUsd: 0.07, inputTokens: 2000, outputTokens: 800, durationMs: 42000 },
    });
    expect(result.ExpressionAttributeValues[':costUsd']).toBe(0.07);
    expect(result.ExpressionAttributeValues[':inputTokens']).toBe(2000);
    expect(result.ExpressionAttributeValues[':outputTokens']).toBe(800);
    expect(result.ExpressionAttributeValues[':durationMs']).toBe(42000);
  });

  it('metrics wins over same-named top-level fields', () => {
    const result = buildStoryStateUpdate({
      state: 'done',
      costUsd: 0.01,    // should be overridden
      inputTokens: 100, // should be overridden
      metrics: { costUsd: 0.07, inputTokens: 2000 },
    });
    expect(result.ExpressionAttributeValues[':costUsd']).toBe(0.07);
    expect(result.ExpressionAttributeValues[':inputTokens']).toBe(2000);
  });

  it('uses top-level fields when metrics does not provide them', () => {
    const result = buildStoryStateUpdate({
      state: 'done',
      costUsd: 0.03,
      inputTokens: 500,
      metrics: { durationMs: 10000 }, // only provides durationMs
    });
    expect(result.ExpressionAttributeValues[':costUsd']).toBe(0.03);
    expect(result.ExpressionAttributeValues[':inputTokens']).toBe(500);
    expect(result.ExpressionAttributeValues[':durationMs']).toBe(10000);
  });

  it('ignores extra metrics fields (sessionId, numTurns) — not written to DDB', () => {
    const result = buildStoryStateUpdate({
      state: 'done',
      metrics: { costUsd: 0.01, sessionId: 'sess-x', numTurns: 5 },
    });
    // sessionId and numTurns are not columns in the story-node row
    expect(result.ExpressionAttributeValues[':sessionId']).toBeUndefined();
    expect(result.ExpressionAttributeValues[':numTurns']).toBeUndefined();
  });
});

// ── Undefined fields excluded ──────────────────────────────────────────────────

describe('buildStoryStateUpdate — undefined exclusion', () => {
  it('omits undefined fields from the expression', () => {
    const result = buildStoryStateUpdate({ state: 'failed' });
    expect(result.ExpressionAttributeValues[':verdict']).toBeUndefined();
    expect(result.ExpressionAttributeValues[':commitSha']).toBeUndefined();
    expect(result.ExpressionAttributeValues[':costUsd']).toBeUndefined();
  });

  it('minimal call (state only) produces a valid SET expression', () => {
    const result = buildStoryStateUpdate({ state: 'failed' });
    // Should have #state + #updatedAt only
    const keys = Object.keys(result.ExpressionAttributeNames);
    expect(keys).toHaveLength(2);
    expect(keys).toContain('#state');
    expect(keys).toContain('#updatedAt');
  });

  it('empty call produces updatedAt-only expression', () => {
    const result = buildStoryStateUpdate({});
    expect(result.UpdateExpression).toBe('SET #updatedAt = :updatedAt');
  });

  it('call with no args produces updatedAt-only expression', () => {
    const result = buildStoryStateUpdate();
    expect(result.UpdateExpression).toBe('SET #updatedAt = :updatedAt');
  });
});

// ── Alias-everything invariant ─────────────────────────────────────────────────

describe('buildStoryStateUpdate — alias-everything', () => {
  it('all ExpressionAttributeNames keys start with #', () => {
    const result = buildStoryStateUpdate({
      state: 'done',
      commitSha: 'sha',
      costUsd: 0.01,
      durationMs: 5000,
    });
    for (const key of Object.keys(result.ExpressionAttributeNames)) {
      expect(key.startsWith('#')).toBe(true);
    }
  });

  it('ExpressionAttributeNames values are the real attribute names (no # prefix)', () => {
    const result = buildStoryStateUpdate({ state: 'done', commitSha: 'sha' });
    for (const val of Object.values(result.ExpressionAttributeNames)) {
      expect(val.startsWith('#')).toBe(false);
    }
    expect(result.ExpressionAttributeNames['#state']).toBe('state');
    expect(result.ExpressionAttributeNames['#commitSha']).toBe('commitSha');
    expect(result.ExpressionAttributeNames['#updatedAt']).toBe('updatedAt');
  });

  it('verdict field is aliased (not a bare attribute name in UpdateExpression)', () => {
    const result = buildStoryStateUpdate({
      state: 'done',
      verdict: { done: true, status: 'done', failing: [], blocking: [], attention: [], pending: [], reasons: [] },
    });
    expect(result.UpdateExpression).toContain('#verdict = :verdict');
    expect(result.ExpressionAttributeNames['#verdict']).toBe('verdict');
  });

  it('persists a non-empty loadedSkills array (aliased) for the forensic Skills tab', () => {
    const loadedSkills = [
      { skill: 'lazy-dev', source: 'org' },
      { skill: 'ui-components', source: 'anthropic-official' },
    ];
    const result = buildStoryStateUpdate({ state: 'done', loadedSkills });
    expect(result.UpdateExpression).toContain('#loadedSkills = :loadedSkills');
    expect(result.ExpressionAttributeNames['#loadedSkills']).toBe('loadedSkills');
    expect(result.ExpressionAttributeValues[':loadedSkills']).toEqual(loadedSkills);
  });

  it('does NOT write loadedSkills when the array is empty (never clobber a prior set)', () => {
    const result = buildStoryStateUpdate({ state: 'failed', loadedSkills: [] });
    expect(result.UpdateExpression).not.toContain('loadedSkills');
    expect(result.ExpressionAttributeNames['#loadedSkills']).toBeUndefined();
  });

  it('does NOT write loadedSkills when omitted', () => {
    const result = buildStoryStateUpdate({ state: 'done', commitSha: 'sha' });
    expect(result.UpdateExpression).not.toContain('loadedSkills');
  });
});

// ── invariants persistence (dossier A1) ────────────────────────────────────────
// The validator bindings previously existed ONLY in the fresh test-author's
// stdout — a resumed/retried job re-derived manifest={} and fail-closed on
// 'no authored validator'. Persisting them on the row (exactly like
// acceptanceCriteria) is what breaks the deterministic retry dead-end.

describe('buildStoryStateUpdate — invariants (A1)', () => {
  const invariants = [
    {
      id: 'inv-1',
      description: 'every declared target resolves',
      validator: { ref: 'src/inv-1.invariant.test.ts', kind: 'test', status: 'passing', lastRunSha: 'sha1' },
    },
  ];

  it('persists a non-empty invariants array WITH validator state (aliased)', () => {
    const result = buildStoryStateUpdate({ state: 'done', invariants });
    expect(result.UpdateExpression).toContain('#invariants = :invariants');
    expect(result.ExpressionAttributeNames['#invariants']).toBe('invariants');
    expect(result.ExpressionAttributeValues[':invariants']).toEqual(invariants);
    expect(result.ExpressionAttributeValues[':invariants'][0].validator.ref).toBe('src/inv-1.invariant.test.ts');
    expect(result.ExpressionAttributeValues[':invariants'][0].validator.status).toBe('passing');
  });

  it('does NOT write invariants when the array is empty (never clobber a prior binding)', () => {
    const result = buildStoryStateUpdate({ state: 'failed', invariants: [] });
    expect(result.UpdateExpression).not.toContain('invariants');
    expect(result.ExpressionAttributeNames['#invariants']).toBeUndefined();
  });

  it('does NOT write invariants when omitted', () => {
    const result = buildStoryStateUpdate({ state: 'done' });
    expect(result.UpdateExpression).not.toContain('invariants');
  });
});

// ── stageSummaries persistence + size caps (dossier B2) ────────────────────────

describe('buildStoryStateUpdate — stageSummaries', () => {
  it('persists a stageSummaries object (aliased)', () => {
    const stageSummaries = {
      testAuthor: { files: [{ path: 'src/a.test.ts', lines: 10 }], redSha: 'sha1', resumed: false },
      implementer: { attempts: [{ attempt: 1, commitSha: 'sha2', durationMs: 100 }] },
    };
    const result = buildStoryStateUpdate({ state: 'done', stageSummaries });
    expect(result.UpdateExpression).toContain('#stageSummaries = :stageSummaries');
    expect(result.ExpressionAttributeNames['#stageSummaries']).toBe('stageSummaries');
    expect(result.ExpressionAttributeValues[':stageSummaries']).toEqual(stageSummaries);
  });

  it('does NOT write stageSummaries when omitted', () => {
    const result = buildStoryStateUpdate({ state: 'done' });
    expect(result.UpdateExpression).not.toContain('stageSummaries');
  });
});

describe('capStageSummaries', () => {
  it('returns undefined for null/non-object/empty input', () => {
    expect(capStageSummaries(null)).toBeUndefined();
    expect(capStageSummaries(undefined)).toBeUndefined();
    expect(capStageSummaries('x')).toBeUndefined();
    expect(capStageSummaries({})).toBeUndefined();
  });

  it('passes a small object through structurally unchanged (deep copy)', () => {
    const s = { testAuthor: { files: [{ path: 'a', preview: 'short' }], resumed: true } };
    const out = capStageSummaries(s);
    expect(out).toEqual(s);
    expect(out).not.toBe(s); // never mutates the caller's object
  });

  it(`caps each preview at ${STAGE_SUMMARY_PREVIEW_CAP} chars`, () => {
    const s = { testAuthor: { files: [{ path: 'a', preview: 'x'.repeat(5000) }] } };
    const out = capStageSummaries(s);
    expect(out.testAuthor.files[0].preview.length).toBe(STAGE_SUMMARY_PREVIEW_CAP);
    // input untouched
    expect(s.testAuthor.files[0].preview.length).toBe(5000);
  });

  it(`shrinks/drops previews until the total JSON fits under ${STAGE_SUMMARIES_MAX_BYTES} bytes`, () => {
    // 40 files × 2000-char previews = ~80KB of preview payload alone.
    const files = Array.from({ length: 40 }, (_, i) => ({
      path: `src/f${i}.test.ts`,
      lines: 50,
      preview: 'y'.repeat(3000),
    }));
    const s = { testAuthor: { files, redSha: 'sha1' } };
    const out = capStageSummaries(s);
    expect(Buffer.byteLength(JSON.stringify(out), 'utf8')).toBeLessThanOrEqual(STAGE_SUMMARIES_MAX_BYTES);
    // structural fields survive — previews are the sacrifice
    expect(out.testAuthor.files).toHaveLength(40);
    expect(out.testAuthor.files[0].path).toBe('src/f0.test.ts');
    expect(out.testAuthor.redSha).toBe('sha1');
  });
});
