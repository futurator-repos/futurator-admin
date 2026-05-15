/**
 * persona-loader.test.mjs — Pipeline v2 Phase 3 / Story 3-E-8-1 (PR-82).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  canonicalPersonaTag,
  resolvePersonaPath,
  loadPersona,
  snapshotLatestPersonaVersions,
} from '../persona-loader.mjs';

let tmpRoot;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'personas-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('canonicalPersonaTag', () => {
  it('accepts bare semver', () => {
    expect(canonicalPersonaTag('bedrock', '1.2.0')).toBe('bedrock-v1.2.0');
  });

  it('accepts v-prefixed semver', () => {
    expect(canonicalPersonaTag('bedrock', 'v1.2.0')).toBe('bedrock-v1.2.0');
  });

  it('strips redundant persona prefix', () => {
    expect(canonicalPersonaTag('bedrock', 'bedrock-v1.2.0')).toBe('bedrock-v1.2.0');
    expect(canonicalPersonaTag('bedrock', 'bedrock-1.2.0')).toBe('bedrock-v1.2.0');
  });
});

describe('resolvePersonaPath', () => {
  it('returns missing when no persona dir', () => {
    const { source } = resolvePersonaPath('bedrock', 'v1.0.0', { root: tmpRoot });
    expect(source).toBe('missing');
  });

  it('resolves pinned version when file exists', () => {
    mkdirSync(join(tmpRoot, 'bedrock'), { recursive: true });
    writeFileSync(join(tmpRoot, 'bedrock', 'bedrock-v1.2.0.md'), '# bedrock v1.2.0', 'utf-8');
    const { path, source } = resolvePersonaPath('bedrock', 'v1.2.0', { root: tmpRoot });
    expect(source).toBe('pinned');
    expect(path).toContain('bedrock-v1.2.0.md');
  });

  it('falls back to latest.md when pin file missing', () => {
    mkdirSync(join(tmpRoot, 'bedrock'), { recursive: true });
    writeFileSync(join(tmpRoot, 'bedrock', 'latest.md'), '# bedrock latest', 'utf-8');
    const { source } = resolvePersonaPath('bedrock', 'v9.9.9', { root: tmpRoot });
    expect(source).toBe('latest');
  });

  it('falls back to latest.md when no pin provided', () => {
    mkdirSync(join(tmpRoot, 'nimbus'), { recursive: true });
    writeFileSync(join(tmpRoot, 'nimbus', 'latest.md'), '# nimbus latest', 'utf-8');
    const { source } = resolvePersonaPath('nimbus', undefined, { root: tmpRoot });
    expect(source).toBe('latest');
  });
});

describe('loadPersona', () => {
  beforeEach(() => {
    mkdirSync(join(tmpRoot, 'bedrock'), { recursive: true });
    writeFileSync(join(tmpRoot, 'bedrock', 'bedrock-v1.0.0.md'), '# bedrock v1.0.0', 'utf-8');
    writeFileSync(join(tmpRoot, 'bedrock', 'bedrock-v1.2.0.md'), '# bedrock v1.2.0', 'utf-8');
    writeFileSync(join(tmpRoot, 'bedrock', 'latest.md'), '# bedrock latest', 'utf-8');
  });

  it('returns null when persona missing entirely', () => {
    const result = loadPersona({ personaName: 'unknown', plan: {}, root: tmpRoot });
    expect(result).toBeNull();
  });

  it('loads pinned version from Plan.personaPinned', () => {
    const result = loadPersona({
      personaName: 'bedrock',
      plan: { personaPinned: { bedrock: 'v1.0.0' } },
      root: tmpRoot,
    });
    expect(result?.source).toBe('pinned');
    expect(result?.content).toContain('v1.0.0');
    expect(result?.version).toBe('bedrock-v1.0.0');
  });

  it('falls back to latest when plan has no pin', () => {
    const result = loadPersona({ personaName: 'bedrock', plan: {}, root: tmpRoot });
    expect(result?.source).toBe('latest');
    expect(result?.content).toContain('latest');
    expect(result?.version).toBe('latest');
  });

  it('falls back to latest when pin file missing', () => {
    const result = loadPersona({
      personaName: 'bedrock',
      plan: { personaPinned: { bedrock: 'v9.9.9' } },
      root: tmpRoot,
    });
    expect(result?.source).toBe('latest');
  });

  it('returns null when personaName empty', () => {
    expect(loadPersona({ personaName: '', plan: {}, root: tmpRoot })).toBeNull();
  });
});

describe('snapshotLatestPersonaVersions', () => {
  it('returns empty when personas-root missing', () => {
    rmSync(tmpRoot, { recursive: true, force: true });
    const snap = snapshotLatestPersonaVersions({ root: tmpRoot });
    expect(snap).toEqual({});
  });

  it('finds highest-semver tag per persona', () => {
    mkdirSync(join(tmpRoot, 'bedrock'), { recursive: true });
    writeFileSync(join(tmpRoot, 'bedrock', 'bedrock-v1.0.0.md'), '');
    writeFileSync(join(tmpRoot, 'bedrock', 'bedrock-v1.2.0.md'), '');
    writeFileSync(join(tmpRoot, 'bedrock', 'bedrock-v1.0.5.md'), '');

    mkdirSync(join(tmpRoot, 'nimbus'), { recursive: true });
    writeFileSync(join(tmpRoot, 'nimbus', 'nimbus-v0.4.0.md'), '');

    const snap = snapshotLatestPersonaVersions({ root: tmpRoot });
    expect(snap.bedrock).toBe('v1.2.0');
    expect(snap.nimbus).toBe('v0.4.0');
  });

  it('ignores personas with no tagged versions (only latest.md)', () => {
    mkdirSync(join(tmpRoot, 'rick'), { recursive: true });
    writeFileSync(join(tmpRoot, 'rick', 'latest.md'), '# rick latest');
    const snap = snapshotLatestPersonaVersions({ root: tmpRoot });
    expect(snap.rick).toBeUndefined();
  });

  it('handles 10.0.0 > 2.0.0 (numeric semver)', () => {
    mkdirSync(join(tmpRoot, 'big'), { recursive: true });
    writeFileSync(join(tmpRoot, 'big', 'big-v2.0.0.md'), '');
    writeFileSync(join(tmpRoot, 'big', 'big-v10.0.0.md'), '');
    const snap = snapshotLatestPersonaVersions({ root: tmpRoot });
    expect(snap.big).toBe('v10.0.0');
  });
});
