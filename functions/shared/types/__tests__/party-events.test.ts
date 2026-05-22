import { describe, it, expect } from 'vitest';
import { parsePartyEvent, isCheckpointEvent } from '../party-events';
import type { PartyEvent } from '../party';

function raw(eventType: PartyEvent['eventType'], payload: Record<string, unknown>): PartyEvent {
  return {
    jobId: 'session-1',
    eventSeq: 1,
    eventType,
    timestamp: '2026-05-22T00:00:00Z',
    payload,
  };
}

describe('parsePartyEvent', () => {
  it('parses party.checkpoint.composed', () => {
    const e = parsePartyEvent(
      raw('party.checkpoint.composed', {
        sessionId: 'sid',
        projectId: 'pid',
        branch: 'party/pid/abcd1234',
        round: 3,
        title: 't',
        summary: 's',
        commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        pushed: false,
        exitCode: 0,
        reason: 'COMPOSED',
      }),
    );
    expect(e?.type).toBe('party.checkpoint.composed');
    if (e && e.type === 'party.checkpoint.composed') {
      expect(e.commitSha).toBe('abcdef0123456789abcdef0123456789abcdef01');
      expect(e.pushed).toBe(false);
      expect(e.branch).toBe('party/pid/abcd1234');
      expect(e.round).toBe(3);
    }
  });

  it('parses party.checkpoint.pushed with pushed=true', () => {
    const e = parsePartyEvent(
      raw('party.checkpoint.pushed', {
        sessionId: 'sid',
        projectId: 'pid',
        branch: 'b',
        round: 1,
        pushed: true,
        commitSha: 'abcdef0123456789abcdef0123456789abcdef01',
        exitCode: 0,
        reason: 'PUSHED',
      }),
    );
    expect(e?.type).toBe('party.checkpoint.pushed');
    if (e && e.type === 'party.checkpoint.pushed') {
      expect(e.pushed).toBe(true);
    }
  });

  it('parses party.checkpoint.blocked with null commitSha', () => {
    const e = parsePartyEvent(
      raw('party.checkpoint.blocked', {
        sessionId: 'sid',
        projectId: 'pid',
        branch: 'b',
        round: 1,
        commitSha: null,
        pushed: false,
        exitCode: 2,
        reason: 'SECRETS_HIT',
      }),
    );
    expect(e?.type).toBe('party.checkpoint.blocked');
    if (e && e.type === 'party.checkpoint.blocked') {
      expect(e.commitSha).toBeNull();
      expect(e.reason).toBe('SECRETS_HIT');
    }
  });

  it('parses party.agent.question', () => {
    const e = parsePartyEvent(
      raw('party.agent.question', {
        sessionId: 'sid',
        question: 'Should we use Zod?',
        turnCount: 5,
      }),
    );
    expect(e?.type).toBe('party.agent.question');
    if (e && e.type === 'party.agent.question') {
      expect(e.question).toBe('Should we use Zod?');
      expect(e.turnCount).toBe(5);
    }
  });

  it('parses party.tool.default-allow', () => {
    const e = parsePartyEvent(
      raw('party.tool.default-allow', {
        sessionId: 'sid',
        command: 'mkdir scratch',
        jobId: 'job-1',
      }),
    );
    expect(e?.type).toBe('party.tool.default-allow');
    if (e && e.type === 'party.tool.default-allow') {
      expect(e.command).toBe('mkdir scratch');
      expect(e.jobId).toBe('job-1');
    }
  });

  it('returns null for non-typed events (e.g. party.turn.assistant.token)', () => {
    expect(parsePartyEvent(raw('party.turn.assistant.token', { delta: 'h' }))).toBeNull();
    expect(parsePartyEvent(raw('party.bootstrap.completed', {}))).toBeNull();
  });

  it('tolerates missing fields with safe defaults (does not throw)', () => {
    const e = parsePartyEvent(raw('party.checkpoint.composed', {}));
    expect(e?.type).toBe('party.checkpoint.composed');
    if (e && e.type === 'party.checkpoint.composed') {
      expect(e.sessionId).toBe('');
      expect(e.commitSha).toBeNull();
      expect(e.pushed).toBe(false);
      expect(e.exitCode).toBeNull();
    }
  });
});

describe('isCheckpointEvent', () => {
  it('returns true for all four checkpoint variants', () => {
    expect(isCheckpointEvent(raw('party.checkpoint.composed', {}))).toBe(true);
    expect(isCheckpointEvent(raw('party.checkpoint.pushed', {}))).toBe(true);
    expect(isCheckpointEvent(raw('party.checkpoint.blocked', {}))).toBe(true);
    expect(isCheckpointEvent(raw('party.checkpoint.failed', {}))).toBe(true);
  });
  it('returns false for non-checkpoint events', () => {
    expect(isCheckpointEvent(raw('party.turn.completed', {}))).toBe(false);
    expect(isCheckpointEvent(raw('party.agent.question', {}))).toBe(false);
  });
});
