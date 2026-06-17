/**
 * semantic-extract.test.mjs — ts-morph cross-file CALLS resolution.
 */

import { describe, it, expect } from 'vitest';
import { Project, SyntaxKind } from 'ts-morph';
import { extractSemanticCalls, funcNodeIdFor, fileNodeIdFor } from '../semantic-extract.mjs';

function projectWith(files) {
  const p = new Project({ useInMemoryFileSystem: true });
  for (const [path, src] of Object.entries(files)) p.createSourceFile(path, src);
  return p;
}

describe('node-id helpers match graph-sync scheme', () => {
  it('builds file + function ids the same way graph-sync does', () => {
    expect(fileNodeIdFor('src/game/scoring.ts')).toBe('code/src--game--scoring.ts');
    expect(funcNodeIdFor('src/game/scoring.ts', 'loseLife')).toBe(
      'code/src--game--scoring.ts#function:loseLife',
    );
  });
});

describe('extractSemanticCalls', () => {
  it('resolves a CROSS-FILE call through an import to a precise CALLS edge', () => {
    const project = projectWith({
      '/src/util.ts': 'export function helper() { return 1; }',
      '/src/main.ts': 'import { helper } from "./util";\nexport function run() { return helper(); }',
    });
    const edges = extractSemanticCalls(project, '/', SyntaxKind);
    expect(edges).toContainEqual({
      type: 'CALLS',
      source: 'code/src--main.ts#function:run',
      target: 'code/src--util.ts#function:helper',
    });
  });

  it('resolves arrow-function callees named by their variable', () => {
    const project = projectWith({
      '/src/a.ts': 'export const compute = () => 42;',
      '/src/b.ts': 'import { compute } from "./a";\nexport function go() { return compute(); }',
    });
    const edges = extractSemanticCalls(project, '/', SyntaxKind);
    expect(edges).toContainEqual({
      type: 'CALLS',
      source: 'code/src--b.ts#function:go',
      target: 'code/src--a.ts#function:compute',
    });
  });

  it('ignores calls with no enclosing function and external/unresolved callees', () => {
    const project = projectWith({
      '/src/top.ts': 'import { helper } from "./util";\nhelper();\nexport function f() { console.log("x"); }',
      '/src/util.ts': 'export function helper() {}',
    });
    const edges = extractSemanticCalls(project, '/', SyntaxKind);
    // module-scope helper() → skipped (no caller); console.log → unresolved/external
    expect(edges).toEqual([]);
  });

  it('does not emit self-edges', () => {
    const project = projectWith({
      '/src/rec.ts': 'export function loop() { return loop(); }',
    });
    const edges = extractSemanticCalls(project, '/', SyntaxKind);
    expect(edges).toEqual([]);
  });
});
