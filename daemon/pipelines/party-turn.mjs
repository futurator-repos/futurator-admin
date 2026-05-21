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

// 10 min. The party-mode skill spawns BMad Master who explores the project
// (Glob/Read/Bash) before any agent speaks. On large codebases (e.g. BMAD
// itself, our admin app), the exploration alone can run 60-90s before a
// single token of agent text is emitted. 180s was killing turns mid-flight,
// leaving sessions in ERROR with only the orchestrator preamble visible.
// 600s is generous but still bounded — Claude will rarely use the full
// budget; if it does, the request was always going to fail.
const DEFAULT_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 5_000;
// Mirrors functions/shared/types/party.ts DEFAULT_ALLOWED_TOOLS. Kept inline
// because the daemon is a separate node module with its own deps and can't
// import TypeScript directly. If you add a tool here, also add it to the
// TOGGLEABLE_TOOLS list in shared/types/party.ts so the UI can flip it.
const DEFAULT_ALLOWED_TOOLS = ['WebSearch', 'WebFetch'];
// BMAD 6.3.x invokes party-mode as a Claude Code skill (`/bmad-party-mode`).
// The older `/bmad:core:workflows:party-mode` slash-command is a workflow
// path and no longer exists post-6.3.x.
const PARTY_MODE_PREFIX = '/bmad-party-mode';

// Format contract — appended to Claude's system prompt via --append-system-prompt
// so the UI can split a multi-agent response into per-agent cards reliably.
//
// Why open-only Unicode markers (⟪…⟫):
//   • Brackets U+27EA / U+27EB never appear in normal prose, code, or markdown,
//     so collisions with content are essentially impossible.
//   • Open-only (no close marker) keeps the stream small and matches the
//     observed pattern (`**Name:**` style with the next header terminating
//     the previous block). Lower cognitive load on the model = higher
//     compliance rate.
//
// The 23 names below come from the canonical roster (bmad/_cfg/agent-manifest
// .csv after the custom-agents overlay). The parser rejects any other name as
// "this is a section heading, not an agent" — that's how false positives like
// `**My hot take:**` get filtered out.
//
// Backwards compat: the client parser ALWAYS falls back to legacy
// `[emoji ]**Name:**` matching for sessions started before this contract
// shipped. So existing transcripts still render correctly.
// Compact format contract. Long contracts burn context budget and slow Claude
// down measurably; this version trades verbosity for clarity. Roster names
// must match the UI's allow-list — see src/components/labs/party/turn-parser.ts
// `ROSTER_NAMES`. The rest is style: open-only markers, one per line.
const PARTY_FORMAT_CONTRACT = [
  '## Party Mode output format',
  '',
  'Wrap each speaker in a single marker line. No close marker — the next',
  'marker terminates the previous block.',
  '',
  '- `⟪AGENT:Name⟫` — an agent contribution (Name from the roster below).',
  '- `⟪SYSTEM⟫` — your orchestrator notes (routing, summaries, hand-offs).',
  '',
  'Rules:',
  '1. Each marker MUST be preceded by a blank line AND start its own line.',
  '   ALWAYS write `\\n\\n⟪AGENT:Name⟫\\n` — never glue a marker to the end',
  '   of the previous sentence (e.g. `…analysis.⟪AGENT:Winston⟫` is WRONG).',
  '2. No `📋 **John:**` headers, no `---` decoration between agents.',
  '3. No roster table — the UI already shows an avatar rail.',
  '4. Inside blocks: normal GFM markdown (bold, lists, code, tables, etc).',
  '',
  'Roster names (exact spelling, case-sensitive):',
  'BMad Master, BMad Builder, Mary, John, Sally, Winston, Amelia, Paige, Bob,',
  'Murat, Carson, Dr. Quinn, Maya, Victor, Sophia, Ludwig, Pedrock, Dave ups!,',
  'Sean Tinel, Nimbus, Kube Rick, Sue Render, Rick.',
  '',
  'Example:',
  '```',
  '⟪SYSTEM⟫',
  'Bringing in John (PM) and Sally (UX) to debate the scoring system.',
  '',
  '⟪AGENT:John⟫',
  'Why do you want it more competitive? Who are you competing against?',
  '',
  '⟪AGENT:Sally⟫',
  'Two players, same score, totally different play styles — that means',
  'scoring rewards completion, not skill.',
  '',
  '⟪SYSTEM⟫',
  'Strong agreement on a combo multiplier. Want to dig deeper?',
  '```',
  '',
  // ── Story 20.8 (party-push Epic 20) — checkpoint + ASK_HUMAN markers ──
  // The party-marker-extractor (Story 20.1) pulls these out of assistant
  // text post-turn; the agent-commit-composer (Story 19.5) uses them to
  // shape commit titles + bodies. Without explicit teaching here, the
  // orchestrator emits free-form prose and the composer falls back to
  // lenient titles like "N files changed (auto)" — defeating the design.
  '## Saving your work to git',
  '',
  'The system handles all git operations. You do NOT run git commands. Edit and',
  'Write tools auto-approve; git mutation is hard-denied by the hook.',
  '',
  'When a round ends, if you produced files (Edit/Write/MultiEdit), the system',
  "auto-commits to this debate's git branch. To shape the commit's title and",
  'summary — what future readers (humans, other agents) will see in `git log` —',
  'emit ONE block at the end of your final round message:',
  '',
  '    [CHECKPOINT_SUMMARY]: <conventional-commit-style title, ≤100 chars>',
  '    <2-5 line summary describing what was decided and produced, ≤500 chars total>',
  '',
  'Example:',
  '    [CHECKPOINT_SUMMARY]: feat: cohort module architecture v0.1',
  '    Covers profile-maturity scoring, multitenancy model, DynamoDB schema,',
  '    and dashboard wireframes per round. Open: comms channel + facilitator search.',
  '',
  "If you didn't produce files this round, OMIT the block — the system skips",
  'the commit silently.',
  '',
  '## Asking the human for input',
  '',
  'If you need the operator to make a decision before continuing, emit:',
  '',
  '    [ASK_HUMAN]: <one-sentence question>',
  '',
  'and stop tool calls in the same round. The system pauses the debate, surfaces',
  "your question in the UI, and resumes with the operator's reply as the next",
  "turn's input.",
  '',
  'Use sparingly — most rounds should not need this. Genuine clarifications',
  "(\"commit message: 'feat:' or 'chore:'?\") count; rhetorical questions don't.",
].join('\n');

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
    getProject,
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

  // Resolve which extra tools (WebSearch, WebFetch, …) the user has
  // allowed for this project. Default → DEFAULT_ALLOWED_TOOLS so existing
  // projects work without a DDB migration. Empty array → user explicitly
  // disabled all extras (we still pass the flag with no values, which
  // claude treats as "no extra allowlist").
  let allowedTools = [...DEFAULT_ALLOWED_TOOLS];
  if (typeof getProject === 'function' && session.projectId) {
    try {
      const project = await getProject(session.projectId);
      if (project && Array.isArray(project.allowedTools)) {
        allowedTools = project.allowedTools.filter((t) => typeof t === 'string');
      }
    } catch (err) {
      logger.warn?.(`[party-turn] getProject failed (using defaults): ${err.message}`);
    }
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
    // Inject marker-based output contract. See PARTY_FORMAT_CONTRACT above.
    // Appended (not replaced) so BMAD's own party-mode skill prompt still
    // applies. The contract instructs Claude to wrap each agent in
    // `⟪AGENT:Name⟫` markers — the client parser splits on these.
    '--append-system-prompt',
    PARTY_FORMAT_CONTRACT,
  ];
  // Pass the per-project tool allowlist. Without this, WebSearch/WebFetch
  // get auto-denied in `-p` mode (the default permission flow can't
  // surface a prompt) and agents fall back to model knowledge.
  if (allowedTools.length > 0) {
    args.push('--allowedTools', ...allowedTools);
  }
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

  // Signal that the Claude subprocess is live — UI uses this to replace the
  // generic "routing" indicator with a concrete "waiting on first token"
  // message. Happens immediately after spawn() returns, which is well
  // before Claude emits its first stream-json line (5–15 s cold start).
  await pushEvent(sessionId, 'turn', '__party__', 'party.turn.started', {
    sessionId,
    turnCount: session.turnCount,
    isFirstTurn,
  });

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
      // Extract chunks from message.content. Text → assistant.token (renders
      // as orchestrator/agent prose). Tool calls → assistant.tool (renders
      // as a collapsible "Actions" log row). Surfacing tool calls lets the
      // user see what the orchestrator is exploring (Read, Glob, Bash, …)
      // before any agent text arrives — useful both as a progress signal
      // and as a debugging aid when agents reference specific files.
      const blocks = parsed?.message?.content ?? [];
      for (const block of blocks) {
        if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
          await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.token', {
            sessionId,
            text: block.text,
          });
        } else if (block?.type === 'tool_use') {
          await pushEvent(sessionId, 'turn', '__party__', 'party.turn.assistant.tool', {
            sessionId,
            tool: {
              id: block.id,
              name: block.name,
              // Trim oversized inputs so we don't blow the DDB 400 KB item
              // limit when Claude reads a giant file. The full payload only
              // matters for debugging — UI only shows the key params.
              input: truncateToolInput(block.input),
            },
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

/**
 * Tool inputs can carry huge strings (file contents from Read, multi-KB
 * Bash output, big JSON blobs from MCP servers). DDB items are capped at
 * 400 KB and we want plenty of headroom — string-shaped fields are clipped
 * to ~2000 chars each and the whole serialized payload to ~8000 chars.
 */
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

export const PARTY_TURN_CONSTANTS = {
  DEFAULT_TIMEOUT_MS,
  KILL_GRACE_MS,
  PARTY_MODE_PREFIX,
  PARTY_FORMAT_CONTRACT,
};
