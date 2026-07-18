// loop.mjs — Anthropic computer-use agent loop that drives a browser executor.
//
// VENDORED from the operator's BrowserAgent project:
//   ~/GetReal/elevenLabsConcepts/BrowserAgent/server/agent/loop.js
//
// Futurator adaptations (express/session coupling removed so this runs inside the
// daemon as a library):
//   - Events are delivered via an injected `emit(type, data)` callback instead of
//     `session.emitter.emit`. The wrapping try/catch is preserved.
//   - Screenshots are handed to an injected `saveFrame(stepIndex, base64Png)`
//     callback instead of being written to a hardcoded `runs/<sessionId>/` dir
//     (the runner uploads them to S3). No `fs`/`path`/`RUNS_DIR` dependency.
//   - `mode` is passed directly (was `session.mode`); an optional `client` can be
//     injected (tests pass a fake SDK client) — otherwise a real Anthropic client
//     is constructed from `apiKey`/`baseURL`.
// Everything else — the computer-use tool spec (`computer_20251124`, beta
// `computer-use-2025-11-24`), the 3-most-recent-images pruning, the transient
// retry/backoff logic, and the executor interface — is kept EXACTLY as upstream.

import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt } from './prompts.mjs';

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 800;
const MAX_TOKENS = 4096;
const MAX_API_RETRIES = 3;
const KEEP_RECENT_IMAGES = 3;

/**
 * Sleep for `ms` milliseconds, rejecting early if the abort signal fires.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Decide whether an API error is transient and worth retrying.
 */
function isRetryable(err) {
  if (!err) return false;
  if (Anthropic.APIConnectionError && err instanceof Anthropic.APIConnectionError) return true;
  if (Anthropic.APIConnectionTimeoutError && err instanceof Anthropic.APIConnectionTimeoutError) return true;
  const status = typeof err.status === 'number' ? err.status : undefined;
  if (status === 429) return true;
  if (typeof status === 'number' && status >= 500 && status < 600) return true;
  // Network-level errors from the underlying fetch have no HTTP status.
  if (status === undefined && (err.code || err.name === 'FetchError' || err.name === 'TypeError')) {
    return true;
  }
  return false;
}

/**
 * True when an error represents a user-triggered abort of the in-flight request.
 */
function isAbortError(err, signal) {
  if (signal?.aborted) return true;
  if (!err) return false;
  if (Anthropic.APIUserAbortError && err instanceof Anthropic.APIUserAbortError) return true;
  return err.name === 'AbortError' || err.message === 'aborted';
}

/**
 * Bound context growth: keep only the most recent image blocks, replacing older
 * ones (in plain user content or inside tool_result blocks) with a text stub.
 */
function pruneHistoryImages(messages) {
  const imageBlocks = [];
  for (const msg of messages) {
    if (!Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block) continue;
      if (block.type === 'image') {
        imageBlocks.push(block);
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content) {
          if (inner && inner.type === 'image') imageBlocks.push(inner);
        }
      }
    }
  }
  const pruneCount = Math.max(0, imageBlocks.length - KEEP_RECENT_IMAGES);
  for (let i = 0; i < pruneCount; i += 1) {
    const block = imageBlocks[i];
    delete block.source;
    block.type = 'text';
    block.text = '[screenshot omitted to save context]';
  }
}

// Decode a PNG's pixel dimensions from its IHDR chunk (bytes 16..24).
function pngDims(buf) {
  if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  return null;
}

/**
 * Run the computer-use agent loop until the model stops requesting tools, the
 * step budget is exhausted, the signal aborts, or an error occurs. Never throws
 * to the caller (catches internally, emits 'error').
 *
 * @param {object} opts
 * @param {(type: string, data: any) => void} opts.emit - event sink (thought|action|screenshot|done|error|status)
 * @param {(stepIndex: number, base64Png: string) => (void|Promise<void>)} opts.saveFrame - persistence sink for screenshots
 * @param {{execute: Function, screenshot: Function, stop: Function, getViewport?: Function}} opts.executor
 * @param {string} opts.instruction
 * @param {string} opts.url
 * @param {string} opts.model
 * @param {string} [opts.apiKey]
 * @param {string} [opts.baseURL]
 * @param {string} [opts.mode] - "headless" | "headed" | "extension" (steers the system prompt)
 * @param {object} [opts.client] - pre-built Anthropic-compatible client (tests inject a fake); else constructed from apiKey/baseURL
 * @param {number} [opts.maxSteps=40]
 * @param {AbortSignal} [opts.signal]
 */
export async function runAgentLoop({
  emit: emitRaw,
  saveFrame,
  executor,
  instruction,
  url,
  model,
  apiKey,
  baseURL,
  mode = 'headless',
  client: injectedClient,
  maxSteps = 40,
  signal,
}) {
  const emit = (type, data) => {
    try {
      emitRaw?.(type, data);
    } catch (err) {
      console.error('[agent] failed to emit event', type, err);
    }
  };

  const client = injectedClient || new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
  // Display dimensions the model reasons in. Default 1280x800, but overridden
  // below from the executor's REAL viewport so the model's coordinates match
  // the actual page (critical in extension mode: the user's window can be any
  // size, and clicks must map 1:1 to real CSS pixels).
  let displayW = VIEWPORT_WIDTH;
  let displayH = VIEWPORT_HEIGHT;
  let system = buildSystemPrompt({ instruction, url, mode, width: displayW, height: displayH });

  let screenshotSeq = 0;

  // Hand a base64 PNG to the injected persistence sink and announce it via a
  // screenshot event.
  async function saveScreenshot(base64Png) {
    screenshotSeq += 1;
    const step = screenshotSeq;
    try {
      const buf = Buffer.from(base64Png, 'base64');
      const d = pngDims(buf);
      // Warn only if image dims drift from the display dims (would break clicks).
      if (d && (d.w !== displayW || d.h !== displayH)) {
        console.warn('[agent] screenshot', step, `${d.w}x${d.h}px MISMATCH vs ${displayW}x${displayH} — clicks may miss`);
      }
      await saveFrame?.(step, base64Png);
    } catch (err) {
      console.error('[agent] failed to save screenshot', err);
    }
    emit('screenshot', { step });
    return step;
  }

  // Call the Messages API with abort support and transient-error retries.
  async function createMessage(messages) {
    const params = {
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages,
      tools: [
        {
          type: 'computer_20251124',
          name: 'computer',
          display_width_px: displayW,
          display_height_px: displayH,
        },
      ],
      betas: ['computer-use-2025-11-24'],
    };

    let lastErr;
    for (let attempt = 0; attempt < MAX_API_RETRIES; attempt += 1) {
      if (signal?.aborted) throw new Error('aborted');
      try {
        return await client.beta.messages.create(params, { signal });
      } catch (err) {
        if (isAbortError(err, signal)) throw err;
        lastErr = err;
        if (!isRetryable(err) || attempt === MAX_API_RETRIES - 1) throw err;
        const delayMs = Math.min(1000 * 2 ** attempt, 8000);
        console.error(
          `[agent] transient API error (attempt ${attempt + 1}/${MAX_API_RETRIES}), retrying in ${delayMs}ms:`,
          err?.message || err,
        );
        emit('status', { status: 'retrying', message: `Transient API error, retrying (attempt ${attempt + 1}).` });
        await sleep(delayMs, signal);
      }
    }
    throw lastErr;
  }

  const messages = [];
  let steps = 0;
  let finalText = '';

  try {
    emit('status', { status: 'running', message: 'Agent started.' });

    if (signal?.aborted) {
      emit('status', { status: 'stopped', message: 'Run stopped by user.' });
      return;
    }

    // Resolve the executor's real viewport so the model reasons in the actual
    // page's coordinate space. Extension mode = the user's real window (any
    // size); Playwright mode reports a fixed 1280x800. Falls back to 1280x800.
    try {
      const vp = await executor.getViewport?.();
      if (vp && Number.isFinite(vp.width) && Number.isFinite(vp.height) && vp.width > 0 && vp.height > 0) {
        displayW = Math.round(vp.width);
        displayH = Math.round(vp.height);
        system = buildSystemPrompt({ instruction, url, mode, width: displayW, height: displayH });
      }
    } catch (e) {
      /* keep 1280x800 default */
    }
    console.log('[agent] display', `${displayW}x${displayH}`, 'mode=' + mode);

    // Capture the initial state of the already-navigated page.
    const initialShot = await executor.screenshot();
    if (!initialShot) throw new Error('Executor returned an empty initial screenshot.');
    await saveScreenshot(initialShot);

    messages.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text:
            `Task: ${instruction}\n` +
            `The browser is already open at: ${url}\n` +
            `The current screenshot of the page is attached. Begin working on the task now.`,
        },
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: initialShot },
        },
      ],
    });

    while (steps < maxSteps) {
      if (signal?.aborted) {
        emit('status', { status: 'stopped', message: 'Run stopped by user.' });
        return;
      }

      pruneHistoryImages(messages);

      const response = await createMessage(messages);

      if (signal?.aborted) {
        emit('status', { status: 'stopped', message: 'Run stopped by user.' });
        return;
      }

      const assistantContent = Array.isArray(response.content) ? response.content : [];
      messages.push({ role: 'assistant', content: assistantContent });

      const textPieces = [];
      const toolResults = [];

      for (const block of assistantContent) {
        if (!block) continue;
        if (block.type === 'text') {
          if (block.text) {
            textPieces.push(block.text);
            emit('thought', { text: block.text });
          }
        } else if (block.type === 'tool_use') {
          const input = block.input || {};
          emit('action', { action: input });

          let result;
          try {
            result = await executor.execute(input);
          } catch (err) {
            result = { ok: false, error: `Executor threw: ${err?.message || String(err)}` };
          }
          // Log only failed actions (useful when a QA run goes wrong).
          if (!(result && result.ok)) {
            console.warn('[agent] action FAILED', JSON.stringify(input), '->', result && result.error);
          }

          if (result && result.ok) {
            if (result.base64Png) {
              await saveScreenshot(result.base64Png);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content: [
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: 'image/png', data: result.base64Png },
                  },
                ],
              });
            } else {
              toolResults.push({
                type: 'tool_result',
                tool_use_id: block.id,
                content:
                  typeof result.text === 'string' && result.text
                    ? result.text
                    : 'Action completed successfully.',
              });
            }
          } else {
            const errText = (result && result.error) || 'Action failed.';
            toolResults.push({
              type: 'tool_result',
              tool_use_id: block.id,
              content: errText,
              is_error: true,
            });
          }
        }
      }

      if (textPieces.length) finalText = textPieces.join('\n\n');
      steps += 1;

      // Finished: the model stopped requesting tools (or requested none).
      if (response.stop_reason !== 'tool_use' || toolResults.length === 0) {
        emit('done', { text: finalText, steps });
        return;
      }

      messages.push({ role: 'user', content: toolResults });
    }

    // Step budget exhausted without a natural stop.
    emit('status', { status: 'max_steps_reached', message: `Reached the step limit (${maxSteps}).` });
    emit('done', { text: finalText || `Stopped after reaching the ${maxSteps}-step limit.`, steps });
  } catch (err) {
    if (isAbortError(err, signal)) {
      emit('status', { status: 'stopped', message: 'Run stopped by user.' });
    } else {
      console.error('[agent] run failed', err);
      emit('error', { message: err?.message || String(err) });
    }
  } finally {
    // Playwright executors close the browser; the extension executor's stop()
    // detaches the debugger instead of closing the user's tab.
    try {
      await executor.stop();
    } catch (err) {
      console.error('[agent] executor.stop() failed', err);
    }
  }
}

export default runAgentLoop;
