import { describe, expect, it } from 'vitest';
import { dedupeAttentionItems } from '../use-attention-items';
import type { AttentionItem } from '../../../functions/shared/types/attention';

function makeItem(overrides: Partial<AttentionItem> & { createdAt: string }): AttentionItem {
  return {
    planId: 'plan-1',
    itemId: `item-${Math.random().toString(36).slice(2)}`,
    resolvedAt: null,
    severity: 'high',
    category: 'retry-exhausted',
    title: 'Default title',
    body: '',
    context: {},
    suggestedActions: [],
    status: 'open',
    ...overrides,
  };
}

describe('dedupeAttentionItems', () => {
  it('collapses duplicates within the 60s window', () => {
    const items = [
      makeItem({
        createdAt: '2026-04-22T12:00:00.000Z',
        title: 'Pacman died',
        context: { storyId: 'S-1' },
      }),
      makeItem({
        createdAt: '2026-04-22T12:00:20.000Z',
        title: 'Pacman died',
        context: { storyId: 'S-1' },
      }),
      makeItem({
        createdAt: '2026-04-22T12:00:55.000Z',
        title: 'Pacman died',
        context: { storyId: 'S-1' },
      }),
    ];
    const result = dedupeAttentionItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].duplicateCount).toBe(2);
    // Keeps the earliest createdAt.
    expect(result[0].createdAt).toBe('2026-04-22T12:00:00.000Z');
  });

  it('keeps separate buckets when gap exceeds the 60s window', () => {
    const items = [
      makeItem({
        createdAt: '2026-04-22T12:00:00.000Z',
        title: 'Shell guard refused',
        context: { storyId: 'S-1' },
      }),
      makeItem({
        createdAt: '2026-04-22T12:02:01.000Z',
        title: 'Shell guard refused',
        context: { storyId: 'S-1' },
      }),
    ];
    const result = dedupeAttentionItems(items);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.duplicateCount === 0)).toBe(true);
  });

  it('does not dedupe across different story ids', () => {
    const items = [
      makeItem({
        createdAt: '2026-04-22T12:00:00.000Z',
        title: 'Retry exhausted',
        context: { storyId: 'S-1' },
      }),
      makeItem({
        createdAt: '2026-04-22T12:00:05.000Z',
        title: 'Retry exhausted',
        context: { storyId: 'S-2' },
      }),
    ];
    const result = dedupeAttentionItems(items);
    expect(result).toHaveLength(2);
  });

  it('treats items without a storyId as the same bucket when titles match', () => {
    const items = [
      makeItem({
        createdAt: '2026-04-22T12:00:00.000Z',
        title: 'Daemon shutdown',
        context: {},
      }),
      makeItem({
        createdAt: '2026-04-22T12:00:30.000Z',
        title: 'Daemon shutdown',
        context: {},
      }),
    ];
    const result = dedupeAttentionItems(items);
    expect(result).toHaveLength(1);
    expect(result[0].duplicateCount).toBe(1);
  });
});
