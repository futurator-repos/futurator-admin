'use client';

import Link from 'next/link';

/**
 * Labs3 header — the SDD sibling of legacy LabsHeader. Sits inside AppShell's
 * <main>. Carries the "L A B S · 3" wordmark and a "Plan Spec Graph" tag so the
 * operator always knows they're on the pipeline-3 surface (not legacy Labs).
 *
 * Intentionally lighter than the legacy header: no Project Selector / Delete
 * affordances — those operate on the legacy epic→wave plan model. Labs3 is a
 * read-only visualization of the plan-spec-graph; the back-link returns to the
 * Apps/Plans hub.
 */
export function Labs3Header({ planId }: { planId: string }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '18px 0 22px',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <h1
          style={{
            fontSize: 17,
            fontWeight: 300,
            color: 'var(--foreground)',
            letterSpacing: '0.42em',
            textTransform: 'uppercase',
            margin: 0,
          }}
        >
          L A B S
        </h1>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            color: 'var(--accent-blue)',
            fontWeight: 500,
            letterSpacing: '0.1em',
            padding: '2px 7px',
            borderRadius: 4,
            border: '1px solid color-mix(in srgb, var(--accent-blue) 45%, transparent)',
            background: 'color-mix(in srgb, var(--accent-blue) 8%, transparent)',
          }}
        >
          3
        </span>
        <span style={{ width: 1, height: 14, background: 'var(--border-2)' }} />
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Plan Spec Graph
        </span>
      </div>

      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
        }}
      >
        <Link
          href={`/labs/?planId=${encodeURIComponent(planId)}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10,
            color: 'var(--text-mute)',
            textTransform: 'uppercase',
            letterSpacing: '0.14em',
            textDecoration: 'none',
            padding: '6px 10px',
            border: '1px solid var(--border-2)',
            borderRadius: 4,
          }}
        >
          Legacy view →
        </Link>
      </div>
    </header>
  );
}
