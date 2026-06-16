import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveCitedSections } from '../lib/story-context-pack.mjs';

/**
 * Story 5.5a — the loop-closure regression guard. A story's `references[]` must
 * inline the VERBATIM cited section body into the Story Context Pack (so DEV
 * reads the contract, not a path). This guards the already-shipped
 * `resolveCitedSections` against drift.
 */
function projectWithArch() {
  const dir = mkdtempSync(join(tmpdir(), 'cited-pack-'));
  mkdirSync(join(dir, 'concept'), { recursive: true });
  // architecture.md with anchors (as write-back produces) + sidecar manifest.
  const md = [
    '<!--§overview-->',
    '## Overview',
    'High-level.',
    '<!--§state-model-->',
    '## State Model',
    'The store holds {score, lives}. Reducers are pure.',
    '<!--§api-contracts-->',
    '## API Contracts',
    'POST /score → 200.',
  ].join('\n');
  writeFileSync(join(dir, 'concept', 'architecture.md'), md, 'utf8');
  const manifest = {
    artifact: 'architecture',
    rev: 1,
    contentHash: 'sha256:arch',
    sections: [
      { id: 'overview', title: 'Overview', lineStart: 1, lineEnd: 3 },
      { id: 'state-model', title: 'State Model', lineStart: 4, lineEnd: 6 },
      { id: 'api-contracts', title: 'API Contracts', lineStart: 7, lineEnd: 9 },
    ],
  };
  writeFileSync(join(dir, 'concept', 'architecture.sections.json'), JSON.stringify(manifest), 'utf8');
  return dir;
}

describe('resolveCitedSections (Story 5.5a — pack inlines the contract)', () => {
  it('inlines the verbatim cited section body, not a path', () => {
    const dir = projectWithArch();
    try {
      const out = resolveCitedSections(dir, [{ source: 'architecture', section: 'state-model' }]);
      expect(out).toHaveLength(1);
      expect(out[0].source).toBe('architecture');
      expect(out[0].section).toBe('state-model');
      expect(out[0].text).toContain('The store holds {score, lives}. Reducers are pure.');
      // Must be the body text, never a file path.
      expect(out[0].text).not.toContain('concept/architecture.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips harness refs and unknown sections gracefully (gate blocks dangling, not the pack)', () => {
    const dir = projectWithArch();
    try {
      const out = resolveCitedSections(dir, [
        { source: 'harness', section: 'whatever' },
        { source: 'architecture', section: 'does-not-exist' },
        { source: 'architecture', section: 'api-contracts' },
      ]);
      expect(out.map((o) => o.section)).toEqual(['api-contracts']);
      expect(out[0].text).toContain('POST /score → 200.');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
