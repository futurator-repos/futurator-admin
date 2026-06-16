/**
 * Mycelium-MCP telemetry (Epic 4, Story 4.3 — closes PRD W3/G8).
 *
 * Every MCP tool invocation emits a durable record so adoption + token savings
 * are PROVABLE from data, not self-reported. The record shape (per the AC):
 *
 *   { tool, projectId, storyId, tokensIn, tokensOut, fallbackUsed, ts }
 *
 * Default sink: `knowledge/_graph/mcp-telemetry.jsonl` (one JSON object per line,
 * append-only). `appendTelemetry` accepts an injectable `sink(line)` so the hot
 * path and tests don't touch the filesystem. `mcp-telemetry-report.mjs`
 * aggregates these into an adoption rate + a token delta vs. the grep+read
 * baseline. No success figure is borrowed — the baseline is measured.
 */

import { appendFile, mkdir } from 'fs/promises';
import { dirname } from 'path';

/**
 * Rough token estimate from a character count. The transport may pass real
 * counts later; until then we estimate at ~4 chars/token (English+code).
 */
export function estimateTokens(chars) {
  if (!chars || chars <= 0) return 0;
  return Math.ceil(chars / 4);
}

/**
 * Build a normalized telemetry record. `tokensIn/Out` are derived from the
 * arg/result sizes unless explicitly supplied.
 */
export function buildTelemetryRecord({
  tool,
  projectId = null,
  storyId = null,
  argsSize = 0,
  resultSize = 0,
  tokensIn,
  tokensOut,
  fallbackUsed = false,
  ts,
}) {
  return {
    tool,
    projectId: projectId ?? null,
    storyId: storyId ?? null,
    tokensIn: tokensIn ?? estimateTokens(argsSize),
    tokensOut: tokensOut ?? estimateTokens(resultSize),
    fallbackUsed: !!fallbackUsed,
    ts: ts ?? new Date().toISOString(),
  };
}

/**
 * Append one record to the durable sink. If `sink` is provided it is used
 * (tests/in-memory); otherwise the record is appended as a JSONL line to
 * `path` (default `knowledge/_graph/mcp-telemetry.jsonl`), creating the dir.
 */
export async function appendTelemetry(record, path, sink) {
  const line = JSON.stringify(record);
  if (typeof sink === 'function') {
    await sink(line);
    return record;
  }
  const target = path || 'knowledge/_graph/mcp-telemetry.jsonl';
  await mkdir(dirname(target), { recursive: true });
  await appendFile(target, line + '\n', 'utf-8');
  return record;
}

/** Parse a JSONL telemetry blob into records, skipping malformed lines. */
export function parseTelemetry(jsonl) {
  const out = [];
  for (const raw of String(jsonl).split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      /* skip malformed */
    }
  }
  return out;
}
