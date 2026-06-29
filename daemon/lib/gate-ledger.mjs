// gate-ledger — append-only record of every live-gate decision (development-plan §5.4).
//
// The gate hook itself writes raw JSONL lines (best-effort, fail-open) to the
// path in FUTURATOR_GATE_LEDGER. This module owns the *read* side: rolling those
// lines up into the audit-mode A/B verdict — "how many would-blocks, by tier and
// factor" — which is exactly the signal the audit→enforce rollout gates on
// (flip enforce only at zero false-positive would-blocks).

import { existsSync, readFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** Append one gate event as JSONL. Best-effort; never throws. */
export function appendGateEvent(ledgerPath, record) {
  if (!ledgerPath) return;
  try {
    mkdirSync(dirname(ledgerPath), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify(record) + '\n', 'utf8');
  } catch { /* fail-open */ }
}

/** Parse a gate-events.jsonl file into records. Tolerates partial/corrupt lines. */
export function readGateEvents(ledgerPath) {
  if (!ledgerPath || !existsSync(ledgerPath)) return [];
  const out = [];
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* skip corrupt line */ }
  }
  return out;
}

/**
 * Roll gate events into A/B-ready stats. The headline number for the rollout
 * decision is `wouldBlock` (audit mode) vs `blocked` (enforce mode); the
 * by-tier / by-factor breakdowns drive allowlist refinement (e.g. an
 * `infra-file` would-block on package.json during an install is a false
 * positive to allowlist before enforcing).
 *
 * @param {Array<object>} events
 */
export function rollupGateStats(events = []) {
  const stats = {
    total: events.length,
    allow: 0,
    audit: 0,
    wouldBlock: 0,
    blocked: 0,
    factForce: 0,
    factForceCleared: 0,
    byTier: {},
    byFactor: {},
    bySession: {},
  };
  for (const e of events) {
    const d = e.decision;
    if (d === 'audit') stats.audit += 1;
    else if (d === 'fact-force') stats.factForce += 1;
    else if (d === 'fact-force-cleared') stats.factForceCleared += 1;
    else if (d === 'block') {
      if (e.enforce) stats.blocked += 1;
      else stats.wouldBlock += 1;
    } else if (d === 'allow') stats.allow += 1;

    const tier = e.risk?.tier;
    if (tier) stats.byTier[tier] = (stats.byTier[tier] || 0) + 1;
    for (const f of e.risk?.factors || []) {
      const key = String(f).split(':')[0].split('=')[0];
      stats.byFactor[key] = (stats.byFactor[key] || 0) + 1;
    }
    if (e.session) stats.bySession[e.session] = (stats.bySession[e.session] || 0) + 1;
  }
  return stats;
}
