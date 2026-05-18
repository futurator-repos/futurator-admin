import { describe, it, expect } from 'vitest';
import { deriveScope, formatScopeLabel } from '../use-free-agent-scope';

function sp(...pairs: Array<[string, string]>): URLSearchParams {
  const p = new URLSearchParams();
  for (const [k, v] of pairs) p.set(k, v);
  return p;
}

describe('deriveScope (AC #4 route rules)', () => {
  it('maps /labs/projects/:id → project scope', () => {
    expect(deriveScope('/labs/projects/dino-7', sp())).toEqual({
      kind: 'project',
      id: 'dino-7',
    });
  });

  it('maps /labs/party/:id → project scope', () => {
    expect(deriveScope('/labs/party/songster', sp())).toEqual({
      kind: 'project',
      id: 'songster',
    });
  });

  it('maps /labs/plans/:id → plan scope', () => {
    expect(deriveScope('/labs/plans/plan-abc', sp())).toEqual({
      kind: 'plan',
      id: 'plan-abc',
    });
  });

  it('maps /labs?planId=... → plan scope', () => {
    expect(deriveScope('/labs', sp(['planId', 'plan-xyz']))).toEqual({
      kind: 'plan',
      id: 'plan-xyz',
    });
  });

  it('maps /labs?appId=... → app scope', () => {
    expect(deriveScope('/labs', sp(['appId', 'snake-4']))).toEqual({
      kind: 'app',
      id: 'snake-4',
    });
  });

  it('prefers appId over planId when both are present on /labs (real bare repo wins)', () => {
    // Regression guard: the user's URL admin.futurator.ai/labs?appId=snake-4&planId=plan_…
    // was previously deriving plan scope → projectId '_plan' → no bare repo on disk →
    // daemon's ensureWorktree threw WORKTREE_FAILURE. App scope gives projectId='snake-4'
    // which the Pipeline v2 bootstrap actually creates on EC2.
    expect(deriveScope('/labs', sp(['appId', 'snake-4'], ['planId', 'plan_snake-4_xyz']))).toEqual({
      kind: 'app',
      id: 'snake-4',
    });
  });

  it('maps /apps/:id → app scope', () => {
    expect(deriveScope('/apps/my-app', sp())).toEqual({ kind: 'app', id: 'my-app' });
  });

  it('falls back to workspace for unknown routes', () => {
    expect(deriveScope('/settings', sp())).toEqual({ kind: 'workspace' });
    expect(deriveScope('/', sp())).toEqual({ kind: 'workspace' });
    expect(deriveScope('/reports', sp())).toEqual({ kind: 'workspace' });
  });

  it('handles trailing slashes (trailingSlash: true export)', () => {
    expect(deriveScope('/labs/projects/dino-7/', sp())).toEqual({
      kind: 'project',
      id: 'dino-7',
    });
  });

  it('prioritizes project route over planId query (defensive ordering)', () => {
    expect(deriveScope('/labs/projects/dino-7', sp(['planId', 'plan-abc']))).toEqual({
      kind: 'project',
      id: 'dino-7',
    });
  });

  it('ignores planId on routes other than /labs', () => {
    expect(deriveScope('/reports', sp(['planId', 'plan-abc']))).toEqual({
      kind: 'workspace',
    });
  });
});

describe('formatScopeLabel', () => {
  it('formats workspace scope', () => {
    expect(formatScopeLabel({ kind: 'workspace' })).toBe('Workspace');
  });

  it('formats project scope with id', () => {
    expect(formatScopeLabel({ kind: 'project', id: 'dino-7' })).toBe('Project: dino-7');
  });

  it('formats plan scope with id', () => {
    expect(formatScopeLabel({ kind: 'plan', id: 'plan-abc' })).toBe('Plan: plan-abc');
  });

  it('formats app scope with id', () => {
    expect(formatScopeLabel({ kind: 'app', id: 'my-app' })).toBe('App: my-app');
  });

  it('falls back to "?" when id is missing on non-workspace scope', () => {
    expect(formatScopeLabel({ kind: 'plan' })).toBe('Plan: ?');
  });
});
