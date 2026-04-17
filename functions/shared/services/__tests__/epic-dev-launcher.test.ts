import { describe, it, expect } from 'vitest';
import { validateEpicForOrchestratorStart } from '../epic-dev-launcher';
import type { EpicWorkflow } from '../../types/epic-workflow';

function makeEpic(overrides: Partial<EpicWorkflow> = {}): EpicWorkflow {
  return {
    epicId: 'EPIC-1',
    title: 'Ship feature X',
    description: 'Epic description',
    acceptanceCriteria: '',
    workingDir: '/home/ubuntu/projects/alpha',
    status: 'ready',
    stories: [
      {
        storyId: 'S-1',
        order: 1,
        title: 'Story 1',
        description: '',
        status: 'pending',
        wave: 1,
        touchPoints: ['src/a.ts'],
        complexity: 'standard',
        reviewRigor: 'standard',
        criteria: [{ id: 'AC-1', text: 'criterion 1', needsBrowser: false }],
      },
    ],
    useEpicOrchestrator: true,
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

describe('validateEpicForOrchestratorStart', () => {
  it('builds a valid payload when everything is in place', () => {
    const r = validateEpicForOrchestratorStart(makeEpic());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.orchestratorModel).toBe('opus');
    expect(r.payload.maxParallel).toBe(4);
    expect(r.payload.maxRemediationRounds).toBe(2);
    expect(r.payload.epicGoal).toBe('Ship feature X');
    expect(r.payload.stories).toHaveLength(1);
    expect(r.payload.stories[0].acceptanceCriteria).toEqual(['criterion 1']);
    expect(r.payload.stories[0].touchPoints).toEqual(['src/a.ts']);
    expect(r.payload.stories[0].wave).toBe(1);
  });

  it('applies overrides', () => {
    const r = validateEpicForOrchestratorStart(makeEpic(), {
      orchestratorModel: 'sonnet',
      maxParallel: 8,
      maxRemediationRounds: 5,
      rubric: 'RULES',
      contextDigest: 'DIGEST',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.orchestratorModel).toBe('sonnet');
    expect(r.payload.maxParallel).toBe(8);
    expect(r.payload.maxRemediationRounds).toBe(5);
    expect(r.payload.rubric).toBe('RULES');
    expect(r.payload.contextDigest).toBe('DIGEST');
  });

  it('returns flag-disabled when useEpicOrchestrator is false', () => {
    const r = validateEpicForOrchestratorStart(makeEpic({ useEpicOrchestrator: false }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('flag-disabled');
  });

  it('returns flag-disabled when flag is absent', () => {
    const epic = makeEpic();
    delete (epic as { useEpicOrchestrator?: boolean }).useEpicOrchestrator;
    const r = validateEpicForOrchestratorStart(epic);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('flag-disabled');
  });

  it('returns invalid-status when epic is not ready/fixing', () => {
    const r = validateEpicForOrchestratorStart(makeEpic({ status: 'draft' }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('invalid-status');
  });

  it('accepts status=fixing', () => {
    const r = validateEpicForOrchestratorStart(makeEpic({ status: 'fixing' }));
    expect(r.ok).toBe(true);
  });

  it('returns no-stories when epic has no stories', () => {
    const r = validateEpicForOrchestratorStart(makeEpic({ stories: [] }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('no-stories');
  });

  it('returns inference-missing with story IDs when touchPoints missing', () => {
    const epic = makeEpic();
    epic.stories[0].touchPoints = [];
    const r = validateEpicForOrchestratorStart(epic);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('inference-missing');
    expect(r.missingInferenceFor).toEqual(['S-1']);
  });

  it('returns inference-missing when complexity is unset', () => {
    const epic = makeEpic();
    delete epic.stories[0].complexity;
    const r = validateEpicForOrchestratorStart(epic);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('inference-missing');
  });

  it('returns inference-missing when reviewRigor is unset', () => {
    const epic = makeEpic();
    delete epic.stories[0].reviewRigor;
    const r = validateEpicForOrchestratorStart(epic);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('inference-missing');
  });

  it('defaults wave to 1 when absent', () => {
    const epic = makeEpic();
    delete epic.stories[0].wave;
    const r = validateEpicForOrchestratorStart(epic);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.stories[0].wave).toBe(1);
  });

  it('defaults contextDigest to epic.description', () => {
    const r = validateEpicForOrchestratorStart(makeEpic({ description: 'some ctx' }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.contextDigest).toBe('some ctx');
  });
});
