/**
 * catalog.ts — visual catalog for the code-knowledge graph (Graph Viz v2).
 *
 * Adapted from the v0/claude references to OUR data model: node kinds are
 * file/function/class/dir plus null-kind knowledge docs (keyed by `type`:
 * decision/system/index/log/document); edge types are the 7 we actually emit
 * plus the wiki edges the compiler can write. Each kind carries a colour, base
 * radius, canvas shape, icon key, label, and a "layer" used by Layered Lanes.
 */

export type NodeShape = 'circle' | 'roundRect' | 'diamond' | 'hex' | 'doc';
export type LayoutMode = 'force' | 'lanes' | 'community';

export interface KindMeta {
  color: string;
  base: number;
  shape: NodeShape;
  icon: string;
  label: string;
  /** 1 = code, 2 = knowledge/docs (drives Layered Lanes). */
  layer: 1 | 2;
}

/** Keyed by node.kind, falling back to node.type for null-kind doc nodes. */
export const KIND_META: Record<string, KindMeta> = {
  // Layer 1 — code (AST + file). Bigger bases so icons read at overview zoom.
  file: { color: '#3b82f6', base: 8, shape: 'circle', icon: 'file', label: 'File', layer: 1 },
  function: {
    color: '#22d3ee',
    base: 5,
    shape: 'circle',
    icon: 'function',
    label: 'Function',
    layer: 1,
  },
  class: { color: '#a855f7', base: 7, shape: 'circle', icon: 'class', label: 'Class', layer: 1 },
  dir: { color: '#64748b', base: 7, shape: 'roundRect', icon: 'dir', label: 'Directory', layer: 1 },
  // Layer 2 — knowledge / docs (null-kind nodes, keyed by type)
  decision: {
    color: '#f0abfc',
    base: 8,
    shape: 'hex',
    icon: 'decision',
    label: 'Decision',
    layer: 2,
  },
  system: { color: '#f97316', base: 8, shape: 'hex', icon: 'system', label: 'System', layer: 2 },
  requirement: {
    color: '#22c55e',
    base: 8,
    shape: 'hex',
    icon: 'requirement',
    label: 'Requirement',
    layer: 2,
  },
  index: { color: '#34d399', base: 8, shape: 'doc', icon: 'document', label: 'Index', layer: 2 },
  log: { color: '#eab308', base: 7, shape: 'doc', icon: 'document', label: 'Log', layer: 2 },
  document: {
    color: '#eab308',
    base: 8,
    shape: 'doc',
    icon: 'document',
    label: 'Document',
    layer: 2,
  },
  unknown: { color: '#64748b', base: 6, shape: 'circle', icon: 'file', label: 'Node', layer: 1 },
};

/** Resolve a node's kind meta (prefer kind, fall back to type, then unknown). */
export function kindMeta(kind: string | null | undefined, type?: string | null): KindMeta {
  const key = kind || type || 'unknown';
  return KIND_META[key] ?? KIND_META.unknown;
}

export interface EdgeMeta {
  color: string;
  label: string;
  group: 'code' | 'wiki' | 'doc';
}

export const EDGE_META: Record<string, EdgeMeta> = {
  // code (AST / ts-morph)
  DEFINES: { color: '#0ea5e9', label: 'Defines', group: 'code' },
  IMPORTS: { color: '#ec4899', label: 'Imports', group: 'code' },
  CALLS: { color: '#f59e0b', label: 'Calls', group: 'code' },
  RENDERS: { color: '#8b5cf6', label: 'Renders', group: 'code' },
  CONTAINS: { color: '#475569', label: 'Contains', group: 'code' },
  // wiki / knowledge
  DEPENDS_ON: { color: '#94a3b8', label: 'Depends on', group: 'wiki' },
  DERIVED_FROM: { color: '#60a5fa', label: 'Derived from', group: 'wiki' },
  REFINES: { color: '#22d3ee', label: 'Refines', group: 'wiki' },
  VALIDATES: { color: '#34d399', label: 'Validates', group: 'wiki' },
  SUPERSEDES: { color: '#f87171', label: 'Supersedes', group: 'wiki' },
  CONFLICTS_WITH: { color: '#f43f5e', label: 'Conflicts with', group: 'wiki' },
  ENABLES: { color: '#facc15', label: 'Enables', group: 'wiki' },
  INFORMS: { color: '#a3a3a3', label: 'Informs', group: 'wiki' },
  // doc → code
  REFERENCES: { color: '#2dd4bf', label: 'References', group: 'doc' },
};

export function edgeMeta(type: string): EdgeMeta {
  return EDGE_META[type] ?? EDGE_META.DEPENDS_ON;
}

/** Stable, high-contrast community palette (Leiden community index → colour). */
const COMMUNITY_PALETTE = [
  '#60a5fa',
  '#34d399',
  '#f472b6',
  '#fbbf24',
  '#a78bfa',
  '#fb923c',
  '#22d3ee',
  '#facc15',
  '#f87171',
  '#4ade80',
  '#c084fc',
  '#2dd4bf',
  '#fca5a5',
  '#94a3b8',
];

export function communityColor(community: number): string {
  return COMMUNITY_PALETTE[
    ((community % COMMUNITY_PALETTE.length) + COMMUNITY_PALETTE.length) % COMMUNITY_PALETTE.length
  ];
}

/** Layered-Lanes columns. We only have two real layers (CODE, DOCS). */
export interface Lane {
  key: string;
  label: string;
  layer: 1 | 2;
}
export const LANES: Lane[] = [
  { key: 'docs', label: 'DOCS', layer: 2 },
  { key: 'code', label: 'CODE', layer: 1 },
];
export const LANE_GAP = 280;

/** X position for a node's lane (layer 2 / docs on the left, code on the right). */
export function laneX(layer: 1 | 2): number {
  return layer === 2 ? 0 : LANE_GAP;
}
