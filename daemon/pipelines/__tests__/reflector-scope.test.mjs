import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildReflectorAgentPrompt } from '../reflector-runner.mjs';
import { applyReflection } from '../reflector-apply.mjs';

afterEach(() => { delete process.env.P3_REFLECTOR_SCOPE; });

describe('buildReflectorAgentPrompt — scope (Connector C)', () => {
  const base = { scope: 'plan', projectSlug: 'demo', planSummary: 's', evidenceBlocks: [] };
  it('default (off) offers org-skill, not skill-requirement — dark', () => {
    const p = buildReflectorAgentPrompt({ ...base, scopeToLanding: false });
    expect(p).toMatch(/org-skill/);
    expect(p).not.toMatch(/skill-requirement/);
  });
  it('scoped (on) offers skill-requirement, drops org-skill', () => {
    const p = buildReflectorAgentPrompt({ ...base, scopeToLanding: true });
    expect(p).toMatch(/skill-requirement/);
    expect(p).not.toMatch(/org-skill/);
  });
});

describe('applyReflection — skill-requirement → scout ledger', () => {
  it('appends the requirement to .context/skill-requirements.jsonl (idempotent)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'reflreq-'));
    try {
      const proposal = { id: 'r1', target: 'skill-requirement', skillName: 'playwright-a11y', content: 'need an accessibility probe technique', rationale: 'AC-3 unbindable' };
      const r1 = await applyReflection({ workingDir: dir, projectSlug: 'demo', proposal });
      expect(r1.status).toBe('applied');
      const ledger = join(dir, '.context', 'skill-requirements.jsonl');
      expect(existsSync(ledger)).toBe(true);
      expect(readFileSync(ledger, 'utf-8')).toMatch(/playwright-a11y/);
      // idempotent on id
      const r2 = await applyReflection({ workingDir: dir, projectSlug: 'demo', proposal });
      expect(r2.status).toBe('applied');
      expect(readFileSync(ledger, 'utf-8').trim().split('\n')).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
