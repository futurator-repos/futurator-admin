import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { generateStoryPipeline, isWaveCloseCompilerEnabled } from '../story-pipeline';
import type { EpicStory } from '../../types/epic-workflow';

const story: EpicStory = {
  storyId: 'S-1',
  order: 0,
  title: 'A test story',
  description: 'AC: it works.',
  status: 'pending',
  touchPoints: ['src/main.js'],
} as EpicStory;

describe('Story E.1 — WAVE_CLOSE_COMPILER_ENABLED feature flag', () => {
  let original: string | undefined;

  beforeEach(() => {
    original = process.env.WAVE_CLOSE_COMPILER_ENABLED;
  });

  afterEach(() => {
    if (original === undefined) delete process.env.WAVE_CLOSE_COMPILER_ENABLED;
    else process.env.WAVE_CLOSE_COMPILER_ENABLED = original;
  });

  it('default (flag absent) — per-story compile-knowledge + compile-sync stay in the pipeline', () => {
    delete process.env.WAVE_CLOSE_COMPILER_ENABLED;
    expect(isWaveCloseCompilerEnabled()).toBe(false);
    const pipeline = generateStoryPipeline(story, 'Test Epic', '/home/ubuntu/projects/foo', {
      rigor: 'prototype', // skip TEST steps to keep the pipeline minimal
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('compile-commit-on-pass');
    expect(ids).toContain('compile-diff');
    expect(ids).toContain('compile-knowledge');
    expect(ids).toContain('compile-sync');
  });

  it('flag=false (explicit) — same legacy behavior', () => {
    process.env.WAVE_CLOSE_COMPILER_ENABLED = 'false';
    expect(isWaveCloseCompilerEnabled()).toBe(false);
    const pipeline = generateStoryPipeline(story, 'Test Epic', '/home/ubuntu/projects/foo', {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('compile-knowledge');
    expect(ids).toContain('compile-sync');
  });

  it('flag=true — compile-knowledge + compile-sync are excluded; commit + diff stay', () => {
    process.env.WAVE_CLOSE_COMPILER_ENABLED = 'true';
    expect(isWaveCloseCompilerEnabled()).toBe(true);
    const pipeline = generateStoryPipeline(story, 'Test Epic', '/home/ubuntu/projects/foo', {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    // The wave-close compiler still needs the per-story commit + diff to consume.
    expect(ids).toContain('compile-commit-on-pass');
    expect(ids).toContain('compile-diff');
    // But the per-story knowledge work is gone.
    expect(ids).not.toContain('compile-knowledge');
    expect(ids).not.toContain('compile-sync');
  });

  it('flag=true — per-story pipeline ends after compile-diff', () => {
    process.env.WAVE_CLOSE_COMPILER_ENABLED = 'true';
    const pipeline = generateStoryPipeline(story, 'Test Epic', '/home/ubuntu/projects/foo', {
      rigor: 'prototype',
    });
    const lastStepId = pipeline.steps[pipeline.steps.length - 1].id;
    expect(lastStepId).toBe('compile-diff');
  });

  it('flag toggling does not affect dev/review steps (only compile-* steps gated)', () => {
    process.env.WAVE_CLOSE_COMPILER_ENABLED = 'true';
    const pipeline = generateStoryPipeline(story, 'Test Epic', '/home/ubuntu/projects/foo', {
      rigor: 'prototype',
    });
    const ids = pipeline.steps.map((s) => s.id);
    expect(ids).toContain('dev');
    expect(ids).toContain('review');
    expect(ids).toContain('retry');
  });
});
