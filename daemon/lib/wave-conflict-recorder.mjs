/**
 * wave-conflict-recorder.mjs — Story C (agentic-integration, 2026-05-29).
 *
 * Durable, queryable telemetry for wave-merge conflicts. Writes one row per
 * conflict to `futurator-wave-conflicts` (PK planId, SK conflictId). This is
 * the "data on how common conflicts are" that worktree-rollout-design.md §2
 * named as the precondition for ever revisiting auto-resolution — its
 * absence is exactly why the 2026-05-28 auto-resolver shipped with no data
 * and could be re-flipped under the next incident.
 *
 * The full conflicted blobs live in the attention item's context (and are
 * size-bounded there). This row keeps only the metadata needed for the
 * operator "conflicts / conflict-rate by plan" view, so the DDB item stays
 * well under the 400 KB limit even on a wide conflict.
 *
 * Best-effort: a recorder failure must NEVER block the wave-merge halt. The
 * caller wraps this in `.catch()`.
 */

import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';

export const WAVE_CONFLICTS_TABLE =
  process.env.WAVE_CONFLICTS_TABLE || 'futurator-wave-conflicts';

/**
 * Build a sortable conflictId: zero-padded epoch-ms prefix so a Query on the
 * partition returns conflicts in chronological order, plus a short random
 * suffix to avoid collisions within the same millisecond.
 */
function makeConflictId(nowMs) {
  const ts = String(nowMs).padStart(15, '0');
  return `${ts}-${randomUUID().slice(0, 8)}`;
}

/**
 * Record a wave-merge conflict event.
 *
 * @param {import('@aws-sdk/lib-dynamodb').DynamoDBDocumentClient} ddb
 * @param {{
 *   planId: string,
 *   epicId: string,
 *   waveNumber: number,
 *   appId: string,
 *   mode: 'halted' | 'operator-resolved' | 'auto-resolved',
 *   conflictedAtStoryId: string,
 *   files: string[],
 *   mergedStoryIds?: string[],
 *   blobs?: Array<{ file: string, bytes: number, truncated?: boolean, unreadable?: boolean }>,
 *   candidateWorktree?: string,
 * }} event
 * @param {(level: string, msg: string) => void} [log]
 * @returns {Promise<{ conflictId: string }>}
 */
export async function recordWaveConflictEvent(ddb, event, log = () => {}) {
  if (!event?.planId) throw new Error('recordWaveConflictEvent: planId required');
  const nowMs = Date.now();
  const conflictId = makeConflictId(nowMs);
  const createdAt = new Date(nowMs).toISOString();

  const item = {
    planId: event.planId,
    conflictId,
    appId: event.appId ?? 'unknown',
    createdAt,
    epicId: event.epicId ?? null,
    waveNumber: typeof event.waveNumber === 'number' ? event.waveNumber : null,
    mode: event.mode ?? 'halted',
    conflictedAtStoryId: event.conflictedAtStoryId ?? null,
    files: Array.isArray(event.files) ? event.files : [],
    fileCount: Array.isArray(event.files) ? event.files.length : 0,
    mergedStoryIds: Array.isArray(event.mergedStoryIds) ? event.mergedStoryIds : [],
    // Metadata only — the full marker'd content lives in the attention item.
    blobMeta: Array.isArray(event.blobs)
      ? event.blobs.map((b) => ({
          file: b.file,
          bytes: b.bytes ?? 0,
          truncated: !!b.truncated,
          unreadable: !!b.unreadable,
        }))
      : [],
    candidateWorktree: event.candidateWorktree ?? null,
    // snake3 (2026-06-10) — the resolver's own account of HOW it resolved
    // (or why it couldn't): transcript tail / infra cause. This is the
    // merge-forensics record the operator audits — previously the runner
    // passed `reasoning` and the recorder dropped it on the floor.
    reasoning: typeof event.reasoning === 'string' ? event.reasoning.slice(0, 4000) : null,
  };

  await ddb.send(new PutCommand({ TableName: WAVE_CONFLICTS_TABLE, Item: item }));
  log(
    'info',
    `[wave-conflict] recorded ${item.mode} conflict ${conflictId} (plan ${event.planId}, ` +
      `${item.fileCount} file(s)) → ${WAVE_CONFLICTS_TABLE}`,
  );
  return { conflictId };
}
