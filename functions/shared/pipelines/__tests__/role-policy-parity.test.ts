import { describe, it, expect } from 'vitest';
import { resolveRolePolicy, policyToAgentConfig } from '../role-policy';
// Daemon mirror is .mjs; vitest resolves both ext flavors at runtime.
// @ts-expect-error — pure-JS mirror has no .d.ts
import {
  buildAgentConfig as buildAgentConfigMjs,
  SHARED_ROLES,
} from '../../../../daemon/pipelines/lib/role-policy.mjs';

/**
 * Parity test — PR-32b.
 *
 * Asserts that for every shared role, the TS resolver and the daemon-side
 * .mjs resolver produce byte-identical AgentConfig strings. Catches drift
 * if either side gets updated without the other.
 *
 * Only the shared roles (TEST/DEV/REVIEWER/COMPILER/QA/PM/API_AUTHOR) are
 * cross-validated — daemon-only roles (CONVERSATION/REFLECTION/DEPLOY)
 * are tested per-side (the TS test exercises them; the MJS test does too)
 * but they aren't candidates for parity since the API Lambda never spawns
 * them.
 *
 * Note: the TS resolver takes (boilerplateKind, rigor, role); the MJS
 * mirror just takes role (no rigor/kind awareness yet — Story 2-A-1-2).
 * For parity we hold rigor='mvp' and kind='nextjs-base' on the TS side.
 */
describe('role-policy parity (TS ↔ MJS)', () => {
  for (const role of SHARED_ROLES as Array<
    'API_AUTHOR' | 'TEST' | 'DEV' | 'REVIEWER' | 'COMPILER' | 'QA' | 'PM'
  >) {
    it(`${role}: TS and MJS produce byte-identical AgentConfig strings`, () => {
      const tsPolicy = resolveRolePolicy('nextjs-base', 'mvp', role);
      const tsCfg = policyToAgentConfig(tsPolicy, '_');
      const mjsCfg = buildAgentConfigMjs({ role, name: '_' });
      expect(mjsCfg.allowedTools, `${role} allowed`).toBe(tsCfg.allowedTools);
      expect(mjsCfg.disallowedTools, `${role} disallowed`).toBe(tsCfg.disallowedTools);
    });
  }
});
