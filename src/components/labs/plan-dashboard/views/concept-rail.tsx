'use client';

import { Fragment } from 'react';
import type { ConceptPlan, ConceptArtifactKind } from '@/types/plan';

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
}

export function ConceptRail({ conceptPlan }: { conceptPlan: ConceptPlan }) {
  const has = (k: ConceptArtifactKind) => conceptPlan.artifacts.some((a) => a.kind === k);
  const nodes: ConceptNodeDef[] = [
    { id: 'route', label: 'Route', persona: 'Mary', icon: '📊', active: true },
    { id: 'prd', label: 'PRD', persona: 'John', icon: '📋', active: has('prd') },
    { id: 'ux', label: 'UX', persona: 'Sally', icon: '🎨', active: has('ux') },
    {
      id: 'architecture',
      label: 'Architecture',
      persona: 'Winston',
      icon: '🏗️',
      active: has('architecture'),
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
            <ConceptNode node={n} />
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

function ConceptNode({ node }: { node: ConceptNodeDef }) {
  const color = node.active ? 'var(--accent-purple)' : 'var(--border-2)';
  return (
    <div
      data-testid={`concept-node-${node.id}`}
      data-active={node.active}
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
