/**
 * scan-finding-map.test.mjs — locks B1: deterministic recon rows → ScanFinding
 * with the evidence hints the planner reads, + the anchored-path hallucination guard.
 */

import { describe, it, expect } from 'vitest';
import {
  hotspotToFinding,
  privacyToFindings,
  dropUnanchored,
  boundaryOf,
  shardKeyForFile,
  mapSeverity,
} from '../lib/scan-finding-map.mjs';

describe('helpers', () => {
  it('boundaryOf + shardKeyForFile use the §sys convention', () => {
    expect(boundaryOf('src/components/ui/button.tsx')).toBe('src/components/ui');
    expect(shardKeyForFile('src/components/ui/button.tsx')).toBe('§sys:src--components--ui');
    expect(boundaryOf('index.ts')).toBe('.');
  });
  it('maps hotspot severity to ScanSeverity', () => {
    expect(mapSeverity('critical')).toBe('High');
    expect(mapSeverity('high')).toBe('High');
    expect(mapSeverity('medium')).toBe('Medium');
    expect(mapSeverity('low')).toBe('Low');
  });
});

describe('hotspotToFinding', () => {
  it('god-object → architecture, godFile hint, effort from method count', () => {
    const f = hotspotToFinding({
      kind: 'god-object',
      score: 90,
      severity: 'critical',
      title: 'God-object: Store (44 methods)',
      files: ['src/lib/store.ts'],
      evidence: { methods: 44, importers: 38, community: 7, file: 'src/lib/store.ts' },
      suggestedAction: 'Split into modules',
    });
    expect(f.dimension).toBe('architecture');
    expect(f.severity).toBe('High');
    expect(f.effort).toBe('Large'); // methods > 25
    expect(f.evidence.godFile).toBe(true);
    expect(f.evidence.hotspotKind).toBe('god-object');
    expect(f.location).toBe('src/lib/store.ts:1');
    expect(f.area).toBe('§sys:src--lib');
  });

  it('dead-code safe-candidate → code-quality, Trivial, isDeletion', () => {
    const f = hotspotToFinding({
      kind: 'dead-code',
      score: 40,
      severity: 'medium',
      title: 'Dead file: suggestions.ts',
      files: ['src/lib/suggestions.ts'],
      evidence: { confidence: 'safe-candidate', knipFlagged: 1 },
      suggestedAction: 'Delete or wire',
    });
    expect(f.dimension).toBe('code-quality-refactoring');
    expect(f.effort).toBe('Trivial');
    expect(f.evidence.isDeletion).toBe(true);
    expect(f.evidence.safeCandidate).toBe(true);
  });

  it('design-system-consolidation → area UI; helperExtraction for duplicate-subsystem', () => {
    expect(hotspotToFinding({ kind: 'design-system-consolidation', severity: 'medium', title: 'DS', files: ['src/components/badge.tsx'], evidence: {} }).area).toBe('UI');
    expect(hotspotToFinding({ kind: 'duplicate-subsystem', severity: 'high', title: 'dup', files: ['a.ts'], evidence: { count: 3 } }).evidence.helperExtraction).toBe(true);
  });

  it('tags isFoundation when the file is a high-fan-in hub', () => {
    const f = hotspotToFinding(
      { kind: 'god-object', severity: 'high', title: 'x', files: ['src/lib/constants.ts'], evidence: { methods: 5, file: 'src/lib/constants.ts' } },
      new Set(['src/lib/constants.ts']),
    );
    expect(f.evidence.isFoundation).toBe(true);
  });
});

describe('privacyToFindings', () => {
  it('one compliance finding per category, category-first', () => {
    const summary = {
      byRegulation: {
        gdpr: { categories: [
          { category: 'Personal Data Store', severity: 'high', fileCount: 30, remediation: 'Encrypt at rest', citation: ['x'], sampleFiles: [{ file: 'src/db/users.ts', score: 75 }] },
        ] },
        'eu-ai-act': { categories: [
          { category: 'AI System In Use', severity: 'high', fileCount: 2, remediation: 'Document', citation: ['y'], sampleFiles: [] },
        ] },
      },
    };
    const out = privacyToFindings(summary);
    expect(out).toHaveLength(2);
    expect(out.every((f) => f.dimension === 'compliance')).toBe(true);
    const store = out.find((f) => f.issue === 'Personal Data Store');
    expect(store.effort).toBe('Large'); // fileCount 30 > 10
    expect(store.area).toBe('§sys:src--db');
    expect(store.evidence.regulation).toBe('gdpr');
  });
});

describe('dropUnanchored', () => {
  const anchored = new Set(['src/real.ts']);
  it('keeps all deterministic findings; drops unanchored LLM findings', () => {
    const findings = [
      { source: 'deterministic', location: 'src/whatever.ts:1' },
      { source: 'llm', location: 'src/real.ts:10' },
      { source: 'llm', location: 'src/hallucinated.ts:5' },
      { source: 'llm', location: 'multiple' },
    ];
    const kept = dropUnanchored(findings, anchored);
    expect(kept.map((f) => f.location)).toEqual(['src/whatever.ts:1', 'src/real.ts:10', 'multiple']);
  });
});
