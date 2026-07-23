/**
 * Self-Reflection Pipeline
 * Story MY-5.5
 *
 * Specialized conversation variant where the agent analyzes the project's
 * overall health. Pre-queries low-maturity nodes, flagged nodes, pending work,
 * and tech debt, then synthesizes a structured health report.
 *
 * The report is compiled as a system article: knowledge/system/reflection-{date}.md
 *
 * Module Usage:
 *   import { getSelfReflectionPipeline } from './self-reflection-pipeline.mjs';
 *   const pipeline = getSelfReflectionPipeline('spyhunter', '/path/to/project');
 */

import { resolve, join } from 'path';
import { createGraphStore } from '../scripts/lib/graph-store.mjs';
import { readFile, writeFile, mkdir, access, appendFile } from 'fs/promises';
import { buildAgentConfig } from './lib/role-policy.mjs';

// Bolt/Memgraph EXCISED (EU-migration S2.2). The three health pre-queries are
// now GraphStore reads (DynamoDB when GRAPH_*_TABLE resolve, else in-memory):
//   low-maturity = listNodes + status∈{active,flagged} + maturity < 0.6
//   flagged      = listNodes + status == 'flagged'
//   prune        = superseded nodes with zero active DEPENDS_ON in-edge (reverse GSI)

/** Phase ordering for the maturity heatmap (heir of the Cypher CASE ladder). */
const PHASE_ORDER = {
  discovery: 1, planning: 2, solutioning: 3, implementation: 4, qa: 5, release: 6, support: 7,
};

/** Read a node field, falling back to the allowlisted `props` bag. */
function nodeField(node, key) {
  return node?.[key] ?? node?.props?.[key];
}

// ── Helpers ─────────────────────────────────────────────────────────

function today() {
  return new Date().toISOString().split('T')[0];
}

function nowISO() {
  return new Date().toISOString();
}

/**
 * Safely read a file, returning a default string if it doesn't exist.
 */
async function safeRead(filePath, defaultContent = '(file not found)') {
  try {
    return await readFile(filePath, 'utf-8');
  } catch {
    return defaultContent;
  }
}

/**
 * Coerce a possibly-missing numeric field to a JS number (null/undefined → NaN
 * so callers can distinguish "no maturity" from 0).
 */
function toNumber(val) {
  if (val === null || val === undefined) return NaN;
  if (typeof val === 'number') return val;
  return Number(val);
}

/** Sort by phase order then maturity ascending (heir of the Cypher ORDER BY). */
function byPhaseThenMaturity(a, b) {
  const pa = PHASE_ORDER[a.phase] ?? 99;
  const pb = PHASE_ORDER[b.phase] ?? 99;
  if (pa !== pb) return pa - pb;
  return (toNumber(a.maturity) || 0) - (toNumber(b.maturity) || 0);
}

// ── Pre-query functions ─────────────────────────────────────────────

/**
 * Query the graph store for all low-maturity nodes (status active/flagged,
 * maturity < 0.6). Bolt EXCISED — a `listNodes` scan + JS filter/sort.
 *
 * @param {string} projectId - The project to query.
 * @param {object} [store] - GraphStore (defaults to `createGraphStore()`).
 * @returns {Promise<Array>} Low-maturity node records.
 */
export async function queryLowMaturityNodes(projectId, store) {
  store = store || (await createGraphStore());
  const nodes = await store.listNodes(projectId);
  return nodes
    .filter((n) => ['active', 'flagged'].includes(n.status ?? 'active'))
    .map((n) => ({
      nodeId: n.nodeId,
      type: nodeField(n, 'type') ?? n.kind,
      phase: nodeField(n, 'phase'),
      title: n.title ?? nodeField(n, 'title'),
      maturity: toNumber(nodeField(n, 'maturity')),
      status: n.status,
    }))
    .filter((r) => Number.isFinite(r.maturity) && r.maturity < 0.6)
    .sort(byPhaseThenMaturity);
}

/**
 * Query the graph store for all flagged nodes.
 *
 * @param {string} projectId - The project to query.
 * @param {object} [store] - GraphStore (defaults to `createGraphStore()`).
 * @returns {Promise<Array>} Flagged node records.
 */
export async function queryFlaggedNodes(projectId, store) {
  store = store || (await createGraphStore());
  const nodes = await store.listNodes(projectId);
  return nodes
    .filter((n) => n.status === 'flagged')
    .map((n) => ({
      nodeId: n.nodeId,
      type: nodeField(n, 'type') ?? n.kind,
      phase: nodeField(n, 'phase'),
      title: n.title ?? nodeField(n, 'title'),
      maturity: toNumber(nodeField(n, 'maturity')),
      missingSignals: nodeField(n, 'missingSignals'),
      flagReason: nodeField(n, 'flagReason'),
    }))
    .sort(byPhaseThenMaturity);
}

/**
 * Query the graph store for pruning candidates: superseded nodes with no active
 * DEPENDS_ON dependent (reverse GSI in-edge scan).
 *
 * @param {string} projectId - The project to query.
 * @param {object} [store] - GraphStore (defaults to `createGraphStore()`).
 * @returns {Promise<Array>} Pruning candidate records.
 */
export async function queryPruningCandidates(projectId, store) {
  store = store || (await createGraphStore());
  const nodes = await store.listNodes(projectId);
  const superseded = nodes.filter((n) => n.status === 'superseded');
  const candidates = [];
  for (const n of superseded) {
    const inEdges = await store.inEdges(projectId, n.nodeId, { type: 'DEPENDS_ON' });
    let hasActiveDependent = false;
    for (const e of inEdges) {
      const dependent = await store.getNode(projectId, e.from);
      if (dependent && (dependent.status ?? 'active') === 'active') {
        hasActiveDependent = true;
        break;
      }
    }
    if (!hasActiveDependent) {
      candidates.push({ nodeId: n.nodeId, title: n.title ?? nodeField(n, 'title'), type: nodeField(n, 'type') ?? n.kind });
    }
  }
  return candidates.sort((a, b) => String(nodeField(a, 'updated') ?? '').localeCompare(String(nodeField(b, 'updated') ?? '')));
}

// ── Reflection report compilation ───────────────────────────────────

/**
 * Compile a reflection report as a system article in the wiki.
 *
 * @param {string} reportContent - The full reflection report markdown.
 * @param {string} knowledgeDir - Path to the knowledge/ directory.
 * @param {object} [opts] - Options.
 * @param {boolean} [opts.verbose=false] - Debug output.
 * @returns {Promise<string>} Path to the created reflection article.
 */
export async function compileReflectionArticle(reportContent, knowledgeDir, opts = {}) {
  const dbg = opts.verbose ? (msg) => console.error(`[self-reflection] ${msg}`) : () => {};

  const systemDir = join(knowledgeDir, 'system');
  await mkdir(systemDir, { recursive: true });

  const dateStr = today();
  const articlePath = join(systemDir, `reflection-${dateStr}.md`);

  const frontmatter = `---
title: "Project Reflection - ${dateStr}"
type: reflection
phase: system
status: active
maturity: 0.8
created: ${dateStr}
updated: ${dateStr}
tags: [reflection, health-check, sprint-planning]
---

`;

  await writeFile(articlePath, frontmatter + reportContent, 'utf-8');
  dbg(`Reflection article written: ${articlePath}`);

  // Update log.md
  const logPath = join(knowledgeDir, 'log.md');
  const logEntry = `| ${nowISO()} | self-reflection | Created reflection report: reflection-${dateStr}.md |\n`;

  try {
    const logExists = await safeRead(logPath, null);
    if (logExists === null) {
      const header = '# Knowledge Operations Log\n\n| Timestamp | Operation | Details |\n|-----------|-----------|----------|\n';
      await writeFile(logPath, header + logEntry, 'utf-8');
    } else {
      await appendFile(logPath, logEntry, 'utf-8');
    }
  } catch (err) {
    dbg(`Failed to update log.md: ${err.message}`);
  }

  return articlePath;
}

// ── Pipeline definition ─────────────────────────────────────────────

/**
 * Build the self-reflection agent prompt.
 * This is a specialized prompt that instructs the agent to produce a
 * structured health report based on pre-gathered graph and system data.
 *
 * @param {string} projectName - Display name for the project.
 * @returns {string} Prompt template with {{variable}} placeholders.
 */
function buildReflectionPrompt(projectName) {
  return `You are the Project Health Analyst for ${projectName || '{{PROJECT_NAME}}'}.
You are performing a comprehensive self-reflection on the project's current state.

PROJECT CONTEXT (index + pending work + file tree):
{{PROJECT_CONTEXT}}

LOW MATURITY NODES (all nodes with maturity < 0.6, needing work):
{{LOW_MATURITY_NODES}}

SYSTEM DOCUMENTS (pending work + tech debt registry):
{{SYSTEM_DOCS}}

FLAGGED NODES (items requiring review):
{{FLAGGED_NODES}}

Your task: Synthesize a comprehensive health report with the following sections.
Use the data above plus your ability to Read, Grep, and Glob files to build a thorough analysis.

## Maturity Heatmap by Phase
For each of the 7 phases (discovery, planning, solutioning, implementation, qa, release, support):
- Count of total nodes
- Count of nodes with maturity < 0.6
- Average maturity score
- Brief assessment (strong / needs work / critical gaps)

## Flagged Items Requiring Review
For each flagged node:
- What it is and why it was flagged
- Suggested action (update, supersede, or remove flag)

## Technical Debt Identified
- Items from debt-registry.md
- Newly detected debt patterns (e.g., missing tests, stale dependencies, outdated articles)

## Missing Test Coverage
- Code nodes without corresponding QA/test articles
- Implementation nodes that lack validation edges in the graph

## Suggested Next Actions
Prioritized list (most important first) of what to work on next. Consider:
- Flagged items blocking downstream work
- Low-maturity nodes in early phases (planning before implementation)
- Tech debt items with highest impact
- Missing coverage for critical paths

Reference wiki articles using [[wikilink]] notation throughout.

After your analysis, output the full report as a NEW_KNOWLEDGE block so it is
automatically compiled as a system article:

---NEW_KNOWLEDGE---
- type: reflection
  title: Project Reflection - ${today()}
  content: [Your full structured report here]
  links: [list of all wiki articles referenced in the report]
---END_NEW_KNOWLEDGE---`;
}

/**
 * Generate a self-reflection pipeline definition.
 *
 * This is a specialized variant of the conversation pipeline that
 * pre-gathers graph data about project health before the agent step.
 *
 * Steps:
 *   1. gather-context — same as conversation pipeline
 *   2. query-low-maturity — graph-store query for maturity < 0.6 nodes
 *   3. read-system-docs — read pending-work.md and debt-registry.md
 *   4. query-flagged — graph-store query for flagged nodes
 *   5. reflect — agent synthesizes health report
 *   6. compile — compile reflection as system article (via Story 5.4)
 *   7. sync — graph-sync for the new article
 *
 * @param {string} projectId - The project identifier.
 * @param {string} workingDir - Absolute path to the project workspace.
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.projectName] - Human-readable project name.
 * @param {string} [opts.model='opus'] - Agent model.
 * @returns {object} Pipeline definition object.
 */
export function getSelfReflectionPipeline(projectId, workingDir, opts = {}) {
  const {
    projectName = projectId,
    model = 'opus',
  } = opts;

  const resolvedDir = resolve(workingDir);
  const knowledgeDir = join(resolvedDir, 'knowledge');
  const graphSearchScript = '/opt/futurator-daemon/scripts/graph-search.mjs';
  // Deployed module path (mirrors the graph-sync.mjs convention below) — the
  // shell steps import THIS module's store-backed query fns, so the Cypher→store
  // translation lives in exactly one place. Bolt/Memgraph EXCISED (S2.2).
  const selfReflectionModule = '/opt/futurator-daemon/pipelines/self-reflection-pipeline.mjs';

  // Build the graph pre-query runners for the shell steps. Inline node -e imports
  // the exported store-backed query fns; each creates its own GraphStore (DynamoDB
  // when GRAPH_*_TABLE resolve, else in-memory).
  const lowMaturityCmd = `node --input-type=module -e "import { queryLowMaturityNodes } from '${selfReflectionModule}'; console.log(JSON.stringify(await queryLowMaturityNodes('${projectId}'), null, 2));"`;

  const flaggedNodesCmd = `node --input-type=module -e "import { queryFlaggedNodes } from '${selfReflectionModule}'; console.log(JSON.stringify(await queryFlaggedNodes('${projectId}'), null, 2));"`;

  return {
    id: 'self-reflection',
    type: 'conversation-reflection',
    projectId,
    workingDir: resolvedDir,
    variables: {
      USER_QUERY: `Reflect on the current state of ${projectName}`,
      PROJECT_NAME: projectName,
      projectId,
    },
    agents: {
      // PR-32b — REFLECTION role from the daemon role-policy mirror.
      ASSISTANT: buildAgentConfig({ role: 'REFLECTION', name: 'Project Health Analyst', model }),
    },
    steps: [
      // Step 1: Gather project context (same as conversation pipeline)
      {
        id: 'gather-context',
        stepType: 'shell',
        command: [
          `cd "${resolvedDir}"`,
          'cat knowledge/index.md 2>/dev/null || echo "No index.md found"',
          'echo "---PENDING---"',
          'cat knowledge/system/pending-work.md 2>/dev/null || echo "No pending-work.md found"',
          'echo "---TREE---"',
          "find . -type f -not -path './node_modules/*' -not -path './.git/*' -not -path './.mycelium/*' | head -200",
        ].join(' && '),
        captureAs: 'PROJECT_CONTEXT',
      },

      // Step 2: Query low-maturity nodes from the graph store
      {
        id: 'query-low-maturity',
        stepType: 'shell',
        command: lowMaturityCmd,
        captureAs: 'LOW_MATURITY_NODES',
        allowFailure: true, // Continue even if the graph store is unavailable
      },

      // Step 3: Read system documents (pending work + tech debt)
      {
        id: 'read-system-docs',
        stepType: 'shell',
        command: [
          `cd "${resolvedDir}"`,
          'echo "=== PENDING WORK ==="',
          'cat knowledge/system/pending-work.md 2>/dev/null || echo "(no pending-work.md)"',
          'echo ""',
          'echo "=== TECH DEBT REGISTRY ==="',
          'cat knowledge/system/debt-registry.md 2>/dev/null || echo "(no debt-registry.md)"',
        ].join(' && '),
        captureAs: 'SYSTEM_DOCS',
      },

      // Step 4: Query flagged nodes from the graph store
      {
        id: 'query-flagged',
        stepType: 'shell',
        command: flaggedNodesCmd,
        captureAs: 'FLAGGED_NODES',
        allowFailure: true,
      },

      // Step 5: Self-reflection agent
      {
        id: 'reflect',
        stepType: 'agent',
        agentId: 'ASSISTANT',
        prompt: buildReflectionPrompt(projectName),
        extractors: {
          NEW_KNOWLEDGE: {
            type: 'between',
            startDelimiter: '---NEW_KNOWLEDGE---',
            endDelimiter: '---END_NEW_KNOWLEDGE---',
          },
        },
      },

      // Step 6: Compile reflection as system article (conditional on NEW_KNOWLEDGE)
      {
        id: 'compile-reflection',
        stepType: 'shell',
        command: `node --input-type=module -e "
import { compileConversationKnowledge } from '${join(resolvedDir, '../../daemon/pipelines/conversation-compile.mjs')}';
const block = process.env.NEW_KNOWLEDGE || '';
if (block) {
  const result = await compileConversationKnowledge(
    block, '${projectId}', '${knowledgeDir}',
    { conversationId: 'self-reflection-${today()}', syncToGraph: false, verbose: true }
  );
  console.log(JSON.stringify(result, null, 2));
} else {
  console.log('No NEW_KNOWLEDGE extracted from reflection.');
}
"`,
        condition: 'NEW_KNOWLEDGE',
      },

      // Step 7: Graph sync (ensure the reflection node is in the graph store)
      {
        id: 'sync',
        stepType: 'shell',
        command: `node /opt/futurator-daemon/scripts/graph-sync.mjs --project "${projectId}" --knowledge-dir "${knowledgeDir}"`,
        condition: 'NEW_KNOWLEDGE',
      },
    ],
  };
}
