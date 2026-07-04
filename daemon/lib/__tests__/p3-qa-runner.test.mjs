/**
 * p3-qa-runner.test.mjs — QA-Review W2 orchestrator (hermetic).
 *
 * Injects a fake Playwright (multi-launch, one per journey), a fake
 * spawnJudge, and a fake s3 shell primitive; real fs only for the
 * p3-orphan-check wiring fixtures (a filesystem scan, matching that
 * sibling's own test convention).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runP3Qa, joinDevUrl } from '../p3-qa-runner.mjs';

// ── Fake Playwright: one config per sequential chromium.launch() call ──────

function makeFakePlaywright(launchConfigs) {
  let idx = 0;
  return {
    chromium: {
      launch: async () => {
        const cfg = launchConfigs[Math.min(idx, launchConfigs.length - 1)] || {};
        idx += 1;
        if (cfg.throwOnLaunch) throw new Error(cfg.throwOnLaunch);
        let snapCalls = 0;
        let shotCalls = 0;
        const page = {
          goto: async (url) => {
            if (cfg.throwOnGoto) throw new Error(cfg.throwOnGoto);
            page.gotoUrl = url;
          },
          waitForFunction: async () => {
            if (cfg.harnessMounted === false) throw new Error('timeout');
          },
          keyboard: { press: async () => {} },
          waitForTimeout: async () => {},
          screenshot: async () => {
            shotCalls += 1;
            return Buffer.from(`frame-${shotCalls}`);
          },
          evaluate: async (_fn, arg) => {
            if (arg && arg.m) return undefined;
            const snaps = cfg.snapshots || [{}];
            return snaps[Math.min(snapCalls++, snaps.length - 1)];
          },
        };
        return { newPage: async () => page, close: async () => {} };
      },
    },
  };
}

const passJudge = async () => ({ ok: true, output: 'VERDICT: PASS [conf=high]\nOBSERVATION: looks right' });
const okS3 = async () => ({ code: 0, stdout: '', stderr: '' });

function story(overrides = {}) {
  return {
    storyId: 's1',
    title: 'Story 1',
    intent: 'does a thing',
    touches: ['src/a.ts'],
    acceptanceCriteria: [],
    ...overrides,
  };
}

// ── joinDevUrl ───────────────────────────────────────────────────────────

describe('joinDevUrl', () => {
  it('adds a trailing slash when devUrl has none and no subpath given', () => {
    expect(joinDevUrl('https://dev.futurator.ai/p-1')).toBe('https://dev.futurator.ai/p-1/');
  });
  it('does not double a trailing slash', () => {
    expect(joinDevUrl('https://dev.futurator.ai/p-1/')).toBe('https://dev.futurator.ai/p-1/');
  });
  it('joins a subpath without doubling slashes', () => {
    expect(joinDevUrl('https://dev.futurator.ai/p-1/', '/foo')).toBe('https://dev.futurator.ai/p-1/foo');
    expect(joinDevUrl('https://dev.futurator.ai/p-1', 'foo')).toBe('https://dev.futurator.ai/p-1/foo');
  });
});

// ── main scenario: 2 journeys, one pass one deterministic-fail ────────────

describe('runP3Qa — two journeys (pass + deterministic-fail)', () => {
  it('blocking:true, per-journey S3 frame URLs are namespaced, ranAtSha === plan.qaCommitSha', async () => {
    const plan = { planId: 'plan-1', qaCommitSha: 'sha123', devUrl: 'https://dev.futurator.ai/p-1' };
    const stories = [
      story({ storyId: 's1', acceptanceCriteria: [{ id: 's1-ac1', text: 'space starts run' }] }),
      story({ storyId: 's2', touches: ['src/b.ts'], acceptanceCriteria: [{ id: 's2-ac1', text: 'space ends run' }] }),
    ];
    const journeys = [
      {
        id: 'j-pass',
        title: 'Pass journey',
        acRefs: ['s1-ac1'],
        steps: [{ acId: 's1-ac1', label: 'press space', when: 'The user presses Space', thenObservable: "snapshot.status equals 'running'" }],
      },
      {
        id: 'j-fail',
        title: 'Fail journey',
        acRefs: ['s2-ac1'],
        steps: [{ acId: 's2-ac1', label: 'press space over', when: 'The user presses Space', thenObservable: "snapshot.status equals 'over'" }],
      },
    ];
    const playwright = makeFakePlaywright([
      { snapshots: [{ status: 'running' }] }, // j-pass: matches 'running'
      { snapshots: [{ status: 'running' }] }, // j-fail: expects 'over', gets 'running' -> fail
    ]);

    const result = await runP3Qa({
      plan,
      stories,
      journeys,
      playwright,
      spawnJudge: passJudge,
      s3: okS3,
      log: () => {},
    });

    expect(result.ranAtSha).toBe('sha123');
    expect(result.blocking).toBe(true);
    expect(result.journeys).toHaveLength(2);

    const passJourney = result.journeys.find((j) => j.id === 'j-pass');
    const failJourney = result.journeys.find((j) => j.id === 'j-fail');
    expect(passJourney.verdict).toBe('pass');
    expect(failJourney.verdict).toBe('fail');
    expect(failJourney.steps[0].deterministic.passed).toBe(false);

    // Namespaced S3 URLs: p3-qa/<planId>/<qaCommitSha>/<journeyId>/...
    expect(passJourney.steps[0].vqa.beforeShotUrl).toMatch(
      /^https:\/\/futurator\.ai\/p3-qa\/plan-1\/sha123\/j-pass\//,
    );
    expect(passJourney.steps[0].vqa.afterShotUrl).toMatch(
      /^https:\/\/futurator\.ai\/p3-qa\/plan-1\/sha123\/j-pass\//,
    );
    expect(failJourney.steps[0].vqa.beforeShotUrl).toMatch(
      /^https:\/\/futurator\.ai\/p3-qa\/plan-1\/sha123\/j-fail\//,
    );

    // Flattened vqa[] carries the same URLs, keyed by journeyId/stepLabel.
    const flatForPass = result.vqa.find((v) => v.journeyId === 'j-pass');
    expect(flatForPass.beforeShotUrl).toBe(passJourney.steps[0].vqa.beforeShotUrl);
  });
});

// ── pacman3 fixture: stub reducer never imported (orphan) + no-op keypress ─

describe('runP3Qa — pacman3-shaped fixture (stub reducer + orphans)', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'p3-qa-pacman3-'));
    mkdirSync(join(root, 'src', 'game'), { recursive: true });
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    writeFileSync(join(root, 'src', 'game', 'reducer.ts'), 'export function reducer(s) { return s; }\n');
    // The "assemble" file exists but never imports the reducer — pacman3 disease.
    writeFileSync(
      join(root, 'src', 'app', 'page.tsx'),
      "import React from 'react';\nexport default function Page() { return null; }\n",
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocking:true — a keyboard-no-move deterministic fail AND wiring.orphanModules non-empty', async () => {
    const plan = { planId: 'p2', qaCommitSha: 'sha2', devUrl: 'https://dev.futurator.ai/p-2' };
    const stories = [
      story({
        storyId: 's1',
        touches: ['src/game/reducer.ts'],
        acceptanceCriteria: [
          { id: 's1-ac1', text: 'ArrowUp moves the player', when: 'The user presses ArrowUp', thenObservable: 'snapshot.x is greater than 0' },
        ],
      }),
    ];
    const journeys = [
      {
        id: 'j1',
        title: 'Move journey',
        acRefs: ['s1-ac1'],
        steps: [{ acId: 's1-ac1', label: 'press arrowup', when: 'The user presses ArrowUp', thenObservable: 'snapshot.x is greater than 0' }],
      },
    ];
    // ArrowUp pressed, but x never moves off 0 — the "keyboard does nothing" disease.
    const playwright = makeFakePlaywright([{ snapshots: [{ x: 0 }] }]);
    const qaContext = { appDir: root };

    const result = await runP3Qa({ plan, stories, journeys, playwright, spawnJudge: passJudge, s3: okS3, qaContext, log: () => {} });

    expect(result.blocking).toBe(true);
    expect(result.wiring.orphanModules).toContain('src/game/reducer.ts');
    expect(result.wiring.blocking).toBe(true);
    expect(result.journeys[0].verdict).toBe('fail');
    expect(result.journeys[0].steps[0].deterministic.passed).toBe(false);
    expect(result.journeys[0].steps[0].deterministic.detail).toMatch(/snapshot\.x/);
  });

  // Review fix #5: a harness/infra failure (no playwright) must NOT block a
  // possibly-working app — it degrades to uncertain, never a false-block.
  it('infra failure (no playwright) → journey uncertain, NOT blocking', async () => {
    const plan = { planId: 'p3', qaCommitSha: 'sha3', devUrl: 'https://dev.futurator.ai/p-3' };
    const stories = [
      story({
        storyId: 's1', touches: ['src/a.ts'],
        acceptanceCriteria: [{ id: 's1-ac1', text: 't', when: 'press x', thenObservable: 'snapshot.x is greater than 0' }],
      }),
    ];
    const journeys = [{ id: 'j1', title: 'J', acRefs: ['s1-ac1'], steps: [{ acId: 's1-ac1', label: 'press x', when: 'press x', thenObservable: 'snapshot.x is greater than 0' }] }];
    const result = await runP3Qa({ plan, stories, journeys, playwright: null, spawnJudge: passJudge, s3: okS3, qaContext: {}, log: () => {} });
    expect(result.blocking).toBe(false);
    expect(result.journeys[0].verdict).toBe('uncertain');
    expect(result.journeys[0].steps[0].deterministic.infra).toBe(true);
  });
});

// ── fully-wired fixture: blocking:false ───────────────────────────────────

describe('runP3Qa — fully-wired fixture', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'p3-qa-wired-'));
    mkdirSync(join(root, 'src', 'game'), { recursive: true });
    mkdirSync(join(root, 'src', 'app'), { recursive: true });
    writeFileSync(join(root, 'src', 'game', 'reducer.ts'), 'export function reducer(s) { return s; }\n');
    writeFileSync(
      join(root, 'src', 'app', 'page.tsx'),
      "import { reducer } from '../game/reducer';\nexport default function Page() { return reducer({}); }\n",
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('blocking:false when the journey passes and nothing is orphaned', async () => {
    const plan = { planId: 'p3', qaCommitSha: 'sha3', devUrl: 'https://dev.futurator.ai/p-3' };
    const stories = [
      story({
        storyId: 's1',
        touches: ['src/game/reducer.ts'],
        acceptanceCriteria: [
          { id: 's1-ac1', text: 'ArrowUp moves the player', when: 'The user presses ArrowUp', thenObservable: 'snapshot.x is greater than 0' },
        ],
      }),
    ];
    const journeys = [
      {
        id: 'j1',
        title: 'Move journey',
        acRefs: ['s1-ac1'],
        steps: [{ acId: 's1-ac1', label: 'press arrowup', when: 'The user presses ArrowUp', thenObservable: 'snapshot.x is greater than 0' }],
      },
    ];
    const playwright = makeFakePlaywright([{ snapshots: [{ x: 5 }] }]);
    const qaContext = { appDir: root };

    const result = await runP3Qa({ plan, stories, journeys, playwright, spawnJudge: passJudge, s3: okS3, qaContext, log: () => {} });

    expect(result.blocking).toBe(false);
    expect(result.wiring.blocking).toBe(false);
    expect(result.journeys[0].verdict).toBe('pass');
    expect(result.status).toBe('pass');
  });
});

// ── fail-open: an infra throw on journey #1 must not abort journey #2 ─────

describe('runP3Qa — per-journey fail-open (infra throw continuation)', () => {
  it('an s3 upload throw on journey #1 degrades it to uncertain, continues to journey #2', async () => {
    const plan = { planId: 'plan-4', qaCommitSha: 'sha4', devUrl: 'https://dev.futurator.ai/p-4' };
    const stories = [
      story({ storyId: 's1', acceptanceCriteria: [{ id: 's1-ac1', text: 'space starts run' }] }),
      story({ storyId: 's2', touches: ['src/b.ts'], acceptanceCriteria: [{ id: 's2-ac1', text: 'space starts run too' }] }),
    ];
    const journeys = [
      {
        id: 'j1',
        title: 'Journey 1',
        acRefs: ['s1-ac1'],
        steps: [{ acId: 's1-ac1', label: 'press space', when: 'The user presses Space', thenObservable: "snapshot.status equals 'running'" }],
      },
      {
        id: 'j2',
        title: 'Journey 2',
        acRefs: ['s2-ac1'],
        steps: [{ acId: 's2-ac1', label: 'press space', when: 'The user presses Space', thenObservable: "snapshot.status equals 'running'" }],
      },
    ];
    const playwright = makeFakePlaywright([
      { snapshots: [{ status: 'running' }] },
      { snapshots: [{ status: 'running' }] },
    ]);
    // Throw ONLY when uploading a frame namespaced under journey j1.
    const throwingS3 = async (cmd) => {
      if (cmd.includes('p3-qa/plan-4/sha4/j1/')) throw new Error('s3 cp boom');
      return { code: 0, stdout: '', stderr: '' };
    };

    const result = await runP3Qa({
      plan,
      stories,
      journeys,
      playwright,
      spawnJudge: passJudge,
      s3: throwingS3,
      log: () => {},
    });

    expect(result.journeys).toHaveLength(2);
    const j1 = result.journeys.find((j) => j.id === 'j1');
    const j2 = result.journeys.find((j) => j.id === 'j2');
    expect(j1.verdict).toBe('uncertain');
    expect(j1.steps).toEqual([]);
    expect(j2.verdict).toBe('pass');
    expect(j2.steps[0].vqa.beforeShotUrl).toMatch(/^https:\/\/futurator\.ai\/p3-qa\/plan-4\/sha4\/j2\//);
  });
});

// ── honesty: nothing to verify never fakes a pass ─────────────────────────

describe('runP3Qa — no journeys resolvable', () => {
  it('status:uncertain, blocking:false (nothing fabricated) when there is nothing to run', async () => {
    const plan = { planId: 'p5', qaCommitSha: 'sha5', devUrl: 'https://dev.futurator.ai/p-5' };
    const result = await runP3Qa({ plan, stories: [], journeys: [], playwright: makeFakePlaywright([]), spawnJudge: passJudge, s3: okS3, log: () => {} });
    expect(result.journeys).toEqual([]);
    expect(result.status).toBe('uncertain');
    expect(result.blocking).toBe(false);
  });
});

describe('seam-mount static sub-lane (pacman3 root cause)', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'p3-qa-seam-'));
    mkdirSync(join(root, 'src', 'game'), { recursive: true });
    mkdirSync(join(root, 'src', 'components'), { recursive: true });
    // The scaffold DEFINES the hook…
    writeFileSync(join(root, 'src', 'game', 'state-machine.ts'),
      'export function useGameStateMachine(r, i) { return [i, () => {}]; }\n');
    // …but the game hand-rolls useReducer and never imports it (pacman3 class).
    writeFileSync(join(root, 'src', 'components', 'Game.tsx'),
      "import { useReducer } from 'react';\nexport function Game(){ const [s] = useReducer((x)=>x, {}); return null; }\n");
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('hook defined but never imported → wiring blocks with seamMounted:false', async () => {
    const plan = { planId: 'p9', qaCommitSha: 'sha9', devUrl: 'https://dev.futurator.ai/p-9' };
    const result = await runP3Qa({
      plan, stories: [], journeys: [],
      playwright: null, spawnJudge: async () => ({ ok: true, output: '' }),
      s3: async () => ({ code: 0 }), qaContext: { appDir: root }, log: () => {},
    });
    expect(result.wiring.seamMounted).toBe(false);
    expect(result.wiring.blocking).toBe(true);
    expect(result.wiring.seamDetail).toMatch(/only DEFINED/);
  });
});
