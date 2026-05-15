/**
 * Decision Extraction from Architecture Sessions
 *
 * Takes architecture session output, identifies technology choices, pattern
 * selections, API design decisions. Creates decision articles in
 * knowledge/decisions/ following ADR format (context, options, chosen,
 * rationale, consequences).
 *
 * Creates:
 *   - DERIVED_FROM edges to requirements (weight 0.7)
 *   - INFORMS edges to placeholder code articles (weight 0.3, status: suggested)
 *   - CONFLICTS_WITH edges between contradicting decisions (weight 0.9, bidirectional)
 *
 * Usage:
 *   import { extractDecisions } from './extract-decisions.mjs';
 *   const results = await extractDecisions(sessionOutput, knowledgeDir);
 *
 * CLI:
 *   node extract-decisions.mjs --input <path> --knowledge-dir <dir> [--project <id>]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import { createDriver } from './lib/memgraph-driver.mjs';
import {
  parseFrontmatter,
  serializeFrontmatter,
  getMaturityLabel,
  appendCompilationLog,
  EDGE_WEIGHTS,
} from '../pipelines/predev-compile-pipeline.mjs';

// ── Decision Pattern Detection ──

/**
 * Patterns that indicate an architectural decision in text.
 */
const DECISION_PATTERNS = [
  // Technology choices: "we chose X over Y", "decided to use X"
  { pattern: /(?:we\s+)?(?:chose|selected|picked|decided\s+(?:to\s+use|on))\s+(.+?)(?:\s+(?:over|instead\s+of|rather\s+than)\s+(.+?))?[.;,\n]/gi, type: 'technology-choice' },
  // Pattern selections: "using the X pattern", "adopted X approach"
  { pattern: /(?:using|adopt(?:ed|ing)?|implement(?:ed|ing)?)\s+(?:the\s+)?(.+?)\s+(?:pattern|approach|strategy|methodology)[.;,\n]/gi, type: 'pattern-selection' },
  // API design: "REST over GraphQL", "will expose X API"
  { pattern: /(?:REST|GraphQL|gRPC|WebSocket|SSE)\s+(?:over|instead\s+of|vs\.?)\s+(?:REST|GraphQL|gRPC|WebSocket|SSE)/gi, type: 'api-design' },
  // Data model: "single table vs multi-table", "normalized vs denormalized"
  { pattern: /(?:single.?table|multi.?table|normalized|denormalized|relational|document|graph)\s+(?:vs\.?|over|design|model|approach)/gi, type: 'data-model' },
  // Explicit ADR markers
  { pattern: /^##\s+(?:ADR|Decision|Architecture Decision)/gmi, type: 'explicit-adr' },
];

/**
 * Structural patterns for parsing explicit ADR sections within a document.
 */
const ADR_SECTION_PATTERNS = {
  context: /^##\s*(?:Context|Background|Problem)\s*\n([\s\S]*?)(?=^##\s|\n*$)/gm,
  options: /^##\s*(?:Options?\s*Considered|Alternatives|Options)\s*\n([\s\S]*?)(?=^##\s|\n*$)/gm,
  chosen: /^##\s*(?:Chosen\s*Option|Decision|Selected\s*Option|Resolution)\s*\n([\s\S]*?)(?=^##\s|\n*$)/gm,
  rationale: /^##\s*(?:Rationale|Justification|Reasoning|Why)\s*\n([\s\S]*?)(?=^##\s|\n*$)/gm,
  consequences: /^##\s*(?:Consequences|Trade-?offs|Impact|Implications)\s*\n([\s\S]*?)(?=^##\s|\n*$)/gm,
};

/**
 * Extract decisions from architecture session output.
 *
 * @param {string} content - Full text of architecture document or session output
 * @param {string} docSlug - Slug of the source document
 * @returns {Array<{
 *   slug: string,
 *   title: string,
 *   decisionType: string,
 *   context: string,
 *   optionsConsidered: string[],
 *   chosenOption: string,
 *   rationale: string,
 *   consequences: string,
 *   tags: string[],
 *   sourceSection: string
 * }>}
 */
export function parseDecisions(content, docSlug) {
  const { content: body } = parseFrontmatter(content);
  const decisions = [];

  // Strategy 1: Explicit ADR sections (well-structured documents)
  const explicitDecisions = extractExplicitADRs(body, docSlug);
  decisions.push(...explicitDecisions);

  // Strategy 2: Implicit decisions from decision language patterns
  if (decisions.length === 0) {
    const implicitDecisions = extractImplicitDecisions(body, docSlug);
    decisions.push(...implicitDecisions);
  }

  // Deduplicate by title similarity
  return deduplicateDecisions(decisions);
}

/**
 * Extract explicitly structured ADR sections from the document.
 *
 * @param {string} body - Document body (without frontmatter)
 * @param {string} docSlug
 * @returns {Array}
 */
function extractExplicitADRs(body, docSlug) {
  const decisions = [];

  // Look for ADR-style sections (## ADR: Title or ## Decision: Title)
  const adrHeadingRegex = /^##\s+(?:ADR|Decision|Architecture Decision)\s*[:—-]?\s*(.+)$/gm;
  let match;
  const adrStarts = [];

  while ((match = adrHeadingRegex.exec(body)) !== null) {
    adrStarts.push({ title: match[1].trim(), index: match.index });
  }

  for (let i = 0; i < adrStarts.length; i++) {
    const start = adrStarts[i].index;
    const end = i + 1 < adrStarts.length ? adrStarts[i + 1].index : body.length;
    const section = body.slice(start, end);

    const title = adrStarts[i].title;
    const slug = `${docSlug}--${generateDecisionSlug(title)}`;

    decisions.push({
      slug,
      title,
      decisionType: 'explicit-adr',
      context: extractSection(section, 'Context') || extractSection(section, 'Background') || '',
      optionsConsidered: extractOptionsList(section),
      chosenOption: extractSection(section, 'Chosen Option') || extractSection(section, 'Decision') || '',
      rationale: extractSection(section, 'Rationale') || extractSection(section, 'Justification') || '',
      consequences: extractSection(section, 'Consequences') || extractSection(section, 'Trade-offs') || '',
      tags: deriveDecisionTags(title + ' ' + section),
      sourceSection: title,
    });
  }

  return decisions;
}

/**
 * Extract implicit decisions from decision language in the document.
 *
 * @param {string} body
 * @param {string} docSlug
 * @returns {Array}
 */
function extractImplicitDecisions(body, docSlug) {
  const decisions = [];
  const seen = new Set();

  // Split into sections
  const sections = body.split(/^##\s+/gm).filter(s => s.trim());

  for (const section of sections) {
    const heading = section.split('\n')[0].trim();
    const sectionBody = section.slice(heading.length).trim();

    for (const { pattern, type } of DECISION_PATTERNS) {
      // Reset regex lastIndex
      pattern.lastIndex = 0;
      let match;

      while ((match = pattern.exec(sectionBody)) !== null) {
        const chosenTech = match[1]?.trim() || match[0].trim();
        const alternative = match[2]?.trim() || '';

        // Avoid duplicates based on the matched text
        const key = chosenTech.toLowerCase().slice(0, 50);
        if (seen.has(key)) continue;
        seen.add(key);

        const title = buildDecisionTitle(chosenTech, alternative, type);
        const slug = `${docSlug}--${generateDecisionSlug(title)}`;

        // Extract surrounding context (paragraph containing the decision)
        const matchIdx = match.index;
        const paraStart = sectionBody.lastIndexOf('\n\n', matchIdx);
        const paraEnd = sectionBody.indexOf('\n\n', matchIdx + match[0].length);
        const contextPara = sectionBody.slice(
          paraStart >= 0 ? paraStart : 0,
          paraEnd >= 0 ? paraEnd : sectionBody.length
        ).trim();

        decisions.push({
          slug,
          title,
          decisionType: type,
          context: contextPara,
          optionsConsidered: alternative
            ? [chosenTech, alternative]
            : [chosenTech],
          chosenOption: chosenTech,
          rationale: contextPara,
          consequences: '',
          tags: deriveDecisionTags(title + ' ' + contextPara),
          sourceSection: heading,
        });
      }
    }
  }

  return decisions;
}

/**
 * Extract a named section's content from text.
 */
function extractSection(text, sectionName) {
  const regex = new RegExp(`^###?\\s+${sectionName}\\s*\\n([\\s\\S]*?)(?=^###?\\s|\\n*$)`, 'gm');
  const match = regex.exec(text);
  return match ? match[1].trim() : '';
}

/**
 * Extract a list of options from an "Options Considered" section.
 */
function extractOptionsList(text) {
  const section = extractSection(text, 'Options Considered') || extractSection(text, 'Alternatives') || '';
  if (!section) return [];

  const items = [];
  const itemRegex = /^[\s]*(?:[-*]|\d+[.)]) (.+)$/gm;
  let match;
  while ((match = itemRegex.exec(section)) !== null) {
    items.push(match[1].trim());
  }
  return items;
}

/**
 * Build a concise decision title.
 */
function buildDecisionTitle(chosen, alternative, type) {
  const typeLabels = {
    'technology-choice': 'Technology Choice',
    'pattern-selection': 'Pattern Selection',
    'api-design': 'API Design',
    'data-model': 'Data Model Decision',
    'explicit-adr': 'Architecture Decision',
  };
  const label = typeLabels[type] || 'Decision';

  if (alternative) {
    return `${label} - ${chosen} over ${alternative}`;
  }
  return `${label} - ${chosen}`;
}

/**
 * Generate a kebab-case slug for a decision.
 */
function generateDecisionSlug(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

/**
 * Derive tags from decision text.
 */
function deriveDecisionTags(text) {
  const tags = ['architecture-decision'];
  const lower = text.toLowerCase();

  const tagPatterns = [
    [/auth(?:entication|orization)/i, 'authentication'],
    [/jwt|token/i, 'jwt'],
    [/security/i, 'security'],
    [/rest\b/i, 'rest'],
    [/graphql/i, 'graphql'],
    [/grpc/i, 'grpc'],
    [/websocket|sse/i, 'realtime'],
    [/database|dynamo|postgres|mongo|memgraph/i, 'database'],
    [/cache|redis/i, 'caching'],
    [/lambda|serverless/i, 'serverless'],
    [/s3|storage/i, 'storage'],
    [/cloudfront|cdn/i, 'cdn'],
    [/docker|container/i, 'containers'],
    [/react|vue|angular|svelte/i, 'frontend'],
    [/node|express|fastify/i, 'backend'],
    [/test|jest|vitest/i, 'testing'],
    [/ci.?cd|deploy|pipeline/i, 'deployment'],
    [/micro.?service|monolith/i, 'architecture'],
    [/pattern/i, 'design-pattern'],
  ];

  for (const [pattern, tag] of tagPatterns) {
    if (pattern.test(lower)) tags.push(tag);
  }

  return [...new Set(tags)];
}

/**
 * Deduplicate decisions by title similarity.
 */
function deduplicateDecisions(decisions) {
  const seen = new Map();
  const result = [];

  for (const d of decisions) {
    const key = d.slug.toLowerCase();
    if (!seen.has(key)) {
      seen.set(key, true);
      result.push(d);
    }
  }

  return result;
}

// ── Decision Maturity Assessment ──

/**
 * Assess maturity for a decision article.
 * ADR nodes are scored based on completeness:
 *   - Context stated: +0.15
 *   - Options evaluated: +0.15
 *   - Chosen option identified: +0.15
 *   - Rationale documented: +0.15
 *   - Consequences identified: +0.10
 *   - Linked to requirements: +0.15 (assessed later)
 *   - Linked to code: +0.15 (assessed later)
 *
 * @param {Object} decision
 * @returns {{ score: number, label: string, signals: string[], missing: string[] }}
 */
export function assessDecisionMaturity(decision) {
  let score = 0;
  const signals = [];
  const missing = [];

  if (decision.context && decision.context.length > 20) {
    score += 0.15;
    signals.push('Context clearly stated');
  } else {
    missing.push('Context missing or too brief');
  }

  if (decision.optionsConsidered && decision.optionsConsidered.length >= 2) {
    score += 0.15;
    signals.push(`${decision.optionsConsidered.length} options evaluated`);
  } else if (decision.optionsConsidered && decision.optionsConsidered.length === 1) {
    score += 0.05;
    signals.push('Single option noted (no alternatives)');
    missing.push('Only one option considered');
  } else {
    missing.push('No options considered');
  }

  if (decision.chosenOption && decision.chosenOption.length > 5) {
    score += 0.15;
    signals.push('Chosen option identified');
  } else {
    missing.push('No chosen option');
  }

  if (decision.rationale && decision.rationale.length > 20) {
    score += 0.15;
    signals.push('Rationale documented');
  } else {
    missing.push('Rationale missing or too brief');
  }

  if (decision.consequences && decision.consequences.length > 10) {
    score += 0.10;
    signals.push('Consequences identified');
  } else {
    missing.push('Consequences not documented');
  }

  // Future linkage signals
  missing.push('No requirement linkage yet');
  missing.push('No code linkage yet');

  score = Math.round(score * 10) / 10;
  const label = getMaturityLabel(score);

  return { score, label, signals, missing };
}

// ── Placeholder Code Article Creation ──

/**
 * Infer placeholder code files from a decision.
 * Analyzes the chosen option and context to predict what code files
 * the architecture implies will exist.
 *
 * @param {Object} decision
 * @returns {Array<{ slug: string, title: string, description: string }>}
 */
export function inferPlaceholderCode(decision) {
  const placeholders = [];
  const lower = (decision.chosenOption + ' ' + decision.context + ' ' + decision.rationale).toLowerCase();

  // Common patterns: technology -> implied code files
  const codeInferences = [
    { test: /jwt|auth(?:entication)/i, files: [
      { slug: 'src--utils--jwt', title: 'src/utils/jwt.ts', desc: 'JWT token validation, refresh, and rotation utilities' },
      { slug: 'src--api--auth-api', title: 'src/api/auth-api.ts', desc: 'Authentication API endpoints (login, logout, refresh)' },
      { slug: 'src--components--auth', title: 'src/components/auth.tsx', desc: 'Authentication UI component and context provider' },
    ]},
    { test: /rest\s+api|api.?first/i, files: [
      { slug: 'src--api--client', title: 'src/api/client.ts', desc: 'REST API client with request/response handling' },
    ]},
    { test: /graphql/i, files: [
      { slug: 'src--graphql--client', title: 'src/graphql/client.ts', desc: 'GraphQL client configuration' },
      { slug: 'src--graphql--schema', title: 'src/graphql/schema.ts', desc: 'GraphQL schema definitions' },
    ]},
    { test: /dynamo|database|data.?store/i, files: [
      { slug: 'src--db--client', title: 'src/db/client.ts', desc: 'Database client and connection management' },
    ]},
    { test: /lambda|serverless/i, files: [
      { slug: 'functions--handler', title: 'functions/handler.ts', desc: 'Serverless function handler' },
    ]},
    { test: /s3|storage|upload/i, files: [
      { slug: 'src--utils--storage', title: 'src/utils/storage.ts', desc: 'S3/storage utilities for file operations' },
    ]},
    { test: /cache|redis/i, files: [
      { slug: 'src--utils--cache', title: 'src/utils/cache.ts', desc: 'Caching layer implementation' },
    ]},
    { test: /websocket|realtime|sse/i, files: [
      { slug: 'src--utils--realtime', title: 'src/utils/realtime.ts', desc: 'Real-time communication handler (WebSocket/SSE)' },
    ]},
  ];

  for (const { test, files } of codeInferences) {
    if (test.test(lower)) {
      for (const file of files) {
        placeholders.push({
          slug: file.slug,
          title: file.title,
          description: file.desc,
        });
      }
    }
  }

  return placeholders;
}

/**
 * Create a placeholder code article (status: suggested, maturity: 0.1).
 *
 * @param {Object} placeholder
 * @param {string} decisionNodeId - Node ID of the parent decision
 * @param {string} knowledgeDir
 * @returns {string} Path to created article
 */
export function createPlaceholderCodeArticle(placeholder, decisionNodeId, knowledgeDir) {
  const now = new Date().toISOString().split('T')[0];

  const frontmatter = {
    title: placeholder.title,
    type: 'code',
    phase: 'implementation',
    status: 'suggested',
    maturity: 0.1,
    created: now,
    updated: now,
    tags: ['placeholder', 'suggested'],
  };

  const content = `${serializeFrontmatter(frontmatter)}

## Purpose
${placeholder.description}

## Derived From
- [[${decisionNodeId}]] -- Architecture decision driving this implementation

## Signals
- Placeholder created from architecture decision
- Implementation not yet started

## Missing Signals
- Code not yet written
- No tests
- No review
`;

  const codeDir = join(knowledgeDir, 'code');
  if (!existsSync(codeDir)) {
    mkdirSync(codeDir, { recursive: true });
  }

  const articlePath = join(codeDir, `${placeholder.slug}.md`);
  writeFileSync(articlePath, content, 'utf-8');

  return articlePath;
}

// ── Conflict Detection ──

/**
 * Detect conflicts between a new decision and existing decisions.
 * Uses tag overlap and optionally vector similarity (when Memgraph is available).
 *
 * @param {Object} newDecision - The new decision to check
 * @param {string} projectId
 * @param {import('neo4j-driver').Driver} [driver] - Optional Memgraph driver
 * @returns {Promise<Array<{ nodeId: string, title: string, sharedTags: string[], similarity: number }>>}
 */
export async function detectConflicts(newDecision, projectId, driver) {
  const conflicts = [];

  if (!driver) return conflicts;

  const session = driver.session();
  try {
    // Query existing decisions with overlapping tags
    const result = await session.run(
      `MATCH (d:Node {type: 'adr', projectId: $projectId, status: 'active'})
       WHERE d.nodeId <> $newNodeId
         AND any(tag IN d.tags WHERE tag IN $newTags)
       RETURN d.nodeId AS nodeId, d.title AS title, d.tags AS tags`,
      {
        projectId,
        newNodeId: `decisions/${newDecision.slug}`,
        newTags: newDecision.tags,
      }
    );

    for (const record of result.records) {
      const existingTags = record.get('tags') || [];
      const sharedTags = newDecision.tags.filter(t => existingTags.includes(t) && t !== 'architecture-decision');

      if (sharedTags.length > 0) {
        conflicts.push({
          nodeId: record.get('nodeId'),
          title: record.get('title'),
          sharedTags,
          similarity: sharedTags.length / Math.max(newDecision.tags.length, existingTags.length),
        });
      }
    }
  } finally {
    await session.close();
  }

  return conflicts;
}

/**
 * Create CONFLICTS_WITH edges between two decisions.
 * Bidirectional: creates edge in both directions (weight 0.9).
 *
 * @param {string} nodeId1
 * @param {string} nodeId2
 * @param {string} projectId
 * @param {import('neo4j-driver').Driver} driver
 */
export async function createConflictEdges(nodeId1, nodeId2, projectId, driver) {
  const session = driver.session();
  try {
    await session.run(
      `MATCH (d1:Node {nodeId: $nodeId1, projectId: $projectId})
       MATCH (d2:Node {nodeId: $nodeId2, projectId: $projectId})
       MERGE (d1)-[:CONFLICTS_WITH {weight: 0.9}]->(d2)
       MERGE (d2)-[:CONFLICTS_WITH {weight: 0.9}]->(d1)`,
      { nodeId1, nodeId2, projectId }
    );
  } finally {
    await session.close();
  }
}

// ── ADR Article Creation ──

/**
 * Create a decision article in ADR format.
 *
 * @param {Object} decision - Extracted decision
 * @param {string} knowledgeDir
 * @param {Object} [opts]
 * @param {string[]} [opts.linkedRequirements] - Requirement nodeIds
 * @param {Array} [opts.placeholders] - Placeholder code articles
 * @param {Array} [opts.conflicts] - Conflicting decisions
 * @returns {string} Path to created article
 */
export function createDecisionArticle(decision, knowledgeDir, opts = {}) {
  const maturity = assessDecisionMaturity(decision);
  const now = new Date().toISOString().split('T')[0];
  const nodeId = `decisions/${decision.slug}`;

  const frontmatter = {
    title: decision.title,
    type: 'adr',
    phase: 'solutioning',
    status: 'active',
    maturity: maturity.score,
    created: now,
    updated: now,
    decisionType: decision.decisionType,
    tags: decision.tags,
  };

  const sections = [];

  // Context
  sections.push(`## Context\n${decision.context || '(Context not yet documented)'}`);

  // Options Considered
  if (decision.optionsConsidered.length > 0) {
    const optionsList = decision.optionsConsidered
      .map((opt, i) => `${i + 1}. **${opt}**`)
      .join('\n');
    sections.push(`## Options Considered\n${optionsList}`);
  }

  // Chosen Option
  sections.push(`## Chosen Option\n${decision.chosenOption || '(Not yet decided)'}`);

  // Rationale
  sections.push(`## Rationale\n${decision.rationale || '(Rationale not yet documented)'}`);

  // Consequences
  sections.push(`## Consequences\n${decision.consequences || '(Consequences not yet analyzed)'}`);

  // Derived From (linked requirements)
  const linkedReqs = opts.linkedRequirements || [];
  if (linkedReqs.length > 0) {
    sections.push(`## Derived From\n${linkedReqs.map(r => `- [[${r}]]`).join('\n')}`);
  } else {
    sections.push('## Derived From\n(No requirements linked yet)');
  }

  // Informs (placeholder code)
  const placeholders = opts.placeholders || [];
  if (placeholders.length > 0) {
    sections.push(`## Informs\n${placeholders.map(p => `- [[code/${p.slug}]] (suggested)`).join('\n')}`);
  }

  // Conflicts With
  const conflicts = opts.conflicts || [];
  if (conflicts.length > 0) {
    sections.push(`## Conflicts With\n${conflicts.map(c => `- [[${c.nodeId}]] -- shared domain: ${c.sharedTags.join(', ')}`).join('\n')}`);
  }

  // Signals
  sections.push(`## Signals\n${maturity.signals.map(s => `- ${s}`).join('\n')}`);

  // Missing Signals
  if (maturity.missing.length > 0) {
    sections.push(`## Missing Signals\n${maturity.missing.map(s => `- ${s}`).join('\n')}`);
  }

  // Write article
  const articleContent = `${serializeFrontmatter(frontmatter)}\n\n${sections.join('\n\n')}\n`;
  const decDir = join(knowledgeDir, 'decisions');
  if (!existsSync(decDir)) {
    mkdirSync(decDir, { recursive: true });
  }
  const articlePath = join(decDir, `${decision.slug}.md`);
  writeFileSync(articlePath, articleContent, 'utf-8');

  return articlePath;
}

// ── Requirement Matching ──

/**
 * Match a decision to existing requirement nodes by keyword and tag overlap.
 * When Memgraph is available, also uses semantic similarity.
 *
 * @param {Object} decision
 * @param {string} projectId
 * @param {import('neo4j-driver').Driver} [driver]
 * @returns {Promise<string[]>} Array of requirement nodeIds
 */
export async function matchRequirements(decision, projectId, driver) {
  const matched = [];

  if (!driver) return matched;

  const session = driver.session();
  try {
    // Match by tag overlap
    const result = await session.run(
      `MATCH (req:Node {type: 'requirement', projectId: $projectId, status: 'active'})
       WHERE any(tag IN req.tags WHERE tag IN $decisionTags AND tag <> 'architecture-decision' AND tag <> 'functional' AND tag <> 'non-functional')
       RETURN req.nodeId AS nodeId, req.title AS title, req.tags AS tags`,
      { projectId, decisionTags: decision.tags }
    );

    for (const record of result.records) {
      matched.push(record.get('nodeId'));
    }
  } finally {
    await session.close();
  }

  return matched;
}

// ── Architecture Revision Handling ──

/**
 * Handle revisions to architecture documents.
 * Diff against existing decision nodes — update changed, add new,
 * mark obsolete as superseded.
 *
 * @param {Array} newDecisions - Newly extracted decisions
 * @param {string} docSlug - Source document slug
 * @param {string} knowledgeDir
 * @returns {{ added: string[], updated: string[], superseded: string[] }}
 */
export function handleDecisionRevision(newDecisions, docSlug, knowledgeDir) {
  const decDir = join(knowledgeDir, 'decisions');
  const added = [];
  const updated = [];
  const superseded = [];

  // Gather existing decisions from this document
  const existingSlugs = new Set();
  if (existsSync(decDir)) {
    for (const file of readdirSync(decDir)) {
      if (file.startsWith(docSlug + '--') && file.endsWith('.md')) {
        existingSlugs.add(file.replace('.md', ''));
      }
    }
  }

  const newSlugs = new Set(newDecisions.map(d => d.slug));

  for (const d of newDecisions) {
    if (existingSlugs.has(d.slug)) {
      updated.push(d.slug);
    } else {
      added.push(d.slug);
    }
  }

  for (const slug of existingSlugs) {
    if (!newSlugs.has(slug)) {
      const filePath = join(decDir, `${slug}.md`);
      if (existsSync(filePath)) {
        let content = readFileSync(filePath, 'utf-8');
        content = content.replace(/status: active/, 'status: superseded');
        const now = new Date().toISOString().split('T')[0];
        content = content.replace(/updated: .+/, `updated: ${now}`);
        writeFileSync(filePath, content, 'utf-8');
        superseded.push(slug);
      }
    }
  }

  return { added, updated, superseded };
}

// ── Main Extraction Function ──

/**
 * Extract decisions from architecture session output.
 *
 * This is the main export used by the pre-dev compilation pipeline (Story 4.1).
 * When article type is architecture, tech-spec, api-spec, data-model, or adr,
 * this function is called automatically.
 *
 * @param {string} sessionOutput - Path to architecture document or raw content
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @param {Object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.sessionId]
 * @returns {Promise<{
 *   docSlug: string,
 *   decisions: Array,
 *   articles: Array<{ path: string, nodeId: string, maturity: Object }>,
 *   placeholders: Array<{ path: string, nodeId: string }>,
 *   conflicts: Array,
 *   revision: { added: string[], updated: string[], superseded: string[] }
 * }>}
 */
export async function extractDecisions(sessionOutput, knowledgeDir, opts = {}) {
  // Determine if sessionOutput is a file path or raw content
  let content;
  let docTitle;
  if (existsSync(sessionOutput)) {
    content = readFileSync(sessionOutput, 'utf-8');
    const { data: fm } = parseFrontmatter(content);
    docTitle = fm.title || basename(sessionOutput, '.md');
  } else {
    content = sessionOutput;
    docTitle = 'architecture-session';
  }

  const docSlug = docTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  // Parse decisions
  const decisions = parseDecisions(content, docSlug);

  // Handle revision
  const revision = handleDecisionRevision(decisions, docSlug, knowledgeDir);

  // Connect to Memgraph if available
  let driver;
  try {
    driver = createDriver();
    // Test connection
    const testSession = driver.session();
    await testSession.run('RETURN 1');
    await testSession.close();
  } catch {
    driver = null;
  }

  const articles = [];
  const allPlaceholders = [];
  const allConflicts = [];

  for (const decision of decisions) {
    const nodeId = `decisions/${decision.slug}`;

    // Match to requirements
    const linkedRequirements = await matchRequirements(decision, opts.projectId, driver);
    if (linkedRequirements.length === 0) {
      console.warn(`[extract-dec] Warning: Decision "${decision.title}" has no linked requirements (orphan decision)`);
    }

    // Infer placeholder code
    const placeholders = inferPlaceholderCode(decision);

    // Create placeholder code articles
    const createdPlaceholders = [];
    for (const ph of placeholders) {
      const phPath = createPlaceholderCodeArticle(ph, nodeId, knowledgeDir);
      createdPlaceholders.push({ path: phPath, nodeId: `code/${ph.slug}`, slug: ph.slug });
      allPlaceholders.push({ path: phPath, nodeId: `code/${ph.slug}`, slug: ph.slug });
    }

    // Detect conflicts
    const conflicts = await detectConflicts(decision, opts.projectId, driver);
    allConflicts.push(...conflicts.map(c => ({ ...c, decisionNodeId: nodeId })));

    // Create conflict edges in Memgraph
    if (driver) {
      for (const conflict of conflicts) {
        try {
          await createConflictEdges(nodeId, conflict.nodeId, opts.projectId, driver);
        } catch (err) {
          console.warn(`[extract-dec] Could not create conflict edge: ${err.message}`);
        }
      }
    }

    // Create decision article
    const maturity = assessDecisionMaturity(decision);
    const articlePath = createDecisionArticle(decision, knowledgeDir, {
      linkedRequirements,
      placeholders,
      conflicts,
    });

    articles.push({
      path: articlePath,
      nodeId,
      slug: decision.slug,
      title: decision.title,
      maturity,
    });
  }

  // Close driver
  if (driver) {
    try { await driver.close(); } catch { /* ignore */ }
  }

  // Log extraction
  appendCompilationLog(knowledgeDir, {
    sessionId: opts.sessionId || '-',
    agentType: 'architect',
    articleType: 'decision-extraction',
    nodeId: `doc/${docSlug}`,
    maturityScore: `${decisions.length} decisions, ${allPlaceholders.length} placeholders, ${allConflicts.length} conflicts`,
  });

  return {
    docSlug,
    decisions,
    articles,
    placeholders: allPlaceholders,
    conflicts: allConflicts,
    revision,
  };
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);
  let inputPath = null;
  let knowledgeDir = null;
  let projectId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--input' && args[i + 1]) inputPath = args[++i];
    else if (args[i] === '--knowledge-dir' && args[i + 1]) knowledgeDir = args[++i];
    else if (args[i] === '--project' && args[i + 1]) projectId = args[++i];
  }

  if (!inputPath) {
    console.error('Usage: node extract-decisions.mjs --input <path> --knowledge-dir <dir> [--project <id>]');
    process.exit(1);
  }

  if (!knowledgeDir) {
    knowledgeDir = join(dirname(inputPath), '..', 'knowledge');
  }

  console.log(`[extract-dec] Extracting decisions from: ${inputPath}`);

  const result = await extractDecisions(inputPath, knowledgeDir, { projectId });

  console.log(`[extract-dec] Document: ${result.docSlug}`);
  console.log(`[extract-dec] Decisions extracted: ${result.decisions.length}`);
  console.log(`[extract-dec] Placeholder code articles: ${result.placeholders.length}`);
  console.log(`[extract-dec] Conflicts detected: ${result.conflicts.length}`);

  if (result.revision.added.length > 0) {
    console.log(`[extract-dec] New: ${result.revision.added.join(', ')}`);
  }
  if (result.revision.superseded.length > 0) {
    console.log(`[extract-dec] Superseded: ${result.revision.superseded.join(', ')}`);
  }

  for (const article of result.articles) {
    console.log(`  ${article.nodeId} -- maturity ${article.maturity.score} (${article.maturity.label})`);
  }

  if (result.conflicts.length > 0) {
    console.log('\nConflicts:');
    for (const c of result.conflicts) {
      console.log(`  ${c.decisionNodeId} <-> ${c.nodeId} (shared: ${c.sharedTags.join(', ')})`);
    }
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('extract-decisions.mjs') ||
  process.argv[1].endsWith('extract-decisions')
);
if (isMain) {
  main().catch(err => {
    console.error(`[extract-dec] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
