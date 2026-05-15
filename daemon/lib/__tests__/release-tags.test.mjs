/**
 * release-tags.test.mjs — Pipeline v2 Phase 2-B / Story 2-B-5-1 (PR-93).
 */

import { describe, it, expect } from 'vitest';
import {
  planCompletionTag,
  productionReleaseTag,
  rigorUpgradeTag,
  skillAuthorTag,
  classifyTag,
  nextSemver,
} from '../release-tags.mjs';

describe('tag builders', () => {
  it('planCompletionTag uses <project>-plan-<slug>', () => {
    expect(planCompletionTag({ project: 'songster', planSlug: 'songster-v2-storyboard' })).toBe(
      'songster-plan-songster-v2-storyboard',
    );
  });

  it('productionReleaseTag uses <project>-v<semver>', () => {
    expect(productionReleaseTag({ project: 'songster', semver: 'v1.2.3' })).toBe('songster-v1.2.3');
  });

  it('rigorUpgradeTag includes rigor-upgrade marker', () => {
    expect(rigorUpgradeTag({ project: 'songster', semver: 'v2.0.0' })).toBe(
      'songster-rigor-upgrade-v2.0.0',
    );
  });

  it('skillAuthorTag includes skill name', () => {
    expect(
      skillAuthorTag({ project: 'songster', skillName: 'music-theory-engine', semver: 'v1.0.0' }),
    ).toBe('songster-skill-music-theory-engine-v1.0.0');
  });

  it('rejects bad slugs', () => {
    expect(() => planCompletionTag({ project: 'BAD', planSlug: 'songster' })).toThrow();
    expect(() => productionReleaseTag({ project: 'songster', semver: 'v1' })).toThrow();
    expect(() => productionReleaseTag({ project: 'songster', semver: '1.0.0' })).toThrow();
  });

  it('accepts pre-release semver suffix', () => {
    expect(productionReleaseTag({ project: 'songster', semver: 'v1.0.0-rc.1' })).toBe(
      'songster-v1.0.0-rc.1',
    );
  });
});

describe('classifyTag', () => {
  it('identifies plan-completion', () => {
    const c = classifyTag('songster-plan-songster-v2-storyboard');
    expect(c.kind).toBe('plan-completion');
    if (c.kind === 'plan-completion') {
      expect(c.project).toBe('songster');
      expect(c.planSlug).toBe('songster-v2-storyboard');
    }
  });

  it('identifies production-release', () => {
    const c = classifyTag('songster-v1.2.3');
    expect(c.kind).toBe('production-release');
    if (c.kind === 'production-release') {
      expect(c.project).toBe('songster');
      expect(c.semver).toBe('v1.2.3');
    }
  });

  it('identifies rigor-upgrade', () => {
    const c = classifyTag('songster-rigor-upgrade-v2.0.0');
    expect(c.kind).toBe('rigor-upgrade');
  });

  it('identifies skill-author', () => {
    const c = classifyTag('songster-skill-music-theory-engine-v1.0.0');
    expect(c.kind).toBe('skill-author');
    if (c.kind === 'skill-author') {
      expect(c.skillName).toBe('music-theory-engine');
    }
  });

  it('returns unknown for arbitrary strings', () => {
    expect(classifyTag('random-string').kind).toBe('unknown');
    expect(classifyTag('').kind).toBe('unknown');
  });
});

describe('nextSemver', () => {
  it('returns v0.1.0 when no tags exist', () => {
    expect(nextSemver([])).toBe('v0.1.0');
  });

  it('ignores plan-completion tags (only semver-bearing tags count)', () => {
    expect(nextSemver(['songster-plan-foo', 'songster-plan-bar'])).toBe('v0.1.0');
  });

  it('bumps patch by default', () => {
    expect(nextSemver(['songster-v1.2.3'])).toBe('v1.2.4');
  });

  it('bumps minor', () => {
    expect(nextSemver(['songster-v1.2.3'], 'minor')).toBe('v1.3.0');
  });

  it('bumps major', () => {
    expect(nextSemver(['songster-v1.2.3'], 'major')).toBe('v2.0.0');
  });

  it('finds the highest among multiple', () => {
    expect(
      nextSemver(['songster-v1.0.0', 'songster-v2.5.0', 'songster-v1.10.0', 'songster-v2.4.99']),
    ).toBe('v2.5.1');
  });

  it('includes rigor-upgrade tags in version search', () => {
    expect(nextSemver(['songster-v1.0.0', 'songster-rigor-upgrade-v2.0.0'])).toBe('v2.0.1');
  });
});
