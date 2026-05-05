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
import neo4j from 'neo4j-driver';
import { readFile, writeFile, mkdir, access, appendFile } from 'fs/promises';
import { buildAgentConfig } from './lib/role-policy.mjs';

const BOLT_URI = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';

// ── Cypher queries ──────────────────────────────────────────────────

/**
 * Query all nodes with maturity < 0.6, ordered by phase then maturity.
 */
const LOW_MATURITY_CYPHER = `
MATCH (n:Node)
WHERE n.projectId = $projectId
  AND n.status IN ['active', 'flagged']
  AND n.maturity < 0.6
RETURN n.nodeId AS nodeId,
       n.type AS type,
       n.phase AS phase,
       n.title AS title,
       n.maturity AS maturity,
       n.status AS status
ORDER BY
  CASE n.phase
    WHEN 'discovery' THEN 1
    WHEN 'planning' THEN 2
    WHEN 'solutioning' THEN 3
    WHEN 'implementation' THEN 4
    WHEN 'qa' THEN 5
    WHEN 'release' THEN 6
    WHEN 'support' THEN 7
  END ASC,
  n.maturity ASC
`;

/**
 * Query all flagged nodes with their flag reasons and missing signals.
 */
const FLAGGED_NODES_CYPHER = `
MATCH (n:Node)
WHERE n.projectId = $projectId
  AND n.status = 'flagged'
RETURN n.nodeId AS nodeId,
       n.type AS type,
       n.phase AS phase,
       n.title AS title,
       n.maturity AS maturity,
       n.missingSignals AS missingSignals,
       n.flagReason AS flagReason
ORDER BY n.phase, n.maturity ASC
`;

/**
 * Query pruning candidates (superseded nodes with no active dependents).
 */
const PRUNING_CANDIDATES_CYPHER = `
MATCH (n:Node)
WHERE n.status = 'superseded'
  AND n.projectId = $projectId
  AND NOT (n)<-[:DEPENDS_ON]-(:Node {status: 'active'})
RETURN n.nodeId AS nodeId,
       n.title AS title,
       n.type AS type
ORDER BY n.updated ASC
`;

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
 * Convert a neo4j integer to a JS number, handling both native and wrapped types.
 */
function toNumber(val) {
  if (val === null || val === undefined) return 0;
  if (typeof val === 'number') return val;
  if (typeof val === 'object' && val.toNumber) return val.toNumber();
  return Number(val) || 0;
}

/**
 * Run a Cypher query against Memgraph and return records as plain objects.
 */
async function runCypher(driver, cypher, params) {
  const session = driver.session();
  try {
    const result = await session.run(cypher, params);
    return result.records.map((record) => {
      const obj = {};
      for (const key of record.keys) {
        const val = record.get(key);
        obj[key] = (typeof val === 'object' && val !== null && val.toNumber) ? val.toNumber() : val;
      }
      return obj;
    });
  } finally {
    await session.close();
  }
}

// ── Pre-query functions ─────────────────────────────────────────────

/**
 * Query Memgraph for all low-maturity nodes.
 *
 * @param {string} projectId - The project to query.
 * @returns {Promise<Array>} Low-maturity node records.
 */
export async function queryLowMaturityNodes(projectId) {
  const driver = neo4j.driver(BOLT_URI);
  try {
    return await runCypher(driver, LOW_MATURITY_CYPHER, { projectId });
  } finally {
    await driver.close();
  }
}

/**
 * Query Memgraph for all flagged nodes.
 *
 * @param {string} projectId - The project to query.
 * @returns {Promise<Array>} Flagged node records.
 */
export async function queryFlaggedNodes(projectId) {
  const driver = neo4j.driver(BOLT_URI);
  try {
    return await runCypher(driver, FLAGGED_NODES_CYPHER, { projectId });
  } finally {
    await driver.close();
  }
}

/**
 * Query Memgraph for pruning candidates.
 *
 * @param {string} projectId - The project to query.
 * @returns {Promise<Array>} Pruning candidate records.
 */
export async function queryPruningCandidates(projectId) {
  const driver = neo4j.driver(BOLT_URI);
  try {
    return await runCypher(driver, PRUNING_CANDIDATES_CYPHER, { projectId });
  } finally {
    await driver.close();
  }
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
 *   2. query-low-maturity — Cypher query for maturity < 0.6 nodes
 *   3. read-system-docs — read pending-work.md and debt-registry.md
 *   4. query-flagged — Cypher query for flagged nodes
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
  const graphSearchScript = '/home/ubuntu/scripts/graph-search.mjs';

  // Build a Cypher query runner script for the shell step.
  // We use inline node -e to run Cypher queries via neo4j-driver.
  const lowMaturityCmd = `node --input-type=module -e "
import neo4j from 'neo4j-driver';
const driver = neo4j.driver(process.env.MEMGRAPH_URI || 'bolt://localhost:7687');
const session = driver.session();
try {
  const result = await session.run(\`
    MATCH (n:Node)
    WHERE n.projectId = \\$projectId
      AND n.status IN ['active', 'flagged']
      AND n.maturity < 0.6
    RETURN n.nodeId AS nodeId, n.type AS type, n.phase AS phase,
           n.title AS title, n.maturity AS maturity, n.status AS status
    ORDER BY
      CASE n.phase
        WHEN 'discovery' THEN 1
        WHEN 'planning' THEN 2
        WHEN 'solutioning' THEN 3
        WHEN 'implementation' THEN 4
        WHEN 'qa' THEN 5
        WHEN 'release' THEN 6
        WHEN 'support' THEN 7
      END ASC,
      n.maturity ASC
  \`, { projectId: '${projectId}' });
  const rows = result.records.map(r => ({
    nodeId: r.get('nodeId'),
    type: r.get('type'),
    phase: r.get('phase'),
    title: r.get('title'),
    maturity: typeof r.get('maturity') === 'object' ? r.get('maturity').toNumber() : r.get('maturity'),
    status: r.get('status'),
  }));
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await session.close();
  await driver.close();
}
"`;

  const flaggedNodesCmd = `node --input-type=module -e "
import neo4j from 'neo4j-driver';
const driver = neo4j.driver(process.env.MEMGRAPH_URI || 'bolt://localhost:7687');
const session = driver.session();
try {
  const result = await session.run(\`
    MATCH (n:Node)
    WHERE n.projectId = \\$projectId
      AND n.status = 'flagged'
    RETURN n.nodeId AS nodeId, n.type AS type, n.phase AS phase,
           n.title AS title, n.maturity AS maturity,
           n.missingSignals AS missingSignals, n.flagReason AS flagReason
    ORDER BY n.phase, n.maturity ASC
  \`, { projectId: '${projectId}' });
  const rows = result.records.map(r => ({
    nodeId: r.get('nodeId'),
    type: r.get('type'),
    phase: r.get('phase'),
    title: r.get('title'),
    maturity: typeof r.get('maturity') === 'object' ? r.get('maturity').toNumber() : r.get('maturity'),
    missingSignals: r.get('missingSignals'),
    flagReason: r.get('flagReason'),
  }));
  console.log(JSON.stringify(rows, null, 2));
} finally {
  await session.close();
  await driver.close();
}
"`;

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

      // Step 2: Query low-maturity nodes from Memgraph
      {
        id: 'query-low-maturity',
        stepType: 'shell',
        command: lowMaturityCmd,
        captureAs: 'LOW_MATURITY_NODES',
        allowFailure: true, // Continue even if Memgraph is unavailable
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

      // Step 4: Query flagged nodes from Memgraph
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

      // Step 7: Graph sync (ensure the reflection node is in Memgraph)
      {
        id: 'sync',
        stepType: 'shell',
        command: `node /home/ubuntu/scripts/graph-sync.mjs --project "${projectId}" --knowledge-dir "${knowledgeDir}"`,
        condition: 'NEW_KNOWLEDGE',
      },
    ],
  };
}
