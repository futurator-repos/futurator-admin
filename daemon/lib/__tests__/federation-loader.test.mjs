/**
 * federation-loader.test.mjs — Pipeline v2 Phase 3 / Story 3-C-1-1.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadFederation,
  validateFederationShape,
  manifestSha,
  createFederationCache,
  EMBEDDED_DEFAULT_FEDERATION,
} from '../federation-loader.mjs';

let tmpDir;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'fed-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('validateFederationShape', () => {
  it('accepts a valid manifest', () => {
    expect(validateFederationShape(EMBEDDED_DEFAULT_FEDERATION)).toBeNull();
  });

  it('rejects non-object', () => {
    expect(validateFederationShape(null)).toMatch(/object/);
    expect(validateFederationShape('string')).toMatch(/object/);
    expect(validateFederationShape([])).toMatch(/object/);
  });

  it('rejects unsupported manifest-version', () => {
    expect(
      validateFederationShape({
        'manifest-version': 2,
        sources: [{ id: 'x', url: 'https://x.com', 'auto-trust': true, priority: 1 }],
        'refresh-cadence': 'weekly',
      }),
    ).toMatch(/manifest-version/);
  });

  it('rejects empty sources', () => {
    expect(
      validateFederationShape({
        'manifest-version': 1,
        sources: [],
        'refresh-cadence': 'weekly',
      }),
    ).toMatch(/sources/);
  });

  it('rejects non-http URL', () => {
    expect(
      validateFederationShape({
        'manifest-version': 1,
        sources: [{ id: 'x', url: 'file:///etc/passwd', 'auto-trust': true, priority: 1 }],
        'refresh-cadence': 'weekly',
      }),
    ).toMatch(/url/);
  });

  it('rejects non-positive priority', () => {
    expect(
      validateFederationShape({
        'manifest-version': 1,
        sources: [{ id: 'x', url: 'https://x.com', 'auto-trust': true, priority: -1 }],
        'refresh-cadence': 'weekly',
      }),
    ).toMatch(/priority/);
  });

  it('rejects unknown refresh-cadence', () => {
    expect(
      validateFederationShape({
        'manifest-version': 1,
        sources: [{ id: 'x', url: 'https://x.com', 'auto-trust': true, priority: 1 }],
        'refresh-cadence': 'forever',
      }),
    ).toMatch(/refresh-cadence/);
  });

  it('accepts per-source refresh-cadence override', () => {
    expect(
      validateFederationShape({
        'manifest-version': 1,
        sources: [
          {
            id: 'x',
            url: 'https://x.com',
            'auto-trust': false,
            priority: 99,
            'refresh-cadence': 'daily',
          },
        ],
        'refresh-cadence': 'weekly',
      }),
    ).toBeNull();
  });
});

describe('loadFederation', () => {
  it('returns fallback when file missing', () => {
    const result = loadFederation(join(tmpDir, 'absent.yaml'));
    expect(result.source).toBe('fallback');
    expect(result.error).toBeUndefined();
    expect(result.manifest).toEqual(EMBEDDED_DEFAULT_FEDERATION);
  });

  it('returns parsed manifest from valid file', () => {
    const path = join(tmpDir, 'valid.yaml');
    writeFileSync(
      path,
      `
manifest-version: 1
sources:
  - id: anthropic-official
    url: https://github.com/anthropics/skills
    auto-trust: true
    priority: 1
  - id: futurator-internal
    url: https://github.com/futurator/futurator-skills
    auto-trust: true
    priority: 2
refresh-cadence: weekly
`,
      'utf-8',
    );
    const result = loadFederation(path);
    expect(result.source).toBe('file');
    expect(result.error).toBeUndefined();
    expect(result.manifest.sources).toHaveLength(2);
    expect(result.manifest.sources[0].id).toBe('anthropic-official');
  });

  it('falls back with error when YAML is malformed', () => {
    const path = join(tmpDir, 'bad.yaml');
    writeFileSync(path, 'sources: [\n  - id: missing-close\n', 'utf-8');
    const result = loadFederation(path);
    expect(result.source).toBe('fallback');
    expect(result.error).toMatch(/parse/);
    expect(result.manifest).toEqual(EMBEDDED_DEFAULT_FEDERATION);
  });

  it('falls back with error when shape is invalid', () => {
    const path = join(tmpDir, 'bad-shape.yaml');
    writeFileSync(path, `manifest-version: 1\nsources: []\nrefresh-cadence: weekly\n`, 'utf-8');
    const result = loadFederation(path);
    expect(result.source).toBe('fallback');
    expect(result.error).toMatch(/validation failed/);
    expect(result.manifest).toEqual(EMBEDDED_DEFAULT_FEDERATION);
  });
});

describe('manifestSha', () => {
  it('is deterministic for the same manifest', () => {
    expect(manifestSha(EMBEDDED_DEFAULT_FEDERATION)).toBe(
      manifestSha(EMBEDDED_DEFAULT_FEDERATION),
    );
  });

  it('changes when manifest changes', () => {
    const variant = {
      ...EMBEDDED_DEFAULT_FEDERATION,
      'refresh-cadence': 'daily',
    };
    expect(manifestSha(variant)).not.toBe(manifestSha(EMBEDDED_DEFAULT_FEDERATION));
  });

  it('returns a 64-char hex string', () => {
    const sha = manifestSha(EMBEDDED_DEFAULT_FEDERATION);
    expect(sha).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('createFederationCache', () => {
  it('serves the loaded manifest on get()', () => {
    const cache = createFederationCache(join(tmpDir, 'absent.yaml'));
    const { manifest, source } = cache.get();
    expect(source).toBe('fallback');
    expect(manifest).toEqual(EMBEDDED_DEFAULT_FEDERATION);
  });

  it('refresh() picks up file changes', () => {
    const path = join(tmpDir, 'refresh.yaml');

    const cache = createFederationCache(path);
    expect(cache.get().source).toBe('fallback');

    writeFileSync(
      path,
      `
manifest-version: 1
sources:
  - id: x
    url: https://x.com
    auto-trust: true
    priority: 1
refresh-cadence: daily
`,
      'utf-8',
    );

    const refresh = cache.refresh();
    expect(refresh.source).toBe('file');
    expect(refresh.changed).toBe(true);
    expect(refresh.newSha).not.toBe(refresh.previousSha);
    expect(cache.get().manifest.sources[0].id).toBe('x');
  });

  it('refresh() reports no change when content unchanged', () => {
    const path = join(tmpDir, 'static.yaml');
    writeFileSync(
      path,
      `
manifest-version: 1
sources:
  - id: x
    url: https://x.com
    auto-trust: true
    priority: 1
refresh-cadence: weekly
`,
      'utf-8',
    );
    const cache = createFederationCache(path);
    cache.get();
    const refresh = cache.refresh();
    expect(refresh.changed).toBe(false);
  });
});
