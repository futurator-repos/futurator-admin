// story-dev-events — stream event parser + emitter for the story-dev pipeline.
//
// Mirrors the epic-dev-pipeline's inline processEvent + pushEvent pattern but
// extracted into a reusable object so the retry loop can create a fresh stream
// per attempt without duplicating the line-buffer carry logic.
//
// Contract (development-plan G1):
//   • Every pushEvent call is guarded by `if (!pushEvent) return;` — unit tests
//     inject no pushEvent.
//   • Every emit is wrapped in try/catch → logger.warn (best-effort telemetry;
//     never blocks the pipeline).
//   • ingest() is synchronous (void) and fires pushEvent fire-and-forget so that
//     a slow DDB write never stalls the stdout data handler.

export const STORY_DEV_STEP_ID = 'story-dev';
export const STORY_DEV_AGENT_ID = 'dev';

/**
 * Create a streaming event bridge for one story-dev spawn.
 *
 * @param {{
 *   pushEvent?: (jobId: string, stepId: string, agentId: string, type: string, data: object) => Promise<void>,
 *   jobId: string,
 *   stepId?: string,
 *   agentId?: string,
 *   logger?: { warn?: (m: string) => void },
 * }} opts
 * @returns {{
 *   ingest(chunk: string): void,
 *   finalize(): void,
 *   emitStepStart(text: string): void,
 *   emitStepComplete(metrics?: object): void,
 *   emitStepError(text: string): void,
 *   readonly metrics: { costUsd?: number, inputTokens?: number, outputTokens?: number, sessionId?: string, numTurns?: number },
 *   readonly finalResult: object | null,
 * }}
 */
export function createStoryEventStream({
  pushEvent,
  jobId,
  stepId = STORY_DEV_STEP_ID,
  agentId = STORY_DEV_AGENT_ID,
  logger,
} = {}) {
  let _lineBuffer = '';
  let _finalResult = null;

  /**
   * Fire-and-forget wrapper.
   * Telemetry must never block or throw into the pipeline.
   */
  function safePush(type, data) {
    if (!pushEvent) return;
    try {
      const p = pushEvent(jobId, stepId, agentId, type, data);
      if (p && typeof p.catch === 'function') {
        p.catch((e) =>
          logger?.warn?.(`[story-dev-events] push ${type} failed: ${e?.message}`),
        );
      }
    } catch (e) {
      logger?.warn?.(`[story-dev-events] push ${type} sync error: ${e?.message}`);
    }
  }

  /** Process one complete newline-terminated JSON line from the CLI stream. */
  function processLine(line) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON line (progress text, warnings) — silently ignored.
      return;
    }
    if (!event || typeof event !== 'object') return;

    if (event.type === 'stream_event') {
      const delta = event.event?.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        safePush('text_delta', { text: delta.text });
      }
    } else if (event.type === 'assistant') {
      const content = event.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          safePush('tool_use', {
            toolName: block.name,
            toolInput: JSON.stringify(block.input).slice(0, 2000),
          });
        } else if (block.type === 'text' && block.text) {
          safePush('text_delta', { text: block.text });
        }
      }
    } else if (event.type === 'tool_result') {
      const output =
        typeof event.output === 'string'
          ? event.output.slice(0, 2000)
          : JSON.stringify(event.output).slice(0, 2000);
      safePush('tool_result', { toolOutput: output });
    } else if (event.type === 'result') {
      // Capture the last result event — used for metrics extraction.
      _finalResult = event;
    }
  }

  return {
    /**
     * Feed a raw stdout chunk.
     * Carries the line buffer across calls so splits mid-line are handled
     * transparently.
     */
    ingest(chunk) {
      _lineBuffer += chunk;
      const lines = _lineBuffer.split('\n');
      _lineBuffer = lines.pop() ?? '';
      for (const line of lines) {
        processLine(line);
      }
    },

    /**
     * Flush the trailing partial line.
     * Call exactly once after the child process close event.
     */
    finalize() {
      if (_lineBuffer.trim()) {
        processLine(_lineBuffer);
      }
      _lineBuffer = '';
    },

    /** Emit step_start — best-effort, no await required. */
    emitStepStart(text) {
      safePush('step_start', { text: text ?? '' });
    },

    /**
     * Emit step_complete. Accepts a metrics object (falls back to the captured
     * finalResult for any absent fields). Mirrors epic-dev-pipeline's terminal emit.
     *
     * @param {{ costUsd?: number, sessionId?: string, durationMs?: number, numTurns?: number }} [metrics]
     */
    emitStepComplete(metrics = {}) {
      if (!pushEvent) return;
      try {
        const cost = metrics.costUsd ?? _finalResult?.total_cost_usd ?? 0;
        const sessionId = metrics.sessionId ?? _finalResult?.session_id ?? '';
        const durationMs = metrics.durationMs;
        const numTurns = metrics.numTurns ?? _finalResult?.num_turns ?? 0;
        const p = pushEvent(jobId, stepId, agentId, 'step_complete', {
          cost,
          sessionId,
          durationMs,
          text: JSON.stringify({ numTurns, durationMs }),
        });
        if (p && typeof p.catch === 'function') {
          p.catch((e) =>
            logger?.warn?.(`[story-dev-events] step_complete push failed: ${e?.message}`),
          );
        }
      } catch (e) {
        logger?.warn?.(`[story-dev-events] step_complete sync error: ${e?.message}`);
      }
    },

    /** Emit step_error — best-effort, no await required. */
    emitStepError(text) {
      safePush('step_error', { text: text ?? '' });
    },

    /**
     * Metrics extracted from the CLI's terminal `result` event.
     * Returns {} when no result event has been received yet.
     */
    get metrics() {
      if (!_finalResult) return {};
      return {
        costUsd: _finalResult.total_cost_usd,
        inputTokens: _finalResult.usage?.input_tokens,
        outputTokens: _finalResult.usage?.output_tokens,
        sessionId: _finalResult.session_id,
        numTurns: _finalResult.num_turns,
      };
    },

    /** The raw CLI `result` event (last seen), or null if not yet received. */
    get finalResult() {
      return _finalResult;
    },
  };
}
