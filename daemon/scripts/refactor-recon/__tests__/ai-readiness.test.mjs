/**
 * ai-readiness.test.mjs — content/path-signal AI-agent readiness detector. Must
 * detect Claude Code (skills/subagents/MCP/hooks) + other agent tools anywhere,
 * and report the gentle onboarding nudge for a plain repo.
 */

import { describe, it, expect } from 'vitest';
import { buildAiReadiness } from '../ai-readiness.mjs';

const f = (rel, content) => ({ rel, content });
const tool = (r, name) => r.tools.find((t) => t.name === name);
const has = (r, check) => r.findings.some((x) => x.evidence?.check === check);

describe('buildAiReadiness', () => {
  it('detects a .claude/ with skills + subagents + MCP + hooks', () => {
    const r = buildAiReadiness([
      f('CLAUDE.md', '# project context'),
      f('.claude/skills/graphify/SKILL.md', '# graphify'),
      f('.claude/skills/deploy/SKILL.md', '# deploy'),
      f('.claude/agents/reviewer.md', '# reviewer'),
      f('.claude/commands/ship.md', '# /ship'),
      f('.claude/settings.json', '{"hooks":{"PreToolUse":[]},"mcpServers":{"graph":{}}}'),
    ]);
    expect(r.hasClaudeCode).toBe(true);
    expect(r.skillCount).toBe(2);
    expect(r.agentCount).toBe(1);
    expect(r.commandCount).toBe(1);
    expect(r.hasMcp).toBe(true);
    expect(r.hasHooks).toBe(true);
    expect(tool(r, 'Claude Code').present).toBe(true);
    expect(r.summary).toContain('Claude Code');
    expect(r.summary).toContain('2 skills');
    expect(r.summary).toContain('MCP');
    expect(has(r, 'no-ai-onboarding')).toBe(false);
  });

  it('detects MCP via a bare .mcp.json (no settings)', () => {
    const r = buildAiReadiness([f('CLAUDE.md', '# ctx'), f('.mcp.json', '{"mcpServers":{}}')]);
    expect(r.hasMcp).toBe(true);
    expect(r.hasHooks).toBe(false);
  });

  it('detects a bare AGENTS.md-only repo (no Claude Code, no finding)', () => {
    const r = buildAiReadiness([f('AGENTS.md', '# agent instructions'), f('src/a.ts', 'export const x = 1')]);
    expect(r.hasClaudeCode).toBe(false);
    expect(tool(r, 'AGENTS.md').present).toBe(true);
    expect(r.summary).toContain('AGENTS.md');
    expect(has(r, 'no-ai-onboarding')).toBe(false);
  });

  it('detects other agent tools folder-agnostically (Cursor / Copilot)', () => {
    const cursor = buildAiReadiness([f('.cursorrules', 'be terse')]);
    expect(tool(cursor, 'Cursor').present).toBe(true);
    expect(has(cursor, 'no-ai-onboarding')).toBe(false); // cursor suppresses the nudge

    const copilot = buildAiReadiness([f('.github/copilot-instructions.md', '# copilot')]);
    expect(tool(copilot, 'GitHub Copilot').present).toBe(true);
    expect(copilot.hasClaudeCode).toBe(false);
    expect(has(copilot, 'no-ai-onboarding')).toBe(true); // copilot alone does NOT suppress
  });

  it('clean-negative: plain repo → no Claude Code + the gentle onboarding finding', () => {
    const r = buildAiReadiness([f('README.md', '# app'), f('src/index.ts', 'export const x = 1')]);
    expect(r.hasClaudeCode).toBe(false);
    expect(r.skillCount).toBe(0);
    expect(r.summary).toBe('no AI-agent config detected');
    expect(has(r, 'no-ai-onboarding')).toBe(true);
    const finding = r.findings.find((x) => x.evidence?.check === 'no-ai-onboarding');
    expect(finding.dimension).toBe('code-quality-refactoring');
    expect(finding.source).toBe('deterministic');
    expect(finding.severity).toBe('Low');
  });
});
