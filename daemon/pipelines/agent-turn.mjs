// Pipeline v1 — Story 3.3 (initial implementation).
//
// Generic conversational turn: spawn-or-resume a Claude session for an
// `agent-turn` job, persist the response, update the AgentSession + the
// AgentConversation row. This is the decoupled successor to party-turn —
// no /bmad-party-mode prefix, no party-projects lock.
//
// V1 scope: minimal viable turn loop. The party-turn refactor (full AC#3
// of Story 3.3 — "party-turn becomes a thin wrapper over agent-turn") is
// a follow-up that can land without disrupting the contract here.

import { spawn } from 'node:child_process';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const SESSIONS_TABLE = process.env.AGENT_SESSIONS_TABLE || 'futurator-agent-sessions';
const CONVERSATIONS_TABLE =
  process.env.AGENT_CONVERSATIONS_TABLE || 'futurator-agent-conversations';

/**
 * Run one conversational turn.
 *
 * @param {object} job - the agent-turn job row from DDB
 * @param {object} ctx
 * @param {object} ctx.ddb - DynamoDBDocumentClient
 * @param {Function} ctx.log - logger(level, msg, data?)
 * @param {Function} ctx.pushEvent - event emitter to agent-events
 * @param {string} ctx.claudeBin - resolved claude binary path
 */
export async function runAgentTurn(job, ctx) {
  const payload = job.agentTurnPayload;
  if (!payload) throw new Error('agent-turn job missing agentTurnPayload');
  const { conversationId, sessionId, claudeSessionId, content, mode, systemPromptSource } =
    payload;

  ctx.log('info', `[agent-turn] ${conversationId}: ${mode} turn (${content.length} chars)`);

  // Mark conversation active.
  const now = new Date().toISOString();
  await ctx.ddb.send(
    new UpdateCommand({
      TableName: CONVERSATIONS_TABLE,
      Key: { conversationId },
      UpdateExpression: 'SET lastActivityAt = :n',
      ExpressionAttributeValues: { ':n': now },
    }),
  );

  // Build prompt: handoff (fresh) prepended to operator content.
  let prompt = content;
  if (mode === 'fresh' && systemPromptSource) {
    prompt = `${systemPromptSource}\n\n---\n\nOperator: ${content}`;
  }

  // Spawn claude.
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
  if (mode !== 'fresh' && claudeSessionId) {
    args.push('--resume', claudeSessionId);
  }

  const session = await ctx.ddb.send(
    new GetCommand({ TableName: SESSIONS_TABLE, Key: { sessionId } }),
  );
  const cwd = session.Item?.cwd || process.env.HOME || '/tmp';

  return new Promise((resolve, reject) => {
    // claude ≥2.1.19x is a native binary — spawn it directly, not via `node` (see CLAUDE_BIN note).
    const proc = spawn(ctx.claudeBin, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    let buffer = '';
    let finalResult = null;
    let stderrBuffer = '';

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          if (event.type === 'system' && event.subtype === 'init' && event.session_id) {
            // Capture the Claude session id on first turn.
            ctx.ddb
              .send(
                new UpdateCommand({
                  TableName: SESSIONS_TABLE,
                  Key: { sessionId },
                  UpdateExpression:
                    'SET claudeSessionId = :c, firstTurnAt = if_not_exists(firstTurnAt, :n), #s = :a',
                  ExpressionAttributeNames: { '#s': 'status' },
                  ExpressionAttributeValues: {
                    ':c': event.session_id,
                    ':n': now,
                    ':a': 'ACTIVE',
                  },
                }),
              )
              .catch(() => undefined);
          }
          if (event.type === 'result') finalResult = event;
          if (ctx.pushEvent) {
            ctx.pushEvent(job.jobId, conversationId, 'agent-turn', 'status', {
              text: line.slice(0, 500),
            });
          }
        } catch {
          // non-JSON
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString();
    });

    proc.on('error', (err) => reject(err));

    proc.on('close', async () => {
      const cost = finalResult?.total_cost_usd || 0;
      const tokens =
        (finalResult?.usage?.input_tokens || 0) + (finalResult?.usage?.output_tokens || 0);

      // Update session totals.
      try {
        await ctx.ddb.send(
          new UpdateCommand({
            TableName: SESSIONS_TABLE,
            Key: { sessionId },
            UpdateExpression:
              'ADD tokenCount :t, costUsd :c SET lastTurnAt = :n, #s = :idle',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: {
              ':t': tokens,
              ':c': cost,
              ':n': new Date().toISOString(),
              ':idle': 'IDLE',
            },
          }),
        );
        await ctx.ddb.send(
          new UpdateCommand({
            TableName: CONVERSATIONS_TABLE,
            Key: { conversationId },
            UpdateExpression: 'ADD totalCostUsd :c SET lastActivityAt = :n',
            ExpressionAttributeValues: {
              ':c': cost,
              ':n': new Date().toISOString(),
            },
          }),
        );
      } catch (err) {
        ctx.log('error', `[agent-turn] DDB update failed: ${err.message}`);
      }

      if (!finalResult) {
        return reject(new Error(`agent-turn produced no result. stderr: ${stderrBuffer.slice(0, 500)}`));
      }
      resolve({ result: finalResult.result, cost, tokens });
    });
  });
}
