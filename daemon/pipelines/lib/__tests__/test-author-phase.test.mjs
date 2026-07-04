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
  });

  it('throws on a non-zero test-author spawn (→ caller fails open)', async () => {
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

  it('all ACs already bound + bindings RED → reuses committed tests, NO spawn, owns derived files', async () => {
    let spawned = false;
    const r = await runTestAuthorPhase(deps({
      payload: boundPayload,
      spawnOnce: async () => { spawned = true; return { exitCode: 0, text: bindingText }; },
      runBindings: async () => ({ acceptanceCriteria: [], summary: { ran: 2, passed: 0, failed: 2 } }),
    }));
    expect(spawned).toBe(false);
    expect(r.ownedTestFiles.sort()).toEqual([
      'src/components/canvas/HUDOverlay.test.tsx',
      'src/game/rules.test.ts',
    ]);
  });

  it('all ACs bound but a binding already PASSES (leftover impl) → throws the distinct retry reason', async () => {
    await expect(runTestAuthorPhase(deps({
      payload: boundPayload,
      runBindings: async () => ({ acceptanceCriteria: [], summary: { ran: 2, passed: 1, failed: 1 } }),
    }))).rejects.toThrow(/retry-with-prior-work/);
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
