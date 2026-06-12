/**
 * graph-insights tests — pacman1 UX pass (2026-06-12).
 */

import { describe, expect, it } from 'vitest';
import { articleUrl, computeCoverage, computeIsolated, hasArticle } from '../graph-insights';

const fileWithArticle = {
  id: 'code/src--game--maze.ts',
  kind: 'file',
  summary: 'Renders the maze grid.',
  maturity: 2,
};
const fileNoArticle = { id: 'code/src--app--layout.tsx', kind: 'file', summary: '', maturity: 0 };
const fn = { id: 'code/src--game--maze.ts#function:drawMaze', kind: 'function' };

describe('coverage', () => {
  it('counts files, articles, functions and the coverage pct', () => {
    const c = computeCoverage([fileWithArticle, fileNoArticle, fn]);
    expect(c).toMatchObject({ files: 2, filesWithArticle: 1, functions: 1, coveragePct: 50 });
  });

  it('hasArticle is summary OR maturity driven', () => {
    expect(hasArticle(fileWithArticle)).toBe(true);
    expect(hasArticle(fileNoArticle)).toBe(false);
    expect(hasArticle({ id: 'x', maturity: 1 })).toBe(true);
  });
});

describe('isolated nodes', () => {
  it('classifies isolation reasons and skips connected nodes', () => {
    const nodes = [fileWithArticle, fileNoArticle, fn, { id: 'code/src--linked.ts', kind: 'file' }];
    const edges = [
      { source: 'code/src--linked.ts', target: 'code/src--game--maze.ts', type: 'IMPORTS' },
    ];
    const iso = computeIsolated(nodes, edges);
    const byId = new Map(iso.map((i) => [i.node.id, i.reason]));
    // linked + maze are connected by the edge.
    expect(byId.has('code/src--linked.ts')).toBe(false);
    expect(byId.has('code/src--game--maze.ts')).toBe(false);
    expect(byId.get('code/src--app--layout.tsx')).toBe('unreferenced-file');
    expect(byId.get(fn.id)).toBe('detached-function');
  });

  it('files sort before detached functions (actionable first)', () => {
    const iso = computeIsolated([fn, fileNoArticle], []);
    expect(iso[0].node.id).toBe(fileNoArticle.id);
  });
});

describe('articleUrl', () => {
  it('builds the knowledge-live URL for article-bearing file nodes only', () => {
    expect(articleUrl('https://x/knowledge-live', 'pacman1', fileWithArticle)).toBe(
      'https://x/knowledge-live/pacman1/code/src--game--maze.ts.md',
    );
    expect(articleUrl('https://x/knowledge-live', 'pacman1', fileNoArticle)).toBeNull();
    expect(articleUrl('https://x/knowledge-live', 'pacman1', { ...fn, summary: 'doc' })).toBeNull();
  });
});
