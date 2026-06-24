/**
 * ultracode-bench-capture.mjs — the REAL `claude` spawns + capture (the EC2-validation-needed core).
 *
 * ⚠️ UNPROVEN UNTIL VALIDATED ON REAL EC2 (see docs/.../ultracode-bench-ec2-validation.md):
 *   1. Does headless `claude -p "ultracode <intent>"` actually invoke the planner and write a
 *      `workflows/scripts/<name>-wf_<id>.js` (print mode may be TUI-only)? If not, capture is dead
 *      and the node-pty fallback is the only path.
 *   2. Does SIGKILL after the script lands provably leave `agentCount === 0` (no subagents spawned)?
 *
 * Halt design (addresses the critique's chunked-write race): we do NOT kill on the first `.js` byte.
 * We wait until the sibling `wf_<id>.json` EXISTS and is SIZE-STABLE across two poll ticks (it carries
 * the authoritative `agentCount`), THEN read it and SIGKILL. A missing/empty wf.json at timeout ⇒
 * TAINTED (never trust a defaulted agentCount:0). agentCount > 0 ⇒ TAINTED.
 *
 * Spawns reuse the daemon's OAuth path (stripApiKey + loadOAuth) — the daemon deletes
 * ANTHROPIC_API_KEY and runs Claude on the Max/OAuth subscription. NEVER introduce an API key here.
 */

import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';

/** harvest.mjs path-munge: cwd → ~/.claude/projects/<dashed>. macOS /tmp → /private/tmp. */
export function sessionProjectDir(cwd) {
  const real = cwd.startsWith('/tmp/') ? `/private${cwd}` : cwd;
  return join(homedir(), '.claude', 'projects', real.replace(/[/.]/g, '-'));
}

/** Find the newest `workflows/scripts/*.js` under any session subdir of the munged project dir. */
function findGeneratedScript(projDir) {
  if (!existsSync(projDir)) return null;
  const stack = [projDir];
  let best = null;
  while (stack.length) {
    const d = stack.pop();
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && full.endsWith('.js') && /\/workflows\/scripts\//.test(full)) {
        const m = statSync(full).mtimeMs;
        if (!best || m > best.mtime) best = { path: full, mtime: m };
      }
    }
  }
  return best?.path ?? null;
}

/** Read the sibling wf_<id>.json (one dir up from scripts/) — carries agentCount + phases. */
function readWfMeta(scriptPath) {
  const id = (basename(scriptPath).match(/wf_[A-Za-z0-9-]+/) || [])[0];
  if (!id) return null;
  const jsonPath = join(dirname(dirname(scriptPath)), `${id}.json`);
  if (!existsSync(jsonPath)) return null;
  try {
    const stat = statSync(jsonPath);
    const wf = JSON.parse(readFileSync(jsonPath, 'utf8'));
    return {
      jsonPath,
      size: stat.size,
      agentCount: wf.agentCount ?? null,
      phases: wf.phases ?? [],
    };
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Build the real capture deps for the runner.
 * @param {object} cfg
 *   - claudeBin: resolved `claude` path
 *   - stripApiKey(env) → env  (the daemon's OAuth-safe env)
 *   - loadOAuth(reason)       (refresh creds before spawn)
 *   - metaPrompt: string      (the Futurator Workflow Author system prompt for Case 2)
 *   - log(level,msg,meta?)
 */
export function makeCaptureDeps(cfg) {
  const {
    claudeBin = 'claude',
    stripApiKey = (e) => e,
    loadOAuth,
    metaPrompt,
    log = () => {},
  } = cfg;

  /** CASE 1 — spawn native ultracode, watch the scripts dir, kill on stable wf.json. */
  async function captureCase1({
    intent,
    model = 'opus',
    effort = 'xhigh',
    cwd,
    captureTimeoutMs = 120000,
    pollMs = 150,
  }) {
    loadOAuth?.('ultracode-bench-case1');
    const args = [
      '-p',
      `ultracode ${intent}`,
      '--model',
      model,
      '--permission-mode',
      'bypassPermissions',
    ];
    if (effort) args.push('--effort', effort); // [VERIFY] exact CLI effort flag on EC2
    // claudeBin resolves to the cli.js symlink (/usr/bin/claude → …/cli.js). Like the rest of the
    // daemon (agent-daemon.mjs: spawn(process.execPath, [CLAUDE_BIN, …])) it must be run as
    // `node cli.js`, NOT exec'd directly — a direct spawn ENOENTs. And without an 'error' listener
    // a spawn failure is an unhandled 'error' event that crashes the WHOLE daemon; capture it and
    // throw so the runner's try/catch marks the run ERROR (pacman ultracode-bench crash 2026-06-24).
    const child = spawn(process.execPath, [claudeBin, ...args], {
      cwd,
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    let spawnError = null;
    child.on('error', (e) => {
      spawnError = e;
    });

    const projDir = sessionProjectDir(cwd);
    const deadline = Date.now() + captureTimeoutMs;
    let prevWfSize = -1;

    try {
      while (Date.now() < deadline) {
        if (spawnError) throw new Error(`claude spawn failed (case1): ${spawnError.message}`);
        const scriptPath = findGeneratedScript(projDir);
        if (scriptPath) {
          const meta = readWfMeta(scriptPath);
          if (meta && meta.size === prevWfSize && meta.size > 0) {
            // wf.json size stable across two ticks → safe to read + kill
            const scriptJs = readFileSync(scriptPath, 'utf8');
            killTree(child);
            if (meta.agentCount == null) return tainted('wf.json missing agentCount');
            if (meta.agentCount > 0)
              return tainted(`agentCount=${meta.agentCount} (agents spawned before halt)`);
            return { scriptJs, agentCount: 0, tainted: false, phases: meta.phases };
          }
          prevWfSize = meta ? meta.size : -1; // wf.json not there yet (only the .js) → keep waiting
        }
        await sleep(pollMs);
      }
      killTree(child);
      return tainted(
        `timeout after ${captureTimeoutMs}ms — no stable wf.json (headless ultracode may not write a script)`,
      );
    } finally {
      killTree(child);
    }
  }

  /** CASE 2 — spawn `claude -p` with the meta-prompt; the whole stdout IS the script. */
  async function runCase2({ intent, model = 'opus', effort = 'xhigh', cwd }) {
    loadOAuth?.('ultracode-bench-case2');
    const prompt = `${metaPrompt}\n\nINTENT:\n${intent}`;
    const args = ['-p', prompt, '--model', model, '--permission-mode', 'bypassPermissions'];
    if (effort) args.push('--effort', effort);
    const out = await spawnCapture(claudeBin, args, {
      cwd,
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
    });
    return { scriptJs: extractScript(out) };
  }

  return { captureCase1, runCase2 };

  function tainted(reason) {
    log('warn', `[ultracode-bench] case1 tainted: ${reason}`);
    return { scriptJs: '', agentCount: null, tainted: true, taintReason: reason };
  }
}

function killTree(child) {
  try {
    if (child && !child.killed) child.kill('SIGKILL');
  } catch {
    /* ignore */
  }
}

function spawnCapture(bin, args, opts) {
  return new Promise((resolve, reject) => {
    // Run the cli.js symlink via node, matching captureCase1 + the daemon's spawn pattern.
    const child = spawn(process.execPath, [bin, ...args], { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.on('error', reject);
    child.on('close', () => resolve(out));
  });
}

/** Pull the workflow script out of the model's stdout (the meta-prompt asks for script-only output). */
export function extractScript(stdout) {
  const fenced = stdout.match(/```(?:js|javascript)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : stdout;
  const start = body.indexOf('export const meta');
  return start >= 0 ? body.slice(start).trim() : body.trim();
}
