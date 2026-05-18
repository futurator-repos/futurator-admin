/**
 * free-agent-session.mjs — Story 18.2 (Epic 18: Free Claude Code Agent)
 *
 * Daemon-side handler for a single free-agent turn. Modeled on party-turn.mjs
 * (the closest analog: claude -p with stream-json + --resume on follow-ups).
 *
 * Per-turn flow:
 *   1. Acquire the processing lock (ACTIVE → PROCESSING via repository).
 *   2. Ensure the per-session worktree exists (Story 18.1 ensureWorktree).
 *   3. Write the per-session .claude/settings.json with the PreToolUse hook
 *      reference (Story 18.1 writeFreeAgentSettings).
 *   4. Spawn `claude -p <prompt>` with:
 *        --model <model>
 *        --max-budget-usd <costCapUsd>
 *        --output-format stream-json --verbose
 *        --permission-mode bypassPermissions
 *          (PreToolUse path-confinement hook + the least-privilege IAM role
 *          on the subprocess are the load-bearing security boundaries.
 *          `acceptEdits` only auto-approves edits; Bash still prompts and
 *          `-p` has no stdin, so AWS CLI calls hung indefinitely until the
 *          agent gave up. Same posture as epic-dev-pipeline.mjs:260.)
 *        --session-id <sessionId>           (first turn only)
 *        --resume <claudeSessionId>         (follow-up turns only)
 *        --add-dir <worktreePath>
 *        cwd: worktreePath
 *        env: AWS_ACCESS_KEY_ID/SECRET/SESSION_TOKEN (from session credentials)
 *             FREE_AGENT_CONFINEMENT_ROOT=<worktreePath> (for the PreToolUse hook)
 *   5. Parse stream-json output line-by-line:
 *        type=system,subtype=init → capture session_id → setClaudeSessionId
 *        type=assistant → emit free-agent.turn.token / .tool_use
 *        type=result    → final cost + is_error signal; close handler decides
 *   6. Watchdog at 600s: SIGTERM, then SIGKILL after 5s grace.
 *   7. On close:
 *        normal → incrementTurn + updateCostUsd + releaseProcessingLock('ACTIVE')
 *        cost-cap exit → markBudgetExhausted + emit free-agent.budget.exhausted
 *        non-zero exit → markError + releaseProcessingLock('ERROR')
 *        timeout → markError('TIMEOUT')
 *
 * Per Story 18.1 architectural notes: process.env CANNOT be patched on a
 * running subprocess. Credential refresh is the API Lambda's job — done
 * BEFORE enqueueing the next turn (NOT during this turn).
 */

import { spawn as realSpawn } from 'node:child_process';
import {
  existsSync as fsExistsSync,
  mkdirSync as fsMkdirSync,
  writeFileSync as fsWriteFileSync,
} from 'node:fs';
import { join as pathJoin } from 'node:path';

const DEFAULT_TIMEOUT_MS = Number(process.env.FREE_AGENT_TURN_TIMEOUT_MS) || 600_000;
const KILL_GRACE_MS = 5_000;

// Matchers for cost-cap exit detection. The exact signal from `--max-budget-usd`
// is undocumented in the CLI help; this matcher checks the most likely shapes
// observed in Anthropic SDK budget errors. Refine on real EC2 dev observation.
const BUDGET_EXHAUSTED_PATTERNS = [
  /budget.*exhausted/i,
  /max.*budget/i,
  /cost.*cap/i,
  /max_budget_usd/i,
];

/**
 * @param {object} job — agent-jobs row with freeAgentSessionPayload
 * @param {object} ctx
 * @param {Function} ctx.pushEvent             — pushEvent(jobIdOrSessionId, stepId, agentId, eventType, data)
 * @param {object}   ctx.sessionsRepo          — free-agent-sessions-repository functions
 * @param {object}   [ctx.worktreeHelpers]     — { ensureWorktree, writeFreeAgentSettings }
 * @param {string}   [ctx.claudeBin]           — default 'claude'
 * @param {typeof realSpawn} [ctx.spawn]       — injectable for tests
 * @param {number}   [ctx.timeoutMs]
 * @param {() => number} [ctx.now]
 * @param {object}   [ctx.logger]              — console-like
 */
export async function runFreeAgentSession(job, ctx) {
  const payload = job?.freeAgentSessionPayload || {};
  const { sessionId, projectId, model, costCapUsd, credentials, messages } = payload;

  if (!sessionId || !projectId || !model || !credentials || !Array.isArray(messages)) {
    throw new Error(
      'runFreeAgentSession: payload requires sessionId, projectId, model, credentials, messages',
    );
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUserMessage || typeof lastUserMessage.content !== 'string') {
    throw new Error('runFreeAgentSession: payload.messages must contain a user message');
  }

  const {
    pushEvent,
    sessionsRepo,
    worktreeHelpers,
    claudeBin = 'claude',
    spawn = realSpawn,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    logger = console,
  } = ctx;

  if (!sessionsRepo) throw new Error('runFreeAgentSession: ctx.sessionsRepo required');
  if (!pushEvent) throw new Error('runFreeAgentSession: ctx.pushEvent required');

  // ── 1. Lock ──
  // The API Lambda's POST /messages route pre-acquires the processing lock
  // (ACTIVE → PROCESSING) before enqueueing this job. The session is therefore
  // already in PROCESSING when we run. Re-acquiring here would fail with
  // SESSION_BUSY against a lock we ourselves are working under. The release
  // path (`releaseProcessingLock`) at the end of the turn unwinds the lock the
  // API set. If a future entry point (e.g., a direct daemon invocation) needs
  // to acquire the lock itself, it must do so before calling this handler.

  // ── 2. Ensure worktree + 3. settings + AGENT.md ──
  let worktreeInfo;
  try {
    const wt = worktreeHelpers || (await import('./lib/free-agent-worktree.mjs'));
    worktreeInfo = await wt.ensureWorktree({ projectId, sessionId });
    wt.writeFreeAgentSettings({
      worktreePath: worktreeInfo.worktreePath,
      projectId,
      sessionId,
    });
    // Refresh AGENT.md every turn so it always reflects the current scope /
    // sessionId / timestamp. Cheap (~3KB write) and lets resumed sessions
    // pick up template updates without a fresh worktree.
    if (typeof wt.writeAgentMd === 'function') {
      try {
        wt.writeAgentMd({
          worktreePath: worktreeInfo.worktreePath,
          projectId,
          sessionId,
          scope: payload.scope || { kind: 'workspace' },
          planId: payload.scope?.kind === 'plan' ? payload.scope?.id : undefined,
          operatorId: payload.operatorId,
        });
      } catch (mdErr) {
        // AGENT.md is helpful-but-not-load-bearing — log and continue. We don't
        // want a markdown-write failure to take the whole turn down.
        logger.warn?.(`[free-agent-session] writeAgentMd failed: ${mdErr.message}`);
      }
    }
  } catch (err) {
    await sessionsRepo.markError(sessionId, `WORKTREE_FAILURE: ${err.message}`);
    await sessionsRepo.releaseProcessingLock(sessionId, 'ERROR');
    throw err;
  }

  // ── 4. Build spawn args ──
  const session = await sessionsRepo.getSession(sessionId);
  const isFirstTurn = !session?.claudeSessionId;

  // Cmd+Shift+4 attachments: the API forwards images in the payload as
  // {mediaType, base64}. We decode each to <worktree>/.agent-attachments/
  // (gitignored by convention since the worktree is single-use), then
  // prepend a directive to the prompt so the agent knows to Read them.
  // Same security boundary as everything else — the PreToolUse hook keeps
  // file ops inside the worktree, and the agent's Read tool natively
  // supports image files (PNG/JPEG/WebP/GIF).
  const attachmentPaths = writeAttachments({
    worktreePath: worktreeInfo.worktreePath,
    images: lastUserMessage.images || [],
    logger,
  });

  // System-prompt nudge points the agent at AGENT.md (which the daemon wrote
  // above with the per-session operator context, tool surface, and DDB schema
  // hints). Without this, the agent defaults to generic Claude Code instincts
  // — tries `gh`, doesn't know it has AWS DDB read, treats plan questions as
  // git-branch lookups (2026-05-18 first-light observation).
  const systemPromptNudge =
    'You are the Futurator Free Agent. **Your first action must be to read AGENT.md at the root of your current working directory** — it documents your AWS tool surface, available DynamoDB tables, the current project/plan/session scope, and which questions you can answer directly via `aws` CLI vs which would need the operator. Then respond to the operator concisely with file:line citations where applicable.';

  const attachmentDirective =
    attachmentPaths.length > 0
      ? `[The operator pasted ${attachmentPaths.length} image${attachmentPaths.length === 1 ? '' : 's'}. Read ${attachmentPaths.length === 1 ? 'it' : 'each'} with the Read tool before answering:\n${attachmentPaths.map((p) => `  - ${p}`).join('\n')}\n]\n\n`
      : '';

  const args = [
    '--print',
    attachmentDirective + lastUserMessage.content,
    '--model',
    model,
    '--max-budget-usd',
    String(costCapUsd),
    '--output-format',
    'stream-json',
    '--verbose',
    '--permission-mode',
    'bypassPermissions',
    '--add-dir',
    worktreeInfo.worktreePath,
    '--append-system-prompt',
    systemPromptNudge,
  ];

  if (isFirstTurn) {
    args.push('--session-id', sessionId);
  } else {
    args.push('--resume', session.claudeSessionId);
  }

  const env = {
    ...process.env,
    AWS_ACCESS_KEY_ID: credentials.accessKeyId,
    AWS_SECRET_ACCESS_KEY: credentials.secretAccessKey,
    AWS_SESSION_TOKEN: credentials.sessionToken,
    FREE_AGENT_CONFINEMENT_ROOT: worktreeInfo.worktreePath,
    // Story 18.3 — the prepare-commit-msg hook reads this to build the
    // `Agent: FREE-AGENT-<sessionId>` trailer.
    FREE_AGENT_SESSION_ID: sessionId,
  };

  logger.info?.(
    `[free-agent-session] spawn session=${sessionId.slice(0, 8)} firstTurn=${isFirstTurn} model=${model} cap=${costCapUsd}`,
  );

  await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.turn.start', {
    sessionId,
    turnCount: session?.turnCount ?? 0,
    isFirstTurn,
    model,
  });

  // ── 5. Spawn + watchdog + stream parse ──
  const child = spawn(claudeBin, args, {
    cwd: worktreeInfo.worktreePath,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
          /* best effort */
        }
      }, KILL_GRACE_MS);
    } catch {
      /* best effort */
    }
  }, timeoutMs);

  let stdoutBuf = '';
  let stderrBuf = '';
  let capturedClaudeSessionId = null;
  let lastResultEvent = null;
  let totalCostUsd = 0;
  // Story 18.3 — token accumulation per turn (input includes cache reads/writes).
  let totalTokensIn = 0;
  let totalTokensOut = 0;

  child.stdout?.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      if (line.length === 0) continue;
      void handleLine(line);
    }
  });

  child.stderr?.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
  });

  async function handleLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      logger.warn?.(`[free-agent-session] non-JSON stdout line: ${line.slice(0, 120)}`);
      return;
    }
    const type = parsed?.type;

    if (type === 'system' && parsed?.subtype === 'init' && parsed?.session_id) {
      if (!capturedClaudeSessionId) {
        capturedClaudeSessionId = parsed.session_id;
        try {
          await sessionsRepo.setClaudeSessionId(sessionId, capturedClaudeSessionId);
        } catch (err) {
          logger.warn?.(
            `[free-agent-session] setClaudeSessionId failed (may already be set): ${err.message}`,
          );
        }
      }
      return;
    }

    if (type === 'assistant') {
      const blocks = parsed?.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.turn.token', {
            sessionId,
            text: block.text,
          });
        } else if (block?.type === 'tool_use') {
          await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.turn.tool_use', {
            sessionId,
            tool: {
              id: block.id,
              name: block.name,
              input: truncateToolInput(block.input),
            },
          });
        }
      }
      return;
    }

    if (type === 'result') {
      lastResultEvent = parsed;
      if (typeof parsed.total_cost_usd === 'number') {
        totalCostUsd = parsed.total_cost_usd;
      } else if (typeof parsed?.usage?.total_cost_usd === 'number') {
        totalCostUsd = parsed.usage.total_cost_usd;
      }
      // Story 18.3 — extract token counts from the result.usage block.
      // input-equivalent = sum of new-input + cache-creation + cache-read.
      const usage = parsed?.usage || {};
      const inputTokens = Number(usage.input_tokens) || 0;
      const cacheCreation = Number(usage.cache_creation_input_tokens) || 0;
      const cacheRead = Number(usage.cache_read_input_tokens) || 0;
      const outputTokens = Number(usage.output_tokens) || 0;
      totalTokensIn = inputTokens + cacheCreation + cacheRead;
      totalTokensOut = outputTokens;
      return;
    }
  }

  // ── 6. Wait for close ──
  const exitCode = await new Promise((resolvePromise) => {
    child.on('error', (err) => {
      logger.error?.(`[free-agent-session] spawn error: ${err.message}`);
      resolvePromise(-1);
    });
    child.on('close', (code) => resolvePromise(code ?? 0));
  });

  clearTimeout(watchdog);
  if (killTimer) clearTimeout(killTimer);

  // ── 7. Terminal-state branching ──
  if (timedOut) {
    await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.turn.error', {
      sessionId,
      reason: 'TIMEOUT',
      timeoutMs,
      stderr: stderrBuf.slice(0, 4000),
    });
    await sessionsRepo.markError(sessionId, 'TIMEOUT');
    await sessionsRepo.releaseProcessingLock(sessionId, 'ERROR');
    return { ok: false, reason: 'TIMEOUT', claudeSessionId: capturedClaudeSessionId };
  }

  const isCostCapExit =
    exitCode !== 0 && lastResultEvent?.is_error && matchesBudgetSignal(lastResultEvent);
  if (isCostCapExit) {
    if (totalCostUsd > 0) await sessionsRepo.updateCostUsd(sessionId, totalCostUsd);
    await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.budget.exhausted', {
      sessionId,
      costUsdAccumulated: totalCostUsd,
      costCapUsd,
    });
    await sessionsRepo.markBudgetExhausted(sessionId);
    await sessionsRepo.releaseProcessingLock(sessionId, 'BUDGET_EXHAUSTED');
    return { ok: false, reason: 'BUDGET_EXHAUSTED', claudeSessionId: capturedClaudeSessionId };
  }

  if (exitCode !== 0) {
    await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.turn.error', {
      sessionId,
      reason: 'NON_ZERO_EXIT',
      exitCode,
      stderr: stderrBuf.slice(0, 4000),
    });
    await sessionsRepo.markError(sessionId, `NON_ZERO_EXIT:${exitCode}`);
    await sessionsRepo.releaseProcessingLock(sessionId, 'ERROR');
    return { ok: false, reason: 'NON_ZERO_EXIT', exitCode };
  }

  // Normal completion.
  if (totalCostUsd > 0) await sessionsRepo.updateCostUsd(sessionId, totalCostUsd);
  // Story 18.3 — record token accumulation if the repo facade supports it.
  if (
    (totalTokensIn > 0 || totalTokensOut > 0) &&
    typeof sessionsRepo.updateTokens === 'function'
  ) {
    await sessionsRepo.updateTokens(sessionId, totalTokensIn, totalTokensOut);
  }
  await sessionsRepo.incrementTurn(sessionId);
  await sessionsRepo.releaseProcessingLock(sessionId, 'ACTIVE');

  await pushEvent(sessionId, 'turn', '__free-agent__', 'free-agent.turn.complete', {
    sessionId,
    claudeSessionId: capturedClaudeSessionId,
    totalCostUsd,
    exitCode,
  });

  return {
    ok: true,
    claudeSessionId: capturedClaudeSessionId,
    totalCostUsd,
    totalTokensIn,
    totalTokensOut,
  };
}

const ATTACHMENT_DIRNAME = '.agent-attachments';
const MEDIA_TYPE_EXTS = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

/**
 * Decode `{mediaType, base64}` attachments into `<worktree>/.agent-attachments/`.
 * Returns the relative paths (e.g. `./.agent-attachments/0.jpg`) for the prompt.
 * Failures are non-fatal — the agent still gets the user's text, just without
 * the visual context. Logged for debugging.
 */
function writeAttachments({ worktreePath, images, logger, fs }) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const fsImpl = fs || {
    existsSync: fsExistsSync,
    mkdirSync: fsMkdirSync,
    writeFileSync: fsWriteFileSync,
  };
  const dir = pathJoin(worktreePath, ATTACHMENT_DIRNAME);
  try {
    if (!fsImpl.existsSync(dir)) fsImpl.mkdirSync(dir, { recursive: true });
  } catch (err) {
    logger?.warn?.(`[free-agent-session] could not create attachments dir: ${err.message}`);
    return [];
  }

  const written = [];
  for (let i = 0; i < images.length; i += 1) {
    const img = images[i];
    const ext = MEDIA_TYPE_EXTS[img?.mediaType];
    if (!ext || typeof img.base64 !== 'string') {
      logger?.warn?.(`[free-agent-session] skipping attachment ${i}: bad shape`);
      continue;
    }
    const filename = `${i}.${ext}`;
    const fullPath = pathJoin(dir, filename);
    try {
      fsImpl.writeFileSync(fullPath, Buffer.from(img.base64, 'base64'));
      written.push(`./${ATTACHMENT_DIRNAME}/${filename}`);
    } catch (err) {
      logger?.warn?.(`[free-agent-session] failed to write attachment ${i}: ${err.message}`);
    }
  }
  return written;
}

function matchesBudgetSignal(resultEvent) {
  const msg = resultEvent?.error?.message || resultEvent?.result || resultEvent?.message || '';
  if (typeof msg !== 'string') return false;
  return BUDGET_EXHAUSTED_PATTERNS.some((rx) => rx.test(msg));
}

function truncateToolInput(input) {
  if (!input || typeof input !== 'object') return input;
  const MAX_FIELD = 2000;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string' && v.length > MAX_FIELD) {
      out[k] = v.slice(0, MAX_FIELD) + `…[+${v.length - MAX_FIELD}b]`;
    } else if (typeof v === 'object' && v !== null) {
      try {
        const json = JSON.stringify(v);
        out[k] = json.length > MAX_FIELD ? json.slice(0, MAX_FIELD) + '…' : v;
      } catch {
        out[k] = '[unserializable]';
      }
    } else {
      out[k] = v;
    }
  }
  return out;
}

export const FREE_AGENT_SESSION_CONSTANTS = {
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
  BUDGET_EXHAUSTED_PATTERNS,
};
