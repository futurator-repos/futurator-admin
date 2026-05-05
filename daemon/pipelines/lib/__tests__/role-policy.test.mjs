import { describe, it, expect } from 'vitest';
import {
  buildAgentConfig,
  buildAllowedToolsString,
  buildDisallowedToolsString,
  KNOWN_ROLES,
  SHARED_ROLES,
} from '../role-policy.mjs';

describe('daemon role-policy mirror', () => {
  it('exposes the expected role surface', () => {
    expect(KNOWN_ROLES).toEqual(
      expect.arrayContaining([
        'API_AUTHOR',
        'TEST',
        'DEV',
        'REVIEWER',
        'COMPILER',
        'QA',
        'PM',
        'CONVERSATION',
        'REFLECTION',
        'DEPLOY',
      ]),
    );
    expect(SHARED_ROLES).toEqual(['API_AUTHOR', 'TEST', 'DEV', 'REVIEWER', 'COMPILER', 'QA', 'PM']);
  });

  it('throws with a clear message for unknown roles', () => {
    expect(() => buildAgentConfig({ role: 'UNKNOWN', name: 'x' })).toThrow(/unknown role "UNKNOWN"/);
  });

  it('returns sorted comma-joined strings (matches TS resolver shape)', () => {
    const cfg = buildAgentConfig({ role: 'DEV', name: 'Developer', model: 'sonnet' });
    expect(cfg.allowedTools).toBe('Bash,Edit,Glob,Grep,Read,Write');
    expect(cfg.disallowedTools).toBe('Agent,Task,WebFetch,WebSearch');
    expect(cfg.name).toBe('Developer');
    expect(cfg.model).toBe('sonnet');
  });

  it('omits model from the result when not provided', () => {
    const cfg = buildAgentConfig({ role: 'DEV', name: 'Developer' });
    expect(cfg.model).toBeUndefined();
    // …but still produces the deny string.
    expect(cfg.disallowedTools).toContain('Agent');
  });

  it.each([
    ['DEV', 'Bash,Edit,Glob,Grep,Read,Write', 'Agent,Task,WebFetch,WebSearch'],
    ['TEST', 'Bash,Edit,Glob,Grep,Read,Write', 'Agent,Task,WebFetch,WebSearch'],
    ['REVIEWER', 'Glob,Grep,Read', 'Agent,Bash,Edit,Task,WebFetch,WebSearch,Write'],
    ['COMPILER', 'Edit,Glob,Grep,Read,Write', 'Agent,Bash,Task,WebFetch,WebSearch'],
    ['QA', 'Bash,Glob,Read,Write', 'Agent,Task,WebFetch,WebSearch'],
    ['PM', 'Read', 'Agent,Bash,Edit,Task,WebFetch,WebSearch,Write'],
    // Daemon-only roles
    ['CONVERSATION', 'Bash,Glob,Grep,Read', 'Agent,Edit,Task,WebFetch,WebSearch,Write'],
    ['REFLECTION', 'Bash,Glob,Grep,Read', 'Agent,Edit,Task,WebFetch,WebSearch,Write'],
    ['DEPLOY', 'Edit,Glob,Grep,Read,Write', 'Agent,Bash,Task,WebFetch,WebSearch'],
  ])('%s → allowed=%s / disallowed=%s', (role, allowed, disallowed) => {
    const cfg = buildAgentConfig({ role, name: '_' });
    expect(cfg.allowedTools).toBe(allowed);
    expect(cfg.disallowedTools).toBe(disallowed);
  });

  it('every role denies the PR-3 baseline (Task / Agent / WebFetch / WebSearch)', () => {
    for (const role of KNOWN_ROLES) {
      const cfg = buildAgentConfig({ role, name: '_' });
      for (const t of ['Task', 'Agent', 'WebFetch', 'WebSearch']) {
        expect(cfg.disallowedTools, `${role}: ${t}`).toContain(t);
      }
    }
  });

  it('CONVERSATION / REFLECTION are read+bash, no Write/Edit', () => {
    for (const role of ['CONVERSATION', 'REFLECTION']) {
      const cfg = buildAgentConfig({ role, name: '_' });
      expect(cfg.allowedTools).toContain('Bash');
      expect(cfg.allowedTools).not.toContain('Write');
      expect(cfg.allowedTools).not.toContain('Edit');
      expect(cfg.disallowedTools).toContain('Write');
      expect(cfg.disallowedTools).toContain('Edit');
    }
  });
});

describe('step-level helpers', () => {
  it('buildAllowedToolsString returns just the comma-joined string', () => {
    expect(buildAllowedToolsString('COMPILER')).toBe('Edit,Glob,Grep,Read,Write');
  });

  it('buildDisallowedToolsString returns just the comma-joined string', () => {
    expect(buildDisallowedToolsString('COMPILER')).toBe('Agent,Bash,Task,WebFetch,WebSearch');
  });
});
