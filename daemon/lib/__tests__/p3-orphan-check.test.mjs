/**
 * p3-orphan-check.test.mjs — QA-Review W2 wiring check (assemble-must-import).
 * Fixtures are real files under a tmp dir (this is a filesystem scan, not a
 * graph query) so the static import/require/dynamic-import/re-export
 * extraction is proven against real source text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findOrphanModules } from '../p3-orphan-check.mjs';

let root;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'p3-orphan-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function writeGameModules(root) {
  mkdirSync(join(root, 'src', 'game'), { recursive: true });
  mkdirSync(join(root, 'src', 'app'), { recursive: true });
  writeFileSync(join(root, 'src', 'game', 'ghost-ai.ts'), 'export function ghostAI() { return 1; }\n');
  writeFileSync(join(root, 'src', 'game', 'reducer.ts'), 'export function reducer(s) { return s; }\n');
  writeFileSync(join(root, 'src', 'game', 'controls.ts'), 'export function controls() { return {}; }\n');
}

const BUILT = ['src/game/ghost-ai.ts', 'src/game/reducer.ts', 'src/game/controls.ts'];

describe('findOrphanModules — pacman3-shaped tree (nothing imported)', () => {
  it('flags all 3 built modules as orphans, blocking true', () => {
    writeGameModules(root);
    // The "assemble" file exists but imports NONE of the built modules — the
    // exact pacman3 disease (static preview shipped, feature never wired).
    writeFileSync(
      join(root, 'src', 'app', 'page.tsx'),
      "import React from 'react';\nexport default function Page() { return null; }\n",
    );
    const r = findOrphanModules({ appDir: root, builtModules: BUILT });
    expect(r.orphanModules.sort()).toEqual([...BUILT].sort());
    expect(r.blocking).toBe(true);
  });
});

describe('findOrphanModules — fully-wired tree', () => {
  it('empty orphans, blocking false when every built module is imported', () => {
    writeGameModules(root);
    writeFileSync(
      join(root, 'src', 'app', 'page.tsx'),
      [
        "import { ghostAI } from '../game/ghost-ai';",
        "export { controls } from '../game/controls';", // re-export counts as importer
        'export default async function Page() {',
        "  const { reducer } = await import('../game/reducer');", // dynamic import counts too
        '  return ghostAI() + reducer.length;',
        '}',
        '',
      ].join('\n'),
    );
    const r = findOrphanModules({ appDir: root, builtModules: BUILT });
    expect(r.orphanModules).toEqual([]);
    expect(r.blocking).toBe(false);
  });

  it('dynamic import() alone is sufficient to count as an importer', () => {
    writeGameModules(root);
    writeFileSync(
      join(root, 'src', 'app', 'page.tsx'),
      "export default async function Page() {\n  await import('../game/reducer');\n  return null;\n}\n",
    );
    const r = findOrphanModules({ appDir: root, builtModules: ['src/game/reducer.ts'] });
    expect(r.orphanModules).toEqual([]);
    expect(r.blocking).toBe(false);
  });

  it('a bare re-export ("export { x } from ...") alone counts as an importer', () => {
    writeGameModules(root);
    writeFileSync(join(root, 'src', 'app', 'page.tsx'), "export { controls } from '../game/controls';\n");
    const r = findOrphanModules({ appDir: root, builtModules: ['src/game/controls.ts'] });
    expect(r.orphanModules).toEqual([]);
    expect(r.blocking).toBe(false);
  });
});

describe('findOrphanModules — partial wiring', () => {
  it('only the un-imported built module is reported, the wired ones are not', () => {
    writeGameModules(root);
    writeFileSync(
      join(root, 'src', 'app', 'page.tsx'),
      "import { ghostAI } from '../game/ghost-ai';\nexport default function Page() { return ghostAI(); }\n",
    );
    const r = findOrphanModules({ appDir: root, builtModules: BUILT });
    expect(r.orphanModules).toEqual(['src/game/controls.ts', 'src/game/reducer.ts']);
    expect(r.blocking).toBe(true);
  });
});

describe('findOrphanModules — fail-open honesty contract', () => {
  it('a thrown scan error degrades to empty + non-blocking, never a false block', () => {
    // A non-string appDir makes node:path `join()` throw synchronously inside
    // the try block — proving the outer catch fail-opens rather than
    // propagating or fake-passing.
    const r = findOrphanModules({ appDir: 123, builtModules: BUILT });
    expect(r).toEqual({ orphanModules: [], blocking: false });
  });

  it('no builtModules given → empty, non-blocking (nothing to judge)', () => {
    expect(findOrphanModules({ appDir: root, builtModules: [] })).toEqual({
      orphanModules: [],
      blocking: false,
    });
  });

  it('empty/missing src tree → empty, non-blocking (nothing to scan)', () => {
    const r = findOrphanModules({ appDir: root, builtModules: BUILT });
    expect(r).toEqual({ orphanModules: [], blocking: false });
  });
});

describe('isFrameworkEntry exemption (review fix #10)', () => {
  it('exempts Next App Router + entry files that framework loads (0 src importers by design)', () => {
    const root2 = mkdtempSync(join(tmpdir(), 'p3-orphan-fw-'));
    mkdirSync(join(root2, 'src', 'app'), { recursive: true });
    // page.tsx is built by the assemble story and has no src importer — but it's
    // a framework entry, NOT an orphan.
    writeFileSync(join(root2, 'src', 'app', 'page.tsx'), 'export default function Page(){return null}\n');
    writeFileSync(join(root2, 'src', 'main.tsx'), 'console.log("entry")\n');
    const r = findOrphanModules({ appDir: root2, builtModules: ['src/app/page.tsx', 'src/main.tsx'] });
    expect(r.orphanModules).toEqual([]);
    expect(r.blocking).toBe(false);
    rmSync(root2, { recursive: true, force: true });
  });
})

describe('test-file importers do not mask a runtime orphan (pacman3 disease)', () => {
  it('flags a module imported ONLY by its own test as a runtime orphan', () => {
    const r3 = mkdtempSync(join(tmpdir(), 'p3-orphan-test-'));
    mkdirSync(join(r3, 'src', 'game'), { recursive: true });
    writeFileSync(join(r3, 'src', 'game', 'ghost-ai.ts'), 'export function ghostAI(){return 1}\n');
    // Only the TEST imports it — nothing in the app does → runtime orphan.
    writeFileSync(join(r3, 'src', 'game', 'ghost-ai.test.ts'), "import { ghostAI } from './ghost-ai';\nghostAI();\n");
    writeFileSync(join(r3, 'src', 'app.ts'), 'export const app = 1;\n');
    const r = findOrphanModules({ appDir: r3, builtModules: ['src/game/ghost-ai.ts'] });
    expect(r.orphanModules).toEqual(['src/game/ghost-ai.ts']);
    expect(r.blocking).toBe(true);
    rmSync(r3, { recursive: true, force: true });
  });
})
