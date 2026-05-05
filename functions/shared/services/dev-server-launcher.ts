import type { AgentJob, PipelineDefinition } from '../types/agent-orchestrator';
import type { EpicWorkflow } from '../types/epic-workflow';

/**
 * Dev-server launcher — Story 16.3.
 *
 * Creates a single-step OPS agent pipeline that starts the Vite/React dev
 * server in background on the EC2 host, waits for boot, and returns the
 * public URL via regex-extracted variables (`DEV_SERVER_URL`,
 * `DEV_SERVER_PID`, `STATUS`).
 *
 * The public EC2 IP is passed in by the caller (API handler fetches it from
 * EC2 describe-instances). This removes the agent's need to hit IMDSv2 from
 * inside the Claude sandbox (which was returning the private IP unreliably).
 *
 * Job is PENDING until the daemon picks it up. Caller returns the jobId to
 * the UI which polls for the extracted URL.
 */

export interface DevServerDeps {
  createJob: (job: AgentJob) => Promise<unknown>;
  uuid: () => string;
}

export function buildDevServerPipeline(
  workingDir: string,
  publicIp: string,
): PipelineDefinition {
  return {
    maxIterations: 1,
    agents: {
      OPS: {
        name: 'DevOps',
        allowedTools: 'Bash',
        model: 'haiku',
      },
    },
    steps: [
      {
        id: 'start_server',
        agentId: 'OPS',
        prompt: `You are a headless DevOps automation. You run non-interactively — there is NO human to read your output. Execute the commands below and emit the EXACT output format at the end. Do not add commentary.

Goal: start a Vite dev server for ${workingDir} so it is reachable at http://${publicIp}:5173.

Commands (run in order):

1. Kill anything already on port 5173:
   kill $(lsof -ti:5173) 2>/dev/null; sleep 1

2. cd to the working dir and ensure deps are installed:
   cd ${workingDir} && [ -d node_modules ] || npm install

3. Start the dev server in the background, detached from this shell's stdout
   (stdout MUST be redirected — otherwise this session hangs):
   cd ${workingDir} && nohup npm run dev -- --host 0.0.0.0 --port 5173 > /tmp/futurator-devserver.log 2>&1 & echo "PID=$!"

4. Wait up to 20 seconds for the server to respond:
   for i in $(seq 1 20); do sleep 1; STATUS=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:5173 2>/dev/null); [ "$STATUS" = "200" ] && break; done; echo "STATUS=$STATUS"

5. Read the log for confirmation:
   tail -20 /tmp/futurator-devserver.log

## Output format — EXACT plain text, no markdown, no bold, no code fences

Emit these three lines as the LAST thing in your final text message, each on
its own line. Do NOT wrap them in markdown or decoration.

DEV_SERVER_URL: http://${publicIp}:5173
DEV_SERVER_PID: <the PID you captured in step 3>
STATUS: running

If step 4's STATUS was not 200, emit:

DEV_SERVER_URL: http://${publicIp}:5173
DEV_SERVER_PID: unknown
STATUS: failed`,
        // Regex tolerant to markdown emphasis (** _ `) the agent sometimes
        // wraps labels in, despite the "plain text" instruction.
        extractors: {
          DEV_SERVER_URL: {
            type: 'regex',
            pattern: '[*_`]*DEV_SERVER_URL[*_`]*:\\s*[*_`]*\\s*(https?://[^\\s*_`]+)',
          },
          DEV_SERVER_PID: {
            type: 'regex',
            pattern: '[*_`]*DEV_SERVER_PID[*_`]*:\\s*[*_`]*\\s*(\\d+|unknown)',
          },
          STATUS: {
            type: 'regex',
            pattern: '[*_`]*STATUS[*_`]*:\\s*[*_`]*\\s*(\\w+)',
          },
        },
        validations: [],
      },
    ],
  };
}

export async function launchDevServer(
  epic: EpicWorkflow,
  userId: string,
  now: string,
  publicIp: string,
  deps: DevServerDeps,
): Promise<{ jobId: string }> {
  const pipeline = buildDevServerPipeline(epic.workingDir, publicIp);
  const jobId = deps.uuid();
  await deps.createJob({
    jobId,
    status: 'PENDING',
    createdAt: now,
    updatedAt: now,
    createdBy: userId,
    workingDir: epic.workingDir,
    pipeline,
  });
  return { jobId };
}
