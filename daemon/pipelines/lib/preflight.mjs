// Pipeline v1 — Story 1.4. Pre-flight validator framework.
//
// Pipeline steps may declare `preconditions: PreflightCheck[]`. The pipeline
// runner runs these *before* spawning Claude. On failure, the step is marked
// NEEDS_ATTENTION with triggeredBy=PREFLIGHT_FAILED and a structured payload
// identifying which check failed — no Claude spawn happens, no quota burned.
//
// Initial library: `folder-exists`. Future stories may add `port-free`,
// `dependency-installed`, `dev-server-reachable`, `env-var-set`,
// `disk-space-available` (PRD §FR-6).

import { existsSync, statSync, accessSync, readFileSync, constants } from 'node:fs';

/**
 * Run a list of preflight checks in order. First failure short-circuits;
 * remaining checks are not run. Pure function — does not throw, does not
 * spawn anything outside the local filesystem.
 *
 * @param {Array<object>} checks
 * @returns {Promise<{ ok: true } | { ok: false, failedCheck: object, message: string }>}
 */
export async function runPreflight(checks) {
  if (!Array.isArray(checks) || checks.length === 0) return { ok: true };

  for (const check of checks) {
    const result = await runOneCheck(check);
    if (!result.ok) {
      return { ok: false, failedCheck: check, message: result.message };
    }
  }
  return { ok: true };
}

async function runOneCheck(check) {
  switch (check?.check) {
    case 'folder-exists':
      return runFolderExists(check);
    default:
      return {
        ok: false,
        message: `Unknown preflight check type: ${JSON.stringify(check?.check)}`,
      };
  }
}

/**
 * `folder-exists` validator. Checks that the path exists, is a directory,
 * and (optionally) is owned/writable by the user named in `writable_by`.
 *
 * Implementation note: when `writable_by` is omitted we only check that
 * the daemon process itself can write to the path. When present we verify
 * via `stat` that ownership matches AND that write permission is set —
 * this is what would have caught the chown bug fixed pre-Story 1.4.
 *
 * @param {{ path: string, writable_by?: string }} check
 */
function runFolderExists(check) {
  const path = check.path;
  if (typeof path !== 'string' || path.length === 0) {
    return { ok: false, message: 'folder-exists: path is required' };
  }

  if (!existsSync(path)) {
    return { ok: false, message: `folder-exists: path does not exist: ${path}` };
  }

  let stats;
  try {
    stats = statSync(path);
  } catch (err) {
    return { ok: false, message: `folder-exists: stat failed: ${err.message}` };
  }
  if (!stats.isDirectory()) {
    return { ok: false, message: `folder-exists: path is not a directory: ${path}` };
  }

  const writableBy = check.writable_by;
  if (writableBy) {
    // Owner-name match. We resolve UID → username via /etc/passwd lazily.
    // If we can't resolve the owner name, fail closed: the validator cannot
    // verify the constraint, so the daemon must escalate rather than spawn.
    const ownerName = resolveOwnerName(stats.uid);
    if (!ownerName) {
      return {
        ok: false,
        message: `folder-exists: path "${path}" owner uid=${stats.uid} could not be resolved (no /etc/passwd entry); cannot verify writable_by="${writableBy}"`,
      };
    }
    if (ownerName !== writableBy) {
      return {
        ok: false,
        message: `folder-exists: path "${path}" owner is "${ownerName}", expected "${writableBy}"`,
      };
    }
    // Owner-write bit set?
    // S_IWUSR === 0o200
    // eslint-disable-next-line no-bitwise
    if ((stats.mode & 0o200) === 0) {
      return {
        ok: false,
        message: `folder-exists: path "${path}" is not writable by owner (mode=${stats.mode.toString(8)})`,
      };
    }
  } else {
    // No owner constraint — just verify the daemon can W_OK the path.
    try {
      accessSync(path, constants.W_OK);
    } catch {
      return {
        ok: false,
        message: `folder-exists: path "${path}" is not writable by the daemon process`,
      };
    }
  }

  return { ok: true };
}

// ── owner-name resolution (lazy-cached) ────────────────────────────────────

let passwdCache;
function resolveOwnerName(uid) {
  if (typeof uid !== 'number') return null;
  if (!passwdCache) {
    passwdCache = new Map();
    try {
      // /etc/passwd format: name:passwd:uid:gid:gecos:home:shell
      const txt = readFileSync('/etc/passwd', 'utf8');
      for (const line of txt.split('\n')) {
        const parts = line.split(':');
        if (parts.length >= 3) {
          const id = parseInt(parts[2], 10);
          if (Number.isFinite(id)) passwdCache.set(id, parts[0]);
        }
      }
    } catch {
      // No /etc/passwd readable — leave cache empty; caller falls back.
    }
  }
  return passwdCache.get(uid) || null;
}
