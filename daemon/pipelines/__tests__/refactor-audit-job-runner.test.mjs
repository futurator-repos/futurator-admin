/**
 * refactor-audit-job-runner.test.mjs — Refactoring Assessment Module (Epic B2).
 *
 * Unit-tests the pure runner: validation, recon-step detection, failure
 * classification, event emission, and the success/failure return shapes — all
 * with injected deps, no process spawn and no DDB. Also asserts the router's
 * selectHandler routes 'refactor-audit' correctly (before the epic-dev check).
 */

import { describe, it, expect, vi } from 'vitest';
import { selectHandler, JOB_HANDLER_REFACTOR_AUDIT } from '../job-router.mjs';
import {
  validateRefactorAuditJob,
  detectStep,
  classifyReconFailure,
  buildAssessEvent,
  runRefactorAuditJob,
  ASSESS_STEPS,
  buildL3Prompt,
  parseL3Output,
  runL3Adjudication,
} from '../refactor-audit-job-runner.mjs';

function auditJob(overrides = {}) {
  return {
    jobId: 'job-1',
    jobType: 'refactor-audit',
    workingDir: '/home/ubuntu/projects/applicator',
    refactorAuditPayload: {
      projectId: 'applicator',
      projectPath: '/home/ubuntu/projects/applicator',
      ...(overrides.payload || {}),
    },
    ...overrides.job,
  };
}

describe('selectHandler — refactor-audit routing', () => {
  it('routes a refactor-audit job to its handler', () => {
    expect(selectHandler(auditJob())).toBe(JOB_HANDLER_REFACTOR_AUDIT);
  });

  it('prefers jobType over an incidental epic-dev phase', () => {
    expect(selectHandler({ ...auditJob(), phase: 'epic-dev' })).toBe(JOB_HANDLER_REFACTOR_AUDIT);
  });
});

describe('validateRefactorAuditJob', () => {
  it('accepts a well-formed job', () => {
    expect(validateRefactorAuditJob(auditJob())).toEqual({ ok: true });
  });

  it('rejects a jobType mismatch', () => {
    expect(validateRefactorAuditJob({ ...auditJob(), jobType: 'party-refresh' })).toEqual({
      ok: false,
      reason: 'jobType-mismatch',
    });
  });

  it('rejects a missing payload', () => {
    const j = auditJob();
    delete j.refactorAuditPayload;
    expect(validateRefactorAuditJob(j)).toEqual({
      ok: false,
      reason: 'refactorAuditPayload-missing',
    });
  });

  it('rejects a missing projectPath', () => {
    expect(
      validateRefactorAuditJob(auditJob({ payload: { projectPath: '' } })),
    ).toEqual({ ok: false, reason: 'projectPath-missing' });
  });
});

describe('detectStep', () => {
  it('maps each recon ▶ marker to its stage', () => {
    expect(detectStep('▶ /opt/graphify-venv/bin/python .../graphify-build.py repo src out')).toBe(
      'graphify',
    );
    expect(detectStep('▶ knip → graphify-out/knip.json')).toBe('knip');
    expect(detectStep('▶ node .../alias-resolve.mjs repo --graph ...')).toBe('alias-resolve');
    expect(detectStep('▶ node .../hotspot-detect.mjs out --repo ...')).toBe('hotspot-detect');
  });

  it('returns null for a non-stage line', () => {
    expect(detectStep('files scanned: 659')).toBeNull();
    expect(detectStep('')).toBeNull();
    expect(detectStep(undefined)).toBeNull();
  });

  it('covers all four declared stages', () => {
    expect(ASSESS_STEPS).toEqual(['graphify', 'knip', 'alias-resolve', 'hotspot-detect']);
  });
});

describe('classifyReconFailure', () => {
  it('maps exit codes to stable reasons', () => {
    expect(classifyReconFailure(2)).toBe('graphify-missing');
    expect(classifyReconFailure(3)).toBe('degenerate-build');
    expect(classifyReconFailure(1)).toBe('recon-error');
    expect(classifyReconFailure(137)).toBe('recon-error');
  });
});

describe('buildAssessEvent', () => {
  it('builds a completed event', () => {
    const e = buildAssessEvent('completed', {
      hotspotCount: 4,
      counts: { 'god-object': 1 },
      reportPath: '/x/REPORT.md',
    });
    expect(e.eventType).toBe('assess.completed');
    expect(e.payload).toMatchObject({ hotspotCount: 4, counts: { 'god-object': 1 } });
  });

  it('builds a failed event with a capped message', () => {
    const e = buildAssessEvent('failed', { reason: 'degenerate-build', message: 'x'.repeat(5000) });
    expect(e.eventType).toBe('assess.failed');
    expect(e.payload.reason).toBe('degenerate-build');
    expect(e.payload.message.length).toBe(1500);
  });
});

describe('runRefactorAuditJob — lifecycle', () => {
  it('gates when paused (re-queued by the daemon)', async () => {
    const res = await runRefactorAuditJob(auditJob(), { paused: true, runRecon: vi.fn() });
    expect(res).toEqual({ ok: true, status: 'gated', reason: 'agent.paused' });
  });

  it('happy path: streams steps, reads artifacts, emits completed', async () => {
    const events = [];
    const pushEvent = vi.fn(async (_j, _s, _a, eventType, data) => {
      events.push({ eventType, data });
    });
    const runRecon = vi.fn(async ({ onChunk }) => {
      onChunk('stdout', '▶ python graphify-build.py repo src out\nbuilding...\n');
      onChunk('stdout', '▶ knip → graphify-out/knip.json\n');
      onChunk('stdout', '▶ node alias-resolve.mjs repo\n');
      onChunk('stdout', '▶ node hotspot-detect.mjs out\n');
      return { code: 0 };
    });
    const sampleHotspots = [
      { kind: 'god-object', score: 90, severity: 'critical', title: 'X', files: ['a.ts'], evidence: {}, suggestedAction: 'split' },
      { kind: 'dead-code', score: 30, severity: 'medium', title: 'Y', files: ['b.ts'], evidence: {}, suggestedAction: 'delete' },
    ];
    const readArtifacts = vi.fn(async () => ({
      hotspotCount: 4,
      counts: { 'god-object': 1, 'design-system-consolidation': 1, 'duplicate-subsystem': 1, 'dead-code': 1 },
      hotspots: sampleHotspots,
      reportPath: '/home/ubuntu/projects/applicator/graphify-out/REPORT.md',
    }));

    const res = await runRefactorAuditJob(auditJob(), { runRecon, readArtifacts, pushEvent });

    expect(res.ok).toBe(true);
    expect(res.hotspotCount).toBe(4);
    expect(res.hotspots).toEqual(sampleHotspots); // full array travels on the summary
    expect(readArtifacts).toHaveBeenCalledOnce();

    const types = events.map((e) => e.eventType);
    expect(types[0]).toBe('assess.started');
    expect(types).toContain('assess.completed');
    // one step.started per stage, in order
    const stepStarts = events.filter((e) => e.eventType === 'assess.step.started').map((e) => e.data.step);
    expect(stepStarts).toEqual(['graphify', 'knip', 'alias-resolve', 'hotspot-detect']);
  });

  it('classifies a degenerate build (exit 3) and writes an attention item', async () => {
    const events = [];
    const pushEvent = vi.fn(async (_j, _s, _a, eventType, data) => events.push({ eventType, data }));
    const writeAttentionItem = vi.fn(async () => {});
    const runRecon = vi.fn(async () => ({ code: 3, stderrTail: 'degenerate' }));

    const res = await runRefactorAuditJob(auditJob(), { runRecon, pushEvent, writeAttentionItem });

    expect(res).toMatchObject({ ok: false, reason: 'degenerate-build' });
    expect(events.find((e) => e.eventType === 'assess.failed').data.reason).toBe('degenerate-build');
    expect(writeAttentionItem).toHaveBeenCalledOnce();
  });

  it('classifies missing graphify (exit 2)', async () => {
    const runRecon = vi.fn(async () => ({ code: 2, stderrTail: '! graphify not importable' }));
    const res = await runRefactorAuditJob(auditJob(), { runRecon });
    expect(res).toMatchObject({ ok: false, reason: 'graphify-missing' });
  });

  it('fails cleanly when artifacts are unreadable after a 0 exit', async () => {
    const runRecon = vi.fn(async () => ({ code: 0 }));
    const readArtifacts = vi.fn(async () => {
      throw new Error('ENOENT hotspots.json');
    });
    const res = await runRefactorAuditJob(auditJob(), { runRecon, readArtifacts });
    expect(res).toMatchObject({ ok: false, reason: 'artifacts-unreadable' });
  });

  it('fails when validation rejects the job', async () => {
    const res = await runRefactorAuditJob({ jobType: 'wrong' }, { runRecon: vi.fn() });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/^validation:/);
  });
});

describe('L3 adjudication (Epic C)', () => {
  const HS = [
    { kind: 'god-object', title: 'God-object: X (44 methods)', files: ['a.ts'], severity: 'critical' },
    { kind: 'dead-code', title: 'Dead files: 3', files: ['b.ts'], severity: 'medium' },
  ];

  it('buildL3Prompt embeds the hotspots, the adversarial guard, and the output markers', () => {
    const p = buildL3Prompt(HS, 40);
    expect(p).toMatch(/God-object: X/);
    expect(p).toMatch(/REJECT findings you cannot prove/);
    expect(p).toMatch(/primitives/); // the canonical false-positive guard
    expect(p).toMatch(/---L3---/);
    expect(p).toMatch(/Strangler-Fig/);
  });

  it('buildL3Prompt caps to topN', () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ kind: 'god-object', title: `H${i}`, files: [] }));
    const p = buildL3Prompt(many, 5);
    expect(p).toMatch(/these 5 hotspots/);
  });

  it('parseL3Output extracts verdicts + plan from the ---L3--- block', () => {
    const text =
      'some thinking...\n---L3---\n' +
      JSON.stringify({
        verdicts: [
          { hotspotTitle: 'A', kind: 'god-object', verdict: 'confirmed', rationale: 'r' },
          { hotspotTitle: 'B', kind: 'dead-code', verdict: 'rejected', rationale: 'name collision' },
        ],
        plan: { plan: { name: 'fix-x', description: 'd'.repeat(25), epics: [] } },
      }) +
      '\n---END_L3---\n';
    const out = parseL3Output(text);
    expect(out.verdicts).toHaveLength(2);
    expect(out.confirmed).toHaveLength(1);
    expect(out.confirmed[0].hotspotTitle).toBe('A');
    expect(out.plan.plan.name).toBe('fix-x');
  });

  it('parseL3Output tolerates a bare object with no markers', () => {
    const out = parseL3Output(JSON.stringify({ verdicts: [{ verdict: 'confirmed', kind: 'x', hotspotTitle: 't', rationale: 'r' }], plan: null }));
    expect(out.confirmed).toHaveLength(1);
    expect(out.plan).toBeNull();
  });

  it('parseL3Output returns empty on garbage', () => {
    expect(parseL3Output('no json here')).toEqual({ verdicts: [], confirmed: [], plan: null });
    expect(parseL3Output('')).toEqual({ verdicts: [], confirmed: [], plan: null });
  });

  it('runL3Adjudication spawns the agent and returns parsed result', async () => {
    const runL3Agent = vi.fn(async () => ({
      output: '---L3---\n' + JSON.stringify({
        verdicts: [{ hotspotTitle: 'A', kind: 'god-object', verdict: 'confirmed', rationale: 'r' }],
        plan: { plan: { name: 'fix', description: 'x'.repeat(25), epics: [] } },
      }) + '\n---END_L3---',
    }));
    const res = await runL3Adjudication(auditJob(), HS, { runL3Agent });
    expect(res.ok).toBe(true);
    expect(res.confirmed).toHaveLength(1);
    expect(res.plan).toBeTruthy();
    expect(runL3Agent).toHaveBeenCalledOnce();
  });

  it('runL3Adjudication fails cleanly when the agent throws', async () => {
    const runL3Agent = vi.fn(async () => { throw new Error('spawn died'); });
    const res = await runL3Adjudication(auditJob(), HS, { runL3Agent });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/spawn died/);
  });
});
