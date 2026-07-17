/**
 * Agentic Document Center — E2.4 (W2): the router decision ledger (pure layer).
 *
 * Every routing decision is recorded so replays are free and the history is
 * auditable (the audit trail per artifact). The physical append to
 * `knowledge/_docs/router-log.jsonl` is daemon-side I/O; this module is the
 * pure idempotency + dedup core that the daemon and the approve/reject API both
 * use, mirroring the Reflector inbox's append-once discipline.
 */
import type { DocRouterDecision } from '../schemas/doc-router-schema';

export interface LedgerEntry {
  /** The decision as routed. */
  decision: DocRouterDecision;
  /** ISO timestamp the entry was written. */
  recordedAt: string;
  /** Whether the decision has been acted on (applied) or awaits operator review. */
  state: 'applied' | 'proposed' | 'approved' | 'rejected';
}

/**
 * The idempotency key for a decision. A given artifact routed to the same
 * action+target+edge is the SAME decision — re-running the router must not
 * append a duplicate row nor re-apply the action.
 */
export function ledgerKey(d: DocRouterDecision): string {
  const t = d.target ? `${d.target.docType}:${d.target.shardKey}` : '-';
  const e = d.edge ? `${d.edge.type}:${d.edge.from}->${d.edge.to}` : '-';
  return `${d.artifactRef}|${d.action}|${t}|${e}`;
}

/** True iff this decision is already in the ledger (by idempotency key). */
export function alreadyLedgered(existing: LedgerEntry[], d: DocRouterDecision): boolean {
  const key = ledgerKey(d);
  return existing.some((e) => ledgerKey(e.decision) === key);
}

/**
 * Append a decision to the ledger idempotently. Returns the (possibly unchanged)
 * ledger and whether a new entry was added. A 'proposed' decision starts
 * 'proposed' (operator-gated); everything else starts 'applied'.
 */
export function appendDecision(
  existing: LedgerEntry[],
  d: DocRouterDecision,
  recordedAt: string,
): { ledger: LedgerEntry[]; added: boolean } {
  if (alreadyLedgered(existing, d)) return { ledger: existing, added: false };
  const entry: LedgerEntry = {
    decision: d,
    recordedAt,
    state: d.status === 'proposed' ? 'proposed' : 'applied',
  };
  return { ledger: [...existing, entry], added: true };
}

/**
 * Resolve an operator decision on a 'proposed' entry. Idempotent: resolving an
 * already-resolved entry is a no-op (returns it unchanged).
 */
export function resolveProposed(
  existing: LedgerEntry[],
  key: string,
  verdict: 'approved' | 'rejected',
): LedgerEntry[] {
  return existing.map((e) => {
    if (ledgerKey(e.decision) !== key) return e;
    if (e.state !== 'proposed') return e; // already resolved — no-op
    return { ...e, state: verdict };
  });
}

/** The decisions still awaiting operator review. */
export function pendingProposals(existing: LedgerEntry[]): LedgerEntry[] {
  return existing.filter((e) => e.state === 'proposed');
}
