/**
 * Path remap — host-portable daemon paths (Task B, 2026-07-17).
 *
 * agent-jobs rows bake fleet-absolute paths (`/home/ubuntu/projects/<appId>`,
 * `/home/ubuntu/worktrees/<app>/<plan>/<story>`) at enqueue time in the API /
 * cron Lambdas. A daemon running on a host whose filesystem roots differ (the
 * Mac runner script sets `PROJECTS_ROOT=$HOME/FuturatorFleet/projects` and
 * `FUTURATOR_WORKTREE_ROOT=$HOME/FuturatorFleet/worktrees`) must rewrite those
 * baked paths to local equivalents before any handler touches the filesystem.
 *
 * CRITICAL INVARIANT — fleet/EC2 boxes are an exact behavioral no-op: a
 * mapping is active ONLY when its env target is set AND differs from the
 * source prefix. With `PROJECTS_ROOT` unset (or equal to the legacy default)
 * and `FUTURATOR_WORKTREE_ROOT` unset (or default), NO mapping is active —
 * including the `/home/ubuntu` → homedir fallback, which is deliberately
 * gated on at least one env-driven mapping being active. (Without that gate a
 * root-run EC2 daemon, whose homedir is `/root`, would silently rewrite
 * `/home/ubuntu/...` job paths — the exact breakage the invariant forbids.)
 *
 * Mappings apply longest-source-prefix first, on whole path segments only
 * (`/home/ubuntu/projectsfoo` never matches the projects mapping). A path that
 * is already local (no `/home/ubuntu` prefix) passes through untouched, so
 * re-remapping is always safe (idempotent).
 */

import { homedir } from 'node:os';

const SRC_PROJECTS_ROOT = '/home/ubuntu/projects';
const SRC_WORKTREE_ROOT = '/home/ubuntu/worktrees';
const SRC_HOME = '/home/ubuntu';

/** Env-driven mappings only — the activity signal for the whole module. */
function envMappings() {
  const out = [];
  const projects = process.env.PROJECTS_ROOT;
  if (projects && projects !== SRC_PROJECTS_ROOT) out.push([SRC_PROJECTS_ROOT, projects]);
  const worktrees = process.env.FUTURATOR_WORKTREE_ROOT;
  if (worktrees && worktrees !== SRC_WORKTREE_ROOT) out.push([SRC_WORKTREE_ROOT, worktrees]);
  return out;
}

/**
 * True when at least one env-driven mapping is active — i.e. this daemon is
 * running on a host whose roots differ from the fleet layout. Fleet/EC2 boxes
 * (env unset or equal to the legacy defaults) always return false.
 */
export function isRemapActive() {
  return envMappings().length > 0;
}

/** Active mappings, longest source prefix first. Empty on fleet boxes. */
function activeMappings() {
  const out = envMappings();
  if (out.length === 0) return out;
  // Catch-all for other fleet-absolute paths (e.g. `/home/ubuntu/repos/...`).
  // Only participates when an env-driven mapping proved we're off-fleet.
  const home = homedir();
  if (home && home !== SRC_HOME) out.push([SRC_HOME, home]);
  return out.sort((a, b) => b[0].length - a[0].length);
}

/**
 * Remap a single absolute path. Segment-aware longest-prefix-first; returns
 * the input string identically when no mapping applies (every fleet box, any
 * already-local path, any non-string input).
 */
export function remapDaemonPath(p) {
  if (typeof p !== 'string' || p.length === 0) return p;
  for (const [src, dst] of activeMappings()) {
    if (p === src || p.startsWith(`${src}/`)) return `${dst}${p.slice(src.length)}`;
  }
  return p;
}

const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g;

/**
 * Remap every fleet-absolute path OCCURRENCE inside free text (legacy
 * step-based pipelines bake `cd ${workingDir} && ...` into step command
 * strings at enqueue time). Boundary-guarded so `/home/ubuntu/projectsfoo`
 * is not hit by the projects mapping. Identity when no mapping is active.
 */
export function remapPathsInText(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const [src, dst] of activeMappings()) {
    const re = new RegExp(`${src.replace(REGEX_ESCAPE, '\\$&')}(?![\\w-])`, 'g');
    out = out.replace(re, dst);
  }
  return out;
}

/**
 * Payload path fields the daemon reads (grep of daemon/pipelines/*.mjs +
 * agent-daemon.mjs): `workingDir` (queueRequestPayload), `projectPath`
 * (partyBootstrap/partyInspect/refactorAudit/scanEngine/dualAgentCompare
 * payloads). Shallow, string-only.
 */
const PAYLOAD_PATH_KEYS = ['workingDir', 'projectPath', 'sourceWorktree', 'worktreePath'];

/**
 * The single job-intake seam: rewrite every baked fleet path on a claimed job
 * IN PLACE before it is handed to its runner. Covers `job.workingDir`, path
 * fields on every `*Payload` object, and path occurrences inside legacy
 * pipeline step `command`/`prompt` strings. Exact no-op (object untouched)
 * when no mapping is active. Returns the job for call-site convenience.
 */
export function remapJobPaths(job) {
  if (!job || typeof job !== 'object' || !isRemapActive()) return job;
  if (typeof job.workingDir === 'string') job.workingDir = remapDaemonPath(job.workingDir);
  for (const key of Object.keys(job)) {
    if (!key.endsWith('Payload')) continue;
    const payload = job[key];
    if (!payload || typeof payload !== 'object') continue;
    for (const pathKey of PAYLOAD_PATH_KEYS) {
      if (typeof payload[pathKey] === 'string') payload[pathKey] = remapDaemonPath(payload[pathKey]);
    }
  }
  const steps = job.pipeline?.steps;
  if (Array.isArray(steps)) {
    for (const step of steps) {
      if (!step || typeof step !== 'object') continue;
      if (typeof step.command === 'string') step.command = remapPathsInText(step.command);
      if (typeof step.prompt === 'string') step.prompt = remapPathsInText(step.prompt);
    }
  }
  return job;
}
