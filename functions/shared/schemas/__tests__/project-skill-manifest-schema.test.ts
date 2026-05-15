/**
 * project-skill-manifest-schema.test.ts — Pipeline v2 Phase 3 / Story 3-C-2-1.
 */

import { describe, it, expect } from 'vitest';
import {
  ProjectSkillManifestSchema,
  emptyManifest,
  flattenSkills,
  skillsUsedCommitLine,
} from '../project-skill-manifest-schema';

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('ProjectSkillManifestSchema', () => {
  it('parses an empty manifest', () => {
    const result = ProjectSkillManifestSchema.safeParse(emptyManifest('dino-runner-1'));
    expect(result.success).toBe(true);
  });

  it('parses a populated v2.5 §36 illustrative manifest', () => {
    const manifest = {
      project: 'songster',
      'manifest-version': 1,
      'generated-by': 'skill-scout@v2.5',
      core: [{ source: 'anthropic-official', skill: 'frontend-design', version: `sha:${SHA_A}` }],
      stack: [
        { source: 'vercel-web', skill: 'vercel-react-best-practices', version: 'tag:v2.4.1' },
      ],
      domain: [
        { source: 'futurator-internal', skill: 'music-theory-engine', version: `sha:${SHA_B}` },
      ],
      vendor: [{ source: 'stripe-official', skill: 'stripe-checkout', version: 'tag:v3.2.0' }],
      plans: {
        'songster-v2-storyboard': {
          skills: [{ skill: 'lead-sheet-generator', 'graduate-policy': 'on-plan-success' }],
        },
      },
      gaps: [
        {
          need: 'Demucs v4 ECS Fargate runbook',
          encounters: 3,
          'suggested-action': 'author-via-skill-creator',
        },
      ],
    };
    const result = ProjectSkillManifestSchema.safeParse(manifest);
    expect(result.success).toBe(true);
  });

  it('rejects missing project slug', () => {
    const manifest = { ...emptyManifest('x'), project: '' };
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects version without sha: or tag: prefix', () => {
    const manifest = emptyManifest('x');
    manifest.core = [{ source: 's', skill: 'k', version: 'sha:tooshort' }];
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(false);

    manifest.core = [{ source: 's', skill: 'k', version: 'v1.0.0' }];
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('accepts sha:<40-char-hex>', () => {
    const manifest = emptyManifest('x');
    manifest.core = [{ source: 's', skill: 'k', version: `sha:${SHA_A}` }];
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('accepts tag:<semver-like>', () => {
    const manifest = emptyManifest('x');
    manifest.core = [{ source: 's', skill: 'k', version: 'tag:v2.4.1' }];
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(true);

    manifest.core = [{ source: 's', skill: 'k', version: 'tag:1.0.0-beta.2' }];
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it('rejects unknown graduate-policy', () => {
    const manifest = {
      ...emptyManifest('x'),
      plans: {
        plan1: {
          skills: [{ skill: 's', 'graduate-policy': 'someday' }],
        },
      },
    };
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects negative gap.encounters', () => {
    const manifest = {
      ...emptyManifest('x'),
      gaps: [{ need: 'thing', encounters: -1 }],
    };
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(false);
  });

  it('rejects unsupported manifest-version', () => {
    const manifest = { ...emptyManifest('x'), 'manifest-version': 2 };
    expect(ProjectSkillManifestSchema.safeParse(manifest).success).toBe(false);
  });
});

describe('emptyManifest', () => {
  it('passes its own schema', () => {
    expect(ProjectSkillManifestSchema.safeParse(emptyManifest('dino-1')).success).toBe(true);
  });

  it('uses the provided project slug', () => {
    expect(emptyManifest('songster').project).toBe('songster');
  });
});

describe('flattenSkills', () => {
  it('orders alphabetically by skill@source', () => {
    const manifest = {
      core: [{ source: 'anthropic-official', skill: 'zeta', version: `sha:${SHA_A}` }],
      stack: [{ source: 'vercel-web', skill: 'alpha', version: 'tag:v1' }],
      domain: [{ source: 'futurator-internal', skill: 'beta', version: `sha:${SHA_B}` }],
      vendor: [],
    };
    const order = flattenSkills(manifest).map((e) => e.skill);
    expect(order).toEqual(['alpha', 'beta', 'zeta']);
  });

  it('combines all four kinds', () => {
    const manifest = {
      core: [{ source: 'a', skill: '1', version: 'tag:v1' }],
      stack: [{ source: 'b', skill: '2', version: 'tag:v1' }],
      domain: [{ source: 'c', skill: '3', version: 'tag:v1' }],
      vendor: [{ source: 'd', skill: '4', version: 'tag:v1' }],
    };
    expect(flattenSkills(manifest)).toHaveLength(4);
  });
});

describe('skillsUsedCommitLine', () => {
  it('produces v2.5 §40 comma+space format, alphabetical', () => {
    const manifest = {
      core: [{ source: 'anthropic-official', skill: 'frontend-design', version: `sha:${SHA_A}` }],
      stack: [
        { source: 'vercel-web', skill: 'vercel-react-best-practices', version: 'tag:v2.4.1' },
      ],
      domain: [
        { source: 'futurator-internal', skill: 'music-theory-engine', version: `sha:${SHA_B}` },
      ],
      vendor: [],
    };
    expect(skillsUsedCommitLine(manifest)).toBe(
      'frontend-design@anthropic-official, music-theory-engine@futurator-internal, vercel-react-best-practices@vercel-web',
    );
  });

  it('returns empty string when no skills loaded', () => {
    expect(skillsUsedCommitLine({ core: [], stack: [], domain: [], vendor: [] })).toBe('');
  });
});
