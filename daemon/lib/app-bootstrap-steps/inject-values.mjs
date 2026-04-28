/**
 * inject-values.mjs — Pipeline v2 / Story 1.4.3 step 3.
 *
 * Substitutes `__APP_SLUG__` and `__APP_DISPLAY_NAME__` placeholders in the
 * files declared by the boilerplate registry's `postCreateSteps[0].targetFiles`.
 *
 * Idempotent — re-running on a worktree where the placeholders have already
 * been replaced is a clean no-op (the `replace()` calls are no-ops, no file
 * is rewritten when the content is unchanged).
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

const SLUG_PLACEHOLDER = '__APP_SLUG__';
const DISPLAY_NAME_PLACEHOLDER = '__APP_DISPLAY_NAME__';

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
    const after = before
      .split(SLUG_PLACEHOLDER)
      .join(appId)
      .split(DISPLAY_NAME_PLACEHOLDER)
      .join(displayName);

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
