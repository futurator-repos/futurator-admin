import { describe, it, expect } from 'vitest';
import {
  validateProjectContextPack,
  formatValidationErrors,
} from '../project-context-schema.mjs';

function validPack(overrides = {}) {
  return {
    version: 1,
    planMd: '# plan body\n',
    storySpec: {
      id: 'S-1',
      title: 'Story One',
      description: 'do the thing',
      acceptanceCriteria: [{ id: 'AC-1', text: 'works', needsBrowser: false }],
      touchPoints: ['src/main.js'],
      hasBrowserTests: false,
      wave: 0,
    },
    projectTree: 'src/\n  main.js',
    fileDigests: {
      'src/main.js': { sha: 'abc123', head: '// main', lines: 1 },
    },
    recentDiffs: 'abc1234 init',
    prevWorkSummaries: [],
    knowledgeIndex: '',
    runCommand: 'python3 -m http.server 8080',
    meta: {
      truncated: [],
      waveStartTime: '2026-05-05T00:00:00.000Z',
      projectDir: '/home/ubuntu/projects/foo',
    },
    ...overrides,
  };
}

describe('validateProjectContextPack — happy path', () => {
  it('accepts the canonical pack shape from buildStoryContextPack', () => {
    const result = validateProjectContextPack(validPack());
    expect(result).toEqual({ ok: true });
  });

  it('accepts wave: null (assembler emits null for non-numeric)', () => {
    const result = validateProjectContextPack(
      validPack({ storySpec: { ...validPack().storySpec, wave: null } }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts an empty fileDigests object (story may not declare touch points)', () => {
    const result = validateProjectContextPack(validPack({ fileDigests: {} }));
    expect(result.ok).toBe(true);
  });

  it('accepts file digest with the optional truncated:true marker', () => {
    const result = validateProjectContextPack(
      validPack({
        fileDigests: {
          'src/main.js': { sha: 'abc', head: '...', lines: 999, truncated: true },
        },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it('accepts pack with multiple prevWorkSummaries entries', () => {
    const result = validateProjectContextPack(
      validPack({
        prevWorkSummaries: [
          { storyId: 'S-0', title: 'Bootstrap', summary: 'set up tree' },
          { storyId: 'S-0a', title: 'Aside', summary: 'unrelated tweak' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
  });
});

describe('validateProjectContextPack — failure paths (clear error path)', () => {
  it('rejects null root', () => {
    const r = validateProjectContextPack(null);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/root: expected object/);
  });

  it('rejects missing required field with the field name in the error', () => {
    const pack = validPack();
    delete pack.fileDigests;
    const r = validateProjectContextPack(pack);
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing required field: fileDigests');
  });

  it('rejects wrong type on storySpec.id with the path', () => {
    const r = validateProjectContextPack(
      validPack({ storySpec: { ...validPack().storySpec, id: 42 } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('storySpec.id'))).toBe(true);
  });

  it('rejects missing storySpec.id (empty string fails non-empty check)', () => {
    const r = validateProjectContextPack(
      validPack({ storySpec: { ...validPack().storySpec, id: '' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('storySpec.id: expected non-empty string');
  });

  it('rejects non-array touchPoints', () => {
    const r = validateProjectContextPack(
      validPack({ storySpec: { ...validPack().storySpec, touchPoints: 'src/main.js' } }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('storySpec.touchPoints'))).toBe(true);
  });

  it('rejects fileDigests entry missing sha', () => {
    const r = validateProjectContextPack(
      validPack({
        fileDigests: { 'src/main.js': { head: '// main', lines: 1 } },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('sha'))).toBe(true);
  });

  it('rejects fileDigests entry with wrong type for truncated', () => {
    const r = validateProjectContextPack(
      validPack({
        fileDigests: {
          'src/main.js': { sha: 'abc', head: '// main', lines: 1, truncated: 'yes' },
        },
      }),
    );
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('truncated'))).toBe(true);
  });

  it('rejects meta.waveStartTime as number (must be ISO string or null)', () => {
    const pack = validPack();
    pack.meta.waveStartTime = 1714857600000;
    const r = validateProjectContextPack(pack);
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('waveStartTime'))).toBe(true);
  });

  it('rejects pack with version=0 (must be positive)', () => {
    const r = validateProjectContextPack(validPack({ version: 0 }));
    expect(r.ok).toBe(false);
    expect(r.errors.some((e) => e.includes('version'))).toBe(true);
  });

  it('returns multiple errors for a multiply-broken pack', () => {
    const broken = validPack();
    broken.planMd = 42;
    broken.storySpec.id = '';
    broken.fileDigests = null;
    const r = validateProjectContextPack(broken);
    expect(r.ok).toBe(false);
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });
});

describe('formatValidationErrors', () => {
  it('renders bullets and caps at 10 entries', () => {
    const many = Array.from({ length: 15 }, (_, i) => `error ${i}`);
    const out = formatValidationErrors(many);
    expect(out.split('\n').filter((l) => l.startsWith('- ')).length).toBe(10);
    expect(out).toContain('…and 5 more');
  });

  it('renders all bullets when ≤10 entries (no overflow line)', () => {
    const out = formatValidationErrors(['a', 'b', 'c']);
    expect(out).toBe('- a\n- b\n- c');
    expect(out).not.toContain('more');
  });
});
