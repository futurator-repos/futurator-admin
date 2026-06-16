/**
 * system-graph-bootstrap.test.mjs — Story 7.2. Bootstrap-on-first-build: the
 * first wave runs a full-repo bootstrap (--scan); subsequent waves run the
 * incremental step.
 */

import { describe, it, expect, vi } from 'vitest';
import { chooseGraphMode, runWaveGateGraph } from '../lib/system-graph-bootstrap.mjs';

describe('chooseGraphMode', () => {
  it('bootstraps on first build (no ast-facts marker yet)', () => {
    const exists = () => false;
    expect(chooseGraphMode({ root: '/r' }, { existsSync: exists })).toBe('bootstrap');
  });

  it('goes incremental once the AST-facts marker exists', () => {
    const exists = (p) => /ast-facts\.json$/.test(p);
    expect(chooseGraphMode({ root: '/r' }, { existsSync: exists })).toBe('incremental');
  });
});

describe('runWaveGateGraph', () => {
  it('first build → reuses bootstrap-ast --scan (the Slice-C full-repo scan)', async () => {
    const run = vi.fn(async () => '{}');
    const res = await runWaveGateGraph(
      { root: '/repos/songster' },
      { run, existsSync: () => false, log: () => {} },
    );
    expect(res.mode).toBe('bootstrap');
    expect(res.ran).toBe('bootstrap-ast');
    expect(run).toHaveBeenCalledWith('bootstrap-ast.mjs', ['--project', 'songster', '--root', '/repos/songster']);
  });

  it('subsequent wave → runs the incremental reusable step', async () => {
    const run = vi.fn(async () => '{}');
    const res = await runWaveGateGraph(
      { root: '/repos/songster', global: true },
      { run, existsSync: () => true, writeFile: async () => {}, mkdir: async () => {}, log: () => {} },
    );
    expect(res.mode).toBe('incremental');
    expect(res.ran).toBe('system-graph-step');
    // the step ran the extractors + graph-sync
    expect(run.mock.calls.some(([s]) => s === 'graph-sync.mjs')).toBe(true);
    expect(res.result.synced).toBe(true);
  });

  it('requires root', async () => {
    await expect(runWaveGateGraph({}, { run: async () => '' })).rejects.toThrow(/root/);
  });
});
