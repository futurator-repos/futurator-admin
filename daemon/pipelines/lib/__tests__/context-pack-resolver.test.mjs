import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execSync } from 'node:child_process';
import { resolveAndSerializeContextPack } from '../context-pack-resolver.mjs';

function makeTmpProject() {
  const dir = mkdtempSync(join(tmpdir(), 'ctx-resolver-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'plan.md'), '# plan body\n', 'utf8');
  writeFileSync(join(dir, 'src', 'main.js'), '// main\n', 'utf8');
  execSync('git init -q && git add -A && git -c user.email=a@b.c -c user.name=A commit -q -m "init"', {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return dir;
}

function fakeDdb(epic, plan) {
  return {
    send: vi.fn(async (cmd) => {
      const params = cmd?.input || {};
      if (params.TableName?.includes('epic')) return { Item: epic };
      if (params.TableName?.includes('plan')) return { Item: plan };
      return { Item: null };
    }),
  };
}

describe('resolveAndSerializeContextPack', () => {
  let dir;

  beforeEach(() => {
    dir = makeTmpProject();
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a stub body (no failure thrown) when STORY_ID is missing', async () => {
    const out = await resolveAndSerializeContextPack({
      ddb: fakeDdb(null, null),
      job: { jobId: 'j1', workingDir: dir },
      variables: {},
    });
    expect(out.failure).toMatch(/STORY_ID/);
    expect(out.body).toContain('story-context-pack v1');
    expect(out.pack).toBeNull();
  });

  it('returns a disk-only pack when EPIC_ID is "(not provided)"', async () => {
    const out = await resolveAndSerializeContextPack({
      ddb: fakeDdb(null, null),
      job: { jobId: 'j1', workingDir: dir },
      variables: { STORY_ID: 'S-1', EPIC_ID: '(not provided)' },
    });
    expect(out.failure).toBeUndefined();
    expect(out.pack).not.toBeNull();
    expect(out.body).toContain('# Project context — story S-1');
  });

  it('looks up epic + plan from DDB and assembles a full pack', async () => {
    const story = {
      storyId: 'S-1',
      title: 'Build foo',
      description: 'foo desc',
      criteria: [{ id: 'AC-1', text: 'foo works' }],
      touchPoints: ['src/main.js'],
      wave: 0,
    };
    const epic = {
      epicId: 'E-1',
      planId: 'P-1',
      stories: [story],
      startedAt: '2026-01-01T00:00:00.000Z',
    };
    const plan = { planId: 'P-1', name: 'foo-plan', runCommand: 'npm run dev' };
    const ddb = fakeDdb(epic, plan);

    const out = await resolveAndSerializeContextPack({
      ddb,
      job: { jobId: 'j1', workingDir: dir },
      variables: { STORY_ID: 'S-1', EPIC_ID: 'E-1' },
    });
    expect(out.failure).toBeUndefined();
    expect(out.pack.runCommand).toBe('npm run dev');
    expect(out.pack.storySpec.id).toBe('S-1');
    expect(out.body).toContain('# Project context — story S-1');
    expect(out.body).toContain('npm run dev');
  });

  it('returns a stub body when DDB GetItem throws', async () => {
    const ddb = { send: vi.fn(async () => { throw new Error('access denied'); }) };
    const out = await resolveAndSerializeContextPack({
      ddb,
      job: { jobId: 'j1', workingDir: dir },
      variables: { STORY_ID: 'S-1', EPIC_ID: 'E-1' },
    });
    expect(out.failure).toMatch(/epic read failed/);
    expect(out.body).toContain('assembly skipped');
  });

  it('assembles prevWorkSummaries from sibling DONE stories with workSummary in same wave', async () => {
    const story = { storyId: 'S-2', title: 'B', wave: 0, touchPoints: ['src/main.js'] };
    const epic = {
      epicId: 'E-1',
      planId: 'P-1',
      stories: [
        { storyId: 'S-1', title: 'Prev A', wave: 0, status: 'done', workSummary: 'did A' },
        { storyId: 'S-X', title: 'Diff wave', wave: 1, status: 'done', workSummary: 'wrong wave' },
        { storyId: 'S-Y', title: 'Pending', wave: 0, status: 'pending', workSummary: 'not done' },
        story,
      ],
    };
    const out = await resolveAndSerializeContextPack({
      ddb: fakeDdb(epic, {}),
      job: { jobId: 'j1', workingDir: dir },
      variables: { STORY_ID: 'S-2', EPIC_ID: 'E-1' },
    });
    expect(out.pack.prevWorkSummaries).toHaveLength(1);
    expect(out.pack.prevWorkSummaries[0].storyId).toBe('S-1');
    expect(out.body).toContain('S-1 — Prev A');
  });
});
