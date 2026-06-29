// Pipeline v1 — Story 5.3. Auto-compaction worker.
//
// Periodically scans `agent-sessions` for IDLE sessions whose tokenCount
// exceeds SESSION_COMPACTION_TOKEN_THRESHOLD. For each candidate:
//   1. Spawns a one-shot Sonnet "compaction" call summarizing turns 1..N-2
//      into a single block (preserving file paths, decisions, key tool
//      outputs, current goal).
//   2. Replaces the saved transcript with the compacted version.
//   3. Marks the original session ARCHIVED with `compactedFrom = oldId`.
//   4. Creates a new session row representing the compacted version.
//
// V1 scope: scaffold + compaction *job enqueue* (the actual one-shot Sonnet
// spawn is the daemon's responsibility — this module hands off via the
// jobs table). The full transcript-rewrite ships as a follow-up.

import { ScanCommand, UpdateCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { shouldCompact } from './session-warmth.mjs';

// ── Pipeline-3: dual-threshold compaction policy (development-plan §5.3) ───────
// jcode's constants. The 200k window has a SOFT (0.80) and HARD (0.95) line:
// soft = compact opportunistically at an idle boundary; hard = must compact
// before the next turn or we risk overflow. RECENT turns are kept VERBATIM (a
// load-bearing floor so compaction can't drop the live working set); images are
// flattened to a flat token cost rather than re-counted per pixel.
export const CONTEXT_WINDOW_TOKENS = 200_000;
export const COMPACT_SOFT = 0.8;
export const COMPACT_HARD = 0.95;
export const RECENT_TURNS_TO_KEEP = 10;
export const IMAGE_FLAT_TOKENS = 1600;

/** Flat token cost for N images (jcode flat-1600), not per-pixel. */
export function flattenImageTokens(imageCount) {
  return Math.max(0, Number(imageCount) || 0) * IMAGE_FLAT_TOKENS;
}

/**
 * Decide whether/how to compact given the live token count.
 *   tokenCount ≥ HARD×window → 'hard' (must compact now)
 *   tokenCount ≥ SOFT×window → 'soft' (compact at the next idle boundary)
 *   else                     → 'none'
 *
 * @returns {{ action:'none'|'soft'|'hard', fraction:number, keepTurns:number }}
 */
export function decideCompaction({ tokenCount, windowTokens = CONTEXT_WINDOW_TOKENS, keepTurns = RECENT_TURNS_TO_KEEP } = {}) {
  const t = Number(tokenCount) || 0;
  const fraction = windowTokens > 0 ? Math.round((t / windowTokens) * 1000) / 1000 : 0;
  let action = 'none';
  if (fraction >= COMPACT_HARD) action = 'hard';
  else if (fraction >= COMPACT_SOFT) action = 'soft';
  return { action, fraction, keepTurns };
}

/**
 * Partition a turn list into { summarize, keep }: the last `keepTurns` are kept
 * verbatim; everything before is summarized into one block. PURE.
 */
export function planCompaction(turns = [], keepTurns = RECENT_TURNS_TO_KEEP) {
  const arr = Array.isArray(turns) ? turns : [];
  if (arr.length <= keepTurns) return { summarize: [], keep: arr.slice() };
  return { summarize: arr.slice(0, arr.length - keepTurns), keep: arr.slice(arr.length - keepTurns) };
}

export class Compactor {
  constructor(ddb, opts = {}) {
    this.ddb = ddb;
    this.sessionsTable =
      opts.sessionsTable ||
      process.env.AGENT_SESSIONS_TABLE ||
      'futurator-agent-sessions';
    this.jobsTable =
      opts.jobsTable || process.env.AGENT_JOBS_TABLE || 'futurator-agent-jobs';
    this.intervalMs = opts.intervalMs || 5 * 60 * 1000;
    this.log = opts.log || (() => undefined);
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.tick().catch(() => undefined), this.intervalMs);
    if (this._timer.unref) this._timer.unref();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  async tick() {
    const candidates = await this.scanCandidates();
    if (candidates.length === 0) return { compacted: 0 };
    let compacted = 0;
    for (const session of candidates) {
      try {
        await this.compactSession(session);
        compacted += 1;
      } catch (err) {
        this.log('warn', `compaction failed for session ${session.sessionId}: ${err.message}`);
      }
    }
    return { compacted };
  }

  async scanCandidates() {
    const out = [];
    let ExclusiveStartKey;
    do {
      const result = await this.ddb.send(
        new ScanCommand({ TableName: this.sessionsTable, ExclusiveStartKey }),
      );
      for (const item of result.Items || []) {
        if (shouldCompact(item)) out.push(item);
      }
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return out;
  }

  /**
   * Mark the source session as ARCHIVED + create a placeholder compacted
   * session row. The actual transcript rewrite happens out-of-band: the
   * daemon spawns a Sonnet job whose output replaces the saved transcript
   * file. (V1: just marks the archival; a follow-up PR plugs in the
   * Sonnet rewrite.)
   */
  async compactSession(session) {
    const newId = randomUUID();
    const now = new Date().toISOString();
    await this.ddb.send(
      new PutCommand({
        TableName: this.sessionsTable,
        Item: {
          sessionId: newId,
          jobId: session.jobId,
          stepId: session.stepId,
          claudeSessionId: session.claudeSessionId,
          status: 'IDLE',
          cwd: session.cwd,
          agentKind: session.agentKind,
          tokenCount: Math.max(1, Math.floor((session.tokenCount || 0) * 0.4)),
          costUsd: 0,
          firstTurnAt: now,
          lastTurnAt: now,
          compactedFrom: session.sessionId,
        },
      }),
    );
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.sessionsTable,
        Key: { sessionId: session.sessionId },
        UpdateExpression: 'SET #s = :a',
        ExpressionAttributeNames: { '#s': 'status' },
        ExpressionAttributeValues: { ':a': 'ARCHIVED' },
      }),
    );
    return newId;
  }
}
