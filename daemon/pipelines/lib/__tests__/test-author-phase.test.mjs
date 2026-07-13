import { describe, it, expect } from 'vitest';
import {
  buildStoryTestPrompt,
  buildImplementerPrompt,
  runTestAuthorPhase,
  parsePorcelainTestFiles,
} from '../test-author-phase.mjs';

describe('parsePorcelainTestFiles (pacman3 canary fix)', () => {
  it('collects new/modified test files from git status --porcelain', () => {
    const out = parsePorcelainTestFiles([
      '?? src/game/pacman/movement.test.ts',
      ' M src/game/pacman/ghost-ai.test.ts',
      'A  src/game/pacman/movement.ts', // impl file — excluded
      '?? notes.md',
    ].join('\n'));
    expect(out).toEqual(['src/game/pacman/movement.test.ts', 'src/game/pacman/ghost-ai.test.ts']);
  });
  it('handles renames and empty input', () => {
    expect(parsePorcelainTestFiles('R  old.test.ts -> src/new.test.ts')).toEqual(['src/new.test.ts']);
    expect(parsePorcelainTestFiles('')).toEqual([]);
    expect(parsePorcelainTestFiles(undefined)).toEqual([]);
  });
});

const payload = {
  storyId: 'S1',
  title: 'Login',
  touches: ['src/login.ts', 'src/login.test.ts'],
  acceptanceCriteria: [{ id: 'AC-1', text: 'issues a token' }],
};
const bindingText = '<BINDING>{"AC-1":{"testRef":"login issues token","testKind":"unit"}}</BINDING>';

describe('prompts', () => {
  it('test-author prompt demands failing tests, no implementation', () => {
    const p = buildStoryTestPrompt(payload);
    expect(p).toMatch(/TEST AUTHOR/);
    expect(p).toMatch(/MUST FAIL/);
    expect(p).toMatch(/AC-1/);
    expect(p).toMatch(/<BINDING>/);
    expect(p).toMatch(/Do NOT write, stub, or scaffold implementation/);
  });
  it('renders NO invariants block when the story declares none (byte-identical common case)', () => {
    expect(buildStoryTestPrompt(payload)).not.toMatch(/<INVARIANTS>/);
  });
  it('split-path test-author authors declared invariants as *.invariant.test.ts + emits the manifest', () => {
    const p = buildStoryTestPrompt({
      ...payload,
      invariants: [
        { id: 'S1-inv1', description: 'every declared route resolves to a component' },
      ],
    });
    expect(p).toMatch(/Invariant validators \(MANDATORY/);
    expect(p).toMatch(/S1-inv1/);
    expect(p).toMatch(/every declared route resolves/);
    expect(p).toMatch(/\*\*\/<id>\.invariant\.test\.ts/); // steered to the staged form
    expect(p).toMatch(/<INVARIANTS>/);
    expect(p).toMatch(/"S1-inv1": \{ "ref": "<path-to-your-invariant-test>", "kind": "test" \}/);
  });
  it('implementer prompt lists owned tests and forbids editing them', () => {
    const p = buildImplementerPrompt(payload, ['src/login.test.ts']);
    expect(p).toMatch(/IMPLEMENTER/);
    expect(p).toMatch(/src\/login\.test\.ts/);
    expect(p).toMatch(/may NOT create, edit, or delete/);
  });
});

const redSummary = { ran: 1, passed: 0, failed: 1 };
const deps = (over = {}) => ({
  payload,
  headSha: 'sha0',
  spawnOnce: async () => ({ exitCode: 0, text: bindingText }),
  commitRed: async () => ({ committed: true, sha: 'redsha', files: ['src/login.test.ts'] }),
  runBindings: async () => ({ acceptanceCriteria: [], summary: redSummary }),
  ...over,
});

describe('runTestAuthorPhase', () => {
  it('happy path: authors, commits RED, proves red, returns owned files', async () => {
    const r = await runTestAuthorPhase(deps());
    expect(r.ownedTestFiles).toEqual(['src/login.test.ts']);
    expect(r.redSha).toBe('redsha');
    expect(r.boundCriteria[0].testBinding.status).toBe('bound');
    expect(r.resumed).toBeUndefined(); // fresh path — not a retry resume
  });

  it('throws on a non-zero test-author spawn (FRESH path → caller retries once, then fails CLOSED)', async () => {
    await expect(runTestAuthorPhase(deps({ spawnOnce: async () => ({ exitCode: 1, text: '' }) }))).rejects.toThrow(/exit 1/);
  });

  it('throws when no <BINDING> is emitted', async () => {
    await expect(runTestAuthorPhase(deps({ spawnOnce: async () => ({ exitCode: 0, text: 'no binding here' }) }))).rejects.toThrow(/no <BINDING>/);
  });

  it('throws when a bound test PASSES before implementation (not RED)', async () => {
    await expect(
      runTestAuthorPhase(deps({ runBindings: async () => ({ acceptanceCriteria: [], summary: { ran: 1, passed: 1, failed: 0 } }) })),
    ).rejects.toThrow(/RED-first check failed/);
  });
});

describe('retry idempotency (pacman4 forensic 2026-07-05)', () => {
  const boundAc = (id, testRef, over = {}) => ({ id, text: 't', testBinding: { status: 'bound', testRef }, ...over });
  const boundPayload = {
    ...payload,
    acceptanceCriteria: [
      boundAc('AC-1', 'src/game/rules.test.ts > rules > [AC-1] loseLife decrements'),
      boundAc('AC-2', 'src/components/canvas/HUDOverlay.test.tsx > HUD > [AC-2] shows lives'),
    ],
  };

  it('all ACs already bound + bindings RED → resumes with committed tests, NO spawn, owns derived files', async () => {
    let spawned = false;
    const r = await runTestAuthorPhase(deps({
      payload: boundPayload,
      spawnOnce: async () => { spawned = true; return { exitCode: 0, text: bindingText }; },
      runBindings: async () => ({ acceptanceCriteria: [], summary: { ran: 2, passed: 0, failed: 2 } }),
    }));
    expect(spawned).toBe(false);
    expect(r.resumed).toBe(true);
    expect(r.ownedTestFiles.sort()).toEqual([
      'src/components/canvas/HUDOverlay.test.tsx',
      'src/game/rules.test.ts',
    ]);
  });

  // pacman8 incident (2026-07-11): this case used to THROW 'retry-with-prior-work'
  // and the caller fell OPEN to the single-spawn dev — the implementer authored
  // its own tests. RED was already proven at the RED commit; a partially-green
  // retry resumes fix-forward against the SAME immutable tests (the completion
  // gate re-verifies every binding honestly, so this can never fake a pass).
  it('all ACs bound + a binding already PASSES (prior impl present) → still RESUMES, does NOT throw', async () => {
    let spawned = false;
    const r = await runTestAuthorPhase(deps({
      payload: boundPayload,
      spawnOnce: async () => { spawned = true; return { exitCode: 0, text: bindingText }; },
      runBindings: async () => ({ acceptanceCriteria: [], summary: { ran: 2, passed: 1, failed: 1 } }),
    }));
    expect(spawned).toBe(false);
    expect(r.resumed).toBe(true);
    expect(r.redSha).toBe('sha0'); // resume pins to the incoming head — no new RED commit
    expect(r.bindingOutput).toBe('');
    expect(r.boundCriteria).toBe(boundPayload.acceptanceCriteria);
    expect(r.ownedTestFiles.sort()).toEqual([
      'src/components/canvas/HUDOverlay.test.tsx',
      'src/game/rules.test.ts',
    ]);
  });

  it('PARTIALLY bound ACs still author fresh (no idempotency shortcut)', async () => {
    let spawned = false;
    const mixed = { ...payload, acceptanceCriteria: [boundAc('AC-1', 'src/a.test.ts > x'), { id: 'AC-2', text: 'unbound' }] };
    await runTestAuthorPhase(deps({
      payload: mixed,
      spawnOnce: async () => { spawned = true; return { exitCode: 0, text: bindingText }; },
    }));
    expect(spawned).toBe(true);
  });
});

// pacman1 (2026-07-13): the authored tests inline into the implementer prompt.
describe('buildImplementerPrompt — inline test contents', () => {
  it('renders inlined sources for files in testContents and keeps others list-only', () => {
    const p = buildImplementerPrompt(
      { title: 'T', acceptanceCriteria: [], touches: ['src/x.ts'] },
      ['src/a.test.ts', 'src/b.test.ts'],
      { 'src/a.test.ts': 'expect(1).toBe(1);' },
    );
    expect(p).toContain('## src/a.test.ts');
    expect(p).toContain('expect(1).toBe(1);');
    expect(p).toContain('- src/b.test.ts');
    expect(p).not.toContain('## src/b.test.ts');
  });

  it('omits the inline section entirely when no contents are provided (byte-stable legacy prompt shape)', () => {
    const p = buildImplementerPrompt({ title: 'T', acceptanceCriteria: [], touches: [] }, ['src/a.test.ts']);
    expect(p).not.toContain('inline (identical to the committed files');
  });
});
