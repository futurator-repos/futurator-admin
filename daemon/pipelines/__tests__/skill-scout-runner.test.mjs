/**
 * skill-scout-runner.test.mjs — Pipeline v2 Phase 3 / Story 3-C-3-2.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  readProjectManifest,
  buildPromptContext,
  disposeProposals,
  buildDecisionCard,
  buildForensicEvent,
} from '../skill-scout-runner.mjs';

const SHA = 'a'.repeat(40);
const FIXTURE_FEDERATION = {
  'manifest-version': 1,
  sources: [
    {
      id: 'anthropic-official',
      url: 'https://github.com/anthropics/skills',
      'auto-trust': true,
      priority: 1,
    },
  ],
  'refresh-cadence': 'weekly',
};

function makeFedCache(manifest = FIXTURE_FEDERATION) {
  return { get: () => ({ manifest }) };
}

let tmpProject;

beforeEach(() => {
  tmpProject = mkdtempSync(join(tmpdir(), 'skill-scout-runner-'));
});

afterEach(() => {
  rmSync(tmpProject, { recursive: true, force: true });
});

describe('readProjectManifest', () => {
  it('returns null when manifest missing', () => {
    expect(readProjectManifest(tmpProject)).toBeNull();
  });

  it('returns parsed + raw when manifest present', () => {
    mkdirSync(join(tmpProject, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpProject, '.claude', 'skills.manifest.yaml'),
      'project: dino\nmanifest-version: 1\ncore: []\n',
      'utf-8',
    );
    const result = readProjectManifest(tmpProject);
    expect(result).not.toBeNull();
    expect(result.parsed.project).toBe('dino');
    expect(result.raw).toContain('project: dino');
  });

  it('throws on malformed YAML', () => {
    mkdirSync(join(tmpProject, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpProject, '.claude', 'skills.manifest.yaml'),
      'sources: [\n  - id: unclosed\n',
      'utf-8',
    );
    expect(() => readProjectManifest(tmpProject)).toThrow(/parse failed/);
  });
});

describe('buildPromptContext', () => {
  it('reads federation from cache and project manifest from disk', () => {
    mkdirSync(join(tmpProject, '.claude'), { recursive: true });
    writeFileSync(
      join(tmpProject, '.claude', 'skills.manifest.yaml'),
      'project: dino\nmanifest-version: 1\ncore:\n  - source: anthropic-official\n    skill: frontend-design\n    version: sha:' +
        SHA +
        '\nstack: []\ndomain: []\nvendor: []\nplans: {}\ngaps: []\n',
      'utf-8',
    );
    const ctx = buildPromptContext({
      federationCache: makeFedCache(),
      projectPath: tmpProject,
      projectSlug: 'dino',
    });
    expect(ctx.manifestSource).toBe('disk');
    expect(ctx.currentManifestYaml).toContain('frontend-design');
    expect(ctx.federationYaml).toContain('anthropic-official');
  });

  it('uses placeholder manifest when file missing', () => {
    const ctx = buildPromptContext({
      federationCache: makeFedCache(),
      projectPath: tmpProject,
      projectSlug: 'dino-runner-1',
    });
    expect(ctx.manifestSource).toBe('placeholder');
    expect(ctx.currentManifestYaml).toContain('project: dino-runner-1');
    expect(ctx.currentManifestYaml).toContain('manifest-version: 1');
    expect(ctx.currentManifestYaml).toContain('generated-by: placeholder@runner');
  });
});

describe('disposeProposals', () => {
  function proposal(confidence) {
    return {
      kind: 'add',
      source: 's',
      skill: 'k',
      manifestBucket: 'core',
      version: 'sha:' + SHA,
      rationale: 'r',
      verifyNotes: 'v',
      confidence,
    };
  }

  it('noop on empty proposals', () => {
    const d = disposeProposals({
      output: { trigger: 'T1', projectSlug: 'x', proposals: [] },
      rigor: 'mvp',
    });
    expect(d.disposition).toBe('noop');
  });

  it('T3 always surfaces card regardless of confidence', () => {
    const d = disposeProposals({
      output: { trigger: 'T3', projectSlug: 'x', proposals: [proposal(1.0)] },
      rigor: 'prototype',
    });
    expect(d.disposition).toBe('surface-card');
    expect(d.reason).toMatch(/always surfaces/);
  });

  it.each(['T4', 'T6', 'T8'])(
    '%s always surfaces card (Story 3-C-5)',
    (trigger) => {
      const d = disposeProposals({
        output: { trigger, projectSlug: 'x', proposals: [proposal(1.0)] },
        rigor: 'prototype',
      });
      expect(d.disposition).toBe('surface-card');
      expect(d.reason).toContain(trigger);
    },
  );

  it('T5 auto-confirms under prototype with high confidence', () => {
    const d = disposeProposals({
      output: { trigger: 'T5', projectSlug: 'x', proposals: [proposal(0.95)] },
      rigor: 'prototype',
    });
    expect(d.disposition).toBe('auto-confirm');
  });

  it('T7 surfaces card under mvp regardless of confidence', () => {
    const d = disposeProposals({
      output: { trigger: 'T7', projectSlug: 'x', proposals: [proposal(0.99)] },
      rigor: 'mvp',
    });
    expect(d.disposition).toBe('surface-card');
  });

  it('prototype + all high-confidence T1 → auto-confirm', () => {
    const d = disposeProposals({
      output: {
        trigger: 'T1',
        projectSlug: 'x',
        proposals: [proposal(0.95), proposal(0.9)],
      },
      rigor: 'prototype',
    });
    expect(d.disposition).toBe('auto-confirm');
  });

  it('prototype + any low-confidence T1 → surface card', () => {
    const d = disposeProposals({
      output: {
        trigger: 'T1',
        projectSlug: 'x',
        proposals: [proposal(0.95), proposal(0.7)],
      },
      rigor: 'prototype',
    });
    expect(d.disposition).toBe('surface-card');
  });

  it('mvp always surfaces card', () => {
    const d = disposeProposals({
      output: { trigger: 'T2', projectSlug: 'x', proposals: [proposal(0.99)] },
      rigor: 'mvp',
    });
    expect(d.disposition).toBe('surface-card');
  });

  it('production always surfaces card', () => {
    const d = disposeProposals({
      output: { trigger: 'T2', projectSlug: 'x', proposals: [proposal(0.99)] },
      rigor: 'production',
    });
    expect(d.disposition).toBe('surface-card');
  });
});

describe('buildDecisionCard', () => {
  it('produces a medium-severity attention shape with the proposals', () => {
    const card = buildDecisionCard({
      output: {
        trigger: 'T1',
        projectSlug: 'dino',
        proposals: [
          {
            kind: 'add',
            source: 'anthropic-official',
            skill: 'frontend-design',
            manifestBucket: 'core',
            version: 'sha:' + SHA,
            rationale: 'core formatting primitive',
            verifyNotes: 'mit; specific desc',
            confidence: 0.9,
          },
        ],
      },
      projectSlug: 'dino',
      appId: 'app-1',
    });
    expect(card.severity).toBe('medium');
    expect(card.category).toBe('manifest-change-proposed');
    expect(card.title).toContain('T1');
    expect(card.title).toContain('dino');
    expect(card.body).toContain('frontend-design');
    expect(card.actions).toEqual(['confirm', 'edit', 'decline', 'defer']);
    expect(card.context.proposalCount).toBe(1);
  });
});

describe('buildForensicEvent', () => {
  it('emits step.skill-scout.<trigger> with proposal counts', () => {
    const ev = buildForensicEvent({
      trigger: 'T1',
      output: {
        trigger: 'T1',
        projectSlug: 'dino',
        proposals: [{}, {}, {}],
      },
      durationMs: 1234,
      tokensConsumed: 500,
    });
    expect(ev.eventType).toBe('step.skill-scout.T1');
    expect(ev.payload.proposalCount).toBe(3);
    expect(ev.payload.projectSlug).toBe('dino');
    expect(ev.payload.durationMs).toBe(1234);
  });

  it('zero proposals when output undefined', () => {
    const ev = buildForensicEvent({ trigger: 'T2', output: undefined });
    expect(ev.payload.proposalCount).toBe(0);
  });
});
