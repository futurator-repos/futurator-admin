import { describe, it, expect } from 'vitest';
import {
  ledgerKey,
  alreadyLedgered,
  appendDecision,
  resolveProposed,
  pendingProposals,
  type LedgerEntry,
} from '../doc-router-ledger';
import type { DocRouterDecision } from '../../schemas/doc-router-schema';

function mergeDecision(shardKey: string): DocRouterDecision {
  return {
    artifactRef: `knowledge/code/${shardKey}.md`,
    provenance: 'code-wiki-change',
    realm: 'official',
    action: 'merge-shard',
    target: { docType: 'architecture', shardKey },
    reason: 'r',
    status: 'applied',
  };
}

function proposedDecision(): DocRouterDecision {
  return {
    artifactRef: 'mystery.md',
    provenance: 'unknown',
    realm: 'decisions',
    action: 'log-only',
    reason: 'r',
    status: 'proposed',
  };
}

describe('ledgerKey / alreadyLedgered', () => {
  it('same artifact+action+target ⇒ same key (idempotent)', () => {
    const a = mergeDecision('§sys:a');
    const b = mergeDecision('§sys:a');
    expect(ledgerKey(a)).toBe(ledgerKey(b));
  });

  it('different target ⇒ different key', () => {
    expect(ledgerKey(mergeDecision('§sys:a'))).not.toBe(ledgerKey(mergeDecision('§sys:b')));
  });
});

describe('appendDecision', () => {
  it('appends a new decision and marks applied', () => {
    const { ledger, added } = appendDecision([], mergeDecision('§sys:a'), 'T0');
    expect(added).toBe(true);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].state).toBe('applied');
  });

  it('is idempotent — re-appending the same decision adds nothing', () => {
    const first = appendDecision([], mergeDecision('§sys:a'), 'T0').ledger;
    const second = appendDecision(first, mergeDecision('§sys:a'), 'T1');
    expect(second.added).toBe(false);
    expect(second.ledger).toHaveLength(1);
  });

  it('a proposed decision starts proposed (operator-gated)', () => {
    const { ledger } = appendDecision([], proposedDecision(), 'T0');
    expect(ledger[0].state).toBe('proposed');
  });
});

describe('resolveProposed / pendingProposals', () => {
  it('approving flips a proposed entry to approved; pending shrinks', () => {
    const entries: LedgerEntry[] = appendDecision([], proposedDecision(), 'T0').ledger;
    expect(pendingProposals(entries)).toHaveLength(1);
    const resolved = resolveProposed(entries, ledgerKey(proposedDecision()), 'approved');
    expect(resolved[0].state).toBe('approved');
    expect(pendingProposals(resolved)).toHaveLength(0);
  });

  it('resolving an already-resolved entry is a no-op (idempotent)', () => {
    const entries = appendDecision([], proposedDecision(), 'T0').ledger;
    const once = resolveProposed(entries, ledgerKey(proposedDecision()), 'approved');
    const twice = resolveProposed(once, ledgerKey(proposedDecision()), 'rejected');
    expect(twice[0].state).toBe('approved'); // unchanged
  });
});
