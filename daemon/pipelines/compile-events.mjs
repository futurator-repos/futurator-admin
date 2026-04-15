/**
 * Compile Events — Structured event emission for the compilation pipeline
 *
 * Emits compilation-specific events to futurator-agent-events DynamoDB table.
 * All event emission is non-blocking — errors are logged but never thrown.
 *
 * Usage:
 *   import { emitCompilationStarted, emitCompilationCompleted, emitCompilationFailed } from './compile-events.mjs';
 *
 *   await emitCompilationStarted(pushEvent, jobId, context);
 *   await emitCompilationCompleted(pushEvent, jobId, context, result);
 *   await emitCompilationFailed(pushEvent, jobId, context, error);
 */

import { appendFileSync, existsSync, mkdirSync } from 'fs';

// ── Event Types ──

/**
 * @typedef {Object} CompilationContext
 * @property {string} jobId       — pipeline job ID
 * @property {string} storyId     — story being compiled
 * @property {string} epicId      — parent epic
 * @property {string} projectId   — project identifier
 * @property {string} workingDir  — project workspace path
 */

/**
 * @typedef {Object} CompilationResult
 * @property {'success' | 'failed' | 'skipped'} status
 * @property {string} startedAt          — ISO timestamp
 * @property {string} completedAt        — ISO timestamp
 * @property {number} durationMs         — total compilation time
 * @property {{ created: number, updated: number, superseded: number }} articleCounts
 */

// ── Non-blocking wrapper ──

/**
 * Wraps an async function to ensure it never throws.
 * Errors are logged but swallowed.
 *
 * @param {Function} fn — async function to wrap
 * @param {string} label — label for error logging
 * @returns {Function} — wrapped function that never throws
 */
function nonBlocking(fn, label) {
  return async (...args) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error(`[compile-events] ${label} failed (non-blocking): ${err.message}`);
      return undefined;
    }
  };
}

// ── Event Emitters ──

/**
 * Emit a compilation-started event.
 *
 * @param {Function} pushEvent — the daemon's pushEvent function
 * @param {string} jobId — pipeline job ID
 * @param {CompilationContext} ctx — compilation context
 */
export const emitCompilationStarted = nonBlocking(
  async (pushEvent, jobId, ctx) => {
    const startedAt = new Date().toISOString();

    await pushEvent(jobId, 'compile-phase', '__compiler__', 'compilation-started', {
      text: `Compilation started for story ${ctx.storyId}`,
      compilationEvent: 'compilation-started',
      storyId: ctx.storyId,
      epicId: ctx.epicId,
      projectId: ctx.projectId,
      compilationStartedAt: startedAt,
    });

    return startedAt;
  },
  'emitCompilationStarted',
);

/**
 * Emit a compilation-completed event with full metadata.
 *
 * @param {Function} pushEvent — the daemon's pushEvent function
 * @param {string} jobId — pipeline job ID
 * @param {CompilationContext} ctx — compilation context
 * @param {CompilationResult} result — compilation outcome
 */
export const emitCompilationCompleted = nonBlocking(
  async (pushEvent, jobId, ctx, result) => {
    await pushEvent(jobId, 'compile-phase', '__compiler__', 'compilation-completed', {
      text: `Compilation completed: ${result.status} (${result.durationMs}ms, ${result.articleCounts.created} created, ${result.articleCounts.updated} updated, ${result.articleCounts.superseded} superseded)`,
      compilationEvent: 'compilation-completed',
      storyId: ctx.storyId,
      epicId: ctx.epicId,
      projectId: ctx.projectId,
      compilationStatus: result.status,
      compilationStartedAt: result.startedAt,
      compilationCompletedAt: result.completedAt,
      durationMs: result.durationMs,
      articlesCreated: result.articleCounts.created,
      articlesUpdated: result.articleCounts.updated,
      articlesSuperseded: result.articleCounts.superseded,
    });
  },
  'emitCompilationCompleted',
);

/**
 * Emit a compilation-failed event with error details.
 *
 * @param {Function} pushEvent — the daemon's pushEvent function
 * @param {string} jobId — pipeline job ID
 * @param {CompilationContext} ctx — compilation context
 * @param {Error} error — the error that caused the failure
 * @param {string} [startedAt] — when compilation started (for duration calc)
 */
export const emitCompilationFailed = nonBlocking(
  async (pushEvent, jobId, ctx, error, startedAt) => {
    const completedAt = new Date().toISOString();
    const durationMs = startedAt
      ? new Date(completedAt) - new Date(startedAt)
      : 0;

    await pushEvent(jobId, 'compile-phase', '__compiler__', 'compilation-failed', {
      text: `Compilation FAILED (non-blocking): ${error.message.slice(0, 500)}`,
      compilationEvent: 'compilation-failed',
      storyId: ctx.storyId,
      epicId: ctx.epicId,
      projectId: ctx.projectId,
      compilationStatus: 'failed',
      compilationCompletedAt: completedAt,
      durationMs,
      errorMessage: error.message,
      errorStack: error.stack?.slice(0, 2000),
    });
  },
  'emitCompilationFailed',
);

// ── Knowledge Log Fallback Writer ──

/**
 * Write a compilation record to knowledge/log.md.
 * Used as a fallback when the COMPILER agent fails before writing the log.
 *
 * @param {string} workingDir — project workspace path
 * @param {string} storyId — story identifier
 * @param {'success' | 'failed'} status — compilation outcome
 * @param {{ created: number, updated: number, superseded: number }} counts — article counts
 * @param {string} [errorSummary] — error description for failed compilations
 */
export const writeCompilationLog = nonBlocking(
  async (workingDir, storyId, status, counts = { created: 0, updated: 0, superseded: 0 }, errorSummary = 'OK') => {
    const knowledgeDir = `${workingDir}/knowledge`;
    const logPath = `${knowledgeDir}/log.md`;

    // Ensure knowledge directory exists
    if (!existsSync(knowledgeDir)) {
      mkdirSync(knowledgeDir, { recursive: true });
    }

    // Create log.md with header if it doesn't exist
    if (!existsSync(logPath)) {
      const header = `# Knowledge Compilation Log

| Timestamp | Story ID | Status | Created/Updated/Superseded | Notes |
|-----------|----------|--------|---------------------------|-------|
`;
      appendFileSync(logPath, header);
    }

    // Sanitize error summary for table format (remove pipes)
    const sanitizedError = (errorSummary || 'OK').slice(0, 100).replace(/\|/g, '/').replace(/\n/g, ' ');

    const timestamp = new Date().toISOString();
    const entry = `| ${timestamp} | ${storyId} | ${status} | ${counts.created}/${counts.updated}/${counts.superseded} | ${sanitizedError} |\n`;

    appendFileSync(logPath, entry);
  },
  'writeCompilationLog',
);

/**
 * Parse article counts from COMPILE_RESULT text.
 * Attempts to extract created/updated/superseded counts from the compiler agent's output.
 *
 * @param {string} compileResult — the COMPILE_RESULT variable text
 * @returns {{ created: number, updated: number, superseded: number }}
 */
export function parseArticleCounts(compileResult) {
  const counts = { created: 0, updated: 0, superseded: 0 };

  if (!compileResult) return counts;

  // Try to parse structured output patterns
  const createdMatch = compileResult.match(/(\d+)\s*(?:articles?\s*)?created/i);
  const updatedMatch = compileResult.match(/(\d+)\s*(?:articles?\s*)?updated/i);
  const supersededMatch = compileResult.match(/(\d+)\s*(?:articles?\s*)?superseded/i);

  if (createdMatch) counts.created = parseInt(createdMatch[1], 10);
  if (updatedMatch) counts.updated = parseInt(updatedMatch[1], 10);
  if (supersededMatch) counts.superseded = parseInt(supersededMatch[1], 10);

  // Fallback: count file operations mentioned in the output
  if (counts.created === 0 && counts.updated === 0) {
    const writeMatches = compileResult.match(/(?:Created|Wrote|Write)\s+.*\.md/gi);
    const editMatches = compileResult.match(/(?:Updated|Edited|Edit)\s+.*\.md/gi);
    if (writeMatches) counts.created = writeMatches.length;
    if (editMatches) counts.updated = editMatches.length;
  }

  return counts;
}
