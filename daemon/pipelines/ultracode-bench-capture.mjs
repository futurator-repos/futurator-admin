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
 * Case 2 (our meta-prompt) — `claude -p` output-only; the whole stdout IS the script (any prose
 *   preceding `export const meta` is captured separately as planText, a scoreable artifact).
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

/** Extract {input,output} token counts from a stream-json line carrying a usage object. */
function parseUsage(line) {
  try {
    const ev = JSON.parse(line);
    const u = ev?.message?.usage || ev?.usage;
    if (!u) return null;
    return {
      input:
        (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
      output: u.output_tokens || 0,
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
/**
 * The taint reason a cancelled Case-1 capture reports — a CONTRACT with the job runner,
 * which maps it to run status CANCELLED (operator intent) instead of ERROR (a failure).
 */
export const CANCELLED_TAINT_REASON = 'cancelled-by-operator';

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
  function captureCase1({ intent, model = 'opus', effort = 'xhigh', cwd, captureTimeoutMs = 120000, shouldAbort }) {
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
      let latestUsage = null; // most recent token usage seen in the stream

      const timer = setTimeout(
        () => finish(fallbackOrTaint(`timeout after ${captureTimeoutMs}ms — no Workflow plan in stream`)),
        captureTimeoutMs,
      );

      // True-cancel support: the operator's Cancel button sets cancelRequestedAt on the run row;
      // the runner injects shouldAbort() and we kill the live child within one poll tick. The
      // 'cancelled-by-operator' taint reason is a CONTRACT with the runner (it maps it to a
      // CANCELLED run, not an ERROR).
      const abortPoll = shouldAbort
        ? setInterval(async () => {
            try {
              if (!settled && (await shouldAbort())) finish(tainted(CANCELLED_TAINT_REASON));
            } catch {
              /* a failed cancel check must never kill a healthy capture */
            }
          }, 4000)
        : null;

      function finish(result) {
        if (settled) return;
        if (abortPoll) clearInterval(abortPoll);
        if (result && !result.tainted && !result.tokens) {
          // We halt the instant the plan is produced, BEFORE the CLI finalizes that turn's output
          // usage — so the streamed output count is unreliable. Input is accurate; estimate output
          // from the authored plan's size (~4 chars/token) so the number is meaningful, and flag it.
          const input = latestUsage?.input ?? 0;
          const estOut = Math.round((result.scriptJs || '').length / 4);
          const output = Math.max(latestUsage?.output ?? 0, estOut);
          if (input || output) result = { ...result, tokens: { input, output, outputApprox: true } };
        }
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
          // Track token usage (cumulative on assistant/result events) for the planning-cost metric.
          if (line.includes('"usage"')) {
            latestUsage = parseUsage(line) ?? latestUsage;
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

  /**
   * CASE 2 — our meta-prompt. Runs with stream-json so we can (a) live-stream the script as it's
   * authored and (b) capture token usage. The model's full text response IS the script; the
   * authoritative copy is the `result` event, with assistant text as the streaming/fallback source.
   * Resolves { scriptJs, planText, tokens }.
   */
  function runCase2({ intent, model = 'opus', effort = 'xhigh', cwd, onToken, shouldAbort }) {
    loadOAuth?.('ultracode-bench-case2');
    const prompt = `${metaPrompt}\n\nINTENT:\n${intent}`;
    const args = [
      '-p',
      prompt,
      '--model',
      model,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    const eff2 = normEffort(effort);
    if (eff2) args.push('--effort', eff2);

    return new Promise((resolve, reject) => {
      const child = spawn(claudeBin, args, {
        cwd,
        env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let buf = '';
      let assistantText = '';
      let resultText = '';
      let usage = null;
      let pending = '';
      let lastFlush = 0;
      const flush = () => {
        if (pending && onToken) onToken(pending);
        pending = '';
      };

      // True-cancel: kill the live child on the operator's cancel signal; the close handler
      // resolves with { aborted: true } so the runner marks the side CANCELLED, never COMPLETE.
      let aborted = false;
      const abortPoll = shouldAbort
        ? setInterval(async () => {
            try {
              if (!aborted && (await shouldAbort())) {
                aborted = true;
                killTree(child);
              }
            } catch {
              /* a failed cancel check must never kill a healthy run */
            }
          }, 4000)
        : null;

      child.on('error', reject);
      child.stdout.on('data', (chunk) => {
        buf += chunk.toString();
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim()) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          const u = parseUsage(line);
          if (u) usage = u;
          if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
            const t = ev.message.content
              .filter((p) => p?.type === 'text')
              .map((p) => p.text)
              .join('');
            if (t) {
              assistantText += t;
              pending += t;
            }
          } else if (ev.type === 'result' && typeof ev.result === 'string') {
            resultText = ev.result;
          }
          const now = Date.now();
          if (now - lastFlush > 750) {
            lastFlush = now;
            flush();
          }
        }
      });
      child.on('close', () => {
        if (abortPoll) clearInterval(abortPoll);
        flush();
        if (aborted) {
          resolve({ scriptJs: '', planText: '', tokens: usage, aborted: true });
          return;
        }
        const { planText, scriptJs } = splitPlanAndScript(resultText || assistantText);
        resolve({ scriptJs, planText, tokens: usage });
      });
    });
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

// Anchored on the real declaration shape (`export const meta` followed by `=`) so a prose
// mention of the phrase (e.g. the model narrating "...as required by export const meta...")
// isn't mistaken for the script start.
const META_DECL_SOURCE = String.raw`^export const meta\s*=`;
const META_DECL_RE = new RegExp(META_DECL_SOURCE, 'm');

/**
 * Split the model's stdout into { planText, scriptJs } — fence-aware: if a ``` fence's body
 * actually contains the `export const meta = ...` declaration, everything before that fence is
 * prose/plan and the fence is the script; a fence that does NOT contain the declaration (e.g. an
 * illustrative snippet fenced inside the plan) is ignored rather than trusted. Otherwise, scan the
 * whole stdout for the LAST anchored `export const meta =` occurrence — everything before it is
 * the plan. planText is '' when no prose precedes the script (the v0 meta-prompt's script-only
 * behavior stays unchanged).
 */
export function splitPlanAndScript(stdout) {
  const fenceRe = /```(?:js|javascript)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = fenceRe.exec(stdout)) !== null) {
    const body = match[1];
    const declMatch = body.match(META_DECL_RE);
    if (declMatch) {
      const scriptJs = body.slice(declMatch.index).trim();
      const planText = stdout.slice(0, match.index).trim();
      return { planText, scriptJs };
    }
  }

  // No fence's body contains the real declaration (or there are no fences) — fall back to
  // scanning the full stdout, taking the LAST anchored match so an earlier prose mention (with
  // the required trailing `=`, e.g. a quoted example) doesn't get confused with the real script.
  const declMatches = [...stdout.matchAll(new RegExp(META_DECL_SOURCE, 'gm'))];
  const last = declMatches[declMatches.length - 1];
  const start = last ? last.index : -1;
  const scriptJs = start >= 0 ? stdout.slice(start).trim() : stdout.trim();
  const planText = start >= 0 ? stdout.slice(0, start).trim() : '';
  return { planText, scriptJs };
}

/** Pull the workflow script out of the model's stdout (the meta-prompt asks for script-only output). */
export function extractScript(stdout) {
  return splitPlanAndScript(stdout).scriptJs;
}
