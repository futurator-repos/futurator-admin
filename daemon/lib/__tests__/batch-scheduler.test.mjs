import { describe, it, expect } from 'vitest';
import { shouldPickUp, isInNightlyWindow, isInWeekendWindow } from '../batch-scheduler.mjs';

describe('shouldPickUp', () => {
  it('always picks up "now" priority', () => {
    expect(shouldPickUp({ priority: 'now' })).toBe(true);
    expect(shouldPickUp({})).toBe(true); // default
  });

  it('blocks "nightly" outside the window', () => {
    const noon = new Date('2026-04-26T12:00:00.000Z');
    expect(shouldPickUp({ priority: 'nightly' }, noon)).toBe(false);
  });

  it('admits "nightly" inside the window', () => {
    const lateNight = new Date('2026-04-26T03:00:00.000Z');
    expect(shouldPickUp({ priority: 'nightly' }, lateNight)).toBe(true);
  });

  it('blocks "weekend" on a Wednesday', () => {
    const wed = new Date('2026-04-22T12:00:00.000Z'); // 2026-04-22 is Wednesday
    expect(shouldPickUp({ priority: 'weekend' }, wed)).toBe(false);
  });

  it('admits "weekend" on a Saturday', () => {
    const sat = new Date('2026-04-25T12:00:00.000Z'); // 2026-04-25 is Saturday
    expect(shouldPickUp({ priority: 'weekend' }, sat)).toBe(true);
  });
});

describe('isInNightlyWindow / isInWeekendWindow', () => {
  it('nightly window is exclusive on the end edge', () => {
    expect(isInNightlyWindow(new Date('2026-04-26T05:59:00.000Z'))).toBe(true);
    expect(isInNightlyWindow(new Date('2026-04-26T06:00:00.000Z'))).toBe(false);
  });

  it('weekend window covers Saturday + Sunday', () => {
    expect(isInWeekendWindow(new Date('2026-04-25T03:00:00.000Z'))).toBe(true);
    expect(isInWeekendWindow(new Date('2026-04-26T03:00:00.000Z'))).toBe(true);
    expect(isInWeekendWindow(new Date('2026-04-27T03:00:00.000Z'))).toBe(false);
  });
});
