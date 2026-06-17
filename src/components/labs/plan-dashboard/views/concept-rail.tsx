'use client';

import { Fragment } from 'react';
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
}: {
  conceptPlan: ConceptPlan;
  /** Live per-artifact status; absent → static planned-chain view (back-compat). */
  conceptArtifacts?: ConceptArtifact[];
  /** Approve a draft artifact (advances the chain). Absent → no Approve buttons. */
  onApprove?: (kind: ConceptArtifactKind) => void;
  /** The kind whose Approve is in flight (disables the button). */
  approvingKind?: ConceptArtifactKind | null;
}) {
  const has = (k: ConceptArtifactKind) => conceptPlan.artifacts.some((a) => a.kind === k);
  const statusOf = (k: ConceptArtifactKind): ConceptArtifact | undefined =>
    conceptArtifacts.find((a) => a.kind === k);
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
              onApprove={onApprove}
              approving={!!n.artifactKind && approvingKind === n.artifactKind}
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

/** Map an artifact's (status, rev) to a human caption + tone for the node. */
function artifactPhase(a: ConceptArtifact | undefined): {
  caption: string;
  tone: string;
  awaiting: boolean;
} | null {
  if (!a) return null;
  if (a.status === 'approved') return { caption: '✓ approved', tone: 'success', awaiting: false };
  if (a.status === 'stale') return { caption: '↻ stale', tone: 'warning', awaiting: false };
  // draft
  if (a.rev > 0) return { caption: '⏸ awaiting approval', tone: 'accent-blue', awaiting: true };
  return { caption: '⋯ generating', tone: 'text-mute', awaiting: false };
}

function ConceptNode({
  node,
  artifact,
  onApprove,
  approving,
}: {
  node: ConceptNodeDef;
  artifact?: ConceptArtifact;
  onApprove?: (kind: ConceptArtifactKind) => void;
  approving?: boolean;
}) {
  const color = node.active ? 'var(--accent-purple)' : 'var(--border-2)';
  const phase = artifactPhase(artifact);
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
            textAlign: 'center',
          }}
        >
          {phase.caption}
        </div>
      )}
      {phase?.awaiting && onApprove && node.artifactKind && (
        <button
          type="button"
          data-testid={`concept-approve-${node.id}`}
          disabled={approving}
          onClick={() => onApprove(node.artifactKind!)}
          style={{
            marginTop: 6,
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--success)',
            background: 'color-mix(in srgb, var(--success) 10%, transparent)',
            border: '1px solid color-mix(in srgb, var(--success) 45%, transparent)',
            borderRadius: 4,
            padding: '2px 8px',
            cursor: approving ? 'default' : 'pointer',
            opacity: approving ? 0.5 : 1,
          }}
        >
          {approving ? 'Approving…' : 'Approve'}
        </button>
      )}
    </div>
  );
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
