/**
 * Conversation Pipeline Type
 * Story MY-5.3
 *
 * Pipeline definition for interactive codebase conversations.
 * Not build-oriented — discovery and analysis.
 *
 * Pipeline steps:
 *   1. gather-context (shell) — reads index.md, pending-work.md, file tree
 *   2. graph-search (shell) — GraphRAG search for the user's query
 *   3. respond (agent) — Project Assistant with full context + tools
 *
 * The agent may produce NEW_KNOWLEDGE blocks that feed into Story 5.4's
 * compilation step.
 *
 * Module Usage:
 *   import { getConversationPipeline } from './conversation-pipeline.mjs';
 *   const pipeline = getConversationPipeline('spyhunter', 'How does auth work?', '/path/to/project');
 */

import { resolve, join } from 'path';

// ── NEW_KNOWLEDGE parser ────────────────────────────────────────────

/**
 * Extract NEW_KNOWLEDGE blocks from agent output text.
 *
 * Expected format:
 * ---NEW_KNOWLEDGE---
 * - type: decision | insight | requirement | risk
 *   title: Some Title
 *   content: Some content describing the knowledge.
 *   links: [related-article-1, related-article-2]
 * ---END_NEW_KNOWLEDGE---
 *
 * @param {string} text - The agent's response text.
 * @returns {Array<{type: string, title: string, content: string, links: string[]}>}
 */
export function parseNewKnowledge(text) {
  if (!text || typeof text !== 'string') return [];

  const blocks = [];
  const blockRegex = /---NEW_KNOWLEDGE---\s*([\s\S]*?)\s*---END_NEW_KNOWLEDGE---/g;
  let match;

  while ((match = blockRegex.exec(text)) !== null) {
    const blockContent = match[1].trim();
    const items = parseKnowledgeItems(blockContent);
    blocks.push(...items);
  }

  return blocks;
}

/**
 * Parse YAML-like knowledge items from inside a NEW_KNOWLEDGE block.
 *
 * @param {string} blockContent - Content between delimiters.
 * @returns {Array<{type: string, title: string, content: string, links: string[]}>}
 */
function parseKnowledgeItems(blockContent) {
  const items = [];
  // Split on "- type:" to separate individual items
  const itemChunks = blockContent.split(/^- type:/m).filter((s) => s.trim());

  for (const chunk of itemChunks) {
    const lines = ('type:' + chunk).split('\n');
    const item = { type: '', title: '', content: '', links: [] };

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('type:')) {
        item.type = trimmed.slice(5).trim();
      } else if (trimmed.startsWith('title:')) {
        item.title = trimmed.slice(6).trim();
      } else if (trimmed.startsWith('content:')) {
        item.content = trimmed.slice(8).trim();
      } else if (trimmed.startsWith('links:')) {
        const linksStr = trimmed.slice(6).trim();
        // Parse [a, b, c] format
        if (linksStr.startsWith('[') && linksStr.endsWith(']')) {
          item.links = linksStr.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
        }
      } else if (item.content && trimmed && !trimmed.startsWith('-')) {
        // Multi-line content continuation
        item.content += ' ' + trimmed;
      }
    }

    // Validate required fields
    if (item.type && item.title && item.content) {
      items.push(item);
    }
  }

  return items;
}

// ── Pipeline definition ─────────────────────────────────────────────

/**
 * Build the agent prompt for the conversation's respond step.
 *
 * @param {string} projectName - Display name for the project.
 * @returns {string} Prompt template with {{variable}} placeholders.
 */
function buildAgentPrompt(projectName) {
  return `You are the Project Assistant for ${projectName || '{{PROJECT_NAME}}'}.
You have access to the project's full knowledge graph.

PROJECT CONTEXT (index + pending work + file tree):
{{PROJECT_CONTEXT}}

GRAPH SEARCH RESULTS (nodes related to user's query):
{{GRAPH_RESULTS}}

USER'S MESSAGE:
{{USER_QUERY}}

Respond helpfully. You can:
- Read any wiki article in knowledge/ for compiled context
- Grep the source code for precise details
- Read source files directly
- Reference decisions, requirements, architecture by their wiki links using [[wikilink]] notation

When referencing wiki articles or decisions, use the [[article-id]] notation so they
can be linked in the knowledge graph.

If the conversation produces NEW KNOWLEDGE (decisions made, insights discovered, revised
understanding of requirements, or newly identified risks), note them at the end of your
response in a structured block:

---NEW_KNOWLEDGE---
- type: decision | insight | requirement | risk
  title: Short descriptive title
  content: Full description of the knowledge item.
  links: [related-wiki-article-1, related-wiki-article-2]
---END_NEW_KNOWLEDGE---

This will be compiled into the wiki after the conversation.
Only include NEW_KNOWLEDGE if the conversation genuinely produced new insights worth
persisting. Not every conversation needs it.`;
}

/**
 * Generate a conversation pipeline definition.
 *
 * This returns a pipeline configuration object compatible with the
 * agent-daemon.mjs step-based executor. It defines 3 steps:
 *
 * 1. gather-context: Shell step that reads project context files.
 * 2. graph-search: Shell step that runs GraphRAG search.
 * 3. respond: Agent step with the Project Assistant.
 *
 * @param {string} projectId - The project identifier.
 * @param {string} userQuery - The user's natural language question.
 * @param {string} workingDir - Absolute path to the project workspace.
 * @param {object} [opts] - Optional configuration.
 * @param {string} [opts.projectName] - Human-readable project name.
 * @param {number} [opts.topK=15] - GraphRAG top-K results.
 * @param {number} [opts.hops=3] - GraphRAG traversal depth.
 * @param {string} [opts.model='opus'] - Agent model.
 * @returns {object} Pipeline definition object.
 */
export function getConversationPipeline(projectId, userQuery, workingDir, opts = {}) {
  const {
    projectName = projectId,
    topK = 15,
    hops = 3,
    model = 'opus',
  } = opts;

  const resolvedDir = resolve(workingDir);

  // Escape the user query for shell safety (basic escaping)
  const shellSafeQuery = userQuery.replace(/"/g, '\\"').replace(/`/g, '\\`').replace(/\$/g, '\\$');

  // Determine the scripts directory (relative to this file's expected EC2 location)
  const scriptsDir = resolve(import.meta.url.replace('file://', ''), '../../scripts');
  // Fallback: the known EC2 path
  const graphSearchScript = '/home/ubuntu/scripts/graph-search.mjs';

  return {
    id: 'conversation',
    type: 'conversation',
    projectId,
    workingDir: resolvedDir,
    variables: {
      USER_QUERY: userQuery,
      PROJECT_NAME: projectName,
      projectId,
    },
    agents: {
      ASSISTANT: {
        name: 'Project Assistant',
        allowedTools: 'Read,Grep,Glob,Bash',
        model,
      },
    },
    steps: [
      // Step 1: Gather project context (shell, ~3s, $0)
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

      // Step 2: GraphRAG search for the user's query (shell, ~1s, ~$0.001)
      {
        id: 'graph-search',
        stepType: 'shell',
        command: `node ${graphSearchScript} --project "${projectId}" --query "${shellSafeQuery}" --top-k ${topK} --hops ${hops}`,
        captureAs: 'GRAPH_RESULTS',
        allowFailure: true, // Pipeline continues even if Memgraph is unavailable
      },

      // Step 3: Conversational agent with full context
      {
        id: 'respond',
        stepType: 'agent',
        agentId: 'ASSISTANT',
        prompt: buildAgentPrompt(projectName),
        extractors: {
          NEW_KNOWLEDGE: {
            type: 'between',
            startDelimiter: '---NEW_KNOWLEDGE---',
            endDelimiter: '---END_NEW_KNOWLEDGE---',
          },
        },
      },
    ],
  };
}

/**
 * List of trigger phrases that route to the self-reflection variant
 * instead of the standard conversation pipeline.
 */
export const REFLECTION_TRIGGERS = [
  'reflect',
  'current state',
  'health check',
  'what needs work',
  'project health',
  'what should i work on',
  'status check',
  'maturity check',
];

/**
 * Detect whether a user query should trigger self-reflection mode.
 *
 * @param {string} query - The user's query text.
 * @returns {boolean} True if the query matches a reflection trigger.
 */
export function isReflectionQuery(query) {
  const lower = query.toLowerCase();
  return REFLECTION_TRIGGERS.some((trigger) => lower.includes(trigger));
}
