import { describe, it, expect } from 'vitest';
import {
  RoleSchema,
  RigorSchema,
  BoilerplateKindSchema,
  RolePolicySchema,
  resolveRolePolicy,
  policyToAgentConfig,
  buildAgentConfig,
} from '../role-policy';
import type { Role } from '../role-policy';
import type { BoilerplateType } from '../../boilerplates/registry';
import type { PlanRigor } from '../../types/plan';

const ALL_ROLES: Role[] = [
  'API_AUTHOR',
  'TEST',
  'DEV',
  'REVIEWER',
  'COMPILER',
  'QA',
  'PM',
  // PR-32b — daemon-only roles
  'CONVERSATION',
  'REFLECTION',
  'DEPLOY',
];
const ALL_RIGORS: PlanRigor[] = ['prototype', 'mvp', 'production'];
const ALL_KINDS: BoilerplateType[] = [
  'nextjs-base',
  'nextjs-canvas-game',
  'nextjs-form-app',
  'nextjs-dashboard',
  'sst',
  'vite',
  'mobile',
];

describe('role-policy schema', () => {
  it('Role enum covers every role used in pipelines today', () => {
    for (const r of ALL_ROLES) expect(RoleSchema.safeParse(r).success).toBe(true);
    expect(RoleSchema.safeParse('UNKNOWN').success).toBe(false);
  });

  it('Rigor enum mirrors PlanRigor union', () => {
    for (const r of ALL_RIGORS) expect(RigorSchema.safeParse(r).success).toBe(true);
    expect(RigorSchema.safeParse('strict').success).toBe(false);
  });

  it('BoilerplateKind enum covers every BoilerplateType from the registry', () => {
    for (const k of ALL_KINDS) expect(BoilerplateKindSchema.safeParse(k).success).toBe(true);
    expect(BoilerplateKindSchema.safeParse('django').success).toBe(false);
  });
});

describe('resolveRolePolicy — cartesian coverage', () => {
  it('returns a schema-valid policy for every (kind, rigor, role) combination', () => {
    for (const kind of ALL_KINDS) {
      for (const rigor of ALL_RIGORS) {
        for (const role of ALL_ROLES) {
          const policy = resolveRolePolicy(kind, rigor, role);
          const parsed = RolePolicySchema.safeParse(policy);
          expect(parsed.success, `(${kind}, ${rigor}, ${role})`).toBe(true);
          expect(policy.allowedTools.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('every role has Bash denied except DEV / TEST / QA / CONVERSATION / REFLECTION (Bash-allowed roles)', () => {
    // Bash allowed: TEST, DEV, QA (story pipeline) + CONVERSATION, REFLECTION
    // (daemon-only, PR-32b — they shell out for context gathering).
    const BASH_ALLOWED_ROLES = new Set<Role>(['TEST', 'DEV', 'QA', 'CONVERSATION', 'REFLECTION']);
    for (const role of ALL_ROLES) {
      const policy = resolveRolePolicy('nextjs-base', 'mvp', role);
      const bashAllowed = policy.allowedTools.includes('Bash');
      const bashDenied = policy.disallowedTools.includes('Bash');
      const expectedAllowed = BASH_ALLOWED_ROLES.has(role);
      expect(bashAllowed, `${role} bash allowed`).toBe(expectedAllowed);
      expect(bashDenied, `${role} bash denied`).toBe(!expectedAllowed);
    }
  });

  it('every role denies the PR-3 baseline (Task / Agent / WebFetch / WebSearch)', () => {
    for (const role of ALL_ROLES) {
      const policy = resolveRolePolicy('nextjs-base', 'mvp', role);
      for (const t of ['Task', 'Agent', 'WebFetch', 'WebSearch']) {
        expect(policy.disallowedTools, `${role} denies ${t}`).toContain(t);
      }
    }
  });

  it('REVIEWER is read-only (no Write, no Edit, no Bash)', () => {
    const policy = resolveRolePolicy('nextjs-canvas-game', 'production', 'REVIEWER');
    expect(policy.allowedTools).not.toContain('Write');
    expect(policy.allowedTools).not.toContain('Edit');
    expect(policy.allowedTools).not.toContain('Bash');
    expect(policy.disallowedTools).toContain('Write');
    expect(policy.disallowedTools).toContain('Edit');
    expect(policy.disallowedTools).toContain('Bash');
  });

  it('PM gets only Read', () => {
    const policy = resolveRolePolicy('nextjs-base', 'mvp', 'PM');
    expect(policy.allowedTools).toEqual(['Read']);
  });
});

describe('resolveRolePolicy — turn caps (v2.5 §17)', () => {
  it.each([
    ['prototype', 'TEST', 6],
    ['prototype', 'DEV', 8],
    ['prototype', 'REVIEWER', 4],
    ['mvp', 'API_AUTHOR', 2],
    ['mvp', 'TEST', 8],
    ['mvp', 'DEV', 10],
    ['mvp', 'REVIEWER', 6],
    ['production', 'API_AUTHOR', 2],
    ['production', 'TEST', 10],
    ['production', 'DEV', 12],
    ['production', 'REVIEWER', 8],
    ['production', 'QA', 8],
    ['production', 'PM', 6],
  ] as const)('%s rigor / %s role → maxTurns=%i', (rigor, role, expected) => {
    const policy = resolveRolePolicy('nextjs-base', rigor, role);
    expect(policy.maxTurns).toBe(expected);
  });

  it('API_AUTHOR has no maxTurns under prototype rigor (skipped step)', () => {
    const policy = resolveRolePolicy('nextjs-base', 'prototype', 'API_AUTHOR');
    expect(policy.maxTurns).toBeUndefined();
  });

  it('COMPILER has no cap at any rigor (deterministic shell-heavy work)', () => {
    for (const rigor of ALL_RIGORS) {
      const policy = resolveRolePolicy('nextjs-base', rigor, 'COMPILER');
      expect(policy.maxTurns).toBeUndefined();
    }
  });
});

describe('resolveRolePolicy — stable ordering', () => {
  it('allowedTools and disallowedTools are sorted (deterministic for snapshots)', () => {
    const policy = resolveRolePolicy('nextjs-base', 'mvp', 'DEV');
    const allowedSorted = [...policy.allowedTools].sort();
    const disallowedSorted = [...policy.disallowedTools].sort();
    expect(policy.allowedTools).toEqual(allowedSorted);
    expect(policy.disallowedTools).toEqual(disallowedSorted);
  });
});

describe('resolveRolePolicy — preserves Phase-1 PR-3 string surface', () => {
  // Snapshots verify that the resolver outputs the same comma-joined strings
  // the eight pipeline files used to declare inline. Regression-fence: any
  // future tightening shows up as a snapshot diff.
  it('story-pipeline DEV (mvp) matches the legacy PR-3 string', () => {
    const cfg = buildAgentConfig({
      boilerplateKind: 'nextjs-base',
      rigor: 'mvp',
      role: 'DEV',
      name: 'Developer',
    });
    expect(cfg.allowedTools).toBe('Bash,Edit,Glob,Grep,Read,Write');
    expect(cfg.disallowedTools).toBe('Agent,Task,WebFetch,WebSearch');
  });

  it('story-pipeline REVIEWER (mvp) matches the legacy PR-3 string', () => {
    const cfg = buildAgentConfig({
      boilerplateKind: 'nextjs-base',
      rigor: 'mvp',
      role: 'REVIEWER',
      name: 'Code Reviewer',
    });
    expect(cfg.allowedTools).toBe('Glob,Grep,Read');
    expect(cfg.disallowedTools).toBe('Agent,Bash,Edit,Task,WebFetch,WebSearch,Write');
  });

  it('story-pipeline TEST (mvp) matches the legacy PR-3 string', () => {
    const cfg = buildAgentConfig({
      boilerplateKind: 'nextjs-base',
      rigor: 'mvp',
      role: 'TEST',
      name: 'Test Author',
    });
    expect(cfg.allowedTools).toBe('Bash,Edit,Glob,Grep,Read,Write');
    expect(cfg.disallowedTools).toBe('Agent,Task,WebFetch,WebSearch');
  });

  it('story-pipeline COMPILER (mvp) matches the legacy PR-3 string', () => {
    const cfg = buildAgentConfig({
      boilerplateKind: 'nextjs-base',
      rigor: 'mvp',
      role: 'COMPILER',
      name: 'Knowledge Compiler',
    });
    expect(cfg.allowedTools).toBe('Edit,Glob,Grep,Read,Write');
    expect(cfg.disallowedTools).toBe('Agent,Bash,Task,WebFetch,WebSearch');
  });

  it('PM matches the legacy string (Read only)', () => {
    const cfg = buildAgentConfig({
      boilerplateKind: 'nextjs-base',
      rigor: 'mvp',
      role: 'PM',
      name: 'Product Manager',
    });
    expect(cfg.allowedTools).toBe('Read');
    // PM is read-only: Write/Edit/Bash join the PR-3 baseline deny.
    expect(cfg.disallowedTools).toBe('Agent,Bash,Edit,Task,WebFetch,WebSearch,Write');
  });

  it('QA gains the PR-3 baseline deny it lacked pre-PR-32 (tightening)', () => {
    const cfg = buildAgentConfig({
      boilerplateKind: 'nextjs-base',
      rigor: 'mvp',
      role: 'QA',
      name: 'Visual QA Tester',
    });
    // Pre-PR-32 visual-qa-pipeline.ts had no disallowedTools at all.
    expect(cfg.allowedTools).toBe('Bash,Glob,Read,Write');
    expect(cfg.disallowedTools).toBe('Agent,Task,WebFetch,WebSearch');
  });
});

describe('policyToAgentConfig', () => {
  it('serializes arrays as comma-joined strings (no spaces)', () => {
    const policy = resolveRolePolicy('nextjs-base', 'mvp', 'DEV');
    const cfg = policyToAgentConfig(policy, 'Developer', 'sonnet');
    expect(cfg.name).toBe('Developer');
    expect(cfg.model).toBe('sonnet');
    expect(cfg.allowedTools).not.toContain(' ');
    expect(cfg.disallowedTools).not.toContain(' ');
  });

  it('omits model when not provided', () => {
    const policy = resolveRolePolicy('nextjs-base', 'mvp', 'DEV');
    const cfg = policyToAgentConfig(policy, 'Developer');
    expect(cfg.model).toBeUndefined();
  });
});
