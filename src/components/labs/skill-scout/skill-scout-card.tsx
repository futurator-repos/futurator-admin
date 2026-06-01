/**
 * skill-scout-card.tsx — Pipeline v2 Phase 3-C Epic 3 (Story 3.5, 2026-05-20).
 *
 * Specialized renderer for attention items with
 * `category === 'manifest-change-proposed'`. Shows the SKILL-SCOUT
 * proposals + four actions (confirm / edit / decline / defer). Mounted
 * by attention-dock.tsx when it detects the category match (follow-on
 * wire when the dock gains category-based card routing).
 *
 * Confirm / decline / defer call the API directly; Edit opens a modal
 * (also follow-on — v1 ships the "Confirm all" button only and lets
 * operators decline if they want to pick a subset).
 */

'use client';

import { useState } from 'react';
import { api } from '@/lib/api-client';

export interface SkillProposal {
  kind: 'add' | 'remove' | 'upgrade';
  source: string;
  skill: string;
  manifestBucket: 'core' | 'stack' | 'domain' | 'vendor';
  version: string;
  rationale: string;
  verifyNotes: string;
  confidence: number;
}

export interface SkillScoutCardContext {
  trigger: 'T1' | 'T2' | 'T3' | 'T4' | 'T5' | 'T6' | 'T7' | 'T8';
  projectSlug: string;
  appId?: string;
  planId?: string;
  proposalCount: number;
  proposals: SkillProposal[];
}

export interface SkillScoutCardProps {
  itemId: string;
  planId: string;
  context: SkillScoutCardContext;
  /** Called when the operator's action successfully resolves the card. */
  onResolved?: () => void;
}

const TRIGGER_LABEL: Record<SkillScoutCardContext['trigger'], string> = {
  T1: 'Project init',
  T2: 'Plan intent',
  T3: 'Brownfield audit',
  T4: 'PM speculation',
  T5: 'New dependency',
  T6: 'Reviewer cluster',
  T7: 'Stream graduation',
  T8: 'Weekly refresh',
};

const KIND_BADGE: Record<SkillProposal['kind'], { label: string; color: string }> = {
  add: { label: '+', color: 'var(--success, #22c55e)' },
  upgrade: { label: '↑', color: 'var(--accent-blue, #3b82f6)' },
  remove: { label: '−', color: 'var(--warning, #f59e0b)' },
};

export function SkillScoutCard({ itemId, planId, context, onResolved }: SkillScoutCardProps) {
  const [busy, setBusy] = useState<null | 'confirm' | 'decline' | 'defer'>(null);
  const [error, setError] = useState<string | null>(null);

  const callApi = async (action: 'confirm' | 'decline' | 'defer') => {
    setBusy(action);
    setError(null);
    try {
      // Use the shared api client — it targets the API base URL (Lambda)
      // and attaches auth. A raw fetch('/api/…') resolves against the
      // static-site origin (S3) in production and 405s. The base already
      // includes `/api`, so the path here must NOT repeat it.
      await api.post(
        `/skill-scout/proposals/${encodeURIComponent(itemId)}/${action}?planId=${encodeURIComponent(planId)}`,
        {},
      );
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <article
      style={{
        margin: '12px 0',
        padding: '14px 14px 14px 18px',
        background: 'color-mix(in srgb, var(--accent-blue, #3b82f6) 4%, transparent)',
        border: '1px solid var(--accent-blue, #3b82f6)',
        borderRadius: 4,
      }}
    >
      <header style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--accent-blue, #3b82f6)',
          }}
        >
          SKILL-SCOUT · {TRIGGER_LABEL[context.trigger]}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
          }}
        >
          {context.proposalCount} proposal{context.proposalCount === 1 ? '' : 's'} ·{' '}
          {context.projectSlug}
        </span>
      </header>

      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 12px' }}>
        {context.proposals.map((p) => (
          <li
            key={`${p.skill}@${p.source}`}
            style={{
              display: 'grid',
              gridTemplateColumns: 'auto 1fr auto',
              gap: 8,
              alignItems: 'baseline',
              padding: '4px 0',
              borderBottom: '1px solid var(--border)',
              fontSize: 12,
            }}
          >
            <span
              aria-label={p.kind}
              style={{
                fontFamily: 'var(--font-mono)',
                color: KIND_BADGE[p.kind].color,
                width: 12,
                textAlign: 'center',
                fontSize: 14,
              }}
            >
              {KIND_BADGE[p.kind].label}
            </span>
            <div>
              <code style={{ fontSize: 11 }}>
                {p.skill}@{p.source}
              </code>
              <div style={{ fontSize: 11, color: 'var(--text-mute)', marginTop: 2 }}>
                {p.rationale}
              </div>
            </div>
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                color: 'var(--text-faint)',
              }}
              title={`bucket=${p.manifestBucket} · version=${p.version}`}
            >
              conf {p.confidence.toFixed(2)}
            </span>
          </li>
        ))}
      </ul>

      {error && (
        <p style={{ fontSize: 11, color: 'var(--warning, #f59e0b)', marginBottom: 8 }}>
          Error: {error}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="button"
          onClick={() => callApi('confirm')}
          disabled={busy !== null}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '5px 10px',
            borderRadius: 2,
            border: '1px solid var(--success, #22c55e)',
            background: 'color-mix(in srgb, var(--success, #22c55e) 10%, transparent)',
            color: 'var(--success, #22c55e)',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy === 'confirm' ? 'Confirming…' : 'Confirm all'}
        </button>
        <button
          type="button"
          onClick={() => callApi('decline')}
          disabled={busy !== null}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '5px 10px',
            borderRadius: 2,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-mute)',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy === 'decline' ? 'Declining…' : 'Decline'}
        </button>
        <button
          type="button"
          onClick={() => callApi('defer')}
          disabled={busy !== null}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            padding: '5px 10px',
            borderRadius: 2,
            border: '1px solid var(--border)',
            background: 'transparent',
            color: 'var(--text-mute)',
            cursor: busy ? 'wait' : 'pointer',
          }}
        >
          {busy === 'defer' ? 'Deferring…' : 'Defer'}
        </button>
        {/* Edit action deferred to v2 — operator can Decline + Confirm a fresh sub-card. */}
      </div>
    </article>
  );
}
