# Futurator Agent Orchestrator — Architecture Document

## 1. Goal

Build a system where:

1. You write instructions for **Agent A** and **Agent B** in a web app (deployed on AWS)
2. Those instructions are sent to your local Mac, where **Claude Code CLI** executes them — no API keys, using your OAuth session
3. Agent A runs in **session A.1**, Agent B runs in **session B.1**, then Agent A **resumes session A.1** with B's output
4. Every response streams back to the web app in real time, rendered as **rich markdown** with tool call visualization
5. All sessions, instructions, and outputs are stored and auditable in the web app

The instructions are never hardcoded. You change them in the browser, hit Run, and the local terminal executes whatever you wrote.

---

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│  BROWSER (anywhere — phone, laptop, office)                        │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  Futurator Agent Orchestrator UI                              │  │
│  │                                                               │  │
│  │  ┌─────────────────────┐  ┌─────────────────────┐            │  │
│  │  │ Agent A Instructions│  │ Agent B Instructions│            │  │
│  │  │ (textarea/editor)   │  │ (textarea/editor)   │            │  │
│  │  └─────────────────────┘  └─────────────────────┘            │  │
│  │                                                               │  │
│  │  ┌─────────────────────┐  ┌─────────────────────┐            │  │
│  │  │ Working Directory   │  │ Allowed Tools       │            │  │
│  │  │ /Users/richie/...   │  │ Bash,Read,Edit      │            │  │
│  │  └─────────────────────┘  └─────────────────────┘            │  │
│  │                                                               │  │
│  │  [ ▶ Run Pipeline ]                                           │  │
│  │                                                               │  │
│  │  ┌───────────────────────────────────────────────────────┐   │  │
│  │  │ Live Output Panel                                     │   │  │
│  │  │                                                       │   │  │
│  │  │ SESSION A.1 ─────────────────────────────────────     │   │  │
│  │  │ 🤖 Agent A is running...                              │   │  │
│  │  │ ● Read(src/auth.ts)                                   │   │  │
│  │  │   └ 42 lines read                                     │   │  │
│  │  │ ● Bash(npm test)                                      │   │  │
│  │  │   └ 12 tests passed                                   │   │  │
│  │  │ Agent A: "I found 3 issues in the auth module..."     │   │  │
│  │  │ ✅ Complete — $0.04 — 5.2s                            │   │  │
│  │  │                                                       │   │  │
│  │  │ SESSION B.1 ─────────────────────────────────────     │   │  │
│  │  │ 🤖 Agent B is running...                              │   │  │
│  │  │ ...                                                   │   │  │
│  │  │                                                       │   │  │
│  │  │ SESSION A.1 (RESUMED) ───────────────────────────     │   │  │
│  │  │ 🤖 Agent A resuming with B's feedback...              │   │  │
│  │  │ ...                                                   │   │  │
│  │  └───────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  POST /api/jobs → create job                                        │
│  GET  /api/jobs/:id/events → SSE stream (polling DynamoDB)          │
└────────────────────────┬────────────────────────────────────────────┘
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────────┐
│  AWS (eu-central-1)                                                 │
│                                                                     │
│  ┌──────────────────────┐     ┌────────────────────────────────┐   │
│  │  Next.js API Routes  │────▶│  DynamoDB: agent-orchestrator  │   │
│  │  (ECS / Lambda)      │     │                                │   │
│  │                      │     │  Jobs Table:                   │   │
│  │  POST /api/jobs      │     │    PK: JOB#<uuid>              │   │
│  │  GET  /api/jobs/:id  │     │    SK: META                    │   │
│  │  GET  /api/jobs/:id/ │     │    prompt_a, prompt_b          │   │
│  │       events         │     │    status, working_dir         │   │
│  │                      │     │                                │   │
│  │                      │     │  Events Table:                 │   │
│  │                      │     │    PK: JOB#<uuid>              │   │
│  │                      │     │    SK: EVT#<seq>               │   │
│  │                      │     │    agent, type, data           │   │
│  └──────────────────────┘     └────────────┬───────────────────┘   │
│                                             │                       │
└─────────────────────────────────────────────┼───────────────────────┘
                                              │
                     ┌────────────────────────┘
                     │  Outbound poll every 3s
                     │  (Mac → AWS, no ports opened)
                     ▼
┌─────────────────────────────────────────────────────────────────────┐
│  YOUR MAC (local machine)                                           │
│                                                                     │
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │  agent-daemon.mjs                                             │  │
│  │                                                               │  │
│  │  1. Poll DynamoDB for status=PENDING                          │  │
│  │  2. Pick up job, read prompt_a and prompt_b                   │  │
│  │  3. Spawn: claude -p "{prompt_a}" --output-format stream-json │  │
│  │     --verbose --allowedTools "Bash,Read,Edit"                 │  │
│  │  4. Parse each NDJSON line from stdout                        │  │
│  │  5. Write each event to DynamoDB Events table                 │  │
│  │  6. When Agent A finishes, extract result                     │  │
│  │  7. Spawn Agent B with prompt_b + A's handoff                 │  │
│  │  8. Write B's events to DynamoDB                              │  │
│  │  9. Spawn Agent A --resume with B's output                    │  │
│  │  10. Write resumed A events to DynamoDB                       │  │
│  │  11. Set job status=COMPLETED                                 │  │
│  └───────────────────────────────────────────────────────────────┘  │
│                                                                     │
│  Claude Code CLI (OAuth — no API key)                               │
│  Full access to local filesystem, git, MCP servers, env vars        │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 3. Data Model

### 3.1 Jobs Table

Single-table design. One item per job with all metadata.

```
Table: futurator-agent-orchestrator

PK: JOB#<uuid>
SK: META

Attributes:
  job_id:           string    — UUID
  status:           string    — PENDING | RUNNING_A | RUNNING_B | RUNNING_A_RESUME | COMPLETED | FAILED
  created_at:       string    — ISO timestamp
  updated_at:       string    — ISO timestamp

  # Inputs (written by web app)
  prompt_a:         string    — Full instruction text for Agent A
  prompt_b:         string    — Full instruction text for Agent B
  working_dir:      string    — e.g. "/Users/richie/projects/songster"
  allowed_tools_a:  string    — e.g. "Bash,Read,Edit,Write"
  allowed_tools_b:  string    — e.g. "Bash(git*),Read,Grep,Glob"
  disallowed_tools_b: string  — e.g. "Write,Edit" (B is reviewer by default)

  # Session tracking (written by daemon)
  session_a:        string    — Claude Code session ID for Agent A
  session_b:        string    — Claude Code session ID for Agent B

  # Results (written by daemon)
  result_a:         string    — Agent A's first-pass response text
  result_b:         string    — Agent B's response text
  result_a_resumed: string    — Agent A's resumed response text
  cost_a:           number
  cost_b:           number
  cost_a_resumed:   number
  total_cost:       number
  error_message:    string    — If status=FAILED

GSI: status-created-index
  PK: status
  SK: created_at
  (Daemon queries: status=PENDING, ordered by created_at ASC, Limit 1)
```

### 3.2 Events Table

One item per streaming event. The web app polls these to render live output.

```
Table: futurator-agent-events (or same table with different SK pattern)

PK: JOB#<uuid>
SK: EVT#<zero-padded-sequence>    — e.g. EVT#000001, EVT#000002

Attributes:
  seq:        number    — Auto-incrementing sequence
  timestamp:  string    — ISO timestamp
  agent:      string    — "A" | "B" | "A_RESUMED"
  phase:      string    — "RUNNING" | "COMPLETE" | "ERROR"

  # Event payload (one of these will be populated)
  event_type: string    — "text_delta" | "tool_use" | "tool_result" | "result" | "status"
  text:       string    — For text_delta: the markdown text chunk
  tool_name:  string    — For tool_use: "Read", "Bash", "Edit", etc.
  tool_input: string    — For tool_use: JSON string of input params
  tool_output:string    — For tool_result: truncated output
  cost:       number    — For result: total_cost_usd
  session_id: string    — For result: the session_id
  duration_ms:number    — For result: execution time

TTL: expire_at  — Auto-delete events after 7 days to control costs
```

---

## 4. Daemon Implementation

The daemon runs on your Mac as a long-lived Node.js process. It polls DynamoDB for pending jobs, executes the three-step pipeline, and streams events back.

### 4.1 Core Daemon

```javascript
// agent-daemon.mjs
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  PutCommand,
} from '@aws-sdk/lib-dynamodb';
import { spawn } from 'child_process';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({ region: 'eu-central-1' }));
const JOBS_TABLE = 'futurator-agent-orchestrator';
const EVENTS_TABLE = 'futurator-agent-events'; // or same table

let eventSeq = 0;

// ─── Push a single event to DynamoDB ───
async function pushEvent(jobId, agent, eventType, data) {
  eventSeq++;
  const seq = String(eventSeq).padStart(6, '0');

  await ddb.send(
    new PutCommand({
      TableName: EVENTS_TABLE,
      Item: {
        PK: `JOB#${jobId}`,
        SK: `EVT#${seq}`,
        seq: eventSeq,
        timestamp: new Date().toISOString(),
        agent,
        event_type: eventType,
        ...data,
        expire_at: Math.floor(Date.now() / 1000) + 7 * 86400, // TTL: 7 days
      },
    }),
  );
}

// ─── Run claude -p with stream-json and push events ───
function runAgent(jobId, agent, prompt, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose'];
    if (opts.resume) args.push('--resume', opts.resume);
    if (opts.allowedTools) args.push('--allowedTools', opts.allowedTools);
    if (opts.disallowedTools) args.push('--disallowedTools', opts.disallowedTools);

    pushEvent(jobId, agent, 'status', { text: `Agent ${agent} starting...` });

    const proc = spawn('claude', args, {
      cwd: opts.workingDir || process.env.HOME,
      shell: true,
    });

    let buffer = '';
    let finalResult = null;

    proc.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete last line

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);
          processStreamEvent(jobId, agent, event);

          // Capture the final result message
          if (event.type === 'result') {
            finalResult = event;
          }
        } catch (e) {
          // Non-JSON line, ignore
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      pushEvent(jobId, agent, 'status', { text: `stderr: ${chunk.toString()}` });
    });

    proc.on('close', (code) => {
      if (code !== 0 && !finalResult) {
        pushEvent(jobId, agent, 'status', { text: `Exit code ${code}`, phase: 'ERROR' });
        return reject(new Error(`Agent ${agent} exited with code ${code}`));
      }
      pushEvent(jobId, agent, 'result', {
        phase: 'COMPLETE',
        cost: finalResult?.cost_usd || 0,
        session_id: finalResult?.session_id || '',
        duration_ms: finalResult?.duration_ms || 0,
      });
      resolve(finalResult);
    });
  });
}

// ─── Process individual stream-json events ───
async function processStreamEvent(jobId, agent, event) {
  switch (event.type) {
    case 'stream_event': {
      const delta = event.event?.delta;
      if (delta?.type === 'text_delta' && delta.text) {
        // Text streaming — the markdown content
        await pushEvent(jobId, agent, 'text_delta', { text: delta.text });
      }
      break;
    }

    case 'assistant': {
      const content = event.message?.content || [];
      for (const block of content) {
        if (block.type === 'tool_use') {
          await pushEvent(jobId, agent, 'tool_use', {
            tool_name: block.name,
            tool_input: JSON.stringify(block.input).slice(0, 2000), // truncate
          });
        }
        if (block.type === 'text' && block.text) {
          await pushEvent(jobId, agent, 'text_delta', { text: block.text });
        }
      }
      break;
    }

    case 'tool_result': {
      const output =
        typeof event.output === 'string'
          ? event.output.slice(0, 2000)
          : JSON.stringify(event.output).slice(0, 2000);
      await pushEvent(jobId, agent, 'tool_result', { tool_output: output });
      break;
    }

    case 'result': {
      // Final result — handled in proc.on('close')
      break;
    }
  }
}

// ─── Execute the full A → B → A pipeline ───
async function executePipeline(job) {
  const {
    job_id,
    prompt_a,
    prompt_b,
    working_dir,
    allowed_tools_a,
    allowed_tools_b,
    disallowed_tools_b,
  } = job;

  const baseOpts = { workingDir: working_dir || process.env.HOME };

  // ── STEP 1: Agent A (session A.1) ──
  await updateJobStatus(job_id, 'RUNNING_A');

  const resultA = await runAgent(job_id, 'A', prompt_a, {
    ...baseOpts,
    allowedTools: allowed_tools_a || 'Bash,Read,Edit,Write',
  });

  const sessionA = resultA.session_id;
  const textA = resultA.result || '';

  await updateJobField(job_id, {
    session_a: sessionA,
    result_a: textA,
    cost_a: resultA.cost_usd || 0,
  });

  // ── STEP 2: Agent B (session B.1) ──
  // Inject A's output into B's prompt as context
  await updateJobStatus(job_id, 'RUNNING_B');

  const bPromptFull = [prompt_b, '', '---CONTEXT_FROM_AGENT_A---', textA, '---END_CONTEXT---'].join(
    '\n',
  );

  const resultB = await runAgent(job_id, 'B', bPromptFull, {
    ...baseOpts,
    allowedTools: allowed_tools_b || 'Bash(git*),Read,Grep,Glob',
    disallowedTools: disallowed_tools_b || 'Write,Edit',
  });

  const textB = resultB.result || '';

  await updateJobField(job_id, {
    session_b: resultB.session_id,
    result_b: textB,
    cost_b: resultB.cost_usd || 0,
  });

  // ── STEP 3: Agent A RESUMES (session A.1) ──
  // Only B's output goes in. A's session context provides memory.
  await updateJobStatus(job_id, 'RUNNING_A_RESUME');

  const resumePrompt = [
    'Agent B has completed their work. Here is their report:',
    '',
    textB,
    '',
    "Continue from where you left off. Incorporate Agent B's feedback.",
  ].join('\n');

  const resultAResumed = await runAgent(job_id, 'A_RESUMED', resumePrompt, {
    ...baseOpts,
    resume: sessionA, // ← THIS resumes session A.1
    allowedTools: allowed_tools_a || 'Bash,Read,Edit,Write',
  });

  await updateJobField(job_id, {
    result_a_resumed: resultAResumed.result || '',
    cost_a_resumed: resultAResumed.cost_usd || 0,
    total_cost: (resultA.cost_usd || 0) + (resultB.cost_usd || 0) + (resultAResumed.cost_usd || 0),
    status: 'COMPLETED',
    updated_at: new Date().toISOString(),
  });

  console.log(`✅ Job ${job_id} completed.`);
}

// ─── Helper: update job status ───
async function updateJobStatus(jobId, status) {
  await updateJobField(jobId, { status, updated_at: new Date().toISOString() });
}

async function updateJobField(jobId, fields) {
  const keys = Object.keys(fields);
  await ddb.send(
    new UpdateCommand({
      TableName: JOBS_TABLE,
      Key: { PK: `JOB#${jobId}`, SK: 'META' },
      UpdateExpression: 'SET ' + keys.map((k) => `#${k} = :${k}`).join(', '),
      ExpressionAttributeNames: Object.fromEntries(keys.map((k) => [`#${k}`, k])),
      ExpressionAttributeValues: Object.fromEntries(keys.map((k) => [`:${k}`, fields[k]])),
    }),
  );
}

// ─── Poll loop ───
async function poll() {
  console.log('🔄 Agent daemon started. Polling for jobs...');

  while (true) {
    try {
      const { Items } = await ddb.send(
        new QueryCommand({
          TableName: JOBS_TABLE,
          IndexName: 'status-created-index',
          KeyConditionExpression: '#s = :pending',
          ExpressionAttributeNames: { '#s': 'status' },
          ExpressionAttributeValues: { ':pending': 'PENDING' },
          Limit: 1,
          ScanIndexForward: true, // oldest first
        }),
      );

      if (Items?.length > 0) {
        const job = Items[0];
        eventSeq = 0; // reset per job
        console.log(`📥 Job picked up: ${job.job_id}`);

        try {
          await executePipeline(job);
        } catch (err) {
          await updateJobField(job.job_id, {
            status: 'FAILED',
            error_message: err.message,
            updated_at: new Date().toISOString(),
          });
          console.error(`❌ Job ${job.job_id} failed:`, err.message);
        }
      }
    } catch (err) {
      console.error('Poll error:', err.message);
    }

    await new Promise((r) => setTimeout(r, 3000));
  }
}

poll();
```

### 4.2 How Session Resume Works

The critical line is:

```javascript
const resultAResumed = await runAgent(jobId, 'A_RESUMED', resumePrompt, {
  resume: sessionA, // captured from Step 1
});
```

This translates to the CLI call:

```bash
claude -p "Agent B has completed..." \
  --resume "6f13c724-0e30-40c1-8069-40db981bd7df" \
  --output-format stream-json \
  --verbose
```

The `--resume` flag reopens session A.1's full conversation history. Agent A retains everything from its first run (files it read, decisions it made, any internal reasoning) without us re-injecting that context. The only new information in the prompt is Agent B's output.

This was verified in the roundtrip test: Agent A generated a secret token, that token was never passed to Agent B or re-injected into the resumed prompt, and Agent A correctly recalled it from session memory upon resume.

---

## 5. Web App API Routes

### 5.1 Create Job

```typescript
// app/api/jobs/route.ts
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'crypto';

export async function POST(req: Request) {
  const body = await req.json();

  const job_id = randomUUID();

  await ddb.send(
    new PutCommand({
      TableName: 'futurator-agent-orchestrator',
      Item: {
        PK: `JOB#${job_id}`,
        SK: 'META',
        job_id,
        status: 'PENDING',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        prompt_a: body.prompt_a,
        prompt_b: body.prompt_b,
        working_dir: body.working_dir || '/Users/richie/projects',
        allowed_tools_a: body.allowed_tools_a || 'Bash,Read,Edit,Write',
        allowed_tools_b: body.allowed_tools_b || 'Bash(git*),Read,Grep,Glob',
        disallowed_tools_b: body.disallowed_tools_b || 'Write,Edit',
      },
    }),
  );

  return Response.json({ job_id, status: 'PENDING' });
}
```

### 5.2 Get Job Status

```typescript
// app/api/jobs/[id]/route.ts
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: 'futurator-agent-orchestrator',
      Key: { PK: `JOB#${params.id}`, SK: 'META' },
    }),
  );

  return Response.json(Item);
}
```

### 5.3 Stream Events (SSE)

The frontend polls this endpoint. It returns all events newer than the client's last-seen sequence number.

```typescript
// app/api/jobs/[id]/events/route.ts
export async function GET(req: Request, { params }: { params: { id: string } }) {
  const { searchParams } = new URL(req.url);
  const afterSeq = searchParams.get('after') || '000000';

  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: 'futurator-agent-events',
      KeyConditionExpression: 'PK = :pk AND SK > :after',
      ExpressionAttributeValues: {
        ':pk': `JOB#${params.id}`,
        ':after': `EVT#${afterSeq}`,
      },
      ScanIndexForward: true,
      Limit: 50,
    }),
  );

  return Response.json({
    events: Items || [],
    last_seq: Items?.length ? Items[Items.length - 1].seq : afterSeq,
  });
}
```

---

## 6. Frontend: Live Output with Rich Rendering

### 6.1 Event Polling Hook

```typescript
// hooks/useAgentEvents.ts
import { useState, useEffect, useRef } from 'react';

interface AgentEvent {
  seq: number;
  agent: 'A' | 'B' | 'A_RESUMED';
  event_type: 'text_delta' | 'tool_use' | 'tool_result' | 'result' | 'status';
  text?: string;
  tool_name?: string;
  tool_input?: string;
  tool_output?: string;
  cost?: number;
  session_id?: string;
  duration_ms?: number;
  phase?: string;
}

export function useAgentEvents(jobId: string | null) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [status, setStatus] = useState<string>('IDLE');
  const lastSeq = useRef('000000');

  useEffect(() => {
    if (!jobId) return;

    const interval = setInterval(async () => {
      const res = await fetch(`/api/jobs/${jobId}/events?after=${lastSeq.current}`);
      const data = await res.json();

      if (data.events.length > 0) {
        setEvents((prev) => [...prev, ...data.events]);
        lastSeq.current = String(data.last_seq).padStart(6, '0');
      }

      // Also check job status
      const jobRes = await fetch(`/api/jobs/${jobId}`);
      const job = await jobRes.json();
      setStatus(job.status);

      // Stop polling when done
      if (['COMPLETED', 'FAILED'].includes(job.status)) {
        clearInterval(interval);
      }
    }, 1000); // poll every 1s

    return () => clearInterval(interval);
  }, [jobId]);

  return { events, status };
}
```

### 6.2 Event Renderer Component

The stream-json output contains these event types and how to render each:

```
stream-json event                 Web UI rendering
──────────────────────────────────────────────────────────────────
text_delta                     →  Append to markdown buffer, render with react-markdown
tool_use (Read)                →  📄 "Reading src/auth.ts" — collapsible file viewer
tool_use (Edit)                →  ✏️  "Editing src/auth.ts" — show diff (old vs new)
tool_use (Write)               →  📝 "Creating src/cache.ts" — show file content
tool_use (Bash)                →  ⬛ "Running: npm test" — terminal-styled block
tool_result                    →  Collapsible output panel under the tool call
result                         →  ✅ "Complete — $0.04 — 5.2s" — summary badge
status                         →  🔄 "Agent A starting..." — status indicator
```

```tsx
// components/AgentEventRenderer.tsx
import ReactMarkdown from 'react-markdown';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';

interface Props {
  events: AgentEvent[];
}

export function AgentEventRenderer({ events }: Props) {
  // Group events by agent phase
  const phases = groupByAgent(events);

  return (
    <div className="space-y-6">
      {phases.map((phase) => (
        <AgentPhase key={phase.agent} phase={phase} />
      ))}
    </div>
  );
}

function AgentPhase({ phase }) {
  // Accumulate text_delta events into a single markdown string
  const markdownText = phase.events
    .filter((e) => e.event_type === 'text_delta')
    .map((e) => e.text)
    .join('');

  const toolCalls = phase.events.filter((e) => e.event_type === 'tool_use');
  const toolResults = phase.events.filter((e) => e.event_type === 'tool_result');
  const result = phase.events.find((e) => e.event_type === 'result');

  const agentLabel = {
    A: 'Agent A — Session A.1',
    B: 'Agent B — Session B.1',
    A_RESUMED: 'Agent A — Session A.1 (Resumed)',
  }[phase.agent];

  return (
    <div className="border rounded-lg p-4">
      <h3 className="font-semibold text-lg mb-3">{agentLabel}</h3>

      {/* Tool calls */}
      {toolCalls.map((tc, i) => (
        <ToolCallBlock
          key={i}
          name={tc.tool_name}
          input={tc.tool_input}
          output={toolResults[i]?.tool_output}
        />
      ))}

      {/* Markdown response */}
      {markdownText && (
        <div className="prose prose-sm max-w-none mt-4">
          <ReactMarkdown
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '');
                return match ? (
                  <SyntaxHighlighter language={match[1]}>{String(children)}</SyntaxHighlighter>
                ) : (
                  <code className={className} {...props}>
                    {children}
                  </code>
                );
              },
            }}
          >
            {markdownText}
          </ReactMarkdown>
        </div>
      )}

      {/* Result badge */}
      {result && (
        <div className="mt-3 flex items-center gap-3 text-sm text-green-600">
          <span>✅ Complete</span>
          <span>💰 ${result.cost?.toFixed(4)}</span>
          <span>⏱ {(result.duration_ms / 1000).toFixed(1)}s</span>
          <span className="text-xs text-gray-400">Session: {result.session_id}</span>
        </div>
      )}
    </div>
  );
}

function ToolCallBlock({ name, input, output }) {
  const [expanded, setExpanded] = useState(false);

  const icons = {
    Read: '📄',
    Edit: '✏️',
    Write: '📝',
    Bash: '⬛',
    Grep: '🔍',
    Glob: '📂',
  };

  const parsedInput = (() => {
    try {
      return JSON.parse(input);
    } catch {
      return { raw: input };
    }
  })();

  // Display the most relevant input field
  const summary = parsedInput.file_path || parsedInput.command || parsedInput.pattern || name;

  return (
    <div className="my-2 border-l-2 border-blue-300 pl-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-sm font-mono text-blue-700 hover:underline"
      >
        <span>{icons[name] || '🔧'}</span>
        <span>
          {name}({summary})
        </span>
        <span className="text-gray-400">{expanded ? '▼' : '▶'}</span>
      </button>

      {expanded && output && (
        <pre className="mt-1 p-2 bg-gray-900 text-gray-100 text-xs rounded overflow-x-auto max-h-48">
          {output}
        </pre>
      )}
    </div>
  );
}

function groupByAgent(events: AgentEvent[]) {
  const phases: { agent: string; events: AgentEvent[] }[] = [];
  let current: (typeof phases)[0] | null = null;

  for (const event of events) {
    if (!current || current.agent !== event.agent) {
      current = { agent: event.agent, events: [] };
      phases.push(current);
    }
    current.events.push(event);
  }

  return phases;
}
```

### 6.3 Main Page

```tsx
// app/orchestrator/page.tsx
'use client';
import { useState } from 'react';
import { useAgentEvents } from '@/hooks/useAgentEvents';
import { AgentEventRenderer } from '@/components/AgentEventRenderer';

export default function OrchestratorPage() {
  const [promptA, setPromptA] = useState('');
  const [promptB, setPromptB] = useState('');
  const [workingDir, setWorkingDir] = useState('/Users/richie/projects/songster');
  const [jobId, setJobId] = useState<string | null>(null);

  const { events, status } = useAgentEvents(jobId);

  async function runPipeline() {
    const res = await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt_a: promptA,
        prompt_b: promptB,
        working_dir: workingDir,
      }),
    });
    const { job_id } = await res.json();
    setJobId(job_id);
  }

  return (
    <div className="max-w-4xl mx-auto p-6">
      <h1 className="text-2xl font-bold mb-6">Agent Orchestrator</h1>

      {/* Instruction Editors */}
      <div className="grid grid-cols-2 gap-4 mb-4">
        <div>
          <label className="block text-sm font-medium mb-1">Agent A Instructions</label>
          <textarea
            value={promptA}
            onChange={(e) => setPromptA(e.target.value)}
            rows={8}
            className="w-full border rounded p-3 font-mono text-sm"
            placeholder="You are Agent A. Review the auth module and..."
          />
        </div>
        <div>
          <label className="block text-sm font-medium mb-1">Agent B Instructions</label>
          <textarea
            value={promptB}
            onChange={(e) => setPromptB(e.target.value)}
            rows={8}
            className="w-full border rounded p-3 font-mono text-sm"
            placeholder="You are Agent B. Review Agent A's work and..."
          />
        </div>
      </div>

      {/* Config */}
      <div className="mb-4">
        <label className="block text-sm font-medium mb-1">Working Directory</label>
        <input
          value={workingDir}
          onChange={(e) => setWorkingDir(e.target.value)}
          className="w-full border rounded p-2 font-mono text-sm"
        />
      </div>

      {/* Run */}
      <button
        onClick={runPipeline}
        disabled={!promptA || !promptB || status === 'RUNNING_A'}
        className="bg-blue-600 text-white px-6 py-2 rounded font-medium disabled:opacity-50"
      >
        {status === 'IDLE' || status === 'COMPLETED' || status === 'FAILED'
          ? '▶ Run Pipeline'
          : `Running (${status})...`}
      </button>

      {/* Live Output */}
      {jobId && (
        <div className="mt-6">
          <h2 className="text-lg font-semibold mb-3">
            Pipeline Output
            <span className="ml-2 text-sm font-normal text-gray-500">Job: {jobId}</span>
          </h2>
          <AgentEventRenderer events={events} />
        </div>
      )}
    </div>
  );
}
```

---

## 7. Stream-JSON Event Reference

When the daemon runs `claude -p --output-format stream-json --verbose`, each line of stdout is a JSON object. These are the event types that matter for rendering:

### 7.1 Top-Level Message Types

| `type`         | When it appears                                       | What it contains                                                            |
| -------------- | ----------------------------------------------------- | --------------------------------------------------------------------------- |
| `system`       | Session start                                         | Model info, session config                                                  |
| `assistant`    | After each Claude turn                                | `message.content[]` — array of text blocks and tool_use blocks              |
| `stream_event` | During generation (with `--include-partial-messages`) | `event.delta.text` — individual tokens as they stream                       |
| `tool_result`  | After a tool executes                                 | `output` — the tool's stdout/return value                                   |
| `result`       | End of session                                        | `result` (final text), `session_id`, `cost_usd`, `duration_ms`, `num_turns` |

### 7.2 Tool Use Block (inside `assistant.message.content[]`)

```json
{
  "type": "tool_use",
  "id": "toolu_01DmJKv4gRW2TqAywfaXa7f1",
  "name": "Read",
  "input": {
    "file_path": "/Users/richie/projects/songster/src/audio/analyzer.ts"
  }
}
```

Tool names: `Read`, `Edit`, `Write`, `Bash`, `Grep`, `Glob`, `TodoWrite`, and any MCP tools (prefixed with `mcp__`).

### 7.3 Text Content (markdown)

Claude's response text arrives as markdown. For example, a response might contain:

```markdown
I found 3 issues in the auth module:

1. **Missing error handling** in `login()` — the catch block swallows errors silently
2. **Hardcoded secret** on line 42 — `JWT_SECRET` should come from env
3. **No rate limiting** — the endpoint accepts unlimited requests

Here's the fix for issue 1:

\`\`\`typescript
try {
const token = await authenticate(user);
return { success: true, token };
} catch (error) {
logger.error('Auth failed:', error);
throw new AuthenticationError(error.message);
}
\`\`\`
```

This is what `react-markdown` renders as the rich formatted output you saw in Cursor. The Cursor TUI does the same thing — it takes markdown and renders it with ANSI colors/formatting for the terminal. Your web app does the same with HTML/CSS.

---

## 8. Rendering Pipeline

```
Claude Code CLI                 Daemon                    Web App
──────────────                  ──────                    ───────

claude -p "..."
  --output-format stream-json
  --verbose
       │
       │ stdout (NDJSON)
       │
       ├── {"type":"stream_event",    ──▶  pushEvent()    ──▶  text_delta
       │    "event":{"delta":              to DynamoDB          append to markdown
       │    {"text":"I found"}}}                                buffer, render with
       │                                                        react-markdown
       ├── {"type":"assistant",       ──▶  pushEvent()    ──▶  tool_use
       │    "message":{"content":          to DynamoDB          show tool call UI
       │    [{"type":"tool_use",                                with icon + input
       │      "name":"Bash",
       │      "input":{"command":
       │      "npm test"}}]}}
       │
       ├── {"type":"tool_result",     ──▶  pushEvent()    ──▶  tool_result
       │    "output":"12 passed"}          to DynamoDB          collapsible output
       │                                                        panel
       ├── {"type":"result",          ──▶  pushEvent()    ──▶  result badge
       │    "session_id":"...",            to DynamoDB          ✅ $0.04, 5.2s
       │    "cost_usd": 0.04,
       │    "duration_ms": 5200}
       │
       ▼ (exit code 0)
```

---

## 9. What This Proves

When you run this system end-to-end, these facts are verifiable from the web UI:

1. **Instructions are dynamic** — You typed them in textareas. The daemon reads them from DynamoDB. Nothing is hardcoded.

2. **Agent A runs in session A.1** — The session_id is captured from the first `result` event and displayed in the UI.

3. **Agent B runs in session B.1** — Different session_id, receives only A's output as context.

4. **Agent A resumes session A.1** — The resumed session_id matches the original A.1 session_id. Agent A retains context from its first run (as proven by the secret token test).

5. **Responses flow back to the web app** — Every `text_delta`, `tool_use`, and `tool_result` event appears in the UI in real time, rendered as rich markdown.

6. **All sessions are stored** — The Jobs table has `result_a`, `result_b`, `result_a_resumed` with full text, costs, and session IDs. The Events table has the complete streaming log.

---

## 10. Setup Checklist

### AWS Side

- [ ] Create DynamoDB table `futurator-agent-orchestrator` (PK: string, SK: string)
- [ ] Create DynamoDB table `futurator-agent-events` (PK: string, SK: string, TTL on `expire_at`)
- [ ] Create GSI `status-created-index` on the jobs table (PK: `status`, SK: `created_at`)
- [ ] Add API routes to Futurator Next.js app
- [ ] Add Orchestrator page to Futurator Admin Hub

### Local Mac Side

- [ ] `npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb`
- [ ] Verify `claude --version` is 2.1.52+
- [ ] Verify `aws sts get-caller-identity` shows your account
- [ ] Run `node agent-daemon.mjs`
- [ ] (Optional) Set up as a launchd service for auto-start

### First Test

1. Open the Orchestrator page in your browser
2. Agent A: "Say hello and generate a random 6-digit secret token. Remember it."
3. Agent B: "Acknowledge what Agent A said. Add your own 4-digit token."
4. Working dir: any directory
5. Click Run Pipeline
6. Watch events stream in
7. Verify Agent A's resumed response recalls its secret token

---

## 11. Future Enhancements

- **WebSocket** instead of DynamoDB polling for sub-second latency
- **Multiple pipelines**: A → B → C → A, or parallel B+C then A resumes
- **Template library**: Save and reuse instruction templates (e.g. "Code Review", "Bug Fix", "Feature Build")
- **Cost dashboard**: Aggregate costs across jobs, per project
- **Session browser**: List all Claude Code sessions, resume any from the web
- **MCP integration**: Pass `--mcp-config` to connect Songster's audio analysis tools
- **Approval gates**: Pause between agents for human review before continuing
