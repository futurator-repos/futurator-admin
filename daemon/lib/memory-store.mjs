/**
 * memory-store.mjs — Pipeline v2 Phase 3 / Story 3-E-1-1.
 *
 * File-backed inter-agent memory hierarchy at `/mnt/memory/` (overridable
 * via FUTURATOR_MEMORY_ROOT). Three scopes per v2.5 §45:
 *
 *   futurator-org/        READ-ONLY org-wide
 *     brand-voice.md
 *     bmad-conventions.md
 *     aws-patterns.md
 *     known-pitfalls.md
 *     ...
 *
 *   project-<slug>/       READ-WRITE for project agents
 *     CLAUDE.md           (living document, Story 3-E-4-1)
 *     decisions.md        (append-only architecture log)
 *     glossary.md
 *     known-issues.md
 *     skills/             (project-local skills)
 *
 *   inbox/                READ-WRITE for inter-agent comms
 *     pm-to-dev.md
 *     dev-to-reviewer.md
 *     reviewer-to-qa.md
 *     qa-to-deploy.md
 *     triage-history.md
 *     reflections.md      (REFLECTOR proposals, Story 3-E-2-1)
 *     decisions.md        (cross-agent decision log)
 *
 * Migration target: when Claude Managed Agents (MA) Memory Store arrives in
 * Phase G, this module's surface is the same — `read/appendLine/writeAtomic`
 * map directly to MA Memory Store API. The file backend is the v2.5
 * implementation; Phase G ports backend, not callers.
 *
 * Security: path-traversal protection on every public function. Scope
 * parameter enforces tenant isolation — a project-scope call cannot read
 * from another project's directory; an org-scope call cannot write at all.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  renameSync,
} from 'fs';
import { join, normalize, sep, dirname } from 'path';
import { randomBytes } from 'node:crypto';

const DEFAULT_ROOT = process.env.FUTURATOR_MEMORY_ROOT || '/mnt/memory';

const ORG_FILES = [
  'brand-voice.md',
  'bmad-conventions.md',
  'aws-patterns.md',
  'known-pitfalls.md',
];

const INBOX_FILES = [
  'pm-to-dev.md',
  'dev-to-reviewer.md',
  'reviewer-to-qa.md',
  'qa-to-deploy.md',
  'triage-history.md',
  'reflections.md',
  'decisions.md',
];

const PROJECT_FILES = ['CLAUDE.md', 'decisions.md', 'glossary.md', 'known-issues.md'];

/**
 * MemoryStoreError — emitted for security violations (path traversal,
 * wrong-scope writes) and missing-scope errors. Distinct subclass so
 * callers can `instanceof` it instead of string-matching messages.
 */
export class MemoryStoreError extends Error {
  constructor(message, { code } = {}) {
    super(message);
    this.name = 'MemoryStoreError';
    this.code = code;
  }
}

/**
 * Resolve a scope descriptor to its on-disk directory under root. Throws
 * MemoryStoreError on malformed scope.
 *
 *   scope === 'org'              → <root>/futurator-org
 *   scope === 'inbox'            → <root>/inbox
 *   scope === { kind: 'project', slug: 'songster' }
 *                                → <root>/project-songster
 */
export function resolveScopeDir(root, scope) {
  if (scope === 'org') return join(root, 'futurator-org');
  if (scope === 'inbox') return join(root, 'inbox');
  if (scope && typeof scope === 'object' && scope.kind === 'project') {
    if (typeof scope.slug !== 'string' || !scope.slug) {
      throw new MemoryStoreError('project scope requires non-empty slug', { code: 'BAD_SCOPE' });
    }
    if (!/^[a-z][a-z0-9-]{0,38}[a-z0-9]$/.test(scope.slug)) {
      // Mirrors App.appId regex (PR-1, Phase 1).
      throw new MemoryStoreError(
        `invalid project slug: ${JSON.stringify(scope.slug)}`,
        { code: 'BAD_SLUG' },
      );
    }
    return join(root, `project-${scope.slug}`);
  }
  throw new MemoryStoreError(
    `unknown scope: ${JSON.stringify(scope)}`,
    { code: 'BAD_SCOPE' },
  );
}

/**
 * Reject paths that escape their scope dir. Returns the resolved absolute
 * path on success. Both `\\` and `..` segments fail.
 */
function safeJoin(scopeDir, relative) {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw new MemoryStoreError('file path required', { code: 'BAD_PATH' });
  }
  if (relative.includes('\0')) {
    throw new MemoryStoreError('null byte in path', { code: 'BAD_PATH' });
  }
  const normalized = normalize(relative);
  if (
    normalized.startsWith('..') ||
    normalized.startsWith('/') ||
    normalized.startsWith('\\') ||
    normalized.split(sep).some((seg) => seg === '..')
  ) {
    throw new MemoryStoreError(`path traversal: ${relative}`, { code: 'BAD_PATH' });
  }
  return join(scopeDir, normalized);
}

function isOrgScope(scope) {
  return scope === 'org';
}

/**
 * Create a memory-store handle rooted at `root` (defaults to /mnt/memory or
 * the env override). Idempotent — does not provision subdirs; that's
 * `provisionMemoryRoot()`'s job.
 */
export function createMemoryStore({ root = DEFAULT_ROOT } = {}) {
  function read(scope, file) {
    const dir = resolveScopeDir(root, scope);
    const path = safeJoin(dir, file);
    if (!existsSync(path)) return null;
    return readFileSync(path, 'utf-8');
  }

  function appendLine(scope, file, content) {
    if (isOrgScope(scope)) {
      throw new MemoryStoreError(
        'org scope is READ-ONLY (writes only via REFLECTOR-APPLY commits)',
        { code: 'READ_ONLY' },
      );
    }
    const dir = resolveScopeDir(root, scope);
    const path = safeJoin(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    const line = content.endsWith('\n') ? content : content + '\n';
    appendFileSync(path, line, 'utf-8');
    return path;
  }

  function writeAtomic(scope, file, content) {
    if (isOrgScope(scope)) {
      throw new MemoryStoreError(
        'org scope is READ-ONLY (writes only via REFLECTOR-APPLY commits)',
        { code: 'READ_ONLY' },
      );
    }
    const dir = resolveScopeDir(root, scope);
    const path = safeJoin(dir, file);
    mkdirSync(dirname(path), { recursive: true });
    // Atomic: write to .tmp-<rand>, then rename. POSIX rename is atomic on
    // the same filesystem; partial writes never surface to readers.
    const tmpPath = path + '.tmp-' + randomBytes(6).toString('hex');
    writeFileSync(tmpPath, content, 'utf-8');
    renameSync(tmpPath, path);
    return path;
  }

  function exists(scope, file) {
    const dir = resolveScopeDir(root, scope);
    const path = safeJoin(dir, file);
    return existsSync(path);
  }

  function getRoot() {
    return root;
  }

  return { read, appendLine, writeAtomic, exists, getRoot };
}

/**
 * Provision the three top-level scope directories under `root`. Called once
 * from `agent-daemon.mjs` startup. Idempotent.
 *
 * Optional `projectSlugs` array provisions known project- dirs eagerly.
 * Subsequent unknown slugs are created lazily on first write.
 *
 * Returns the set of directories that were newly created (for log).
 */
export function provisionMemoryRoot({ root = DEFAULT_ROOT, projectSlugs = [] } = {}) {
  const created = [];

  function ensure(dir) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
      created.push(dir);
    }
  }

  ensure(root);
  ensure(join(root, 'futurator-org'));
  ensure(join(root, 'inbox'));
  for (const slug of projectSlugs) {
    try {
      ensure(resolveScopeDir(root, { kind: 'project', slug }));
    } catch {
      // Skip malformed slugs silently — provisioning is best-effort.
    }
  }

  // Seed empty inbox files so REFLECTOR (3-E-2) and TRIAGE (3-E-6) can read
  // the frontmatter on first run without ENOENT-trapping the caller.
  for (const file of INBOX_FILES) {
    const path = join(root, 'inbox', file);
    if (!existsSync(path)) {
      writeFileSync(
        path,
        `---\nlast-seen-sha: null\nlast-update-at: null\n---\n`,
        'utf-8',
      );
    }
  }

  return { created, root };
}

export { ORG_FILES, INBOX_FILES, PROJECT_FILES };
