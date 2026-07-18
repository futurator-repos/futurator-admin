'use client';

/**
 * SpecGraphView — dependency DAG for a plan-spec-graph plan.
 *
 * Layout contract:
 *   x-axis = cohortBatch level (topological column, 0 = leftmost)
 *   y-axis = story row within each batch (stacked top-to-bottom)
 *
 * Rendering layers:
 *   1. SVG edge layer (dangerouslySetInnerHTML, pointer-events: none) —
 *      solid cubic-bezier paths for depends_on, lighter dashed for shared touches.
 *   2. React node cards (absolutely positioned divs) — interactive, show state
 *      fill/ring, StoryNodeStatePill, AC testBinding rollup badge.
 *   3. Detail panel below canvas — expands on node click.
 *
 * Mirrors git-graph-view's SVG technique: laneX/rowY math, M..C..L paths,
 * dangerouslySetInnerHTML for the edge string, idxByStoryId map for O(1) lookup.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { StoryNodeRow, StoryNodeState, TestBindingStatus } from '@/types/plan-spec';
import type { Labs3ViewProps } from '@/components/labs3/plan-spec-dashboard/adapter';
import { links3 } from '@/lib/links3';
import {
  STORY_NODE_STATE_META,
  ACTIVE_STORY_NODE_STATES,
  StoryNodeStatePill,
} from '@/components/labs3/shared/state-pill';

// ── Layout constants ──────────────────────────────────────────────────────────

/** Width of each node card. */
const NODE_W = 204;
/** Height of each node card. */
const NODE_H = 72;
const HALF_W = NODE_W / 2;
const HALF_H = NODE_H / 2;
/** Horizontal distance between batch column centres. */
const BATCH_STEP = 252;
/** Vertical distance between node centres in the same batch. */
const ROW_STEP = 92;
/** Canvas left/right padding. */
const PAD_X = 20;
/** Canvas top padding — room for batch-level header labels. */
const PAD_Y = 50;

// ── State-node colours (explicit rgba so they compose with any background) ───

const STATE_COLORS: Record<
  string,
  { fill: string; stroke: string; selectedFill: string; selectedRing: string }
> = {
  blocked: {
    fill: 'rgba(239,68,68,0.08)',
    stroke: 'rgba(239,68,68,0.36)',
    selectedFill: 'rgba(239,68,68,0.18)',
    selectedRing: '0 0 0 2px rgba(239,68,68,0.30)',
  },
  ready: {
    fill: 'rgba(34,197,94,0.08)',
    stroke: 'rgba(34,197,94,0.36)',
    selectedFill: 'rgba(34,197,94,0.18)',
    selectedRing: '0 0 0 2px rgba(34,197,94,0.30)',
  },
  claimed: {
    fill: 'rgba(120,147,184,0.09)',
    stroke: 'rgba(120,147,184,0.36)',
    selectedFill: 'rgba(120,147,184,0.20)',
    selectedRing: '0 0 0 2px rgba(120,147,184,0.28)',
  },
  developing: {
    fill: 'rgba(167,139,250,0.11)',
    stroke: 'rgba(167,139,250,0.44)',
    selectedFill: 'rgba(167,139,250,0.22)',
    selectedRing: '0 0 0 2px rgba(167,139,250,0.32)',
  },
  merging: {
    fill: 'rgba(6,182,212,0.09)',
    stroke: 'rgba(6,182,212,0.36)',
    selectedFill: 'rgba(6,182,212,0.20)',
    selectedRing: '0 0 0 2px rgba(6,182,212,0.28)',
  },
  verifying: {
    fill: 'rgba(209,165,79,0.09)',
    stroke: 'rgba(209,165,79,0.36)',
    selectedFill: 'rgba(209,165,79,0.20)',
    selectedRing: '0 0 0 2px rgba(209,165,79,0.28)',
  },
  done: {
    fill: 'rgba(34,197,94,0.07)',
    stroke: 'rgba(34,197,94,0.30)',
    selectedFill: 'rgba(34,197,94,0.16)',
    selectedRing: '0 0 0 2px rgba(34,197,94,0.24)',
  },
  failed: {
    fill: 'rgba(239,68,68,0.08)',
    stroke: 'rgba(239,68,68,0.36)',
    selectedFill: 'rgba(239,68,68,0.18)',
    selectedRing: '0 0 0 2px rgba(239,68,68,0.28)',
  },
};
const FALLBACK_COLORS = {
  fill: 'rgba(128,128,128,0.08)',
  stroke: 'rgba(128,128,128,0.33)',
  selectedFill: 'rgba(128,128,128,0.18)',
  selectedRing: '0 0 0 2px rgba(128,128,128,0.24)',
};

function stateColors(state: StoryNodeState) {
  return STATE_COLORS[state] ?? FALLBACK_COLORS;
}

// ── Phase (planner-emitted named phase; S1 cross-slice field) ─────────────────
//
// StoryNode.phase is added to the shared type by slice S1. We read it via a
// narrow cast so this consumer compiles whether or not S1 has landed yet, and
// stays defensive against legacy rows minted before phases existed (undefined /
// empty → treated as absent, header falls back to the anonymous "BATCH N").

function storyPhase(row: StoryNodeRow): string | undefined {
  const p = (row as StoryNodeRow & { phase?: unknown }).phase;
  return typeof p === 'string' && p.trim() ? p.trim() : undefined;
}

/** First non-empty phase carried by any story in a batch column (else absent). */
function batchPhase(stories: StoryNodeRow[]): string | undefined {
  for (const s of stories) {
    const p = storyPhase(s);
    if (p) return p;
  }
  return undefined;
}

/** Escape a phase name before it is spliced into the dangerouslySetInnerHTML SVG. */
function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── AC rollup ─────────────────────────────────────────────────────────────────

interface AcRollup {
  passing: number;
  failing: number;
  bound: number;
  unbound: number;
  total: number;
}

function rollupAC(acs: StoryNodeRow['acceptanceCriteria']): AcRollup {
  const r: AcRollup = { passing: 0, failing: 0, bound: 0, unbound: 0, total: acs.length };
  for (const ac of acs) {
    const s = ac.testBinding.status;
    if (s === 'passing') r.passing++;
    else if (s === 'failing') r.failing++;
    else if (s === 'bound') r.bound++;
    else r.unbound++;
  }
  return r;
}

// ── Layout ────────────────────────────────────────────────────────────────────

interface NodePos {
  cx: number;
  cy: number;
  row: StoryNodeRow;
}

interface LayoutResult {
  nodePos: Map<string, NodePos>;
  svgW: number;
  svgH: number;
  batches: { batchNum: number; colIdx: number; stories: StoryNodeRow[] }[];
}

function buildLayout(stories: StoryNodeRow[]): LayoutResult {
  const batchMap = new Map<number, StoryNodeRow[]>();
  for (const s of stories) {
    const b = s.cohortBatch ?? 0;
    if (!batchMap.has(b)) batchMap.set(b, []);
    batchMap.get(b)!.push(s);
  }
  const batches = [...batchMap.entries()]
    .sort(([a], [b]) => a - b)
    .map(([batchNum, ss], colIdx) => ({ batchNum, colIdx, stories: ss }));

  const nodePos = new Map<string, NodePos>();
  for (const { colIdx, stories: ss } of batches) {
    const cx = PAD_X + HALF_W + colIdx * BATCH_STEP;
    ss.forEach((s, rowIdx) => {
      const cy = PAD_Y + HALF_H + rowIdx * ROW_STEP;
      nodePos.set(s.storyId, { cx, cy, row: s });
    });
  }

  const maxRows = Math.max(0, ...batches.map((b) => b.stories.length));
  const svgW = Math.max(600, PAD_X * 2 + NODE_W + (batches.length - 1) * BATCH_STEP);
  const svgH = Math.max(180, PAD_Y + maxRows * ROW_STEP + PAD_X);

  return { nodePos, svgW, svgH, batches };
}

// ── Edge SVG builders ─────────────────────────────────────────────────────────

/** Solid cubic-bezier arrows for depends_on edges (left→right across batches). */
function buildDependsOnPaths(stories: StoryNodeRow[], nodePos: Map<string, NodePos>): string[] {
  const parts: string[] = [];
  for (const story of stories) {
    const to = nodePos.get(story.storyId);
    if (!to) continue;
    for (const depId of story.depends_on) {
      const from = nodePos.get(depId);
      if (!from) continue;
      // Source exits from right edge; target enters from left edge.
      const fx = from.cx + HALF_W;
      const fy = from.cy;
      const tx = to.cx - HALF_W;
      const ty = to.cy;
      const mx = (fx + tx) / 2;
      // Cubic bezier: control points keep horizontal tangents at both ends.
      const d = `M${fx} ${fy} C${mx} ${fy} ${mx} ${ty} ${tx} ${ty}`;
      parts.push(
        `<path d="${d}" stroke="#7893b8" stroke-width="1.5" fill="none" stroke-linecap="round" opacity="0.68"/>`,
      );
      // Small filled arrowhead at target entry point.
      parts.push(
        `<polygon points="${tx},${ty} ${tx - 7},${ty - 3.5} ${tx - 7},${ty + 3.5}" fill="#7893b8" opacity="0.68"/>`,
      );
    }
  }
  return parts;
}

/**
 * Dashed lighter edges for stories that share at least one glob in touches[].
 * Only drawn between stories in different batches (same-batch pairs are
 * already isolated by the frontier; drawing them would add visual noise).
 */
function buildTouchesOverlay(stories: StoryNodeRow[], nodePos: Map<string, NodePos>): string[] {
  const parts: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < stories.length; i++) {
    for (let j = i + 1; j < stories.length; j++) {
      const a = stories[i];
      const b = stories[j];
      if ((a.cohortBatch ?? 0) === (b.cohortBatch ?? 0)) continue;
      const shared = a.touches?.some((t) => b.touches?.includes(t)) ?? false;
      if (!shared) continue;
      const key = [a.storyId, b.storyId].sort().join('\x00');
      if (seen.has(key)) continue;
      seen.add(key);
      const posA = nodePos.get(a.storyId);
      const posB = nodePos.get(b.storyId);
      if (!posA || !posB) continue;
      const isALeft = posA.cx <= posB.cx;
      const fx = isALeft ? posA.cx + HALF_W : posA.cx - HALF_W;
      const fy = posA.cy;
      const tx = isALeft ? posB.cx - HALF_W : posB.cx + HALF_W;
      const ty = posB.cy;
      const mx = (fx + tx) / 2;
      const d = `M${fx} ${fy} C${mx} ${fy} ${mx} ${ty} ${tx} ${ty}`;
      parts.push(
        `<path d="${d}" stroke="#d1a54f" stroke-width="1" fill="none" stroke-dasharray="4 3" opacity="0.38"/>`,
      );
    }
  }
  return parts;
}

/**
 * Batch-level column header labels, rendered inside the SVG.
 * When the column's stories carry a planner-emitted `phase`, the header reads
 * "Batch N — <phase>"; legacy columns with no phase fall back to "BATCH N".
 */
function buildBatchLabels(
  batches: { batchNum: number; colIdx: number; stories: StoryNodeRow[] }[],
): string[] {
  return batches.map(({ batchNum, colIdx, stories }) => {
    const cx = PAD_X + HALF_W + colIdx * BATCH_STEP;
    const phase = batchPhase(stories);
    const label = phase ? `Batch ${batchNum} — ${escapeXml(phase)}` : `BATCH ${batchNum}`;
    return (
      `<text x="${cx}" y="20" text-anchor="middle" ` +
      `font-family="monospace" font-size="9.5" letter-spacing="1.5" ` +
      `fill="rgba(128,128,128,0.45)" style="text-transform:uppercase">` +
      label +
      `</text>` +
      // Vertical column rule
      `<line x1="${cx}" y1="30" x2="${cx}" y2="99999" ` +
      `stroke="rgba(128,128,128,0.08)" stroke-width="1" stroke-dasharray="2 4"/>`
    );
  });
}

// ── Sub-components ────────────────────────────────────────────────────────────

function AcBadge({ rollup }: { rollup: AcRollup }) {
  if (rollup.total === 0) return null;
  const hasFailing = rollup.failing > 0;
  const allPassing = rollup.total > 0 && rollup.passing === rollup.total;
  const color = hasFailing
    ? 'rgba(239,68,68,0.9)'
    : allPassing
      ? 'rgba(34,197,94,0.85)'
      : rollup.bound > 0
        ? 'rgba(120,147,184,0.85)'
        : 'rgba(128,128,128,0.55)';
  const bgColor = hasFailing
    ? 'rgba(239,68,68,0.13)'
    : allPassing
      ? 'rgba(34,197,94,0.12)'
      : rollup.bound > 0
        ? 'rgba(120,147,184,0.13)'
        : 'rgba(128,128,128,0.10)';
  const label = hasFailing
    ? `${rollup.failing} fail`
    : allPassing
      ? `${rollup.total} pass`
      : rollup.passing > 0
        ? `${rollup.passing}/${rollup.total}`
        : rollup.bound > 0
          ? `${rollup.bound} bound`
          : `${rollup.unbound} unbound`;
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        padding: '1px 5px',
        borderRadius: 8,
        background: bgColor,
        color,
        letterSpacing: '0.04em',
        fontWeight: 500,
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  );
}

function ActivePulse() {
  return (
    <span
      style={{
        width: 5,
        height: 5,
        borderRadius: '50%',
        background: 'currentColor',
        display: 'inline-block',
        flexShrink: 0,
      }}
      className="animate-pulse"
    />
  );
}

function NodeCard({
  pos,
  isSelected,
  onClick,
}: {
  pos: NodePos;
  isSelected: boolean;
  onClick: () => void;
}) {
  const { row } = pos;
  const colors = stateColors(row.state);
  const isActive = ACTIVE_STORY_NODE_STATES.has(row.state);
  const rollup = useMemo(() => rollupAC(row.acceptanceCriteria ?? []), [row.acceptanceCriteria]);

  return (
    <div
      role="button"
      tabIndex={0}
      data-story-node=""
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onClick();
        }
      }}
      style={{
        position: 'absolute',
        left: pos.cx - HALF_W,
        top: pos.cy - HALF_H,
        width: NODE_W,
        height: NODE_H,
        background: isSelected ? colors.selectedFill : colors.fill,
        border: `1.5px solid ${isSelected ? colors.stroke.replace('0.36', '0.72') : colors.stroke}`,
        borderRadius: 8,
        cursor: 'pointer',
        padding: '7px 9px',
        boxSizing: 'border-box',
        display: 'flex',
        flexDirection: 'column',
        gap: 5,
        boxShadow: isSelected ? colors.selectedRing : 'none',
        transition: 'box-shadow 130ms, background 130ms, border-color 130ms',
        overflow: 'hidden',
        userSelect: 'none',
      }}
    >
      {/* Row 1: state pill + active pulse + AC badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
        {isActive && (
          <span style={{ color: STORY_NODE_STATE_META[row.state]?.color ?? 'var(--text-mute)' }}>
            <ActivePulse />
          </span>
        )}
        <StoryNodeStatePill state={row.state} />
        <span style={{ flex: 1 }} />
        <AcBadge rollup={rollup} />
      </div>
      {/* Row 2: story title (2-line clamp) */}
      <div
        style={{
          fontSize: 11.5,
          fontWeight: 500,
          color: 'var(--foreground)',
          lineHeight: 1.35,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          flex: 1,
        }}
      >
        {row.title}
      </div>
    </div>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────

function TestBindingChip({ status }: { status: TestBindingStatus }) {
  const map: Record<TestBindingStatus, { label: string; bg: string; fg: string }> = {
    passing: { label: 'passing', bg: 'rgba(34,197,94,0.14)', fg: 'rgba(34,197,94,0.9)' },
    failing: { label: 'failing', bg: 'rgba(239,68,68,0.14)', fg: 'rgba(239,68,68,0.9)' },
    misbound: { label: 'misbound', bg: 'rgba(245,158,11,0.14)', fg: 'rgba(245,158,11,0.9)' },
    bound: { label: 'bound', bg: 'rgba(120,147,184,0.14)', fg: 'rgba(120,147,184,0.9)' },
    unbound: { label: 'unbound', bg: 'rgba(128,128,128,0.10)', fg: 'rgba(128,128,128,0.65)' },
  };
  const m = map[status] ?? {
    label: status,
    bg: 'rgba(128,128,128,0.10)',
    fg: 'rgba(128,128,128,0.65)',
  };
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        padding: '1px 5px',
        borderRadius: 6,
        background: m.bg,
        color: m.fg,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
    >
      {m.label}
    </span>
  );
}

function AcClassChip({
  acClass,
}: {
  acClass: StoryNodeRow['acceptanceCriteria'][number]['acClass'];
}) {
  const labels: Record<string, string> = {
    deterministic: 'DET',
    'advisory-taste': 'ADV',
    'advisory-security': 'SEC',
  };
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        padding: '1px 5px',
        borderRadius: 6,
        background: 'var(--bg-elev)',
        color: 'var(--text-faint)',
        letterSpacing: '0.05em',
        flexShrink: 0,
        border: '1px solid var(--border)',
      }}
    >
      {labels[acClass] ?? acClass.toUpperCase().slice(0, 3)}
    </span>
  );
}

function MonoBadge({ children }: { children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        padding: '1px 6px',
        borderRadius: 8,
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        color: 'var(--text-faint)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontFamily: 'var(--font-mono)',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--text-faint)',
        marginBottom: 5,
      }}
    >
      {children}
    </div>
  );
}

function DetailPanel({
  row,
  onClose,
  onOpenInStories,
  titleById,
  panelRef,
}: {
  row: StoryNodeRow;
  onClose: () => void;
  onOpenInStories: () => void;
  /** storyId → title, for resolving depends_on into human-readable titles. */
  titleById: Map<string, string>;
  panelRef: React.Ref<HTMLDivElement>;
}) {
  const acList = row.acceptanceCriteria ?? [];
  const deps = row.depends_on ?? [];
  const touches = row.touches ?? [];
  const phase = storyPhase(row);
  // Only surface verdict reasons when the story actually failed — a green story
  // may still carry a stale verdict from an earlier attempt (dossier A3).
  const reasons =
    (row.state === 'failed' || row.verdict?.done === false) && row.verdict?.reasons
      ? row.verdict.reasons.filter((r) => r && r.trim())
      : [];

  return (
    <div
      ref={panelRef}
      style={{
        background: 'var(--surface)',
        borderTop: '1px solid var(--border)',
        padding: '14px 16px',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* Header row */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              flexWrap: 'wrap',
              marginBottom: 8,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10.5,
                color: 'var(--text-faint)',
                letterSpacing: '0.04em',
              }}
            >
              {row.storyId.slice(0, 14)}…
            </span>
            <StoryNodeStatePill state={row.state} />
            {row.cohort?.epicTitle && <MonoBadge>{row.cohort.epicTitle}</MonoBadge>}
            <MonoBadge>batch {row.cohortBatch ?? 0}</MonoBadge>
            {row.complexity && <MonoBadge>{row.complexity}</MonoBadge>}
            {phase && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 10,
                  padding: '1px 6px',
                  borderRadius: 8,
                  background: 'rgba(167,139,250,0.13)',
                  color: 'rgba(167,139,250,0.9)',
                  border: '1px solid rgba(167,139,250,0.24)',
                  whiteSpace: 'nowrap',
                }}
                title="Planner phase"
              >
                {phase}
              </span>
            )}
          </div>

          {/* Title */}
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              lineHeight: 1.45,
              marginBottom: row.intent ? 6 : 10,
            }}
          >
            {row.title}
          </div>

          {/* Intent */}
          {row.intent && (
            <div
              style={{
                fontSize: 12.5,
                color: 'var(--text-dim)',
                lineHeight: 1.55,
                marginBottom: 10,
              }}
            >
              {row.intent}
            </div>
          )}

          {/* Acceptance Criteria */}
          {acList.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <SectionLabel>Acceptance Criteria ({acList.length})</SectionLabel>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                {acList.map((ac) => (
                  <div
                    key={ac.id}
                    style={{
                      display: 'flex',
                      alignItems: 'flex-start',
                      gap: 6,
                      fontSize: 12.5,
                      lineHeight: 1.45,
                    }}
                  >
                    <TestBindingChip status={ac.testBinding.status} />
                    <AcClassChip acClass={ac.acClass} />
                    <span style={{ color: 'var(--text-dim)', flex: 1, minWidth: 0 }}>
                      {ac.text}
                    </span>
                    {ac.testBinding.testRef && (
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 9.5,
                          color: 'var(--text-faint)',
                          flexShrink: 0,
                          maxWidth: 120,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={ac.testBinding.testRef}
                      >
                        {ac.testBinding.testRef}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Depends on + Touches */}
          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap' }}>
            {deps.length > 0 && (
              <div>
                <SectionLabel>Depends on ({deps.length})</SectionLabel>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {deps.map((d) => {
                    // Resolve to the dependency's title; fall back to a truncated
                    // id for cross-plan / not-yet-loaded deps.
                    const depTitle = titleById.get(d);
                    return (
                      <span
                        key={d}
                        title={depTitle ? `${depTitle}\n${d}` : d}
                        style={{
                          fontFamily: depTitle ? 'var(--font-sans)' : 'var(--font-mono)',
                          fontSize: 10.5,
                          padding: '2px 6px',
                          borderRadius: 8,
                          background: 'rgba(120,147,184,0.13)',
                          color: 'rgba(120,147,184,0.85)',
                          border: '1px solid rgba(120,147,184,0.24)',
                          maxWidth: 200,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {depTitle ?? `${d.slice(0, 12)}…`}
                      </span>
                    );
                  })}
                </div>
              </div>
            )}
            {touches.length > 0 && (
              <div>
                <SectionLabel>Touches ({touches.length})</SectionLabel>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {touches.slice(0, 6).map((t) => (
                    <span
                      key={t}
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        padding: '2px 6px',
                        borderRadius: 8,
                        background: 'rgba(209,165,79,0.11)',
                        color: 'rgba(209,165,79,0.85)',
                        border: '1px solid rgba(209,165,79,0.20)',
                      }}
                    >
                      {t}
                    </span>
                  ))}
                  {touches.length > 6 && (
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: 10,
                        color: 'var(--text-faint)',
                        padding: '2px 4px',
                      }}
                    >
                      +{touches.length - 6} more
                    </span>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Failure reasons — only when the story failed. A story can fail on
              unbound invariants while every visible AC is green (dossier A3), so
              this is the only place the operator sees WHY it went red. */}
          {reasons.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: '9px 11px',
                borderRadius: 8,
                background: 'rgba(239,68,68,0.08)',
                border: '1px solid rgba(239,68,68,0.24)',
              }}
            >
              <SectionLabel>Failure reasons ({reasons.length})</SectionLabel>
              <ul
                style={{
                  margin: 0,
                  paddingLeft: 16,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 3,
                }}
              >
                {reasons.map((r, i) => (
                  <li
                    key={i}
                    style={{
                      fontSize: 12,
                      lineHeight: 1.5,
                      color: 'rgba(239,68,68,0.92)',
                    }}
                  >
                    {r}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        {/* Actions: the ONLY remaining navigation path to the Stories tab, plus close */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
          <button
            type="button"
            onClick={onOpenInStories}
            style={{
              background: 'rgba(120,147,184,0.13)',
              border: '1px solid rgba(120,147,184,0.24)',
              color: 'rgba(120,147,184,0.95)',
              cursor: 'pointer',
              fontSize: 11.5,
              fontWeight: 500,
              lineHeight: 1,
              padding: '5px 9px',
              borderRadius: 7,
              whiteSpace: 'nowrap',
            }}
          >
            Open in Stories →
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close story detail"
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-mute)',
              cursor: 'pointer',
              fontSize: 18,
              lineHeight: 1,
              padding: '0 3px',
              marginTop: -2,
            }}
          >
            ×
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────────────

function GraphLegend({ storyCount }: { storyCount: number }) {
  const allStates = Object.keys(STORY_NODE_STATE_META) as StoryNodeState[];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        padding: '7px 14px',
        background: 'var(--surface)',
        borderBottom: '1px solid var(--border)',
        flexWrap: 'wrap',
        fontSize: 11,
        color: 'var(--text-mute)',
      }}
    >
      <span
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          letterSpacing: '0.07em',
          color: 'var(--text-faint)',
          textTransform: 'uppercase',
          flexShrink: 0,
        }}
      >
        {storyCount} {storyCount === 1 ? 'story' : 'stories'}
      </span>

      {/* Edge types */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        <svg width="30" height="10" aria-hidden="true">
          <path
            d="M0 5 C10 5 20 5 24 5"
            stroke="#7893b8"
            strokeWidth="1.5"
            fill="none"
            opacity="0.68"
          />
          <polygon points="24,5 18,2 18,8" fill="#7893b8" opacity="0.68" />
        </svg>
        <span>depends_on</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5, flexShrink: 0 }}>
        <svg width="28" height="10" aria-hidden="true">
          <path
            d="M0 5 L24 5"
            stroke="#d1a54f"
            strokeWidth="1"
            fill="none"
            strokeDasharray="4 3"
            opacity="0.45"
          />
        </svg>
        <span>shared touches</span>
      </div>

      <span style={{ flex: 1 }} />

      {/* State colour key */}
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {allStates.map((s) => {
          const m = STORY_NODE_STATE_META[s];
          return (
            <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <span
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: '50%',
                  background: m.color,
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              <span style={{ fontSize: 10.5, color: 'var(--text-mute)' }}>{m.label}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ── Planner narrative panel ─────────────────────────────────────────────────
//
// The quick-planspec planner emits a <PLAN_THINKING> narrative (CLASSIFICATION /
// PHASES+AXIS / QUALITY PATTERNS+RISKS / MODEL ASSIGNMENT) BEFORE the story DAG,
// persisted onto the Plan row (plan.planNarrative) by the daemon. Rendering it
// here on the "Plan" subtab is what makes the reasoning behind the graph legible
// — otherwise the one-shot generation call's thinking is lost. Collapsed by
// default so it never dominates the graph; the planShape badge stays visible in
// the header even while collapsed.

function PlanShapeBadge({ shape }: { shape: 'coherent' | 'sharded' }) {
  const coherent = shape === 'coherent';
  const color = coherent ? 'rgba(167,139,250,0.9)' : 'rgba(120,147,184,0.9)';
  const bg = coherent ? 'rgba(167,139,250,0.13)' : 'rgba(120,147,184,0.13)';
  return (
    <span
      style={{
        fontSize: 9,
        fontFamily: 'var(--font-mono)',
        padding: '1px 6px',
        borderRadius: 8,
        background: bg,
        color,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        flexShrink: 0,
      }}
      title={
        coherent
          ? 'Phased chain: foundation → capabilities → assemble'
          : 'Independent parallelizable stories'
      }
    >
      {shape}
    </span>
  );
}

/**
 * Exported (design I2/U4) so PlanningView (plan-stage subtab) can promote
 * this same narrative block front-and-center once stories are ingested,
 * instead of duplicating the collapsible-panel markup.
 */
export function PlannerNarrativePanel({
  narrative,
  shape,
}: {
  narrative?: string;
  shape?: 'coherent' | 'sharded';
}) {
  const [open, setOpen] = useState(false);
  if (!narrative) return null;

  return (
    <div
      style={{
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        marginBottom: 12,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '9px 14px',
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          color: 'var(--foreground)',
          textAlign: 'left',
        }}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            transform: open ? 'rotate(90deg)' : 'none',
            transition: 'transform 120ms',
            color: 'var(--text-mute)',
            fontSize: 10,
          }}
        >
          ▶
        </span>
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 10.5,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--text-faint)',
          }}
        >
          Planner narrative
        </span>
        {shape && <PlanShapeBadge shape={shape} />}
      </button>
      {open && (
        <pre
          style={{
            margin: 0,
            padding: '0 16px 14px',
            fontFamily: 'var(--font-mono)',
            fontSize: 11.5,
            lineHeight: 1.6,
            color: 'var(--text-dim)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            overflowX: 'auto',
          }}
        >
          {narrative}
        </pre>
      )}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────────────

/**
 * quick-p3-origin plans (`plan.mintJobId` present) are still being minted by
 * the quick-planspec daemon job — point the operator at the Planning tab,
 * which polls that job's live status, rather than the stale
 * `run-as-pipeline-3` instruction (that endpoint is the LEGACY plan→P3
 * conversion bridge; quick-p3 plans never call it). Legacy plans genuinely
 * awaiting that conversion keep a corrected hint naming the real trigger.
 */
function EmptyState({ planId, mintJobId }: { planId: string; mintJobId?: string | null }) {
  return (
    <div
      style={{
        padding: 48,
        textAlign: 'center',
        background: 'var(--bg-elev)',
        border: '1px solid var(--border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          fontSize: 14,
          fontWeight: 500,
          color: 'var(--foreground)',
          marginBottom: 8,
        }}
      >
        No stories ingested yet
      </div>
      <div style={{ fontSize: 12.5, color: 'var(--text-dim)', lineHeight: 1.6 }}>
        {mintJobId ? (
          <>
            The planner is still minting this plan.{' '}
            <Link
              href={links3.plan(planId, 'plan-stage')}
              style={{ color: 'var(--accent-blue, var(--foreground))' }}
            >
              Watch progress on the Planning tab →
            </Link>
          </>
        ) : (
          <>
            This legacy plan has no minted StoryNode graph yet. Use the{' '}
            <span style={{ fontWeight: 500 }}>Run as Pipeline-3</span> action on the plan row (Labs
            → plan list) to convert it and seed the dependency graph.
          </>
        )}
      </div>
    </div>
  );
}

// ── Top-level view ────────────────────────────────────────────────────────────

export function SpecGraphView({ planId, stories, plan, onSelectStory }: Labs3ViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const narrative = plan?.planNarrative;
  const shape = plan?.planShape;

  const layout = useMemo(() => buildLayout(stories), [stories]);

  /** storyId → title, so the detail panel can render depends_on as story titles. */
  const titleById = useMemo(() => new Map(stories.map((s) => [s.storyId, s.title])), [stories]);

  // Escape + click-outside close the in-place detail panel. Clicks on a node
  // card ([data-story-node]) are ignored here so the card's own toggle handler
  // owns node→node switching and same-node close.
  useEffect(() => {
    if (selectedId == null) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedId(null);
    }
    function onDown(e: MouseEvent) {
      const t = e.target as HTMLElement | null;
      if (!t) return;
      if (panelRef.current?.contains(t)) return;
      if (t.closest('[data-story-node]')) return;
      setSelectedId(null);
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [selectedId]);

  /**
   * Build the complete SVG inner HTML string: column rules, batch labels,
   * touches overlay (dashed), then depends_on paths (solid, on top).
   * Order matters: touches behind depends_on so arrows read clearly.
   */
  const edgeHtml = useMemo(() => {
    const headers = buildBatchLabels(layout.batches);
    const touches = buildTouchesOverlay(stories, layout.nodePos);
    const deps = buildDependsOnPaths(stories, layout.nodePos);
    return [...headers, ...touches, ...deps].join('');
  }, [stories, layout]);

  const selectedRow = selectedId != null ? (layout.nodePos.get(selectedId)?.row ?? null) : null;

  // Clicking a node opens the in-place detail panel — it NO LONGER navigates
  // away (dossier B4). The panel's "Open in Stories →" button is the sole
  // remaining path that invokes onSelectStory.
  function handleSelect(storyId: string) {
    setSelectedId((prev) => (prev === storyId ? null : storyId));
  }

  if (stories.length === 0)
    return (
      <>
        <PlannerNarrativePanel narrative={narrative} shape={shape} />
        <EmptyState planId={planId} mintJobId={plan?.mintJobId} />
      </>
    );

  return (
    <>
      <PlannerNarrativePanel narrative={narrative} shape={shape} />
      <div
        style={{
          background: 'var(--bg-elev)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
          fontFamily: 'var(--font-sans)',
          color: 'var(--foreground)',
        }}
      >
        <GraphLegend storyCount={stories.length} />

        {/* Scrollable canvas */}
        <div
          style={{
            overflowX: 'auto',
            overflowY: 'auto',
            maxHeight: 520,
            position: 'relative',
          }}
        >
          <div
            style={{
              position: 'relative',
              width: layout.svgW,
              height: layout.svgH,
            }}
          >
            {/* Layer 1 — edge SVG (pointer-events: none so clicks fall through to cards) */}
            <svg
              width={layout.svgW}
              height={layout.svgH}
              style={{ position: 'absolute', top: 0, left: 0, pointerEvents: 'none' }}
              aria-hidden="true"
              dangerouslySetInnerHTML={{ __html: edgeHtml }}
            />

            {/* Layer 2 — node cards */}
            {[...layout.nodePos.values()].map((pos) => (
              <NodeCard
                key={pos.row.storyId}
                pos={pos}
                isSelected={selectedId === pos.row.storyId}
                onClick={() => handleSelect(pos.row.storyId)}
              />
            ))}
          </div>
        </div>

        {/* Detail panel (below canvas) — in-place, does not navigate away */}
        {selectedRow != null && (
          <DetailPanel
            row={selectedRow}
            onClose={() => setSelectedId(null)}
            onOpenInStories={() => onSelectStory?.(selectedRow.storyId)}
            titleById={titleById}
            panelRef={panelRef}
          />
        )}
      </div>
    </>
  );
}
