'use client';

import { Fragment, type CSSProperties } from 'react';
import type { ConceptPlan, ConceptArtifactKind, ConceptArtifact } from '@/types/plan';

/**
 * Concept v2 (E12.4, §12) — the Concept pipeline rail.
 *
 * Renders the Concept Router's `conceptPlan` DAG so the operator can SEE and
 * verify the `route → prd → (ux) → arch → plan → gate` chain. Nodes the Router
 * didn't activate (e.g. UX on a CLI; gate on a noop rigor) are greyed with a
 * "skipped" caption. The Router's rationale is shown inline (auditable).
 *
 * Live per-node status (drafting/approved) lands once the conceptArtifacts
 * pointers + job-status are persisted; today this renders the PLANNED chain —
 * the "check the chain" view the operator asked for.
 */

interface ConceptNodeDef {
  id: string;
  label: string;
  persona: string;
  icon: string;
  active: boolean;
  /** Concept artifact kind this node maps to (prd/ux/architecture), if any. */
  artifactKind?: ConceptArtifactKind;
}

export function ConceptRail({
  conceptPlan,
  conceptArtifacts = [],
  onApprove,
  approvingKind,
  onRegenerate,
  regeneratingKind,
}: {
  conceptPlan: ConceptPlan;
  /** Live per-artifact status; absent → static planned-chain view (back-compat). */
  conceptArtifacts?: ConceptArtifact[];
  /** Approve a draft artifact (advances the chain). Absent → no Approve buttons. */
  onApprove?: (kind: ConceptArtifactKind) => void;
  /** The kind whose Approve is in flight (disables the button). */
  approvingKind?: ConceptArtifactKind | null;
  /** Regenerate a drafted/stale artifact. Absent → no Regenerate buttons. */
  onRegenerate?: (kind: ConceptArtifactKind) => void;
  /** The kind whose Regenerate is in flight. */
  regeneratingKind?: ConceptArtifactKind | null;
}) {
  const has = (k: ConceptArtifactKind) => conceptPlan.artifacts.some((a) => a.kind === k);
  const statusOf = (k: ConceptArtifactKind): ConceptArtifact | undefined =>
    conceptArtifacts.find((a) => a.kind === k);
  // Live whole-chain progress caption for the header (replaces the silence).
  const activeKinds = conceptPlan.artifacts.map((a) => a.kind);
  const approvedCount = conceptArtifacts.filter(
    (a) => a.status === 'approved' && activeKinds.includes(a.kind),
  ).length;
  // The chain is SERIAL: exactly one artifact is "active" at a time — the first
  // non-approved one in topological order. Earlier ones are approved; later ones
  // are queued (rev0, waiting their turn — NOT generating). The active one is
  // either generating (rev0) or awaiting approval (rev>0).
  const firstPendingKind = conceptPlan.artifacts.find((p) => {
    const r = statusOf(p.kind);
    return !r || r.status !== 'approved';
  })?.kind;
  const fpArtifact = firstPendingKind ? statusOf(firstPendingKind) : undefined;
  const generatingKind =
    fpArtifact && fpArtifact.status === 'draft' && fpArtifact.rev === 0
      ? firstPendingKind
      : undefined;
  const awaitingKind =
    fpArtifact && fpArtifact.status === 'draft' && fpArtifact.rev > 0
      ? firstPendingKind
      : undefined;
  const nodes: ConceptNodeDef[] = [
    { id: 'route', label: 'Route', persona: 'Mary', icon: '📊', active: true },
    {
      id: 'prd',
      label: 'PRD',
      persona: 'John',
      icon: '📋',
      active: has('prd'),
      artifactKind: 'prd',
    },
    { id: 'ux', label: 'UX', persona: 'Sally', icon: '🎨', active: has('ux'), artifactKind: 'ux' },
    {
      id: 'architecture',
      label: 'Architecture',
      persona: 'Winston',
      icon: '🏗️',
      active: has('architecture'),
      artifactKind: 'architecture',
    },
    { id: 'plan', label: 'Plan', persona: 'epics → waves', icon: '📐', active: true },
    {
      id: 'gate',
      label: 'Gate',
      persona: 'Murat',
      icon: '🧪',
      active: conceptPlan.gate !== 'noop',
    },
  ];

  // Live one-line progress headline (so the chain never looks silent).
  const total = activeKinds.length;
  const headline = generatingKind
    ? `Drafting ${generatingKind.toUpperCase()}…`
    : awaitingKind
      ? `${awaitingKind.toUpperCase()} ready for your review`
      : approvedCount >= total && total > 0
        ? 'All specs approved — drafting the epic plan…'
        : 'Routing…';

  return (
    <div
      data-testid="concept-rail"
      style={{
        padding: '16px 20px',
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--bg-elev)',
        marginBottom: 16,
      }}
    >
      <style>{SPINNER_KEYFRAMES}</style>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            color: 'var(--text-faint)',
            textTransform: 'uppercase',
            letterSpacing: '0.22em',
          }}
        >
          Concept chain
        </span>
        {total > 0 && (
          <span
            data-testid="concept-headline"
            style={{
              fontSize: 11,
              color: 'var(--text-dim)',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            {generatingKind && <Spinner />}
            {headline}
            <span style={{ color: 'var(--text-faint)' }}>
              ({approvedCount}/{total} approved)
            </span>
          </span>
        )}
        <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        <ConceptChip label={conceptPlan.uiBearing ? 'UI-bearing' : 'non-UI'} tone="accent-blue" />
        <ConceptChip label={`complexity: ${conceptPlan.complexity}`} tone="text-mute" />
        <ConceptChip label={`gate: ${conceptPlan.gate}`} tone="warning" />
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 0 }}>
        {nodes.map((n, i) => (
          <Fragment key={n.id}>
            <ConceptNode
              node={n}
              artifact={n.artifactKind ? statusOf(n.artifactKind) : undefined}
              activeGen={!!n.artifactKind && n.artifactKind === generatingKind}
              onApprove={onApprove}
              approving={!!n.artifactKind && approvingKind === n.artifactKind}
              onRegenerate={onRegenerate}
              regenerating={!!n.artifactKind && regeneratingKind === n.artifactKind}
            />
            {i < nodes.length - 1 && <ConceptConnector lit={nodes[i + 1].active} />}
          </Fragment>
        ))}
      </div>

      <div
        style={{
          marginTop: 12,
          fontSize: 12,
          color: 'var(--text-dim)',
          fontStyle: 'italic',
          borderTop: '1px solid var(--border)',
          paddingTop: 10,
        }}
      >
        {conceptPlan.rationale}
      </div>
    </div>
  );
}

const SPINNER_KEYFRAMES = `@keyframes concept-spin { to { transform: rotate(360deg); } }`;

/** A small CSS-only spinner (no deps). */
function Spinner({ size = 11 }: { size?: number }) {
  return (
    <span
      aria-label="working"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: '2px solid color-mix(in srgb, var(--accent-purple) 30%, transparent)',
        borderTopColor: 'var(--accent-purple)',
        borderRadius: '50%',
        animation: 'concept-spin 0.7s linear infinite',
        flex: '0 0 auto',
      }}
    />
  );
}

interface NodePhase {
  caption: string;
  tone: string;
  awaiting: boolean;
  generating: boolean;
  queued: boolean;
  stale: boolean;
}

/**
 * Map an artifact's (status, rev) + whether it's the actively-generating one to
 * a node phase. A rev0 draft that is NOT the active one is QUEUED (waiting its
 * serial turn), not generating — only the active artifact spins.
 */
function artifactPhase(a: ConceptArtifact | undefined, activeGen: boolean): NodePhase | null {
  if (!a) return null;
  const base = { awaiting: false, generating: false, queued: false, stale: false };
  if (a.status === 'approved') return { ...base, caption: 'approved', tone: 'success' };
  if (a.status === 'stale')
    return { ...base, caption: 'stale — regenerate', tone: 'warning', stale: true };
  if (a.rev > 0)
    return { ...base, caption: 'awaiting approval', tone: 'accent-blue', awaiting: true };
  if (activeGen) return { ...base, caption: 'generating', tone: 'text-mute', generating: true };
  return { ...base, caption: 'queued', tone: 'text-faint', queued: true };
}

function ConceptNode({
  node,
  artifact,
  activeGen,
  onApprove,
  approving,
  onRegenerate,
  regenerating,
}: {
  node: ConceptNodeDef;
  artifact?: ConceptArtifact;
  activeGen?: boolean;
  onApprove?: (kind: ConceptArtifactKind) => void;
  approving?: boolean;
  onRegenerate?: (kind: ConceptArtifactKind) => void;
  regenerating?: boolean;
}) {
  const color = node.active ? 'var(--accent-purple)' : 'var(--border-2)';
  const phase = artifactPhase(artifact, !!activeGen);
  return (
    <div
      data-testid={`concept-node-${node.id}`}
      data-active={node.active}
      data-artifact-status={artifact?.status}
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        minWidth: 0,
        opacity: node.active ? 1 : 0.45,
        padding: '0 4px',
      }}
    >
      <div
        style={{
          width: 30,
          height: 30,
          borderRadius: '50%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 15,
          background: node.active ? `color-mix(in srgb, ${color} 12%, transparent)` : 'transparent',
          border: `1px solid ${node.active ? color : 'var(--border)'}`,
        }}
      >
        {node.icon}
      </div>
      <div
        style={{
          fontSize: 12,
          fontWeight: 500,
          color: node.active ? 'var(--foreground)' : 'var(--text-faint)',
          marginTop: 8,
          textAlign: 'center',
        }}
      >
        {node.label}
      </div>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          color: 'var(--text-faint)',
          marginTop: 2,
          letterSpacing: '0.05em',
          textAlign: 'center',
        }}
      >
        {node.active ? node.persona : 'skipped'}
      </div>
      {phase && (
        <div
          data-testid={`concept-status-${node.id}`}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 9,
            fontWeight: 600,
            color: `var(--${phase.tone})`,
            marginTop: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 4,
          }}
        >
          {phase.generating && <Spinner size={9} />}
          {phase.awaiting && '⏸ '}
          {phase.stale && '↻ '}
          {!phase.generating && phase.tone === 'success' && '✓ '}
          {phase.caption}
        </div>
      )}
      {phase?.awaiting && onApprove && node.artifactKind && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
          <button
            type="button"
            data-testid={`concept-approve-${node.id}`}
            disabled={approving}
            onClick={() => onApprove(node.artifactKind!)}
            style={pillStyle('success', approving)}
          >
            {approving ? 'Approving…' : 'Approve'}
          </button>
          {onRegenerate && (
            <button
              type="button"
              data-testid={`concept-regen-${node.id}`}
              disabled={regenerating}
              onClick={() => onRegenerate(node.artifactKind!)}
              title="Regenerate this document"
              style={pillStyle('text-mute', regenerating)}
            >
              {regenerating ? '↻…' : '↻'}
            </button>
          )}
        </div>
      )}
      {phase?.stale && onRegenerate && node.artifactKind && (
        <button
          type="button"
          data-testid={`concept-regen-${node.id}`}
          disabled={regenerating}
          onClick={() => onRegenerate(node.artifactKind!)}
          style={{ ...pillStyle('warning', regenerating), marginTop: 6 }}
        >
          {regenerating ? 'Regenerating…' : 'Regenerate'}
        </button>
      )}
    </div>
  );
}

/** Shared pill-button style keyed on a theme tone. */
function pillStyle(tone: string, busy?: boolean): CSSProperties {
  return {
    fontSize: 10,
    fontWeight: 600,
    color: `var(--${tone})`,
    background: `color-mix(in srgb, var(--${tone}) 10%, transparent)`,
    border: `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
    borderRadius: 4,
    padding: '2px 8px',
    cursor: busy ? 'default' : 'pointer',
    opacity: busy ? 0.5 : 1,
  };
}

function ConceptConnector({ lit }: { lit: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        flex: '0 0 24px',
        height: 1,
        marginTop: 15,
        background: lit ? 'var(--accent-purple)' : 'var(--border)',
        opacity: lit ? 0.5 : 1,
      }}
    />
  );
}

function ConceptChip({ label, tone }: { label: string; tone: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 9,
        fontWeight: 600,
        color: `var(--${tone})`,
        border: `1px solid color-mix(in srgb, var(--${tone}) 45%, transparent)`,
        background: `color-mix(in srgb, var(--${tone}) 9%, transparent)`,
        borderRadius: 3,
        padding: '2px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
