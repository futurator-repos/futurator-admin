/**
 * system-graph-step.test.mjs — Story 7.1. The four extractors + graph-sync as a
 * single config-driven wave-gate step: any repo runs them against its own
 * sst.config.ts + Hono app through one integration point.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  resolveStepConfig,
  buildExtractorPlan,
  buildSyncArgs,
  runSystemGraphStep,
} from '../lib/system-graph-step.mjs';

describe('resolveStepConfig — conventions, no per-repo code', () => {
  it('derives project/knowledgeDir/mycelium from root and defaults config+app+lambda', () => {
    const c = resolveStepConfig({ root: '/repos/songster' });
    expect(c.project).toBe('songster');
    expect(c.config).toBe('sst.config.ts');
    expect(c.app).toBe('functions/api/index.ts');
    expect(c.lambda).toBe('infra/lambda/Api');
    expect(c.knowledgeDir).toMatch(/songster\/knowledge$/);
    expect(c.myceliumDir).toMatch(/songster\/\.mycelium$/);
  });

  it('honours explicit overrides (a repo with a non-default app path)', () => {
    const c = resolveStepConfig({ root: '/r', app: 'src/server.ts', lambda: 'infra/lambda/Web', project: 'p' });
    expect(c.app).toBe('src/server.ts');
    expect(c.lambda).toBe('infra/lambda/Web');
  });
});

describe('buildExtractorPlan', () => {
  it('runs infra + route + ast against the repo config/app, capturing each envelope', () => {
    const plan = buildExtractorPlan(resolveStepConfig({ root: '/r' }));
    expect(plan.map((s) => s.name)).toEqual(['infra', 'route', 'ast']);
    const infra = plan.find((s) => s.name === 'infra');
    expect(infra.args).toEqual(['--root', '/r', '--config', 'sst.config.ts']);
    expect(infra.outFile).toMatch(/\.mycelium\/infra-facts\.json$/);
    const route = plan.find((s) => s.name === 'route');
    expect(route.args).toEqual(['--root', '/r', '--app', 'functions/api/index.ts', '--lambda', 'infra/lambda/Api']);
  });

  it('includes service-extract only when a source-file list is given (never guessed)', () => {
    const withFiles = buildExtractorPlan(resolveStepConfig({ root: '/r', sourceFiles: ['a.ts', 'b.ts'] }));
    const svc = withFiles.find((s) => s.name === 'service');
    expect(svc.args).toEqual(['--root', '/r', '--files', 'a.ts,b.ts']);
    const noFiles = buildExtractorPlan(resolveStepConfig({ root: '/r' }));
    expect(noFiles.find((s) => s.name === 'service')).toBeUndefined();
  });

  it('adds --scan only in bootstrap mode (Story 7.2)', () => {
    const scan = buildExtractorPlan(resolveStepConfig({ root: '/r', scan: true }));
    expect(scan.find((s) => s.name === 'ast').args).toContain('--scan');
    const incremental = buildExtractorPlan(resolveStepConfig({ root: '/r' }));
    expect(incremental.find((s) => s.name === 'ast').args).not.toContain('--scan');
  });
});

describe('buildSyncArgs — carries --global / --wave-gate through', () => {
  it('passes project + knowledge-dir and the optional flags', () => {
    const c = resolveStepConfig({ root: '/r', global: true, waveGate: 'wave-42' });
    expect(buildSyncArgs(c)).toEqual([
      '--project', 'r', '--knowledge-dir', '/r/knowledge', '--global', '--wave-gate', 'wave-42',
    ]);
  });
});

describe('runSystemGraphStep — orchestration', () => {
  it('captures each extractor stdout to its envelope file, then runs graph-sync', async () => {
    const run = vi.fn(async (script) => `{"from":"${script}"}`);
    const writes = [];
    const writeFile = vi.fn(async (p, content) => writes.push({ p, content }));
    const mkdir = vi.fn(async () => {});

    const result = await runSystemGraphStep(
      { root: '/r', sourceFiles: ['a.ts'], scan: true, global: true },
      { run, writeFile, mkdir, log: () => {} },
    );

    // 4 extractors captured + graph-sync invoked
    expect(result.results.map((r) => r.name)).toEqual(['infra', 'route', 'service', 'ast']);
    expect(result.results.every((r) => r.ok)).toBe(true);
    expect(writes.map((w) => w.p).every((p) => /\.mycelium\//.test(p))).toBe(true);
    expect(result.synced).toBe(true);
    // last run call is graph-sync with --global
    const lastCall = run.mock.calls.at(-1);
    expect(lastCall[0]).toBe('graph-sync.mjs');
    expect(lastCall[1]).toContain('--global');
  });

  it('is non-blocking: a failing extractor is skipped but graph-sync still runs', async () => {
    const run = vi.fn(async (script) => {
      if (script === 'route-extract.mjs') throw new Error('tree-sitter missing');
      return '{}';
    });
    const result = await runSystemGraphStep(
      { root: '/r' },
      { run, writeFile: async () => {}, mkdir: async () => {}, log: () => {} },
    );
    const route = result.results.find((r) => r.name === 'route');
    expect(route.ok).toBe(false);
    expect(route.error).toMatch(/tree-sitter/);
    expect(result.synced).toBe(true); // graph-sync still ran
  });

  it('requires root/project/knowledgeDir', async () => {
    await expect(runSystemGraphStep({}, { run: async () => '' })).rejects.toThrow(/root, project/);
  });
});
