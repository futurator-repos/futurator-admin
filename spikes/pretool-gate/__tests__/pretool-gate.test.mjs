// Runnable checks for the keystone gate. Pure functions only (no stdin/exit).
// Run: node --test spikes/pretool-gate/__tests__/pretool-gate.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeRisk, decide, parseHookPayload, loadPolicy, targetFile } from '../pretool-gate.mjs';

test('risk: read-only/low edits stay in allow tier', () => {
  assert.equal(computeRisk('Edit', { file_path: 'src/ui/button.tsx' }).tier, 'allow');
  assert.equal(computeRisk('Grep', {}).tier, 'allow');
});

test('risk: destructive bash is block tier; force-push is confirm+', () => {
  assert.equal(computeRisk('Bash', { command: 'rm -rf /' }).tier, 'block');           // .20+.45+.35
  const force = computeRisk('Bash', { command: 'git push --force origin main' });
  assert.ok(['confirm', 'block'].includes(force.tier));                                // .20+.40+.35
});

test('risk: editing a secrets/infra file is elevated', () => {
  assert.ok(computeRisk('Write', { file_path: '.env.production' }).score >= 0.35);
  assert.ok(computeRisk('Edit', { file_path: 'sst.config.ts' }).score >= 0.25);
});

test('decide: forbiddenArea is a hard block', () => {
  const d = decide({ toolName: 'Edit', toolInput: { file_path: 'functions/shared/auth-middleware.ts' } },
    { forbiddenAreas: ['functions/shared/auth-middleware.ts'] });
  assert.equal(d.decision, 'block');
  assert.match(d.reason, /forbidden/);
});

test('decide: out-of-scope edit blocks; in-scope passes', () => {
  const policy = { touchPoints: ['src/auth/**'] };
  assert.equal(decide({ toolName: 'Edit', toolInput: { file_path: 'src/billing/charge.ts' } }, policy).decision, 'block');
  assert.equal(decide({ toolName: 'Edit', toolInput: { file_path: 'src/auth/login.ts' } }, policy).decision, 'allow');
});

test('decide: confirm-tier bash → fact-force with required-facts message', () => {
  // force-push to a feature branch = .20 base + .40 force, no shared-blast → confirm tier (not block).
  const d = decide({ toolName: 'Bash', toolInput: { command: 'git push --force origin my-feature' } }, {});
  assert.equal(d.decision, 'fact-force');
  assert.match(d.reason, /rollback/i);
});

test('decide: read-only tools always allowed', () => {
  assert.equal(decide({ toolName: 'Read', toolInput: { file_path: '.env' } }, {}).decision, 'allow');
});

test('targetFile + payload + policy parsing', () => {
  assert.equal(targetFile('Edit', { file_path: 'a.ts' }), 'a.ts');
  assert.equal(targetFile('Bash', { command: 'ls' }), null);
  const p = parseHookPayload('{"tool_name":"Write","tool_input":{"file_path":"x.ts"}}', {});
  assert.equal(p.toolName, 'Write');
  assert.equal(p.toolInput.file_path, 'x.ts');
  const pol = loadPolicy({ FUTURATOR_GATE_MODE: 'ENFORCE', FUTURATOR_TOUCH_POINTS: 'src/a/**, src/b/**' });
  assert.equal(pol.mode, 'enforce');
  assert.deepEqual(pol.touchPoints, ['src/a/**', 'src/b/**']);
});
