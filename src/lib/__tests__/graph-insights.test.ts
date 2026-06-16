/**
 * graph-insights tests — pacman1 UX pass (2026-06-12).
 */

import { describe, expect, it } from 'vitest';
import {
  articleUrl,
  centralityRadius,
  communityColor,
  COMMUNITY_PALETTE,
  computeCoverage,
  computeIsolated,
  hasArticle,
  integrityHeadline,
  maxCentrality,
  type ArchInsights,
  type OrphanReport,
} from '../graph-insights';

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

describe('integrityHeadline (Epic 2 — orphan-invariant status)', () => {
  const base: OrphanReport = {
    projectId: 'futurator-admin',
    generatedAt: '2026-06-16T00:00:00Z',
    status: 'pass',
    orphanCount: 0,
    hardFailCount: 0,
    byKind: {},
    orphans: [],
    hardFail: [],
  };

  it('reports unknown when no report exists', () => {
    expect(integrityHeadline(null).tone).toBe('unknown');
  });

  it('reports pass when status is pass', () => {
    const h = integrityHeadline({ ...base, status: 'pass' });
    expect(h.tone).toBe('pass');
    expect(h.label).toMatch(/pass/i);
  });

  it('reports fail with the hard-fail count when an extractor dropped an edge', () => {
    const h = integrityHeadline({
      ...base,
      status: 'fail',
      hardFailCount: 2,
      hardFail: [
        { id: 'infra/lambda/Api', kind: 'lambda' },
        { id: 'endpoint/GET /x', kind: 'endpoint' },
      ],
    });
    expect(h.tone).toBe('fail');
    expect(h.label).toContain('2');
    expect(h.detail).toMatch(/wave gate/i);
  });
});

describe('Epic 3 — architectural X-ray helpers', () => {
  it('communityColor cycles the color-blind-safe palette and is neutral when unassigned', () => {
    expect(communityColor(0)).toBe(COMMUNITY_PALETTE[0]);
    expect(communityColor(COMMUNITY_PALETTE.length)).toBe(COMMUNITY_PALETTE[0]); // wraps
    expect(communityColor(null)).toBe('#64748b');
    // stable: same community → same color across calls
    expect(communityColor(3)).toBe(communityColor(3));
  });

  it('centralityRadius scales with centrality and floors at base', () => {
    expect(centralityRadius(0, 1, 4)).toBe(4); // no centrality → base
    expect(centralityRadius(null, 1, 4)).toBe(4);
    expect(centralityRadius(1, 0, 4)).toBe(4); // no max → base (avoid /0)
    expect(centralityRadius(1, 1, 4)).toBeGreaterThan(4); // max-centrality node is biggest
    expect(centralityRadius(0.5, 1, 4)).toBeLessThan(centralityRadius(1, 1, 4));
  });

  it('maxCentrality finds the run maximum (0 when none / null insights)', () => {
    expect(maxCentrality(null)).toBe(0);
    const insights = {
      nodeMetrics: {
        a: { centrality: 0.2, community: 0 },
        b: { centrality: 0.9, community: 1 },
        c: { centrality: null, community: 1 },
      },
    } as unknown as ArchInsights;
    expect(maxCentrality(insights)).toBe(0.9);
  });
});
