/**
 * stream-archive.test.mjs — Pipeline v2 Phase 2-B / Story 2-B-6-1 (PR-100).
 */

import { describe, it, expect } from 'vitest';
import {
  isStreamIdle,
  streamArchiveName,
  buildGraduationProposal,
  buildStreamIdleAttention,
  STREAM_CONSTANTS,
} from '../stream-archive.mjs';

describe('isStreamIdle', () => {
  it('false for non-stream branches', () => {
    const r = isStreamIdle({
      branchName: 'main',
      lastCommitAt: '2026-01-01T00:00:00Z',
    });
    expect(r.isStream).toBe(false);
    expect(r.isIdle).toBe(false);
  });

  it('true when ≥ 30 days idle', () => {
    const r = isStreamIdle({
      branchName: 'stream/live-perf',
      lastCommitAt: '2026-03-01T00:00:00Z',
      now: () => Date.parse('2026-05-15T00:00:00Z'),
    });
    expect(r.isStream).toBe(true);
    expect(r.isIdle).toBe(true);
    expect(r.ageDays).toBeGreaterThanOrEqual(30);
  });

  it('false when under threshold', () => {
    const r = isStreamIdle({
      branchName: 'stream/live-perf',
      lastCommitAt: '2026-05-01T00:00:00Z',
      now: () => Date.parse('2026-05-15T00:00:00Z'),
    });
    expect(r.isStream).toBe(true);
    expect(r.isIdle).toBe(false);
  });

  it('respects custom threshold', () => {
    const r = isStreamIdle({
      branchName: 'stream/xy',
      lastCommitAt: '2026-05-01T00:00:00Z',
      now: () => Date.parse('2026-05-15T00:00:00Z'),
      thresholdDays: 7,
    });
    expect(r.isIdle).toBe(true);
  });

  it('isStream=true but isIdle=false on unparseable date', () => {
    const r = isStreamIdle({
      branchName: 'stream/xy',
      lastCommitAt: 'not a date',
    });
    expect(r.isStream).toBe(true);
    expect(r.isIdle).toBe(false);
  });
});

describe('streamArchiveName', () => {
  it('emits archive/stream-<name>-<YYYYMMDD>', () => {
    const out = streamArchiveName({
      branchName: 'stream/live-perf-teleprompter',
      archivedAt: new Date('2026-05-15T00:00:00Z'),
    });
    expect(out).toBe('archive/stream-live-perf-teleprompter-20260515');
  });

  it('rejects non-stream branchName', () => {
    expect(() => streamArchiveName({ branchName: 'main' })).toThrow(/stream\//);
  });

  it('rejects bad slug after stream/ prefix', () => {
    expect(() => streamArchiveName({ branchName: 'stream/BAD' })).toThrow(/kebab-case/);
  });

  it('handles string date input', () => {
    const out = streamArchiveName({
      branchName: 'stream/xy',
      archivedAt: '2026-01-02T00:00:00Z',
    });
    expect(out).toBe('archive/stream-xy-20260102');
  });
});

describe('buildGraduationProposal', () => {
  it('extracts stream name + builds plan shape', () => {
    const p = buildGraduationProposal({
      branchName: 'stream/live-perf',
      planIntent: 'extract teleprompter',
    });
    expect(p.streamName).toBe('live-perf');
    expect(p.planSlug).toBe('live-perf');
    expect(p.intent).toBe('extract teleprompter');
    expect(p.sourceBranch).toBe('stream/live-perf');
    expect(p.planKind).toBe('change');
  });

  it('defaults intent when not provided', () => {
    const p = buildGraduationProposal({ branchName: 'stream/xy' });
    expect(p.intent).toMatch(/Graduating stream\/xy/);
  });

  it('rejects bad branchName', () => {
    expect(() => buildGraduationProposal({ branchName: 'main' })).toThrow();
    expect(() => buildGraduationProposal({ branchName: 'stream/BAD' })).toThrow();
  });
});

describe('buildStreamIdleAttention', () => {
  it('shapes a low-severity item with operator paths', () => {
    const item = buildStreamIdleAttention({ branchName: 'stream/xy', ageDays: 31 });
    expect(item.severity).toBe('low');
    expect(item.category).toBe('stream-idle');
    expect(item.actions).toContain('graduate-to-plan');
    expect(item.actions).toContain('archive-now');
    expect(item.body).toContain('31 days');
  });
});

describe('STREAM_CONSTANTS', () => {
  it('30-day threshold', () => {
    expect(STREAM_CONSTANTS.idleThresholdDays).toBe(30);
  });
});
