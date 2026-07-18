'use client';

/**
 * PromoteCtaBar — the single promote-ladder CTA shared by DeploymentView
 * (dev→staging, no confirm) and PublishView (staging→production, explicit
 * typed confirm — a destructive/irreversible action per Vercel guidelines).
 * Design doc I8 slice N3.
 *
 * Always disabled-with-reason (never a silent no-op): `gate.reason` renders
 * beneath the button whenever `gate.canPromote` is false, sourced from the
 * pure `canPromote` / `canPromoteToProduction` helpers in `deploy-gate.ts`.
 */

import { useState } from 'react';
import { ArrowRight, Loader2, Rocket } from 'lucide-react';
import { usePromoteApp } from '@/hooks/use-deploy-report';
import type { PromoteGate } from './deploy-gate';

export interface PromoteCtaBarProps {
  planId: string;
  target: 'staging' | 'production';
  /** Button label, e.g. "Promote to staging" / "Publish to production". */
  label: string;
  gate: PromoteGate;
  /** Already-live URL for this target, shown as "Open live" when present. */
  liveUrl?: string;
  /** When set, requires typing this exact word before firing (destructive actions). */
  confirmWord?: string;
  /** Explanation shown alongside the confirm input. */
  confirmCopy?: string;
}

function primaryBtnStyle(disabled: boolean): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '7px 14px',
    border: disabled ? '1px solid var(--border-2)' : '1px solid var(--success)',
    borderRadius: 2,
    color: disabled ? 'var(--text-faint)' : 'var(--background)',
    background: disabled ? 'transparent' : 'var(--success)',
    fontWeight: 500,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
  };
}

function ghostBtnStyle(): React.CSSProperties {
  return {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    fontSize: 10,
    letterSpacing: '0.14em',
    textTransform: 'uppercase',
    padding: '7px 14px',
    border: '1px solid var(--border-2)',
    borderRadius: 2,
    color: 'var(--text-dim)',
    background: 'transparent',
    cursor: 'pointer',
  };
}

export function PromoteCtaBar({
  planId,
  target,
  label,
  gate,
  liveUrl,
  confirmWord,
  confirmCopy,
}: PromoteCtaBarProps) {
  const promote = usePromoteApp(planId);
  const [confirming, setConfirming] = useState(false);
  const [typed, setTyped] = useState('');

  const busy = promote.isPending;
  const canAct = gate.canPromote && !busy;
  const armed = !confirmWord || typed.trim().toUpperCase() === confirmWord.toUpperCase();

  function fire() {
    promote.mutate(target, {
      onSuccess: () => {
        setConfirming(false);
        setTyped('');
      },
    });
  }

  function onPrimaryClick() {
    if (!canAct) return;
    if (confirmWord && !confirming) {
      setConfirming(true);
      return;
    }
    fire();
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        flexWrap: 'wrap',
        padding: '14px 18px',
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--bg-elev)',
      }}
    >
      <div style={{ flex: 1, minWidth: 180 }}>
        {liveUrl ? (
          <a
            href={liveUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--accent-blue)',
              textDecoration: 'none',
            }}
          >
            Open live
            <ArrowRight size={11} aria-hidden="true" />
          </a>
        ) : (
          <span style={{ fontSize: 12, color: 'var(--text-mute)' }}>Not deployed yet</span>
        )}
      </div>

      {promote.isError && (
        <span role="alert" style={{ fontSize: 11, color: 'var(--destructive)', maxWidth: 260 }}>
          {promote.error instanceof Error ? promote.error.message : 'Promotion failed.'}
        </span>
      )}

      {confirming ? (
        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 10, color: 'var(--warning)', maxWidth: 240, lineHeight: 1.4 }}>
            {confirmCopy} Type <strong>{confirmWord}</strong>.
          </span>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && armed && !busy) fire();
            }}
            autoFocus
            placeholder={confirmWord}
            aria-label={`Type ${confirmWord} to confirm`}
            style={{
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
              padding: '6px 8px',
              border: '1px solid var(--border-2)',
              borderRadius: 2,
              background: 'var(--background)',
              color: 'var(--foreground)',
              width: 120,
            }}
          />
          <button
            type="button"
            onClick={fire}
            disabled={busy || !armed}
            style={primaryBtnStyle(busy || !armed)}
          >
            {busy ? (
              <Loader2 size={11} className="animate-spin" aria-hidden="true" />
            ) : (
              <Rocket size={11} aria-hidden="true" />
            )}
            {busy ? 'Promoting…' : label}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
              setTyped('');
            }}
            style={ghostBtnStyle()}
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={onPrimaryClick}
          disabled={!canAct}
          title={!gate.canPromote ? gate.reason : undefined}
          style={primaryBtnStyle(!canAct)}
        >
          {busy ? (
            <Loader2 size={11} className="animate-spin" aria-hidden="true" />
          ) : (
            <Rocket size={11} aria-hidden="true" />
          )}
          {busy ? 'Promoting…' : label}
        </button>
      )}

      {!gate.canPromote && gate.reason && (
        <span style={{ fontSize: 10, color: 'var(--text-mute)', flexBasis: '100%' }}>
          {gate.reason}
        </span>
      )}
    </div>
  );
}
