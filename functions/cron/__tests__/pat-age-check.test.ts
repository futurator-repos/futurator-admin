/**
 * pat-age-check.test.ts — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Unit tests for the PAT age check cron handler.
 *
 * Strategy:
 *   - Mock the SSM client (via rotate-pat module) so no real AWS calls.
 *   - Mock attention-items-repository to capture writes.
 *   - Inject controlled time via vi.setSystemTime().
 *
 * 5 test cases:
 *   1. rotatedAt < 80 days ago → no attention item written (existing resolved if present)
 *   2. rotatedAt > 80 days ago → writes 'low' severity attention item
 *   3. rotatedAt > 100 days ago → writes 'medium' severity attention item
 *   4. rotatedAt = null (never set) → writes info ('low') attention item about missing timestamp
 *   5. Already has an open item → createAttentionItem called (overwrites stable itemId, no duplicate)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── 1. Mock @aws-sdk/client-ssm ───────────────────────────────────────────────
vi.mock('@aws-sdk/client-ssm', () => ({
  SSMClient: class SSMClient {
    send = vi.fn();
  },
  PutParameterCommand: vi.fn(),
  GetParameterCommand: vi.fn(),
  ParameterNotFound: class ParameterNotFound extends Error {
    constructor() {
      super('ParameterNotFound');
      this.name = 'ParameterNotFound';
    }
  },
}));

// ── 2. Mock rotate-pat so SSM reads are controlled ───────────────────────────
const rotateMocks = vi.hoisted(() => ({
  readRotatedAt: vi.fn(),
  rotatePat: vi.fn(),
  SSM_PAT_PATH: '/futurator/_pipeline/github-pat',
  SSM_PAT_ROTATED_AT_PATH: '/futurator/_pipeline/github-pat-rotated-at',
  InvalidPatError: class InvalidPatError extends Error {
    constructor(m: string) {
      super(m);
      this.name = 'InvalidPatError';
    }
  },
  ParameterNotFound: class ParameterNotFound extends Error {
    constructor() {
      super('ParameterNotFound');
      this.name = 'ParameterNotFound';
    }
  },
}));

vi.mock('../../shared/github/rotate-pat', () => rotateMocks);

// ── 3. Mock attention-items-repository ───────────────────────────────────────
const attentionMocks = vi.hoisted(() => ({
  createAttentionItem: vi.fn().mockResolvedValue(undefined),
  getAttentionItem: vi.fn().mockResolvedValue(null),
  updateAttentionStatus: vi.fn().mockResolvedValue(null),
  listAttentionItems: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../shared/repositories/attention-items-repository', () => attentionMocks);

// ── 4. Import handler AFTER mocks ─────────────────────────────────────────────
import { handler } from '../pat-age-check';

// ── Helpers ───────────────────────────────────────────────────────────────────

const NOW = new Date('2026-04-28T09:00:00.000Z');

function daysAgo(days: number): string {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('pat-age-check handler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.clearAllMocks();
    // Default: no existing attention item
    attentionMocks.getAttentionItem.mockResolvedValue(null);
    attentionMocks.createAttentionItem.mockResolvedValue(undefined);
    attentionMocks.updateAttentionStatus.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Test 1: < 80 days → no new item, existing open item resolved
  it('resolves existing item and writes nothing when PAT is < 80 days old', async () => {
    rotateMocks.readRotatedAt.mockResolvedValueOnce(daysAgo(30));
    // Simulate an existing open item
    attentionMocks.getAttentionItem.mockResolvedValueOnce({
      planId: '_system',
      itemId: 'github-pat-age-sentinel',
      status: 'open',
      createdAt: daysAgo(5),
      resolvedAt: null,
    });

    await handler();

    // Should not write a new item
    expect(attentionMocks.createAttentionItem).not.toHaveBeenCalled();
    // Should resolve the existing open item
    expect(attentionMocks.updateAttentionStatus).toHaveBeenCalledWith(
      '_system',
      'github-pat-age-sentinel',
      'resolved',
    );
  });

  // Test 2: > 80 days → 'low' severity attention item
  it('writes a low-severity attention item when PAT is 81 days old', async () => {
    rotateMocks.readRotatedAt.mockResolvedValueOnce(daysAgo(81));

    await handler();

    expect(attentionMocks.createAttentionItem).toHaveBeenCalledOnce();
    const item = attentionMocks.createAttentionItem.mock.calls[0][0];
    expect(item.planId).toBe('_system');
    expect(item.severity).toBe('low');
    expect(item.status).toBe('open');
    expect(item.title).toMatch(/GitHub PAT/);
    // PAT value must not appear in the attention item
    expect(JSON.stringify(item)).not.toContain('ghp_');
  });

  // Test 3: > 100 days → 'medium' severity
  it('writes a medium-severity attention item when PAT is 101 days old', async () => {
    rotateMocks.readRotatedAt.mockResolvedValueOnce(daysAgo(101));

    await handler();

    expect(attentionMocks.createAttentionItem).toHaveBeenCalledOnce();
    const item = attentionMocks.createAttentionItem.mock.calls[0][0];
    expect(item.severity).toBe('medium');
    // The day count appears in the body; the title includes the date
    expect(item.title).toMatch(/GitHub PAT due for rotation/);
    expect(item.body).toMatch(/101 day/);
  });

  // Test 4: rotatedAt = null → informational 'low' item about missing timestamp
  it('writes a low-severity info item when rotation timestamp has never been set', async () => {
    rotateMocks.readRotatedAt.mockResolvedValueOnce(null);

    await handler();

    expect(attentionMocks.createAttentionItem).toHaveBeenCalledOnce();
    const item = attentionMocks.createAttentionItem.mock.calls[0][0];
    expect(item.severity).toBe('low');
    expect(item.title).toMatch(/missing/);
    expect(item.body).toMatch(/Settings → GitHub/);
  });

  // Test 5: Item already open → createAttentionItem overwrites (no duplicate row)
  //         The stable itemId ensures only one row per sentinel category.
  it('overwrites the existing item without creating a duplicate row', async () => {
    const existingItem = {
      planId: '_system',
      itemId: 'github-pat-age-sentinel',
      status: 'open',
      createdAt: daysAgo(10),
      resolvedAt: null,
      severity: 'low',
      title: 'GitHub PAT due for rotation (last rotated 2026-02-06)',
    };
    attentionMocks.getAttentionItem.mockResolvedValueOnce(existingItem);
    rotateMocks.readRotatedAt.mockResolvedValueOnce(daysAgo(85));

    await handler();

    // createAttentionItem is called once — overwrites by stable itemId
    expect(attentionMocks.createAttentionItem).toHaveBeenCalledOnce();
    // The createdAt is preserved from the existing item
    const written = attentionMocks.createAttentionItem.mock.calls[0][0];
    expect(written.createdAt).toBe(existingItem.createdAt);
    // No duplicate: called exactly once
    expect(attentionMocks.createAttentionItem).toHaveBeenCalledTimes(1);
  });
});
