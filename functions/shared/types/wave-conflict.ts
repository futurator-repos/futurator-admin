/**
 * wave-conflict.ts — Story C (agentic-integration, 2026-05-29).
 *
 * A durable record of one wave-merge conflict. Written by the daemon
 * (daemon/lib/wave-conflict-recorder.mjs) on the halt path; read by the API
 * for the operator "conflicts / conflict-rate by plan" view. This is the
 * conflict-rate telemetry that worktree-rollout-design.md §2 named as the
 * precondition for ever revisiting auto-resolution.
 */

export type WaveConflictMode = 'halted' | 'operator-resolved' | 'auto-resolved';

export interface WaveConflictBlobMeta {
  file: string;
  bytes: number;
  truncated: boolean;
  unreadable: boolean;
}

export interface WaveConflictEvent {
  /** Partition key. */
  planId: string;
  /** Sort key — epoch-ms-prefixed, so a Query returns chronological order. */
  conflictId: string;
  appId: string;
  /** ISO-8601. */
  createdAt: string;
  epicId: string | null;
  waveNumber: number | null;
  mode: WaveConflictMode;
  /** The wip story whose merge raised the conflict. */
  conflictedAtStoryId: string | null;
  /** Conflicted file paths. */
  files: string[];
  fileCount: number;
  /** Stories successfully merged into the candidate before the conflict. */
  mergedStoryIds: string[];
  /** Per-file metadata (the full marker'd blobs live in the attention item). */
  blobMeta: WaveConflictBlobMeta[];
  candidateWorktree: string | null;
}

/** Aggregate conflict-rate view for an app (or plan). */
export interface WaveConflictRate {
  total: number;
  byMode: Record<WaveConflictMode, number>;
  /** file path → number of conflicts that touched it (the hot-file ranking). */
  byFile: Record<string, number>;
  firstAt: string | null;
  lastAt: string | null;
}
