/**
 * ultracode-bench-capture.mjs — the REAL `claude` spawns + capture.
 *
 * Case 1 (native ultracode) — VALIDATED 2026-06-25. Headless `claude -p "ultracode <intent>"`
 * invokes the built-in Workflow tool on its FIRST turn and persists the plan to
 * ~/.claude/projects/<munged-cwd>/<session>/workflows/scripts/<name>-wf_<id>.js (sibling manifest
 * one dir up: workflows/wf_<id>.json carries agentCount/phases). We stream `--output-format
 * stream-json` and HALT the instant the Workflow tool returns that scriptPath — the earliest
 * deterministic "plan produced" point — then read the script.
 *   We no longer poll the filesystem for a SIZE-STABLE, agentCount===0 wf.json: the Workflow tool
 *   spawns its sub-agents on the SAME turn it persists the script, so a zero-agent snapshot is
 *   unobservable (that race tainted every run). agentCount is recorded for reporting, never tainted.
 *   A filesystem scan (findGeneratedScript) remains a fallback if the path isn't seen in the stream.
 *
 * Case 2 (our meta-prompt) — `claude -p` output-only; the whole stdout IS the script.
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

/** Read a persisted workflow plan + its manifest (agentCount/phases recorded for reporting only). */
function readWorkflowPlan(scriptPath) {
  try {
    const scriptJs = readFileSync(scriptPath, 'utf8');
    if (!scriptJs.trim()) return null;
    const meta = readWfMeta(scriptPath);
    return {
      scriptJs,
      agentCount: meta?.agentCount ?? null,
      tainted: false,
      phases: meta?.phases ?? [],
    };
  } catch {
    return null;
  }
}

// The claude CLI `--effort` flag accepts ONLY low|medium|high|max. 'xhigh' (a valid Agent-tool
// effort elsewhere) is rejected and makes the spawn exit instantly — normalize anything invalid to
// 'max' (the CLI's highest tier) so an old payload can't silently kill the capture.
const VALID_EFFORT = new Set(['low', 'medium', 'high', 'max']);
const normEffort = (e) => (VALID_EFFORT.has(e) ? e : 'max');

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

  /**
   * CASE 1 — run native ultracode headless; stream the JSON events and HALT the instant the
   * Workflow tool returns its persisted scriptPath (the earliest deterministic "plan produced").
   * claude ≥2.1.19x is a native binary — spawn it DIRECTLY (node can't run an ELF).
   */
  function captureCase1({ intent, model = 'opus', effort = 'xhigh', cwd, captureTimeoutMs = 120000 }) {
    loadOAuth?.('ultracode-bench-case1');
    const args = [
      '-p',
      `ultracode ${intent}`,
      '--model',
      model,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    const eff1 = normEffort(effort);
    if (eff1) args.push('--effort', eff1);

    const child = spawn(claudeBin, args, {
      cwd,
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve) => {
      let settled = false;
      let buf = '';
      let blockingRateLimit = false;
      let capturing = false; // a scriptPath was seen; we're retrying the read

      const timer = setTimeout(
        () => finish(fallbackOrTaint(`timeout after ${captureTimeoutMs}ms — no Workflow plan in stream`)),
        captureTimeoutMs,
      );

      function finish(result) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree(child);
        resolve(result);
      }

      // Last resort: the scriptPath wasn't in the stream → scan the session dir once.
      function fallbackOrTaint(reason) {
        try {
          const sp = findGeneratedScript(sessionProjectDir(cwd));
          const plan = sp && readWorkflowPlan(sp);
          if (plan) return plan;
        } catch {
          /* ignore */
        }
        return tainted(blockingRateLimit ? 'rate limited (5h window, overage rejected)' : reason);
      }

      child.on('error', (e) => finish(tainted(`claude spawn failed (case1): ${e.message}`)));
      child.on('close', () => {
        // If we're mid-capture (path seen, retrying the read), let that resolve.
        if (!capturing) finish(fallbackOrTaint('stream ended before a Workflow plan was produced'));
      });

      // The Workflow tool returns the persisted path slightly before the file is flushed; retry the
      // read for a short window (the file persists independently of the live process).
      function captureFrom(path) {
        capturing = true;
        let tries = 0;
        const attempt = () => {
          if (settled) return;
          const plan = readWorkflowPlan(path);
          if (plan) return finish(plan);
          if (++tries >= 15) return finish(fallbackOrTaint(`scriptPath never became readable: ${path}`));
          setTimeout(attempt, 300); // up to ~4.5s
        };
        attempt();
      }

      child.stdout.on('data', (chunk) => {
        if (capturing) return;
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          // Cheap blocking-rate-limit guard (no full parse).
          if (line.includes('rate_limit_event') && line.includes('"status"') && !line.includes('"allowed"')) {
            blockingRateLimit = true;
          }
          // A hard CLI error (e.g. "Not logged in · Please run /login", auth/credits) surfaces as a
          // result event with is_error:true — report it verbatim so the UI shows the real reason
          // instead of a misleading "no Workflow plan" (daemon-logged-out incident 2026-06-25).
          if (line.includes('"type":"result"') && line.includes('"is_error":true')) {
            const em = line.match(/"result":"((?:[^"\\]|\\.)*)"/);
            finish(tainted(`claude error: ${em ? em[1] : 'CLI reported is_error'}`));
            return;
          }
          // The Workflow tool_result carries the persisted plan's absolute path.
          const m = line.match(/\/[^"\s\\]*\/workflows\/scripts\/[^"\s\\]*\.js/);
          if (m) {
            captureFrom(m[0]);
            return;
          }
        }
      });
    });
  }

  /** CASE 2 — spawn `claude -p` with the meta-prompt; the whole stdout IS the script. */
  async function runCase2({ intent, model = 'opus', effort = 'xhigh', cwd }) {
    loadOAuth?.('ultracode-bench-case2');
    const prompt = `${metaPrompt}\n\nINTENT:\n${intent}`;
    const args = ['-p', prompt, '--model', model, '--permission-mode', 'bypassPermissions'];
    const eff2 = normEffort(effort);
    if (eff2) args.push('--effort', eff2);
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
    // claude ≥2.1.19x is a native binary — spawn directly (see captureCase1).
    const child = spawn(bin, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
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
