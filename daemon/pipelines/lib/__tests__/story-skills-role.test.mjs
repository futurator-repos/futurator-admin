import { describe, it, expect } from 'vitest';
import { SKILLS_PUSH_ROLES } from '../../../lib/skills-prompt.mjs';
import { buildSkillsInjection } from '../story-skills-inject.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SKILLS_PUSH_ROLES (canonical policy)', () => {
  it('code-producing roles push; reviewers/compilers do not', () => {
    for (const r of ['DEV', 'TEST', 'API_AUTHOR', 'story-dev', 'test-author', 'implementer']) {
      expect(SKILLS_PUSH_ROLES.has(r)).toBe(true);
    }
    for (const r of ['REVIEWER', 'senior-reviewer', 'COMPILER', 'REFLECTOR']) {
      expect(SKILLS_PUSH_ROLES.has(r)).toBe(false);
    }
  });
});

describe('buildSkillsInjection — role param never throws, returns args', () => {
  it('accepts a push role and a non-push role on an empty workdir', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-role-'));
    try {
      const push = await buildSkillsInjection({ workingDir: dir, storyText: 'x', role: 'implementer' });
      const pull = await buildSkillsInjection({ workingDir: dir, storyText: 'x', role: 'reviewer' });
      const dflt = await buildSkillsInjection({ workingDir: dir, storyText: 'x' });
      for (const r of [push, pull, dflt]) expect(Array.isArray(r)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
