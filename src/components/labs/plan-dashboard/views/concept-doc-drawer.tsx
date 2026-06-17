'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Loader2, X } from 'lucide-react';
import { useConceptDocument } from '@/hooks/use-concept-artifacts';
import type { ConceptArtifactKind } from '@/types/plan';

const PERSONA: Record<
  ConceptArtifactKind,
  { name: string; role: string; icon: string; doc: string }
> = {
  prd: { name: 'John', role: 'Product Manager', icon: '📋', doc: 'prd.md' },
  ux: { name: 'Sally', role: 'UX Expert', icon: '🎨', doc: 'ux-spec.md' },
  architecture: { name: 'Winston', role: 'Architect', icon: '🏗️', doc: 'architecture.md' },
};

/**
 * Concept v2 — right-side slide-over that renders a generated spec
 * (PRD / UX / Architecture) so the operator can READ it before approving.
 * Mirrors the debates file-drawer pattern: fixed overlay, click-outside to
 * close. Approve / Regenerate are available inline so review → decision is one
 * surface.
 */
export function ConceptDocDrawer({
  planId,
  kind,
  onClose,
  onApprove,
  onRegenerate,
  approving,
  regenerating,
}: {
  planId: string;
  kind: ConceptArtifactKind;
  onClose: () => void;
  onApprove: (kind: ConceptArtifactKind) => void;
  onRegenerate: (kind: ConceptArtifactKind) => void;
  approving?: boolean;
  regenerating?: boolean;
}) {
  const persona = PERSONA[kind];
  const { data, isLoading, isError, refetch } = useConceptDocument(planId, kind, {
    stillGenerating: false,
  });
  const md = data?.markdown ?? null;
  const status = data?.status ?? null;
  const canApprove = (data?.rev ?? 0) >= 1 && status !== 'approved';

  return (
    <>
      {/* Click-outside scrim */}
      <div
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', zIndex: 50 }}
        aria-hidden
      />
      <aside
        role="dialog"
        aria-label={`${persona.doc} document`}
        data-testid="concept-doc-drawer"
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          bottom: 0,
          width: 'min(720px, 92vw)',
          background: 'var(--background)',
          borderLeft: '1px solid var(--border)',
          zIndex: 51,
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-8px 0 32px rgba(0,0,0,0.18)',
        }}
      >
        {/* Header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <span style={{ fontSize: 18 }}>{persona.icon}</span>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {persona.doc}
              {status && (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: 10,
                    fontWeight: 600,
                    fontFamily: 'var(--font-mono)',
                    color: status === 'approved' ? 'var(--success)' : 'var(--accent-blue)',
                  }}
                >
                  {status === 'approved' ? '✓ APPROVED' : status === 'stale' ? '↻ STALE' : 'DRAFT'}
                </span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-mute)' }}>
              by {persona.name} · {persona.role}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              color: 'var(--text-mute)',
              display: 'flex',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflow: 'auto', padding: '20px 24px' }}>
          {isLoading && (
            <div
              style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--text-mute)' }}
            >
              <Loader2 size={14} className="animate-spin" /> Loading {persona.doc}…
            </div>
          )}
          {isError && (
            <div style={{ color: 'var(--danger)' }}>
              Couldn’t load the document.{' '}
              <button
                type="button"
                onClick={() => refetch()}
                style={{
                  textDecoration: 'underline',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: 'inherit',
                }}
              >
                Retry
              </button>
            </div>
          )}
          {!isLoading && !isError && !md && (
            <div style={{ color: 'var(--text-mute)' }}>
              {persona.name} hasn’t finished drafting {persona.doc} yet — it’ll appear here once the
              draft lands.
            </div>
          )}
          {md && (
            <div className="concept-doc-prose" style={{ fontSize: 14, lineHeight: 1.65 }}>
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{md}</ReactMarkdown>
            </div>
          )}
        </div>

        {/* Footer actions */}
        <div
          style={{
            display: 'flex',
            gap: 10,
            padding: '12px 20px',
            borderTop: '1px solid var(--border)',
            background: 'var(--bg-elev)',
          }}
        >
          <button
            type="button"
            data-testid="drawer-approve"
            disabled={!canApprove || approving}
            onClick={() => onApprove(kind)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: canApprove ? 'var(--success)' : 'var(--text-faint)',
              background: canApprove
                ? 'color-mix(in srgb, var(--success) 12%, transparent)'
                : 'transparent',
              border: `1px solid ${canApprove ? 'color-mix(in srgb, var(--success) 45%, transparent)' : 'var(--border)'}`,
              borderRadius: 6,
              padding: '6px 16px',
              cursor: canApprove && !approving ? 'pointer' : 'default',
              opacity: approving ? 0.5 : 1,
            }}
          >
            {approving ? 'Approving…' : status === 'approved' ? '✓ Approved' : 'Approve'}
          </button>
          <button
            type="button"
            data-testid="drawer-regenerate"
            disabled={regenerating}
            onClick={() => onRegenerate(kind)}
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--text-mute)',
              background: 'transparent',
              border: '1px solid var(--border)',
              borderRadius: 6,
              padding: '6px 16px',
              cursor: regenerating ? 'default' : 'pointer',
              opacity: regenerating ? 0.5 : 1,
            }}
          >
            {regenerating ? 'Regenerating…' : '↻ Regenerate'}
          </button>
          <button
            type="button"
            onClick={onClose}
            style={{
              marginLeft: 'auto',
              fontSize: 13,
              color: 'var(--text-mute)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            Close
          </button>
        </div>
      </aside>
    </>
  );
}
