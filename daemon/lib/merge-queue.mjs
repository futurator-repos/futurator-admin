// merge-queue — a single-consumer FIFO that serializes integration (development-plan §5.2).
//
// Continuous Kahn dispatch means many stories finish concurrently and all want to
// merge into the same integration head. Letting them race is the index.md write
// race + the source of half the compile thrash. The fix is NOT lowering
// concurrency (parallelism is preserved during DEV) — it's funnelling the cheap,
// fast INTEGRATE step through one consumer so merges apply one-at-a-time against a
// moving head. Predicted-clean merges (via merge-tree) go first; predicted-dirty
// ones are deferred to the back so they re-predict against the advanced head.
//
// Pure, in-process, async-drained. The daemon owns one instance per plan.

export function createMergeQueue({ onMerge, log = () => {} } = {}) {
  const queue = [];
  let draining = false;
  const results = [];

  async function drain() {
    if (draining) return; // single consumer — never two drains at once
    draining = true;
    try {
      while (queue.length) {
        // FIFO, but predicted-clean before predicted-dirty (stable within class).
        queue.sort((a, b) => (a.dirty === b.dirty ? a.seq - b.seq : a.dirty ? 1 : -1));
        const item = queue.shift();
        try {
          const res = onMerge ? await onMerge(item) : { merged: true };
          results.push({ storyId: item.storyId, ...res });
        } catch (err) {
          log('warn', `[merge-queue] merge failed for ${item.storyId}: ${err?.message || err}`);
          results.push({ storyId: item.storyId, merged: false, error: String(err?.message || err) });
        }
      }
    } finally {
      draining = false;
    }
  }

  let seq = 0;
  return {
    /** Enqueue a story for integration. `dirty` = merge-tree predicted a conflict. */
    enqueue(item) {
      queue.push({ ...item, seq: seq++, dirty: Boolean(item.dirty) });
    },
    /** Process the queue to empty. Idempotent if already draining. */
    async run() {
      await drain();
      return results.slice();
    },
    get length() { return queue.length; },
    get isDraining() { return draining; },
    get results() { return results.slice(); },
  };
}
