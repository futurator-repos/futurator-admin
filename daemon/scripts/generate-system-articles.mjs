/**
 * System Knowledge Article Generator — MY-3.2
 *
 * Generates/regenerates the four system-level knowledge articles:
 *   1. pending-work.md     — nodes with maturity < 0.6 or status: flagged
 *   2. dependency-map.md   — DEPENDS_ON edge graph across code articles
 *   3. debt-registry.md    — tech debt items with severity and origin
 *   4. deployment-manifest.md — deployed vs. pending deployment status
 *
 * Reads node/edge data from the graph store (bolt EXCISED, EU-migration S2.2).
 * Each article gets proper frontmatter (type: system, phase: system).
 *
 * Usage:
 *   node generate-system-articles.mjs --project <projectId> --knowledge-dir <dir>
 *   node generate-system-articles.mjs --project spyhunter --knowledge-dir /home/ubuntu/projects/spyhunter/knowledge
 *   node generate-system-articles.mjs --project spyhunter --knowledge-dir ./knowledge --incremental-deps-only
 *
 * [Source: docs/concepts/mycelium-labs-architecture.md#2-Architecture-Overview]
 * [Source: docs/concepts/mycelium-labs-architecture.md#5.2-GraphRAG-Query-Patterns]
 */

import { createGraphStore } from './lib/graph-store.mjs';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';

// ── Config ──

const PHASES_ORDER = ['discovery', 'planning', 'solutioning', 'implementation', 'qa', 'release', 'support'];

// ── CLI Args ──

const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
}

const projectId = getArg('project');
const knowledgeDir = getArg('knowledge-dir');
const incrementalDepsOnly = args.includes('--incremental-deps-only');

if (!projectId || !knowledgeDir) {
  console.error('Usage: node generate-system-articles.mjs --project <id> --knowledge-dir <dir>');
  process.exit(1);
}

// Ensure system directory exists
const systemDir = join(knowledgeDir, 'system');
if (!existsSync(systemDir)) {
  mkdirSync(systemDir, { recursive: true });
}

// ── Helpers ──

function today() {
  return new Date().toISOString().split('T')[0];
}

function systemFrontmatter(title) {
  const d = today();
  return [
    '---',
    `title: "${title}"`,
    'type: system',
    'phase: system',
    'status: active',
    'maturity: 1.0',
    `created: ${d}`,
    `updated: ${d}`,
    'tags: [system, auto-generated]',
    '---',
  ].join('\n');
}

function maturityLabel(score) {
  if (score >= 0.8) return 'Ready';
  if (score >= 0.6) return 'Solid';
  if (score >= 0.4) return 'Partial';
  if (score >= 0.2) return 'Early';
  return 'Raw';
}

function toNumber(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return val;
  if (val.toNumber) return val.toNumber();
  return Number(val) || 0;
}

function toString(val) {
  if (val == null) return '';
  return String(val);
}

// ── Graph store ──
// Bolt/Memgraph EXCISED (EU-migration S2.2). Each generator reads the project's
// nodes/edges once from the GraphStore (DynamoDB when GRAPH_*_TABLE resolve, else
// in-memory) and shapes them in JS. `rec()` re-exposes the legacy
// `record.get(field)` accessor so the downstream section-building loops are
// unchanged.

const store = await createGraphStore();

let _nodesCache = null;
async function allNodes() {
  if (!_nodesCache) _nodesCache = await store.listNodes(projectId);
  return _nodesCache;
}

/** Wrap a plain object as a neo4j-style record so downstream `.get(k)` still works. */
const rec = (o) => ({ get: (k) => o[k] });

/** Read a node field, falling back to the allowlisted `props` bag. */
const nField = (n, k) => n?.[k] ?? n?.props?.[k];
const nType = (n) => nField(n, 'type') ?? n?.kind;
const nMaturity = (n) => { const v = Number(nField(n, 'maturity')); return Number.isFinite(v) ? v : NaN; };

/** Phase-order sort key (heir of the Cypher CASE ladder). */
const PHASE_RANK = { discovery: 1, planning: 2, solutioning: 3, implementation: 4, qa: 5, release: 6, support: 7 };

// ── 1. Pending Work ──

async function generatePendingWork() {
  console.log('Generating pending-work.md ...');

  const records = (await allNodes())
    .filter((n) => ['active', 'flagged'].includes(n.status ?? 'active') && Number.isFinite(nMaturity(n)) && nMaturity(n) < 0.6)
    .map((n) => ({
      nodeId: n.nodeId, type: nType(n), phase: nField(n, 'phase'),
      title: n.title ?? nField(n, 'title'), maturity: nMaturity(n), status: n.status,
      flagReason: nField(n, 'flagReason'), flagSeverity: nField(n, 'flagSeverity'),
    }))
    .sort((a, b) => (PHASE_RANK[a.phase] ?? 99) - (PHASE_RANK[b.phase] ?? 99) || (a.maturity - b.maturity))
    .map(rec);

  // Group by phase
  const byPhase = {};
  for (const phase of PHASES_ORDER) {
    byPhase[phase] = [];
  }

  for (const rec of records) {
    const phase = toString(rec.get('phase')) || 'implementation';
    if (!byPhase[phase]) byPhase[phase] = [];
    byPhase[phase].push({
      nodeId: toString(rec.get('nodeId')),
      type: toString(rec.get('type')),
      title: toString(rec.get('title')),
      maturity: toNumber(rec.get('maturity')),
      status: toString(rec.get('status')),
      flagReason: toString(rec.get('flagReason')),
      flagSeverity: toString(rec.get('flagSeverity')),
    });
  }

  const totalCount = records.length;
  const sections = [];
  sections.push(systemFrontmatter('Pending Work'));
  sections.push('');
  sections.push('## Purpose');
  sections.push('');
  sections.push(`Cross-cutting dashboard of all nodes requiring attention. Total items: **${totalCount}**.`);
  sections.push(`Includes nodes with maturity < 0.6 or status \`flagged\`.`);
  sections.push('');

  for (const phase of PHASES_ORDER) {
    const items = byPhase[phase];
    if (items.length === 0) continue;

    sections.push(`## ${phase.charAt(0).toUpperCase() + phase.slice(1)} (${items.length})`);
    sections.push('');
    sections.push('| Node | Type | Maturity | Status | Flag |');
    sections.push('|------|------|----------|--------|------|');

    for (const item of items) {
      const matLabel = maturityLabel(item.maturity);
      const flag = item.status === 'flagged'
        ? `${item.flagSeverity || 'unknown'}: ${item.flagReason || 'no reason'}`
        : '-';
      sections.push(`| [[${item.nodeId}]] | ${item.type} | ${item.maturity.toFixed(1)} (${matLabel}) | ${item.status} | ${flag} |`);
    }
    sections.push('');
  }

  const content = sections.join('\n');
  writeFileSync(join(systemDir, 'pending-work.md'), content);
  console.log(`  pending-work.md: ${totalCount} items across ${Object.values(byPhase).filter(a => a.length > 0).length} phases`);
  return totalCount;
}

// ── 2. Dependency Map ──

async function generateDependencyMap() {
  console.log('Generating dependency-map.md ...');

  const nodesById = new Map((await allNodes()).map((n) => [n.nodeId, n]));
  const records = (await store.listEdges(projectId))
    .filter((e) => e.type === 'DEPENDS_ON')
    .filter((e) => { const a = nodesById.get(e.from); return a && ['active', 'flagged', 'deployed'].includes(a.status ?? 'active'); })
    .sort((x, y) => x.from.localeCompare(y.from) || x.to.localeCompare(y.to))
    .map((e) => {
      const a = nodesById.get(e.from), b = nodesById.get(e.to);
      return rec({
        fromId: e.from, fromTitle: a?.title ?? nField(a, 'title') ?? '',
        toId: e.to, toTitle: b?.title ?? nField(b, 'title') ?? '',
        fromType: nType(a) ?? '', toType: nType(b) ?? '',
      });
    });

  // Build adjacency map
  const deps = new Map(); // nodeId -> { title, type, dependsOn: [{nodeId, title}] }
  const inDegree = new Map(); // nodeId -> count of incoming edges

  for (const rec of records) {
    const fromId = toString(rec.get('fromId'));
    const toId = toString(rec.get('toId'));
    const fromTitle = toString(rec.get('fromTitle'));
    const toTitle = toString(rec.get('toTitle'));
    const fromType = toString(rec.get('fromType'));

    if (!deps.has(fromId)) {
      deps.set(fromId, { title: fromTitle, type: fromType, dependsOn: [] });
    }
    deps.get(fromId).dependsOn.push({ nodeId: toId, title: toTitle });
    inDegree.set(toId, (inDegree.get(toId) || 0) + 1);
  }

  // Detect circular dependencies
  const circularPairs = [];
  for (const [nodeId, info] of deps) {
    for (const dep of info.dependsOn) {
      const depInfo = deps.get(dep.nodeId);
      if (depInfo && depInfo.dependsOn.some(d => d.nodeId === nodeId)) {
        const pair = [nodeId, dep.nodeId].sort().join(' <-> ');
        if (!circularPairs.includes(pair)) {
          circularPairs.push(pair);
        }
      }
    }
  }

  const sections = [];
  sections.push(systemFrontmatter('Dependency Map'));
  sections.push('');
  sections.push('## Purpose');
  sections.push('');
  sections.push(`Top-level import graph across all code articles, derived from \`DEPENDS_ON\` edges.`);
  sections.push(`Total nodes with dependencies: **${deps.size}**. Total edges: **${records.length}**.`);
  sections.push('');

  if (circularPairs.length > 0) {
    sections.push('## Circular Dependencies');
    sections.push('');
    sections.push('> **Warning:** The following circular dependencies were detected:');
    sections.push('');
    for (const pair of circularPairs) {
      sections.push(`- ${pair}`);
    }
    sections.push('');
  }

  sections.push('## Dependency Graph');
  sections.push('');

  // Sort by number of dependencies (most connected first)
  const sorted = [...deps.entries()].sort((a, b) => b[1].dependsOn.length - a[1].dependsOn.length);

  for (const [nodeId, info] of sorted) {
    const incoming = inDegree.get(nodeId) || 0;
    sections.push(`### [[${nodeId}]] (${info.type})`);
    sections.push(`Depends on ${info.dependsOn.length} | Depended on by ${incoming}`);
    sections.push('');
    for (const dep of info.dependsOn) {
      sections.push(`- -> [[${dep.nodeId}]] — ${dep.title}`);
    }
    sections.push('');
  }

  const content = sections.join('\n');
  writeFileSync(join(systemDir, 'dependency-map.md'), content);
  console.log(`  dependency-map.md: ${deps.size} nodes, ${records.length} edges, ${circularPairs.length} circular`);
  return { nodeCount: deps.size, edgeCount: records.length };
}

/**
 * Incremental dependency map update — appends new edges only.
 * Used during story-level compilation (AC #7).
 *
 * @param {Array<{fromId: string, toId: string, fromTitle: string, toTitle: string}>} newEdges
 */
async function appendDependencyEdges(newEdges) {
  const filePath = join(systemDir, 'dependency-map.md');
  if (!existsSync(filePath)) {
    // If file doesn't exist yet, do a full generation instead
    return generateDependencyMap();
  }

  console.log(`Appending ${newEdges.length} new edges to dependency-map.md ...`);
  let existing = readFileSync(filePath, 'utf-8');

  const newLines = [];
  newLines.push('');
  newLines.push(`<!-- Incremental update: ${today()} -->`);
  for (const edge of newEdges) {
    newLines.push(`- [[${edge.fromId}]] -> [[${edge.toId}]] — ${edge.toTitle}`);
  }

  // Append before the end of the file
  existing += newLines.join('\n') + '\n';

  // Update the `updated` field in frontmatter
  existing = existing.replace(/^updated:.*$/m, `updated: ${today()}`);

  writeFileSync(filePath, existing);
  console.log(`  dependency-map.md: appended ${newEdges.length} edges`);
}

// ── 3. Debt Registry ──

async function generateDebtRegistry() {
  console.log('Generating debt-registry.md ...');

  // Nodes that may have tech debt indicators (active/flagged), by maturity asc.
  const records = (await allNodes())
    .filter((n) => ['active', 'flagged'].includes(n.status ?? 'active'))
    .map((n) => ({
      nodeId: n.nodeId, type: nType(n), phase: nField(n, 'phase'),
      title: n.title ?? nField(n, 'title'), maturity: Number.isFinite(nMaturity(n)) ? nMaturity(n) : 0,
      createdByStory: nField(n, 'createdByStory'), createdByEpic: nField(n, 'createdByEpic'),
      summary: nField(n, 'summary'),
    }))
    .sort((a, b) => a.maturity - b.maturity)
    .map(rec);

  // Classify debt items by severity
  // - Critical: maturity < 0.2 or explicit critical markers
  // - Moderate: maturity 0.2-0.4 or moderate markers
  // - Low: maturity 0.4-0.6 with missing signals
  const debtItems = [];

  for (const rec of records) {
    const maturity = toNumber(rec.get('maturity'));
    const nodeId = toString(rec.get('nodeId'));
    const type = toString(rec.get('type'));
    const phase = toString(rec.get('phase'));
    const title = toString(rec.get('title'));
    const story = toString(rec.get('createdByStory'));
    const summary = toString(rec.get('summary'));

    // Determine severity based on maturity and type
    let severity = null;
    let description = '';

    if (maturity < 0.2) {
      severity = 'critical';
      description = `Raw concept (maturity ${maturity.toFixed(1)}) — key aspects undefined. Needs immediate definition.`;
    } else if (maturity < 0.4) {
      severity = 'moderate';
      description = `Early stage (maturity ${maturity.toFixed(1)}) — basic outline with many gaps.`;
    } else if (maturity < 0.6 && (type === 'code' || type === 'decision')) {
      severity = 'low';
      description = `Partial definition (maturity ${maturity.toFixed(1)}) — core defined but gaps remain.`;
    }

    // Check summary for explicit debt markers
    const lowerSummary = (summary || '').toLowerCase();
    if (lowerSummary.includes('todo') || lowerSummary.includes('hack') ||
        lowerSummary.includes('workaround') || lowerSummary.includes('tech debt')) {
      severity = severity === 'critical' ? 'critical' : 'moderate';
      description = `Explicit tech debt marker detected. ${description}`;
    }

    if (severity) {
      debtItems.push({ nodeId, type, phase, title, maturity, severity, description, story });
    }
  }

  // Group by severity then phase
  const bySeverity = { critical: [], moderate: [], low: [] };
  for (const item of debtItems) {
    bySeverity[item.severity].push(item);
  }

  const sections = [];
  sections.push(systemFrontmatter('Debt Registry'));
  sections.push('');
  sections.push('## Purpose');
  sections.push('');
  sections.push(`Tech debt registry tracking items needing attention. Total items: **${debtItems.length}**.`);
  sections.push(`Critical: ${bySeverity.critical.length} | Moderate: ${bySeverity.moderate.length} | Low: ${bySeverity.low.length}`);
  sections.push('');

  for (const severity of ['critical', 'moderate', 'low']) {
    const items = bySeverity[severity];
    if (items.length === 0) continue;

    sections.push(`## ${severity.charAt(0).toUpperCase() + severity.slice(1)} (${items.length})`);
    sections.push('');
    sections.push('| Node | Type | Phase | Maturity | Origin Story | Description |');
    sections.push('|------|------|-------|----------|-------------|-------------|');

    for (const item of items) {
      sections.push(`| [[${item.nodeId}]] | ${item.type} | ${item.phase} | ${item.maturity.toFixed(1)} | ${item.story || '-'} | ${item.description} |`);
    }
    sections.push('');
  }

  const content = sections.join('\n');
  writeFileSync(join(systemDir, 'debt-registry.md'), content);
  console.log(`  debt-registry.md: ${debtItems.length} items (${bySeverity.critical.length} critical, ${bySeverity.moderate.length} moderate, ${bySeverity.low.length} low)`);
  return debtItems.length;
}

// ── 4. Deployment Manifest ──

async function generateDeploymentManifest() {
  console.log('Generating deployment-manifest.md ...');

  const nodes = await allNodes();
  const codeOfStatus = (status) => nodes.filter((n) => n.status === status && nType(n) === 'code');

  // Deployed articles (by deploy date desc)
  const deployedRecords = codeOfStatus('deployed')
    .sort((a, b) => String(nField(b, 'updated') ?? '').localeCompare(String(nField(a, 'updated') ?? '')))
    .map((n) => rec({ nodeId: n.nodeId, title: n.title ?? nField(n, 'title'), epic: nField(n, 'createdByEpic'), deployDate: nField(n, 'updated') }));

  // Pending deployment (active code articles)
  const pendingRecords = codeOfStatus('active')
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    .map((n) => rec({ nodeId: n.nodeId, title: n.title ?? nField(n, 'title'), epic: nField(n, 'createdByEpic') }));

  // Superseded articles
  const supersededRecords = codeOfStatus('superseded')
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId))
    .map((n) => rec({ nodeId: n.nodeId, title: n.title ?? nField(n, 'title') }));

  // Latest deploy record
  const deployRecordResults = nodes
    .filter((n) => nType(n) === 'deployment-record')
    .sort((a, b) => String(nField(b, 'created') ?? '').localeCompare(String(nField(a, 'created') ?? '')))
    .slice(0, 1)
    .map((n) => rec({ nodeId: n.nodeId, title: n.title ?? nField(n, 'title'), created: nField(n, 'created') }));

  const deployedCount = deployedRecords.length;
  const pendingCount = pendingRecords.length;
  const supersededCount = supersededRecords.length;

  const sections = [];
  sections.push(systemFrontmatter('Deployment Manifest'));
  sections.push('');
  sections.push('## Purpose');
  sections.push('');
  sections.push(`Tracks deployment status of all code articles.`);
  sections.push('');
  sections.push('## Summary');
  sections.push('');
  sections.push(`| Status | Count |`);
  sections.push(`|--------|-------|`);
  sections.push(`| Deployed | ${deployedCount} |`);
  sections.push(`| Pending Deployment | ${pendingCount} |`);
  sections.push(`| Superseded | ${supersededCount} |`);
  sections.push(`| **Total** | **${deployedCount + pendingCount + supersededCount}** |`);
  sections.push('');

  if (deployRecordResults.length > 0) {
    const latestDeploy = deployRecordResults[0];
    sections.push(`**Latest deployment:** [[${toString(latestDeploy.get('nodeId'))}]] (${toString(latestDeploy.get('created'))})`);
    sections.push('');
  }

  // Deployed articles
  sections.push('## Deployed');
  sections.push('');
  if (deployedCount === 0) {
    sections.push('No code articles deployed yet.');
  } else {
    sections.push('| Node | Title | Epic | Deploy Date |');
    sections.push('|------|-------|------|-------------|');
    for (const rec of deployedRecords) {
      sections.push(`| [[${toString(rec.get('nodeId'))}]] | ${toString(rec.get('title'))} | ${toString(rec.get('epic'))} | ${toString(rec.get('deployDate'))} |`);
    }
  }
  sections.push('');

  // Pending deployment
  sections.push('## Pending Deployment');
  sections.push('');
  if (pendingCount === 0) {
    sections.push('All code articles are deployed.');
  } else {
    sections.push('| Node | Title | Epic |');
    sections.push('|------|-------|------|');
    for (const rec of pendingRecords) {
      sections.push(`| [[${toString(rec.get('nodeId'))}]] | ${toString(rec.get('title'))} | ${toString(rec.get('epic'))} |`);
    }
  }
  sections.push('');

  // Superseded
  sections.push('## Superseded');
  sections.push('');
  if (supersededCount === 0) {
    sections.push('No superseded code articles.');
  } else {
    sections.push('| Node | Title |');
    sections.push('|------|-------|');
    for (const rec of supersededRecords) {
      sections.push(`| [[${toString(rec.get('nodeId'))}]] | ${toString(rec.get('title'))} |`);
    }
  }
  sections.push('');

  const content = sections.join('\n');
  writeFileSync(join(systemDir, 'deployment-manifest.md'), content);
  console.log(`  deployment-manifest.md: ${deployedCount} deployed, ${pendingCount} pending, ${supersededCount} superseded`);
  return { deployedCount, pendingCount, supersededCount };
}

// ── Main ──

async function main() {
  console.log(`=== System Article Generator ===`);
  console.log(`Project: ${projectId}`);
  console.log(`Knowledge dir: ${knowledgeDir}`);
  console.log(`Mode: ${incrementalDepsOnly ? 'incremental (deps only)' : 'full regeneration'}`);
  console.log('');

  try {
    if (incrementalDepsOnly) {
      // Story-level compilation: only update dependency-map incrementally
      // In this mode, we expect new edges to be passed via stdin or generated
      // from recent compilation. For now, we do a full dependency map regen
      // as a safe default when called with no stdin data.
      await generateDependencyMap();
    } else {
      // Epic-level compilation: full regeneration of all system articles
      const [pendingCount, depStats, debtCount, deployStats] = await Promise.all([
        generatePendingWork(),
        generateDependencyMap(),
        generateDebtRegistry(),
        generateDeploymentManifest(),
      ]);

      console.log('');
      console.log('=== Summary ===');
      console.log(`  pending-work.md:         ${pendingCount} items`);
      console.log(`  dependency-map.md:       ${depStats.nodeCount} nodes, ${depStats.edgeCount} edges`);
      console.log(`  debt-registry.md:        ${debtCount} items`);
      console.log(`  deployment-manifest.md:  ${deployStats.deployedCount} deployed, ${deployStats.pendingCount} pending`);
    }

    console.log('');
    console.log('System articles generated successfully.');
  } catch (err) {
    console.error('Error generating system articles:', err.message);
    console.error(err.stack);
    process.exit(1);
  } finally {
    await store.close?.();
  }
}

main();

// ── Exports for programmatic use ──

export {
  generatePendingWork,
  generateDependencyMap,
  generateDebtRegistry,
  generateDeploymentManifest,
  appendDependencyEdges,
  systemFrontmatter,
  maturityLabel,
};
