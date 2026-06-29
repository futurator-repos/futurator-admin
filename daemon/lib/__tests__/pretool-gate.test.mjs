import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeRisk,
  decide,
  parseHookPayload,
  loadPolicy,
  targetFile,
  resolvePolicyForTarget,
  sweepStaleMemos,
} from '../pretool-gate.mjs';
import { appendGateEvent, readGateEvents, rollupGateStats } from '../gate-ledger.mjs';
import { buildGateSpawn } from '../gate-settings.mjs';

/** Ported from spikes/pretool-gate (8 green tests) + new coverage for the
 *  daemon promotion: policy walk-up, memo TTL sweep, ledger rollup, settings. */

describe('computeRisk (ported)', () => {
  it('read-only/low edits stay in allow tier', () => {
    expect(computeRisk('Edit', { file_path: 'src/ui/button.tsx' }).tier).toBe('allow');
    expect(computeRisk('Grep', {}).tier).toBe('allow');
  });
  it('destructive bash is block tier; force-push is confirm+', () => {
    expect(computeRisk('Bash', { command: 'rm -rf /' }).tier).toBe('block');
    expect(['confirm', 'block']).toContain(computeRisk('Bash', { command: 'git push --force origin main' }).tier);
  });
  it('editing a secrets/infra file is elevated', () => {
    expect(computeRisk('Write', { file_path: '.env.production' }).score).toBeGreaterThanOrEqual(0.35);
    expect(computeRisk('Edit', { file_path: 'sst.config.ts' }).score).toBeGreaterThanOrEqual(0.25);
  });
});

describe('decide (ported)', () => {
  it('forbiddenArea is a hard block', () => {
    const d = decide(
      { toolName: 'Edit', toolInput: { file_path: 'functions/shared/auth-middleware.ts' } },
      { forbiddenAreas: ['functions/shared/auth-middleware.ts'] },
    );
    expect(d.decision).toBe('block');
    expect(d.reason).toMatch(/forbidden/);
  });
  it('out-of-scope edit blocks; in-scope passes', () => {
    const policy = { touchPoints: ['src/auth/**'] };
    expect(decide({ toolName: 'Edit', toolInput: { file_path: 'src/billing/charge.ts' } }, policy).decision).toBe('block');
    expect(decide({ toolName: 'Edit', toolInput: { file_path: 'src/auth/login.ts' } }, policy).decision).toBe('allow');
  });
  it('confirm-tier bash → fact-force with required-facts message', () => {
    const d = decide({ toolName: 'Bash', toolInput: { command: 'git push --force origin my-feature' } }, {});
    expect(d.decision).toBe('fact-force');
    expect(d.reason).toMatch(/rollback/i);
  });
  it('read-only tools always allowed', () => {
    expect(decide({ toolName: 'Read', toolInput: { file_path: '.env' } }, {}).decision).toBe('allow');
  });
});

describe('helpers (ported)', () => {
  it('targetFile + payload + policy parsing', () => {
    expect(targetFile('Edit', { file_path: 'a.ts' })).toBe('a.ts');
    expect(targetFile('Bash', { command: 'ls' })).toBe(null);
    const p = parseHookPayload('{"tool_name":"Write","tool_input":{"file_path":"x.ts"}}', {});
    expect(p.toolName).toBe('Write');
    expect(p.toolInput.file_path).toBe('x.ts');
    const pol = loadPolicy({ FUTURATOR_GATE_MODE: 'ENFORCE', FUTURATOR_TOUCH_POINTS: 'src/a/**, src/b/**' });
    expect(pol.mode).toBe('enforce');
    expect(pol.touchPoints).toEqual(['src/a/**', 'src/b/**']);
  });
});

describe('resolvePolicyForTarget (Phase-3 seam, safe in Phase 1)', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'gate-policy-')); });

  it('returns base policy unchanged when no .futurator/gate-policy.json exists', () => {
    const base = { mode: 'audit', touchPoints: ['a/**'], forbiddenAreas: [] };
    const eff = resolvePolicyForTarget(join(root, 'src', 'x.ts'), base);
    expect(eff).toEqual(base);
  });

  it('overlays the nearest worktree policy file onto the base', () => {
    const wt = join(root, 'wt');
    mkdirSync(join(wt, '.futurator'), { recursive: true });
    writeFileSync(join(wt, '.futurator', 'gate-policy.json'), JSON.stringify({ touchPoints: ['wt/src/**'], forbiddenAreas: ['wt/secret/**'] }));
    const base = { mode: 'enforce', touchPoints: [], forbiddenAreas: [] };
    const eff = resolvePolicyForTarget(join(wt, 'src', 'deep', 'x.ts'), base);
    expect(eff.mode).toBe('enforce'); // file omits mode → base mode kept
    expect(eff.touchPoints).toEqual(['wt/src/**']);
    expect(eff.forbiddenAreas).toEqual(['wt/secret/**']);
  });

  it('a corrupt policy file falls back to base (fail-open)', () => {
    const wt = join(root, 'wt');
    mkdirSync(join(wt, '.futurator'), { recursive: true });
    writeFileSync(join(wt, '.futurator', 'gate-policy.json'), '{ not json');
    const base = { mode: 'audit', touchPoints: ['a/**'], forbiddenAreas: [] };
    expect(resolvePolicyForTarget(join(wt, 'x.ts'), base)).toEqual(base);
  });
});

describe('sweepStaleMemos (gate-memo-sweep TTL)', () => {
  it('removes memos older than the TTL, keeps fresh ones', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-memo-'));
    const stale = join(dir, 'aaa.seen');
    const fresh = join(dir, 'bbb.seen');
    writeFileSync(stale, '');
    writeFileSync(fresh, '');
    const old = Date.now() / 1000 - 60 * 60; // 1h ago in seconds
    utimesSync(stale, old, old);
    const res = sweepStaleMemos({ stateDir: dir, ttlMs: 30 * 60 * 1000, now: Date.now() });
    expect(res.swept).toBe(1);
    expect(res.kept).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });
  it('missing dir is a no-op', () => {
    expect(sweepStaleMemos({ stateDir: join(tmpdir(), 'does-not-exist-xyz') })).toEqual({ swept: 0, kept: 0 });
  });
});

describe('gate-ledger rollup', () => {
  it('counts would-blocks vs blocks and breaks down by tier/factor', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'gate-ledger-')), 'gate-events.jsonl');
    appendGateEvent(path, { decision: 'block', enforce: false, risk: { tier: 'block', factors: ['base:Bash=0.2', 'irreversible'] }, session: 's1' });
    appendGateEvent(path, { decision: 'block', enforce: true, risk: { tier: 'block', factors: ['force-push'] }, session: 's1' });
    appendGateEvent(path, { decision: 'audit', enforce: false, risk: { tier: 'review', factors: ['infra-file'] }, session: 's2' });
    appendGateEvent(path, { decision: 'fact-force-cleared', enforce: false });
    const stats = rollupGateStats(readGateEvents(path));
    expect(stats.total).toBe(4);
    expect(stats.wouldBlock).toBe(1);
    expect(stats.blocked).toBe(1);
    expect(stats.audit).toBe(1);
    expect(stats.factForceCleared).toBe(1);
    expect(stats.byFactor.irreversible).toBe(1);
    expect(stats.byTier.block).toBe(2);
  });
});

describe('buildGateSpawn (wire-in)', () => {
  it('off/absent flags → no-op spawn (legacy unchanged)', () => {
    expect(buildGateSpawn({ jobId: 'j', p3Flags: { P3_GATE_MODE: 'off' } })).toEqual({ settingsPath: null, args: [], env: {} });
    expect(buildGateSpawn({ jobId: 'j' })).toEqual({ settingsPath: null, args: [], env: {} });
  });
  it('audit mode writes settings + env + --settings arg', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-settings-'));
    const g = buildGateSpawn({
      jobId: 'job-123',
      p3Flags: { P3_GATE_MODE: 'audit' },
      touchPoints: ['src/**'],
      forbiddenAreas: ['x/**'],
      ledgerPath: '/tmp/led.jsonl',
      settingsDir: dir,
    });
    expect(g.args[0]).toBe('--settings');
    expect(existsSync(g.settingsPath)).toBe(true);
    expect(g.env.FUTURATOR_GATE_MODE).toBe('audit');
    expect(JSON.parse(g.env.FUTURATOR_TOUCH_POINTS)).toEqual(['src/**']);
    expect(g.env.FUTURATOR_GATE_LEDGER).toBe('/tmp/led.jsonl');
  });
});
