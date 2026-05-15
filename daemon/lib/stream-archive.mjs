/**
 * stream-archive.mjs — Pipeline v2 Phase 2-B / Story 2-B-6-1 (PR-100).
 *
 * Stream-branch lifecycle helpers per v2.5 §25.
 *
 *   - 30-day idle detection (last commit age)
 *   - Archive-branch naming (`archive/stream-<name>-<YYYYMMDD>`)
 *   - Graduation transition (stream/<n> → Labs plan, per v2.5 §25.4)
 *
 * Pure helpers; the daemon's GC scan (Story 2-B-7) wires this into a
 * weekly tick.
 */

const STREAM_IDLE_THRESHOLD_DAYS = 30;
const SLUG_RE = /^[a-z][a-z0-9-]{0,38}[a-z0-9]$/;

/**
 * Detect whether a stream branch is idle. Caller supplies the branch
 * name + the last-commit timestamp (ISO).
 *
 * @param {{
 *   branchName: string,
 *   lastCommitAt: string,
 *   now?: () => number,
 *   thresholdDays?: number,
 * }} args
 * @returns {{ isStream: boolean, isIdle: boolean, ageDays?: number, reason: string }}
 */
export function isStreamIdle({
  branchName,
  lastCommitAt,
  now = () => Date.now(),
  thresholdDays = STREAM_IDLE_THRESHOLD_DAYS,
}) {
  if (typeof branchName !== 'string' || !branchName.startsWith('stream/')) {
    return { isStream: false, isIdle: false, reason: 'not a stream branch' };
  }
  const last = Date.parse(lastCommitAt);
  if (Number.isNaN(last)) {
    return { isStream: true, isIdle: false, reason: 'unparseable lastCommitAt' };
  }
  const ageMs = now() - last;
  const ageDays = Math.floor(ageMs / (24 * 60 * 60 * 1000));
  if (ageDays >= thresholdDays) {
    return { isStream: true, isIdle: true, ageDays, reason: `idle ${ageDays}d ≥ ${thresholdDays}d threshold` };
  }
  return { isStream: true, isIdle: false, ageDays, reason: `last commit ${ageDays}d ago` };
}

/**
 * Compute the archive-branch name for a given stream + date.
 *
 *   stream/<name>  →  archive/stream-<name>-<YYYYMMDD>
 */
export function streamArchiveName({ branchName, archivedAt = new Date() }) {
  if (!branchName.startsWith('stream/')) {
    throw new Error(`stream-archive: branchName must start with stream/, got ${JSON.stringify(branchName)}`);
  }
  const name = branchName.slice('stream/'.length);
  if (!SLUG_RE.test(name)) {
    throw new Error(`stream-archive: stream name must be kebab-case slug, got ${JSON.stringify(name)}`);
  }
  const date = archivedAt instanceof Date ? archivedAt : new Date(archivedAt);
  const yyyymmdd =
    date.getUTCFullYear().toString().padStart(4, '0') +
    (date.getUTCMonth() + 1).toString().padStart(2, '0') +
    date.getUTCDate().toString().padStart(2, '0');
  return `archive/stream-${name}-${yyyymmdd}`;
}

/**
 * Graduation transition: a `stream/<name>` becomes a Labs plan. v2.5
 * §25.4 — the stream's commits become the foundation of a new plan.
 *
 * Returns the plan-slug + initial-intent that the plan-creator service
 * uses to spawn the plan.
 */
export function buildGraduationProposal({ branchName, planIntent }) {
  if (!branchName.startsWith('stream/')) {
    throw new Error(`stream-archive: branchName must start with stream/, got ${JSON.stringify(branchName)}`);
  }
  const streamName = branchName.slice('stream/'.length);
  if (!SLUG_RE.test(streamName)) {
    throw new Error(`stream-archive: stream name must be kebab-case slug`);
  }
  return {
    streamName,
    planSlug: streamName, // graduation reuses the same slug
    intent: planIntent || `Graduating stream/${streamName} to a Labs plan`,
    sourceBranch: branchName,
    /** Plan kind tag for the spawned plan — distinguishes from operator-initiated plans. */
    planKind: 'change',
  };
}

/**
 * Attention-item factory for a stream that's about to be auto-archived.
 * Operator can intercede before the daemon archives.
 */
export function buildStreamIdleAttention({ branchName, ageDays }) {
  return {
    severity: 'low',
    category: 'stream-idle',
    title: `Stream branch ${branchName} idle ${ageDays}d`,
    body:
      `${branchName} has had no commits in ${ageDays} days. Daemon will ` +
      `auto-archive after ${STREAM_IDLE_THRESHOLD_DAYS}d unless you:\n` +
      `  • commit to the branch\n` +
      `  • graduate it to a Labs plan (v2.5 §25.4)\n` +
      `  • manually archive\n`,
    actions: ['graduate-to-plan', 'archive-now', 'dismiss'],
    context: { branchName, ageDays },
  };
}

export const STREAM_CONSTANTS = Object.freeze({
  idleThresholdDays: STREAM_IDLE_THRESHOLD_DAYS,
});
