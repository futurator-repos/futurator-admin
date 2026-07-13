import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildStoryDevContract, buildStoryDevJob, DANGER_PATHS } from '../story-job-minter.mjs';
import { handleStoryCompletion } from '../story-completion-handler.mjs';
import { buildStoryDevPrompt, runStoryDevJob } from '../../pipelines/story-dev-pipeline.mjs';
import { selectHandler, JOB_HANDLER_STORY_DEV } from '../../pipelines/job-router.mjs';

const storyNode = (over = {}) => ({
  storyId: 's1', title: 'Add login', intent: 'users can log in',
  complexity: 'standard', depends_on: [], touches: ['src/auth/**'],
  acceptanceCriteria: [{ id: 'a1', text: 'login works', acClass: 'deterministic', testBinding: { status: 'unbound' } }],
  ...over,
});

describe('buildStoryDevContract', () => {
  it('unions authored forbidden + DANGER_PATHS + sibling touches; keeps own touches allowed', () => {
    const c = buildStoryDevContract({
      storyNode: storyNode({ forbiddenAreas: ['legacy/**'] }),
      siblingTouches: ['src/billing/**', 'src/auth/**'], // own touch stays allowed
    });
    expect(c.allowedPaths).toEqual(['src/auth/**']);
    expect(c.forbiddenAreas).toContain('legacy/**');
    expect(c.forbiddenAreas).toContain('src/billing/**');
    expect(c.forbiddenAreas).not.toContain('src/auth/**'); // our own touch excluded from forbidden
    for (const d of DANGER_PATHS) expect(c.forbiddenAreas).toContain(d);
  });
});

describe('buildStoryDevJob', () => {
  it('builds a PENDING story-dev row with refs + payload', () => {
    const row = buildStoryDevJob({ storyNode: storyNode(), planId: 'p1', appId: 'app1', workingDir: '/w', jobId: 'j1', now: 'T' });
    expect(row).toMatchObject({
      jobId: 'j1', status: 'PENDING', jobType: 'story-dev', workingDir: '/w',
      storyNodeRef: { storyId: 's1', planId: 'p1' },
    });
    expect(row.storyDevPayload.touches).toEqual(['src/auth/**']);
    expect(row.storyDevPayload.acceptanceCriteria).toHaveLength(1);
  });
});

describe('handleStoryCompletion', () => {
  it('binds from <BINDING>, runs tests, done → done + propagate', async () => {
    const devOutput = 'work...\n<BINDING>{"a1":{"testRef":"t.test.ts","testKind":"unit"}}</BINDING>';
    const r = await handleStoryCompletion({
      storyNode: storyNode(), devOutput, headSha: 'SHA',
      executors: { unit: async () => ({ passed: true }) },
    });
    expect(r.verdict.status).toBe('done');
    expect(r.newState).toBe('done');
    expect(r.propagate).toBe(true);
    expect(r.acceptanceCriteria[0].testBinding.status).toBe('passing');
  });
  it('failing test → failed, no propagate', async () => {
    const devOutput = '<BINDING>{"a1":"t.test.ts"}</BINDING>';
    const r = await handleStoryCompletion({
      storyNode: storyNode(), devOutput, headSha: 'SHA',
      executors: { unit: async () => ({ passed: false }) },
    });
    expect(r.newState).toBe('failed');
    expect(r.propagate).toBe(false);
  });
  it('no <BINDING> → ACs stay unbound → failed', async () => {
    const r = await handleStoryCompletion({ storyNode: storyNode(), devOutput: 'no manifest', headSha: 'SHA' });
    expect(r.verdict.status).toBe('failing');
    expect(r.newState).toBe('failed');
  });
});

describe('buildStoryDevPrompt', () => {
  it('includes ACs, scope, and the BINDING request', () => {
    const p = buildStoryDevPrompt({ title: 'X', intent: 'y', acceptanceCriteria: [{ id: 'a1', text: 'does a' }], touches: ['src/**'], forbiddenAreas: ['secret/**'] });
    expect(p).toMatch(/\[a1\] does a/);
    expect(p).toMatch(/ONLY create\/modify files matching: src\/\*\*/);
    expect(p).toMatch(/NOT touch: secret\/\*\*/);
    expect(p).toMatch(/<BINDING>/);
  });
});

describe('selectHandler', () => {
  it('routes jobType story-dev', () => {
    expect(selectHandler({ jobType: 'story-dev' })).toBe(JOB_HANDLER_STORY_DEV);
  });
});

describe('runStoryDevJob (injected spawn)', () => {
  function fakeSpawn(stdout, code) {
    return () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.pid = 1234;
      setTimeout(() => {
        if (stdout) child.stdout.emit('data', Buffer.from(stdout));
        child.emit('close', code);
      }, 0);
      return child;
    };
  }
  const job = () => ({
    jobId: 'job-1', workingDir: mkdtempSync(join(tmpdir(), 'sdj-')),
    storyNodeRef: { storyId: 's1', planId: 'p1' },
    // These two tests exercise the LEGACY single-spawn dev loop, so pin the
    // split OFF. They used to pass with the split defaulting on only because
    // the test-author's throw fell OPEN to this same legacy path — that
    // fail-open was the pacman8 forbidden mechanism (2026-07-11) and is gone;
    // the split path now fails CLOSED (see pipelines/__tests__/
    // story-dev-pipeline.test.mjs for that contract).
    p3Flags: { P3_TEST_AUTHOR_SPLIT: 'off' },
    storyDevPayload: {
      storyId: 's1', planId: 'p1', appId: 'a', title: 'X', intent: 'y', complexity: 'standard',
      touches: ['src/**'], forbiddenAreas: ['secret/**'],
      acceptanceCriteria: [{ id: 'a1', text: 'does a', acClass: 'deterministic', testBinding: { status: 'unbound' } }],
    },
  });

  it('success path: completion done → updateStoryState(done) + propagate', async () => {
    const states = []; let propagated = false;
    const r = await runStoryDevJob({
      job: job(), eventLogDir: mkdtempSync(join(tmpdir(), 'log-')),
      deps: {
        spawn: fakeSpawn('<BINDING>{"a1":{"testRef":"t","testKind":"unit"}}</BINDING>', 0),
        headSha: 'SHA',
        executors: { unit: async () => ({ passed: true }) },
        updateStoryState: async (s) => states.push(s.state),
        propagateCompletion: async () => { propagated = true; },
        logger: { info() {}, warn() {}, error() {} },
      },
    });
    expect(r.exitCode).toBe(0);
    expect(r.newState).toBe('done');
    expect(states).toContain('done');
    expect(propagated).toBe(true);
  });

  it('non-zero exit → failed, no completion', async () => {
    const states = [];
    const r = await runStoryDevJob({
      job: job(), eventLogDir: mkdtempSync(join(tmpdir(), 'log-')),
      deps: { spawn: fakeSpawn('', 1), updateStoryState: async (s) => states.push(s.state), logger: { info() {}, warn() {}, error() {} } },
    });
    expect(r.exitCode).toBe(1);
    expect(r.newState).toBe('failed');
    expect(states).toEqual(['failed']);
  });
});
