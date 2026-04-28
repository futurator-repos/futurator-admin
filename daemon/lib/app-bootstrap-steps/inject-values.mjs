/**
 * inject-values.mjs — Pipeline v2 / Story 1.4.3 step 3.
 *
 * Substitutes `{{APP_SLUG}}`, `{{APP_DISPLAY_NAME}}`, and `{{INIT_DATE}}`
 * placeholders in the files declared by the boilerplate registry's
 * `postCreateSteps[0].targetFiles`.
 *
 * Mustache-style placeholders (chosen over `__X__` because the latter
 * collides with markdown bold syntax — GitHub renders `__APP_DISPLAY_NAME__`
 * as bold "APP_DISPLAY_NAME" in README previews, which looks like the value
 * was substituted when in fact the placeholders are still raw).
 *
 * Idempotent — re-running on a worktree where the placeholders have already
 * been replaced is a clean no-op (the replace calls are no-ops, no file is
 * rewritten when the content is unchanged).
 *
 * Backward-compat: the legacy `__X__` placeholders are still substituted for
 * any in-flight repos that were created before the format changed. Templates
 * created or updated after 2026-04-28 should use `{{X}}` exclusively.
 *
 * The function is fs-injectable so tests can run hermetically without writing
 * to disk. Production code passes the real `node:fs/promises` API.
 *
 * @param {object}   args
 * @param {string}   args.appId
 * @param {string}   args.displayName
 * @param {string[]} args.targetFiles  — relative paths inside the worktree
 * @param {string}   args.worktreeDir
 * @param {object}   [args.fs]         — { readFile, writeFile, exists }
 * @param {function} [args.onOutput]   — log sink `(stream, data)`
 */

import { readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';

export const APP_BOOTSTRAP_INJECT_VALUES_STEP = 'inject-values';

// Current Mustache-style placeholders (markdown-safe).
const PLACEHOLDERS_NEW = {
  '{{APP_SLUG}}': 'appId',
  '{{APP_DISPLAY_NAME}}': 'displayName',
  '{{INIT_DATE}}': 'initDate',
};

// Legacy `__X__` placeholders kept for backward-compat with repos created
// before 2026-04-28. Markdown-bold collision was the reason we switched.
const PLACEHOLDERS_LEGACY = {
  '__APP_SLUG__': 'appId',
  '__APP_DISPLAY_NAME__': 'displayName',
  '__INIT_DATE__': 'initDate',
};

export async function runInjectValues({
  appId,
  displayName,
  targetFiles,
  worktreeDir,
  fs = {
    readFile: fsReadFile,
    writeFile: fsWriteFile,
    exists: (p) => Promise.resolve(fsExistsSync(p)),
  },
  onOutput,
} = {}) {
  if (!appId) throw new Error('runInjectValues: appId required');
  if (!displayName) throw new Error('runInjectValues: displayName required');
  if (!worktreeDir) throw new Error('runInjectValues: worktreeDir required');
  if (!Array.isArray(targetFiles)) {
    throw new Error('runInjectValues: targetFiles must be an array');
  }

  let modified = 0;
  const visited = [];

  for (const relPath of targetFiles) {
    const absPath = join(worktreeDir, relPath);

    if (!(await fs.exists(absPath))) {
      onOutput?.('stdout', `inject-values: skipped (missing) ${relPath}\n`);
      continue;
    }

    const before = await fs.readFile(absPath, 'utf8');
    const values = {
      appId,
      displayName,
      initDate: new Date().toISOString().slice(0, 10),
    };
    let after = before;
    for (const [token, key] of Object.entries({ ...PLACEHOLDERS_NEW, ...PLACEHOLDERS_LEGACY })) {
      after = after.split(token).join(values[key]);
    }

    visited.push(relPath);

    if (after === before) {
      // Idempotent re-run: nothing to do.
      continue;
    }

    await fs.writeFile(absPath, after, 'utf8');
    modified += 1;
    onOutput?.('stdout', `inject-values: rewrote ${relPath}\n`);
  }

  return { modified, visited };
}
