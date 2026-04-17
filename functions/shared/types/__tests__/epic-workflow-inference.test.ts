import { describe, it, expect } from 'vitest';
import type { EpicStory, StoryComplexity, ReviewRigor, InferenceMetadata } from '../epic-workflow';

describe('EpicStory inference fields (EO-3.1)', () => {
  it('accepts a story with fully-populated inference fields', () => {
    const story: EpicStory = {
      storyId: 'STORY-1',
      order: 1,
      title: 'Add cost chart',
      description: 'Renders daily costs.',
      status: 'pending',
      touchPoints: ['src/hooks/use-costs.ts', 'src/components/admin/costs/cost-chart.tsx'],
      complexity: 'standard',
      reviewRigor: 'standard',
      inferenceMetadata: {
        inferredAt: '2026-04-17T00:00:00.000Z',
        model: 'haiku',
        confidence: 'medium',
        reasoning: 'clear path match',
        retries: 0,
      },
    };
    expect(story.touchPoints).toHaveLength(2);
    expect(story.complexity).toBe('standard');
    expect(story.inferenceMetadata?.model).toBe('haiku');
  });

  it('tolerates stories without any inference fields (pre-inference)', () => {
    const story: EpicStory = {
      storyId: 'STORY-2',
      order: 2,
      title: 'Legacy story',
      description: 'No inference yet.',
      status: 'pending',
    };
    expect(story.touchPoints).toBeUndefined();
    expect(story.complexity).toBeUndefined();
    expect(story.inferenceMetadata).toBeUndefined();
  });

  it('narrows StoryComplexity and ReviewRigor to the documented unions', () => {
    const complexities: StoryComplexity[] = ['trivial', 'standard', 'complex', 'architectural'];
    const rigors: ReviewRigor[] = ['light', 'standard', 'strict'];
    expect(complexities).toHaveLength(4);
    expect(rigors).toHaveLength(3);
  });

  it('InferenceMetadata.model is frozen to the string literal "haiku"', () => {
    const md: InferenceMetadata = {
      inferredAt: '2026-04-17T00:00:00.000Z',
      model: 'haiku',
      confidence: 'high',
    };
    expect(md.model).toBe('haiku');
  });
});
