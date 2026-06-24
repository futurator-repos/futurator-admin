// case2-real.test.mjs — DRIFT GUARD (design §4 / risk #4). Proves the plain-JS slice port of the
// wave layering AGREES with the real deployed services, and that buildAgentConfig resolves real
// capability scoping per story. Requires a runtime that strips TS at import (node ≥23.6).

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { case2ToDecision } from '../lib/case2-to-decision.mjs';
import { case2ToDecisionReal } from '../lib/case2-to-decision-real.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const planOutput = JSON.parse(readFileSync(resolve(here, 'fixtures/sample-plan-output.json'), 'utf8'));

const waveShape = (p) => p.phases.map((ph) => ({ mode: ph.mode, n: ph.agents.length, width: ph.fanOut?.width ?? null }));

test('drift guard — plain port and real services produce the SAME wave structure', async () => {
  const ctx = { target: 'greenfield', rigor: 'production' };
  const plain = case2ToDecision(planOutput, ctx);
  const real = await case2ToDecisionReal(planOutput, ctx);

  // if the runtime couldn't strip TS, the real fn falls back to the plain port — flag, don't false-pass
  assert.ok(!real.extraction.lossy.some((s) => /real-services-unavailable/.test(s)),
    'real services did not load (TS stripping unavailable) — drift guard inconclusive');

  assert.equal(real.phases.length, plain.phases.length);
  assert.deepEqual(waveShape(real), waveShape(plain)); // identical layering ⇒ the slice port is faithful
});

test('real services — buildAgentConfig resolves real capability scoping per story', async () => {
  const real = await case2ToDecisionReal(planOutput, { rigor: 'production' });
  assert.ok(real.capability, 'expected real capability map');
  const cfgs = Object.values(real.capability);
  assert.equal(cfgs.length, 5); // S1..S5
  for (const c of cfgs) {
    assert.ok(typeof c.allowedTools === 'string' && c.allowedTools.length > 0); // real allowlist
    assert.ok(c.disallowedTools.includes('WebFetch')); // BASELINE_DENY applied
    assert.ok(Number.isInteger(c.maxTurns) && c.maxTurns > 0); // real per-rigor turn cap (DEV/production = 12)
  }
});
