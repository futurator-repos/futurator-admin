/**
 * apply-starter-augments — Pipeline v2 / PR-13 Phase 3.
 *
 * Writes the starter pack's `augmentFiles` array onto the materialized
 * working tree. Runs between `inject-values` and `npm-install` so:
 *
 *   - The base scaffold's placeholders (__APP_SLUG__ etc.) are already
 *     substituted before augments overlay
 *   - npm-install picks up any package.json edits the augment makes
 *     (none today, but future augments may add deps)
 *   - bmad-bootstrap sees the augmented tree
 *   - commit-and-push includes the augment files in the initial commit
 *
 * Idempotent: re-running overwrites with byte-identical content. Safe to
 * re-execute on retry. Empty `augmentFiles` (no starter, or base starter)
 * is a no-op success.
 *
 * On any write error: throw, daemon's saga marks the App-bootstrap failed
 * and the operator gets a `pv2-app-bootstrap-failed` attention item with
 * the failed file path in the body.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, isAbsolute, relative } from 'node:path';

/**
 * @typedef {{ path: string, content: string }} AugmentFile
 */

/**
 * Validate that a relative path can't escape the working dir via `..` or
 * absolute prefixes. Defense in depth — augment content comes from the
 * registry (trusted) but the registry is editable code so a typo could
 * theoretically reach a path traversal bug.
 *
 * @param {string} workingDir
 * @param {string} relPath
 * @returns {string} the resolved absolute path
 */
function resolveSafePath(workingDir, relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('augment path must be a non-empty string');
  }
  if (isAbsolute(relPath)) {
    throw new Error(`augment path must be relative (got absolute "${relPath}")`);
  }
  const abs = normalize(join(workingDir, relPath));
  const rel = relative(workingDir, abs);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`augment path "${relPath}" escapes the working dir`);
  }
  return abs;
}

/**
 * Substitute the same `__APP_SLUG__` / `__APP_DISPLAY_NAME__` / `__INIT_DATE__`
 * + Mustache variants that inject-values handles, but applied IN-MEMORY to
 * the augment content before writing. Necessary because apply-starter-
 * augments runs AFTER inject-values; without this, augment files like
 * `.claude/skills.manifest.yaml` and `CLAUDE.md` ship raw `__APP_SLUG__`
 * placeholders forever (2026-05-16 dino-5/-6 incident).
 *
 * Pure string ops; no I/O. Kept inline (no shared helper) because the
 * inject-values step's substitution table is small and we don't want a
 * cross-file dep that could go out of sync silently.
 */
function substitutePlaceholders(content, { appId, displayName, initDate }) {
  let out = content;
  if (appId) {
    out = out.split('__APP_SLUG__').join(appId).split('{{APP_SLUG}}').join(appId);
  }
  if (displayName) {
    out = out
      .split('__APP_DISPLAY_NAME__')
      .join(displayName)
      .split('{{APP_DISPLAY_NAME}}')
      .join(displayName);
  }
  if (initDate) {
    out = out.split('__INIT_DATE__').join(initDate).split('{{INIT_DATE}}').join(initDate);
  }
  return out;
}

/**
 * Run the apply-starter-augments step.
 *
 * @param {object} input
 * @param {string} input.workingDir       — `/home/ubuntu/projects/<slug>`
 * @param {AugmentFile[] | undefined} input.augmentFiles
 * @param {string}   [input.appId]        — for placeholder substitution
 * @param {string}   [input.displayName]  — for placeholder substitution
 * @param {string}   [input.initDate]     — for placeholder substitution
 * @param {function} [input.onOutput]     — `(text) => void` for log streaming
 * @returns {Promise<{ written: number; skipped: boolean }>}
 */
export async function runApplyStarterAugments({
  workingDir,
  augmentFiles,
  packageJsonScripts,
  packageJsonDevDependencies,
  appId,
  displayName,
  initDate,
  onOutput,
}) {
  const log = (msg) => {
    if (typeof onOutput === 'function') onOutput(msg + '\n');
  };

  // dino1 root-cause (2026-06-10) — merge registry-declared npm scripts
  // into the template's package.json (template-owned file, so augmentFiles
  // can't carry it without clobbering). Only fills MISSING keys: a template
  // that later ships its own predev/prebuild wins. Runs even when there are
  // no augment files, so base starters get lifecycle hooks too.
  // pacman1 disease (2026-06-11) — same mechanism for devDependencies (the
  // test runner). Runs BEFORE npm-install, so the bootstrap lockfile pins
  // the runner from day one and stories never touch test plumbing.
  let scriptsMerged = 0;
  let devDepsMerged = 0;
  if (
    (packageJsonScripts && typeof packageJsonScripts === 'object') ||
    (packageJsonDevDependencies && typeof packageJsonDevDependencies === 'object')
  ) {
    const pkgPath = resolveSafePath(workingDir, 'package.json');
    try {
      const { readFile } = await import('node:fs/promises');
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      if (packageJsonScripts && typeof packageJsonScripts === 'object') {
        pkg.scripts = pkg.scripts || {};
        for (const [key, cmd] of Object.entries(packageJsonScripts)) {
          if (typeof cmd === 'string' && !(key in pkg.scripts)) {
            pkg.scripts[key] = cmd;
            scriptsMerged += 1;
          }
        }
      }
      if (packageJsonDevDependencies && typeof packageJsonDevDependencies === 'object') {
        pkg.devDependencies = pkg.devDependencies || {};
        for (const [name, version] of Object.entries(packageJsonDevDependencies)) {
          if (
            typeof version === 'string' &&
            !(name in pkg.devDependencies) &&
            !(name in (pkg.dependencies || {}))
          ) {
            pkg.devDependencies[name] = version;
            devDepsMerged += 1;
          }
        }
      }
      if (scriptsMerged > 0 || devDepsMerged > 0) {
        await writeFile(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');
        if (scriptsMerged > 0) {
          log(`merged ${scriptsMerged} npm script(s) into package.json: ${Object.keys(packageJsonScripts).join(', ')}`);
        }
        if (devDepsMerged > 0) {
          log(`merged ${devDepsMerged} devDependency(ies) into package.json: ${Object.keys(packageJsonDevDependencies).join(', ')}`);
        }
      }
    } catch (err) {
      throw new Error(`packageJson scripts/devDependencies merge failed: ${err.message}`);
    }
  }

  if (!Array.isArray(augmentFiles) || augmentFiles.length === 0) {
    log('No starter pack augment files to apply (base starter or stub).');
    return { written: 0, skipped: true, scriptsMerged, devDepsMerged };
  }

  let written = 0;
  for (const file of augmentFiles) {
    if (!file || typeof file.path !== 'string' || typeof file.content !== 'string') {
      throw new Error(
        `Invalid augment file entry: expected { path, content }, got ${JSON.stringify(file)}`,
      );
    }
    const abs = resolveSafePath(workingDir, file.path);
    await mkdir(dirname(abs), { recursive: true });
    // 2026-05-16 fix: substitute placeholders in-memory before write so
    // augment files (e.g. `.claude/skills.manifest.yaml`, `CLAUDE.md`)
    // get the right slug/displayName even though inject-values ran
    // before this step (the augment files didn't exist yet at that time).
    const content = substitutePlaceholders(file.content, { appId, displayName, initDate });
    await writeFile(abs, content, 'utf8');
    written += 1;
    log(`wrote ${file.path} (${content.length} bytes)`);
  }

  log(`apply-starter-augments: ${written} file(s) written.`);
  return { written, skipped: false, scriptsMerged, devDepsMerged };
}
