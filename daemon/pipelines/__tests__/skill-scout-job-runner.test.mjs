/**
 * skill-scout-job-runner.test.mjs — Pipeline v2 Phase 3-C Epic 3 (Story
 * 3.1, 2026-05-20).
 *
 * Hermetic vitest run of `runSkillScoutJob`. All side-effect deps are
 * injected — no real Claude spawn, no real attention writer, no real
 * federation file, no real installer.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  validateSkillScoutJob,
  runSkillScoutJob,
} from '../skill-scout-job-runner.mjs';

// ── Test helpers ──

const EMPTY_MANIFEST_YAML = `project: my-app
manifest-version: 1
core: []
stack: []
domain: []
vendor: []
plans: {}
gaps: []
`;

function makeFederationCache() {
  return {
    get: () => ({
      manifest: {
        'manifest-version': 1,
        sources: [
          { id: 'anthropic-official', url: 'https://github.com/anthropics/skills', 'auto-trust': true, priority: 1 },
        ],
        'refresh-cadence': 'weekly',
      },
    }),
  };
}

function makeProjectDir() {
  const dir = mkdtempSync(join(tmpdir(), 'scout-job-test-'));
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(join(dir, '.claude/skills.manifest.yaml'), EMPTY_MANIFEST_YAML, 'utf-8');
  return dir;
}

/**
 * Build a minimal valid skill-scout job row + matching ctx for the
 * happy path. Tests override fields as needed.
 */
function makeJobAndCtx({
  trigger = 'T1',
  rigor = 'prototype',
  appId = 'dino-test-3',
  proposals = [],
  agentEmitsValidJson = true,
  agentThrows = null,
  validatorReturns = null,
  applyThrows = null,
  applyReturns = { written: 1 },
} = {}) {
  const projectPath = makeProjectDir();
  const projectSlug = appId;

  const job = {
    jobId: 'job-test-1234',
    jobType: 'skill-scout',
    skillScoutPayload: {
      trigger,
      projectSlug,
      appId,
      planId: trigger === 'T2' ? 'plan-test-1' : null,
      planIntent: trigger === 'T2' ? 'build me a snake game' : undefined,
      rigor,
    },
    pipeline: {
      maxIterations: 2,
      agents: { SKILL_SCOUT: {} },
      steps: [{ id: 'skill-scout-resolve', agentId: 'SKILL_SCOUT', prompt: '' }],
    },
  };

  const attentionCalls = [];
  const pushEventCalls = [];
  const applyCalls = [];

  const ctx = {
    federationCache: makeFederationCache(),
    getProjectPath: (slug) => {
      if (slug !== projectSlug) throw new Error(`unexpected slug ${slug}`);
      return projectPath;
    },
    executeAgentStep: async () => {
      if (agentThrows) throw agentThrows;
      const json = JSON.stringify({
        trigger,
        projectSlug,
        proposals,
      });
      return {
        variables: { SKILL_PROPOSALS_JSON: agentEmitsValidJson ? json : '' },
        tokensConsumed: 1500,
      };
    },
    validateSkillProposalsBlock: (raw) => {
      if (validatorReturns) return validatorReturns;
      try {
        const parsed = JSON.parse(raw);
        return { ok: true, output: parsed };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    applyConfirmedProposals: async (args) => {
      applyCalls.push(args);
      if (applyThrows) throw applyThrows;
      return applyReturns;
    },
    writeAttentionItem: async (item) => {
      attentionCalls.push(item);
    },
    pushEvent: async (...args) => {
      pushEventCalls.push(args);
    },
  };

  return { job, ctx, projectPath, attentionCalls, pushEventCalls, applyCalls };
}

// ── Validation ──

describe('validateSkillScoutJob', () => {
  it('accepts a well-formed job', () => {
    const { job } = makeJobAndCtx();
    expect(validateSkillScoutJob(job)).toEqual({ ok: true });
  });

  it.each([
    ['no job', null, 'job-missing'],
    ['wrong jobType', { jobType: 'other' }, 'jobType-mismatch'],
    [
      'missing jobId',
      { jobType: 'skill-scout', skillScoutPayload: { trigger: 'T1' } },
      'jobId-missing',
    ],
  ])('rejects %s', (_label, job, expectedReason) => {
    expect(validateSkillScoutJob(job)).toEqual({ ok: false, reason: expectedReason });
  });

  it('rejects missing payload', () => {
    const job = { jobType: 'skill-scout', jobId: 'x' };
    expect(validateSkillScoutJob(job).reason).toBe('skillScoutPayload-missing');
  });

  it('rejects invalid trigger', () => {
    const job = {
      jobType: 'skill-scout',
      jobId: 'x',
      skillScoutPayload: { trigger: 'T99', projectSlug: 'a', appId: 'a', rigor: 'mvp' },
      pipeline: { steps: [{}] },
    };
    expect(validateSkillScoutJob(job).reason).toBe('trigger-invalid');
  });

  it('rejects invalid rigor', () => {
    const job = {
      jobType: 'skill-scout',
      jobId: 'x',
      skillScoutPayload: { trigger: 'T1', projectSlug: 'a', appId: 'a', rigor: 'XL' },
      pipeline: { steps: [{}] },
    };
    expect(validateSkillScoutJob(job).reason).toBe('rigor-invalid');
  });

  it('rejects missing pipeline', () => {
    const job = {
      jobType: 'skill-scout',
      jobId: 'x',
      skillScoutPayload: { trigger: 'T1', projectSlug: 'a', appId: 'a', rigor: 'mvp' },
    };
    expect(validateSkillScoutJob(job).reason).toBe('pipeline-missing');
  });
});

// ── runSkillScoutJob — empty proposals (noop) ──

describe('runSkillScoutJob — empty proposals', () => {
  it('returns noop when agent emits zero proposals', async () => {
    const { job, ctx, attentionCalls, applyCalls } = makeJobAndCtx({ proposals: [] });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.ok).toBe(true);
    expect(result.disposition).toBe('noop');
    expect(result.proposalCount).toBe(0);
    expect(attentionCalls).toHaveLength(0); // no card surfaces
    expect(applyCalls).toHaveLength(0); // no install
  });
});

// ── runSkillScoutJob — auto-confirm (T1/T2 prototype + high confidence) ──

describe('runSkillScoutJob — auto-confirm path', () => {
  it('T1 prototype + all confidence ≥0.9 → auto-confirms', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'canvas-design',
        manifestBucket: 'core',
        version: 'tag:v1.0.0',
        rationale: 'r', verifyNotes: 'v', confidence: 0.95,
      },
    ];
    const { job, ctx, attentionCalls, applyCalls } = makeJobAndCtx({
      trigger: 'T1', rigor: 'prototype', proposals,
    });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.ok).toBe(true);
    expect(result.disposition).toBe('auto-confirm');
    expect(result.proposalCount).toBe(1);
    expect(result.acceptedCount).toBe(1);
    expect(applyCalls).toHaveLength(1);
    expect(applyCalls[0].source).toBe('auto-confirm');
    expect(attentionCalls).toHaveLength(0); // no card on auto-confirm
  });

  it('T2 prototype + low-confidence proposal → surfaces card (not auto-confirm)', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'canvas-design',
        manifestBucket: 'core', version: 'tag:v1', rationale: 'r',
        verifyNotes: 'v', confidence: 0.5,
      },
    ];
    const { job, ctx, attentionCalls, applyCalls } = makeJobAndCtx({
      trigger: 'T2', rigor: 'prototype', proposals,
    });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.ok).toBe(true);
    expect(result.disposition).toBe('surface-card');
    expect(attentionCalls).toHaveLength(1);
    expect(applyCalls).toHaveLength(0);
  });

  it('mvp rigor → always surfaces card even with high confidence', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'frontend-design',
        manifestBucket: 'core', version: 'tag:v2', rationale: 'r',
        verifyNotes: 'v', confidence: 0.99,
      },
    ];
    const { job, ctx, attentionCalls, applyCalls } = makeJobAndCtx({
      trigger: 'T2', rigor: 'mvp', proposals,
    });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.disposition).toBe('surface-card');
    expect(attentionCalls[0].category).toBe('manifest-change-proposed');
    expect(applyCalls).toHaveLength(0);
  });

  it('T3 (brownfield) NEVER auto-confirms regardless of rigor', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'x',
        manifestBucket: 'core', version: 'tag:v1', rationale: 'r',
        verifyNotes: 'v', confidence: 0.99,
      },
    ];
    const { job, ctx, applyCalls } = makeJobAndCtx({
      trigger: 'T3', rigor: 'prototype', proposals,
    });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.disposition).toBe('surface-card');
    expect(applyCalls).toHaveLength(0);
  });
});

// ── runSkillScoutJob — surface-card attention shape ──

describe('runSkillScoutJob — surface-card attention shape', () => {
  it('writes a manifest-change-proposed attention with stable dedupKey', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'x',
        manifestBucket: 'core', version: 'tag:v1', rationale: 'r',
        verifyNotes: 'v', confidence: 0.5,
      },
    ];
    const { job, ctx, attentionCalls } = makeJobAndCtx({
      trigger: 'T2', rigor: 'mvp', appId: 'snake-x', proposals,
    });
    await runSkillScoutJob(job, ctx);
    const card = attentionCalls[0];
    expect(card.category).toBe('manifest-change-proposed');
    expect(card.severity).toBe('medium');
    expect(card.appId).toBe('snake-x');
    expect(card.planId).toBe('plan-test-1');
    expect(card.dedupKey).toBe('skill-scout-card:T2:snake-x:plan-test-1');
    expect(card.context.proposals).toEqual(proposals);
    expect(card.actions).toEqual(['confirm', 'edit', 'decline', 'defer']);
  });

  it('T1 surface-card uses app-level dedupKey (no planId in scope)', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'x',
        manifestBucket: 'core', version: 'tag:v1', rationale: 'r',
        verifyNotes: 'v', confidence: 0.5,
      },
    ];
    const { job, ctx, attentionCalls } = makeJobAndCtx({
      trigger: 'T1', rigor: 'mvp', appId: 'snake-x', proposals,
    });
    await runSkillScoutJob(job, ctx);
    expect(attentionCalls[0].dedupKey).toBe('skill-scout-card:T1:snake-x:app-level');
  });
});

// ── runSkillScoutJob — error paths ──

describe('runSkillScoutJob — error paths', () => {
  it('returns invalid-output when agent emits no proposals block', async () => {
    const { job, ctx, attentionCalls } = makeJobAndCtx({ agentEmitsValidJson: false });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('empty-output');
    expect(attentionCalls[0].category).toBe('skill-scout-output-invalid');
  });

  it('returns invalid-output when validator rejects JSON', async () => {
    const { job, ctx, attentionCalls } = makeJobAndCtx({
      validatorReturns: { ok: false, error: 'proposals.0.confidence: must be number' },
    });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-output');
    expect(attentionCalls[0].body).toContain('proposals.0.confidence');
  });

  it('returns agent-step-failed when executeAgentStep throws', async () => {
    const { job, ctx, attentionCalls } = makeJobAndCtx({
      agentThrows: new Error('claude OAuth expired'),
    });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('agent-step-failed');
    expect(attentionCalls[0].category).toBe('skill-scout-failed');
    expect(attentionCalls[0].body).toContain('OAuth expired');
  });

  it('returns auto-confirm-install-failed when applyConfirmedProposals throws', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'canvas-design',
        manifestBucket: 'core', version: 'tag:v1', rationale: 'r',
        verifyNotes: 'v', confidence: 0.95,
      },
    ];
    const { job, ctx, attentionCalls } = makeJobAndCtx({
      trigger: 'T1', rigor: 'prototype', proposals,
      applyThrows: new Error('manifest parse failed'),
    });
    const result = await runSkillScoutJob(job, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('auto-confirm-install-failed');
    expect(attentionCalls[0].category).toBe('skill-install-failed');
  });

  it('returns validation failure result when job row is malformed', async () => {
    const malformed = { jobType: 'skill-scout', jobId: 'x' }; // no payload
    const result = await runSkillScoutJob(malformed, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('skillScoutPayload-missing');
  });
});

// ── Forensic event ──

describe('runSkillScoutJob — forensic emission', () => {
  it('emits step.skill-scout.<trigger> event before disposition branch', async () => {
    const proposals = [
      {
        kind: 'add', source: 'anthropic-official', skill: 'x',
        manifestBucket: 'core', version: 'tag:v1', rationale: 'r',
        verifyNotes: 'v', confidence: 0.95,
      },
    ];
    const { job, ctx, pushEventCalls } = makeJobAndCtx({
      trigger: 'T1', rigor: 'prototype', proposals,
    });
    await runSkillScoutJob(job, ctx);
    const skillEvents = pushEventCalls.filter(
      (args) => typeof args[3] === 'string' && args[3].startsWith('step.skill-scout.'),
    );
    expect(skillEvents).toHaveLength(1);
    expect(skillEvents[0][3]).toBe('step.skill-scout.T1');
    expect(skillEvents[0][4].proposalCount).toBe(1);
  });
});
