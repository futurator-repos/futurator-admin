# Futurator Agent Daemon

Local daemon that polls DynamoDB for pending agent orchestrator jobs and executes them using the Claude Code CLI.

## Prerequisites

- **Node.js 20+**
- **Claude Code CLI** installed and authenticated via OAuth (`claude auth login`)
- **AWS credentials** configured (`~/.aws/credentials` or env vars) with DynamoDB read/write access to `futurator-agent-jobs` and `futurator-agent-events` tables

## Setup

```bash
cd daemon
cp .env.example .env
# Edit .env — table names should already be correct if you used explicit names
npm install
```

## Run

```bash
npm start
# or with auto-restart on file changes:
npm run dev
```

The daemon will:

1. Poll `futurator-agent-jobs` every 3s for `PENDING` jobs
2. Execute the A → B → A(resumed) pipeline using `claude -p`
3. Stream events to `futurator-agent-events` in real time
4. Mark the job as `COMPLETED` or `FAILED`

## How it works

```
Web App → creates PENDING job in DynamoDB
Daemon  → picks up job, spawns `claude -p "..." --output-format stream-json`
        → parses NDJSON output, pushes each event to DynamoDB
        → Agent A runs → Agent B runs with A's output → Agent A resumes with B's feedback
Web App → polls events table, renders live output
```

No inbound ports are opened on your Mac. The daemon only makes outbound calls to DynamoDB.

## Stopping

Press `Ctrl+C`. The daemon will gracefully mark any in-progress job as `FAILED` before exiting.
