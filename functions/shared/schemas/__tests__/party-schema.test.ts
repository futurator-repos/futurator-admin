import { describe, it, expect } from 'vitest';
import {
  projectIdSchema,
  sessionIdSchema,
  bootstrapInputSchema,
  createSessionInputSchema,
  sendMessageInputSchema,
  partyProjectSchema,
  partySessionSchema,
} from '../party-schema';

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
    bmadStatus: 'HEALTHY' as const,
    expectedAgentCount: 23,
    createdAt: '2026-04-17T00:00:00.000Z',
    updatedAt: '2026-04-17T00:00:00.000Z',
  };

  it('accepts a minimal HEALTHY project', () => {
    expect(partyProjectSchema.safeParse(base).success).toBe(true);
  });

  it('rejects an invalid bmadStatus', () => {
    expect(partyProjectSchema.safeParse({ ...base, bmadStatus: 'WEIRD' }).success).toBe(false);
  });

  it('rejects a path that does not start with /', () => {
    expect(partyProjectSchema.safeParse({ ...base, path: 'relative/path' }).success).toBe(false);
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
