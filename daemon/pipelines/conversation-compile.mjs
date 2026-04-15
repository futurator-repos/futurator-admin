/**
 * Conversation-to-Knowledge Compilation
 * Story MY-5.4
 *
 * Parses ---NEW_KNOWLEDGE--- blocks from conversation output and compiles
 * them into wiki articles. Maps knowledge types to phase directories,
 * creates articles with frontmatter, and triggers graph-sync.
 *
 * Knowledge Type Mapping:
 *   decision   → knowledge/decisions/
 *   insight    → knowledge/discovery/
 *   requirement → knowledge/requirements/
 *   risk       → knowledge/planning/
 *   reflection → knowledge/system/
 *
 * Module Usage:
 *   import { compileConversationKnowledge } from './conversation-compile.mjs';
 *   const articles = await compileConversationKnowledge(
 *     newKnowledgeBlock, 'spyhunter', '/path/to/project/knowledge'
 *   );
 */

import { readFile, writeFile, mkdir, access, appendFile } from 'fs/promises';
import { join, dirname } from 'path';
import { parseNewKnowledge } from './conversation-pipeline.mjs';
import { execSync } from 'child_process';

// ── Knowledge type to phase mapping ─────────────────────────────────

const TYPE_TO_PHASE = {
  decision: { dir: 'decisions', type: 'decision', phase: 'solutioning' },
  insight: { dir: 'discovery', type: 'insight', phase: 'discovery' },
  requirement: { dir: 'requirements', type: 'requirement', phase: 'planning' },
  risk: { dir: 'planning', type: 'risk', phase: 'planning' },
  reflection: { dir: 'system', type: 'reflection', phase: 'system', maturity: 0.8 },
};

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Generate a URL-safe slug from a title string.
 * Lowercase, replace spaces with hyphens, strip non-alphanumeric.
 *
 * @param {string} title - The article title.
 * @returns {string} Slug suitable for filenames.
 */
function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80); // Limit slug length
}

/**
 * Check if a file exists at the given path.
 */
async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Get the current ISO date string (YYYY-MM-DD).
 */
function today() {
  return new Date().toISOString().split('T')[0];
}

/**
 * Get the current ISO timestamp string.
 */
function now() {
  return new Date().toISOString();
}

/**
 * Generate frontmatter for a wiki article.
 *
 * @param {object} params - Article metadata.
 * @returns {string} YAML frontmatter block.
 */
function buildFrontmatter({ title, type, phase, tags, maturity = 0.3 }) {
  const tagList = tags && tags.length > 0
    ? `[${tags.map((t) => t.trim()).join(', ')}]`
    : '[conversation-derived]';

  return `---
title: "${title}"
type: ${type}
phase: ${phase}
status: active
maturity: ${maturity}
created: ${today()}
updated: ${today()}
source: conversation
tags: ${tagList}
---`;
}

/**
 * Generate the body of a wiki article from a knowledge item.
 *
 * @param {object} item - Parsed knowledge item.
 * @param {string} item.content - The knowledge content.
 * @param {string[]} item.links - Related wiki article IDs.
 * @returns {string} Markdown article body.
 */
function buildArticleBody(item) {
  let body = `\n## Purpose\n\n${item.content}\n`;

  if (item.links && item.links.length > 0) {
    body += '\n## Dependencies\n\n';
    for (const link of item.links) {
      body += `- [[${link}]]\n`;
    }
  }

  body += `\n## Notes\n\nThis article was automatically compiled from a conversation on ${today()}.\n`;
  body += 'Initial maturity is 0.3 (conversation-derived). Review and validate to increase maturity.\n';

  return body;
}

// ── Main compilation function ───────────────────────────────────────

/**
 * Compile a NEW_KNOWLEDGE block into wiki articles.
 *
 * Parses the block, creates articles in the appropriate phase directories,
 * and returns metadata about what was created.
 *
 * @param {string} newKnowledgeBlock - The raw text containing ---NEW_KNOWLEDGE--- blocks.
 * @param {string} projectId - The project identifier.
 * @param {string} knowledgeDir - Absolute path to the knowledge/ directory.
 * @param {object} [opts] - Options.
 * @param {string} [opts.conversationId] - Pipeline job ID for traceability.
 * @param {boolean} [opts.syncToGraph=false] - Run graph-sync.mjs after compilation.
 * @param {boolean} [opts.verbose=false] - Debug output.
 * @returns {Promise<Array<{path: string, nodeId: string, type: string, title: string}>>}
 */
export async function compileConversationKnowledge(newKnowledgeBlock, projectId, knowledgeDir, opts = {}) {
  const {
    conversationId = `conv-${Date.now()}`,
    syncToGraph = false,
    verbose = false,
  } = opts;

  const dbg = verbose ? (msg) => console.error(`[conversation-compile] ${msg}`) : () => {};

  // Step 1: Parse the NEW_KNOWLEDGE block
  const items = parseNewKnowledge(newKnowledgeBlock);

  if (items.length === 0) {
    dbg('No NEW_KNOWLEDGE items found. Nothing to compile.');
    return [];
  }

  dbg(`Found ${items.length} knowledge items to compile.`);

  const createdArticles = [];

  // Step 2: Create wiki articles for each knowledge item
  for (const item of items) {
    const mapping = TYPE_TO_PHASE[item.type];
    if (!mapping) {
      dbg(`Unknown knowledge type "${item.type}" — skipping item "${item.title}"`);
      continue;
    }

    const slug = slugify(item.title);
    if (!slug) {
      dbg(`Could not generate slug for title "${item.title}" — skipping`);
      continue;
    }

    // Ensure the phase directory exists
    const phaseDir = join(knowledgeDir, mapping.dir);
    await mkdir(phaseDir, { recursive: true });

    // Handle slug collisions
    let finalSlug = slug;
    let articlePath = join(phaseDir, `${finalSlug}.md`);
    let counter = 2;
    while (await fileExists(articlePath)) {
      finalSlug = `${slug}-${counter}`;
      articlePath = join(phaseDir, `${finalSlug}.md`);
      counter++;
    }

    // Extract tags from content (simple heuristic: words after common markers)
    const contentWords = item.content.toLowerCase().split(/\s+/);
    const tags = ['conversation-derived'];
    // Add the knowledge type as a tag
    tags.push(item.type);
    // Add link targets as tags (simplified)
    if (item.links) {
      for (const link of item.links.slice(0, 5)) {
        const tag = link.replace(/^(code|decisions|requirements|discovery|planning)\//, '').replace(/--/g, '-');
        tags.push(tag);
      }
    }

    // Build the article
    const frontmatter = buildFrontmatter({
      title: item.title,
      type: mapping.type,
      phase: mapping.phase,
      tags: [...new Set(tags)],
      ...(mapping.maturity !== undefined && { maturity: mapping.maturity }),
    });

    const body = buildArticleBody(item);
    const articleContent = frontmatter + body;

    // Write the article
    await writeFile(articlePath, articleContent, 'utf-8');

    const nodeId = `${mapping.dir}/${finalSlug}`;

    dbg(`Created: ${articlePath} (nodeId: ${nodeId})`);

    createdArticles.push({
      path: articlePath,
      nodeId,
      type: mapping.type,
      title: item.title,
      phase: mapping.phase,
    });
  }

  // Step 3: Update log.md
  if (createdArticles.length > 0) {
    await updateLog(knowledgeDir, conversationId, createdArticles, dbg);
    await updateIndex(knowledgeDir, createdArticles, dbg);
  }

  // Step 4: Optionally trigger graph-sync
  if (syncToGraph && createdArticles.length > 0) {
    dbg('Triggering graph-sync...');
    try {
      const syncCmd = `node /home/ubuntu/scripts/graph-sync.mjs --project "${projectId}" --knowledge-dir "${knowledgeDir}"`;
      execSync(syncCmd, {
        encoding: 'utf-8',
        timeout: 30000,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      dbg('Graph sync complete.');
    } catch (err) {
      dbg(`Graph sync failed: ${err.message}`);
      // Non-fatal: articles are created even if sync fails
    }
  }

  dbg(`Compilation complete: ${createdArticles.length} articles created.`);
  return createdArticles;
}

// ── Log and index updates ───────────────────────────────────────────

/**
 * Append a compilation record to knowledge/log.md.
 */
async function updateLog(knowledgeDir, conversationId, articles, dbg) {
  const logPath = join(knowledgeDir, 'log.md');

  const titles = articles.map((a) => a.title).join(', ');
  const entry = `| ${now()} | conversation-compile | Created ${articles.length} articles from conversation ${conversationId}: ${titles} |\n`;

  try {
    // Check if log.md exists; if not, create with header
    if (!(await fileExists(logPath))) {
      const header = '# Knowledge Operations Log\n\n| Timestamp | Operation | Details |\n|-----------|-----------|----------|\n';
      await writeFile(logPath, header + entry, 'utf-8');
    } else {
      await appendFile(logPath, entry, 'utf-8');
    }
    dbg(`Updated log.md with ${articles.length} entries.`);
  } catch (err) {
    dbg(`Failed to update log.md: ${err.message}`);
  }
}

/**
 * Update knowledge/index.md with new article entries.
 */
async function updateIndex(knowledgeDir, articles, dbg) {
  const indexPath = join(knowledgeDir, 'index.md');

  try {
    let indexContent;

    if (await fileExists(indexPath)) {
      indexContent = await readFile(indexPath, 'utf-8');
    } else {
      indexContent = '# Knowledge Index\n\nMaster catalog of all knowledge articles.\n\n## Articles\n\n';
    }

    // Append new articles to the index
    let additions = '\n';
    for (const article of articles) {
      additions += `- [[${article.nodeId}]] — ${article.title} (${article.type}, maturity: 0.3, source: conversation)\n`;
    }

    // Append to the end of the index
    await writeFile(indexPath, indexContent + additions, 'utf-8');
    dbg(`Updated index.md with ${articles.length} new entries.`);
  } catch (err) {
    dbg(`Failed to update index.md: ${err.message}`);
  }
}

// ── Convenience: get the compile step definition for conversation pipeline ──

/**
 * Get the compile-conversation step definition for use in the pipeline.
 * This is the conditional step that runs after the 'respond' step
 * only if NEW_KNOWLEDGE was extracted.
 *
 * @param {string} projectId - Project ID.
 * @param {string} knowledgeDir - Path to knowledge directory.
 * @returns {object} Pipeline step definition.
 */
export function getCompileStep(projectId, knowledgeDir) {
  return {
    id: 'compile-conversation',
    stepType: 'shell',
    command: `node --input-type=module -e "
      import { compileConversationKnowledge } from './conversation-compile.mjs';
      const block = process.env.NEW_KNOWLEDGE || '';
      if (block) {
        const result = await compileConversationKnowledge(
          block, '${projectId}', '${knowledgeDir}', { syncToGraph: false, verbose: true }
        );
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log('No NEW_KNOWLEDGE to compile.');
      }
    "`,
    condition: 'NEW_KNOWLEDGE', // Only runs if this variable is non-empty
  };
}

/**
 * Get the graph-sync step definition for the conversation pipeline.
 *
 * @param {string} projectId - Project ID.
 * @param {string} knowledgeDir - Path to knowledge directory.
 * @returns {object} Pipeline step definition.
 */
export function getSyncStep(projectId, knowledgeDir) {
  return {
    id: 'sync',
    stepType: 'shell',
    command: `node /home/ubuntu/scripts/graph-sync.mjs --project "${projectId}" --knowledge-dir "${knowledgeDir}"`,
    condition: 'NEW_KNOWLEDGE', // Only runs if compilation happened
  };
}
