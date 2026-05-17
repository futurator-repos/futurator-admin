/**
 * Pre-flight checks for migrate-brownfield.mjs.
 *
 * Each check is a pure(-ish) function that returns
 *   { ok: true, value: <derived-data> } | { ok: false, error: '<message>' }
 *
 * "Pure-ish" because some checks touch the local filesystem and run git
 * subprocesses; none touch network or AWS. Network/AWS checks are in
 * steps.mjs (because they may trigger provisioning side-effects).
 *
 * The orchestrator runs each check, prints the result, and exits non-zero
 * on the first failure. Re-running picks up where the operator fixed it.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// Mirrored from functions/shared/types/party.ts. Inlined (rather than
// imported) because this is an .mjs runtime file that Node loads without
// the Vite/Vitest transformer, so it can't traverse the .ts module.
// If either constant changes in the backend file, update both places
// (party-schema.test.ts asserts the regex shape, so drift is caught early).
const GITHUB_HTTPS_URL_REGEX = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+(\.git)?$/;
const PROJECT_ID_REGEX = /^[a-z0-9][a-z0-9-]{0,63}$/;
const GITHUB_PAT_PREFIX_REGEX = /^(github_pat_|ghp_|github_token_)/;

export const RUNNER_GITHUB_HTTPS_URL_REGEX = GITHUB_HTTPS_URL_REGEX;
export const RUNNER_PROJECT_ID_REGEX = PROJECT_ID_REGEX;

/** Run `git` synchronously inside repoPath. Returns trimmed stdout. */
function gitIn(repoPath, args, { trim = true } = {}) {
  const out = execFileSync('git', args, {
    cwd: repoPath,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return trim ? out.trim() : out;
}

/** Convert an HTTPS GitHub URL to the kebab-case project name. */
export function deriveProjectNameFromUrl(repoUrl) {
  const m = repoUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!m) return null;
  // Slugify: lowercase, replace `.` and `_` with `-`, strip trailing `-`.
  return m[2]
    .toLowerCase()
    .replace(/[._]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ──────────────────────────────────────────────────────────────────────
// Individual checks
// ──────────────────────────────────────────────────────────────────────

export function checkPathProvided(input) {
  if (!input.path) {
    return {
      ok: false,
      error: '--path is required (or set BROWNFIELD_REPO_PATH). See --help.',
    };
  }
  return { ok: true };
}

export function checkPathIsDirectory(input) {
  if (!existsSync(input.path)) {
    return { ok: false, error: `not a directory: ${input.path}` };
  }
  if (!statSync(input.path).isDirectory()) {
    return { ok: false, error: `not a directory: ${input.path}` };
  }
  return { ok: true };
}

export function checkIsGitRepo(input) {
  if (!existsSync(`${input.path}/.git`)) {
    return { ok: false, error: `not a git repo: ${input.path}/.git missing` };
  }
  return { ok: true };
}

export function checkBmadInstalled(input) {
  const legacy = `${input.path}/bmad/_cfg/agent-manifest.csv`;
  const newLayout = `${input.path}/_bmad/_config/agent-manifest.csv`;
  let manifestPath = null;
  if (existsSync(legacy)) manifestPath = legacy;
  else if (existsSync(newLayout)) manifestPath = newLayout;
  if (!manifestPath) {
    return {
      ok: false,
      error:
        'BMAD not installed in repo — run `npx bmad-method install` inside the project, commit, and push first',
    };
  }
  const txt = readFileSync(manifestPath, 'utf8');
  const rows = txt.split(/\r?\n/).filter((l) => l.length > 0);
  const rowCount = Math.max(0, rows.length - 1); // minus header
  if (rowCount < 1) {
    return { ok: false, error: `BMAD manifest is empty (${manifestPath}) — re-install BMAD` };
  }
  return { ok: true, value: { manifestPath, rowCount } };
}

export function checkGitRemoteIsGithub(input, runner = gitIn) {
  let url;
  try {
    url = runner(input.path, ['remote', 'get-url', 'origin']);
  } catch {
    return {
      ok: false,
      error: 'no `origin` remote configured on this repo (run `git remote add origin …`)',
    };
  }
  if (!GITHUB_HTTPS_URL_REGEX.test(url) && !url.startsWith('git@github.com:')) {
    return { ok: false, error: `origin remote is not GitHub: ${url}` };
  }
  if (url.startsWith('git@github.com:')) {
    return {
      ok: false,
      error: `origin remote is SSH; the daemon clones via HTTPS+PAT. Switch with: git remote set-url origin https://github.com/<owner>/<repo>.git`,
    };
  }
  return { ok: true, value: { repoUrl: url } };
}

export function checkUnpushedCommits(input, runner = gitIn) {
  try {
    const ahead = runner(input.path, ['rev-list', '--count', '@{u}..HEAD']);
    const n = parseInt(ahead, 10) || 0;
    if (n > 0) {
      return {
        ok: true,
        warn: `${n} commit(s) ahead of upstream — EC2 will mirror only what's on GitHub. Push before continuing if you want them included.`,
      };
    }
  } catch {
    // No upstream configured — non-fatal, just warn.
    return {
      ok: true,
      warn: 'current branch has no upstream tracking — cannot determine if local commits are pushed',
    };
  }
  return { ok: true };
}

export function checkResolveBranch(input, runner = gitIn) {
  if (input.branch) {
    return { ok: true, value: { branch: input.branch } };
  }
  try {
    const branch = runner(input.path, ['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!branch || branch === 'HEAD') {
      // Detached HEAD — fall back to default.
      return { ok: true, value: { branch: 'main' } };
    }
    return { ok: true, value: { branch } };
  } catch {
    return { ok: true, value: { branch: 'main' } };
  }
}

export function checkResolveName(input, repoUrl) {
  const explicit = input.name?.trim();
  if (explicit) {
    if (!PROJECT_ID_REGEX.test(explicit)) {
      return {
        ok: false,
        error: `--name "${explicit}" is invalid kebab-case (must match ^[a-z0-9][a-z0-9-]{0,63}$)`,
      };
    }
    return { ok: true, value: { name: explicit } };
  }
  const derived = deriveProjectNameFromUrl(repoUrl);
  if (!derived || !PROJECT_ID_REGEX.test(derived)) {
    return {
      ok: false,
      error: `could not derive a valid kebab-case name from ${repoUrl}; pass --name explicitly`,
    };
  }
  return { ok: true, value: { name: derived } };
}

export function checkPatFile(input, { requirePat = true } = {}) {
  if (!input.patFile) {
    if (!requirePat) return { ok: true, value: { pat: null } };
    return {
      ok: false,
      error:
        '--pat-file is required for a first-time migration (skip this check with --refresh on an existing project)',
    };
  }
  if (!existsSync(input.patFile)) {
    return { ok: false, error: `--pat-file does not exist: ${input.patFile}` };
  }
  const raw = readFileSync(input.patFile, 'utf8').split(/\r?\n/)[0].trim();
  if (!raw) {
    return { ok: false, error: `--pat-file is empty: ${input.patFile}` };
  }
  if (!GITHUB_PAT_PREFIX_REGEX.test(raw)) {
    return {
      ok: false,
      error:
        'PAT does not look like a GitHub token (expected prefix: github_pat_, ghp_, or github_token_)',
    };
  }
  return { ok: true, value: { pat: raw } };
}

export function checkAdminToken(input) {
  if (!input.token) {
    return {
      ok: false,
      error:
        'admin JWT required — pass --token or set FUTURATOR_ADMIN_TOKEN (copy from browser DevTools → Application → Local Storage → "futurator_tokens" → accessToken)',
    };
  }
  // Light shape check: JWT has two dots.
  if (input.token.split('.').length !== 3) {
    return {
      ok: false,
      error: 'admin JWT does not look like a JWT (expected three dot-separated segments)',
    };
  }
  return { ok: true };
}

/**
 * Aggregate runner. Executes checks in dependency order. The orchestrator
 * is expected to print each result; this function just returns the
 * accumulated outcome + derived values.
 *
 * Caller passes overrides for {refresh, requirePat} based on the run mode.
 */
export function runPreflights(input, { gitRunner = gitIn } = {}) {
  const results = [];
  const derived = {};

  function step(name, fn) {
    const r = fn();
    results.push({ name, ...r });
    return r;
  }

  // Synchronous + early-exit on hard failures.
  let r;

  r = step('path provided', () => checkPathProvided(input));
  if (!r.ok) return { ok: false, results, derived };

  r = step('path is a directory', () => checkPathIsDirectory(input));
  if (!r.ok) return { ok: false, results, derived };

  r = step('git repo present', () => checkIsGitRepo(input));
  if (!r.ok) return { ok: false, results, derived };

  r = step('BMAD installed in repo', () => checkBmadInstalled(input));
  if (!r.ok) return { ok: false, results, derived };

  r = step('origin remote is HTTPS GitHub', () => checkGitRemoteIsGithub(input, gitRunner));
  if (!r.ok) return { ok: false, results, derived };
  derived.repoUrl = r.value.repoUrl;

  step('unpushed-commit warning', () => checkUnpushedCommits(input, gitRunner));

  r = step('branch resolved', () => checkResolveBranch(input, gitRunner));
  derived.branch = r.value.branch;

  r = step('project name resolved', () => checkResolveName(input, derived.repoUrl));
  if (!r.ok) return { ok: false, results, derived };
  derived.name = r.value.name;

  r = step('admin JWT present', () => checkAdminToken(input));
  if (!r.ok) return { ok: false, results, derived };

  // PAT is conditional on run mode — only required for fresh migrations.
  if (!input.refresh) {
    r = step('PAT file readable', () => checkPatFile(input, { requirePat: true }));
    if (!r.ok) return { ok: false, results, derived };
    derived.pat = r.value.pat;
  }

  return { ok: true, results, derived };
}
