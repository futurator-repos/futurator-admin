import { describe, it, expect } from 'vitest';
import { computeOverallVqaVerdict, buildQaExecutePipeline } from '../visual-qa-pipeline';
import type { Plan } from '../../types/plan';
import type { VisualTestDef } from '../../types/epic-workflow';

/**
 * F12 (QA evidence integrity) — broken/missing screenshots must NOT be
 * scored as blocking product defects.
 *
 *   (b) HONEST VERDICT LANE — 'errored' (broken/missing evidence, infra) is
 *       distinct from 'fail' (product defect). overall=FAIL only on a genuine
 *       'fail'; 'errored'/'uncertain' route to PARTIAL (retry/operator).
 *   (a) EVIDENCE-INTEGRITY GATE + (c) PRE-JUDGE FILE VALIDATION — structural
 *       assertions on the emitted pipeline bash so a 0/N capture can't reach
 *       the judges and so judges only run on real (>= 2KB, present) frames.
 */

describe('computeOverallVqaVerdict — honest verdict lane', () => {
  it('all pass → PASS', () => {
    expect(computeOverallVqaVerdict({ fail: 0, uncertain: 0, errored: 0 })).toBe('PASS');
  });

  it('a genuine fail → FAIL (blocking)', () => {
    expect(computeOverallVqaVerdict({ fail: 1, uncertain: 0, errored: 0 })).toBe('FAIL');
  });

  it('errored (broken evidence) is NON-blocking → PARTIAL, never FAIL', () => {
    expect(computeOverallVqaVerdict({ fail: 0, uncertain: 0, errored: 3 })).toBe('PARTIAL');
  });

  it('uncertain alone → PARTIAL', () => {
    expect(computeOverallVqaVerdict({ fail: 0, uncertain: 2, errored: 0 })).toBe('PARTIAL');
  });

  it('a real fail dominates even when errored frames are present', () => {
    // The key F12 invariant: broken evidence never UPGRADES a verdict, and a
    // real product defect is still reported as blocking.
    expect(computeOverallVqaVerdict({ fail: 1, uncertain: 0, errored: 5 })).toBe('FAIL');
  });

  it('a 0/N capture (all errored) does not produce a blocking FAIL', () => {
    expect(computeOverallVqaVerdict({ fail: 0, uncertain: 0, errored: 8 })).toBe('PARTIAL');
  });
});

// Minimal Plan shape — buildQaExecutePipeline only reads a few fields.
const PLAN = {
  planId: 'plan-1',
  name: 'demo',
  workingDir: '/tmp/app',
  rigor: 'mvp',
} as unknown as Plan;

const TESTS = [
  {
    id: 'home',
    level: 'L0',
    url: '/',
    expect: 'homepage renders',
    storyId: 's1',
    storyTitle: 'Story 1',
  },
  {
    id: 'about',
    level: 'L1',
    url: '/about',
    expect: 'about renders',
    storyId: 's1',
    storyTitle: 'Story 1',
  },
] as unknown as Array<VisualTestDef & { storyId: string; storyTitle: string }>;

describe('buildQaExecutePipeline — evidence-integrity gate + pre-judge validation', () => {
  const pipeline = buildQaExecutePipeline({
    plan: PLAN,
    allVisualTests: TESTS,
    snapshotPrefix: 'qa-snapshots/demo/job/',
    jobId: 'job-1',
  });
  const stepText = (id: string) => {
    const step = pipeline.steps.find((s) => s.id === id);
    return step && 'command' in step ? String(step.command) : '';
  };

  it('(a) qa-prepare computes an evidence-integrity ratio and emits a gate signal', () => {
    const prepare = stepText('qa-prepare');
    expect(prepare).toContain('EVIDENCE_INTEGRITY');
    expect(prepare).toContain('evidence-integrity.json');
    // captured/authored < ~0.9 marks the run integrityFailed.
    expect(prepare).toContain('ratio < 0.9');
  });

  it('(b) L0 routes a missing/blank frame to errored, never fail', () => {
    const l0 = stepText('qa-judge-l0');
    expect(l0).toContain("verdict = 'errored'");
    // The sub-2KB check must NOT mark the frame as a product fail.
    expect(l0).not.toContain("verdict = 'fail'; rationale = 'screenshot is < 2KB");
  });

  it('(c) L1 validates the frame file exists and is >= 2KB BEFORE invoking the judge', () => {
    const l1 = stepText('qa-judge-l1');
    expect(l1).toContain('fs.existsSync(localShot)');
    expect(l1).toContain('< 2048');
    expect(l1).toContain("verdict: 'errored'");
  });

  it('(c) L2 only judges real frames (filters to existing >= 2KB shots)', () => {
    const l2 = stepText('qa-judge-l2');
    expect(l2).toContain('realShots');
    expect(l2).toContain("verdict: 'errored'");
  });
});
