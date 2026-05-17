import { resolve, isAbsolute } from 'node:path';
import { tmpdir, platform } from 'node:os';

/**
 * Generic path-scoped shell guard (Pipeline Enhancement Plan v2 — Phase A.2).
 *
 * Refuses any spawn whose cwd, or whose "filesystem-scope" arguments, escape
 * the plan project tree or a small static allowlist. Two layers:
 *
 *   1. cwd must resolve inside an allowed root.
 *   2. if the command is a known traversal tool (grep / find / rg / fd / ls /
 *      tar / zip / du), every positional argument that resolves to an
 *      absolute path must also lie inside an allowed root. This catches the
 *      `grep -rn /` family where cwd is fine but the target is `/` or `/etc`.
 *
 * Violations throw a `ShellGuardViolation` (non-retriable) so callers can
 * route them to an attention item.
 */

function buildDefaultRoots() {
  const roots = [
    '/home/ubuntu/projects',
    '/tmp',
    // The daemon's own home is allowed for auth probes and similar
    // tooling that inherits parent cwd.
    process.env.HOME || '/home/ubuntu',
    // OS temp dir — on macOS this is `/var/folders/...` where tests mint
    // scratch project roots. On Linux this redundantly resolves to `/tmp`.
    tmpdir(),
  ];
  // On macOS, realpath resolves `/tmp` and `/var/folders` to `/private/tmp`
  // and `/private/var/folders`. Include both forms so a callsite that uses
  // fs.realpathSync still matches.
  if (platform() === 'darwin') {
    roots.push('/private/tmp', '/private/var/folders');
  }
  // Allow operators to add extra roots via env — comma-separated absolutes.
  const extra = process.env.SHELL_GUARD_EXTRA_ROOTS;
  if (extra) {
    for (const r of extra.split(',').map((s) => s.trim()).filter(Boolean)) {
      roots.push(r);
    }
  }
  return roots;
}

export const DEFAULT_ALLOWED_ROOTS = buildDefaultRoots();

// Tools that recursively walk the filesystem. Their positional args need the
// same scope check as cwd because `grep -rn /` still pegs the CPU even when
// cwd is safe.
const TRAVERSAL_COMMANDS = new Set([
  'grep',
  'find',
  'rg',
  'fd',
  'ls',
  'tar',
  'zip',
  'du',
  'rsync',
]);

export class ShellGuardViolation extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'ShellGuardViolation';
    this.details = details || {};
  }
}

/**
 * Return the allowed-root string the given absolute path lives under, or
 * null if it escapes.
 */
export function allowedRootFor(absPath, roots = DEFAULT_ALLOWED_ROOTS) {
  if (!absPath) return null;
  const normalized = resolve(absPath);
  for (const root of roots) {
    const normRoot = resolve(root);
    if (normalized === normRoot) return normRoot;
    if (normalized.startsWith(normRoot + '/')) return normRoot;
  }
  return null;
}

/**
 * Throws ShellGuardViolation if cwd is outside allowed roots. Returns the
 * resolved cwd on success.
 */
export function assertCwdAllowed(cwd, roots = DEFAULT_ALLOWED_ROOTS) {
  const cwdAbs = cwd ? resolve(cwd) : process.cwd();
  const matched = allowedRootFor(cwdAbs, roots);
  if (!matched) {
    throw new ShellGuardViolation(
      `shell-guard: refused spawn — cwd "${cwdAbs}" is outside allowed roots`,
      { kind: 'cwd', cwd: cwdAbs, allowedRoots: roots },
    );
  }
  return cwdAbs;
}

/**
 * If `command` is a traversal tool (grep/find/etc), inspect each positional
 * arg: any that looks like an absolute filesystem path must resolve under an
 * allowed root. Relative args are OK (they're joined against cwd, which is
 * already guarded). Flags (`-rn`, `--include=x`) pass through.
 *
 * Non-traversal commands (npm, node, git, claude, bash) are not scanned —
 * they don't have the "walk the filesystem from here" semantics.
 */
export function assertArgsAllowed(command, args = [], roots = DEFAULT_ALLOWED_ROOTS) {
  const base = (command || '').split('/').pop();
  if (!TRAVERSAL_COMMANDS.has(base)) return;

  for (const raw of args) {
    if (typeof raw !== 'string' || raw.length === 0) continue;
    // Skip flags; inspect only positional filesystem-ish args.
    if (raw.startsWith('-')) continue;
    if (!isAbsolute(raw)) continue;

    const matched = allowedRootFor(raw, roots);
    if (!matched) {
      throw new ShellGuardViolation(
        `shell-guard: refused ${base} — arg "${raw}" escapes allowed roots`,
        { kind: 'arg', command: base, arg: raw, allowedRoots: roots },
      );
    }
  }
}

/**
 * For a bash `-c "<script>"` invocation, scan the script for traversal tool
 * use against absolute paths. This is heuristic (no shell parser), but
 * captures the common `grep -rn /`, `find / -name …` patterns that were
 * observed pegging CPU.
 */
export function assertShellScriptAllowed(script, roots = DEFAULT_ALLOWED_ROOTS) {
  if (typeof script !== 'string' || script.length === 0) return;
  // 2026-05-17 snake-3 fix — strip single-quoted bash strings before
  // scanning. Bash single-quotes are LITERAL (no $var, no \escape, single-
  // quote cannot appear inside), so any `/` between them is text, never an
  // argv path. Pre-strip removes a class of false positives like the literal
  // " / " inside the EMPTY_DIFF_BY_DESIGN echo argument that was rejecting
  // every story's compile-diff. Double-quoted strings are NOT stripped —
  // those can expand $vars to real paths and skipping them would create a
  // grep "$INJECTED" bypass.
  const stripped = script.replace(/'[^']*'/g, "''");
  // For each traversal command token followed by an absolute path that's
  // outside the allowed roots, raise.
  const tools = Array.from(TRAVERSAL_COMMANDS).join('|');
  const re = new RegExp(
    `(?:^|[\\s;&|\\(])(${tools})\\b[^\\n]*?(?:\\s|^)(/[^\\s'"\`;|&)]*)`,
    'g',
  );
  let match;
  while ((match = re.exec(stripped)) !== null) {
    const tool = match[1];
    const path = match[2];
    // Flags like `-r` don't match the absolute-path group, so anything we
    // capture here is a real path.
    const matched = allowedRootFor(path, roots);
    if (!matched) {
      throw new ShellGuardViolation(
        `shell-guard: refused bash script — ${tool} targets "${path}" outside allowed roots`,
        { kind: 'script', command: tool, arg: path, allowedRoots: roots },
      );
    }
  }
}

/**
 * One-shot guard used by every spawn wrapper. Evaluates cwd, args, and (if
 * bash -c) the script body.
 */
export function assertSpawnAllowed(command, args = [], cwd = undefined, roots = DEFAULT_ALLOWED_ROOTS) {
  assertCwdAllowed(cwd, roots);

  const base = (command || '').split('/').pop();
  if (base === 'bash' || base === 'sh') {
    // bash -c "<script>" pattern: guard the script itself.
    const cIdx = args.indexOf('-c');
    if (cIdx !== -1 && typeof args[cIdx + 1] === 'string') {
      assertShellScriptAllowed(args[cIdx + 1], roots);
      return;
    }
  }
  assertArgsAllowed(command, args, roots);
}
