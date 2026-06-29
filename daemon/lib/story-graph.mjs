// story-graph — the pure Kahn engine for Pipeline-3 scheduling (development-plan §5.2).
//
// No I/O. Operates on plain StoryNode rows ({ storyId, depends_on, state, ... }).
// Three responsibilities, all pure functions:
//   • detectCycles  — reject a plan_spec whose depends_on isn't a DAG (at ingest)
//   • topoOrder / topoLevels — deterministic order + cohortBatch levels
//   • readyFrontier — which stories are dispatchable RIGHT NOW (continuous Kahn,
//     replacing the fixed wave barrier)
//   • applyTransition — the StoryNode lifecycle state machine (immutable)
//
// The frontier is computed from `depends_on` closure against the set of `done`
// stories, so dispatch is eager: a story fires the instant its deps finish, not
// at the next wave tick.

export const STORY_STATES = Object.freeze([
  'blocked', 'ready', 'claimed', 'developing', 'merging', 'verifying', 'done', 'failed',
]);

// Allowed transitions. `failed` is reachable from any non-terminal state; a
// claimed/developing story can be released back to ready on lease expiry.
const TRANSITIONS = Object.freeze({
  blocked: ['ready', 'failed'],
  ready: ['claimed', 'blocked', 'failed'],
  claimed: ['developing', 'ready', 'failed'], // ready = lease reclaim
  developing: ['merging', 'ready', 'failed'],
  merging: ['verifying', 'failed'],
  verifying: ['done', 'failed'],
  done: [],
  failed: ['ready'], // operator/retry can re-open a failed story
});

/** Index nodes by storyId. */
function byId(nodes) {
  const m = new Map();
  for (const n of nodes) m.set(n.storyId, n);
  return m;
}

/**
 * Detect dependency cycles. Returns an array of cycles (each a storyId[] path);
 * empty array ⇒ the graph is a DAG. Also surfaces dangling deps separately.
 *
 * @param {Array<{storyId:string, depends_on?:string[]}>} nodes
 * @returns {{ cycles: string[][], dangling: Array<{storyId:string, missing:string}> }}
 */
export function detectCycles(nodes) {
  const map = byId(nodes);
  const dangling = [];
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (!map.has(dep)) dangling.push({ storyId: n.storyId, missing: dep });
    }
  }

  const cycles = [];
  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map(nodes.map((n) => [n.storyId, WHITE]));
  const stack = [];

  const visit = (id) => {
    color.set(id, GRAY);
    stack.push(id);
    const node = map.get(id);
    for (const dep of (node?.depends_on || [])) {
      if (!map.has(dep)) continue; // dangling handled above
      const c = color.get(dep);
      if (c === GRAY) {
        const i = stack.indexOf(dep);
        cycles.push(stack.slice(i).concat(dep));
      } else if (c === WHITE) {
        visit(dep);
      }
    }
    stack.pop();
    color.set(id, BLACK);
  };

  for (const n of nodes) if (color.get(n.storyId) === WHITE) visit(n.storyId);
  return { cycles, dangling };
}

/** True when depends_on forms a DAG with no dangling references. */
export function isDag(nodes) {
  const { cycles, dangling } = detectCycles(nodes);
  return cycles.length === 0 && dangling.length === 0;
}

/**
 * Kahn topological order. Returns storyId[] (deps before dependents) or null if
 * the graph has a cycle. Stable: ties broken by storyId for determinism.
 */
export function topoOrder(nodes) {
  const map = byId(nodes);
  const indeg = new Map(nodes.map((n) => [n.storyId, 0]));
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (map.has(dep)) indeg.set(n.storyId, indeg.get(n.storyId) + 1);
    }
  }
  const ready = [...indeg.entries()].filter(([, d]) => d === 0).map(([id]) => id).sort();
  const order = [];
  // dependents index
  const dependents = new Map(nodes.map((n) => [n.storyId, []]));
  for (const n of nodes) {
    for (const dep of n.depends_on || []) {
      if (map.has(dep)) dependents.get(dep).push(n.storyId);
    }
  }
  while (ready.length) {
    const id = ready.shift();
    order.push(id);
    for (const dependent of (dependents.get(id) || []).sort()) {
      indeg.set(dependent, indeg.get(dependent) - 1);
      if (indeg.get(dependent) === 0) {
        // insert keeping the queue sorted for deterministic order
        const pos = ready.findIndex((x) => x > dependent);
        if (pos === -1) ready.push(dependent); else ready.splice(pos, 0, dependent);
      }
    }
  }
  return order.length === nodes.length ? order : null;
}

/**
 * Topological LEVELS — the `cohortBatch` value. Level 0 = no deps; a node's level
 * is 1 + max(level of its deps). Shared by ingest (seeds cohortBatch) and the UI
 * (merge grouping). Returns Map<storyId, level> or null on cycle.
 */
export function topoLevels(nodes) {
  const order = topoOrder(nodes);
  if (!order) return null;
  const map = byId(nodes);
  const level = new Map();
  for (const id of order) {
    const deps = (map.get(id).depends_on || []).filter((d) => map.has(d));
    level.set(id, deps.length ? Math.max(...deps.map((d) => level.get(d))) + 1 : 0);
  }
  return level;
}

/**
 * The ready frontier: storyIds dispatchable right now. A story is dispatchable
 * when it is NOT terminal/in-flight AND every dependency is `done`.
 *
 * Pass the live node set (each with `state` + `depends_on`). This is the
 * continuous-Kahn replacement for the wave barrier — call it after every
 * completion to find newly-unblocked work.
 *
 * @param {Array<{storyId, depends_on?, state}>} nodes
 * @returns {string[]} dispatchable storyIds, deterministic (sorted)
 */
export function readyFrontier(nodes) {
  const map = byId(nodes);
  const isDone = (id) => map.get(id)?.state === 'done';
  const out = [];
  for (const n of nodes) {
    if (n.state !== 'blocked' && n.state !== 'ready') continue;
    const deps = (n.depends_on || []).filter((d) => map.has(d));
    if (deps.every(isDone)) out.push(n.storyId);
  }
  return out.sort();
}

/** True when a single story's deps are all satisfied by `doneSet`. */
export function isStoryDispatchable(node, doneSet) {
  if (!node) return false;
  if (node.state !== 'blocked' && node.state !== 'ready') return false;
  return (node.depends_on || []).every((d) => doneSet.has(d));
}

/**
 * Apply a lifecycle transition. PURE — returns a NEW node, or throws on an
 * illegal transition (caller decides whether to swallow). `to` is the target
 * state; STORY_STATES enumerates them.
 */
export function applyTransition(node, to) {
  const from = node.state;
  const allowed = TRANSITIONS[from];
  if (!allowed) throw new Error(`story-graph: unknown state "${from}"`);
  if (from === to) return node;
  if (!allowed.includes(to)) {
    throw new Error(`story-graph: illegal transition ${from} → ${to} for ${node.storyId}`);
  }
  return { ...node, state: to };
}

/** Whether a transition is legal without throwing. */
export function canTransition(from, to) {
  return Boolean(TRANSITIONS[from]?.includes(to)) || from === to;
}
