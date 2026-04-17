import { describe, it, expect } from 'vitest';
import {
  createAgentJobSchema,
  createEpicDevJobSchema,
  epicDevJobPayloadSchema,
  storyManifestEntrySchema,
  waveResultSchema,
  storyOutcomeSchema,
} from '../agent-orchestrator-schema';

function validStoryEntry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    storyId: 'S-1',
    title: 'Thing',
    wave: 1,
    acceptanceCriteria: ['AC 1'],
    touchPoints: ['src/a.ts'],
    complexity: 'standard',
    reviewRigor: 'standard',
    ...overrides,
  };
}

function validPayload(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    orchestratorModel: 'opus',
    maxParallel: 4,
    maxRemediationRounds: 2,
    epicGoal: 'Ship it',
    contextDigest: 'digest',
    rubric: 'rules',
    stories: [validStoryEntry()],
    ...overrides,
  };
}

describe('storyManifestEntrySchema', () => {
  it('accepts a valid entry', () => {
    const r = storyManifestEntrySchema.safeParse(validStoryEntry());
    expect(r.success).toBe(true);
  });

  it('rejects empty touchPoints', () => {
    const r = storyManifestEntrySchema.safeParse(validStoryEntry({ touchPoints: [] }));
    expect(r.success).toBe(false);
  });

  it('rejects invalid complexity', () => {
    const r = storyManifestEntrySchema.safeParse(validStoryEntry({ complexity: 'bogus' }));
    expect(r.success).toBe(false);
  });

  it('rejects invalid reviewRigor', () => {
    const r = storyManifestEntrySchema.safeParse(validStoryEntry({ reviewRigor: 'tough' }));
    expect(r.success).toBe(false);
  });

  it('rejects wave < 1', () => {
    const r = storyManifestEntrySchema.safeParse(validStoryEntry({ wave: 0 }));
    expect(r.success).toBe(false);
  });

  it('defaults acceptanceCriteria to [] when omitted', () => {
    const { acceptanceCriteria: _ac, ...without } = validStoryEntry();
    const r = storyManifestEntrySchema.parse(without);
    expect(r.acceptanceCriteria).toEqual([]);
  });
});

describe('epicDevJobPayloadSchema', () => {
  it('accepts a valid payload', () => {
    expect(epicDevJobPayloadSchema.safeParse(validPayload()).success).toBe(true);
  });

  it('rejects maxParallel outside 1–32', () => {
    expect(epicDevJobPayloadSchema.safeParse(validPayload({ maxParallel: 0 })).success).toBe(false);
    expect(epicDevJobPayloadSchema.safeParse(validPayload({ maxParallel: 33 })).success).toBe(
      false,
    );
  });

  it('rejects orchestratorModel not in opus|sonnet', () => {
    expect(
      epicDevJobPayloadSchema.safeParse(validPayload({ orchestratorModel: 'haiku' })).success,
    ).toBe(false);
  });

  it('rejects empty stories list', () => {
    expect(epicDevJobPayloadSchema.safeParse(validPayload({ stories: [] })).success).toBe(false);
  });

  it('rejects empty epicGoal', () => {
    expect(epicDevJobPayloadSchema.safeParse(validPayload({ epicGoal: '' })).success).toBe(false);
  });
});

describe('createEpicDevJobSchema', () => {
  function valid() {
    return {
      workingDir: '/tmp/project',
      epicId: 'EPIC-1',
      projectId: 'PROJ-1',
      phase: 'epic-dev' as const,
      payload: validPayload(),
    };
  }

  it('accepts a full valid input', () => {
    expect(createEpicDevJobSchema.safeParse(valid()).success).toBe(true);
  });

  it('rejects relative workingDir', () => {
    const r = createEpicDevJobSchema.safeParse({ ...valid(), workingDir: 'relative/path' });
    expect(r.success).toBe(false);
  });

  it('rejects phase != epic-dev', () => {
    const r = createEpicDevJobSchema.safeParse({ ...valid(), phase: 'legacy' });
    expect(r.success).toBe(false);
  });

  it('accepts optional resumeFromWaveResults', () => {
    const resume = {
      '1': {
        waveNumber: 1,
        stories: {
          'S-1': {
            status: 'APPROVED' as const,
            attempts: 1,
            reviewAttempts: 1,
            filesTouched: ['src/a.ts'],
          },
        },
        durationMs: 10_000,
        completedAt: Date.now(),
      },
    };
    const r = createEpicDevJobSchema.safeParse({ ...valid(), resumeFromWaveResults: resume });
    expect(r.success).toBe(true);
  });
});

describe('storyOutcomeSchema', () => {
  it('accepts APPROVED without blocker', () => {
    const r = storyOutcomeSchema.safeParse({
      status: 'APPROVED',
      attempts: 1,
      reviewAttempts: 1,
      filesTouched: ['src/a.ts'],
    });
    expect(r.success).toBe(true);
  });

  it('accepts BLOCKED with blocker record', () => {
    const r = storyOutcomeSchema.safeParse({
      status: 'BLOCKED',
      attempts: 2,
      reviewAttempts: 1,
      filesTouched: [],
      blocker: {
        code: 'context-gap',
        severity: 'hard',
        description: 'missing context',
        detectedAt: 123,
      },
    });
    expect(r.success).toBe(true);
  });

  it('rejects invalid blocker code', () => {
    const r = storyOutcomeSchema.safeParse({
      status: 'BLOCKED',
      attempts: 1,
      reviewAttempts: 1,
      filesTouched: [],
      blocker: {
        code: 'bogus-code',
        severity: 'hard',
        description: 'x',
        detectedAt: 123,
      },
    });
    expect(r.success).toBe(false);
  });
});

describe('waveResultSchema', () => {
  it('accepts a minimal wave result', () => {
    const r = waveResultSchema.safeParse({
      waveNumber: 1,
      stories: {},
      durationMs: 0,
      completedAt: 0,
    });
    expect(r.success).toBe(true);
  });

  it('rejects waveNumber < 1', () => {
    const r = waveResultSchema.safeParse({
      waveNumber: 0,
      stories: {},
      durationMs: 0,
      completedAt: 0,
    });
    expect(r.success).toBe(false);
  });
});

describe('createAgentJobSchema (legacy path unchanged)', () => {
  it('still validates the legacy pipeline-based job shape', () => {
    const r = createAgentJobSchema.safeParse({
      workingDir: '/tmp/a',
      pipeline: {
        agents: { main: { name: 'Primary' } },
        steps: [{ id: 'step-1', agentId: 'main', prompt: 'do it' }],
      },
    });
    expect(r.success).toBe(true);
  });
});
