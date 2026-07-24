import { describe, it, expect } from 'vitest';
import type { ServerCapability } from '../../types/compute-server';
import {
  jobRequiredCapabilities,
  serverHasCapabilitiesFor,
  missingCapabilitiesFor,
  JOB_CAPABILITY_REQUIREMENTS,
} from '../dispatch-capabilities';

describe('dispatch-capabilities — job requirements', () => {
  it('unions static jobType requirements with dynamic per-job requirements', () => {
    // app-bootstrap is statically git-push; add a dynamic browser need.
    expect(jobRequiredCapabilities({ jobType: 'app-bootstrap' })).toEqual(['git-push']);
    expect(
      jobRequiredCapabilities({
        jobType: 'app-bootstrap',
        requiredCapabilities: ['browser'],
      }).sort(),
    ).toEqual(['browser', 'git-push']);
  });

  it('dedupes overlapping static + dynamic requirements', () => {
    expect(
      jobRequiredCapabilities({
        jobType: 'free-agent-session',
        requiredCapabilities: ['interactive'],
      }),
    ).toEqual(['interactive']);
  });

  it('a jobType with no static requirement + no dynamic → empty (any host)', () => {
    expect(jobRequiredCapabilities({ jobType: 'story-dev' })).toEqual([]);
    expect(jobRequiredCapabilities({ jobType: 'scan-engine' })).toEqual([]);
    expect(jobRequiredCapabilities({})).toEqual([]);
  });

  it('story-dev gains browser ONLY dynamically (not every story is UI)', () => {
    expect(JOB_CAPABILITY_REQUIREMENTS['story-dev']).toBeUndefined();
    expect(
      jobRequiredCapabilities({ jobType: 'story-dev', requiredCapabilities: ['browser'] }),
    ).toEqual(['browser']);
  });
});

describe('dispatch-capabilities — eligibility (axis 1)', () => {
  it('a job with no requirements runs on any server', () => {
    expect(serverHasCapabilitiesFor({ capabilities: [] }, { jobType: 'story-dev' })).toBe(true);
    expect(
      serverHasCapabilitiesFor({ capabilities: ['browser'] }, { jobType: 'scan-engine' }),
    ).toBe(true);
  });

  it('server must have EVERY required capability', () => {
    const partyJob = { jobType: 'party-turn' }; // needs git-push + interactive
    expect(serverHasCapabilitiesFor({ capabilities: ['git-push', 'interactive'] }, partyJob)).toBe(
      true,
    );
    expect(serverHasCapabilitiesFor({ capabilities: ['git-push'] }, partyJob)).toBe(false);
    expect(serverHasCapabilitiesFor({ capabilities: [] }, partyJob)).toBe(false);
  });

  it('a browser story only lands on a browser-capable host', () => {
    const browserStory = {
      jobType: 'story-dev',
      requiredCapabilities: ['browser'] as ServerCapability[],
    };
    expect(serverHasCapabilitiesFor({ capabilities: ['browser', 'git-push'] }, browserStory)).toBe(
      true,
    );
    expect(serverHasCapabilitiesFor({ capabilities: ['git-push'] }, browserStory)).toBe(false);
  });

  it('PERMISSIVE-WHEN-UNDECLARED: undefined capabilities can run anything (safe rollout)', () => {
    expect(serverHasCapabilitiesFor({}, { jobType: 'party-turn' })).toBe(true);
    expect(
      serverHasCapabilitiesFor({}, { jobType: 'story-dev', requiredCapabilities: ['browser'] }),
    ).toBe(true);
  });

  it('an EMPTY (reported) capability set is strict — only requirement-free jobs', () => {
    expect(serverHasCapabilitiesFor({ capabilities: [] }, { jobType: 'party-turn' })).toBe(false);
    expect(serverHasCapabilitiesFor({ capabilities: [] }, { jobType: 'story-dev' })).toBe(true);
  });

  it('missingCapabilitiesFor reports the exact gap (and nothing for undeclared)', () => {
    expect(
      missingCapabilitiesFor({ capabilities: ['git-push'] }, { jobType: 'party-turn' }),
    ).toEqual(['interactive']);
    expect(missingCapabilitiesFor({}, { jobType: 'party-turn' })).toEqual([]);
  });
});
