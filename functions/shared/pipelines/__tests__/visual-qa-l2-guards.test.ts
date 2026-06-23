import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildQaExecutePipeline } from '../visual-qa-pipeline';
import type { Plan } from '../../types/plan';
import type { VisualTestDef } from '../../types/epic-workflow';

/**
 * Phase0 (2026-06-23) — L2 judge guards: RULE-1 (CONTRACT_INCOMPLETE), FLOW_NOOP,
 * stepLog-into-prompt. These run inside a bash heredoc'd node script, so the
 * highest risk is an embedded-JS syntax error that only surfaces at runtime on
 * the daemon. This suite (a) node --check's every embedded NODE_EOF body, and
 * (b) asserts the guards are present in the qa-judge-l2 command.
 */

const PLAN = {
  planId: 'plan-test',
  appId: 'pacman-x',
  name: 'pacman-x',
  workingDir: '/home/ubuntu/projects/pacman-x',
  intent: 'test',
  rigor: 'mvp',
  status: 'review',
  epicIds: [],
  createdAt: '2026-06-23T00:00:00Z',
  updatedAt: '2026-06-23T00:00:00Z',
} as unknown as Plan;

type AugTest = VisualTestDef & { storyId: string; storyTitle: string };
const aug = (t: VisualTestDef): AugTest => ({ ...t, storyId: 's1', storyTitle: 'Story 1' });
const TESTS: AugTest[] = [
  aug({
    id: 'l0',
    criteriaRef: 'AC-0',
    description: 'boots',
    setup: '/',
    expect: 'page boots',
    level: 'L0',
  }),
  aug({
    id: 'l1',
    criteriaRef: 'AC-1',
    description: 'maze',
    setup: '/',
    expect: 'maze visible',
    level: 'L1',
  }),
  aug({
    id: 'l2-noflow',
    criteriaRef: 'AC-2',
    description: 'paused overlay',
    setup: '/',
    expect: 'PAUSED overlay appears when the tab loses focus during gameplay',
    level: 'L2',
  }),
  aug({
    id: 'l2-flow',
    criteriaRef: 'AC-3',
    description: 'start dismiss',
    setup: '/',
    expect: 'after pressing Space the start overlay dismisses and the maze shows',
    level: 'L2',
    flow: [
      { action: 'press', key: 'Space' },
      { action: 'wait', ms: 300 },
      { action: 'screenshot', label: 'after-start' },
    ],
  }),
];

function buildPipeline() {
  return buildQaExecutePipeline({
    plan: PLAN,
    allVisualTests: TESTS,
    snapshotPrefix: 'qa-snapshots/pacman-x/job/',
    jobId: 'job-1',
  });
}

function extractHeredocBodies(command: string): string[] {
  // node -e "$(cat <<'NODE_EOF' \n <body> \n NODE_EOF \n )"
  const bodies: string[] = [];
  const re = /<<'NODE_EOF'\n([\s\S]*?)\nNODE_EOF/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command)) !== null) bodies.push(m[1]);
  return bodies;
}

describe('qa-execute embedded node scripts — syntax (node --check)', () => {
  it('every NODE_EOF body parses with no syntax error', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qa-l2-'));
    try {
      const pipeline = buildPipeline();
      let checked = 0;
      for (const step of pipeline.steps) {
        const cmd = typeof step.command === 'string' ? step.command : '';
        for (const body of extractHeredocBodies(cmd)) {
          const f = join(dir, `s-${checked}.js`);
          writeFileSync(f, body);
          const r = spawnSync('node', ['--check', f], { encoding: 'utf8' });
          expect(r.status, `${step.id} embedded script syntax error:\n${r.stderr}`).toBe(0);
          checked += 1;
        }
      }
      expect(checked).toBeGreaterThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('qa-judge-l2 — Phase0 guards present', () => {
  const l2cmd = (() => {
    const p = buildPipeline();
    const s = p.steps.find((x) => x.id === 'qa-judge-l2');
    return typeof s?.command === 'string' ? s.command : '';
  })();

  it('loads the evidence-integrity sidecar for no-op detection', () => {
    expect(l2cmd).toContain('evidence-integrity.json');
  });

  it('RULE-1: blocks an L2 test with no flow as CONTRACT_INCOMPLETE', () => {
    expect(l2cmd).toContain('CONTRACT_INCOMPLETE');
    expect(l2cmd).toContain('!Array.isArray(t.flow) || t.flow.length === 0');
  });

  it('FLOW_NOOP: blocks an L2 frame identical to the idle baseline', () => {
    expect(l2cmd).toContain('FLOW_NOOP');
    expect(l2cmd).toContain('ei.tests[t.id].identical');
  });

  it('feeds the executed step log into the judge prompt (not an unconditional claim)', () => {
    expect(l2cmd).toContain('-flow.json');
    expect(l2cmd).toContain('stepSummary');
    expect(l2cmd).not.toContain('they show POST-INTERACTION state, not the idle load frame');
  });

  it('Phase1: promotes a seam-asserting flow with no published seam to SEAM_ABSENT', () => {
    expect(l2cmd).toContain('SEAM_ABSENT');
  });
});

describe('qa-prepare runFlow — Phase1 seam/assert hardening', () => {
  const prepCmd = (() => {
    const p = buildPipeline();
    const s = p.steps.find((x) => x.id === 'qa-prepare');
    return typeof s?.command === 'string' ? s.command : '';
  })();

  it('waits for window.__harness.ready before a seam-asserting flow (records SEAM_ABSENT on timeout)', () => {
    expect(prepCmd).toContain('waitForFunction');
    expect(prepCmd).toContain('window.__harness && window.__harness.ready === true');
    expect(prepCmd).toContain('seam-ready');
    expect(prepCmd).toContain('SEAM_ABSENT');
  });

  it('polls the assert until the deadline instead of a one-shot read', () => {
    expect(prepCmd).toContain('const deadline = Date.now()');
    expect(prepCmd).toContain('while (!pass && Date.now() < deadline)');
  });

  it('Phase2: implements waitForEvent (poll seam until event) and repeat (drive-until-event)', () => {
    expect(prepCmd).toContain("step.action === 'waitForEvent'");
    expect(prepCmd).toContain('WAIT_EVENT_TIMEOUT');
    expect(prepCmd).toContain("step.action === 'repeat'");
    expect(prepCmd).toContain('REPEAT_UNMET');
  });

  it('Phase2b: implements force (jump to a terminal state via the seam command)', () => {
    expect(prepCmd).toContain("step.action === 'force'");
    expect(prepCmd).toContain('forceStatus');
    expect(prepCmd).toContain('FORCE_UNAVAILABLE');
  });
});

/**
 * DV-2 (agentic-l2-autonomy-backlog §4) — SEAM_NEVER_PUBLISHED static catch.
 * qa-prepare greps the app src/ for an import of the boilerplate's seam hook;
 * an un-imported hook on a seam-asserting plan blocks each probe pre-screenshot.
 */
describe('DV-2 — SEAM_NEVER_PUBLISHED static seam-wiring catch', () => {
  const seamTest = aug({
    id: 'l2-seam',
    criteriaRef: 'AC-9',
    description: 'game over overlay',
    setup: '/',
    expect: 'a GAME OVER overlay shows after the player loses',
    level: 'L2',
    flow: [
      { action: 'force', status: 'over' },
      {
        action: 'waitForEvent',
        expr: 'snapshot.status',
        op: 'eq',
        expected: 'over',
        timeoutMs: 5000,
      },
      { action: 'screenshot', label: 'after' },
      { action: 'assert', expr: 'snapshot.status', op: 'eq', expected: 'over' },
    ],
  });

  function buildSeamPipeline(seamHook?: string) {
    return buildQaExecutePipeline({
      plan: PLAN,
      allVisualTests: [seamTest],
      snapshotPrefix: 'qa-snapshots/pacman-x/job/',
      jobId: 'job-seam',
      seamHook,
    });
  }

  const cmds = (seamHook?: string) => {
    const p = buildSeamPipeline(seamHook);
    const prep = p.steps.find((x) => x.id === 'qa-prepare');
    const l2 = p.steps.find((x) => x.id === 'qa-judge-l2');
    return {
      prep: typeof prep?.command === 'string' ? prep.command : '',
      l2: typeof l2?.command === 'string' ? l2.command : '',
    };
  };

  it('qa-prepare greps src for the seam hook and writes seam-wiring.json (when seamHook + seam probes present)', () => {
    const { prep } = cmds('useGameStateMachine');
    expect(prep).toContain('useGameStateMachine');
    expect(prep).toContain('seam-wiring.json');
    expect(prep).toContain('SEAM_IMPORTED');
  });

  it('qa-judge-l2 blocks an un-imported seam as SEAM_NEVER_PUBLISHED', () => {
    const { l2 } = cmds('useGameStateMachine');
    expect(l2).toContain('SEAM_NEVER_PUBLISHED');
    expect(l2).toContain('seam-wiring.json');
    expect(l2).toContain('sw.seamImported === false');
  });

  it('is a no-op when the boilerplate declares no seam hook', () => {
    const { prep } = cmds(undefined);
    expect(prep).not.toContain('seam-wiring.json');
  });
});
