// Pipeline v2.0 efficiency fix T0.2 / B1 (pre-DEV tsc baseline).
//
// Run a project's runCommand (typically `tsc --noEmit` or `npm run typecheck`)
// keyed on `git rev-parse HEAD`. Cache the result at
// `<projectDir>/.context/tsc-baseline.json` so subsequent invocations
// (sibling stories in the same wave, retry-after-pickup) reuse the same
// verdict without re-running.
//
// Why bash, not LLM: tsc/lint outcomes are objective. Asking the agent
// "did this compile?" wastes ~$0.10 per ask and is probabilistic. The
// daemon shells out, parses exit code, caches the verdict.
//
// Pure-ish: the shell + fs are injectable for tests.

import { execSync as nodeExecSync } from 'node:child_process';
import {
  readFile as fsReadFile,
  writeFile as fsWriteFile,
  mkdir as fsMkdir,
} from 'node:fs/promises';
import { existsSync as fsExistsSync } from 'node:fs';
import { join } from 'node:path';

const CACHE_REL_PATH = '.context/tsc-baseline.json';
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run the project's typecheck command (or fall back to `tsc --noEmit`)
 * with a cache keyed on the working tree's git SHA.
 *
 * @param {object} input
 * @param {string} input.projectDir - absolute path to project root
 * @param {string} [input.runCommand] - shell command to run (default: `npx tsc --noEmit`)
 * @param {number} [input.timeoutMs] - exec timeout (default 60s)
 * @param {boolean} [input.force] - bypass cache (default false)
 * @param {object} [input.shell] - injectable { execSync, gitSha } for tests
 * @param {object} [input.fs] - injectable { readFile, writeFile, mkdir, exists } for tests
 * @returns {Promise<{
 *   ok: boolean,
 *   gitSha: string | null,
 *   output: string,
 *   cached: boolean,
 *   ranAtMs: number,
 *   error?: string,
 * }>}
 */
export async function runCachedTypecheck(input) {
  const {
    projectDir,
    runCommand = 'npx tsc --noEmit',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    force = false,
    shell = { execSync: nodeExecSync, gitSha: defaultGitSha },
    fs = {
      readFile: fsReadFile,
      writeFile: fsWriteFile,
      mkdir: fsMkdir,
      exists: (p) => Promise.resolve(fsExistsSync(p)),
    },
  } = input || {};

  if (!projectDir) {
    return {
      ok: false,
      gitSha: null,
      output: '',
      cached: false,
      ranAtMs: 0,
      error: 'projectDir required',
    };
  }

  // Resolve current git SHA. If the dir isn't a git repo, we still run the
  // command — we just can't cache by SHA (cache is bypassed).
  const gitSha = safeGitSha(shell, projectDir);

  const cachePath = join(projectDir, CACHE_REL_PATH);

  // Cache hit?
  if (!force && gitSha && (await fs.exists(cachePath))) {
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const cached = JSON.parse(raw);
      if (cached?.gitSha === gitSha && typeof cached.ok === 'boolean') {
        return {
          ok: cached.ok,
          gitSha,
          output: cached.output || '',
          cached: true,
          ranAtMs: cached.ranAtMs || 0,
        };
      }
    } catch {
      // corrupt cache — fall through and re-run
    }
  }

  // Run the command. execSync throws on non-zero exit; we capture stdout+stderr
  // separately so failures don't lose context.
  let ok;
  let output = '';
  try {
    output = shell.execSync(runCommand, {
      cwd: projectDir,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
    });
    ok = true;
  } catch (err) {
    ok = false;
    // execSync attaches stdout/stderr to the error object.
    output = [err.stdout || '', err.stderr || '', err.message || '']
      .filter(Boolean)
      .join('\n')
      .slice(0, 8000);
  }

  const ranAtMs = Date.now();

  // Persist cache (best-effort). Cache only when we have a SHA — without
  // git, the next call would falsely reuse a cache from a different tree.
  if (gitSha) {
    try {
      await fs.mkdir(join(projectDir, '.context'), { recursive: true });
      await fs.writeFile(
        cachePath,
        JSON.stringify({ gitSha, ok, output: output.slice(0, 8000), ranAtMs }, null, 2),
        'utf8',
      );
    } catch {
      // non-fatal — caller still gets the verdict
    }
  }

  return { ok, gitSha, output, cached: false, ranAtMs };
}

// ── internals ────────────────────────────────────────────────────────────

function safeGitSha(shell, projectDir) {
  try {
    return shell.gitSha(projectDir);
  } catch {
    return null;
  }
}

function defaultGitSha(projectDir) {
  return nodeExecSync('git rev-parse HEAD', {
    cwd: projectDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5_000,
  }).trim();
}
