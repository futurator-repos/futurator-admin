/**
 * Unit tests for wave-conflict-recorder.mjs (Story C — agentic-integration).
 *
 * Pins the durable conflict-event row shape: chronologically-sortable
 * conflictId, metadata-only blob summary (no full content → row stays under
 * the DDB 400 KB limit), and the partition/sort keys the operator query
 * relies on.
 */

import { describe, expect, it } from 'vitest';
import { recordWaveConflictEvent, WAVE_CONFLICTS_TABLE } from '../wave-conflict-recorder.mjs';

function fakeDdb() {
  const puts = [];
  return {
    puts,
    send: async (cmd) => {
      puts.push(cmd.input);
      return {};
    },
  };
}

const sampleEvent = {
  planId: 'plan_pacman',
  epicId: 'e2',
  waveNumber: 0,
  appId: 'pacman',
  mode: 'halted',
  conflictedAtStoryId: 'story-b',
  files: ['src/app/page.tsx'],
  mergedStoryIds: ['story-a'],
  blobs: [{ file: 'src/app/page.tsx', content: '<<<<<<< HEAD\n...', bytes: 1234, truncated: false }],
  candidateWorktree: '/home/ubuntu/worktrees/pacman/pacman-initial/_cand/job-1',
};

describe('recordWaveConflictEvent', () => {
  it('writes one row to the wave-conflicts table with the right keys', async () => {
    const ddb = fakeDdb();
    const { conflictId } = await recordWaveConflictEvent(ddb, sampleEvent);

    expect(ddb.puts).toHaveLength(1);
    const { TableName, Item } = ddb.puts[0];
    expect(TableName).toBe(WAVE_CONFLICTS_TABLE);
    expect(Item.planId).toBe('plan_pacman'); // PK
    expect(Item.conflictId).toBe(conflictId); // SK
    expect(Item.appId).toBe('pacman'); // GSI hash
    expect(typeof Item.createdAt).toBe('string'); // GSI range
    expect(Item.mode).toBe('halted');
    expect(Item.conflictedAtStoryId).toBe('story-b');
    expect(Item.files).toEqual(['src/app/page.tsx']);
    expect(Item.fileCount).toBe(1);
  });

  it('stores blob METADATA only — never the full marker content', async () => {
    const ddb = fakeDdb();
    await recordWaveConflictEvent(ddb, sampleEvent);
    const blobMeta = ddb.puts[0].Item.blobMeta;
    expect(blobMeta).toEqual([
      { file: 'src/app/page.tsx', bytes: 1234, truncated: false, unreadable: false },
    ]);
    // The big bit — content — must NOT be persisted in the row.
    expect(JSON.stringify(ddb.puts[0].Item)).not.toContain('<<<<<<<');
  });

  it('conflictId is epoch-ms-prefixed so a Query returns chronological order', async () => {
    const ddb = fakeDdb();
    const a = await recordWaveConflictEvent(ddb, sampleEvent);
    const b = await recordWaveConflictEvent(ddb, sampleEvent);
    // The 15-char epoch-ms PREFIX is monotonic non-decreasing (Date.now()),
    // so a Query sorts chronologically. The random suffix only de-dupes
    // within the same millisecond, so compare prefixes, not whole ids.
    expect(a.conflictId.slice(0, 15) <= b.conflictId.slice(0, 15)).toBe(true);
    expect(a.conflictId).toMatch(/^\d{15}-[0-9a-f]{8}$/);
    expect(b.conflictId).toMatch(/^\d{15}-[0-9a-f]{8}$/);
  });

  it('throws when planId is missing (the partition key)', async () => {
    const ddb = fakeDdb();
    await expect(recordWaveConflictEvent(ddb, { ...sampleEvent, planId: undefined })).rejects.toThrow();
  });
});
