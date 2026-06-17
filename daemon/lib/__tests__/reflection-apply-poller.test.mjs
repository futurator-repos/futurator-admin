/**
 * reflection-apply-poller.test.mjs — Skills Institution, Story 1.2 (2026-06-17).
 *
 * Pure tick logic: paused short-circuit, apply confirmed rows, idempotency
 * (skip already-applied), missing-working-dir skip WITHOUT stamping, and
 * outcome→stamp mapping (applied/failed/deferred).
 */

import { describe, it, expect, vi } from 'vitest';
import { runReflectionApplyTick } from '../reflection-apply-poller.mjs';

function row(over = {}) {
  return {
    projectSlug: 'songster',
    id: 'refl-1',
    target: 'project-skill',
    action: 'create',
    skillName: 'plan-retry',
    content: '# Plan retry\n\nbody',
    status: 'confirmed',
    ...over,
  };
}

function deps(over = {}) {
  return {
    isPaused: vi.fn(async () => false),
    listConfirmed: vi.fn(async () => [row()]),
    resolveWorkingDir: vi.fn(() => '/projects/songster'),
    applyReflection: vi.fn(async () => ({ status: 'applied', target: 'project-skill', commitSha: 'deadbeefcafe' })),
    markApplied: vi.fn(async () => null),
    log: () => {},
    ...over,
  };
}

describe('runReflectionApplyTick', () => {
  it('short-circuits when paused', async () => {
    const d = deps({ isPaused: vi.fn(async () => true) });
    const r = await runReflectionApplyTick(d);
    expect(r.reason).toBe('paused');
    expect(d.listConfirmed).not.toHaveBeenCalled();
    expect(d.applyReflection).not.toHaveBeenCalled();
  });

  it('applies a confirmed row and stamps the landing record', async () => {
    const d = deps();
    const r = await runReflectionApplyTick(d);
    expect(r.applied).toBe(1);
    expect(d.applyReflection).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/projects/songster', projectSlug: 'songster' }),
    );
    expect(d.markApplied).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'refl-1', outcome: 'applied', commitSha: 'deadbeefcafe' }),
    );
  });

  it('skips a row already carrying appliedAt (idempotency)', async () => {
    const d = deps({ listConfirmed: vi.fn(async () => [row({ appliedAt: '2026-06-17T00:00:00Z' })]) });
    const r = await runReflectionApplyTick(d);
    expect(r.skipped).toBe(1);
    expect(d.applyReflection).not.toHaveBeenCalled();
    expect(d.markApplied).not.toHaveBeenCalled();
  });

  it('skips WITHOUT stamping when the working dir is not checked out', async () => {
    const d = deps({ resolveWorkingDir: vi.fn(() => null) });
    const r = await runReflectionApplyTick(d);
    expect(r.skipped).toBe(1);
    expect(d.applyReflection).not.toHaveBeenCalled();
    expect(d.markApplied).not.toHaveBeenCalled(); // crucial: retried next tick
  });

  it('stamps a quarantine/failure so it is not retried forever', async () => {
    const d = deps({
      applyReflection: vi.fn(async () => ({
        status: 'failed',
        reason: 'gate1-quarantined',
        scanReport: { securityStatus: 'quarantined', patternsHit: [] },
      })),
    });
    const r = await runReflectionApplyTick(d);
    expect(r.failed).toBe(1);
    expect(d.markApplied).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', error: 'gate1-quarantined' }),
    );
  });

  it('stamps a deferred outcome (promote-from-project not wired)', async () => {
    const d = deps({
      applyReflection: vi.fn(async () => ({ status: 'deferred', reason: 'promote needs skill-proposals' })),
    });
    const r = await runReflectionApplyTick(d);
    expect(r.deferred).toBe(1);
    expect(d.markApplied).toHaveBeenCalledWith(expect.objectContaining({ outcome: 'deferred' }));
  });

  it('treats an applyReflection throw as a stamped failure (tick never crashes)', async () => {
    const d = deps({
      applyReflection: vi.fn(async () => {
        throw new Error('boom');
      }),
    });
    const r = await runReflectionApplyTick(d);
    expect(r.failed).toBe(1);
    expect(d.markApplied).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: 'failed', error: expect.stringContaining('boom') }),
    );
  });

  it('processes a mixed batch and tallies the summary', async () => {
    const d = deps({
      listConfirmed: vi.fn(async () => [
        row({ id: 'a' }),
        row({ id: 'b', appliedAt: 'x' }), // skip
        row({ id: 'c' }),
      ]),
    });
    const r = await runReflectionApplyTick(d);
    expect(r.applied).toBe(2);
    expect(r.skipped).toBe(1);
  });
});
