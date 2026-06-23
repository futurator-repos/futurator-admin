/**
 * build-plan-intent.test.ts — Refactoring Assessment Module (Epic D3, FR35).
 *
 * The Create-plan seam compiles selected hotspots into a NewPlanModal intent.
 * Asserts the Strangler-Fig framing, per-hotspot lines, the empty case, and the
 * 2000-char cap (NewPlanModal rejects intents over the planNameSchema limit).
 */

import { describe, it, expect } from 'vitest';
import { buildPlanIntent } from '../assess-tab';
import type { AuditHotspot } from '@/types/refactor-audit';

const hotspot = (over: Partial<AuditHotspot> = {}): AuditHotspot => ({
  kind: 'god-object',
  score: 90,
  severity: 'critical',
  title: 'God-object: AWSProfileStorage (44 methods, 38 importers)',
  files: ['src/lib/aws-profile-storage.ts'],
  evidence: { methods: 44, importers: 38 },
  suggestedAction: 'Split into ~6 domain repositories along method seams.',
  ...over,
});

describe('buildPlanIntent', () => {
  it('returns empty string for no hotspots', () => {
    expect(buildPlanIntent([])).toBe('');
  });

  it('frames the work as a test-gated Strangler-Fig', () => {
    const intent = buildPlanIntent([hotspot()]);
    expect(intent).toMatch(/Strangler-Fig/);
    expect(intent).toMatch(/grep-zero/);
    expect(intent).toMatch(/test net BEFORE any/);
  });

  it('includes one line per hotspot with severity + title + action', () => {
    const intent = buildPlanIntent([
      hotspot(),
      hotspot({
        kind: 'dead-code',
        severity: 'medium',
        title: 'Dead files: 12',
        suggestedAction: 'Safe-delete.',
      }),
    ]);
    expect(intent).toMatch(/\[critical\] God-object: AWSProfileStorage/);
    expect(intent).toMatch(/\[medium\] Dead files: 12/);
    expect(intent).toMatch(/→ Safe-delete\./);
  });

  it('caps the intent at 2000 chars so NewPlanModal accepts it', () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      hotspot({
        title: `Hotspot number ${i} with a fairly long descriptive title`,
        suggestedAction: 'x'.repeat(80),
      }),
    );
    const intent = buildPlanIntent(many);
    expect(intent.length).toBeLessThanOrEqual(2000);
    expect(intent).toMatch(/truncated/);
  });
});
