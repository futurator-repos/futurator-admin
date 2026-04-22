/**
 * Party Turn Pipeline — runs one user→agent turn in an existing party session.
 *
 * Contract (tech-spec §"Party Turn Execution"):
 *   - Input: { sessionId, content } via job.partyTurnPayload
 *   - Precondition: session already PROCESSING (API layer acquired the lock)
 *   - Turn 1 (turnCount=0 and no claudeSessionId): prompt is
 *       "/bmad:core:workflows:party-mode\n\n<user content>"
 *     and Claude generates a fresh session. The `system.init` stream event
 *     exposes its `session_id`, which we persist as `claudeSessionId`.
 *   - Turn N (N≥2): prompt is just <user content>, and we pass
 *     `--resume <claudeSessionId>` so Claude restores prior context.
 *   - On normal exit: release lock to ACTIVE, increment turnCount.
 *   - On timeout (180s): SIGTERM then SIGKILL, release lock to ERROR.
 *   - On non-zero exit: release lock to ERROR.
 *   - All events are keyed by sessionId (not the turn job's jobId) so the UI
 *     gets one continuous event stream per session across N turns.
 */

import { spawn as realSpawn } from 'node:child_process';
import { registerChild, unregisterChild } from './lib/child-tracker.mjs';

const DEFAULT_TIMEOUT_MS = 180_000;
const KILL_GRACE_MS = 5_000;
// BMAD 6.3.x invokes party-mode as a Claude Code skill (`/bmad-party-mode`).
// The older `/bmad:core:workflows:party-mode` slash-command is a workflow
// path and no longer exists post-6.3.x.
const PARTY_MODE_PREFIX = '/bmad-party-mode';

/**
 * @param {object} job        — agent-jobs row with partyTurnPayload
 * @param {object} ctx
 * @param {Function} ctx.pushEvent        — daemon's pushEvent(jobId, stepId, agentId, eventType, data)
 * @param {Function} ctx.getSession       — async (sessionId) → session row
 * @param {Function} ctx.setClaudeSessionId — async (sessionId, claudeSessionId)
 * @param {Function} ctx.incrementTurn    — async (sessionId)
 * @param {Function} ctx.releaseSessionLock — async (sessionId, finalStatus)
 * @param {string} ctx.claudeBin          — path to the `claude` binary
 * @param {typeof realSpawn} [ctx.spawn]  — injected for tests
 * @param {number} [ctx.timeoutMs]        — override default 180s
 * @param {() => number} [ctx.now]        — time source for tests
 */
export async function runPartyTurn(job, ctx) {
  const payload = job.partyTurnPayload || {};
  const { sessionId, content } = payload;
  if (!sessionId || typeof content !== 'string' || content.length === 0) {
    throw new Error('runPartyTurn: payload.sessionId and payload.content are required');
  }

  const {
    pushEvent,
    getSession,
    setClaudeSessionId,
    incrementTurn,
    releaseSessionLock,
    claudeBin = 'claude',
    spawn = realSpawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    env = {},
    logger = console,
  } = ctx;

  const session = await getSession(sessionId);
  if (!session) {
    throw new Error(`runPartyTurn: session ${sessionId} not found`);
  }

  // Emit user turn event immediately so the UI renders the user message even
  // before Claude has produced a token.
  await pushEvent(sessionId, 'turn', '__party__', 'party.turn.user', {
    sessionId,
    turnCount: session.turnCount,
    content,
  });

  const isFirstTurn = !session.claudeSessionId;
  // Single-line `/slash-command <args>` form. Claude Code's slash-command
  // parser in -p mode treats the FIRST line as the command + its arguments;
  // a blank line between `/bmad-party-mode` and the user content was causing
  // Claude to see them as two separate messages and hallucinate "I don't
  // have that skill" (even though the skill is registered).
  const prompt = isFirstTurn ? `${PARTY_MODE_PREFIX} ${content}` : content;
  const args = [
    '--print',
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
  ];
  if (!isFirstTurn) {
    args.push('--resume', session.claudeSessionId);
  }

  logger.info?.(
    `[party-turn] spawning session=${sessionId.slice(0, 8)} firstTurn=${isFirstTurn} ` +
      `cwd=${session.projectPath}`,
  );

  const child = spawn(claudeBin, args, {
    cwd: session.projectPath,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  registerChild(job.jobId, child);

  try {
    child.stdin?.write?.(prompt);
    child.stdin?.end?.();
  } catch {
    // fall through — child.on('error') and close path handles
  }

  let stdoutBuf = '';
  let stderrBuf = '';
  let capturedClaudeSessionId = null;
  let timedOut = false;
  let killTimer = null;

  const watchdog = setTimeout(() => {
    timedOut = true;
    try {
      child.kill('SIGTERM');
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          // best effort
        }
      }, KILL_GRACE_MS);
    } catch {
      // best effort
    }
  }, timeoutMs);

  child.stdout?.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue;
      void handleStreamLine(line);
    }
  });

  child.stderr?.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });

  async function handleStreamLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Non-JSON line — keep a note for debugging but do not blow up the turn.
      logger.warn?.(`[party-turn] non-JSON line: ${line.slice(0, 120)}`);
      return;
    }
    const type = parsed?.type;
    if (type === 'system' && parsed?.subtype === 'init' && parsed?.session_id) {
      if (!capturedClaudeSessionId) {
        capturedClaudeSessionId = parsed.session_id;
        try {
          await setClaudeSessionId(sessionId, capturedClaudeSessionId);
        } catch (err) {
          logger.warn?.(
            `[party-turn] setClaudeSessionId failed (may already be set): ${err.message}`,
          );
        }
      }
      return;
    }
    if (type === 'assistant') {
      // Extract the text chunk(s) from the message.content array. Each entry
      // may be a text block or a tool_use marker — we only forward text here.
      const blocks = parsed?.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.token', {
            sessionId,
            text: block.text,
          });
        } else if (block?.type === 'tool_use') {
          await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.token', {
            sessionId,
            toolUse: { name: block.name, id: block.id },
          });
        }
      }
      return;
    }
    if (type === 'result') {
      // Final result payload — emitted as completion by the close handler.
      return;
    }
    // Unknown type — forward a generic passthrough for forward-compat.
    await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.token', {
      sessionId,
      raw: parsed,
    });
  }

  const exitCode = await new Promise((resolvePromise) => {
    child.on('error', (err) => {
      unregisterChild(job.jobId, child);
      logger.error?.(`[party-turn] spawn error: ${err.message}`);
      resolvePromise(-1);
    });
    child.on('close', (code) => {
      unregisterChild(job.jobId, child);
      resolvePromise(code ?? 0);
    });
  });

  clearTimeout(watchdog);
  if (killTimer) clearTimeout(killTimer);

  if (timedOut) {
    await pushEvent(sessionId, 'turn', '__party__', 'party.turn.error', {
      sessionId,
      reason: 'TIMEOUT',
      timeoutMs,
      stderr: stderrBuf.slice(0, 4000),
    });
    await releaseSessionLock(sessionId, 'ERROR');
    throw new Error(`party-turn timeout after ${timeoutMs}ms`);
  }

  if (exitCode !== 0) {
    await pushEvent(sessionId, 'turn', '__party__', 'party.turn.error', {
      sessionId,
      reason: 'NON_ZERO_EXIT',
      exitCode,
      stderr: stderrBuf.slice(0, 4000),
    });
    await releaseSessionLock(sessionId, 'ERROR');
    throw new Error(`party-turn exited with code ${exitCode}`);
  }

  await incrementTurn(sessionId);
  await releaseSessionLock(sessionId, 'ACTIVE');
  await pushEvent(sessionId, 'turn', '__party__', 'party.turn.completed', {
    sessionId,
    claudeSessionId: capturedClaudeSessionId,
    exitCode,
  });

  return { ok: true, claudeSessionId: capturedClaudeSessionId };
}

export const PARTY_TURN_CONSTANTS = {
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
  PARTY_MODE_PREFIX,
};
