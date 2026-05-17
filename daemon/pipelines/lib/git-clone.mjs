/**
 * Secret-safe git-clone helper for brownfield Party projects (Story 15.4).
 *
 * Builds the tokenized clone URL in-memory only:
 *   https://x-access-token:<PAT>@github.com/<owner>/<repo>.git
 *
 * Captures stdout/stderr from `git clone` and REDACTS the raw token (and the
 * x-access-token URL form that contains it) before passing the lines to the
 * caller's `ctx.emit` callback or surfacing them in thrown errors. The PAT
 * must never appear in event payloads, logs, or DDB rows.
 *
 * AC #4 — Story 15.4.
 */

import { spawn } from 'node:child_process';

const X_ACCESS_TOKEN_PATTERN = /https:\/\/x-access-token:[^@\s]+@/g;

/**
 * Replace any occurrence of the raw PAT (token) or tokenized URL form with a
 * masked placeholder. Defensive — the redactor MUST be applied to every line
 * before it leaves this module.
 */
export function redactToken(text, token) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text.replace(X_ACCESS_TOKEN_PATTERN, 'https://***@');
  if (token) {
    // Replace any bare occurrence of the raw token in case a downstream tool
    // logs it without the URL wrapper. Split-join is safe because token is
    // treated as a literal (no regex escape needed).
    out = out.split(token).join('***');
  }
  return out;
}

/**
 * Build the in-memory tokenized clone URL.
 *
 * Accepts `https://github.com/<owner>/<repo>` with or without `.git`. Always
 * normalizes to `.git` form because some git versions require it for PAT auth.
 */
export function buildTokenizedUrl(repoUrl, token) {
  if (!repoUrl || typeof repoUrl !== 'string') {
    throw new Error('buildTokenizedUrl: repoUrl is required');
  }
  if (!token || typeof token !== 'string') {
    throw new Error('buildTokenizedUrl: token is required');
  }
  const match = repoUrl.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?$/);
  if (!match) {
    throw new Error(`buildTokenizedUrl: not an HTTPS GitHub URL: ${repoUrl}`);
  }
  const [, owner, repo] = match;
  return `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
}

/**
 * Clone a private GitHub repository into `targetPath` using a fine-grained PAT.
 *
 * @param {object} args
 * @param {string} args.repoUrl - https://github.com/<owner>/<repo>(.git)?
 * @param {string} args.branch - branch name (e.g. 'main')
 * @param {string} args.token - raw PAT, kept in-memory only
 * @param {string} args.targetPath - absolute destination directory
 * @param {number} [args.depth=50] - --depth value passed to git clone
 * @param {object} [args.ctx] - optional caller context
 * @param {(stream: 'stdout'|'stderr', data: string) => Promise<void>|void} [args.ctx.emit]
 * @returns {Promise<void>}
 */
export async function cloneRepo({ repoUrl, branch, token, targetPath, depth = 50, ctx } = {}) {
  if (!branch) throw new Error('cloneRepo: branch is required');
  if (!targetPath) throw new Error('cloneRepo: targetPath is required');

  const tokenized = buildTokenizedUrl(repoUrl, token);
  const args = ['clone', '--branch', branch, '--depth', String(depth), tokenized, targetPath];

  return await new Promise((resolve, reject) => {
    const child = spawn('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });

    const stderrChunks = [];

    child.stdout.on('data', async (chunk) => {
      const redacted = redactToken(chunk.toString('utf8'), token);
      try {
        await ctx?.emit?.('stdout', redacted);
      } catch {
        // Caller emit failure must not crash the clone — swallow.
      }
    });
    child.stderr.on('data', async (chunk) => {
      const redacted = redactToken(chunk.toString('utf8'), token);
      stderrChunks.push(redacted);
      try {
        await ctx?.emit?.('stderr', redacted);
      } catch {
        // ditto.
      }
    });

    child.on('error', (err) => {
      reject(new Error(`git clone failed to spawn: ${redactToken(err.message, token)}`));
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      const tail = stderrChunks.join('').trim().split(/\r?\n/).slice(-5).join('\n');
      reject(new Error(`git clone exited with code ${code}: ${tail}`));
    });
  });
}
