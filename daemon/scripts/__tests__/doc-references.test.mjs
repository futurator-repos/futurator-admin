/**
 * doc-references.test.mjs — wikilink → edge extraction + living-doc gating.
 */

import { describe, it, expect } from 'vitest';
import {
  extractWikilinks,
  isLivingDoc,
  PLAN_SCOPED_TYPES,
} from '../lib/doc-references.mjs';

describe('isLivingDoc', () => {
  it('treats architecture / component / decision / index / system docs as alive', () => {
    expect(isLivingDoc({ type: 'decision' }, 'decisions/ghost-ai')).toBe(true);
    expect(isLivingDoc({ type: 'architecture' }, 'system/architecture')).toBe(true);
    expect(isLivingDoc({ type: 'component' }, 'code/src--x.tsx')).toBe(true);
    expect(isLivingDoc({ type: 'index' }, 'index')).toBe(true);
    expect(isLivingDoc({ type: 'system' }, 'system/dependency-map')).toBe(true);
    expect(isLivingDoc({ type: 'code' }, 'code/src--y.ts')).toBe(true);
  });

  it('excludes plan-run docs by type', () => {
    for (const t of PLAN_SCOPED_TYPES) {
      expect(isLivingDoc({ type: t }, `doc/${t}`)).toBe(false);
    }
  });

  it('excludes docs carrying an explicit plan marker or plan path', () => {
    expect(isLivingDoc({ type: 'decision', planId: 'plan_abc' }, 'decisions/x')).toBe(false);
    expect(isLivingDoc({ type: 'note', scope: 'plan' }, 'notes/x')).toBe(false);
    expect(isLivingDoc({ type: 'decision' }, 'plans/plan_abc/prd')).toBe(false);
    expect(isLivingDoc({ type: 'spec' }, 'epics/e1')).toBe(false);
  });

  it('a story-authored decision is still living (decided_by is not a plan marker)', () => {
    expect(
      isLivingDoc(
        { type: 'decision', decided_by: 'DEV @story 9ffa2c51' },
        'decisions/ghost-pathfinding-greedy',
      ),
    ).toBe(true);
  });
});

describe('extractWikilinks — structured section edges (unchanged behavior)', () => {
  it('maps a ## Dependencies link to DEPENDS_ON regardless of inlineRefs', () => {
    const body = '## Dependencies\n- [[code/src--util.ts]] — imported as util';
    for (const inlineRefs of [false, true]) {
      const edges = extractWikilinks(body, { inlineRefs });
      expect(edges).toContainEqual({
        type: 'DEPENDS_ON',
        direction: 'outgoing',
        weight: 1.0,
        target: 'code/src--util.ts',
      });
    }
  });
});

describe('extractWikilinks — inline REFERENCES (living docs only)', () => {
  const decision =
    '## Decision\nUse greedy.\n\n## Implementation\n' +
    'Implemented in [[code/src--game--ai--ghostAI.ts]] via `moveTowardTarget()`.\n';

  it('emits REFERENCES for a prose [[link]] when inlineRefs is on', () => {
    const edges = extractWikilinks(decision, { inlineRefs: true });
    expect(edges).toContainEqual({
      type: 'REFERENCES',
      direction: 'outgoing',
      weight: 0.2,
      target: 'code/src--game--ai--ghostAI.ts',
    });
  });

  it('emits NOTHING for the same prose link when inlineRefs is off (plan docs)', () => {
    expect(extractWikilinks(decision, { inlineRefs: false })).toEqual([]);
  });

  it('captures links under an H1 section (index.md style)', () => {
    const index = '# Code Articles\n- [[code/src--a.ts]] — a\n- [[code/src--b.ts]] — b\n';
    const edges = extractWikilinks(index, { inlineRefs: true });
    expect(edges.map((e) => e.target).sort()).toEqual(['code/src--a.ts', 'code/src--b.ts']);
    expect(edges.every((e) => e.type === 'REFERENCES')).toBe(true);
  });

  it('does not double-link: a structured target is not also a REFERENCES', () => {
    const body =
      '## Dependencies\n- [[code/src--util.ts]]\n\n## Notes\nsee [[code/src--util.ts]] again\n';
    const edges = extractWikilinks(body, { inlineRefs: true });
    const toUtil = edges.filter((e) => e.target === 'code/src--util.ts');
    expect(toUtil).toHaveLength(1);
    expect(toUtil[0].type).toBe('DEPENDS_ON');
  });

  it('resolves [[id|alias]] to the bare id and dedupes repeats', () => {
    const body = '## Notes\n[[code/src--x.ts|the X module]] and again [[code/src--x.ts]]\n';
    const edges = extractWikilinks(body, { inlineRefs: true });
    expect(edges).toEqual([
      { type: 'REFERENCES', direction: 'outgoing', weight: 0.2, target: 'code/src--x.ts' },
    ]);
  });
});
