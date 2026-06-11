/**
 * Hermetic tests for the v2.6 wave-gate VQA runner (M2, 2026-06-11).
 *
 * Real git repo in a tmpdir as the "candidate"; FAKE spawners (evidence /
 * judge / triage / fixer), fake boot, and a shell wrapper that intercepts
 * `aws s3 cp` (uploads must never hit real AWS from tests — non-blocking
 * failure is the designed degradation).
 *
 * Pins the five outcome paths: pass / fixed / fix-forward / env-blocked /
 * skipped, plus the load-bearing properties: evidence read-only enforcement
 * (hard reset on a dirty candidate), handoff packets shipped under
 * .context/vqa-handoffs (committed = evidence preserved), the vqa report
 * commit, audited vqa-fix commits, and re-capture (never re-judge a stale
 * pre-fix screenshot).
 */

import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  runWaveVqa,
  parseFencedJson,
  parseJudgeOutput,
  judgeConsensus,
  featureSlugsForStory,
  renderVqaReport,
} from '../wave-vqa-runner.mjs';

const TMP = mkdtempSync(join(tmpdir(), 'wave-vqa-'));
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

// ── exec surfaces ──────────────────────────────────────────────────────────
const git = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return Promise.resolve({ code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' });
};
/** bash shell with aws interception — tests must never touch real AWS. */
const shell = (command, cwd) => {
  if (/\baws s3 cp\b/.test(command)) {
    return Promise.resolve({ code: 1, stdout: '', stderr: '(test) aws disabled' });
  }
  const r = spawnSync('bash', ['-c', command], { cwd, encoding: 'utf8' });
  return Promise.resolve({ code: r.status ?? -1, stdout: r.stdout || '', stderr: r.stderr || '' });
};
const g = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
};

let seq = 0;
function mkCandidate() {
  const dir = join(TMP, `cand-${seq++}`);
  mkdirSync(join(dir, 'src', 'features'), { recursive: true });
  writeFileSync(
    join(dir, 'src', 'features', 'alpha.feature.tsx'),
    "export const feature = { slug: 'alpha', order: 10 };\nexport default function A(){return null;}\n",
  );
  g(['init', '-b', 'main'], dir);
  g(['config', 'user.email', 't@example.com'], dir);
  g(['config', 'user.name', 'Test'], dir);
  g(['add', '-A'], dir);
  g(['commit', '-m', 'seed'], dir);
  return dir;
}

function mkShot() {
  const p = join(TMP, `shot-${seq++}.png`);
  writeFileSync(p, 'PNG-FAKE');
  return p;
}

const STORY = {
  storyId: 'S1',
  title: 'Render the alpha surface',
  touchPoints: ['src/features/alpha.feature.tsx'],
  criteria: [
    { id: 'AC-1', text: 'at load the alpha surface is visible', needsBrowser: true },
    { id: 'AC-2', text: 'reducer returns the next state', needsBrowser: false },
  ],
};

const qaContext = { defaultPort: 3000, healthcheckPath: '/', devCommand: 'npm run dev -- --port', warmupMs: 0, buildCacheDir: '.next' };

const fakeBoot = (state = {}) => {
  state.boots = 0;
  state.fn = async () => {
    state.boots++;
    return { ok: true, status: '200', port: 3700, logTail: '', serverLog: '/tmp/x.log', stop: async () => {} };
  };
  return state;
};

const evidenceOutput = (entries) =>
  `agent chatter\n---EVIDENCE_JSON---\n${JSON.stringify(entries)}\n---END_EVIDENCE_JSON---\n`;

const judgeOutput = (verdict, conf = 'high', obs = 'seen') =>
  `VERDICT: ${verdict} [conf=${conf}]\nOBSERVATION: ${obs}`;

function baseArgs(candidateDir, overrides = {}) {
  const boot = fakeBoot();
  const shot = mkShot();
  return {
    candidateDir,
    stories: [STORY],
    rigor: 'mvp',
    qaContext,
    planId: 'plan1',
    epicId: 'e1',
    waveNumber: 2,
    appId: 'app1',
    validationCmd: 'true',
    spawnEvidence: async () => ({
      ok: true,
      output: evidenceOutput([
        {
          storyId: 'S1',
          acId: 'AC-1',
          screenshotPath: shot,
          url: 'http://localhost:3700/?feature=alpha',
          capturedSurface: 'the alpha surface, isolated',
          verifiable: true,
        },
      ]),
    }),
    spawnJudge: async () => ({ ok: true, output: judgeOutput('PASS') }),
    spawnTriage: async () => ({ ok: true, output: '' }),
    spawnFixer: async () => ({ attempted: false, reasoning: 'not wired' }),
    shell,
    git,
    writeAttention: async () => {},
    log: () => {},
    bootServer: boot.fn,
    cleanReboot: boot.fn,
    _boot: boot,
    _shot: shot,
    ...overrides,
  };
}

// ── helper units ───────────────────────────────────────────────────────────
describe('helpers', () => {
  it('parseFencedJson extracts the fenced array and rejects garbage', () => {
    expect(parseFencedJson(evidenceOutput([{ a: 1 }]), /---EVIDENCE_JSON---([\s\S]*?)---END_EVIDENCE_JSON---/)).toEqual([{ a: 1 }]);
    expect(parseFencedJson('no fences', /---EVIDENCE_JSON---([\s\S]*?)---END_EVIDENCE_JSON---/)).toBeNull();
    expect(parseFencedJson('---EVIDENCE_JSON---{not json]---END_EVIDENCE_JSON---', /---EVIDENCE_JSON---([\s\S]*?)---END_EVIDENCE_JSON---/)).toBeNull();
  });

  it('parseJudgeOutput reads the VERDICT/OBSERVATION contract', () => {
    expect(parseJudgeOutput('VERDICT: FAIL [conf=high]\nOBSERVATION: wrong color')).toEqual({
      verdict: 'FAIL',
      confidence: 'high',
      observation: 'wrong color',
    });
    expect(parseJudgeOutput('VERDICT: pass')).toMatchObject({ verdict: 'PASS', confidence: 'low' });
    expect(parseJudgeOutput('nonsense')).toBeNull();
  });

  it('judgeConsensus: confirmed FAIL needs strict majority + one high-conf vote', () => {
    const v = (verdict, confidence = 'high') => ({ verdict, confidence, observation: 'o', lens: 'strict' });
    expect(judgeConsensus([v('FAIL'), v('FAIL', 'low')]).result).toBe('FAIL');
    expect(judgeConsensus([v('FAIL', 'low'), v('FAIL', 'low')]).result).toBe('UNCERTAIN');
    expect(judgeConsensus([v('FAIL'), v('PASS')]).result).toBe('UNCERTAIN');
    expect(judgeConsensus([v('PASS'), v('PASS')]).result).toBe('PASS');
    expect(judgeConsensus([v('UNREACHABLE'), v('UNREACHABLE')]).result).toBe('UNVERIFIABLE');
    expect(judgeConsensus([]).result).toBe('UNCERTAIN');
  });

  it('featureSlugsForStory derives slugs from the CANDIDATE feature files', () => {
    const dir = mkCandidate();
    expect(featureSlugsForStory(STORY, dir)).toEqual(['alpha']);
    expect(featureSlugsForStory({ touchPoints: ['src/game/loop.ts'] }, dir)).toEqual([]);
    expect(featureSlugsForStory({ touchPoints: ['src/features/ghost.feature.tsx'] }, dir)).toEqual([]);
  });

  it('renderVqaReport tabulates verdicts and lists fix-forward handoffs', () => {
    const md = renderVqaReport({
      waveNumber: 3,
      verdicts: [{ storyId: 'S1', acId: 'AC-1', result: 'FAIL', observation: 'x', screenshotUrl: 'https://e/x.png' }],
      fixesApplied: [{ acIds: ['AC-9'], summary: 'fixed it' }],
      fixForward: [{ acId: 'AC-1', storyId: 'S1', expected: 'visible', observed: 'absent' }],
      unverifiable: [],
    });
    expect(md).toContain('# Wave 3 — visual QA report');
    expect(md).toContain('| S1 | AC-1 | FAIL |');
    expect(md).toContain('Fix-forward');
    expect(md).toContain('AC-9');
  });
});

// ── outcome paths ──────────────────────────────────────────────────────────
describe('runWaveVqa', () => {
  it('skips at prototype rigor and when no browser ACs exist', async () => {
    const dir = mkCandidate();
    const a = await runWaveVqa(baseArgs(dir, { rigor: 'prototype' }));
    expect(a.outcome).toBe('skipped');
    const b = await runWaveVqa(
      baseArgs(dir, { stories: [{ ...STORY, criteria: [{ id: 'AC-2', text: 'logic', needsBrowser: false }] }] }),
    );
    expect(b.outcome).toBe('skipped');
    expect(b.reason).toBe('no-browser-acs');
  });

  it('env-blocked when the dev server never boots (deterministic failure)', async () => {
    const dir = mkCandidate();
    const result = await runWaveVqa(
      baseArgs(dir, {
        bootServer: async () => ({ ok: false, status: '000', port: 3700, logTail: 'panic: cache corrupt', stop: async () => {} }),
      }),
    );
    expect(result.outcome).toBe('env-blocked');
    expect(result.bootLogTail).toContain('panic');
  });

  it('pass path: judges agree, report committed, evidence read-only enforced', async () => {
    const dir = mkCandidate();
    const args = baseArgs(dir, {
      // Evidence agent misbehaves: dirties the candidate — must be reverted.
      spawnEvidence: async () => {
        writeFileSync(join(dir, 'TAINT.txt'), 'evidence wrote this');
        return {
          ok: true,
          output: evidenceOutput([
            {
              storyId: 'S1',
              acId: 'AC-1',
              screenshotPath: args._shot,
              url: 'http://localhost:3700/?feature=alpha',
              capturedSurface: 'alpha isolated',
              verifiable: true,
            },
          ]),
        };
      },
    });
    const result = await runWaveVqa(args);
    expect(result.outcome).toBe('pass');
    expect(result.verdicts).toEqual([
      expect.objectContaining({ storyId: 'S1', acId: 'AC-1', result: 'PASS' }),
    ]);
    // Read-only enforcement: the taint was reset away.
    expect(existsSync(join(dir, 'TAINT.txt'))).toBe(false);
    // Knowledge report committed into the candidate.
    expect(result.reportPath).toBe(join('.context', 'wave-2-vqa-report.md'));
    expect(existsSync(join(dir, result.reportPath))).toBe(true);
    expect(g(['log', '--oneline', '-1'], dir)).toContain('vqa report');
  });

  it('skipped (non-blocking) when evidence output is unparseable — with a LOW card', async () => {
    const dir = mkCandidate();
    const cards = [];
    const result = await runWaveVqa(
      baseArgs(dir, {
        spawnEvidence: async () => ({ ok: true, output: 'no fences here' }),
        writeAttention: async (c) => cards.push(c),
      }),
    );
    expect(result.outcome).toBe('skipped');
    expect(result.reason).toBe('evidence-unparseable');
    expect(cards).toHaveLength(1);
    expect(cards[0].category).toBe('wave-vqa-unverifiable');
    expect(cards[0].severity).toBe('low');
  });

  it('unverifiable ACs route OUT before judging; all-unverifiable story gets one LOW card', async () => {
    const dir = mkCandidate();
    const cards = [];
    let judgeCalls = 0;
    const result = await runWaveVqa(
      baseArgs(dir, {
        spawnEvidence: async () => ({
          ok: true,
          output: evidenceOutput([
            {
              storyId: 'S1',
              acId: 'AC-1',
              screenshotPath: null,
              capturedSurface: 'idle frame cannot show this',
              verifiable: false,
              whyNotVerifiable: 'requires elapsed gameplay',
            },
          ]),
        }),
        spawnJudge: async () => {
          judgeCalls++;
          return { ok: true, output: judgeOutput('PASS') };
        },
        writeAttention: async (c) => cards.push(c),
      }),
    );
    expect(result.outcome).toBe('pass');
    expect(judgeCalls).toBe(0);
    expect(result.unverifiable).toHaveLength(1);
    expect(result.verdicts[0]).toMatchObject({ acId: 'AC-1', result: 'UNVERIFIABLE' });
    expect(cards.some((c) => c.category === 'wave-vqa-unverifiable')).toBe(true);
  });

  it('fixed path: confirmed FAIL → fixer → RE-CAPTURED evidence passes → audited commit', async () => {
    const dir = mkCandidate();
    let fixed = false;
    let evidenceCalls = 0;
    const args = baseArgs(dir, {
      spawnEvidence: async () => {
        evidenceCalls++;
        const shot = mkShot();
        return {
          ok: true,
          output: evidenceOutput([
            {
              storyId: 'S1',
              acId: 'AC-1',
              screenshotPath: shot,
              url: 'http://localhost:3700/?feature=alpha',
              capturedSurface: fixed ? 'alpha visible' : 'alpha missing',
              verifiable: true,
            },
          ]),
        };
      },
      spawnJudge: async () =>
        fixed
          ? { ok: true, output: judgeOutput('PASS', 'high', 'now visible') }
          : { ok: true, output: judgeOutput('FAIL', 'high', 'surface absent') },
      spawnTriage: async () => ({
        ok: true,
        output: `---TRIAGE_JSON---\n${JSON.stringify([
          { acId: 'AC-1', classification: 'code-bug', suspectedFiles: ['src/features/alpha.feature.tsx'], summary: 'not mounted' },
        ])}\n---END_TRIAGE_JSON---`,
      }),
      spawnFixer: async () => {
        fixed = true;
        writeFileSync(join(dir, 'src', 'features', 'alpha.feature.tsx'), 'export const feature = { slug: "alpha", order: 10 };\nexport default function A(){return <div/>;}\n');
        return { attempted: true, reasoning: 'mounted the surface' };
      },
    });
    const result = await runWaveVqa(args);
    expect(result.outcome).toBe('fixed');
    expect(result.fixesApplied).toHaveLength(1);
    expect(result.fixesApplied[0].acIds).toEqual(['AC-1']);
    expect(result.fixForward).toHaveLength(0);
    // Evidence was RE-CAPTURED for the re-judge (stale screenshots lie).
    expect(evidenceCalls).toBeGreaterThanOrEqual(2);
    // The fix landed as an audited commit, then the report commit on top.
    const log = g(['log', '--format=%s', '-3'], dir);
    expect(log).toContain('vqa-fix — AC-1');
    expect(log).toContain('vqa report');
    // Handoff packet shipped (committed) under .context/vqa-handoffs.
    expect(existsSync(join(dir, '.context', 'vqa-handoffs', 'AC-1.json'))).toBe(true);
  });

  it('fix-forward: failures surviving capped rounds NEVER block — card + handoff + attempts', async () => {
    const dir = mkCandidate();
    const cards = [];
    let fixerCalls = 0;
    const args = baseArgs(dir, {
      spawnJudge: async () => ({ ok: true, output: judgeOutput('FAIL', 'high', 'still absent') }),
      spawnTriage: async () => ({
        ok: true,
        output: `---TRIAGE_JSON---\n${JSON.stringify([
          { acId: 'AC-1', classification: 'code-bug', suspectedFiles: [], summary: 'not mounted' },
        ])}\n---END_TRIAGE_JSON---`,
      }),
      spawnFixer: async () => {
        fixerCalls++;
        writeFileSync(join(dir, 'attempt.txt'), `try ${fixerCalls}`);
        return { attempted: true, reasoning: 'tried something' };
      },
      writeAttention: async (c) => cards.push(c),
    });
    const result = await runWaveVqa(args);
    expect(result.outcome).toBe('fix-forward');
    expect(fixerCalls).toBe(1); // mvp rigor = 1 capped round
    expect(result.fixForward).toHaveLength(1);
    const handoff = result.fixForward[0];
    expect(handoff).toMatchObject({ storyId: 'S1', acId: 'AC-1', expected: STORY.criteria[0].text });
    expect(handoff.attempts).toHaveLength(1);
    expect(handoff.attempts[0].result).toBe('still-failing');
    expect(handoff.verdicts.length).toBeGreaterThan(0);
    // MEDIUM card with the full handoff in context (M5 renders + mints from it).
    const card = cards.find((c) => c.category === 'wave-vqa-failed');
    expect(card).toBeTruthy();
    expect(card.severity).toBe('medium');
    expect(card.dedupKey).toBe('wave-vqa:plan1:e1:2:S1');
    expect(card.context.handoff.acId).toBe('AC-1');
    // Handoff packet on disk, committed with the report.
    expect(existsSync(join(dir, '.context', 'vqa-handoffs', 'AC-1.json'))).toBe(true);
    const packet = JSON.parse(readFileSync(join(dir, '.context', 'vqa-handoffs', 'AC-1.json'), 'utf8'));
    expect(packet.verifyCommand).toContain('feature=alpha');
  });

  it('a fixer that breaks the validation gate is REVERTED (green-gated fixes only)', async () => {
    const dir = mkCandidate();
    const headBefore = g(['rev-parse', 'HEAD'], dir);
    const args = baseArgs(dir, {
      validationCmd: 'test ! -f BREAKS_BUILD.txt', // fails iff the fixer's file exists
      spawnJudge: async () => ({ ok: true, output: judgeOutput('FAIL', 'high', 'absent') }),
      spawnTriage: async () => ({
        ok: true,
        output: `---TRIAGE_JSON---\n${JSON.stringify([{ acId: 'AC-1', classification: 'code-bug', suspectedFiles: [], summary: 's' }])}\n---END_TRIAGE_JSON---`,
      }),
      spawnFixer: async () => {
        writeFileSync(join(dir, 'BREAKS_BUILD.txt'), 'oops');
        return { attempted: true, reasoning: 'bad fix' };
      },
    });
    const result = await runWaveVqa(args);
    expect(result.outcome).toBe('fix-forward');
    // The bad fix is GONE (hard reset to the pre-fix SHA).
    expect(existsSync(join(dir, 'BREAKS_BUILD.txt'))).toBe(false);
    expect(result.fixForward[0].attempts[0].result).toBe('reverted');
    // Only the report commit was added on top of the original head.
    expect(g(['rev-parse', 'HEAD~1'], dir)).toBe(headBefore);
  });
});
