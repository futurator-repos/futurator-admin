/**
 * dual-agent-compare-runner.mjs — orchestrates a dual-agent comparison.
 *
 * Runs the SAME question through two lanes SEQUENTIALLY (sequential, not
 * parallel, to avoid OAuth/rate-limit contention between two long claude spawns
 * on the one Max subscription):
 *   Lane A — vanilla tools (no graph)
 *   Lane B — vanilla tools + the Mycelium graph MCP
 * and returns both lane results so the operator can judge whether graph access
 * yields a better/faster/cheaper answer.
 *
 * Pure orchestration — `captureLane`, `pushEvent`, and `log` are injected, so
 * the runner is unit-testable with a fake capture (no real claude spawn).
 */

/**
 * @param {object} job  - { question, projectPath, model, timeoutMs }
 * @param {object} deps - { captureLane, pushEvent, log, jobId }
 */
export async function runDualAgentCompare(job, deps) {
  const { question, projectPath, model = 'opus', timeoutMs = 240000 } = job;
  const { captureLane, pushEvent = () => {}, log = () => {}, jobId = 'dual' } = deps;

  if (!question || !question.trim()) return { ok: false, reason: 'question-missing' };
  if (!projectPath) return { ok: false, reason: 'projectPath-missing' };

  const short = String(jobId).slice(0, 8);
  pushEvent({ type: 'dual.started', jobId, question, model });

  const lanes = [
    { lane: 'A', label: 'Vanilla tools', withGraph: false },
    { lane: 'B', label: '+ Mycelium graph MCP', withGraph: true },
  ];

  const results = {};
  for (const meta of lanes) {
    pushEvent({ type: 'dual.lane.start', jobId, lane: meta.lane, label: meta.label });
    log('info', `[${short}] dual-agent lane ${meta.lane} (${meta.label}) starting`);
    const r = await captureLane({
      question,
      cwd: projectPath,
      model,
      withGraph: meta.withGraph,
      timeoutMs,
    });
    const laneResult = {
      lane: meta.lane,
      label: meta.label,
      withGraph: meta.withGraph,
      answer: r.answer || '',
      latencyMs: r.latencyMs ?? 0,
      tokens: r.tokens || { input: 0, output: 0 },
      costUsd: r.costUsd ?? null,
      toolCalls: r.toolCalls ?? 0,
      graphToolCalls: r.graphToolCalls ?? 0,
      ...(r.error ? { error: r.error } : {}),
    };
    results[meta.lane] = laneResult;
    pushEvent({
      type: 'dual.lane.done',
      jobId,
      lane: meta.lane,
      latencyMs: laneResult.latencyMs,
      tokensIn: laneResult.tokens.input,
      tokensOut: laneResult.tokens.output,
      costUsd: laneResult.costUsd,
      graphToolCalls: laneResult.graphToolCalls,
      error: laneResult.error,
    });
    log(
      'info',
      `[${short}] lane ${meta.lane} done: ${laneResult.latencyMs}ms · ${laneResult.tokens.input}+${laneResult.tokens.output} tok · ${laneResult.graphToolCalls} graph calls${laneResult.error ? ` · ERROR ${laneResult.error}` : ''}`,
    );
  }

  pushEvent({ type: 'dual.completed', jobId });
  return {
    ok: true,
    result: { question, model, agentA: results.A, agentB: results.B },
  };
}
