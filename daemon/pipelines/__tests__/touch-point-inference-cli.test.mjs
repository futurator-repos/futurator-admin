import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import {
  mergeInferenceIntoEpic,
  runInferenceCli,
} from '../touch-point-inference.mjs';

function initGit(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.futurator/\n');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
}

function fakeChild({ stdout = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    child.emit('close', code);
  });
  return child;
}

function block(touchPoints, overrides = {}) {
  return (
    '<INFERENCE>\n' +
    JSON.stringify({
      touchPoints,
      complexity: 'standard',
      reviewRigor: 'standard',
      confidence: 'high',
      reasoning: 'ok',
      collisionsWith: [],
      ...overrides,
    }) +
    '\n</INFERENCE>\n'
  );
}

function fakeRepo(epic) {
  const persisted = [];
  return {
    persisted,
    getEpicById: async (id) => (id === epic.epicId ? structuredClone(epic) : null),
    persistInferenceResult: async (id, payload) => {
      persisted.push({ id, payload });
    },
  };
}

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

describe('mergeInferenceIntoEpic', () => {
  it('applies inference fields to matching stories only', () => {
    const epic = {
      epicId: 'E1',
      stories: [
        { storyId: 'S-1', title: 'a', wave: 1 },
        { storyId: 'S-2', title: 'b', wave: 1 },
      ],
    };
    const inference = {
      stories: [
        {
          storyId: 'S-1',
          touchPoints: ['src/a.ts'],
          complexity: 'standard',
          reviewRigor: 'light',
          confidence: 'high',
          reasoning: 'ok',
          wave: 1,
          retries: 0,
          fallbackApplied: false,
          requiresOperatorReview: false,
        },
      ],
    };
    const merged = mergeInferenceIntoEpic(epic, inference);
    expect(merged[0].touchPoints).toEqual(['src/a.ts']);
    expect(merged[0].inferenceMetadata.model).toBe('haiku');
    expect(merged[0].inferenceMetadata.confidence).toBe('high');
    expect(merged[1].touchPoints).toBeUndefined();
  });

  it('respects storyIdFilter', () => {
    const epic = {
      epicId: 'E1',
      stories: [
        { storyId: 'S-1', touchPoints: ['pre/existing.ts'] },
        { storyId: 'S-2' },
      ],
    };
    const inference = {
      stories: [
        {
          storyId: 'S-1',
          touchPoints: ['new/a.ts'],
          complexity: 'standard',
          reviewRigor: 'standard',
          confidence: 'high',
        },
        {
          storyId: 'S-2',
          touchPoints: ['new/b.ts'],
          complexity: 'standard',
          reviewRigor: 'standard',
          confidence: 'high',
        },
      ],
    };
    const merged = mergeInferenceIntoEpic(epic, inference, { storyIdFilter: ['S-2'] });
    expect(merged[0].touchPoints).toEqual(['pre/existing.ts']); // unchanged
    expect(merged[1].touchPoints).toEqual(['new/b.ts']);
  });

  it('sets requiresOperatorReview + fallbackApplied on metadata', () => {
    const epic = { epicId: 'E1', stories: [{ storyId: 'S-1' }] };
    const inference = {
      stories: [
        {
          storyId: 'S-1',
          touchPoints: ['x'],
          complexity: 'standard',
          reviewRigor: 'standard',
          confidence: 'low',
          fallbackApplied: true,
          requiresOperatorReview: true,
        },
      ],
    };
    const merged = mergeInferenceIntoEpic(epic, inference);
    expect(merged[0].inferenceMetadata.fallbackApplied).toBe(true);
    expect(merged[0].inferenceMetadata.requiresOperatorReview).toBe(true);
  });
});

describe('runInferenceCli', () => {
  let root;
  let outPath;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tpi-cli-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// a\n');
    writeFileSync(join(root, 'CLAUDE.md'), '## Architecture\n\nHono.\n');
    initGit(root);
    outPath = join(root, 'result.json');
  });
  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('prints usage and exits 1 when required args are missing', async () => {
    const errors = [];
    const res = await runInferenceCli({
      argv: [],
      repo: fakeRepo({ epicId: 'X', stories: [] }),
      logger: { info: () => {}, warn: () => {}, error: (m) => errors.push(m) },
    });
    expect(res.exitCode).toBe(1);
    expect(errors.join('\n')).toContain('Usage:');
  });

  it('exits 2 when epic is not found', async () => {
    const res = await runInferenceCli({
      argv: ['--epic-id', 'NOPE', '--working-dir', root, '--out', outPath],
      repo: fakeRepo({ epicId: 'OTHER', stories: [] }),
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(2);
  });

  it('writes out.json and persists merged stories on success', async () => {
    const epic = {
      epicId: 'EPIC-1',
      stories: [
        { storyId: 'S-1', title: 'Task one', wave: 1 },
        { storyId: 'S-2', title: 'Task two', wave: 1 },
      ],
    };
    const repo = fakeRepo(epic);
    const outputs = [block(['src/a.ts']), block(['src/b.ts'])];
    let i = 0;
    const spawnFn = () => fakeChild({ stdout: outputs[i++], code: 0 });

    const res = await runInferenceCli({
      argv: ['--epic-id', 'EPIC-1', '--working-dir', root, '--out', outPath],
      repo,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);

    const report = JSON.parse(readFileSync(outPath, 'utf8'));
    expect(report.epicId).toBe('EPIC-1');
    expect(report.stories).toHaveLength(2);

    expect(repo.persisted).toHaveLength(1);
    const persisted = repo.persisted[0];
    expect(persisted.id).toBe('EPIC-1');
    expect(persisted.payload.stories).toHaveLength(2);
    expect(persisted.payload.stories[0].touchPoints).toEqual(['src/a.ts']);
    expect(persisted.payload.stories[0].inferenceMetadata.model).toBe('haiku');
    expect(persisted.payload.inferenceSummary.totalCostUSD).toBeGreaterThan(0);
  });

  it('refuses to re-run when inference already present without --force', async () => {
    const epic = {
      epicId: 'EPIC-1',
      stories: [
        {
          storyId: 'S-1',
          title: 'a',
          wave: 1,
          touchPoints: ['src/a.ts'],
          inferenceMetadata: { model: 'haiku', inferredAt: '2025-01-01', confidence: 'high' },
        },
      ],
    };
    const repo = fakeRepo(epic);
    const res = await runInferenceCli({
      argv: ['--epic-id', 'EPIC-1', '--working-dir', root, '--out', outPath],
      repo,
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(3);
    expect(repo.persisted).toEqual([]);
  });

  it('re-runs when --force is supplied', async () => {
    const epic = {
      epicId: 'EPIC-1',
      stories: [
        {
          storyId: 'S-1',
          title: 'a',
          wave: 1,
          touchPoints: ['old/a.ts'],
          inferenceMetadata: { model: 'haiku', inferredAt: '2025-01-01', confidence: 'high' },
        },
      ],
    };
    const repo = fakeRepo(epic);
    const spawnFn = () => fakeChild({ stdout: block(['new/a.ts']), code: 0 });
    const res = await runInferenceCli({
      argv: ['--epic-id', 'EPIC-1', '--working-dir', root, '--out', outPath, '--force'],
      repo,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(0);
    expect(repo.persisted[0].payload.stories[0].touchPoints).toEqual(['new/a.ts']);
  });

  it('runs inference only for stories listed in --stories', async () => {
    const epic = {
      epicId: 'EPIC-1',
      stories: [
        { storyId: 'S-1', title: 'a', wave: 1, touchPoints: ['old/a.ts'], inferenceMetadata: { model: 'haiku', inferredAt: '2025-01-01', confidence: 'high' } },
        { storyId: 'S-2', title: 'b', wave: 1 },
      ],
    };
    const repo = fakeRepo(epic);
    let spawnCount = 0;
    const spawnFn = () => {
      spawnCount += 1;
      return fakeChild({ stdout: block(['src/b.ts']), code: 0 });
    };
    const res = await runInferenceCli({
      argv: [
        '--epic-id', 'EPIC-1',
        '--working-dir', root,
        '--out', outPath,
        '--stories', 'S-2',
      ],
      repo,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(0);
    expect(spawnCount).toBe(1); // only S-2 inferred
    const persisted = repo.persisted[0].payload.stories;
    expect(persisted[0].touchPoints).toEqual(['old/a.ts']); // preserved
    expect(persisted[1].touchPoints).toEqual(['src/b.ts']);
  });

  it('exits 4 on unknown story ids in --stories', async () => {
    const epic = { epicId: 'EPIC-1', stories: [{ storyId: 'S-1' }] };
    const res = await runInferenceCli({
      argv: [
        '--epic-id', 'EPIC-1',
        '--working-dir', root,
        '--out', outPath,
        '--stories', 'S-9',
      ],
      repo: fakeRepo(epic),
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(4);
  });

  it('exits 10 and surfaces result when fallback was applied', async () => {
    const epic = { epicId: 'EPIC-1', stories: [{ storyId: 'S-1', title: 'api work', wave: 1 }] };
    const repo = fakeRepo(epic);
    const spawnFn = () => fakeChild({ stdout: 'no block', code: 0 });
    const res = await runInferenceCli({
      argv: ['--epic-id', 'EPIC-1', '--working-dir', root, '--out', outPath],
      repo,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(10);
    expect(res.result.fallbacksApplied).toBe(1);
    // still persisted because CLI writes on fallback (operator can re-run)
    expect(repo.persisted).toHaveLength(1);
    expect(repo.persisted[0].payload.stories[0].inferenceMetadata.fallbackApplied).toBe(true);
  });

  it('skips persistence when --skip-persist is supplied', async () => {
    const epic = { epicId: 'EPIC-1', stories: [{ storyId: 'S-1', title: 'a', wave: 1 }] };
    const repo = fakeRepo(epic);
    const spawnFn = () => fakeChild({ stdout: block(['src/a.ts']), code: 0 });
    const res = await runInferenceCli({
      argv: ['--epic-id', 'EPIC-1', '--working-dir', root, '--out', outPath, '--skip-persist'],
      repo,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    expect(repo.persisted).toHaveLength(0);
  });
});
