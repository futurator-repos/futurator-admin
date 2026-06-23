import { describe, it, expect } from 'vitest';
import { routeVqaFailure, summarizeRoutes, VQA_ROUTE } from '../vqa-triage-router.mjs';

describe('routeVqaFailure — FL-1 deterministic routing', () => {
  it('routes SEAM_NEVER_PUBLISHED to a build (not a generic fix)', () => {
    const r = routeVqaFailure({ rationale: 'SEAM_NEVER_PUBLISHED: no source imports useGameStateMachine' });
    expect(r.route).toBe(VQA_ROUTE.DEV_BUILD);
    expect(r.routeClass).toBe('seam-not-mounted');
    expect(r.autoMint).toBe(true);
    expect(r.title).toMatch(/build the feature/i);
  });

  it('routes SEAM_ABSENT to a build', () => {
    expect(routeVqaFailure({ rationale: 'SEAM_ABSENT: window.__harness never published' }).route).toBe(
      VQA_ROUTE.DEV_BUILD,
    );
  });

  it('routes CONTRACT_INCOMPLETE to a build', () => {
    expect(routeVqaFailure({ rationale: 'CONTRACT_INCOMPLETE: L2 test has no flow' }).routeClass).toBe(
      'no-probe',
    );
  });

  it('routes FLOW_NOOP to re-author the interaction', () => {
    const r = routeVqaFailure({ rationale: 'FLOW_NOOP: frame identical to idle' });
    expect(r.route).toBe(VQA_ROUTE.REAUTHOR);
    expect(r.routeClass).toBe('flow-noop');
  });

  it('a structural prefix WINS over the LLM class', () => {
    const r = routeVqaFailure({ classification: 'ac-wording', rationale: 'SEAM_ABSENT: ...' });
    expect(r.route).toBe(VQA_ROUTE.DEV_BUILD);
  });

  it('falls back to the LLM class when no structural prefix is present', () => {
    expect(routeVqaFailure({ classification: 'code-bug', rationale: 'the score reads 0' }).route).toBe(
      VQA_ROUTE.DEV_FIX,
    );
    expect(routeVqaFailure({ classification: 'ac-wording', rationale: 'vague' }).autoMint).toBe(false);
    expect(routeVqaFailure({ classification: 'environment', rationale: 'boot' }).autoMint).toBe(false);
  });

  it('defaults to code-bug (dev-fix) when nothing matches', () => {
    expect(routeVqaFailure({}).route).toBe(VQA_ROUTE.DEV_FIX);
  });
});

describe('summarizeRoutes — bundle reduction', () => {
  it('a build dominates a code-fix in the same bundle', () => {
    const summary = summarizeRoutes([
      routeVqaFailure({ classification: 'code-bug', rationale: 'x' }),
      routeVqaFailure({ rationale: 'SEAM_NEVER_PUBLISHED: y' }),
    ]);
    expect(summary.route).toBe(VQA_ROUTE.DEV_BUILD);
    expect(summary.autoMint).toBe(true);
  });

  it('a bundle of ONLY operator/environment failures is not auto-mintable', () => {
    const summary = summarizeRoutes([
      routeVqaFailure({ classification: 'ac-wording', rationale: 'x' }),
      routeVqaFailure({ classification: 'environment', rationale: 'y' }),
    ]);
    expect(summary.autoMint).toBe(false);
  });

  it('one actionable failure makes the whole bundle auto-mintable', () => {
    const summary = summarizeRoutes([
      routeVqaFailure({ classification: 'ac-wording', rationale: 'x' }),
      routeVqaFailure({ classification: 'code-bug', rationale: 'y' }),
    ]);
    expect(summary.autoMint).toBe(true);
  });
});
