// story-compile-graph.test — G3 (Pipeline-3 parity). Verifies the fire-and-forget
// per-story COMPILE phase: reuses getCompileSteps/getCompilerAgent, runs
// diff-extract → compile-knowledge → embed-sync, and reports graphUpdated from
// the graph-snapshot.json delta. Spawn is fully injected — no real claude / git /
// graph-sync runs.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStoryCompileGraph } from '../story-compile-graph.mjs';

const silentLogger = { info() {}, warn() {}, error() {} };

let workingDir;

beforeEach(() => {
  workingDir = mkdtempSync(join(tmpdir(), 'story-compile-'));
});
afterEach(() => {
  rmSync(workingDir, { recursive: true, force: true });
});

/**
 * Build an injectable spawn that records each invocation and drives a fake child
 * to completion. `handler(file, args, invocation)` returns
 * { stdout?, code?, onClose? } — onClose runs synchronously before 'close' so a
 * step can, e.g., write the graph snapshot to simulate graph-sync.
 */
function makeSpawn(handler) {
  const calls = [];
  const spawn = (file, args) => {
    const invocation = { file, args, command: file === '/bin/sh' ? args?.[1] : null };
    calls.push(invocation);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    const res = handler(file, args, invocation) || {};
    setTimeout(() => {
      if (res.stdout) child.stdout.emit('data', Buffer.from(res.stdout));
      if (typeof res.onClose === 'function') res.onClose();
      child.emit('close', res.code ?? 0);
    }, 0);
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

function writeSnapshot(dir, { nodeCount, edgeCount, generatedAt }) {
  const graphDir = join(dir, 'knowledge', '_graph');
  mkdirSync(graphDir, { recursive: true });
  writeFileSync(
    join(graphDir, 'graph-snapshot.json'),
    JSON.stringify({ projectId: 'p', generatedAt, nodeCount, edgeCount, nodes: [], edges: [] }),
    'utf-8',
  );
}

describe('runStoryCompileGraph', () => {
  it('runs diff → compile-knowledge → sync in order and reports graphUpdated when the snapshot grows', async () => {
    const spawn = makeSpawn((file, args, inv) => {
      if (inv.command && /git diff/.test(inv.command)) {
        return { stdout: 'A\tsrc/new-file.ts\n', code: 0 };
      }
      if (inv.command && /graph-sync\.mjs/.test(inv.command)) {
        // Simulate graph-sync producing a fresh (grown) snapshot.
        return { code: 0, onClose: () => writeSnapshot(workingDir, { nodeCount: 12, edgeCount: 20, generatedAt: '2026-07-01T00:00:00Z' }) };
      }
      return { code: 0 }; // claude COMPILER
    });

    const r = await runStoryCompileGraph({
      projectId: 'spyhunter',
      workingDir,
      storyId: 's-1',
      planId: 'plan-1',
      headSha: 'SHA1',
      deps: { spawn, claudeBin: 'claude', logger: silentLogger },
    });

    expect(r.ran).toBe(true);
    expect(r.graphUpdated).toBe(true);

    // Exactly the 3 story-scoped steps ran, in order: diff (sh), compiler (claude), sync (sh).
    const files = spawn.calls.map((c) => (c.file === 'claude' ? 'claude' : c.command?.match(/git diff|graph-sync/)?.[0]));
    expect(files).toEqual(['git diff', 'claude', 'graph-sync']);
  });

  it('injects the captured DIFF_MANIFEST into the compiler prompt', async () => {
    let compilerPrompt = null;
    const spawn = makeSpawn((file, args, inv) => {
      if (file === 'claude') {
        const pIdx = args.indexOf('-p');
        compilerPrompt = args[pIdx + 1];
        return { code: 0 };
      }
      if (inv.command && /git diff/.test(inv.command)) return { stdout: 'M\tsrc/game.ts\n', code: 0 };
      if (inv.command && /graph-sync/.test(inv.command)) {
        return { code: 0, onClose: () => writeSnapshot(workingDir, { nodeCount: 1, edgeCount: 0, generatedAt: 'x' }) };
      }
      return { code: 0 };
    });

    await runStoryCompileGraph({
      projectId: 'p', workingDir, storyId: 's', planId: 'pl',
      deps: { spawn, claudeBin: 'claude', logger: silentLogger },
    });

    expect(compilerPrompt).toContain('src/game.ts');
    expect(compilerPrompt).not.toContain('{{DIFF_MANIFEST}}');
    expect(compilerPrompt).not.toContain('{{WORK_SUMMARY}}');
  });

  it('passes the COMPILER model/tool policy to claude', async () => {
    let claudeArgs = null;
    const spawn = makeSpawn((file, args, inv) => {
      if (file === 'claude') { claudeArgs = args; return { code: 0 }; }
      if (inv.command && /graph-sync/.test(inv.command)) {
        return { code: 0, onClose: () => writeSnapshot(workingDir, { nodeCount: 1, edgeCount: 0, generatedAt: 'x' }) };
      }
      return { stdout: '', code: 0 };
    });

    await runStoryCompileGraph({
      projectId: 'p', workingDir, storyId: 's', planId: 'pl',
      deps: { spawn, claudeBin: 'claude', logger: silentLogger },
    });

    expect(claudeArgs).toContain('--model');
    expect(claudeArgs).toContain('bypassPermissions');
    expect(claudeArgs).toContain('--allowedTools');
  });

  it('reports graphUpdated:false with a reason when compile-sync fails', async () => {
    const spawn = makeSpawn((file, args, inv) => {
      if (inv.command && /graph-sync/.test(inv.command)) return { code: 1, stdout: 'graph store write failed' };
      return { stdout: 'A\tx.ts\n', code: 0 };
    });

    const r = await runStoryCompileGraph({
      projectId: 'p', workingDir, storyId: 's', planId: 'pl',
      deps: { spawn, claudeBin: 'claude', logger: silentLogger },
    });

    expect(r.ran).toBe(true);
    expect(r.graphUpdated).toBe(false);
    expect(r.reason).toMatch(/compile-sync exit 1/);
  });

  it('continues to sync even when the compiler agent exits non-zero (non-blocking)', async () => {
    let syncRan = false;
    const spawn = makeSpawn((file, args, inv) => {
      if (file === 'claude') return { code: 2 }; // compiler crashed
      if (inv.command && /graph-sync/.test(inv.command)) {
        syncRan = true;
        return { code: 0, onClose: () => writeSnapshot(workingDir, { nodeCount: 3, edgeCount: 2, generatedAt: 't' }) };
      }
      return { stdout: 'A\ty.ts\n', code: 0 };
    });

    const r = await runStoryCompileGraph({
      projectId: 'p', workingDir, storyId: 's', planId: 'pl',
      deps: { spawn, claudeBin: 'claude', logger: silentLogger },
    });

    expect(syncRan).toBe(true);
    expect(r.ran).toBe(true);
    expect(r.graphUpdated).toBe(true);
  });

  it('reports no-snapshot when graph-sync leaves no snapshot (Memgraph unavailable)', async () => {
    const spawn = makeSpawn((file, args, inv) => {
      if (inv.command && /git diff/.test(inv.command)) return { stdout: 'A\tz.ts\n', code: 0 };
      return { code: 0 }; // sync exits 0 but writes nothing
    });

    const r = await runStoryCompileGraph({
      projectId: 'p', workingDir, storyId: 's', planId: 'pl',
      deps: { spawn, claudeBin: 'claude', logger: silentLogger },
    });

    expect(r.ran).toBe(true);
    expect(r.graphUpdated).toBe(false);
    expect(r.reason).toBe('no-snapshot');
  });

  it('does not treat an unchanged snapshot (same generatedAt) as updated', async () => {
    writeSnapshot(workingDir, { nodeCount: 5, edgeCount: 5, generatedAt: 'STAMP' });
    const spawn = makeSpawn((file, args, inv) => {
      if (inv.command && /git diff/.test(inv.command)) return { stdout: '', code: 0 };
      return { code: 0 }; // sync leaves the same snapshot untouched
    });

    const r = await runStoryCompileGraph({
      projectId: 'p', workingDir, storyId: 's', planId: 'pl',
      deps: { spawn, claudeBin: 'claude', logger: silentLogger },
    });

    expect(r.ran).toBe(true);
    expect(r.graphUpdated).toBe(false);
  });

  it('bails without running when projectId/workingDir are missing', async () => {
    const spawn = makeSpawn(() => ({ code: 0 }));
    const r = await runStoryCompileGraph({ storyId: 's', deps: { spawn, logger: silentLogger } });
    expect(r.ran).toBe(false);
    expect(spawn.calls.length).toBe(0);
  });
});
