import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { execSync } from 'node:child_process';
import {
  parseInference,
  keywordGlobFallback,
  buildConventionsDigest,
  inferTouchPoints,
} from '../touch-point-inference.mjs';

function initGit(dir) {
  execSync('git init -q', { cwd: dir });
  execSync('git config user.email "t@t.com"', { cwd: dir });
  execSync('git config user.name "t"', { cwd: dir });
  writeFileSync(join(dir, '.gitignore'), '.futurator/\n');
  execSync('git add -A && git commit -q -m init', { cwd: dir });
}

/**
 * Minimal fake child-process object that looks enough like what the module
 * uses: stdin.write/end, stdout/stderr with `on('data')`, and `on('close')`.
 */
function fakeChild({ stdout = '', stderr = '', code = 0 } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: () => {}, end: () => {} };
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

function canned(output) {
  return () => fakeChild({ stdout: output, code: 0 });
}

function buildStory(id, extras = {}) {
  return {
    storyId: id,
    title: `Story ${id}`,
    description: `Do the thing for ${id}`,
    criteria: [],
    ...extras,
  };
}

function buildBlock(touchPoints, overrides = {}) {
  return (
    '<INFERENCE>\n' +
    JSON.stringify({
      touchPoints,
      complexity: 'standard',
      reviewRigor: 'standard',
      confidence: 'high',
      reasoning: 'test',
      collisionsWith: [],
      ...overrides,
    }) +
    '\n</INFERENCE>\n'
  );
}

describe('parseInference', () => {
  it('extracts a well-formed block', () => {
    const out = parseInference(buildBlock(['src/a.ts']));
    expect(out.ok).toBe(true);
    expect(out.inference.touchPoints).toEqual(['src/a.ts']);
    expect(out.inference.complexity).toBe('standard');
  });

  it('rejects missing block', () => {
    expect(parseInference('no block here').ok).toBe(false);
  });

  it('rejects empty touch points', () => {
    const body = '<INFERENCE>\n{"touchPoints":[],"complexity":"standard","reviewRigor":"standard","confidence":"high"}\n</INFERENCE>';
    const r = parseInference(body);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('empty-touch-points');
  });

  it('rejects invalid complexity', () => {
    const body = '<INFERENCE>\n{"touchPoints":["a"],"complexity":"bogus","reviewRigor":"standard","confidence":"high"}\n</INFERENCE>';
    expect(parseInference(body).reason).toBe('invalid-complexity');
  });

  it('rejects malformed JSON', () => {
    const body = '<INFERENCE>\n{not-json}\n</INFERENCE>';
    expect(parseInference(body).reason).toBe('invalid-json');
  });

  it('coerces missing collisionsWith to empty array', () => {
    const body = '<INFERENCE>\n{"touchPoints":["a"],"complexity":"standard","reviewRigor":"standard","confidence":"high"}\n</INFERENCE>';
    const r = parseInference(body);
    expect(r.ok).toBe(true);
    expect(r.inference.collisionsWith).toEqual([]);
  });

  it('treats non-string input as no-block', () => {
    expect(parseInference(null).ok).toBe(false);
    expect(parseInference(undefined).ok).toBe(false);
  });
});

describe('keywordGlobFallback', () => {
  it('routes api keywords to functions/api/index.ts', () => {
    const out = keywordGlobFallback({ title: 'Add API endpoint', description: 'Hono route' });
    expect(out.touchPoints).toContain('functions/api/index.ts');
    expect(out.confidence).toBe('low');
  });

  it('routes hook keywords to src/hooks/*.ts', () => {
    const out = keywordGlobFallback({ title: 'New hook for TanStack Query', description: '' });
    expect(out.touchPoints).toContain('src/hooks/*.ts');
  });

  it('falls back to src/**/*.ts when no keywords match', () => {
    const out = keywordGlobFallback({ title: 'Do a thing', description: 'generic work' });
    expect(out.touchPoints).toContain('src/**/*.ts');
  });

  it('is deterministic', () => {
    const s = { title: 'Add API endpoint', description: 'Hono route' };
    expect(keywordGlobFallback(s)).toEqual(keywordGlobFallback(s));
  });
});

describe('buildConventionsDigest', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'conv-digest-'));
  });
  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('extracts Architecture and Key Conventions sections', () => {
    writeFileSync(
      join(root, 'CLAUDE.md'),
      [
        '# Project',
        '',
        '## Overview',
        'blah',
        '',
        '## Architecture',
        'Hono single-file API',
        '',
        '## Key Conventions',
        'one repository file per concern',
        '',
        '## Testing',
        'vitest',
      ].join('\n'),
    );
    const digest = buildConventionsDigest(root);
    expect(digest).toContain('Hono single-file API');
    expect(digest).toContain('one repository file per concern');
    expect(digest).not.toContain('vitest');
  });

  it('returns empty string when CLAUDE.md is missing', () => {
    expect(buildConventionsDigest(root)).toBe('');
  });
});

describe('inferTouchPoints', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tpi-'));
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'a.ts'), '// alpha\nexport {};\n');
    writeFileSync(join(root, 'CLAUDE.md'), '## Architecture\n\nHono single-file API\n');
    initGit(root);
  });
  afterEach(() => {
    if (root && existsSync(root)) rmSync(root, { recursive: true, force: true });
  });

  it('populates touch points for every story using canned Haiku output', async () => {
    const epic = {
      epicId: 'EPIC-TEST',
      stories: [
        buildStory('S-1', { wave: 1 }),
        buildStory('S-2', { wave: 1 }),
      ],
    };
    const spawns = [];
    const spawnFn = (_bin, _args, opts) => {
      const i = spawns.length;
      spawns.push({ bin: _bin, args: _args });
      const story = epic.stories[i];
      return fakeChild({
        stdout: buildBlock([`src/${story.storyId}.ts`]),
        code: 0,
      });
    };

    const result = await inferTouchPoints({
      epic,
      workingDir: root,
      spawn: spawnFn,
      logger: { info: () => {} },
    });
    expect(result.stories).toHaveLength(2);
    expect(result.stories[0].touchPoints).toEqual(['src/S-1.ts']);
    expect(result.stories[1].touchPoints).toEqual(['src/S-2.ts']);
    expect(result.fallbacksApplied).toBe(0);
    expect(result.totalCostUSD).toBeGreaterThan(0);
    expect(spawns).toHaveLength(2);
    expect(spawns[0].args).toEqual(['--model', 'haiku', '--allowedTools', '', '--print']);
  });

  it('retries once on malformed output then succeeds', async () => {
    const epic = { epicId: 'E1', stories: [buildStory('S-1', { wave: 1 })] };
    let call = 0;
    const spawnFn = () => {
      call += 1;
      if (call === 1) return fakeChild({ stdout: 'garbage', code: 0 });
      return fakeChild({ stdout: buildBlock(['src/a.ts']), code: 0 });
    };
    const result = await inferTouchPoints({
      epic,
      workingDir: root,
      spawn: spawnFn,
      logger: { info: () => {} },
    });
    expect(result.stories[0].touchPoints).toEqual(['src/a.ts']);
    expect(result.stories[0].retries).toBe(1);
    expect(call).toBe(2);
  });

  it('falls back to keyword globs when Haiku fails twice', async () => {
    const epic = { epicId: 'E1', stories: [buildStory('S-1', { wave: 1, title: 'Add API endpoint' })] };
    const spawnFn = () => fakeChild({ stdout: 'still garbage', code: 0 });
    const result = await inferTouchPoints({
      epic,
      workingDir: root,
      spawn: spawnFn,
      logger: { info: () => {} },
    });
    expect(result.fallbacksApplied).toBe(1);
    expect(result.stories[0].confidence).toBe('low');
    expect(result.stories[0].requiresOperatorReview).toBe(true);
    expect(result.stories[0].touchPoints).toContain('functions/api/index.ts');
    expect(result.requiresOperatorReview).toEqual(['S-1']);
  });

  it('detects a collision and bumps the lower-complexity story to next wave', async () => {
    const epic = {
      epicId: 'E1',
      stories: [
        buildStory('S-1', { wave: 1 }),
        buildStory('S-2', { wave: 1 }),
      ],
    };
    const outputs = [
      buildBlock(['src/hooks/*.ts'], { complexity: 'complex' }),
      buildBlock(['src/hooks/use-costs.ts'], { complexity: 'standard' }),
    ];
    let i = 0;
    const spawnFn = () => fakeChild({ stdout: outputs[i++], code: 0 });
    const result = await inferTouchPoints({
      epic,
      workingDir: root,
      spawn: spawnFn,
      logger: { info: () => {} },
    });
    expect(result.collisions).toHaveLength(1);
    expect(result.waveReassignments).toHaveLength(1);
    const bumped = result.waveReassignments[0];
    expect(bumped.storyId).toBe('S-2');
    expect(bumped.to).toBeGreaterThan(1);
    expect(result.stories.find((s) => s.storyId === 'S-2').wave).toBe(bumped.to);
  });

  it('emits the expected event sequence to the NDJSON log', async () => {
    const epic = {
      epicId: 'EPIC-9',
      stories: [
        buildStory('S-1', { wave: 1 }),
        buildStory('S-2', { wave: 1 }),
      ],
    };
    const outputs = [
      buildBlock(['src/hooks/*.ts'], { complexity: 'complex' }),
      buildBlock(['src/hooks/use-costs.ts'], { complexity: 'standard' }),
    ];
    let i = 0;
    const spawnFn = () => fakeChild({ stdout: outputs[i++], code: 0 });

    const eventLogDir = join(root, 'event-log');
    await inferTouchPoints({
      epic,
      workingDir: root,
      spawn: spawnFn,
      eventLogDir,
      jobId: 'job-xyz',
      logger: { info: () => {} },
    });

    const logFile = join(eventLogDir, 'job-xyz.ndjson');
    expect(existsSync(logFile)).toBe(true);
    const lines = readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const types = lines.map((e) => e.eventType);
    expect(types[0]).toBe('inference_start');
    expect(types).toContain('story_inferred');
    expect(types).toContain('wave_conflict_autosplit');
    expect(types[types.length - 1]).toBe('inference_complete');
    expect(lines.every((e) => e.role === 'orchestrator')).toBe(true);
    expect(lines.every((e) => e.jobId === 'job-xyz')).toBe(true);
    expect(lines.every((e) => e.epicId === 'EPIC-9')).toBe(true);
  });

  it('emits inference_failed when fallback applied', async () => {
    const epic = { epicId: 'E1', stories: [buildStory('S-1', { wave: 1, title: 'API work' })] };
    const spawnFn = () => fakeChild({ stdout: 'no block', code: 0 });
    const eventLogDir = join(root, 'event-log');
    await inferTouchPoints({
      epic,
      workingDir: root,
      spawn: spawnFn,
      eventLogDir,
      jobId: 'job-fail',
      logger: { info: () => {} },
    });
    const lines = readFileSync(join(eventLogDir, 'job-fail.ndjson'), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const failed = lines.find((e) => e.eventType === 'inference_failed');
    expect(failed).toBeDefined();
    expect(failed.payload.fallbackApplied).toBe(true);
    expect(failed.payload.reason).toBeTruthy();
  });

  it('uses provided codebaseIndex override instead of building one', async () => {
    const epic = { epicId: 'E1', stories: [buildStory('S-1', { wave: 1 })] };
    let observedPrompt = '';
    const spawnFn = (_bin, _args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: (data) => { observedPrompt += data; },
        end: () => {},
      };
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(buildBlock(['src/a.ts'])));
        child.emit('close', 0);
      });
      return child;
    };
    await inferTouchPoints({
      epic,
      workingDir: root,
      codebaseIndex: 'CUSTOM_INDEX_MARKER',
      spawn: spawnFn,
      logger: { info: () => {} },
    });
    expect(observedPrompt).toContain('CUSTOM_INDEX_MARKER');
  });

  it('respects maxParallel by limiting concurrent in-flight spawns', async () => {
    const epic = {
      epicId: 'E1',
      stories: Array.from({ length: 6 }, (_, i) => buildStory(`S-${i}`, { wave: 1 })),
    };
    let inFlight = 0;
    let peak = 0;
    const spawnFn = () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: () => {}, end: () => {} };
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(buildBlock(['src/a.ts'])));
        setImmediate(() => {
          inFlight -= 1;
          child.emit('close', 0);
        });
      });
      return child;
    };
    await inferTouchPoints({
      epic,
      workingDir: root,
      maxParallel: 2,
      spawn: spawnFn,
      logger: { info: () => {} },
    });
    expect(peak).toBeLessThanOrEqual(2);
  });

  it('marks confidence:low stories as requiresOperatorReview even on success', async () => {
    const epic = { epicId: 'E1', stories: [buildStory('S-1', { wave: 1 })] };
    const spawnFn = () =>
      fakeChild({
        stdout: buildBlock(['src/a.ts'], { confidence: 'low' }),
        code: 0,
      });
    const result = await inferTouchPoints({
      epic,
      workingDir: root,
      spawn: spawnFn,
      logger: { info: () => {} },
    });
    expect(result.stories[0].requiresOperatorReview).toBe(true);
    expect(result.requiresOperatorReview).toEqual(['S-1']);
    expect(result.fallbacksApplied).toBe(0);
  });
});
