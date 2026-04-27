import { describe, it, expect } from 'vitest';
import {
  generateWaveCompilePipeline,
  WAVE_COMPILE_PROMPT_PLACEHOLDER,
} from '../wave-compile-pipeline';
import type { EpicStory } from '../../types/epic-workflow';

function makeStory(id: string, overrides: Partial<EpicStory> = {}): EpicStory {
  return {
    storyId: id,
    order: 0,
    title: `Story ${id}`,
    description: 'a story',
    status: 'done',
    workSummary: `summary for ${id}`,
    touchPoints: [`src/${id}.js`],
    ...overrides,
  } as EpicStory;
}

describe('generateWaveCompilePipeline', () => {
  it('builds a 3-step pipeline (prepare, knowledge, sync) in order', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1'), makeStory('S-2')],
    });

    expect(pipeline.steps.map((s) => s.id)).toEqual([
      'wave-compile-prepare',
      'wave-compile-knowledge',
      'wave-compile-sync',
    ]);
  });

  it('uses the COMPILER agent with the haiku default model', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1')],
    });
    expect(pipeline.agents.COMPILER.model).toBe('haiku');
    expect(pipeline.agents.COMPILER.allowedTools).toContain('Write');
  });

  it('honors COMPILER_MODEL env override', () => {
    const original = process.env.COMPILER_MODEL;
    process.env.COMPILER_MODEL = 'sonnet';
    try {
      const pipeline = generateWaveCompilePipeline({
        workingDir: '/home/ubuntu/projects/foo',
        epicId: 'E-1',
        wave: 0,
        stories: [makeStory('S-1')],
      });
      expect(pipeline.agents.COMPILER.model).toBe('sonnet');
    } finally {
      if (original === undefined) delete process.env.COMPILER_MODEL;
      else process.env.COMPILER_MODEL = original;
    }
  });

  it('explicit compilerModel beats the env var', () => {
    const original = process.env.COMPILER_MODEL;
    process.env.COMPILER_MODEL = 'sonnet';
    try {
      const pipeline = generateWaveCompilePipeline({
        workingDir: '/home/ubuntu/projects/foo',
        epicId: 'E-1',
        wave: 0,
        stories: [makeStory('S-1')],
        compilerModel: 'haiku',
      });
      expect(pipeline.agents.COMPILER.model).toBe('haiku');
    } finally {
      if (original === undefined) delete process.env.COMPILER_MODEL;
      else process.env.COMPILER_MODEL = original;
    }
  });

  it('declares concurrencyClass=background by default (Story E.4)', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1')],
    });
    expect(pipeline.concurrencyClass).toBe('background');
  });

  it('serializes stories into WAVE_STORY_MANIFEST initialVariable', () => {
    const stories = [
      makeStory('S-1', { workSummary: 'did A' }),
      makeStory('S-2', { workSummary: 'did B' }),
    ];
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 2,
      stories,
    });
    const manifest = JSON.parse(pipeline.initialVariables!.WAVE_STORY_MANIFEST);
    expect(manifest).toHaveLength(2);
    expect(manifest[0].storyId).toBe('S-1');
    expect(manifest[0].workSummary).toBe('did A');
    expect(manifest[1].storyId).toBe('S-2');
  });

  it('exposes the placeholder prompt on the agent step (daemon swaps before spawn)', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1')],
    });
    const knowledgeStep = pipeline.steps.find((s) => s.id === 'wave-compile-knowledge')!;
    expect(knowledgeStep.prompt).toBe(WAVE_COMPILE_PROMPT_PLACEHOLDER);
  });

  it('extracts WAVE_KNOWLEDGE_OUTPUT block from compiler output', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1')],
    });
    const knowledgeStep = pipeline.steps.find((s) => s.id === 'wave-compile-knowledge')!;
    expect(knowledgeStep.extractors).toEqual({
      WAVE_KNOWLEDGE_OUTPUT: {
        type: 'between',
        startDelimiter: '---WAVE_KNOWLEDGE_OUTPUT---',
        endDelimiter: '---END_WAVE_KNOWLEDGE_OUTPUT---',
      },
    });
  });

  it('uses the wave-start SHA in the prepare step diff command when provided', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1'), makeStory('S-2')],
      waveStartSha: 'abc1234',
    });
    const prepare = pipeline.steps.find((s) => s.id === 'wave-compile-prepare')!;
    expect(prepare.command).toContain('git diff --name-status abc1234 HEAD');
  });

  it('falls back to HEAD~<storyCount> when waveStartSha is omitted', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1'), makeStory('S-2'), makeStory('S-3')],
    });
    const prepare = pipeline.steps.find((s) => s.id === 'wave-compile-prepare')!;
    expect(prepare.command).toContain('git diff --name-status HEAD~3 HEAD');
  });

  it('sync step verifies S3 mirror is non-empty (Story A.4 contract relocated)', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1')],
    });
    const sync = pipeline.steps.find((s) => s.id === 'wave-compile-sync')!;
    expect(sync.command).toContain('graph-sync.mjs');
    expect(sync.command).toContain('aws s3 sync');
    expect(sync.command).toContain('EMPTY_S3_MIRROR');
    expect(sync.command).not.toContain('S3 backup skipped');
  });

  it('records pipelineKind=wave-compile + version on the result', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/foo',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1')],
    });
    expect(pipeline.pipelineKind).toBe('wave-compile');
    expect(pipeline.pipelineVersion).toBeGreaterThan(0);
  });

  it('derives projectId from workingDir when not explicitly passed', () => {
    const pipeline = generateWaveCompilePipeline({
      workingDir: '/home/ubuntu/projects/brick-breaker/',
      epicId: 'E-1',
      wave: 0,
      stories: [makeStory('S-1')],
    });
    expect(pipeline.initialVariables!.PROJECT_ID).toBe('brick-breaker');
    const sync = pipeline.steps.find((s) => s.id === 'wave-compile-sync')!;
    expect(sync.command).toContain('--project brick-breaker');
    expect(sync.command).toContain('knowledge-live/brick-breaker/');
  });
});
