import { describe, it, expect } from 'vitest';
import { adaptSession } from './turn-adapter';
import type { PartyEvent } from '@/types/party';

function ev(seq: number, type: string, extras: Record<string, unknown> = {}): PartyEvent {
  return {
    jobId: 'job',
    eventSeq: String(seq).padStart(6, '0'),
    timestamp: new Date(2026, 3, 26, 11, 42, 25 + seq).toISOString(),
    eventType: type,
    ...extras,
  };
}

describe('adaptSession', () => {
  it('produces one round per party.turn.user event', () => {
    const events: PartyEvent[] = [
      ev(1, 'party.turn.user', { content: 'first message' }),
      ev(2, 'party.turn.started'),
      ev(3, 'party.turn.assistant.token', { text: 'hello ' }),
      ev(4, 'party.turn.assistant.token', { text: 'world' }),
      ev(5, 'party.turn.completed'),
      ev(6, 'party.turn.user', { content: 'second message' }),
      ev(7, 'party.turn.assistant.token', { text: 'response 2' }),
      ev(8, 'party.turn.completed'),
    ];
    const out = adaptSession(events, 'ACTIVE');
    expect(out.rounds).toHaveLength(2);
    expect(out.rounds[0].user.text).toBe('first message');
    expect(out.rounds[1].user.text).toBe('second message');
  });

  it('dedupes events that appear twice with the same eventSeq', () => {
    // Simulates a polling race / strict-mode double-mount where the same
    // event landed in our local array twice. Without dedup, we'd render
    // two phantom rounds with identical user prompts. This is the exact
    // production bug observed in 2026-04-26 BMAD session.
    const userEvent = ev(1, 'party.turn.user', { content: 'identical prompt' });
    const events: PartyEvent[] = [
      userEvent,
      ev(2, 'party.turn.started'),
      ev(3, 'party.turn.assistant.token', { text: 'orchestrator opens' }),
      ev(4, 'party.turn.error', { reason: 'TIMEOUT' }),
      // duplicates from a polling race:
      userEvent,
      ev(2, 'party.turn.started'),
      ev(3, 'party.turn.assistant.token', { text: 'orchestrator opens' }),
      ev(4, 'party.turn.error', { reason: 'TIMEOUT' }),
    ];
    const out = adaptSession(events, 'ERROR');
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0].user.text).toBe('identical prompt');
    expect(out.rounds[0].status).toBe('error');
    expect(out.rounds[0].errorReason).toBe('TIMEOUT');
  });

  it('marks the last round inflight when sessionStatus is PROCESSING', () => {
    const events: PartyEvent[] = [
      ev(1, 'party.turn.user', { content: 'q' }),
      ev(2, 'party.turn.started'),
    ];
    const out = adaptSession(events, 'PROCESSING');
    expect(out.rounds[0].status).toBe('active');
    expect(out.rounds[0].isInflight).toBe(true);
  });

  it('handles a stuck-in-ERROR session that has zero token events', () => {
    const events: PartyEvent[] = [
      ev(1, 'party.turn.user', { content: 'broken' }),
      ev(2, 'party.turn.error', { reason: 'TIMEOUT' }),
    ];
    const out = adaptSession(events, 'ERROR');
    expect(out.rounds).toHaveLength(1);
    expect(out.rounds[0].blocks).toEqual([]);
    expect(out.rounds[0].status).toBe('error');
    expect(out.rounds[0].errorReason).toBe('TIMEOUT');
  });
});
