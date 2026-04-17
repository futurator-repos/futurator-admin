import { describe, it, expect } from 'vitest';
import { resolveBlockerSchema } from '../resolve-blocker-schema';

describe('resolveBlockerSchema', () => {
  describe('amend', () => {
    it('accepts a valid amend body with touchPoints edit', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: { touchPoints: ['src/hooks/use-costs.ts'] },
        reason: 'Needed clarification on timezone',
      });
      expect(result.success).toBe(true);
    });

    it('accepts an amend body with criteria edit', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: {
          criteria: [{ id: 'AC-1', text: 'Aggregate in UTC', needsBrowser: false }],
        },
        reason: 'Specify timezone',
      });
      expect(result.success).toBe(true);
    });

    it('rejects amend with empty amendedStory', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: {},
        reason: 'No changes',
      });
      expect(result.success).toBe(false);
    });

    it('rejects amend with empty reason', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: { title: 'Updated' },
        reason: '',
      });
      expect(result.success).toBe(false);
    });

    it('rejects amend with over-long reason', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: { title: 'Updated' },
        reason: 'x'.repeat(1001),
      });
      expect(result.success).toBe(false);
    });

    it('rejects amend with empty touchPoints array', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: { touchPoints: [] },
        reason: 'Fix touch points',
      });
      expect(result.success).toBe(false);
    });

    it('rejects amend with invalid complexity', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: { complexity: 'huge' },
        reason: 'Bump complexity',
      });
      expect(result.success).toBe(false);
    });

    it('accepts amend with expectedBlockerReportedAt', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'amend',
        amendedStory: { title: 'Updated' },
        reason: 'Fix title',
        expectedBlockerReportedAt: '2026-04-17T14:22:11.331Z',
      });
      expect(result.success).toBe(true);
    });
  });

  describe('skip', () => {
    it('accepts a valid skip body', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'skip',
        reason: 'Moving this story to a follow-up epic',
      });
      expect(result.success).toBe(true);
    });

    it('rejects skip with missing reason', () => {
      const result = resolveBlockerSchema.safeParse({ action: 'skip' });
      expect(result.success).toBe(false);
    });

    it('rejects skip with empty reason', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'skip',
        reason: '',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('retry', () => {
    it('accepts a valid retry with default resumeImmediately', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'retry',
        reason: 'Dependency installed',
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.action === 'retry') {
        expect(result.data.resumeImmediately).toBe(true);
      }
    });

    it('accepts retry with explicit resumeImmediately=false', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'retry',
        reason: 'Review before running',
        resumeImmediately: false,
      });
      expect(result.success).toBe(true);
      if (result.success && result.data.action === 'retry') {
        expect(result.data.resumeImmediately).toBe(false);
      }
    });
  });

  describe('discriminated union', () => {
    it('rejects unknown action', () => {
      const result = resolveBlockerSchema.safeParse({
        action: 'ignore',
        reason: 'hack',
      });
      expect(result.success).toBe(false);
    });

    it('rejects body with no action', () => {
      const result = resolveBlockerSchema.safeParse({ reason: 'hack' });
      expect(result.success).toBe(false);
    });
  });
});
