import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import {
  renderOrchestratorPrompt,
  buildStoryTableRows,
  runEpicDevPipeline,
  ORCHESTRATOR_TEMPLATE_PATH,
} from '../epic-dev-pipeline.mjs';

function makeStory(id, extras = {}) {
  return {
    storyId: id,
    title: `Story ${id}`,
    wave: 1,
    touchPoints: [`src/${id}.ts`],
    complexity: 'standard',
    reviewRigor: 'standard',
    acceptanceCriteria: ['AC 1'],
    ...extras,
  };
}

function makeJob(overrides = {}) {
  return {
    jobId: 'job-1',
    status: 'PENDING',
    phase: 'epic-dev',
    epicId: 'EPIC-1',
    projectId: 'PROJ-1',
    workingDir: '/tmp/project',
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    createdBy: 'tester',
    pipeline: { agents: {}, steps: [] },
    epicDevPayload: {
      orchestratorModel: 'opus',
      maxParallel: 4,
      maxRemediationRounds: 2,
      epicGoal: 'Ship feature X',
      contextDigest: 'CTX',
      rubric: 'RUB',
      stories: [makeStory('S-1'), makeStory('S-2', { wave: 2 })],
    },
    ...overrides,
  };
}

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

function silentLogger() {
  return { info: () => {}, warn: () => {}, error: () => {} };
}

describe('renderOrchestratorPrompt', () => {
  it('substitutes every provided variable', () => {
    const tpl = 'epic={{epicId}} project={{projectId}} count={{count}}';
    const { prompt, missingVars } = renderOrchestratorPrompt(tpl, {
      epicId: 'E-1',
      projectId: 'P-1',
      count: 3,
    });
    expect(prompt).toBe('epic=E-1 project=P-1 count=3');
    expect(missingVars).toEqual([]);
  });

  it('collects names of unresolved variables', () => {
    const tpl = '{{a}} {{b}} {{a}}';
    const { prompt, missingVars } = renderOrchestratorPrompt(tpl, { a: 'x' });
    expect(prompt).toBe('x {{b}} x');
    expect(missingVars).toEqual(['b']);
  });

  it('treats null/undefined as missing', () => {
    const tpl = '{{a}} {{b}}';
    const { missingVars } = renderOrchestratorPrompt(tpl, { a: null, b: undefined });
    expect(missingVars).toEqual(['a', 'b']);
  });

  it('stringifies non-string values', () => {
    const { prompt } = renderOrchestratorPrompt('{{n}}', { n: 42 });
    expect(prompt).toBe('42');
  });
});

describe('buildStoryTableRows', () => {
  it('returns one markdown row per story', () => {
    const rows = buildStoryTableRows([
      makeStory('S-1', { wave: 1 }),
      makeStory('S-2', { wave: 2, complexity: 'complex', touchPoints: ['a', 'b'] }),
    ]);
    const lines = rows.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('| S-1 | 1 | standard | standard |');
    expect(lines[1]).toContain('| S-2 | 2 | complex | standard |');
    expect(lines[1]).toContain('a, b');
  });

  it('returns empty string when no stories', () => {
    expect(buildStoryTableRows([])).toBe('');
    expect(buildStoryTableRows(undefined)).toBe('');
  });

  it('escapes pipe characters inside titles', () => {
    const rows = buildStoryTableRows([makeStory('S-1', { title: 'A | B' })]);
    expect(rows).toContain('A \\| B');
  });
});

describe('runEpicDevPipeline — validation', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'eo-pipe-')); });
  afterEach(() => { if (root && existsSync(root)) rmSync(root, { recursive: true, force: true }); });

  it('rejects jobs with non-epic-dev phase', async () => {
    const job = makeJob({ phase: 'legacy' });
    await expect(() =>
      runEpicDevPipeline({ job, eventLogDir: root, logger: silentLogger() }),
    ).rejects.toThrow(/phase must be 'epic-dev'/);
  });

  it('rejects payload missing required fields', async () => {
    const job = makeJob();
    delete job.epicDevPayload.epicGoal;
    await expect(() =>
      runEpicDevPipeline({ job, eventLogDir: root, logger: silentLogger() }),
    ).rejects.toThrow(/missing fields/);
  });

  it('rejects story missing touch points', async () => {
    const job = makeJob();
    job.epicDevPayload.stories = [makeStory('S-1', { touchPoints: [] })];
    await expect(() =>
      runEpicDevPipeline({ job, eventLogDir: root, logger: silentLogger() }),
    ).rejects.toThrow(/missing storyId or touchPoints/);
  });

  it('rejects story missing complexity / reviewRigor', async () => {
    const job = makeJob();
    job.epicDevPayload.stories = [{ storyId: 'S-1', touchPoints: ['x'], wave: 1, title: 't' }];
    await expect(() =>
      runEpicDevPipeline({ job, eventLogDir: root, logger: silentLogger() }),
    ).rejects.toThrow(/run touch-point inference first/);
  });

  it('requires workingDir', async () => {
    const job = makeJob({ workingDir: undefined });
    await expect(() =>
      runEpicDevPipeline({ job, eventLogDir: root, logger: silentLogger() }),
    ).rejects.toThrow(/workingDir is required/);
  });

  it('requires eventLogDir', async () => {
    await expect(() =>
      runEpicDevPipeline({ job: makeJob(), logger: silentLogger() }),
    ).rejects.toThrow(/eventLogDir is required/);
  });
});

describe('runEpicDevPipeline — spawn behavior', () => {
  let root;
  let eventDir;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'eo-pipe-'));
    eventDir = join(root, 'events');
    mkdirSync(eventDir, { recursive: true });
  });
  afterEach(() => { if (root && existsSync(root)) rmSync(root, { recursive: true, force: true }); });

  it('spawns claude with orchestrator model + renders the template fully', async () => {
    const job = makeJob({ workingDir: root });
    let observed = { bin: null, args: null, cwd: null, prompt: '' };
    const spawnFn = (bin, args, options) => {
      observed.bin = bin;
      observed.args = args;
      observed.cwd = options?.cwd;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write: (p) => { observed.prompt += p; },
        end: () => {},
      };
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from('orchestrator output\n'));
        child.emit('close', 0);
      });
      return child;
    };
    const result = await runEpicDevPipeline({
      job,
      eventLogDir: eventDir,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(result.exitCode).toBe(0);
    expect(observed.bin).toBe('claude');
    expect(observed.args).toContain('--model');
    expect(observed.args).toContain('opus');
    expect(observed.cwd).toBe(root);
    expect(observed.prompt).toContain('EPIC-1');
    expect(observed.prompt).toContain('| S-1 |');
    expect(observed.prompt).toContain('| S-2 |');
    expect(observed.prompt).not.toContain('{{epicId}}');
    expect(observed.prompt).not.toContain('{{contextDigest}}');
    expect(observed.prompt).not.toContain('{{resumeFromWaveResults}}');
  });

  it('writes orchestrator stdout/stderr/prompt to {eventLogDir}/{jobId}.orchestrator.*.log', async () => {
    const job = makeJob({ workingDir: root });
    const spawnFn = () => fakeChild({ stdout: 'hello\n', stderr: 'warn\n', code: 0 });
    await runEpicDevPipeline({
      job,
      eventLogDir: eventDir,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    const promptFile = join(eventDir, 'job-1.orchestrator.prompt.log');
    const stdoutFile = join(eventDir, 'job-1.orchestrator.stdout.log');
    const stderrFile = join(eventDir, 'job-1.orchestrator.stderr.log');
    expect(existsSync(promptFile)).toBe(true);
    expect(existsSync(stdoutFile)).toBe(true);
    expect(existsSync(stderrFile)).toBe(true);
    expect(readFileSync(promptFile, 'utf8')).toContain('Epic Orchestrator — EPIC-1');
    expect(readFileSync(stdoutFile, 'utf8')).toContain('hello');
    expect(readFileSync(stderrFile, 'utf8')).toContain('warn');
  });

  it('serializes resumeFromWaveResults as JSON in the prompt (and "null" when absent)', async () => {
    const job = makeJob({
      workingDir: root,
      resumeFromWaveResults: {
        '1': {
          waveNumber: 1,
          stories: { 'S-1': { status: 'APPROVED', attempts: 1, reviewAttempts: 1, filesTouched: [] } },
          durationMs: 100,
          completedAt: 1,
        },
      },
    });
    let capturedPrompt = '';
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: (p) => { capturedPrompt += p; }, end: () => {} };
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    await runEpicDevPipeline({ job, eventLogDir: eventDir, spawn: spawnFn, logger: silentLogger() });
    expect(capturedPrompt).toContain('"waveNumber": 1');
    expect(capturedPrompt).toContain('"status": "APPROVED"');
  });

  it('uses payload.rubric when no rubric file paths provided', async () => {
    const job = makeJob({ workingDir: root });
    job.epicDevPayload.rubric = 'RULE-A\nRULE-B';
    let capturedPrompt = '';
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: (p) => { capturedPrompt += p; }, end: () => {} };
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    await runEpicDevPipeline({ job, eventLogDir: eventDir, spawn: spawnFn, logger: silentLogger() });
    expect(capturedPrompt).toContain('RULE-A');
    expect(capturedPrompt).toContain('RULE-B');
  });

  it('uses mergeRubric when rubricDefaultPath is provided', async () => {
    const defaultPath = join(root, 'default-rubric.md');
    writeFileSync(defaultPath, '# Default Rubric\n\n## R-ARCH-001 No mocks\n\nContent.\n');
    const job = makeJob({ workingDir: root });
    let capturedPrompt = '';
    const spawnFn = () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = { write: (p) => { capturedPrompt += p; }, end: () => {} };
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    await runEpicDevPipeline({
      job,
      eventLogDir: eventDir,
      rubricDefaultPath: defaultPath,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(capturedPrompt).toContain('R-ARCH-001');
  });

  it('surfaces non-zero exit codes from claude', async () => {
    const job = makeJob({ workingDir: root });
    const spawnFn = () => fakeChild({ stdout: 'oops\n', code: 7 });
    const res = await runEpicDevPipeline({
      job,
      eventLogDir: eventDir,
      spawn: spawnFn,
      logger: silentLogger(),
    });
    expect(res.exitCode).toBe(7);
    expect(res.stdout).toContain('oops');
  });

  it('renders the real template file without leaving {{placeholders}} behind', () => {
    const template = readFileSync(ORCHESTRATOR_TEMPLATE_PATH, 'utf8');
    const vars = {
      epicId: 'E', projectId: 'P', projectRoot: '/x', jobId: 'J',
      daemonPort: 17631, contextDigest: 'c', rubric: 'r',
      storyTableRows: '| s |', storyManifestJson: '[]',
      maxParallel: 4, maxRemediationRounds: 2, resumeFromWaveResults: 'null',
    };
    const { prompt, missingVars } = renderOrchestratorPrompt(template, vars);
    expect(missingVars).toEqual([]);
    expect(prompt).not.toMatch(/\{\{\w+\}\}/);
  });
});
