'use client';

import { useState } from 'react';
import Link from 'next/link';
import { Trash2 } from 'lucide-react';
import { DeleteLabs3AppDialog } from './delete-app-dialog';

/**
 * Labs3 header — the SDD sibling of legacy LabsHeader. Sits inside AppShell's
 * <main>. Carries the "L A B S · 3" wordmark and a "Plan Spec Graph" tag so the
 * operator always knows they're on the pipeline-3 surface (not legacy Labs).
 *
 * Carries a "Remove app" affordance (parity with legacy Labs) that fires the
 * full `DELETE /api/apps/:appId` teardown — only rendered once we've resolved
 * the plan's appId. The back-link returns to the Apps/Plans hub.
 */
export function Labs3Header({
  planId,
  appId,
  appLabel,
}: {
  planId: string;
  appId?: string | null;
  appLabel?: string;
}) {
  const [deleteOpen, setDeleteOpen] = useState(false);
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
        {appId && (
          <button
            type="button"
            onClick={() => setDeleteOpen(true)}
            title="Remove this app — deletes the GitHub repo, plans/stories, EC2 worktrees, deployed + dev builds, and QA screenshots"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              color: 'var(--destructive, #ef4444)',
              textTransform: 'uppercase',
              letterSpacing: '0.14em',
              background: 'none',
              cursor: 'pointer',
              padding: '6px 10px',
              border: '1px solid color-mix(in srgb, var(--destructive, #ef4444) 45%, transparent)',
              borderRadius: 4,
            }}
          >
            <Trash2 size={12} /> Remove
          </button>
        )}
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

      {appId && (
        <DeleteLabs3AppDialog
          appId={appId}
          appLabel={appLabel}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
        />
      )}
    </header>
  );
}
