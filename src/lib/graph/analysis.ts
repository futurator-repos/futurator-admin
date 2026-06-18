/**
 * analysis.ts — derived structures for the graph canvas + panels.
 */

export interface XY {
  x?: number;
  y?: number;
}

/** Per-community blob: centroid + radius enclosing its members (drives zones). */
export interface CommunityHull {
  community: number;
  cx: number;
  cy: number;
  r: number;
  count: number;
}

/**
 * Compute one translucent-zone blob per community from the LIVE node positions
 * (centroid + max member distance). Skips communities with < 3 visible members
 * (a blob around 1–2 nodes is noise). Ported from claude-graph's `_drawHulls`.
 */
export function computeCommunityHulls<T extends XY>(
  nodes: T[],
  communityOf: (n: T) => number | null | undefined,
): CommunityHull[] {
  const groups = new Map<number, T[]>();
  for (const n of nodes) {
    const c = communityOf(n);
    if (c == null || n.x == null || n.y == null) continue;
    (groups.get(c) ?? groups.set(c, []).get(c)!).push(n);
  }
  const hulls: CommunityHull[] = [];
  for (const [community, members] of groups) {
    if (members.length < 3) continue;
    let cx = 0;
    let cy = 0;
    for (const m of members) {
      cx += m.x!;
      cy += m.y!;
    }
    cx /= members.length;
    cy /= members.length;
    // 80th-percentile distance (NOT max) so one far-flung member doesn't balloon
    // the blob into a giant flat circle that forces the fit-zoom way out.
    const dists = members.map((m) => Math.hypot(m.x! - cx, m.y! - cy)).sort((a, b) => a - b);
    const p80 = dists[Math.min(dists.length - 1, Math.floor(dists.length * 0.8))];
    hulls.push({ community, cx, cy, r: p80 + 16, count: members.length });
  }
  return hulls;
}

export interface AdjEntry {
  to: string;
  type: string;
  dir: 'out' | 'in';
}

/** Bidirectional adjacency index — for relationships-by-type + future blast. */
export function buildAdjacency(
  edges: { source: string; target: string; type: string }[],
  endpointId: (v: unknown) => string,
): Map<string, AdjEntry[]> {
  const adj = new Map<string, AdjEntry[]>();
  const push = (from: string, e: AdjEntry) => {
    const list = adj.get(from);
    if (list) list.push(e);
    else adj.set(from, [e]);
  };
  for (const e of edges) {
    const s = endpointId(e.source);
    const t = endpointId(e.target);
    push(s, { to: t, type: e.type, dir: 'out' });
    push(t, { to: s, type: e.type, dir: 'in' });
  }
  return adj;
}
