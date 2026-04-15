/**
 * Pre-Development Phase Compilation Pipeline
 *
 * Compilation hook triggered after any document generation session in
 * pre-dev phases (Discovery, Planning, Solutioning). Decomposes PRDs,
 * architecture specs, and planning documents into knowledge nodes.
 *
 * Follows the same 3-step COMPILE pattern as story compilation:
 *   1. Shell step: extract document metadata
 *   2. Agent step: Knowledge Compiler creates/updates wiki articles
 *   3. Shell step: embed via Voyage AI + sync to Memgraph + impact propagation
 *
 * Usage:
 *   import { getPredevCompileSteps } from './predev-compile-pipeline.mjs';
 *   const steps = getPredevCompileSteps(projectId, agentType, documentPath);
 *   // Append steps to existing pipeline
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import neo4j from 'neo4j-driver';

// ── Agent-to-Article-Type Mapping ──

/**
 * Maps agent types to the article types they produce.
 * From architecture doc section 3.1.
 */
export const AGENT_ARTICLE_MAP = {
  pm:       ['prd', 'requirement', 'epic-plan', 'story-plan', 'risk'],
  analyst:  ['brief', 'research', 'evidence', 'competitive-analysis'],
  architect:['architecture', 'tech-spec', 'api-spec', 'data-model', 'adr'],
  ux:       ['ux-spec', 'design', 'user-journey'],
};

/**
 * Maps article types to their phase directory.
 * From architecture doc section 3.1.
 */
export const ARTICLE_PHASE_MAP = {
  // Discovery phase
  brainstorm:           'discovery',
  brief:                'discovery',
  research:             'discovery',
  evidence:             'discovery',
  'competitive-analysis': 'discovery',

  // Planning phase
  prd:                  'planning',
  requirement:          'planning',
  'epic-plan':          'planning',
  'story-plan':         'planning',
  risk:                 'planning',
  decision:             'planning',

  // Solutioning phase
  architecture:         'solutioning',
  'tech-spec':          'solutioning',
  'api-spec':           'solutioning',
  'data-model':         'solutioning',
  adr:                  'solutioning',
  'ux-spec':            'solutioning',
  design:               'solutioning',
  'user-journey':       'solutioning',
};

/**
 * Returns allowed article types for a given agent type.
 * @param {string} agentType - pm | analyst | architect | ux
 * @returns {string[]} Array of article type strings
 */
export function getArticleTypes(agentType) {
  return AGENT_ARTICLE_MAP[agentType] || [];
}

/**
 * Returns the phase directory name for a given article type.
 * @param {string} articleType
 * @returns {string} Phase directory name (discovery, planning, solutioning)
 */
export function getPhaseDir(articleType) {
  return ARTICLE_PHASE_MAP[articleType] || 'planning';
}

// ── Maturity Scoring ──

/**
 * Maturity scoring labels from architecture doc section 6.3.
 */
export const MATURITY_LABELS = [
  { min: 0.0, max: 0.2, label: 'Raw' },
  { min: 0.2, max: 0.4, label: 'Early' },
  { min: 0.4, max: 0.6, label: 'Partial' },
  { min: 0.6, max: 0.8, label: 'Solid' },
  { min: 0.8, max: 1.0, label: 'Ready' },
];

/**
 * Completeness signals for maturity scoring.
 * Each signal has a weight contributing to the final score.
 */
const MATURITY_SIGNALS = {
  hasPurpose:           { weight: 0.15, test: (content) => /^## Purpose/m.test(content) && content.split('## Purpose')[1]?.trim().length > 20 },
  hasDependencies:      { weight: 0.10, test: (content) => /^## Dependencies/m.test(content) && /\[\[/.test(content.split('## Dependencies')[1]?.split('##')[0] || '') },
  hasDerivedFrom:       { weight: 0.10, test: (content) => /^## Derived From/m.test(content) && /\[\[/.test(content.split('## Derived From')[1]?.split('##')[0] || '') },
  hasAcceptanceCriteria:{ weight: 0.15, test: (content) => /^## Acceptance Criteria/m.test(content) && content.split('## Acceptance Criteria')[1]?.trim().length > 10 },
  hasContext:           { weight: 0.10, test: (content) => /^## Context/m.test(content) && content.split('## Context')[1]?.trim().length > 20 },
  hasOptions:           { weight: 0.10, test: (content) => /^## Options Considered/m.test(content) },
  hasRationale:         { weight: 0.10, test: (content) => /^## Rationale/m.test(content) },
  hasConsequences:      { weight: 0.10, test: (content) => /^## Consequences/m.test(content) },
  hasSignals:           { weight: 0.05, test: (content) => /^## Signals/m.test(content) },
  hasMissingSignals:    { weight: 0.05, test: (content) => /^## Missing Signals/m.test(content) },
};

/**
 * Assess maturity score for a wiki article based on content completeness.
 * Returns a score from 0.0 to 1.0.
 *
 * @param {string} content - Full markdown content of the article
 * @param {string} articleType - The type of article (prd, architecture, etc.)
 * @returns {{ score: number, label: string, signals: string[], missing: string[] }}
 */
export function assessMaturity(content, articleType) {
  let score = 0;
  const signals = [];
  const missing = [];

  for (const [name, signal] of Object.entries(MATURITY_SIGNALS)) {
    try {
      if (signal.test(content)) {
        score += signal.weight;
        signals.push(name);
      } else {
        missing.push(name);
      }
    } catch {
      missing.push(name);
    }
  }

  // Bonus for substantial content length
  const wordCount = content.split(/\s+/).length;
  if (wordCount > 500) score = Math.min(1.0, score + 0.05);
  if (wordCount > 1000) score = Math.min(1.0, score + 0.05);

  // Round to 1 decimal place
  score = Math.round(score * 10) / 10;

  const label = MATURITY_LABELS.find(l => score >= l.min && score <= l.max)?.label || 'Raw';

  return { score, label, signals, missing };
}

/**
 * Get the maturity label for a score.
 * @param {number} score
 * @returns {string}
 */
export function getMaturityLabel(score) {
  return MATURITY_LABELS.find(l => score >= l.min && score <= l.max)?.label || 'Raw';
}

// ── Document Parsing ──

/**
 * Parse frontmatter from a markdown document.
 * Simple YAML frontmatter parser (no external dependency required).
 *
 * @param {string} content - Full markdown content
 * @returns {{ data: Object, content: string }}
 */
export function parseFrontmatter(content) {
  const fmRegex = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;
  const match = content.match(fmRegex);

  if (!match) {
    return { data: {}, content };
  }

  const yamlStr = match[1];
  const body = match[2];
  const data = {};

  for (const line of yamlStr.split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;

    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();

    // Parse arrays: [tag1, tag2, tag3]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim());
    }
    // Parse numbers
    else if (/^\d+\.\d+$/.test(value)) {
      value = parseFloat(value);
    }
    // Parse booleans
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;

    data[key] = value;
  }

  return { data, content: body };
}

/**
 * Serialize frontmatter data to YAML string.
 *
 * @param {Object} data - Frontmatter key-value pairs
 * @returns {string} YAML frontmatter block
 */
export function serializeFrontmatter(data) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) {
      lines.push(`${key}: [${value.join(', ')}]`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push('---');
  return lines.join('\n');
}

/**
 * Extract wikilinks from document content.
 * Matches [[path/to/article]] patterns.
 *
 * @param {string} content
 * @returns {string[]} Array of wikilink targets
 */
export function extractWikilinks(content) {
  const links = [];
  const regex = /\[\[([^\]]+)\]\]/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    links.push(match[1]);
  }
  return [...new Set(links)];
}

/**
 * Generate a slug from a document title or path.
 * Uses kebab-case for non-code files, -- for path separators in code files.
 *
 * @param {string} input - Title or file path
 * @param {boolean} isCode - Whether this is a code file path
 * @returns {string}
 */
export function generateSlug(input, isCode = false) {
  if (isCode) {
    // Code files: src/components/auth.tsx -> src--components--auth.tsx
    return input.replace(/\//g, '--');
  }
  // Non-code: kebab-case
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// ── Compilation Pipeline ──

/**
 * Create a wiki article from a generated document.
 *
 * @param {Object} opts
 * @param {string} opts.documentPath - Path to the source document
 * @param {string} opts.agentType - pm | analyst | architect | ux
 * @param {string} opts.projectId - Project identifier
 * @param {string} opts.knowledgeDir - Path to knowledge/ directory
 * @param {string} [opts.sessionId] - Pipeline session ID
 * @returns {{ articlePath: string, nodeId: string, maturity: Object, articleType: string }}
 */
export function compileDocument(opts) {
  const { documentPath, agentType, projectId, knowledgeDir, sessionId } = opts;

  // Read source document
  const rawContent = readFileSync(documentPath, 'utf-8');
  const { data: sourceFm, content: sourceBody } = parseFrontmatter(rawContent);

  // Determine article type from source frontmatter or agent mapping
  const allowedTypes = getArticleTypes(agentType);
  const articleType = sourceFm.type || allowedTypes[0] || 'document';
  const phase = getPhaseDir(articleType);

  // Generate slug and nodeId
  const title = sourceFm.title || basename(documentPath, '.md');
  const slug = generateSlug(title);
  const nodeId = `${phase}/${slug}`;

  // Assess maturity
  const maturity = assessMaturity(rawContent, articleType);

  // Build article frontmatter
  const now = new Date().toISOString().split('T')[0];
  const articleFm = {
    title,
    type: articleType,
    phase,
    status: 'active',
    maturity: maturity.score,
    created: sourceFm.created || now,
    updated: now,
    createdByEpic: sourceFm.createdByEpic || '',
    createdByStory: sourceFm.createdByStory || '',
    lastMutatedByStory: sourceFm.lastMutatedByStory || '',
    tags: sourceFm.tags || [],
  };

  // Extract existing wikilinks from source
  const existingLinks = extractWikilinks(rawContent);

  // Build article body
  const sections = [];

  // Purpose section
  const purposeMatch = sourceBody.match(/## Purpose\s*\n([\s\S]*?)(?=\n## |\n*$)/);
  if (purposeMatch) {
    sections.push(`## Purpose\n${purposeMatch[1].trim()}`);
  } else {
    // Use first paragraph as purpose
    const firstPara = sourceBody.trim().split('\n\n')[0] || '';
    sections.push(`## Purpose\n${firstPara}`);
  }

  // Dependencies section with wikilinks
  const depLinks = existingLinks.filter(l => !l.startsWith('decisions/'));
  if (depLinks.length > 0) {
    sections.push(`## Dependencies\n${depLinks.map(l => `- [[${l}]]`).join('\n')}`);
  }

  // Derived From section
  const derivedLinks = existingLinks.filter(l =>
    l.includes('discovery/') || l.includes('planning/') || l.includes('prd')
  );
  if (derivedLinks.length > 0) {
    sections.push(`## Derived From\n${derivedLinks.map(l => `- [[${l}]]`).join('\n')}`);
  }

  // Informs section
  const informLinks = existingLinks.filter(l =>
    l.includes('code/') || l.includes('solutioning/')
  );
  if (informLinks.length > 0) {
    sections.push(`## Informs\n${informLinks.map(l => `- [[${l}]]`).join('\n')}`);
  }

  // Copy over standard sections from source if present
  for (const sectionName of ['Acceptance Criteria', 'Context', 'Options Considered', 'Chosen Option', 'Rationale', 'Consequences', 'Key Exports', 'Notes']) {
    const sectionRegex = new RegExp(`## ${sectionName}\\s*\\n([\\s\\S]*?)(?=\\n## |\\n*$)`);
    const sectionMatch = sourceBody.match(sectionRegex);
    if (sectionMatch) {
      sections.push(`## ${sectionName}\n${sectionMatch[1].trim()}`);
    }
  }

  // Signals section
  sections.push(`## Signals\n${maturity.signals.map(s => `- ${s}`).join('\n')}`);

  // Missing Signals section
  if (maturity.missing.length > 0) {
    sections.push(`## Missing Signals\n${maturity.missing.map(s => `- ${s}`).join('\n')}`);
  }

  // Write article
  const articleContent = `${serializeFrontmatter(articleFm)}\n\n${sections.join('\n\n')}\n`;
  const phaseDir = join(knowledgeDir, phase);
  if (!existsSync(phaseDir)) {
    mkdirSync(phaseDir, { recursive: true });
  }
  const articlePath = join(phaseDir, `${slug}.md`);
  writeFileSync(articlePath, articleContent, 'utf-8');

  return { articlePath, nodeId, maturity, articleType, phase, title, slug };
}

// ── Impact Propagation ──

/**
 * Edge weights from architecture doc section 6.2.
 */
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

/**
 * Impact score formula from architecture doc section 6.2:
 *   impact = edge_weight / (hops ^ 1.5)
 * Thresholds: >= 0.5 critical, >= 0.1 moderate, < 0.1 no flag.
 *
 * @param {number} edgeWeight
 * @param {number} hops
 * @returns {{ score: number, severity: string }}
 */
export function computeImpactScore(edgeWeight, hops) {
  const score = edgeWeight / Math.pow(Math.max(hops, 1), 1.5);
  let severity = 'none';
  if (score >= 0.5) severity = 'critical';
  else if (score >= 0.1) severity = 'moderate';
  return { score: Math.round(score * 1000) / 1000, severity };
}

/**
 * Run impact propagation after a node update.
 * Queries Memgraph for downstream nodes and flags them for review.
 *
 * @param {string} updatedNodeId - The node that was updated
 * @param {string} projectId - Project identifier
 * @param {import('neo4j-driver').Driver} driver - Neo4j/Memgraph driver
 * @returns {Promise<Array<{ nodeId: string, type: string, title: string, severity: string }>>}
 */
export async function runImpactPropagation(updatedNodeId, projectId, driver) {
  const session = driver.session();
  const flagged = [];

  try {
    const result = await session.run(
      `MATCH (updated:Node {nodeId: $updatedNodeId, projectId: $projectId})
       MATCH path = (updated)-[:INFORMS|ENABLES|DERIVED_FROM*1..4]->(downstream:Node)
       WHERE downstream.status = 'active'
       RETURN downstream.nodeId AS nodeId,
              downstream.type AS type,
              downstream.title AS title,
              length(path) AS hops`,
      { updatedNodeId, projectId }
    );

    for (const record of result.records) {
      const nodeId = record.get('nodeId');
      const type = record.get('type');
      const title = record.get('title');
      const hops = typeof record.get('hops') === 'object'
        ? record.get('hops').toNumber()
        : record.get('hops');

      const { severity } = computeImpactScore(EDGE_WEIGHTS.DERIVED_FROM, hops);

      if (severity !== 'none') {
        // Flag the downstream node
        await session.run(
          `MATCH (n:Node {nodeId: $nodeId, projectId: $projectId})
           SET n.status = 'flagged',
               n.flagReason = 'Upstream node ' + $updatedNodeId + ' was modified (' + $severity + ')'`,
          { nodeId, projectId, updatedNodeId, severity }
        );
        flagged.push({ nodeId, type, title, severity });
      }
    }
  } finally {
    await session.close();
  }

  return flagged;
}

// ── Compilation Log ──

/**
 * Append a compilation record to knowledge/log.md.
 *
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @param {Object} entry
 * @param {string} entry.sessionId
 * @param {string} entry.agentType
 * @param {string} entry.articleType
 * @param {string} entry.nodeId
 * @param {number} entry.maturityScore
 */
export function appendCompilationLog(knowledgeDir, entry) {
  const logPath = join(knowledgeDir, 'log.md');
  const timestamp = new Date().toISOString();
  const logLine = `| ${timestamp} | ${entry.sessionId || '-'} | ${entry.agentType} | ${entry.articleType} | ${entry.nodeId} | ${entry.maturityScore} |\n`;

  let existing = '';
  if (existsSync(logPath)) {
    existing = readFileSync(logPath, 'utf-8');
  } else {
    // Create log file with header
    existing = `# Knowledge Compilation Log\n\n| Timestamp | Session | Agent | Article Type | Node ID | Maturity |\n|-----------|---------|-------|-------------|---------|----------|\n`;
    const logDir = dirname(logPath);
    if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  }

  writeFileSync(logPath, existing + logLine, 'utf-8');
}

// ── Pipeline Step Generation ──

/**
 * Generate the 3-step COMPILE sequence for pre-dev document compilation.
 *
 * Returns pipeline steps following the existing PipelineStep interface:
 *   Step 1 (shell): Extract document metadata — $0 cost
 *   Step 2 (agent): Knowledge Compiler creates/updates wiki articles
 *   Step 3 (shell): Embed + sync + impact propagation via graph-sync.mjs
 *
 * @param {string} projectId - Project identifier
 * @param {string} agentType - pm | analyst | architect | ux
 * @param {string} documentPath - Path to the generated document
 * @returns {import('../../functions/shared/types/agent-orchestrator.js').PipelineStep[]}
 */
export function getPredevCompileSteps(projectId, agentType, documentPath) {
  const compilePrefix = 'compile-predev';

  return [
    // Step 1: Shell — extract document metadata ($0)
    {
      id: `${compilePrefix}-extract`,
      stepType: 'shell',
      command: `cat "${documentPath}" | head -30`,
      timeout: 10000,
      captureAs: 'PREDEV_DOC_HEAD',
    },

    // Step 2: Agent — Knowledge Compiler decomposes document into wiki articles
    {
      id: `${compilePrefix}-compile`,
      stepType: 'agent',
      agentId: 'knowledge-compiler',
      prompt: `You are the Knowledge Compiler. Compile the following document into a wiki article.

Document path: ${documentPath}
Project: ${projectId}
Agent type: ${agentType}
Allowed article types: ${getArticleTypes(agentType).join(', ')}

Document head:
{{PREDEV_DOC_HEAD}}

Instructions:
1. Read the full document at ${documentPath}
2. Determine the article type from content and agent type
3. Create/update the wiki article in the appropriate knowledge/{phase}/ directory
4. Generate [[wikilinks]] to related existing nodes
5. Assess maturity and set the score in frontmatter
6. Report the nodeId, article type, maturity score, and any wikilinks created`,
      extractors: {
        COMPILED_NODE_ID: {
          type: 'regex',
          pattern: 'nodeId:\\s*(.+)',
        },
        COMPILED_MATURITY: {
          type: 'regex',
          pattern: 'maturity:\\s*([\\d.]+)',
        },
      },
    },

    // Step 3: Shell — embed + sync + impact propagation
    {
      id: `${compilePrefix}-sync`,
      stepType: 'shell',
      command: `node /home/ubuntu/scripts/graph-sync.mjs --project ${projectId} --knowledge-dir "$(dirname "${documentPath}")/../knowledge"`,
      timeout: 60000,
      captureAs: 'PREDEV_SYNC_RESULT',
    },
  ];
}

/**
 * Full pre-dev compilation entry point.
 * Reads the document, compiles it to a wiki article, logs the result.
 * Does NOT run graph-sync or impact propagation (those are separate shell steps).
 *
 * @param {Object} opts
 * @param {string} opts.projectId
 * @param {string} opts.documentPath
 * @param {string} opts.agentType
 * @param {string} opts.sessionId
 * @param {string} opts.knowledgeDir
 * @returns {{ articlePath: string, nodeId: string, maturity: Object, articleType: string }}
 */
export function compilePredev(opts) {
  const { projectId, documentPath, agentType, sessionId, knowledgeDir } = opts;

  // Compile the document
  const result = compileDocument({
    documentPath,
    agentType,
    projectId,
    knowledgeDir,
    sessionId,
  });

  // Log the compilation
  appendCompilationLog(knowledgeDir, {
    sessionId,
    agentType,
    articleType: result.articleType,
    nodeId: result.nodeId,
    maturityScore: result.maturity.score,
  });

  return result;
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);
  const opts = {};

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project' && args[i + 1]) opts.projectId = args[++i];
    else if (args[i] === '--document-path' && args[i + 1]) opts.documentPath = args[++i];
    else if (args[i] === '--agent-type' && args[i + 1]) opts.agentType = args[++i];
    else if (args[i] === '--session-id' && args[i + 1]) opts.sessionId = args[++i];
    else if (args[i] === '--knowledge-dir' && args[i + 1]) opts.knowledgeDir = args[++i];
  }

  if (!opts.projectId || !opts.documentPath || !opts.agentType) {
    console.error('Usage: node predev-compile-pipeline.mjs --project <id> --document-path <path> --agent-type <pm|analyst|architect|ux> [--session-id <id>] [--knowledge-dir <path>]');
    process.exit(1);
  }

  if (!opts.knowledgeDir) {
    opts.knowledgeDir = join(dirname(opts.documentPath), '..', 'knowledge');
  }

  console.log(`[predev-compile] Starting compilation for ${opts.agentType} document: ${opts.documentPath}`);

  const result = compilePredev(opts);

  console.log(`[predev-compile] Compiled: nodeId=${result.nodeId}, type=${result.articleType}, maturity=${result.maturity.score} (${result.maturity.label})`);
  console.log(`[predev-compile] Article written to: ${result.articlePath}`);

  // If Memgraph is available, run impact propagation
  const boltUri = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
  let driver;
  try {
    driver = neo4j.driver(boltUri);
    const flagged = await runImpactPropagation(result.nodeId, opts.projectId, driver);
    if (flagged.length > 0) {
      console.log(`[predev-compile] Impact propagation flagged ${flagged.length} downstream nodes:`);
      for (const f of flagged) {
        console.log(`  - ${f.nodeId} (${f.type}) — ${f.severity}`);
      }
    } else {
      console.log('[predev-compile] No downstream nodes flagged.');
    }
  } catch (err) {
    console.warn(`[predev-compile] Memgraph unavailable, skipping impact propagation: ${err.message}`);
  } finally {
    if (driver) await driver.close();
  }
}

// Run CLI if this is the entry point
const isMain = process.argv[1] && (
  process.argv[1].endsWith('predev-compile-pipeline.mjs') ||
  process.argv[1].endsWith('predev-compile-pipeline')
);
if (isMain) {
  main().catch(err => {
    console.error(`[predev-compile] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
