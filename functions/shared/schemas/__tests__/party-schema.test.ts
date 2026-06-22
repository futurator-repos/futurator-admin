import { describe, it, expect } from 'vitest';
import {
  projectIdSchema,
  sessionIdSchema,
  bootstrapInputSchema,
  createSessionInputSchema,
  sendMessageInputSchema,
  partyProjectSchema,
  partySessionSchema,
  brownfieldProjectInputSchema,
  createPartyProjectInputSchema,
  refreshProjectParamsSchema,
  assessProjectParamsSchema,
  assessProjectBodySchema,
  updateMigrationInputSchema,
  docUploadUrlInputSchema,
  docSyncInputSchema,
  docScopeQuerySchema,
} from '../party-schema';

describe('party doc scope schemas', () => {
  const SID = '123e4567-e89b-12d3-a456-426614174000';

  describe('docUploadUrlInputSchema', () => {
    it('defaults scope to session and requires a sessionId', () => {
      const ok = docUploadUrlInputSchema.safeParse({
        filename: 'a.md',
        contentType: 'text/markdown',
        sessionId: SID,
      });
      expect(ok.success).toBe(true);
      if (ok.success) expect(ok.data.scope).toBe('session');
    });

    it('rejects a session-scoped upload with no sessionId (the leak guard)', () => {
      const res = docUploadUrlInputSchema.safeParse({
        filename: 'a.md',
        contentType: 'text/markdown',
      });
      expect(res.success).toBe(false);
    });

    it('allows a shared upload without a sessionId', () => {
      const res = docUploadUrlInputSchema.safeParse({
        filename: 'a.md',
        contentType: 'text/markdown',
        scope: 'shared',
      });
      expect(res.success).toBe(true);
    });

    it('rejects an unknown scope', () => {
      const res = docUploadUrlInputSchema.safeParse({
        filename: 'a.md',
        contentType: 'text/markdown',
        scope: 'global',
        sessionId: SID,
      });
      expect(res.success).toBe(false);
    });
  });

  describe('docSyncInputSchema', () => {
    it('requires sessionId for session scope', () => {
      expect(docSyncInputSchema.safeParse({ filename: 'a.md', s3Key: 'k' }).success).toBe(false);
      expect(
        docSyncInputSchema.safeParse({ filename: 'a.md', s3Key: 'k', sessionId: SID }).success,
      ).toBe(true);
    });
  });

  describe('docScopeQuerySchema', () => {
    it('defaults to session scope and requires sessionId', () => {
      expect(docScopeQuerySchema.safeParse({}).success).toBe(false);
      expect(docScopeQuerySchema.safeParse({ sessionId: SID }).success).toBe(true);
    });

    it('accepts shared scope with no sessionId', () => {
      expect(docScopeQuerySchema.safeParse({ scope: 'shared' }).success).toBe(true);
    });

    it('rejects a non-uuid sessionId', () => {
      expect(docScopeQuerySchema.safeParse({ scope: 'session', sessionId: 'nope' }).success).toBe(
        false,
      );
    });
  });
});

describe('projectIdSchema', () => {
  it('accepts lowercase kebab-case ids', () => {
    expect(projectIdSchema.safeParse('battleship').success).toBe(true);
    expect(projectIdSchema.safeParse('dino-chrome').success).toBe(true);
    expect(projectIdSchema.safeParse('a').success).toBe(true);
    expect(projectIdSchema.safeParse('a1b2c3').success).toBe(true);
  });

  it('rejects invalid ids', () => {
    expect(projectIdSchema.safeParse('').success).toBe(false);
    expect(projectIdSchema.safeParse('-starts-with-hyphen').success).toBe(false);
    expect(projectIdSchema.safeParse('UPPERCASE').success).toBe(false);
    expect(projectIdSchema.safeParse('has_underscore').success).toBe(false);
    expect(projectIdSchema.safeParse('has space').success).toBe(false);
    expect(projectIdSchema.safeParse('../escape').success).toBe(false);
    expect(projectIdSchema.safeParse('a'.repeat(65)).success).toBe(false);
  });
});

describe('sessionIdSchema', () => {
  it('accepts valid UUIDs', () => {
    expect(sessionIdSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success).toBe(true);
  });

  it('rejects non-UUID strings', () => {
    expect(sessionIdSchema.safeParse('not-a-uuid').success).toBe(false);
    expect(sessionIdSchema.safeParse('').success).toBe(false);
  });
});

describe('bootstrapInputSchema', () => {
  it('accepts an empty body', () => {
    expect(bootstrapInputSchema.safeParse({}).success).toBe(true);
  });

  it('accepts forceReinstall boolean', () => {
    expect(bootstrapInputSchema.safeParse({ forceReinstall: true }).success).toBe(true);
    expect(bootstrapInputSchema.safeParse({ forceReinstall: false }).success).toBe(true);
  });

  it('rejects non-boolean forceReinstall', () => {
    expect(bootstrapInputSchema.safeParse({ forceReinstall: 'yes' }).success).toBe(false);
  });
});

describe('createSessionInputSchema', () => {
  it('accepts a valid projectId', () => {
    expect(createSessionInputSchema.safeParse({ projectId: 'battleship' }).success).toBe(true);
  });

  it('accepts optional topic', () => {
    const r = createSessionInputSchema.safeParse({
      projectId: 'battleship',
      topic: 'Talk about UI',
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing projectId', () => {
    expect(createSessionInputSchema.safeParse({}).success).toBe(false);
  });

  it('rejects topic longer than 200 chars', () => {
    const r = createSessionInputSchema.safeParse({
      projectId: 'battleship',
      topic: 'x'.repeat(201),
    });
    expect(r.success).toBe(false);
  });
});

describe('sendMessageInputSchema', () => {
  it('accepts short content', () => {
    expect(sendMessageInputSchema.safeParse({ content: 'hello' }).success).toBe(true);
  });

  it('rejects empty content', () => {
    expect(sendMessageInputSchema.safeParse({ content: '' }).success).toBe(false);
  });

  it('rejects content larger than 8192 bytes', () => {
    const big = 'x'.repeat(8193);
    expect(sendMessageInputSchema.safeParse({ content: big }).success).toBe(false);
  });

  it('accepts content exactly 8192 bytes', () => {
    const exact = 'x'.repeat(8192);
    expect(sendMessageInputSchema.safeParse({ content: exact }).success).toBe(true);
  });

  it('rejects content whose UTF-8 byte length exceeds 8192', () => {
    // 4097 copies of a 2-byte UTF-8 character = 8194 bytes
    const oversizeUtf8 = 'ñ'.repeat(4097);
    expect(sendMessageInputSchema.safeParse({ content: oversizeUtf8 }).success).toBe(false);
  });
});

describe('partyProjectSchema', () => {
  const base = {
    projectId: 'battleship',
    path: '/home/ubuntu/projects/battleship',
    kind: 'greenfield' as const,
    bmadStatus: 'HEALTHY' as const,
    expectedAgentCount: 23,
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
  };

  it('accepts a minimal HEALTHY project', () => {
    expect(partyProjectSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a brownfield project with git fields (Story 15.4 AC #1)', () => {
    const result = partyProjectSchema.safeParse({
      ...base,
      kind: 'brownfield',
      gitRepoUrl: 'https://github.com/foo/songster.git',
      gitBranch: 'main',
      lastPulledAt: '2026-05-17T00:00:00.000Z',
      lastCommitSha: 'abc1234567',
    });
    expect(result.success).toBe(true);
  });

  it('accepts REFRESHING as a valid bmadStatus', () => {
    expect(partyProjectSchema.safeParse({ ...base, bmadStatus: 'REFRESHING' }).success).toBe(true);
  });

  it('rejects an invalid bmadStatus', () => {
    expect(partyProjectSchema.safeParse({ ...base, bmadStatus: 'WEIRD' }).success).toBe(false);
  });

  it('rejects an invalid kind', () => {
    expect(partyProjectSchema.safeParse({ ...base, kind: 'cyborg' }).success).toBe(false);
  });

  it('rejects a path that does not start with /', () => {
    expect(partyProjectSchema.safeParse({ ...base, path: 'relative/path' }).success).toBe(false);
  });
});

describe('brownfieldProjectInputSchema (Story 15.4 AC #2)', () => {
  const base = {
    kind: 'brownfield' as const,
    name: 'songster',
    gitRepoUrl: 'https://github.com/foo/songster',
  };

  it('accepts an HTTPS GitHub URL without .git', () => {
    expect(brownfieldProjectInputSchema.safeParse(base).success).toBe(true);
  });

  it('accepts an HTTPS GitHub URL with .git', () => {
    expect(
      brownfieldProjectInputSchema.safeParse({
        ...base,
        gitRepoUrl: 'https://github.com/foo/songster.git',
      }).success,
    ).toBe(true);
  });

  it('applies the default gitBranch=main when omitted', () => {
    const r = brownfieldProjectInputSchema.safeParse(base);
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.gitBranch).toBe('main');
  });

  it('accepts an explicit gitBranch', () => {
    expect(brownfieldProjectInputSchema.safeParse({ ...base, gitBranch: 'develop' }).success).toBe(
      true,
    );
  });

  it('rejects SSH GitHub URLs', () => {
    expect(
      brownfieldProjectInputSchema.safeParse({
        ...base,
        gitRepoUrl: 'git@github.com:foo/songster.git',
      }).success,
    ).toBe(false);
  });

  it('rejects non-GitHub HTTPS URLs', () => {
    expect(
      brownfieldProjectInputSchema.safeParse({
        ...base,
        gitRepoUrl: 'https://gitlab.com/foo/songster',
      }).success,
    ).toBe(false);
  });

  it('rejects names violating the kebab-case regex', () => {
    expect(brownfieldProjectInputSchema.safeParse({ ...base, name: 'UPPER' }).success).toBe(false);
    expect(
      brownfieldProjectInputSchema.safeParse({ ...base, name: 'has_underscore' }).success,
    ).toBe(false);
    expect(brownfieldProjectInputSchema.safeParse({ ...base, name: '' }).success).toBe(false);
  });

  it('rejects gitBranch containing whitespace', () => {
    expect(
      brownfieldProjectInputSchema.safeParse({ ...base, gitBranch: 'my branch' }).success,
    ).toBe(false);
  });

  it('rejects missing kind discriminator', () => {
    const { kind: _omit, ...without } = base;
    void _omit;
    expect(brownfieldProjectInputSchema.safeParse(without).success).toBe(false);
  });
});

describe('createPartyProjectInputSchema (discriminated union)', () => {
  it('accepts the legacy greenfield shape (back-compat)', () => {
    expect(createPartyProjectInputSchema.safeParse({ projectId: 'bmad-canon' }).success).toBe(true);
  });

  it('accepts an explicit greenfield kind', () => {
    expect(
      createPartyProjectInputSchema.safeParse({ kind: 'greenfield', projectId: 'bmad-canon' })
        .success,
    ).toBe(true);
  });

  it('accepts a brownfield shape with kind, name, gitRepoUrl', () => {
    const r = createPartyProjectInputSchema.safeParse({
      kind: 'brownfield',
      name: 'songster',
      gitRepoUrl: 'https://github.com/foo/songster.git',
    });
    expect(r.success).toBe(true);
  });

  it('rejects a brownfield shape with an invalid URL', () => {
    expect(
      createPartyProjectInputSchema.safeParse({
        kind: 'brownfield',
        name: 'songster',
        gitRepoUrl: 'not-a-url',
      }).success,
    ).toBe(false);
  });
});

describe('refreshProjectParamsSchema', () => {
  it('accepts a valid projectId', () => {
    expect(refreshProjectParamsSchema.safeParse({ projectId: 'songster' }).success).toBe(true);
  });

  it('rejects an invalid projectId', () => {
    expect(refreshProjectParamsSchema.safeParse({ projectId: 'UPPER' }).success).toBe(false);
  });
});

describe('assessProjectParamsSchema (Refactoring Assessment Module — Epic B1)', () => {
  it('accepts a valid projectId', () => {
    expect(assessProjectParamsSchema.safeParse({ projectId: 'applicator' }).success).toBe(true);
  });

  it('rejects an invalid projectId', () => {
    expect(assessProjectParamsSchema.safeParse({ projectId: 'UPPER' }).success).toBe(false);
  });
});

describe('assessProjectBodySchema', () => {
  it('accepts an empty body (bare assess runs a default recon)', () => {
    expect(assessProjectBodySchema.safeParse({}).success).toBe(true);
  });

  it('accepts the full opt set', () => {
    const r = assessProjectBodySchema.safeParse({
      src: 'app',
      skipGraphify: true,
      runL3: true,
      topN: 40,
    });
    expect(r.success).toBe(true);
  });

  it('rejects topN out of range', () => {
    expect(assessProjectBodySchema.safeParse({ topN: 9999 }).success).toBe(false);
    expect(assessProjectBodySchema.safeParse({ topN: 0 }).success).toBe(false);
  });

  it('rejects a non-string src', () => {
    expect(assessProjectBodySchema.safeParse({ src: 123 }).success).toBe(false);
  });
});

describe('partySessionSchema', () => {
  const base = {
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    projectId: 'battleship',
    projectPath: '/home/ubuntu/projects/battleship',
    claudeSessionId: null,
    status: 'ACTIVE' as const,
    turnCount: 0,
    createdAt: '2026-04-17T00:00:00.000Z',
    bmadVersionAtStart: '6.0.0-alpha.7',
    GSI1PK: 'battleship',
    GSI1SK: '2026-04-17T00:00:00.000Z',
  };

  it('accepts a minimal ACTIVE session', () => {
    expect(partySessionSchema.safeParse(base).success).toBe(true);
  });

  it('accepts a session with claudeSessionId set', () => {
    expect(
      partySessionSchema.safeParse({ ...base, claudeSessionId: 'some-claude-session' }).success,
    ).toBe(true);
  });

  it('rejects non-uuid sessionId', () => {
    expect(partySessionSchema.safeParse({ ...base, sessionId: 'not-a-uuid' }).success).toBe(false);
  });

  it('rejects negative turnCount', () => {
    expect(partySessionSchema.safeParse({ ...base, turnCount: -1 }).success).toBe(false);
  });
});

describe('brownfieldProjectInputSchema — Migrate-module extensions (pat + envVars)', () => {
  const base = {
    kind: 'brownfield' as const,
    name: 'songster',
    gitRepoUrl: 'https://github.com/foo/songster.git',
  };

  it('accepts optional pat with valid prefix', () => {
    expect(brownfieldProjectInputSchema.safeParse({ ...base, pat: 'github_pat_abc' }).success).toBe(
      true,
    );
    expect(brownfieldProjectInputSchema.safeParse({ ...base, pat: 'ghp_abc' }).success).toBe(true);
  });

  it('rejects pat without recognized prefix', () => {
    const r = brownfieldProjectInputSchema.safeParse({ ...base, pat: 'random-string' });
    expect(r.success).toBe(false);
  });

  it('accepts optional envVars with UPPER_SNAKE_CASE keys', () => {
    const r = brownfieldProjectInputSchema.safeParse({
      ...base,
      envVars: { OPENAI_API_KEY: 'sk-1', LINKEDIN_API_KEY: 'li-2' },
    });
    expect(r.success).toBe(true);
  });

  it('rejects envVars with lowercase keys', () => {
    const r = brownfieldProjectInputSchema.safeParse({
      ...base,
      envVars: { openai_key: 'sk-1' },
    });
    expect(r.success).toBe(false);
  });

  it('rejects envVars with hyphen-containing keys', () => {
    const r = brownfieldProjectInputSchema.safeParse({
      ...base,
      envVars: { 'FOO-BAR': 'baz' },
    });
    expect(r.success).toBe(false);
  });

  it('still works without pat or envVars (legacy back-compat)', () => {
    expect(brownfieldProjectInputSchema.safeParse(base).success).toBe(true);
  });
});

describe('updateMigrationInputSchema', () => {
  it('accepts pat-only update', () => {
    expect(updateMigrationInputSchema.safeParse({ pat: 'github_pat_x' }).success).toBe(true);
  });

  it('accepts envVars-only update', () => {
    expect(updateMigrationInputSchema.safeParse({ envVars: { FOO: 'bar' } }).success).toBe(true);
  });

  it('accepts both pat and envVars', () => {
    expect(
      updateMigrationInputSchema.safeParse({
        pat: 'github_pat_x',
        envVars: { FOO: 'bar' },
      }).success,
    ).toBe(true);
  });

  it('rejects an empty body', () => {
    const r = updateMigrationInputSchema.safeParse({});
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.errors[0]?.message).toMatch(/at least one/);
    }
  });

  it('rejects invalid pat prefix', () => {
    expect(updateMigrationInputSchema.safeParse({ pat: 'random' }).success).toBe(false);
  });

  it('rejects invalid envVars keys', () => {
    expect(updateMigrationInputSchema.safeParse({ envVars: { foo: 'bar' } }).success).toBe(false);
  });

  // Story 21.2 — pushEnabled toggle gating.
  it('accepts pushEnabled=true when accompanied by a fresh PAT', () => {
    const r = updateMigrationInputSchema.safeParse({
      pushEnabled: true,
      pat: 'github_pat_abc',
    });
    expect(r.success).toBe(true);
  });

  it('rejects pushEnabled=true without a fresh PAT in same body', () => {
    const r = updateMigrationInputSchema.safeParse({ pushEnabled: true });
    expect(r.success).toBe(false);
    if (!r.success) {
      expect(r.error.errors[0]?.message).toMatch(/contents:write PAT/);
    }
  });

  it('accepts pushEnabled=false without requiring a PAT (operator demoting)', () => {
    const r = updateMigrationInputSchema.safeParse({ pushEnabled: false });
    expect(r.success).toBe(true);
  });

  it('accepts pushEnabled bundled with envVars and pat', () => {
    const r = updateMigrationInputSchema.safeParse({
      pat: 'github_pat_abc',
      pushEnabled: true,
      envVars: { FOO: 'bar' },
    });
    expect(r.success).toBe(true);
  });

  // Auto-PR toggle — flippable alone, no PAT required (push must already be on).
  it('accepts autoOpenPr=true on its own (no PAT needed)', () => {
    expect(updateMigrationInputSchema.safeParse({ autoOpenPr: true }).success).toBe(true);
    expect(updateMigrationInputSchema.safeParse({ autoOpenPr: false }).success).toBe(true);
  });

  it('still rejects an empty body even with autoOpenPr in the union', () => {
    expect(updateMigrationInputSchema.safeParse({}).success).toBe(false);
  });
});
