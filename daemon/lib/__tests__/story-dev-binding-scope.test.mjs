// story-dev-binding-scope.test.mjs — R2 (fix-round 2026-07-18): binding-scope
// widening + the de-gamed implementer prompt builders.
//
// Run with the project-standard command (same contract as agentic-vqa-runner):
//   node --test lib/__tests__/story-dev-binding-scope.test.mjs
//
// PURE assertions only — the widening helper takes an INJECTED fs (readFile /
// exists), and the prompt builders are pure over their inputs. No spawn, no disk.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  extractRelativeImports,
  computeBindingScopeWidening,
  isBrowserVerifiedAc,
  renderBrowserVerifiedAcsBlock,
  renderOwnTestScopeBlock,
  buildImplementerGuidance,
} from '../../pipelines/story-dev-pipeline.mjs';

// ── extractRelativeImports ─────────────────────────────────────────────────────

test('extractRelativeImports: captures relative import/require/dynamic, ignores bare specifiers', () => {
  const src = [
    `import { renderSnake } from '../../game/snake/contract';`,
    `import './side-effect';`,
    `const x = require('./local-cjs');`,
    `const y = await import('../lazy/mod');`,
    `import React from 'react';`, // bare — ignored
    `import { z } from '@/aliased';`, // alias — ignored (not ./ or ../)
  ].join('\n');
  const rel = extractRelativeImports(src).sort();
  assert.deepEqual(rel, [
    '../../game/snake/contract',
    '../lazy/mod',
    './local-cjs',
    './side-effect',
  ]);
});

// ── computeBindingScopeWidening ────────────────────────────────────────────────

test('binding-scope: an outside-touches to-be-created impl import widens touches', () => {
  // The defect-#2 shape: the test lives in src/components/canvas/ (the only
  // touch), but binds a symbol in src/game/snake/contract.ts which does not exist
  // yet — the implementer has no legal file to green it until touches widen.
  const testFile = 'src/components/canvas/snake.test.ts';
  const readFile = (p) => {
    assert.equal(p, testFile);
    return `import { renderSnake } from '../../game/snake/contract';`;
  };
  const exists = () => false; // contract.* not on disk → to-be-created
  const widen = computeBindingScopeWidening({
    ownedTestFiles: [testFile],
    touches: ['src/components/canvas/**'],
    readFile,
    exists,
  });
  assert.deepEqual(widen, ['src/game/snake/contract.*']);
});

test('binding-scope: an import that already resolves to a file on disk is NOT widened', () => {
  const testFile = 'src/game/snake/step.test.ts';
  const readFile = () => `import { movement } from './movement';`;
  // ./movement resolves to src/game/snake/movement.ts (exists) → read-only dep.
  const exists = (p) => p === 'src/game/snake/movement.ts';
  const widen = computeBindingScopeWidening({
    ownedTestFiles: [testFile],
    touches: ['src/components/**'],
    readFile,
    exists,
  });
  assert.deepEqual(widen, []);
});

test('binding-scope: an import already covered by touches is NOT widened', () => {
  const testFile = 'src/game/snake/step.test.ts';
  const readFile = () => `import { renderSnake } from './contract';`;
  const exists = () => false; // to-be-created…
  // …but ./contract → src/game/snake/contract.* is already inside touches.
  const widen = computeBindingScopeWidening({
    ownedTestFiles: [testFile],
    touches: ['src/game/snake/**'],
    readFile,
    exists,
  });
  assert.deepEqual(widen, []);
});

test('binding-scope: an explicit extension in the specifier is preserved verbatim', () => {
  const testFile = 'src/a/t.test.ts';
  const readFile = () => `import data from '../fixtures/seed.json';`;
  const exists = () => false;
  const widen = computeBindingScopeWidening({
    ownedTestFiles: [testFile],
    touches: ['src/a/**'],
    readFile,
    exists,
  });
  // .json is not a code ext (CODE_EXT_RE) so it is treated as a bare base → base.*
  assert.deepEqual(widen, ['src/fixtures/seed.json.*']);
});

test('binding-scope: widening is de-duped and CAPPED at 4', () => {
  const testFile = 'src/z/big.test.ts';
  const readFile = () =>
    [
      `import a from '../mods/a';`,
      `import b from '../mods/b';`,
      `import a2 from '../mods/a';`, // duplicate of a → deduped
      `import c from '../mods/c';`,
      `import d from '../mods/d';`,
      `import e from '../mods/e';`, // 5th distinct → dropped by the cap
    ].join('\n');
  const exists = () => false;
  const widen = computeBindingScopeWidening({
    ownedTestFiles: [testFile],
    touches: ['src/z/**'],
    readFile,
    exists,
  });
  assert.equal(widen.length, 4);
  assert.deepEqual(widen, [
    'src/mods/a.*',
    'src/mods/b.*',
    'src/mods/c.*',
    'src/mods/d.*',
  ]);
});

test('binding-scope: an unreadable owned test file is skipped, never throws', () => {
  const widen = computeBindingScopeWidening({
    ownedTestFiles: ['src/gone.test.ts'],
    touches: ['src/**'],
    readFile: () => { throw new Error('ENOENT'); },
    exists: () => false,
  });
  assert.deepEqual(widen, []);
});

// ── isBrowserVerifiedAc ────────────────────────────────────────────────────────

test('isBrowserVerifiedAc: behavior / needsBrowser / requiresBrowser are browser-verified; state is not', () => {
  assert.equal(isBrowserVerifiedAc({ verify: 'behavior' }), true);
  assert.equal(isBrowserVerifiedAc({ needsBrowser: true }), true);
  assert.equal(isBrowserVerifiedAc({ requiresBrowser: true }), true);
  assert.equal(isBrowserVerifiedAc({ verify: 'state' }), false);
  assert.equal(isBrowserVerifiedAc({}), false);
});

// ── renderBrowserVerifiedAcsBlock ──────────────────────────────────────────────

const BROWSER_ACS = [
  {
    id: 'ac3',
    text: 'arrow keys steer the snake',
    verify: 'behavior',
    when: 'presses ArrowUp',
    thenObservable: 'the snake head moves up one cell',
  },
  { id: 'ac9', text: 'pure score math', verify: 'state' }, // NOT browser
];

test('renderBrowserVerifiedAcsBlock: enumerates browser ACs with the "units do not cover" framing', () => {
  const block = renderBrowserVerifiedAcsBlock(BROWSER_ACS, null);
  assert.match(block, /BROWSER-VERIFIED ACCEPTANCE CRITERIA/);
  assert.match(block, /green unit tests DO NOT cover these/i);
  assert.match(block, /wire each behavior into the running app/);
  assert.match(block, /\[ac3\] arrow keys steer the snake/);
  assert.match(block, /when: presses ArrowUp → then: the snake head moves up one cell/);
  // The pure-state AC must NOT be listed as a browser obligation.
  assert.doesNotMatch(block, /ac9/);
  // No prior transcript on the first attempt.
  assert.doesNotMatch(block, /PRIOR PROBE/);
});

test('renderBrowserVerifiedAcsBlock: no browser ACs → empty string (byte-identical prompt)', () => {
  assert.equal(renderBrowserVerifiedAcsBlock([{ id: 'a', verify: 'state' }], null), '');
  assert.equal(renderBrowserVerifiedAcsBlock([], null), '');
});

test('renderBrowserVerifiedAcsBlock: threads the prior attempt probe transcript for a failed browser AC', () => {
  const priorCompletion = {
    acceptanceCriteria: [
      {
        id: 'ac3',
        testBinding: {
          testKind: 'browser',
          status: 'failing',
          detail: 'probe: pressed ArrowUp; snake head stayed at (7,10) — never moved',
        },
      },
    ],
  };
  const block = renderBrowserVerifiedAcsBlock(BROWSER_ACS, priorCompletion);
  assert.match(block, /PRIOR PROBE — attempt failed \(status: failing\)/);
  assert.match(block, /snake head stayed at \(7,10\) — never moved/);
});

test('renderBrowserVerifiedAcsBlock: a passing prior binding is NOT rendered as a failure', () => {
  const priorCompletion = {
    acceptanceCriteria: [{ id: 'ac3', testBinding: { status: 'passing' } }],
  };
  const block = renderBrowserVerifiedAcsBlock(BROWSER_ACS, priorCompletion);
  assert.doesNotMatch(block, /PRIOR PROBE/);
});

// ── renderOwnTestScopeBlock ────────────────────────────────────────────────────

test('renderOwnTestScopeBlock: names the exact owned tests and declares sibling RED expected', () => {
  const block = renderOwnTestScopeBlock(['src/game/snake/step.test.ts', 'src/game/snake/turn.test.ts']);
  assert.match(block, /SELF-VERIFICATION SCOPE/);
  assert.match(block, /- src\/game\/snake\/step\.test\.ts/);
  assert.match(block, /- src\/game\/snake\/turn\.test\.ts/);
  assert.match(block, /npx vitest run "src\/game\/snake\/step\.test\.ts" "src\/game\/snake\/turn\.test\.ts"/);
  assert.match(block, /sibling stories/);
  assert.match(block, /WILL fail, and that is EXPECTED/);
  assert.match(block, /Do NOT investigate, "fix", or modify them/);
});

test('renderOwnTestScopeBlock: no owned files → empty string', () => {
  assert.equal(renderOwnTestScopeBlock([]), '');
  assert.equal(renderOwnTestScopeBlock(), '');
});

// ── buildImplementerGuidance (composition) ─────────────────────────────────────

test('buildImplementerGuidance: composes browser-AC + own-test-scope, prior transcript on attempt 2', () => {
  const priorCompletion = {
    acceptanceCriteria: [
      { id: 'ac3', testBinding: { status: 'failing', detail: 'snake did not move' } },
    ],
  };
  // attempt 1 shape (no prior completion)
  const attempt1 = buildImplementerGuidance({
    acceptanceCriteria: BROWSER_ACS,
    ownedTestFiles: ['src/game/snake/step.test.ts'],
    priorCompletion: null,
  });
  assert.match(attempt1, /BROWSER-VERIFIED ACCEPTANCE CRITERIA/);
  assert.match(attempt1, /SELF-VERIFICATION SCOPE/);
  assert.doesNotMatch(attempt1, /PRIOR PROBE/);

  // attempt 2 shape (prior completion supplied)
  const attempt2 = buildImplementerGuidance({
    acceptanceCriteria: BROWSER_ACS,
    ownedTestFiles: ['src/game/snake/step.test.ts'],
    priorCompletion,
  });
  assert.match(attempt2, /PRIOR PROBE/);
  assert.match(attempt2, /snake did not move/);
});

test('buildImplementerGuidance: nothing to add (pure-unit story, no owned files) → empty string', () => {
  assert.equal(
    buildImplementerGuidance({
      acceptanceCriteria: [{ id: 'a', verify: 'state' }],
      ownedTestFiles: [],
      priorCompletion: null,
    }),
    '',
  );
});
