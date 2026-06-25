/**
 * dual-agent-compare-capture.mjs — the REAL `claude` spawn for ONE lane of a
 * dual-agent comparison. Runs `claude -p "<question>"` in the assessed app's
 * clone, streams `--output-format stream-json`, and captures the final answer +
 * token usage + CLI-reported cost + how many tools (and graph tools) the agent
 * called.
 *
 * Lane A: vanilla tools (no --mcp-config). Lane B: + the Mycelium graph MCP
 * (graphMcpArgs), so the only difference between lanes is graph access.
 *
 * Spawns reuse the daemon's OAuth path (stripApiKey + loadOAuth) — the daemon
 * deletes ANTHROPIC_API_KEY and runs Claude on the Max/OAuth subscription.
 * NEVER introduce an API key here. The source never leaves the box.
 */

import { spawn } from 'node:child_process';

/** Extract {input,output} token counts from a stream-json line carrying usage. */
function parseUsage(u) {
  if (!u) return null;
  return {
    input:
      (u.input_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0),
    output: u.output_tokens || 0,
  };
}

/** A concise instruction wrapper so both lanes get the SAME task framing. */
export function buildPrompt(question, withGraph) {
  const base = [
    'You are a codebase analyst. Answer the following question about THIS repository',
    'concisely and concretely, citing the specific files/paths that support your answer.',
    'If you cannot determine something from the code, say so plainly.',
    '',
    `QUESTION: ${question}`,
  ];
  if (withGraph) {
    base.push(
      '',
      'You also have Mycelium code-graph tools available (mcp__mycelium__query_graph,',
      'get_node, neighbors, blast_radius, god_nodes, orphans, shortest_path). Use them',
      'to explore the dependency/call graph when that helps you answer accurately.',
    );
  }
  return base.join('\n');
}

/**
 * Build the lane-capture function.
 * @param {object} cfg
 *   - claudeBin: resolved `claude` path
 *   - stripApiKey(env) → env  (OAuth-safe env; removes ANTHROPIC_API_KEY)
 *   - loadOAuth(reason)       (refresh creds before spawn)
 *   - graphMcpArgs: string[]  (e.g. ['--mcp-config', '/path']) for lane B
 *   - log(level,msg,meta?)
 */
export function makeDualAgentCapture(cfg) {
  const {
    claudeBin = 'claude',
    stripApiKey = (e) => e,
    loadOAuth,
    graphMcpArgs = [],
    log = () => {},
  } = cfg;

  /**
   * Capture one lane.
   * @returns {Promise<{answer,latencyMs,tokens:{input,output},costUsd,toolCalls,graphToolCalls,error?}>}
   */
  function captureLane({ question, cwd, model = 'opus', withGraph = false, timeoutMs = 240000 }) {
    loadOAuth?.(`dual-agent-compare-${withGraph ? 'B' : 'A'}`);
    const args = [
      '-p',
      buildPrompt(question, withGraph),
      '--model',
      model,
      '--permission-mode',
      'bypassPermissions',
      '--output-format',
      'stream-json',
      '--verbose',
    ];
    if (withGraph) args.push(...graphMcpArgs);

    const startedAt = Date.now();
    const child = spawn(claudeBin, args, {
      cwd,
      env: stripApiKey({ ...process.env, FORCE_COLOR: '0' }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    return new Promise((resolve) => {
      let settled = false;
      let buf = '';
      let assistantText = '';
      let resultText = '';
      let usage = null;
      let costUsd = null;
      let toolCalls = 0;
      let graphToolCalls = 0;

      const finish = (extra = {}) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          if (!child.killed) child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
        resolve({
          answer: (resultText || assistantText).trim(),
          latencyMs: Date.now() - startedAt,
          tokens: usage || { input: 0, output: 0 },
          costUsd,
          toolCalls,
          graphToolCalls,
          ...extra,
        });
      };

      const timer = setTimeout(
        () => finish({ error: `timeout after ${timeoutMs}ms` }),
        timeoutMs,
      );

      child.on('error', (e) => finish({ error: `claude spawn failed: ${e.message}` }));
      child.on('close', () => finish());

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
          const u = parseUsage(ev?.message?.usage || ev?.usage);
          if (u) usage = u;
          if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
            for (const part of ev.message.content) {
              if (part?.type === 'text' && part.text) assistantText += part.text;
              else if (part?.type === 'tool_use') {
                toolCalls++;
                if (typeof part.name === 'string' && part.name.startsWith('mcp__mycelium__')) {
                  graphToolCalls++;
                }
              }
            }
          } else if (ev.type === 'result') {
            if (typeof ev.result === 'string') resultText = ev.result;
            if (typeof ev.total_cost_usd === 'number') costUsd = ev.total_cost_usd;
            // A hard CLI error surfaces as a result event with is_error:true.
            if (ev.is_error) {
              log('warn', `[dual-agent-compare] lane ${withGraph ? 'B' : 'A'} CLI error`);
              finish({ error: `claude error: ${ev.result || 'is_error'}` });
              return;
            }
          }
        }
      });
    });
  }

  return { captureLane };
}
