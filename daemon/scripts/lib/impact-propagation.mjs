/**
 * Impact Propagation Engine — MY-3.5
 *
 * Traverses the knowledge graph from an updated node, calculates impact scores
 * for downstream nodes, and flags those exceeding thresholds.
 *
 * Formula: impact_score = edge_weight / (hops ^ 1.5)
 *
 * Thresholds:
 *   >= 0.5  ->  critical (immediate review needed)
 *   >= 0.1  ->  moderate (review when convenient)
 *   <  0.1  ->  no flag
 *
 * Updates both the GraphStore (S1.4 — session/driver→store swap; Memgraph/bolt
 * EXCISED, see `lib/graph-store.mjs`) and wiki article frontmatter on disk.
 *
 * Usage:
 *   import { propagateImpact, EDGE_WEIGHTS } from './lib/impact-propagation.mjs';
 *   const summary = await propagateImpact('code/src--auth.tsx', store, { knowledgeDir, projectId });
 *
 * [Source: docs/concepts/mycelium-labs-architecture.md#6.2-Impact-Propagation]
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import { join } from 'path';

// ── Edge Weights Configuration ──
// Exported so external consumers can adjust without code changes.

export const EDGE_WEIGHTS = {
  DEPENDS_ON:     1.0,
  CONFLICTS_WITH: 0.9,
  SUPERSEDES:     0.8,
  DERIVED_FROM:   0.7,
  VALIDATES:      0.6,
  REFINES:        0.5,
  ENABLES:        0.5,
  INFORMS:        0.3,
};

// ── Flagging Thresholds ──

const CRITICAL_THRESHOLD = 0.5;
const MODERATE_THRESHOLD = 0.1;

// ── Impact Score Calculation ──

/**
 * Calculates the impact score for a downstream node.
 *
 * @param {number} edgeWeight - Weight of the first edge in the traversal path
 * @param {number} hops       - Number of hops from the source node
 * @returns {number} Impact score
 */
export function calculateImpactScore(edgeWeight, hops) {
  if (hops <= 0) return edgeWeight;
  return edgeWeight / Math.pow(hops, 1.5);
}

/**
 * Determines the severity level for a given impact score.
 *
 * @param {number} score - Impact score
 * @returns {'critical' | 'moderate' | null} Severity or null if below threshold
 */
export function getSeverity(score) {
  if (score >= CRITICAL_THRESHOLD) return 'critical';
  if (score >= MODERATE_THRESHOLD) return 'moderate';
  return null;
}

// ── Frontmatter Update ──

/**
 * Updates frontmatter fields in a wiki article markdown file.
 *
 * @param {string} filePath - Absolute path to the .md file
 * @param {object} updates  - Key-value pairs to set in frontmatter
 * @returns {boolean} True if file was updated
 */
function updateArticleFrontmatter(filePath, updates) {
  if (!existsSync(filePath)) return false;

  let content = readFileSync(filePath, 'utf-8');
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return false;

  let frontmatter = fmMatch[1];
  for (const [key, value] of Object.entries(updates)) {
    const regex = new RegExp(`^${key}:.*$`, 'm');
    const formattedValue = typeof value === 'string' && value.includes(' ')
      ? `"${value}"`
      : value;
    if (regex.test(frontmatter)) {
      frontmatter = frontmatter.replace(regex, `${key}: ${formattedValue}`);
    } else {
      frontmatter += `\n${key}: ${formattedValue}`;
    }
  }

  content = content.replace(/^---\n[\s\S]*?\n---/, `---\n${frontmatter}\n---`);
  writeFileSync(filePath, content);
  return true;
}

// ── Core: Impact Propagation ──

/**
 * Propagates impact from an updated node through the knowledge graph.
 *
 * Traverses up to 4 hops following all edge types, calculates impact scores,
 * flags downstream nodes exceeding thresholds, updates both Memgraph and wiki
 * article frontmatter on disk.
 *
 * @param {string} nodeId            - The updated node's ID (e.g., "code/src--auth.tsx")
 * @param {object} store             - GraphStore instance (S1.4 — session/driver→store swap)
 * @param {object} [opts]            - Options
 * @param {string} [opts.knowledgeDir] - Path to knowledge/ directory for disk frontmatter updates
 * @param {string} opts.projectId      - Project ID (REQUIRED — the store is project-partitioned)
 * @returns {Promise<ImpactSummary>} Summary of the propagation results
 *
 * @typedef {object} ImpactSummary
 * @property {string} sourceNodeId      - The node that was updated
 * @property {number} totalDownstream   - Total downstream nodes reached
 * @property {number} criticalCount     - Nodes flagged as critical
 * @property {number} moderateCount     - Nodes flagged as moderate
 * @property {Array<FlaggedNode>} flagged - Details of each flagged node
 *
 * @typedef {object} FlaggedNode
 * @property {string} nodeId     - Downstream node ID
 * @property {string} type       - Node type
 * @property {string} title      - Node title
 * @property {number} score      - Impact score
 * @property {string} severity   - 'critical' or 'moderate'
 * @property {number} hops       - Number of hops from source
 * @property {string} edgeType   - Type of the first edge in the path
 */
export async function propagateImpact(nodeId, store, opts = {}) {
  const { knowledgeDir, projectId } = opts;
  if (!projectId) {
    throw new Error('propagateImpact: opts.projectId is required (GraphStore is project-partitioned)');
  }

  // ── Step 1+2: forward BFS over the semantic weighted edges (≤4 hops) ──
  // Multiple paths may reach the same node; keep the highest score. Score
  // depends only on the FIRST edge's weight and the total hop count — the
  // legacy formula (`calculateImpactScore`) never looked past the first edge.
  const nodeScores = new Map(); // downstreamId -> { score, hops, edgeType, type, title }
  let frontier = [{ id: nodeId, firstWeight: null, firstEdgeType: null, path: new Set([nodeId]) }];

  for (let hops = 1; hops <= 4 && frontier.length; hops++) {
    const nextFrontier = [];
    for (const item of frontier) {
      const edges = await store.outEdges(projectId, item.id);
      for (const edge of edges) {
        const weight = EDGE_WEIGHTS[edge.type];
        if (weight === undefined) continue; // only the semantic edge types
        const targetId = edge.to;
        if (targetId === nodeId || item.path.has(targetId)) continue; // no repeats within a path

        const firstWeight = item.firstWeight ?? weight;
        const firstEdgeType = item.firstEdgeType ?? edge.type;

        const targetNode = await store.getNode(projectId, targetId);
        if (targetNode && (targetNode.status ?? 'active') === 'active') {
          const score = calculateImpactScore(firstWeight, hops);
          const existing = nodeScores.get(targetId);
          if (!existing || score > existing.score) {
            nodeScores.set(targetId, {
              score,
              hops,
              edgeType: firstEdgeType,
              type: String(targetNode.kind || ''),
              title: String(targetNode.title || targetNode.label || ''),
            });
          }
        }

        nextFrontier.push({
          id: targetId,
          firstWeight,
          firstEdgeType,
          path: new Set([...item.path, targetId]),
        });
      }
    }
    frontier = nextFrontier;
  }

  // ── Step 3: Flag nodes exceeding thresholds ──

  const flagged = [];

  for (const [downstreamId, info] of nodeScores) {
    const severity = getSeverity(info.score);
    if (!severity) continue;

    flagged.push({
      nodeId: downstreamId,
      type: info.type,
      title: info.title,
      score: info.score,
      severity,
      hops: info.hops,
      edgeType: info.edgeType,
    });
  }

  // ── Step 4: Update the GraphStore nodes ──
  // `flagSeverity`/`flagReason` do NOT round-trip: node `props` are filtered to
  // `SYSTEM_GRAPH_NODE_PROPS` (graph-store.mjs) and `setNodeAttrs` only accepts
  // `MUTABLE_NODE_ATTRS` — neither includes these two keys (out of S1.4's file
  // scope to extend). `status:'flagged'` still persists; the full detail
  // (severity/reason) still lands in the wiki frontmatter (Step 5) and the
  // returned summary below, so it isn't lost — just not on the node itself yet.

  for (const flag of flagged) {
    await store.setNodeAttrs(projectId, flag.nodeId, { status: 'flagged' });
  }

  // ── Step 5: Update wiki article frontmatter on disk ──

  if (knowledgeDir) {
    for (const flag of flagged) {
      const articlePath = join(knowledgeDir, `${flag.nodeId}.md`);
      updateArticleFrontmatter(articlePath, {
        status: 'flagged',
        flagSeverity: flag.severity,
        flagReason: `Upstream node ${nodeId} was modified`,
      });
    }
  }

  // ── Step 6: Build summary ──

  const summary = {
    sourceNodeId: nodeId,
    totalDownstream: nodeScores.size,
    criticalCount: flagged.filter(f => f.severity === 'critical').length,
    moderateCount: flagged.filter(f => f.severity === 'moderate').length,
    flagged,
  };

  // ── Step 7: Append to log.md ──

  if (knowledgeDir) {
    const logPath = join(knowledgeDir, 'log.md');
    const d = new Date().toISOString().split('T')[0];
    const logEntry = `[IMPACT] ${d} | Source: ${nodeId} | Critical: ${summary.criticalCount} | Moderate: ${summary.moderateCount} | Total downstream: ${summary.totalDownstream}\n`;

    let criticalDetails = '';
    if (summary.criticalCount > 0) {
      const criticalNodes = flagged.filter(f => f.severity === 'critical');
      for (const cn of criticalNodes) {
        criticalDetails += `  [CRITICAL] ${cn.nodeId} (${cn.type}) — score: ${cn.score.toFixed(3)}, ${cn.hops} hop(s) via ${cn.edgeType}\n`;
      }
    }

    const fullEntry = logEntry + criticalDetails;

    if (existsSync(logPath)) {
      appendFileSync(logPath, fullEntry);
    } else {
      writeFileSync(logPath, `# Knowledge Log\n\n${fullEntry}`);
    }
  }

  return summary;
}

// ── W4.1: read-only reverse impact over DETERMINISTIC structural edges ──
//
// The legacy propagateImpact above traverses the LLM-authored semantic edges
// (DEPENDS_ON/VALIDATES/…) FORWARD and WRITES flags — and has zero callers. The
// query below answers the real refactoring question — "if I change X, what
// depends on it?" — by reverse-traversing only the AST-derived structural edges,
// which are trustworthy. It is REPORT-ONLY (no SET), and needs no graph-sync
// change: the edge TYPE (not a provenance property) already separates
// deterministic edges from the guessed semantic ones, so we never rename or
// migrate DEPENDS_ON (the safety review's hard constraint).

export const STRUCTURAL_EDGE_TYPES = ['IMPORTS', 'CALLS', 'RENDERS', 'TESTS'];

/**
 * Pure: the reverse-impact Cypher. `(changed)<-[:IMPORTS|CALLS|RENDERS|TESTS]-(dependent)`.
 * Vestigial post-S1.4 (queryImpact below no longer runs Cypher — the store has
 * no query-string engine to run it against) — kept exported/untouched as a
 * harmless pure builder; a follow-on story may retire it.
 */
export function buildReverseImpactCypher(maxHops = 4) {
  const n = Number(maxHops);
  const hops = Number.isFinite(n) ? Math.max(1, Math.min(6, n)) : 4;
  const types = STRUCTURAL_EDGE_TYPES.join('|');
  return [
    'MATCH (changed:Node {nodeId: $nodeId})',
    `MATCH path = (changed)<-[:${types}*1..${hops}]-(dependent:Node)`,
    'WHERE dependent.nodeId <> $nodeId',
    'RETURN dependent.nodeId AS nodeId, dependent.kind AS kind,',
    '       dependent.label AS label, length(path) AS hops',
    'ORDER BY hops ASC',
  ].join('\n');
}

/** True for a test-file node (used to surface the covering tests of a change). */
function isTestNode(n) {
  return /\.(test|spec)\.[cm]?[jt]sx?/.test(String(n.label || n.nodeId || ''));
}

/**
 * Read-only impact query: who transitively depends on `nodeId`, via the
 * deterministic structural edges, reverse. Never writes. Surfaces the impacted
 * set + the subset that are covering tests (for selective regression, W5).
 *
 * S1.4: reverse BFS over `store.inEdges` (≤`maxHops`, `STRUCTURAL_EDGE_TYPES`
 * only) replaces the Cypher variable-length path — BFS visits each node in
 * hop order, so the first time a node is reached IS its shortest path
 * (the old "keep the shortest path" dedup is structurally guaranteed here).
 *
 * @param {object} store  GraphStore instance (S1.4 — session/driver→store swap)
 * @param {object} [opts]
 * @param {number} [opts.maxHops]
 * @param {string} opts.projectId  REQUIRED — the store is project-partitioned
 * @returns {Promise<{ sourceNodeId:string, impacted:Array<{nodeId,kind,label,hops}>, tests:string[] }>}
 */
export async function queryImpact(nodeId, store, { maxHops = 4, projectId } = {}) {
  if (!projectId) {
    throw new Error('queryImpact: opts.projectId is required (GraphStore is project-partitioned)');
  }
  const n = Number(maxHops);
  const hops = Number.isFinite(n) ? Math.max(1, Math.min(6, n)) : 4;

  const byId = new Map();
  const visited = new Set([nodeId]);
  let frontier = [nodeId];

  for (let depth = 1; depth <= hops && frontier.length; depth++) {
    const nextFrontier = [];
    for (const id of frontier) {
      for (const type of STRUCTURAL_EDGE_TYPES) {
        const edges = await store.inEdges(projectId, id, { type });
        for (const edge of edges) {
          const dependentId = edge.from;
          if (dependentId === nodeId || visited.has(dependentId)) continue;
          visited.add(dependentId);
          nextFrontier.push(dependentId);
          const depNode = await store.getNode(projectId, dependentId);
          byId.set(dependentId, {
            nodeId: dependentId,
            kind: String(depNode?.kind || ''),
            label: String(depNode?.label || depNode?.title || ''),
            hops: depth,
          });
        }
      }
    }
    frontier = nextFrontier;
  }

  const impacted = [...byId.values()];
  return { sourceNodeId: nodeId, impacted, tests: impacted.filter(isTestNode).map((n) => n.nodeId) };
}

// ── Batch Propagation ──

/**
 * Propagates impact for multiple updated nodes. Useful after epic compilation
 * where many nodes may have changed at once.
 *
 * @param {string[]} nodeIds - Array of updated node IDs
 * @param {object} store     - GraphStore instance (S1.4 — session/driver→store swap)
 * @param {object} [opts] - Options (same as propagateImpact)
 * @returns {Promise<ImpactSummary[]>} Array of summaries, one per source node
 */
export async function propagateImpactBatch(nodeIds, store, opts = {}) {
  const summaries = [];
  for (const nodeId of nodeIds) {
    const summary = await propagateImpact(nodeId, store, opts);
    summaries.push(summary);
  }
  return summaries;
}
