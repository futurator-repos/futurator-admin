/**
 * agentic-vqa-runner.mjs — the automated operator-play-test QA lane.
 *
 * Runs a computer-use agent (the vendored BrowserAgent core in
 * `./browser-agent/`) against a freshly deployed dev app, one run per delivery
 * journey, and reads back a structured verdict. This is the lane that catches
 * the "journey cannot be completed" class of defect that shipped in every pacman
 * plan and that the deterministic `__harness` lanes cannot see.
 *
 * Two backends, one contract (design I2 §Q2):
 *   - EMBEDDED HEADLESS (server boxes): the vendored `runAgentLoop` +
 *     `PlaywrightExecutor` run in-process. Playwright is imported LAZILY from the
 *     daemon's own node_modules so a missing/broken install degrades one journey
 *     rather than the whole daemon.
 *   - EXTENSION (the operator's Mac): drive a locally-running BrowserAgent
 *     service over its HTTP+SSE contract so the operator literally watches QA run
 *     in their real Chrome. `mode:'auto'` probes `GET /api/status` and uses the
 *     extension iff it is reachable AND `extensionConnected`; otherwise embedded.
 *
 * API-KEY ISOLATION (design's key-isolation rule): the SDK client is built ONLY
 * from `env.BROWSER_AGENT_API_KEY`. This module NEVER reads/requires
 * `ANTHROPIC_API_KEY` — the daemon spawns the `claude` CLI on the Max
 * subscription and a global key would silently flip it to per-token billing.
 * Missing key ⇒ `{ skippedReason: 'no-api-key', runs: [] }` (never fails QA).
 *
 * HONESTY CONTRACT: `runAgenticVqa` NEVER throws. Every per-journey failure is
 * caught and recorded as a run entry with `verdict:'uncertain'` + an `error`.
 *
 * @typedef {{ severity: 'blocking'|'attention', note: string }} AgenticFinding
 * @typedef {{
 *   journeyId: string,
 *   instruction: string,
 *   verdict: 'pass'|'fail'|'uncertain',
 *   findings: AgenticFinding[],
 *   frameUrls: string[],
 *   steps: number,
 *   durationMs: number,
 *   error?: string,
 * }} AgenticRun
 * @typedef {{ mode: 'headless'|'extension', model: string, skippedReason?: string, runs: AgenticRun[] }} AgenticReport
 */

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runAgentLoop as defaultRunAgentLoop } from './browser-agent/loop.mjs';

const DEFAULT_BROWSER_AGENT_URL = 'http://127.0.0.1:3010';
const DEFAULT_MODEL = 'claude-sonnet-5';
const DEFAULT_MAX_JOURNEYS = 3;
const DEFAULT_MAX_STEPS = 25;
const STATUS_PROBE_TIMEOUT_MS = 1500;
const SSE_TIMEOUT_MS = 10 * 60 * 1000; // extension runs are watched live; generous ceiling
const S3_TIMEOUT_MS = 45_000;
const DEFAULT_SCREENSHOT_BASE = 'https://dev.futurator.ai';

// ── Pure helpers ───────────────────────────────────────────────────────────

/** Parse an env value as a positive integer, falling back to `def`. PURE. */
function toPosInt(v, def) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : def;
}

/** Turn any string into a safe path/key fragment (mirrors p3-qa-runner). PURE. */
function sanitizeKey(s) {
  return String(s || 'journey').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 120);
}

/**
 * Ensure a fully-qualified URL (BrowserAgent's normalizer mangles bare
 * `host:port`, see assess gaps). Prepends a scheme when none is present. PURE.
 */
export function ensureUrl(devUrl, env = process.env) {
  const raw = String(devUrl || '').trim();
  if (!raw) return raw;
  let url = raw;
  if (!/^https?:\/\//i.test(url)) {
    // localhost/127.* dev servers are http; everything else defaults to https.
    const scheme = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url) ? 'http' : 'https';
    url = `${scheme}://${url}`;
  }
  // Optional env-configured origin rewrite for devUrls whose canonical host is
  // not (yet) resolvable from this box — e.g. a dev subdomain whose DNS alias
  // is pending. Deployment-specific values live in the daemon env, NEVER in
  // code. AGENTIC_VQA_URL_REWRITE format: "<host>=<replacement-host>".
  const rewrite = env.AGENTIC_VQA_URL_REWRITE || '';
  const [fromHost, toHost] = rewrite.split('=');
  if (fromHost && toHost) {
    try {
      const u = new URL(url);
      if (u.hostname === fromHost) {
        u.hostname = toHost;
        url = u.toString();
      }
    } catch {
      /* leave as-is */
    }
  }
  return url;
}

/**
 * Build the natural-language instruction for one delivery journey: narrative +
 * expected outcomes + the real-user framing + the verdict-epilogue reminder.
 * PURE.
 */
export function buildInstruction(journey = {}) {
  const parts = [];
  if (journey.title) parts.push(`Journey: ${journey.title}`);
  const narrative = journey.narrative || journey.description || '';
  if (narrative) parts.push(String(narrative).trim());

  const outcomes = journey.expectedOutcomes || journey.outcomes || journey.expected;
  if (Array.isArray(outcomes) && outcomes.length) {
    parts.push('Expected outcomes (what a satisfied user should be able to observe):');
    for (const o of outcomes) {
      const text = typeof o === 'string' ? o : o?.text || o?.then || JSON.stringify(o);
      if (text) parts.push(`- ${text}`);
    }
  }

  parts.push('You are QA-testing a freshly deployed web app. Interact as a real user.');
  parts.push(
    'When finished, end your final message with the mandatory QA verdict block: a line ' +
      '`QA_VERDICT: pass` or `QA_VERDICT: fail`, then a `QA_FINDINGS:` line, then zero or more ' +
      '`- [blocking|attention] <note>` finding lines (an empty block is allowed on a clean pass).',
  );
  return parts.join('\n');
}

/**
 * Parse the agent's final free-text message into a verdict + findings.
 *
 * Tolerant: any `QA_VERDICT: pass|fail` line (case-insensitive, anywhere) sets
 * the verdict; a `QA_FINDINGS:` block contributes `- [blocking|attention] note`
 * lines. An unparseable / missing verdict yields `'uncertain'` plus an
 * `[attention]` "unparseable verdict" finding. PURE.
 *
 * @param {string} text
 * @returns {{ verdict: 'pass'|'fail'|'uncertain', findings: AgenticFinding[] }}
 */
export function parseAgenticVerdict(text) {
  const src = String(text || '');
  const findings = [];

  const verdictMatch = src.match(/QA_VERDICT:\s*(pass|fail)\b/i);
  const verdict = verdictMatch ? verdictMatch[1].toLowerCase() : 'uncertain';

  // Everything after the LAST `QA_FINDINGS:` marker is the findings block.
  const findingsIdx = src.toUpperCase().lastIndexOf('QA_FINDINGS:');
  if (findingsIdx !== -1) {
    const block = src.slice(findingsIdx + 'QA_FINDINGS:'.length);
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*[-*]\s*\[(blocking|attention)\]\s*(.*\S)?\s*$/i);
      if (m) findings.push({ severity: m[1].toLowerCase(), note: (m[2] || '').trim() });
    }
  }

  if (!verdictMatch) {
    findings.push({ severity: 'attention', note: 'unparseable verdict' });
  }
  return { verdict, findings };
}

// ── S3 frame upload (mirrors p3-qa-runner's injected `s3` spawn shape) ───────

/**
 * Upload one local PNG to the DEV-ENV bucket under the `_qa/` reserved prefix,
 * using the SAME injected `s3` shape p3-qa-runner uses: a callable
 * `s3(cmd, cwd, timeoutMs) => Promise<{ code, stderr }>` that runs a shell
 * command. Missing bucket or a non-zero exit degrades to an empty URL
 * (non-blocking); a genuine THROW from `s3` propagates to the per-journey
 * try/catch. Returns the public URL or ''.
 */
async function uploadFrameFile({ s3, localPath, key, cwd, bucket, base, log }) {
  if (typeof s3 !== 'function' || !bucket) return '';
  const cmd = `timeout 30 aws s3 cp ${localPath} "s3://${bucket}/${key}" --content-type image/png`;
  const up = await s3(cmd, cwd, S3_TIMEOUT_MS);
  if (up && up.code === 0) return `${base}/${key}`;
  try {
    log('warn', `[agentic-vqa] SCREENSHOT_UPLOAD_FAILED for ${key}: ${(up?.stderr || '').slice(0, 200)}`);
  } catch {
    /* best-effort */
  }
  return '';
}

/** Write a base64 PNG to a temp file, upload it, clean up. Returns URL or ''. */
async function uploadBase64Frame({ s3, base64Png, key, cwd, bucket, base, log }) {
  if (typeof s3 !== 'function' || !bucket) return '';
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'agentic-vqa-'));
    const localPath = join(dir, 'frame.png');
    writeFileSync(localPath, Buffer.from(base64Png, 'base64'));
    return await uploadFrameFile({ s3, localPath, key, cwd, bucket, base, log });
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ── Extension backend (HTTP + SSE against a running BrowserAgent service) ────

/**
 * Probe the BrowserAgent service. Returns true iff `GET /api/status` responds
 * within the timeout AND reports `extensionConnected`. Never throws.
 */
async function probeExtension({ baseUrl, fetchImpl, log }) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), STATUS_PROBE_TIMEOUT_MS);
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/api/status`, { signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) return false;
    const data = await res.json();
    return !!data?.extensionConnected;
  } catch (err) {
    try {
      log('info', `[agentic-vqa] extension status probe failed, using headless: ${err?.message || err}`);
    } catch {
      /* best-effort */
    }
    return false;
  }
}

/**
 * Read a BrowserAgent SSE stream (`GET /api/stream/:id`) to completion,
 * collecting screenshot paths and the final `done` text. Stops on done/error.
 */
async function consumeSse({ baseUrl, sessionId, fetchImpl, log }) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SSE_TIMEOUT_MS);
  const screenshotPaths = [];
  let doneText = '';
  let errorMessage;
  try {
    const res = await fetchImpl(`${baseUrl}/api/stream/${encodeURIComponent(sessionId)}`, {
      signal: ctrl.signal,
      headers: { accept: 'text/event-stream' },
    });
    if (!res || !res.ok || !res.body) {
      throw new Error(`stream open failed: ${res?.status}`);
    }
    const decoder = new TextDecoder();
    let buffer = '';
    // res.body is a web ReadableStream (async-iterable in modern Node fetch).
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let sep;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const dataLine = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('');
        if (!dataLine) continue;
        let evt;
        try {
          evt = JSON.parse(dataLine);
        } catch {
          continue;
        }
        if (evt.type === 'screenshot' && evt.data?.url) {
          screenshotPaths.push(evt.data.url);
        } else if (evt.type === 'done') {
          doneText = evt.data?.text || '';
          return { doneText, screenshotPaths, errorMessage };
        } else if (evt.type === 'error') {
          errorMessage = evt.data?.message || 'agent error';
          return { doneText, screenshotPaths, errorMessage };
        }
      }
    }
  } catch (err) {
    errorMessage = errorMessage || err?.message || String(err);
    try {
      log('warn', `[agentic-vqa] SSE consume ended: ${errorMessage}`);
    } catch {
      /* best-effort */
    }
  } finally {
    clearTimeout(timer);
  }
  return { doneText, screenshotPaths, errorMessage };
}

/** Download one BrowserAgent-served screenshot and re-upload it to S3. URL or ''. */
async function downloadAndUploadFrame({ baseUrl, framePath, fetchImpl, s3, key, cwd, bucket, base, log }) {
  if (typeof s3 !== 'function' || !bucket) return '';
  let dir;
  try {
    const full = /^https?:\/\//i.test(framePath) ? framePath : `${baseUrl}${framePath.startsWith('/') ? '' : '/'}${framePath}`;
    const res = await fetchImpl(full);
    if (!res || !res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    dir = mkdtempSync(join(tmpdir(), 'agentic-vqa-'));
    const localPath = join(dir, 'frame.png');
    writeFileSync(localPath, buf);
    return await uploadFrameFile({ s3, localPath, key, cwd, bucket, base, log });
  } catch (err) {
    try {
      log('warn', `[agentic-vqa] frame download/upload failed for ${framePath}: ${err?.message || err}`);
    } catch {
      /* best-effort */
    }
    return '';
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
  }
}

// ── Per-journey backends ─────────────────────────────────────────────────────

/** Run one journey via a locally-running BrowserAgent service (extension mode). */
async function runExtensionJourney({
  journey,
  journeyId,
  instruction,
  url,
  baseUrl,
  fetchImpl,
  s3,
  cwd,
  bucket,
  base,
  keyPrefix,
  log,
}) {
  const started = Date.now();
  const runRes = await fetchImpl(`${baseUrl}/api/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'extension', url, instruction, tier: 'normal' }),
  });
  if (!runRes || !runRes.ok) {
    throw new Error(`extension /api/run failed: ${runRes?.status}`);
  }
  const { sessionId } = await runRes.json();
  if (!sessionId) throw new Error('extension /api/run returned no sessionId');

  const { doneText, screenshotPaths, errorMessage } = await consumeSse({ baseUrl, sessionId, fetchImpl, log });

  const frameUrls = [];
  let step = 0;
  for (const framePath of screenshotPaths) {
    step += 1;
    const key = `${keyPrefix}/step-${String(step).padStart(3, '0')}.png`;
    const u = await downloadAndUploadFrame({ baseUrl, framePath, fetchImpl, s3, key, cwd, bucket, base, log });
    if (u) frameUrls.push(u);
  }

  const parsed = parseAgenticVerdict(doneText);
  const findings = errorMessage
    ? [...parsed.findings, { severity: 'attention', note: `agent error: ${errorMessage}` }]
    : parsed.findings;
  return {
    journeyId,
    instruction,
    verdict: errorMessage ? 'uncertain' : parsed.verdict,
    findings,
    frameUrls,
    steps: screenshotPaths.length,
    durationMs: Date.now() - started,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

/** Run one journey via the in-process vendored loop + PlaywrightExecutor. */
async function runEmbeddedJourney({
  journey,
  journeyId,
  instruction,
  url,
  model,
  apiKey,
  baseURL,
  maxSteps,
  s3,
  cwd,
  bucket,
  base,
  keyPrefix,
  log,
  runAgentLoop,
  createExecutor,
  client,
}) {
  const started = Date.now();
  const frameUrls = [];
  let doneText = '';
  let steps = 0;
  let errorMessage;

  const emit = (type, data) => {
    if (type === 'done') {
      doneText = data?.text || doneText;
      steps = Number.isFinite(data?.steps) ? data.steps : steps;
    } else if (type === 'error') {
      errorMessage = data?.message || 'agent error';
    }
  };

  const saveFrame = async (stepIndex, base64Png) => {
    const key = `${keyPrefix}/step-${String(stepIndex).padStart(3, '0')}.png`;
    const u = await uploadBase64Frame({ s3, base64Png, key, cwd, bucket, base, log });
    if (u) frameUrls.push(u);
  };

  // Lazy Playwright import (only in the real embedded path): a broken install
  // degrades THIS journey via the caller's per-journey try/catch, not the daemon.
  let executor;
  if (createExecutor) {
    executor = createExecutor();
  } else {
    const { PlaywrightExecutor } = await import('./browser-agent/playwright-executor.mjs');
    executor = new PlaywrightExecutor();
  }
  await executor.start({ url, headed: false });

  await runAgentLoop({
    emit,
    saveFrame,
    executor,
    instruction,
    url,
    model,
    apiKey,
    baseURL,
    mode: 'headless',
    client,
    maxSteps,
  });

  const parsed = parseAgenticVerdict(doneText);
  const findings = errorMessage
    ? [...parsed.findings, { severity: 'attention', note: `agent error: ${errorMessage}` }]
    : parsed.findings;
  return {
    journeyId,
    instruction,
    verdict: errorMessage ? 'uncertain' : parsed.verdict,
    findings,
    frameUrls,
    steps,
    durationMs: Date.now() - started,
    ...(errorMessage ? { error: errorMessage } : {}),
  };
}

// ── Entry point ──────────────────────────────────────────────────────────────

/**
 * Run the agentic VQA lane for one plan.
 *
 * @param {object} args
 * @param {{ planId?: string }} [args.plan]
 * @param {Array<object>} [args.journeys] - delivery journeys ({ id, title, narrative, ... })
 * @param {string} args.devUrl - the deployed dev URL (fully-qualified preferred)
 * @param {string} args.sha - the frozen commit the app was deployed at
 * @param {'auto'|'headless'|'extension'} [args.mode='auto']
 * @param {(cmd: string, cwd: string, timeoutMs: number) => Promise<{code:number,stderr?:string}>} [args.s3]
 * @param {(level: string, msg: string) => void} [args.log]
 * @param {NodeJS.ProcessEnv} [args.env=process.env]
 * @param {string} [args.screenshotBucket] - DEV-ENV bucket (default env.QA_SCREENSHOT_BUCKET)
 * @param {string} [args.screenshotBase] - public base URL (default env.QA_SCREENSHOT_BASE || dev.futurator.ai)
 * @param {typeof fetch} [args.fetchImpl] - injectable fetch (tests)
 * @param {Function} [args.runAgentLoop] - injectable loop (tests)
 * @param {() => object} [args.createExecutor] - injectable executor factory (tests)
 * @param {object} [args.client] - injectable Anthropic client (tests)
 * @returns {Promise<AgenticReport>}
 */
export async function runAgenticVqa({
  plan = {},
  journeys,
  devUrl,
  sha,
  mode = 'auto',
  s3,
  log = () => {},
  env = process.env,
  screenshotBucket,
  screenshotBase,
  fetchImpl = globalThis.fetch,
  runAgentLoop = defaultRunAgentLoop,
  createExecutor,
  client,
} = {}) {
  const vlog = (level, msg) => {
    try {
      log(level, msg);
    } catch {
      /* best-effort */
    }
  };

  const model = env.AGENTIC_VQA_MODEL || DEFAULT_MODEL;
  const requestedMode = mode || 'auto';

  // API-KEY ISOLATION: BROWSER_AGENT_API_KEY only. Never ANTHROPIC_API_KEY.
  const apiKey = env.BROWSER_AGENT_API_KEY;
  if (!apiKey) {
    vlog('info', '[agentic-vqa] BROWSER_AGENT_API_KEY not set — skipping agentic VQA lane (no-api-key).');
    return { mode: requestedMode === 'auto' ? 'headless' : requestedMode, model, skippedReason: 'no-api-key', runs: [] };
  }

  const list = Array.isArray(journeys) ? journeys : [];
  const cap = toPosInt(env.AGENTIC_VQA_MAX_JOURNEYS, DEFAULT_MAX_JOURNEYS);
  const maxSteps = toPosInt(env.AGENTIC_VQA_MAX_STEPS, DEFAULT_MAX_STEPS);
  const selected = list.slice(0, cap);

  const baseUrl = String(env.BROWSER_AGENT_URL || DEFAULT_BROWSER_AGENT_URL).replace(/\/+$/, '');
  const baseURL = env.BROWSER_AGENT_BASE_URL || undefined; // SDK base (optional custom gateway)
  const bucket = screenshotBucket ?? env.QA_SCREENSHOT_BUCKET;
  const base = screenshotBase ?? env.QA_SCREENSHOT_BASE ?? DEFAULT_SCREENSHOT_BASE;
  const planId = plan?.planId ?? '';
  const url = ensureUrl(devUrl);
  const cwd = env.QA_SCREENSHOT_CWD || undefined;

  // Resolve the effective backend.
  let effectiveMode;
  if (requestedMode === 'headless') {
    effectiveMode = 'headless';
  } else if (requestedMode === 'extension') {
    effectiveMode = 'extension';
  } else {
    const ext = await probeExtension({ baseUrl, fetchImpl, log });
    effectiveMode = ext ? 'extension' : 'headless';
  }
  vlog('info', `[agentic-vqa] mode=${effectiveMode} model=${model} journeys=${selected.length}/${list.length}`);

  const runs = [];
  for (let idx = 0; idx < selected.length; idx += 1) {
    const journey = selected[idx];
    const journeyId = journey?.id || `journey-${idx + 1}`;
    const instruction = buildInstruction(journey);
    const keyPrefix = `_qa/${planId}/${sha}/agentic/${sanitizeKey(journeyId)}`;
    try {
      const run =
        effectiveMode === 'extension'
          ? await runExtensionJourney({
              journey,
              journeyId,
              instruction,
              url,
              baseUrl,
              fetchImpl,
              s3,
              cwd,
              bucket,
              base,
              keyPrefix,
              log,
            })
          : await runEmbeddedJourney({
              journey,
              journeyId,
              instruction,
              url,
              model,
              apiKey,
              baseURL,
              maxSteps,
              s3,
              cwd,
              bucket,
              base,
              keyPrefix,
              log,
              runAgentLoop,
              createExecutor,
              client,
            });
      runs.push(run);
    } catch (err) {
      const msg = err?.message || String(err);
      vlog('warn', `[agentic-vqa] journey ${journeyId} errored — recording uncertain (non-blocking): ${msg}`);
      runs.push({
        journeyId,
        instruction,
        verdict: 'uncertain',
        findings: [{ severity: 'attention', note: `agentic run error: ${msg}` }],
        frameUrls: [],
        steps: 0,
        durationMs: 0,
        error: msg,
      });
    }
  }

  return { mode: effectiveMode, model, runs };
}

export default runAgenticVqa;
