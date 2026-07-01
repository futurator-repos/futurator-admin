import { describe, it, expect } from 'vitest';

import { buildForensicSkills } from '../story-forensic-skills';

/**
 * G4 — buildForensicSkills: pure rollup that surfaces per-plan skill activations
 * for the Labs3 Skills & Learnings tab. Tolerant of the various shapes skill
 * provenance can arrive in (row objects, trailer tokens, bare names).
 */

describe('buildForensicSkills — empty / defensive', () => {
  it('returns empty structures for null/undefined inputs', () => {
    expect(buildForensicSkills(null, null)).toEqual({ activatedSkills: [], perJob: [] });
    expect(buildForensicSkills(undefined, undefined)).toEqual({
      activatedSkills: [],
      perJob: [],
    });
  });

  it('skips jobs without a jobId', () => {
    const { perJob } = buildForensicSkills(
      [],
      [{ loadedSkills: [{ skill: 'x', source: 'core' }] }],
    );
    expect(perJob).toEqual([]);
  });
});

describe('buildForensicSkills — job-level skills', () => {
  it('reads {skill,source} arrays off a job and counts activations', () => {
    const jobs = [
      { jobId: 'j1', loadedSkills: [{ skill: 'react-ui', source: 'stack' }] },
      { jobId: 'j2', loadedSkills: [{ skill: 'react-ui', source: 'stack' }] },
    ];
    const { activatedSkills, perJob } = buildForensicSkills([], jobs);
    expect(perJob).toEqual([
      { jobId: 'j1', skills: [{ skill: 'react-ui', source: 'stack' }] },
      { jobId: 'j2', skills: [{ skill: 'react-ui', source: 'stack' }] },
    ]);
    expect(activatedSkills).toEqual([{ skill: 'react-ui', source: 'stack', activationCount: 2 }]);
  });

  it('parses "<skill>@<source>" trailer tokens and bare names', () => {
    const jobs = [{ jobId: 'j1', skillsUsed: ['lazy-dev@core', 'orphan-name'] }];
    const { perJob } = buildForensicSkills([], jobs);
    expect(perJob[0].skills).toEqual([
      { skill: 'lazy-dev', source: 'core' },
      { skill: 'orphan-name', source: 'unknown' },
    ]);
  });

  it('de-dupes the same skill@source within one job', () => {
    const jobs = [
      {
        jobId: 'j1',
        loadedSkills: [{ skill: 'a', source: 'core' }],
        skillsUsed: ['a@core'],
      },
    ];
    const { perJob, activatedSkills } = buildForensicSkills([], jobs);
    expect(perJob[0].skills).toEqual([{ skill: 'a', source: 'core' }]);
    expect(activatedSkills).toEqual([{ skill: 'a', source: 'core', activationCount: 1 }]);
  });
});

describe('buildForensicSkills — story-row → job linkage', () => {
  it('merges skills from the plan-spec-graph row linked by storyNodeRef.storyId', () => {
    const storyRows = [{ storyId: 's1', loadedSkills: [{ skill: 'graphify', source: 'domain' }] }];
    const jobs = [
      {
        jobId: 'j1',
        storyNodeRef: { storyId: 's1' },
        loadedSkills: [{ skill: 'react-ui', source: 'stack' }],
      },
    ];
    const { perJob } = buildForensicSkills(storyRows, jobs);
    expect(perJob[0].skills).toEqual([
      { skill: 'react-ui', source: 'stack' },
      { skill: 'graphify', source: 'domain' },
    ]);
  });

  it('also links via storyDevPayload.storyId', () => {
    const storyRows = [{ storyId: 's9', skillsUsed: ['probe-kit@core'] }];
    const jobs = [{ jobId: 'j1', storyDevPayload: { storyId: 's9' } }];
    const { perJob } = buildForensicSkills(storyRows, jobs);
    expect(perJob[0].skills).toEqual([{ skill: 'probe-kit', source: 'core' }]);
  });
});

describe('buildForensicSkills — aggregate ordering', () => {
  it('sorts activatedSkills by count desc, then skill name asc', () => {
    const jobs = [
      { jobId: 'j1', loadedSkills: ['a@core', 'b@core'] },
      { jobId: 'j2', loadedSkills: ['b@core', 'c@core'] },
      { jobId: 'j3', loadedSkills: ['b@core'] },
    ];
    const { activatedSkills } = buildForensicSkills([], jobs);
    expect(activatedSkills).toEqual([
      { skill: 'b', source: 'core', activationCount: 3 },
      { skill: 'a', source: 'core', activationCount: 1 },
      { skill: 'c', source: 'core', activationCount: 1 },
    ]);
  });
});
