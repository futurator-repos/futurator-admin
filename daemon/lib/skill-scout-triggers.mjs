/**
 * skill-scout-triggers.mjs — Pipeline v2 Phase 3 / Story 3-C-5 (PR-79).
 *
 * Helpers the daemon uses to decide WHEN SKILL-SCOUT fires for triggers
 * T4–T8. Each helper is a pure decision function — the daemon's spawn
 * loop hooks them at the relevant lifecycle points. v2.5 §38.
 *
 *   T4 — PM speculation marker         (gated to production rigor)
 *   T5 — new dependency added          (debounce 5min, skip transitive)
 *   T6 — REVIEWER repeats failure      (≥ 3 stories in one wave, same cluster)
 *   T7 — stream graduates to plan      (one-shot on transition)
 *   T8 — weekly federation refresh     (cron Monday 06:00 UTC)
 *
 * The actual daemon-loop wire-in (lifecycle event hooks, cron scheduler)
 * is a Story 3-C-5 follow-on; this module's exports are the contract
 * those wires implement.
 */

const DEBOUNCE_MS = 5 * 60 * 1000;

/**
 * T5: detect new dependencies added in a commit's diff. Returns the list
 * of newly-added package names (or empty when no new deps). Caller
 * passes the result of `git diff --name-only HEAD~1 HEAD` filtered to
 * `package.json` plus the before/after package.json contents.
 *
 * Skip rules:
 *   - lockfile-only changes (no package.json edit)
 *   - transitive resolutions (only `dependencies` + `devDependencies` top-level)
 *   - dep removals (this is the new-dep trigger; remove is out-of-band)
 *
 * @param {{
 *   beforePkgJson: object | null,
 *   afterPkgJson: object,
 * }} args
 * @returns {string[]} newly-added top-level dep names
 */
export function detectNewDependencies({ beforePkgJson, afterPkgJson }) {
  if (!afterPkgJson || typeof afterPkgJson !== 'object') return [];
  const beforeAll = collectTopLevelDeps(beforePkgJson);
  const afterAll = collectTopLevelDeps(afterPkgJson);
  const added = [];
  for (const name of afterAll) {
    if (!beforeAll.has(name)) added.push(name);
  }
  return added;
}

function collectTopLevelDeps(pkg) {
  const set = new Set();
  if (!pkg || typeof pkg !== 'object') return set;
  for (const block of ['dependencies', 'devDependencies']) {
    const deps = pkg[block];
    if (deps && typeof deps === 'object') {
      for (const name of Object.keys(deps)) set.add(name);
    }
  }
  return set;
}

/**
 * T5 debouncer. Operators frequently land 3-5 deps in one
 * `npm install <a> <b> <c>` flurry; firing SKILL-SCOUT per commit would
 * surface five separate cards. The debouncer accumulates over a 5-min
 * window per (projectSlug, dep) pair.
 *
 * In-memory only — the daemon's restart clears the debounce table. That's
 * acceptable: missing one card on the rare post-restart commit is
 * better than burning debounce state to disk.
 */
export function createT5Debouncer({ now = () => Date.now() } = {}) {
  const lastFiredAt = new Map(); // projectSlug → lastFiredMs
  const accumulated = new Map(); // projectSlug → Set<depName>

  function record({ projectSlug, deps }) {
    const t = now();
    const last = lastFiredAt.get(projectSlug);
    if (last && t - last < DEBOUNCE_MS) {
      // Within window — accumulate, don't fire
      const acc = accumulated.get(projectSlug) ?? new Set();
      for (const d of deps) acc.add(d);
      accumulated.set(projectSlug, acc);
      return { fire: false, deps: [], reason: 'debounce window active' };
    }
    // Outside window — flush accumulated + the new ones, fire
    const acc = accumulated.get(projectSlug) ?? new Set();
    for (const d of deps) acc.add(d);
    const final = Array.from(acc);
    accumulated.delete(projectSlug);
    lastFiredAt.set(projectSlug, t);
    return { fire: final.length > 0, deps: final, reason: 'window elapsed' };
  }

  return { record };
}

/**
 * T6: REVIEWER repeat-failure cluster detector. COMPILER calls this at
 * wave close with the wave's REVIEWER events grouped by story. Returns
 * the file-cluster ids that crossed the ≥ 3 threshold.
 *
 * "Cluster" here = a coarse module bucket derived from the first path
 * segment under `src/` (or its boilerplate equivalent). Two REVIEWER
 * rejections in `src/components/Foo.tsx` + `src/components/Bar.tsx`
 * count as the same `components` cluster. v2.5 §38 T6.
 *
 * @param {Array<{ storyId: string, rejectedFiles: string[] }>} reviewerRejections
 * @returns {Array<{ cluster: string, storyIds: string[] }>}
 */
export function detectReviewerClusters(reviewerRejections) {
  const buckets = new Map(); // cluster → Set<storyId>
  for (const rej of reviewerRejections || []) {
    const storyId = String(rej?.storyId ?? '');
    if (!storyId) continue;
    for (const file of rej?.rejectedFiles ?? []) {
      const cluster = bucketForPath(String(file));
      if (!cluster) continue;
      const set = buckets.get(cluster) ?? new Set();
      set.add(storyId);
      buckets.set(cluster, set);
    }
  }
  const out = [];
  for (const [cluster, storyIds] of buckets.entries()) {
    if (storyIds.size >= 3) {
      out.push({ cluster, storyIds: Array.from(storyIds).sort() });
    }
  }
  return out.sort((a, b) => a.cluster.localeCompare(b.cluster));
}

function bucketForPath(path) {
  // Normalize: strip leading ./, split on / or \, return the segment
  // after the source-root prefix (src/, app/, lib/, components/).
  const norm = path.replace(/^[./\\]+/, '');
  const parts = norm.split(/[/\\]/);
  if (parts.length === 0) return null;
  const sourceRoots = new Set(['src', 'app', 'lib', 'functions', 'components']);
  if (sourceRoots.has(parts[0]) && parts.length > 1) {
    return parts[1];
  }
  return parts[0];
}

/**
 * T7: stream-graduation trigger handler. Called when a `stream/<n>`
 * branch transitions to a Labs plan. Returns the args the runner uses
 * to fire SKILL-SCOUT with the stream's commit history as evidence.
 *
 * @param {{ streamName: string, planId: string, projectSlug: string, planIntent: string }} args
 */
export function buildT7Args({ streamName, planId, projectSlug, planIntent }) {
  return {
    trigger: 'T7',
    planId,
    projectSlug,
    planIntent: `Graduating stream/${streamName} → plan: ${planIntent}`,
  };
}

/**
 * T8: weekly federation refresh scheduler hook. Returns the cron
 * configuration the daemon uses to schedule the refresh tick. Monday
 * 06:00 UTC per v2.5 §35.1.
 *
 * The actual cron-Lambda wire-in (or daemon setInterval) is a Story
 * 3-C-5-2 follow-on; this export defines the schedule contract.
 */
export const T8_REFRESH_SCHEDULE = Object.freeze({
  cronExpr: '0 6 * * MON', // Monday 06:00 UTC
  utc: true,
  description: 'Weekly federation refresh (v2.5 §35.1)',
});

/**
 * T8: per-source refresh tick. Walks the federation sources, fetches
 * each index, returns the deltas (new versions, new skills, deprecations).
 * The daemon's existing federation-resolver knows how to fetch indices;
 * this helper layers the delta-computation on top.
 *
 * Output is fed to SKILL-SCOUT as the `planIntent` text under T8.
 *
 * @param {{
 *   currentResolver: { inspectCache(): Record<string, { skillCount: number, fetchedAt: number, error?: string }> },
 *   priorSnapshot: Record<string, Set<string>> | null,  // sourceId → known skills at previous refresh
 *   currentSnapshot: Record<string, Set<string>>,
 * }} args
 * @returns {Array<{ sourceId: string, addedSkills: string[], removedSkills: string[] }>}
 */
export function computeT8Deltas({ priorSnapshot, currentSnapshot }) {
  const out = [];
  for (const [sourceId, currentSet] of Object.entries(currentSnapshot || {})) {
    const priorSet = priorSnapshot?.[sourceId] ?? new Set();
    const added = [...currentSet].filter((s) => !priorSet.has(s)).sort();
    const removed = [...priorSet].filter((s) => !currentSet.has(s)).sort();
    if (added.length === 0 && removed.length === 0) continue;
    out.push({ sourceId, addedSkills: added, removedSkills: removed });
  }
  return out;
}
