/**
 * worktree-reaper.mjs — Phase 1 worktree rollout (2026-05-19).
 *
 * Daemon-internal hourly ticker. Three reap loops:
 *
 *   1. Per-story worktrees under /home/ubuntu/worktrees/<app>/<plan>/<storyId>/
 *      → reap when the owning jobId is terminal AND stale-by-24h, OR when
 *      the job row no longer exists (plan-delete cascade), OR when the
 *      directory is orphaned (no git-worktree-list entry).
 *
 *   2. Coordinator worktrees under /home/ubuntu/worktrees/<app>/<plan>/_merge/
 *      → reap when the plan row is `delivered` / `abandoned` / `archived`,
 *      or missing.
 *
 *   3. node_modules store entries under /home/ubuntu/.node_modules_store/<app>/<sha>/
 *      → reap when .refcount.json reads 0 AND no live symlink target the entry.
 *
 *   4. Free-agent assist worktrees under /home/ubuntu/worktrees/<app>/_assist/<sidShort>/
 *      → reap when the owning session is in a terminal status
 *      (IDLE|EXPIRED|BUDGET_EXHAUSTED|ERROR) AND lastActivityAt is older than
 *      7 days. Mirror of the `_party` namespace classifier. 2026-05-27
 *      unification — see `docs/concepts/free-agent-unification.md`.
 *
 * NAMESPACE BOUNDARIES (design doc §3):
 *   - This reaper NEVER touches /home/ubuntu/projects/<app>/ (legacy
 *     operator-owned shared worktrees).
 *   - The legacy /home/ubuntu/free-agent-worktrees/ root was removed by the
 *     one-shot unification migration; free-agent worktrees now share the
 *     standard root under the `_assist` namespace.
 *
 * Idempotent: safe to invoke any number of times back-to-back.
 *
 * See `docs/concepts/pipeline-v2/worktree-rollout-design.md` §3.
 */

import { existsSync, lstatSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import {
  STORE_ROOT,
  readRefcount,
} from './node-modules-store.mjs';
import { teardownStoryWorktree, bareRepoPath, LEGACY_PROJECTS_ROOT } from './story-worktree.mjs';
import { WORKTREE_ROOT_DEFAULT } from './worktree-paths.mjs';

const STALE_TERMINAL_MS = 24 * 60 * 60 * 1000; // 24h
const TERMINAL_STATUSES = new Set([
  'COMPLETED',
  'COMPLETED_VIA_SALVAGE',
  'COMPLETED_VIA_PREWORK',
  'COMPLETE_WITH_BLOCKED_STORIES',
  'COMPLETED_VIA_TALK',
  'MANUALLY_SKIPPED',
  'FAILED',
  'STALE',
  'ORPHANED',
]);
const PLAN_TERMINAL_STATUSES = new Set(['delivered', 'abandoned', 'archived']);

// Story 19.7 — party worktree namespace (`_party/<sidShort>/`). Terminal
// statuses + stale window match party-session semantics: debate artifacts
// in `docs/` deserve a longer recoverable window than per-story (which
// just hold transient build state).
export const PARTY_TERMINAL_STATUSES = new Set(['ENDED', 'CANCELLED', 'EXPIRED']);
export const PARTY_STALE_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// 2026-05-27 unification — assist worktree namespace (`_assist/<sidShort>/`).
// Free-agent sessions go to terminal `IDLE`/`EXPIRED`/`BUDGET_EXHAUSTED`/`ERROR`
// via the API GC or daemon turn-end; 7d stale window matches party.
export const ASSIST_TERMINAL_STATUSES = new Set([
  'IDLE',
  'EXPIRED',
  'BUDGET_EXHAUSTED',
  'ERROR',
]);
export const ASSIST_STALE_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function runGit(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn('sudo', ['-n', '-u', 'ubuntu', 'git', ...args], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => (stdout += b.toString('utf8')));
    child.stderr.on('data', (b) => (stderr += b.toString('utf8')));
    child.on('error', (e) => resolve({ code: -1, stdout: '', stderr: e.message }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

/**
 * Walk a directory two levels deep (apps → plans → stories), yielding
 * { appId, planSlug, storyId, fullPath } for each leaf. Skips _merge
 * coordinator dirs (they're reaped separately).
 */
function* walkPerStoryWorktrees(root) {
  if (!existsSync(root)) return;
  for (const app of readdirSync(root, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appDir = join(root, app.name);
    for (const plan of readdirSync(appDir, { withFileTypes: true })) {
      if (!plan.isDirectory()) continue;
      // Story 19.7 — `_party` is a sibling-of-plan namespace; never a plan
      // slug. Skipping at this layer keeps per-story + party walkers
      // from double-walking the same paths.
      if (plan.name === '_party') continue;
      // 2026-05-27 unification — same treatment for `_assist`.
      if (plan.name === '_assist') continue;
      const planDir = join(appDir, plan.name);
      for (const story of readdirSync(planDir, { withFileTypes: true })) {
        if (!story.isDirectory()) continue;
        if (story.name === '_merge') continue;
        // Story B (2026-05-29) — `_cand/<jobId>` holds ephemeral wave-merge
        // candidate worktrees; never a per-story worktree. The runner reaps
        // them inline on success/build-failure; this skip stops the reaper
        // misclassifying a lingering candidate as a story orphan.
        if (story.name === '_cand') continue;
        yield {
          appId: app.name,
          planSlug: plan.name,
          storyId: story.name,
          fullPath: join(planDir, story.name),
        };
      }
    }
  }
}

/**
 * Story 19.7 — walk `/home/ubuntu/worktrees/<app>/_party/<sidShort>/` and
 * yield `{ appId, sessionIdShort, fullPath }`. `_party` lives as a sibling
 * of plan slugs under the app dir (per `plan.md` §10 worktree adoption
 * appendix) so the walker descends two levels: `<app>/_party/<sid>/`.
 *
 * Pre-Epic-20: no party worktrees exist on disk → walker yields nothing
 * → reaper logs `party 0/0`. The structure is in place so Story 20.15
 * can wire the real classifier without further skeleton work.
 */
function* walkPartyWorktrees(root) {
  if (!existsSync(root)) return;
  for (const app of readdirSync(root, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const partyDir = join(root, app.name, '_party');
    if (!existsSync(partyDir) || !statSync(partyDir).isDirectory()) continue;
    for (const sid of readdirSync(partyDir, { withFileTypes: true })) {
      if (!sid.isDirectory()) continue;
      yield {
        appId: app.name,
        sessionIdShort: sid.name,
        fullPath: join(partyDir, sid.name),
      };
    }
  }
}

/**
 * 2026-05-27 unification — walk `/home/ubuntu/worktrees/<app>/_assist/<sidShort>/`
 * and yield `{ appId, sessionIdShort, fullPath }`. Mirror of walkPartyWorktrees.
 */
function* walkAssistWorktrees(root) {
  if (!existsSync(root)) return;
  for (const app of readdirSync(root, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const assistDir = join(root, app.name, '_assist');
    if (!existsSync(assistDir) || !statSync(assistDir).isDirectory()) continue;
    for (const sid of readdirSync(assistDir, { withFileTypes: true })) {
      if (!sid.isDirectory()) continue;
      yield {
        appId: app.name,
        sessionIdShort: sid.name,
        fullPath: join(assistDir, sid.name),
      };
    }
  }
}

/**
 * Walk for coordinator (_merge) worktrees only.
 */
function* walkCoordinatorWorktrees(root) {
  if (!existsSync(root)) return;
  for (const app of readdirSync(root, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appDir = join(root, app.name);
    for (const plan of readdirSync(appDir, { withFileTypes: true })) {
      if (!plan.isDirectory()) continue;
      const merge = join(appDir, plan.name, '_merge');
      if (existsSync(merge) && statSync(merge).isDirectory()) {
        yield { appId: app.name, planSlug: plan.name, fullPath: merge };
      }
    }
  }
}

/**
 * Walk store entries.
 */
function* walkStoreEntries(storeRoot) {
  if (!existsSync(storeRoot)) return;
  for (const app of readdirSync(storeRoot, { withFileTypes: true })) {
    if (!app.isDirectory()) continue;
    const appDir = join(storeRoot, app.name);
    for (const sha of readdirSync(appDir, { withFileTypes: true })) {
      if (!sha.isDirectory()) continue;
      yield { appId: app.name, lockfileSha: sha.name, fullPath: join(appDir, sha.name) };
    }
  }
}

/**
 * Resolve a per-story worktree against the daemon's job + epic state.
 * Returns `{ shouldReap: boolean, reason: string }`.
 */
// 2026-06-02 — NEVER reap a per-story worktree that was just touched. A
// "lookup miss" (findStoryByIds / getJobById returning null) can be transient
// — a throttled/eventually-consistent DDB Scan, swallowed by `.catch(()=>null)`
// — NOT proof the story is gone. The hourly reaper was destroying ACTIVE
// wave-N story worktrees mid-run on such a miss, which killed review-runtime
// (no dev server / no screenshot), emptied the story commit, and lost the
// story's code. An in-flight story's worktree is written constantly (fresh
// mtime); a genuine orphan is stale. Only reap-on-missing when stale.
const FRESH_WORKTREE_MS = 30 * 60 * 1000; // 30 min

function worktreeMostRecentMtimeMs(fullPath) {
  let newest = 0;
  try {
    newest = statSync(fullPath).mtimeMs;
    for (const e of readdirSync(fullPath, { withFileTypes: true })) {
      try {
        const m = statSync(join(fullPath, e.name)).mtimeMs;
        if (m > newest) newest = m;
      } catch {
        /* ignore unreadable child */
      }
    }
  } catch {
    /* ignore — treat as ancient (0) so a vanished dir is reapable */
  }
  return newest;
}

async function classifyStoryWorktree({ entry, deps }) {
  // The job that owns this worktree is the one whose storyId matches.
  // Multiple jobs can own the same storyId over time (retries) — we want
  // the LATEST one. The story-row tracks the latest jobId.
  const story = await deps.findStoryByIds(entry).catch(() => null);
  if (!story || !story.jobId) {
    const ageMs = Date.now() - worktreeMostRecentMtimeMs(entry.fullPath);
    if (ageMs < FRESH_WORKTREE_MS) {
      return {
        shouldReap: false,
        reason: `lookup-miss-but-fresh (${Math.round(ageMs / 60_000)}min — likely active, not reaping)`,
      };
    }
    return { shouldReap: true, reason: story ? 'story-has-no-jobId' : 'story-row-missing' };
  }
  const job = await deps.getJobById(story.jobId).catch(() => null);
  if (!job) {
    const ageMs = Date.now() - worktreeMostRecentMtimeMs(entry.fullPath);
    if (ageMs < FRESH_WORKTREE_MS) {
      return {
        shouldReap: false,
        reason: `job-lookup-miss-but-fresh (${Math.round(ageMs / 60_000)}min — likely active, not reaping)`,
      };
    }
    return { shouldReap: true, reason: 'job-row-missing' };
  }
  if (!TERMINAL_STATUSES.has(job.status)) {
    return { shouldReap: false, reason: 'job-active' };
  }
  // Job terminal + stale-by-24h.
  const updatedAt = job.updatedAt ? Date.parse(job.updatedAt) : 0;
  const ageMs = Date.now() - updatedAt;
  if (ageMs < STALE_TERMINAL_MS) {
    return { shouldReap: false, reason: `job-terminal-but-fresh (${Math.round(ageMs / 60_000)}min ago)` };
  }
  return { shouldReap: true, reason: `terminal-and-stale (${Math.round(ageMs / 3_600_000)}h ago)` };
}

/**
 * Story 19.7 — resolve a party worktree against the session row.
 *
 * **PR 0 ships a no-op classifier**: when `deps.findPartySessionByShort`
 * is not wired (which is the case until Story 20.15), this returns
 * `{ shouldReap: false, reason: 'lookup-not-wired' }` UNCONDITIONALLY.
 * Reverse order (real classifier first, then no-op) risks the reaper
 * deleting party worktrees during the Epic 20 rollout before the lookup
 * fixture is in place.
 *
 * Story 20.15 lights up the real branches:
 *   - session row missing → reap
 *   - session status in PARTY_TERMINAL_STATUSES + age > PARTY_STALE_TERMINAL_MS → reap
 *   - otherwise → keep
 */
async function classifyPartyWorktree({ entry, deps }) {
  if (typeof deps.findPartySessionByShort !== 'function') {
    return { shouldReap: false, reason: 'lookup-not-wired' };
  }
  // Story 20.15 will replace this stub. The shape below documents the
  // intended behavior for future-Claude:
  const session = await deps.findPartySessionByShort(entry.sessionIdShort).catch(() => null);
  if (!session) return { shouldReap: true, reason: 'session-row-missing' };
  if (!PARTY_TERMINAL_STATUSES.has(session.status)) {
    return { shouldReap: false, reason: `session-active (${session.status})` };
  }
  const updatedAt = session.updatedAt
    ? Date.parse(session.updatedAt)
    : session.lastTurnAt
      ? Date.parse(session.lastTurnAt)
      : 0;
  const ageMs = Date.now() - updatedAt;
  if (ageMs < PARTY_STALE_TERMINAL_MS) {
    return {
      shouldReap: false,
      reason: `session-terminal-but-fresh (${Math.round(ageMs / 3_600_000)}h ago)`,
    };
  }
  return {
    shouldReap: true,
    reason: `session-terminal-and-stale (${Math.round(ageMs / 3_600_000)}h ago)`,
  };
}

/**
 * 2026-05-27 unification — resolve a free-agent assist worktree against the
 * `futurator-free-agent-sessions` row. Mirrors classifyPartyWorktree:
 *   - lookup not wired (e.g., in tests / boot before deps assembled) → keep
 *   - session row missing → reap (orphan)
 *   - session active (status not in ASSIST_TERMINAL_STATUSES) → keep
 *   - session terminal but lastActivityAt < 7d ago → keep
 *   - session terminal AND lastActivityAt > 7d ago → reap
 */
async function classifyAssistWorktree({ entry, deps }) {
  if (typeof deps.findFreeAgentSessionByShort !== 'function') {
    return { shouldReap: false, reason: 'lookup-not-wired' };
  }
  const session = await deps.findFreeAgentSessionByShort(entry.sessionIdShort).catch(() => null);
  if (!session) return { shouldReap: true, reason: 'session-row-missing' };
  if (!ASSIST_TERMINAL_STATUSES.has(session.status)) {
    return { shouldReap: false, reason: `session-active (${session.status})` };
  }
  const lastActivityMs = session.lastActivityAt ? Date.parse(session.lastActivityAt) : 0;
  const ageMs = Date.now() - lastActivityMs;
  if (ageMs < ASSIST_STALE_TERMINAL_MS) {
    return {
      shouldReap: false,
      reason: `session-terminal-but-fresh (${Math.round(ageMs / 3_600_000)}h ago)`,
    };
  }
  return {
    shouldReap: true,
    reason: `session-terminal-and-stale (${Math.round(ageMs / 3_600_000)}h ago)`,
  };
}

/**
 * Resolve a coordinator worktree against the plan row.
 */
async function classifyCoordinatorWorktree({ entry, deps }) {
  // Plan slug doesn't uniquely identify the plan (multiple plans on the
  // same App share an appId but each has its own name; plan name = slug).
  // Look up the plan by name to find the row.
  const plan = await deps.findPlanByAppAndSlug(entry.appId, entry.planSlug).catch(() => null);
  if (!plan) {
    return { shouldReap: true, reason: 'plan-row-missing' };
  }
  if (PLAN_TERMINAL_STATUSES.has(plan.status)) {
    return { shouldReap: true, reason: `plan-terminal (${plan.status})` };
  }
  return { shouldReap: false, reason: 'plan-active' };
}

/**
 * Resolve a store entry: reap when refcount=0 AND no live symlink.
 * The symlink scan is bounded to WORKTREE_ROOT + LEGACY_PROJECTS_ROOT.
 */
function classifyStoreEntry({ entry, knownSymlinkTargets }) {
  const refcount = readRefcount(entry.appId, entry.lockfileSha);
  if (refcount.count > 0) {
    return { shouldReap: false, reason: `refcount=${refcount.count}` };
  }
  const target = join(entry.fullPath, 'node_modules');
  if (knownSymlinkTargets.has(target)) {
    return { shouldReap: false, reason: 'live-symlink-found' };
  }
  return { shouldReap: true, reason: 'refcount=0-and-no-symlinks' };
}

/**
 * Scan all per-story + legacy worktrees for symlinks under their
 * `node_modules` and return the set of unique store targets.
 */
function collectLiveSymlinkTargets() {
  const targets = new Set();
  const candidates = [];
  // Per-story worktrees.
  if (existsSync(WORKTREE_ROOT_DEFAULT)) {
    for (const e of walkPerStoryWorktrees(WORKTREE_ROOT_DEFAULT)) candidates.push(e.fullPath);
    for (const e of walkCoordinatorWorktrees(WORKTREE_ROOT_DEFAULT)) candidates.push(e.fullPath);
  }
  // Legacy shared worktrees.
  if (existsSync(LEGACY_PROJECTS_ROOT)) {
    for (const app of readdirSync(LEGACY_PROJECTS_ROOT, { withFileTypes: true })) {
      if (app.isDirectory()) candidates.push(join(LEGACY_PROJECTS_ROOT, app.name));
    }
  }
  for (const dir of candidates) {
    const nm = join(dir, 'node_modules');
    if (!existsSync(nm)) continue;
    let st;
    try {
      st = lstatSync(nm);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      try {
        targets.add(readlinkSync(nm));
      } catch {
        /* unreadable link */
      }
    }
  }
  return targets;
}

/**
 * Top-level entry point. Run all three reap loops. Returns a structured
 * summary the caller can log + emit as a metric.
 */
export async function runWorktreeReaper(deps) {
  const t0 = Date.now();
  const summary = {
    perStory: { scanned: 0, reaped: 0, errors: 0 },
    coordinator: { scanned: 0, reaped: 0, errors: 0 },
    store: { scanned: 0, reaped: 0, errors: 0 },
    party: { scanned: 0, reaped: 0, errors: 0 },
    assist: { scanned: 0, reaped: 0, errors: 0 },
    elapsedMs: 0,
  };
  const log = deps.log || (() => {});

  // ── 1. Per-story worktrees ────────────────────────────────────────────
  for (const entry of walkPerStoryWorktrees(WORKTREE_ROOT_DEFAULT)) {
    summary.perStory.scanned++;
    try {
      const verdict = await classifyStoryWorktree({ entry, deps });
      if (!verdict.shouldReap) continue;
      log('info', `[reaper] per-story REAP ${entry.fullPath} (${verdict.reason})`);
      await teardownStoryWorktree({
        appId: entry.appId,
        planSlug: entry.planSlug,
        storyId: entry.storyId,
        deleteBranch: true,
        log,
      });
      summary.perStory.reaped++;
    } catch (err) {
      summary.perStory.errors++;
      log('error', `[reaper] per-story FAIL ${entry.fullPath}: ${err.message}`);
    }
  }

  // ── 2. Coordinator worktrees ──────────────────────────────────────────
  for (const entry of walkCoordinatorWorktrees(WORKTREE_ROOT_DEFAULT)) {
    summary.coordinator.scanned++;
    try {
      const verdict = await classifyCoordinatorWorktree({ entry, deps });
      if (!verdict.shouldReap) continue;
      log('info', `[reaper] coordinator REAP ${entry.fullPath} (${verdict.reason})`);
      // Coordinator has no per-story node_modules state; just remove it
      // via git worktree then rm -rf.
      const bare = bareRepoPath(entry.appId);
      if (existsSync(bare)) {
        await runGit(
          ['--git-dir', bare, 'worktree', 'remove', '--force', entry.fullPath],
          LEGACY_PROJECTS_ROOT,
        );
      }
      if (existsSync(entry.fullPath)) {
        rmSync(entry.fullPath, { recursive: true, force: true });
      }
      summary.coordinator.reaped++;
    } catch (err) {
      summary.coordinator.errors++;
      log('error', `[reaper] coordinator FAIL ${entry.fullPath}: ${err.message}`);
    }
  }

  // ── 3. Party worktrees (Story 19.7) ───────────────────────────────────
  // No-op classifier until Story 20.15 wires `deps.findPartySessionByShort`.
  // Walk-only here ensures the summary line carries `party N/M` so operators
  // can see at-a-glance whether party worktrees are accumulating on disk
  // even before reaping is enabled.
  for (const entry of walkPartyWorktrees(WORKTREE_ROOT_DEFAULT)) {
    summary.party.scanned++;
    try {
      const verdict = await classifyPartyWorktree({ entry, deps });
      if (!verdict.shouldReap) continue;
      log('info', `[reaper] party REAP ${entry.fullPath} (${verdict.reason})`);
      // Mirror coordinator teardown shape: `git worktree remove --force` via
      // the bare repo, then `rm -rf` the path.
      const bare = bareRepoPath(entry.appId);
      if (existsSync(bare)) {
        await runGit(
          ['--git-dir', bare, 'worktree', 'remove', '--force', entry.fullPath],
          LEGACY_PROJECTS_ROOT,
        );
      }
      if (existsSync(entry.fullPath)) {
        rmSync(entry.fullPath, { recursive: true, force: true });
      }
      summary.party.reaped++;
    } catch (err) {
      summary.party.errors++;
      log('error', `[reaper] party FAIL ${entry.fullPath}: ${err.message}`);
    }
  }

  // ── 4. Assist worktrees (2026-05-27 unification) ──────────────────────
  // Mirrors the party loop above. Reaper deps include
  // `findFreeAgentSessionByShort` (wired in agent-daemon.mjs);
  // when missing the classifier returns `lookup-not-wired` → keep.
  for (const entry of walkAssistWorktrees(WORKTREE_ROOT_DEFAULT)) {
    summary.assist.scanned++;
    try {
      const verdict = await classifyAssistWorktree({ entry, deps });
      if (!verdict.shouldReap) continue;
      log('info', `[reaper] assist REAP ${entry.fullPath} (${verdict.reason})`);
      const bare = bareRepoPath(entry.appId);
      if (existsSync(bare)) {
        await runGit(
          ['--git-dir', bare, 'worktree', 'remove', '--force', entry.fullPath],
          LEGACY_PROJECTS_ROOT,
        );
      }
      if (existsSync(entry.fullPath)) {
        rmSync(entry.fullPath, { recursive: true, force: true });
      }
      summary.assist.reaped++;
    } catch (err) {
      summary.assist.errors++;
      log('error', `[reaper] assist FAIL ${entry.fullPath}: ${err.message}`);
    }
  }

  // ── 5. node_modules store entries ─────────────────────────────────────
  const liveTargets = collectLiveSymlinkTargets();
  for (const entry of walkStoreEntries(STORE_ROOT)) {
    summary.store.scanned++;
    try {
      const verdict = classifyStoreEntry({ entry, knownSymlinkTargets: liveTargets });
      if (!verdict.shouldReap) continue;
      log(
        'info',
        `[reaper] store REAP ${entry.appId}/${entry.lockfileSha} (${verdict.reason})`,
      );
      rmSync(entry.fullPath, { recursive: true, force: true });
      summary.store.reaped++;
    } catch (err) {
      summary.store.errors++;
      log('error', `[reaper] store FAIL ${entry.fullPath}: ${err.message}`);
    }
  }

  summary.elapsedMs = Date.now() - t0;
  log(
    'info',
    `[reaper] done in ${summary.elapsedMs}ms — per-story ${summary.perStory.reaped}/${summary.perStory.scanned}, coordinator ${summary.coordinator.reaped}/${summary.coordinator.scanned}, store ${summary.store.reaped}/${summary.store.scanned}, party ${summary.party.reaped}/${summary.party.scanned}, assist ${summary.assist.reaped}/${summary.assist.scanned}`,
  );
  return summary;
}

/**
 * Start an hourly reaper ticker. Returns an `{ stop }` handle for tests
 * + graceful daemon shutdown. The first run fires after the initial
 * delay (default 5 min) so the daemon doesn't reap stuff during startup
 * race windows.
 */
export function startReaperTicker(deps, { intervalMs = 60 * 60 * 1000, initialDelayMs = 5 * 60 * 1000 } = {}) {
  const log = deps.log || (() => {});
  let timer = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    try {
      await runWorktreeReaper(deps);
    } catch (err) {
      log('error', `[reaper] tick failed: ${err.message}`);
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  timer = setTimeout(tick, initialDelayMs);
  log('info', `[reaper] ticker started; first run in ${Math.round(initialDelayMs / 1000)}s, then every ${Math.round(intervalMs / 1000)}s`);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
