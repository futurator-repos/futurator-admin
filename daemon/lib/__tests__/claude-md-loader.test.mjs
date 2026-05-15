/**
 * claude-md-loader.test.mjs — Pipeline v2 Phase 3 / Story 3-E-4-1 (PR-80).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readClaudeMd,
  buildAgentSystemPrompt,
  provenanceLabel,
} from '../claude-md-loader.mjs';

let tmpProject;

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), 'claude-md-'));
});

afterEach(() => {
  rmSync(tmpProject, { recursive: true, force: true });
});

describe('readClaudeMd', () => {
  it('returns null when CLAUDE.md missing', () => {
    expect(readClaudeMd(tmpProject)).toBeNull();
  });

  it('returns content + sha + sizeBytes when present', () => {
    const body = '# Project: dino\n\n## What this is\n\nA test project.\n';
    writeFileSync(join(tmpProject, 'CLAUDE.md'), body, 'utf-8');
    const result = readClaudeMd(tmpProject);
    expect(result).not.toBeNull();
    expect(result.content).toBe(body);
    expect(result.sha).toMatch(/^[a-f0-9]{16}$/);
    expect(result.sizeBytes).toBe(Buffer.byteLength(body, 'utf-8'));
    expect(result.truncated).toBe(false);
  });

  it('truncates oversized CLAUDE.md (> 100KB)', () => {
    const huge = 'x'.repeat(101 * 1024);
    writeFileSync(join(tmpProject, 'CLAUDE.md'), huge, 'utf-8');
    const result = readClaudeMd(tmpProject);
    expect(result.truncated).toBe(true);
    expect(result.content).toContain('truncated by daemon');
    expect(result.sizeBytes).toBeGreaterThan(100 * 1024);
  });

  it('sha changes when content changes', () => {
    writeFileSync(join(tmpProject, 'CLAUDE.md'), 'v1', 'utf-8');
    const a = readClaudeMd(tmpProject);
    writeFileSync(join(tmpProject, 'CLAUDE.md'), 'v2', 'utf-8');
    const b = readClaudeMd(tmpProject);
    expect(a.sha).not.toBe(b.sha);
  });
});

describe('buildAgentSystemPrompt', () => {
  it('prepends CLAUDE.md when present, then context pack, then role prompt', () => {
    writeFileSync(join(tmpProject, 'CLAUDE.md'), '# Project: dino\n## What\nA test.', 'utf-8');
    const result = buildAgentSystemPrompt({
      workingDir: tmpProject,
      contextPack: 'fileTree: []',
      rolePrompt: 'You are DEV.',
    });
    const lines = result.systemPrompt.split('\n');
    const claudeIdx = lines.findIndex((l) => l.startsWith('# Project CLAUDE.md'));
    const ctxIdx = lines.findIndex((l) => l.startsWith('# Project Context'));
    const roleIdx = lines.findIndex((l) => l === 'You are DEV.');
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(ctxIdx).toBeGreaterThan(claudeIdx);
    expect(roleIdx).toBeGreaterThan(ctxIdx);
    expect(result.claudeMdLoaded).toBe(true);
    expect(result.claudeMdSha).toMatch(/^[a-f0-9]{16}$/);
  });

  it('omits CLAUDE.md section when missing', () => {
    const result = buildAgentSystemPrompt({
      workingDir: tmpProject,
      contextPack: 'fileTree: []',
      rolePrompt: 'You are DEV.',
    });
    expect(result.systemPrompt).not.toContain('# Project CLAUDE.md');
    expect(result.claudeMdLoaded).toBe(false);
    expect(result.claudeMdSha).toBeUndefined();
  });

  it('omits context-pack section when empty', () => {
    writeFileSync(join(tmpProject, 'CLAUDE.md'), '# Project', 'utf-8');
    const result = buildAgentSystemPrompt({
      workingDir: tmpProject,
      contextPack: '',
      rolePrompt: 'You are DEV.',
    });
    expect(result.systemPrompt).not.toContain('# Project Context');
  });

  it('includes truncated marker but does not flag claudeMdLoaded=true', () => {
    writeFileSync(join(tmpProject, 'CLAUDE.md'), 'x'.repeat(101 * 1024), 'utf-8');
    const result = buildAgentSystemPrompt({
      workingDir: tmpProject,
      contextPack: '',
      rolePrompt: 'You are DEV.',
    });
    expect(result.systemPrompt).toContain('truncated by daemon');
    expect(result.claudeMdLoaded).toBe(false);
  });
});

describe('provenanceLabel', () => {
  it('reports missing when no file', () => {
    expect(provenanceLabel(tmpProject)).toBe('claude-md: missing');
  });

  it('reports loaded with sha + size', () => {
    writeFileSync(join(tmpProject, 'CLAUDE.md'), 'tiny', 'utf-8');
    const label = provenanceLabel(tmpProject);
    expect(label).toMatch(/^claude-md: loaded sha=[a-f0-9]{8} 4B$/);
  });

  it('reports truncated', () => {
    writeFileSync(join(tmpProject, 'CLAUDE.md'), 'x'.repeat(101 * 1024), 'utf-8');
    expect(provenanceLabel(tmpProject)).toMatch(/^claude-md: truncated/);
  });
});
