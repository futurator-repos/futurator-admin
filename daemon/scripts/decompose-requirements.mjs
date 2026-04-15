/**
 * Requirement Decomposition from PRDs
 *
 * Takes a PRD article path, parses it to identify discrete requirements
 * (functional + non-functional). Creates individual requirement articles
 * in knowledge/requirements/ with DERIVED_FROM edges to the PRD.
 *
 * Deterministic nodeIds: requirements/{prd-slug}--{req-number}
 * Edge weight: DERIVED_FROM = 0.7 (from architecture doc section 6.2)
 *
 * Usage:
 *   import { decomposeRequirements } from './decompose-requirements.mjs';
 *   const results = await decomposeRequirements(prdPath, knowledgeDir);
 *
 * CLI:
 *   node decompose-requirements.mjs --prd <path> --knowledge-dir <dir> [--project <id>]
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join, basename, dirname } from 'path';
import neo4j from 'neo4j-driver';
import {
  parseFrontmatter,
  serializeFrontmatter,
  assessMaturity,
  getMaturityLabel,
  appendCompilationLog,
} from '../pipelines/predev-compile-pipeline.mjs';

// ── Requirement Parsing ──

/**
 * Patterns that indicate requirement language in PRD content.
 */
const REQUIREMENT_INDICATORS = [
  /\b(?:shall|must|should|will|needs? to|required to)\b/i,
  /\b(?:the system|the application|the user|the platform)\b/i,
];

/**
 * Section headings commonly associated with non-functional requirements.
 */
const NFR_SECTION_PATTERNS = [
  /performance/i,
  /security/i,
  /scalability/i,
  /accessibility/i,
  /reliability/i,
  /availability/i,
  /maintainability/i,
  /compliance/i,
  /usability/i,
  /data\s*(?:integrity|privacy|retention)/i,
];

/**
 * Parse a PRD document and extract discrete requirements.
 *
 * @param {string} prdContent - Full markdown content of the PRD
 * @param {string} prdSlug - Slug of the PRD (for nodeId generation)
 * @returns {{ functional: Array, nonFunctional: Array }}
 */
export function parseRequirements(prdContent, prdSlug) {
  const { data: fm, content: body } = parseFrontmatter(prdContent);
  const functional = [];
  const nonFunctional = [];

  // Split content into sections
  const sections = splitSections(body);
  let frCounter = 1;
  let nfrCounter = 1;

  for (const section of sections) {
    const isNFR = NFR_SECTION_PATTERNS.some(p => p.test(section.heading));
    const items = extractRequirementItems(section.content, section.heading);

    for (const item of items) {
      const reqType = isNFR ? 'NFR' : 'FR';
      const counter = isNFR ? nfrCounter++ : frCounter++;
      const reqNumber = `${reqType}-${String(counter).padStart(3, '0')}`;
      const reqSlug = `${prdSlug}--${reqNumber}`;

      const req = {
        nodeId: `requirements/${reqSlug}`,
        slug: reqSlug,
        reqNumber,
        reqType,
        title: item.title || `${reqType === 'FR' ? 'Functional' : 'Non-Functional'} Requirement ${reqNumber}`,
        description: item.description,
        acceptanceCriteria: item.acceptanceCriteria || [],
        priority: item.priority || null,
        userType: item.userType || null,
        sourceSection: section.heading,
        tags: deriveTags(item.description, isNFR),
      };

      if (isNFR) {
        nonFunctional.push(req);
      } else {
        functional.push(req);
      }
    }
  }

  return { functional, nonFunctional };
}

/**
 * Split markdown body into sections by heading.
 *
 * @param {string} body
 * @returns {Array<{ heading: string, level: number, content: string }>}
 */
function splitSections(body) {
  const sections = [];
  const headingRegex = /^(#{1,4})\s+(.+)$/gm;
  let lastIndex = 0;
  let lastHeading = 'Introduction';
  let lastLevel = 1;
  let match;

  while ((match = headingRegex.exec(body)) !== null) {
    if (match.index > lastIndex) {
      sections.push({
        heading: lastHeading,
        level: lastLevel,
        content: body.slice(lastIndex, match.index).trim(),
      });
    }
    lastHeading = match[2].trim();
    lastLevel = match[1].length;
    lastIndex = match.index + match[0].length;
  }

  // Final section
  if (lastIndex < body.length) {
    sections.push({
      heading: lastHeading,
      level: lastLevel,
      content: body.slice(lastIndex).trim(),
    });
  }

  return sections;
}

/**
 * Extract individual requirement items from a section's content.
 * Looks for numbered lists, bullet points with requirement language,
 * and labeled requirement blocks.
 *
 * @param {string} content - Section content
 * @param {string} sectionHeading - The section heading for context
 * @returns {Array<{ title: string, description: string, acceptanceCriteria: string[], priority: string|null, userType: string|null }>}
 */
function extractRequirementItems(content, sectionHeading) {
  const items = [];

  // Strategy 1: Numbered/bulleted items with requirement language
  const listItemRegex = /^[\s]*(?:[-*]|\d+[.)]) (.+)$/gm;
  let match;
  const rawItems = [];

  while ((match = listItemRegex.exec(content)) !== null) {
    rawItems.push(match[1].trim());
  }

  // Group consecutive items: a requirement followed by its sub-items
  let currentReq = null;
  const subItems = [];

  for (const raw of rawItems) {
    const hasReqLanguage = REQUIREMENT_INDICATORS.some(p => p.test(raw));

    if (hasReqLanguage || raw.length > 40) {
      // Save previous requirement
      if (currentReq) {
        items.push(buildRequirementItem(currentReq, subItems.splice(0), sectionHeading));
      }
      currentReq = raw;
    } else if (currentReq) {
      subItems.push(raw);
    }
  }

  // Save last requirement
  if (currentReq) {
    items.push(buildRequirementItem(currentReq, subItems, sectionHeading));
  }

  // Strategy 2: If no items found via list parsing, try paragraph-based extraction
  if (items.length === 0) {
    const paragraphs = content.split(/\n\n+/).filter(p => p.trim().length > 20);
    for (const para of paragraphs) {
      const hasReqLanguage = REQUIREMENT_INDICATORS.some(p => p.test(para));
      if (hasReqLanguage) {
        items.push({
          title: para.split(/[.!?\n]/)[0].trim().slice(0, 100),
          description: para.trim(),
          acceptanceCriteria: [],
          priority: extractPriority(para),
          userType: extractUserType(para),
        });
      }
    }
  }

  return items;
}

/**
 * Build a structured requirement item from raw text.
 *
 * @param {string} mainText - The primary requirement statement
 * @param {string[]} subItems - Sub-items (may be acceptance criteria)
 * @param {string} sectionHeading - Section context
 * @returns {Object}
 */
function buildRequirementItem(mainText, subItems, sectionHeading) {
  // Extract a concise title from the requirement text
  const titleCandidate = mainText.split(/[.!?\n]/)[0].trim();
  const title = titleCandidate.length > 100
    ? titleCandidate.slice(0, 97) + '...'
    : titleCandidate;

  return {
    title,
    description: mainText,
    acceptanceCriteria: subItems.length > 0 ? subItems : [],
    priority: extractPriority(mainText),
    userType: extractUserType(mainText),
  };
}

/**
 * Extract priority from requirement text.
 * @param {string} text
 * @returns {string|null}
 */
function extractPriority(text) {
  const match = text.match(/\b(P[0-3]|critical|high|medium|low|must|should|could)\b/i);
  if (!match) return null;
  const val = match[1].toLowerCase();
  if (val === 'critical' || val === 'must' || val === 'p0') return 'P0';
  if (val === 'high' || val === 'p1') return 'P1';
  if (val === 'medium' || val === 'should' || val === 'p2') return 'P2';
  if (val === 'low' || val === 'could' || val === 'p3') return 'P3';
  return match[1].toUpperCase();
}

/**
 * Extract user type from requirement text.
 * @param {string} text
 * @returns {string|null}
 */
function extractUserType(text) {
  const match = text.match(/\b(?:the\s+)?(user|admin|developer|operator|customer|end.?user|viewer|editor|owner|manager|analyst)\b/i);
  return match ? match[1].toLowerCase() : null;
}

/**
 * Derive tags from requirement text.
 * @param {string} text
 * @param {boolean} isNFR
 * @returns {string[]}
 */
function deriveTags(text, isNFR) {
  const tags = [isNFR ? 'non-functional' : 'functional'];
  const lower = text.toLowerCase();

  const tagPatterns = [
    [/auth(?:entication|orization)/i, 'authentication'],
    [/security/i, 'security'],
    [/performance/i, 'performance'],
    [/api/i, 'api'],
    [/database|storage|persist/i, 'data'],
    [/ui|interface|frontend|display/i, 'ui'],
    [/deploy|infrastructure|server/i, 'infrastructure'],
    [/test|validation|verification/i, 'testing'],
    [/accessibility|a11y/i, 'accessibility'],
    [/scalab/i, 'scalability'],
    [/reliab|availab/i, 'reliability'],
    [/notification|email|alert/i, 'notifications'],
    [/search|filter|query/i, 'search'],
    [/payment|billing|subscription/i, 'payment'],
  ];

  for (const [pattern, tag] of tagPatterns) {
    if (pattern.test(lower)) tags.push(tag);
  }

  return [...new Set(tags)];
}

// ── Requirement Maturity Assessment ──

/**
 * Assess maturity for an individual requirement based on completeness signals.
 * From architecture doc section 6.3:
 *   - Description present: 0.2
 *   - Acceptance criteria defined: +0.2 (total 0.4)
 *   - Priority assigned: +0.1 (total 0.5)
 *   - User type identified: +0.05
 *   - Tags derived: +0.05
 *   - Linked to architecture decisions: +0.2 (assessed later)
 *   - Implemented in code: +0.2 (assessed later)
 *
 * @param {Object} req - Extracted requirement object
 * @returns {{ score: number, label: string, signals: string[], missing: string[] }}
 */
export function assessRequirementMaturity(req) {
  let score = 0;
  const signals = [];
  const missing = [];

  // Description present
  if (req.description && req.description.length > 10) {
    score += 0.2;
    signals.push('Description present');
  } else {
    missing.push('Description missing or too short');
  }

  // Acceptance criteria defined
  if (req.acceptanceCriteria && req.acceptanceCriteria.length > 0) {
    score += 0.2;
    signals.push('Acceptance criteria defined');
  } else {
    missing.push('No acceptance criteria');
  }

  // Priority assigned
  if (req.priority) {
    score += 0.1;
    signals.push(`Priority assigned: ${req.priority}`);
  } else {
    missing.push('No priority assigned');
  }

  // User type identified
  if (req.userType) {
    score += 0.05;
    signals.push(`User type identified: ${req.userType}`);
  } else {
    missing.push('No user type identified');
  }

  // Tags derived
  if (req.tags && req.tags.length > 1) {
    score += 0.05;
    signals.push('Domain tags derived');
  } else {
    missing.push('Minimal tags');
  }

  // Architecture decision linked (not yet at extraction time)
  missing.push('No architecture decision linked yet');

  // Implemented in code (not yet at extraction time)
  missing.push('Not implemented in code yet');

  score = Math.round(score * 10) / 10;
  const label = getMaturityLabel(score);

  return { score, label, signals, missing };
}

// ── Requirement Article Creation ──

/**
 * Create a wiki article for a single requirement.
 *
 * @param {Object} req - Extracted requirement
 * @param {string} prdNodeId - Node ID of the parent PRD
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @param {Object} [opts] - Additional options
 * @param {string} [opts.createdByEpic]
 * @param {string} [opts.createdByStory]
 * @returns {string} Path to the created article
 */
export function createRequirementArticle(req, prdNodeId, knowledgeDir, opts = {}) {
  const maturity = assessRequirementMaturity(req);
  const now = new Date().toISOString().split('T')[0];

  const frontmatter = {
    title: req.title,
    type: 'requirement',
    phase: 'planning',
    status: 'active',
    maturity: maturity.score,
    created: now,
    updated: now,
    createdByEpic: opts.createdByEpic || '',
    createdByStory: opts.createdByStory || '',
    reqType: req.reqType,
    sourceSection: req.sourceSection,
    tags: req.tags,
  };

  const sections = [];

  // Purpose
  sections.push(`## Purpose\n${req.description}`);

  // Derived From
  sections.push(`## Derived From\n- [[${prdNodeId}]] -- ${req.sourceSection}`);

  // Acceptance Criteria
  if (req.acceptanceCriteria.length > 0) {
    sections.push(`## Acceptance Criteria\n${req.acceptanceCriteria.map(ac => `- ${ac}`).join('\n')}`);
  } else {
    sections.push('## Acceptance Criteria\n(Not yet defined)');
  }

  // Priority
  sections.push(`## Priority\n${req.priority || '(Not yet assigned)'}`);

  // User Type
  sections.push(`## User Type\n${req.userType || '(Not yet identified)'}`);

  // Signals
  sections.push(`## Signals\n${maturity.signals.map(s => `- ${s}`).join('\n')}`);

  // Missing Signals
  if (maturity.missing.length > 0) {
    sections.push(`## Missing Signals\n${maturity.missing.map(s => `- ${s}`).join('\n')}`);
  }

  // Write article
  const articleContent = `${serializeFrontmatter(frontmatter)}\n\n${sections.join('\n\n')}\n`;
  const reqDir = join(knowledgeDir, 'requirements');
  if (!existsSync(reqDir)) {
    mkdirSync(reqDir, { recursive: true });
  }
  const articlePath = join(reqDir, `${req.slug}.md`);
  writeFileSync(articlePath, articleContent, 'utf-8');

  return articlePath;
}

// ── PRD Revision Handling ──

/**
 * Detect existing requirements for a PRD and handle updates.
 * When a PRD is recompiled:
 *   - Updated requirements: overwrite the article, bump updated date
 *   - New requirements: create new articles
 *   - Removed requirements: mark as status: superseded
 *
 * @param {Array} newReqs - Newly extracted requirements (functional + nonFunctional)
 * @param {string} prdSlug - The PRD slug
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @returns {{ added: string[], updated: string[], superseded: string[] }}
 */
export function handleRevision(newReqs, prdSlug, knowledgeDir) {
  const reqDir = join(knowledgeDir, 'requirements');
  const added = [];
  const updated = [];
  const superseded = [];

  // Gather existing requirement files for this PRD
  const existingSlugs = new Set();
  if (existsSync(reqDir)) {
    for (const file of readdirSync(reqDir)) {
      if (file.startsWith(prdSlug + '--') && file.endsWith('.md')) {
        existingSlugs.add(file.replace('.md', ''));
      }
    }
  }

  const newSlugs = new Set(newReqs.map(r => r.slug));

  // Detect updated and added
  for (const req of newReqs) {
    if (existingSlugs.has(req.slug)) {
      updated.push(req.slug);
    } else {
      added.push(req.slug);
    }
  }

  // Detect removed (superseded)
  for (const slug of existingSlugs) {
    if (!newSlugs.has(slug)) {
      // Mark as superseded
      const filePath = join(reqDir, `${slug}.md`);
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

// ── Main Decomposition Function ──

/**
 * Decompose a PRD into individual requirement articles.
 *
 * This is the main export used by the pre-dev compilation pipeline (Story 4.1).
 * When article type is 'prd', this function is called automatically.
 *
 * @param {string} prdPath - Path to the PRD markdown file
 * @param {string} knowledgeDir - Path to knowledge/ directory
 * @param {Object} [opts]
 * @param {string} [opts.projectId]
 * @param {string} [opts.createdByEpic]
 * @param {string} [opts.createdByStory]
 * @returns {Promise<{
 *   prdSlug: string,
 *   prdNodeId: string,
 *   functional: Array,
 *   nonFunctional: Array,
 *   totalCount: number,
 *   articles: Array<{ path: string, nodeId: string, maturity: Object }>,
 *   revision: { added: string[], updated: string[], superseded: string[] }
 * }>}
 */
export async function decomposeRequirements(prdPath, knowledgeDir, opts = {}) {
  // Read PRD
  const prdContent = readFileSync(prdPath, 'utf-8');
  const { data: prdFm } = parseFrontmatter(prdContent);
  const prdTitle = prdFm.title || basename(prdPath, '.md');
  const prdSlug = prdTitle
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');

  const prdNodeId = `planning/${prdSlug}`;

  // Parse requirements
  const { functional, nonFunctional } = parseRequirements(prdContent, prdSlug);
  const allReqs = [...functional, ...nonFunctional];

  // Handle revision (diff against existing)
  const revision = handleRevision(allReqs, prdSlug, knowledgeDir);

  // Create/update requirement articles
  const articles = [];
  for (const req of allReqs) {
    const maturity = assessRequirementMaturity(req);
    const articlePath = createRequirementArticle(req, prdNodeId, knowledgeDir, {
      createdByEpic: opts.createdByEpic || prdFm.createdByEpic,
      createdByStory: opts.createdByStory || prdFm.createdByStory,
    });

    articles.push({
      path: articlePath,
      nodeId: req.nodeId,
      slug: req.slug,
      reqNumber: req.reqNumber,
      maturity,
    });
  }

  // Log decomposition
  appendCompilationLog(knowledgeDir, {
    sessionId: opts.sessionId || '-',
    agentType: 'pm',
    articleType: 'requirement-decomposition',
    nodeId: prdNodeId,
    maturityScore: `${allReqs.length} reqs extracted`,
  });

  // If Memgraph is available, verify DERIVED_FROM edges
  const boltUri = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
  let edgeResults = [];
  try {
    const driver = neo4j.driver(boltUri);
    const session = driver.session();
    try {
      // Verify edges after graph-sync would have run
      const result = await session.run(
        `MATCH (req:Node {type: 'requirement'})-[e:DERIVED_FROM]->(prd:Node {type: 'prd'})
         WHERE prd.nodeId = $prdNodeId
         RETURN req.nodeId AS reqNodeId, prd.nodeId AS prdNodeId, e.weight AS weight`,
        { prdNodeId }
      );
      edgeResults = result.records.map(r => ({
        reqNodeId: r.get('reqNodeId'),
        prdNodeId: r.get('prdNodeId'),
        weight: r.get('weight'),
      }));
    } finally {
      await session.close();
    }
    await driver.close();
  } catch {
    // Memgraph not available; edges will be created by graph-sync.mjs
  }

  return {
    prdSlug,
    prdNodeId,
    functional,
    nonFunctional,
    totalCount: allReqs.length,
    articles,
    revision,
    edgeResults,
  };
}

// ── CLI Entry Point ──

async function main() {
  const args = process.argv.slice(2);
  let prdPath = null;
  let knowledgeDir = null;
  let projectId = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--prd' && args[i + 1]) prdPath = args[++i];
    else if (args[i] === '--knowledge-dir' && args[i + 1]) knowledgeDir = args[++i];
    else if (args[i] === '--project' && args[i + 1]) projectId = args[++i];
  }

  if (!prdPath) {
    console.error('Usage: node decompose-requirements.mjs --prd <path> --knowledge-dir <dir> [--project <id>]');
    process.exit(1);
  }

  if (!knowledgeDir) {
    knowledgeDir = join(dirname(prdPath), '..', 'knowledge');
  }

  console.log(`[decompose-req] Decomposing PRD: ${prdPath}`);

  const result = await decomposeRequirements(prdPath, knowledgeDir, { projectId });

  console.log(`[decompose-req] PRD: ${result.prdNodeId}`);
  console.log(`[decompose-req] Functional requirements: ${result.functional.length}`);
  console.log(`[decompose-req] Non-functional requirements: ${result.nonFunctional.length}`);
  console.log(`[decompose-req] Total articles created: ${result.articles.length}`);

  if (result.revision.added.length > 0) {
    console.log(`[decompose-req] New: ${result.revision.added.join(', ')}`);
  }
  if (result.revision.updated.length > 0) {
    console.log(`[decompose-req] Updated: ${result.revision.updated.join(', ')}`);
  }
  if (result.revision.superseded.length > 0) {
    console.log(`[decompose-req] Superseded: ${result.revision.superseded.join(', ')}`);
  }

  for (const article of result.articles) {
    console.log(`  ${article.nodeId} — maturity ${article.maturity.score} (${article.maturity.label})`);
  }
}

const isMain = process.argv[1] && (
  process.argv[1].endsWith('decompose-requirements.mjs') ||
  process.argv[1].endsWith('decompose-requirements')
);
if (isMain) {
  main().catch(err => {
    console.error(`[decompose-req] Fatal error: ${err.message}`);
    process.exit(1);
  });
}
