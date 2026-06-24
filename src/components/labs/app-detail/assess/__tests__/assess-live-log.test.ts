/**
 * assess-live-log.test.ts — the pure event→log-line formatter.
 * The failure line is the auditing-critical case (must surface reason+message).
 */

import { describe, it, expect } from 'vitest';
import { lineForEvent } from '../assess-live-log';

const ev = (over: Record<string, unknown>) =>
  ({
    timestamp: '2026-06-24T10:11:12.000Z',
    jobId: 'j',
    eventSeq: '1',
    seq: 1,
    stepId: 's',
    agentId: 'RECON',
    ...over,
  }) as never;

describe('lineForEvent', () => {
  it('renders recon stdout chunks as mono lines', () => {
    const l = lineForEvent(
      ev({
        eventType: 'assess.step.output',
        step: 'graphify',
        stream: 'stdout',
        data: 'building…\n',
      }),
    );
    expect(l).toMatchObject({ tone: 'mono', text: 'building…' });
    expect(l?.ts).toBe('10:11:12');
  });

  it('renders stderr chunks in the error tone', () => {
    const l = lineForEvent(ev({ eventType: 'assess.step.output', stream: 'stderr', data: 'oops' }));
    expect(l?.tone).toBe('err');
  });

  it('surfaces a failure with reason + message (the audit case)', () => {
    const l = lineForEvent(
      ev({ eventType: 'assess.failed', reason: 'recon-error', message: 'auth expired' }),
    );
    expect(l?.tone).toBe('err');
    expect(l?.text).toMatch(/FAILED \[recon-error\] auth expired/);
  });

  it('renders step transitions + completion + L3', () => {
    expect(lineForEvent(ev({ eventType: 'assess.step.started', step: 'knip' }))?.text).toBe(
      '▶ knip',
    );
    expect(lineForEvent(ev({ eventType: 'assess.completed', hotspotCount: 44 }))?.text).toMatch(
      /44 hotspots/,
    );
    expect(
      lineForEvent(ev({ eventType: 'assess.l3.completed', confirmed: 3, rejected: 1 }))?.text,
    ).toMatch(/3 confirmed, 1 rejected/);
    expect(lineForEvent(ev({ eventType: 'assess.l3.failed', message: 'oauth' }))?.tone).toBe('err');
  });

  it('skips empty output + unknown event types', () => {
    expect(lineForEvent(ev({ eventType: 'assess.step.output', data: '' }))).toBeNull();
    expect(lineForEvent(ev({ eventType: 'step_complete' }))).toBeNull();
  });
});
