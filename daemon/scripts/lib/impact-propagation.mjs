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
 * Updates both Memgraph nodes (via Cypher SET) and wiki article frontmatter on disk.
 *
 * Usage:
 *   import { propagateImpact, EDGE_WEIGHTS } from './lib/impact-propagation.mjs';
 *   const summary = await propagateImpact('code/src--auth.tsx', driver, { knowledgeDir });
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

// All edge type names for building Cypher queries
const ALL_EDGE_TYPES = Object.keys(EDGE_WEIGHTS).join('|');

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
 * @param {import('neo4j-driver').Driver} driver - neo4j-driver instance connected to Memgraph
 * @param {object} [opts]            - Options
 * @param {string} [opts.knowledgeDir] - Path to knowledge/ directory for disk frontmatter updates
 * @param {string} [opts.projectId]    - Project ID for filtering (if not using global graph)
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
export async function propagateImpact(nodeId, driver, opts = {}) {
  const { knowledgeDir, projectId } = opts;
  const session = driver.session();

  try {
    // ── Step 1: Traverse graph to find all downstream nodes ──

    const projectFilter = projectId
      ? 'AND downstream.projectId = $projectId'
      : '';

    const result = await session.run(`
      MATCH (updated:Node {nodeId: $nodeId})
      MATCH path = (updated)-[rels:${ALL_EDGE_TYPES}*1..4]->(downstream:Node)
      WHERE downstream.status = 'active'
        ${projectFilter}
        AND downstream.nodeId <> $nodeId
      RETURN downstream.nodeId AS downstreamId,
             downstream.type AS type,
             downstream.title AS title,
             [r IN rels | type(r)] AS edgeTypes,
             length(path) AS hops
    `, { nodeId, projectId: projectId || '' });

    // ── Step 2: Calculate impact scores ──
    // Multiple paths may reach the same node; use the highest score.

    const nodeScores = new Map(); // downstreamId -> { score, hops, edgeType, type, title }

    for (const record of result.records) {
      const downstreamId = record.get('downstreamId');
      const type = record.get('type');
      const title = record.get('title');
      const edgeTypes = record.get('edgeTypes');
      const hops = typeof record.get('hops') === 'object'
        ? record.get('hops').toNumber()
        : Number(record.get('hops'));

      // Use the weight of the first edge in the path
      const firstEdgeType = edgeTypes[0];
      const edgeWeight = EDGE_WEIGHTS[firstEdgeType] || 0.3;

      const score = calculateImpactScore(edgeWeight, hops);

      const existing = nodeScores.get(downstreamId);
      if (!existing || score > existing.score) {
        nodeScores.set(downstreamId, {
          score,
          hops,
          edgeType: firstEdgeType,
          type: String(type || ''),
          title: String(title || ''),
        });
      }
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

    // ── Step 4: Update Memgraph nodes ──

    for (const flag of flagged) {
      const flagSession = driver.session();
      try {
        await flagSession.run(`
          MATCH (n:Node {nodeId: $downstreamId})
          SET n.status = 'flagged',
              n.flagSeverity = $severity,
              n.flagReason = $reason
          RETURN n.nodeId
        `, {
          downstreamId: flag.nodeId,
          severity: flag.severity,
          reason: `Upstream node ${nodeId} was modified`,
        });
      } finally {
        await flagSession.close();
      }
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

  } finally {
    await session.close();
  }
}

// ── Batch Propagation ──

/**
 * Propagates impact for multiple updated nodes. Useful after epic compilation
 * where many nodes may have changed at once.
 *
 * @param {string[]} nodeIds - Array of updated node IDs
 * @param {import('neo4j-driver').Driver} driver - neo4j-driver instance
 * @param {object} [opts] - Options (same as propagateImpact)
 * @returns {Promise<ImpactSummary[]>} Array of summaries, one per source node
 */
export async function propagateImpactBatch(nodeIds, driver, opts = {}) {
  const summaries = [];
  for (const nodeId of nodeIds) {
    const summary = await propagateImpact(nodeId, driver, opts);
    summaries.push(summary);
  }
  return summaries;
}
