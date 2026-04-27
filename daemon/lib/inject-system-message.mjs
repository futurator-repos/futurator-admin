// Pipeline v1 — Story 4.4. Shared helper for injecting a "system message"
// during a Claude step.
//
// Mid-turn injection limitation:
// The `claude` CLI does not expose a stdin channel for mid-turn system-
// message injection. Until that lands, this helper takes a best-effort
// path: emit a `status` event into the live event stream so the operator
// sees the warning in the Logs tab, and (when supported) write to the
// step's transcript file so the agent picks it up on the next read. The
// agent typically does not re-read its own transcript mid-turn, so the
// most reliable consumer is the operator + any next-turn prompt assembly.
//
// Used by:
//   - Story 1.3 (loop detector hint)
//   - Story 4.2 (time-ceiling 80% warn)
//   - Story 4.3 (cost-ceiling 80% warn)
//
// Not exported as a class — keeping a flat function so call sites stay
// readable.

const PREFIX = '[SYSTEM]';

/**
 * Format the system message body. Single line — multi-line events are
 * truncated by event consumers anyway.
 */
export function formatSystemMessage(category, body) {
  return `${PREFIX} [${category}] ${body}`.slice(0, 500);
}

/**
 * Emit a system message into the live event stream. Returns the formatted
 * text so the caller can also log it.
 *
 * @param {object} ctx
 * @param {Function} ctx.pushEvent - daemon's pushEvent(jobId, stepId, agentId, eventType, payload)
 * @param {string} jobId
 * @param {string} stepId
 * @param {string} agentId
 * @param {'LOOP_HINT'|'COST_WARN'|'TIME_WARN'} category
 * @param {string} body
 */
export function injectSystemMessage(ctx, jobId, stepId, agentId, category, body) {
  const text = formatSystemMessage(category, body);
  try {
    ctx.pushEvent?.(jobId, stepId, agentId, 'status', { text });
  } catch {
    // pushEvent failure must never throw — these are informational.
  }
  return text;
}
