# Observability Spine Contract

Companion to `docs/concepts/epic-orchestrator-architecture.md` Section 9. Specifies the exact shape of every interface between the orchestrator subagent, the daemon forwarder, the DynamoDB event store, and the UI read-side. Phase 2 of the implementation plan consumes this doc directly.

> **Goal:** any event emitted by any subagent during an epic-dev job lands in DynamoDB keyed correctly, within ~1s, without losing ordering, without requiring AWS credentials inside the subagent sandbox, and survives daemon crashes without duplicates.

---

## 1. Existing infrastructure (reused)

| Resource                | Detail                                                                                                                                         |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| DynamoDB table          | `futurator-agent-events` (via `TABLE_NAMES.agentEvents`)                                                                                       |
| Partition key           | `jobId` (string)                                                                                                                               |
| Sort key                | `eventSeq` (zero-padded string, e.g. `"000042"`)                                                                                               |
| TTL attribute           | `expireAt` (epoch seconds, 7-day window)                                                                                                       |
| Existing writer         | `functions/shared/repositories/agent-events-repository.ts :: pushEvent()` — DynamoDB PutCommand                                                |
| Existing reader         | Same repo `getEventsAfter(jobId, afterSeq, limit=50)`                                                                                          |
| Existing API            | `GET /api/agent-jobs/:id/events?after=<seq>` (functions/api/index.ts:520)                                                                      |
| Daemon writer (current) | `pushEvent(jobId, stepId, agentId, eventType, data)` in `daemon/agent-daemon.mjs:157` — per-job monotonic seq via in-memory `jobEventSeqs` Map |

The spine extends this infra; it does not replace it.

---

## 2. Why a filesystem indirection

The epic orchestrator is itself a Claude CLI process running in a subagent sandbox with **no AWS credentials**. Direct DynamoDB writes are out. Options considered:

| Option                                                    | Rejected because                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Orchestrator uses `aws` CLI directly                      | Requires IAM creds or role-chaining into the subagent. Leaks blast radius.                                                      |
| Orchestrator POSTs to Lambda API with a service token     | Adds auth complexity and a network dependency for every event.                                                                  |
| Orchestrator writes to stdout; daemon parses              | Orchestrator's stdout is already the Claude CLI stream (tool messages, results). Would require deep parsing and lose structure. |
| **Orchestrator writes NDJSON to shared FS; daemon tails** | ✅ Chosen. Durable, sandbox-friendly, append-only, grep-friendly.                                                               |

The filesystem is the IPC. The daemon owns the AWS path.

---

## 3. `emit-event.sh` contract

### 3.1 Location and install

- **Source of truth in repo:** `scripts/emit-event.sh`
- **Runtime path on EC2:** `/opt/futurator/emit-event.sh` (symlinked or copied by the daemon's bootstrap step; orchestrator prompt references this absolute path)
- **Permissions:** `0755`, owned by the daemon user

### 3.2 Invocation contract

```bash
/opt/futurator/emit-event.sh '<event JSON>'
```

- **Arg 1:** a single JSON object, quoted as one shell argument. The orchestrator constructs it inline.
- **Exit code:** `0` on success, non-zero on malformed JSON, missing required fields, or disk failure. The orchestrator is instructed to ignore non-zero exits (emission is best-effort; missing events degrade UX, not correctness).
- **Side effects:** appends exactly one NDJSON line to `/var/log/futurator/events/<jobId>.ndjson`.
- **No stdout.** Script writes errors to stderr only.

### 3.3 Required input fields

The orchestrator populates these; the script validates presence:

```json
{
  "jobId": "epic-dev-job-<uuid>",
  "epicId": "EPIC-42",
  "waveNumber": 1,
  "role": "orchestrator" | "dev" | "reviewer",
  "eventType": "wave_start" | "subagent_dispatch" | ...,
  "payload": { ... }
}
```

### 3.4 Optional fields

```json
{
  "storyId": "STORY-7",
  "subagentId": "dev-STORY-7-wave1-attempt1",
  "attempt": 1,
  "correlationId": "EPIC-42/wave-1/STORY-7/dev/1",
  "ts": 1712345678901
}
```

- If `ts` is omitted, the forwarder stamps with server-side `Date.now()`.
- If `correlationId` is omitted, the forwarder composes it from the other fields.

### 3.5 Fields never supplied by the orchestrator

These are assigned by the forwarder:

| Field      | Assigned by | Why                                                   |
| ---------- | ----------- | ----------------------------------------------------- |
| `eventSeq` | Forwarder   | Must be monotonic per `jobId`; shell can't coordinate |
| `seq`      | Forwarder   | Numeric mirror of `eventSeq`                          |
| `expireAt` | Forwarder   | Centralizes TTL policy                                |

### 3.6 Implementation sketch

```bash
#!/bin/bash
set -euo pipefail

EVENT_JSON="$1"

# Validate JSON and extract jobId
if ! JOB_ID=$(printf '%s' "$EVENT_JSON" | jq -e -r '.jobId'); then
  echo "emit-event: invalid JSON or missing .jobId" >&2
  exit 2
fi

for f in epicId waveNumber role eventType; do
  if ! printf '%s' "$EVENT_JSON" | jq -e ".$f" > /dev/null; then
    echo "emit-event: missing required field .$f" >&2
    exit 3
  fi
done

LOG_DIR="${FUTURATOR_EVENT_LOG_DIR:-/var/log/futurator/events}"
mkdir -p "$LOG_DIR"

# Append a single line; rely on POSIX append-atomicity for lines < PIPE_BUF
printf '%s\n' "$EVENT_JSON" >> "$LOG_DIR/${JOB_ID}.ndjson"
```

**Atomicity note:** POSIX guarantees atomic appends for writes ≤ `PIPE_BUF` bytes (typically 4096). Events exceed this when `payload` is large (full diff embedded). Mitigation: the orchestrator never embeds full diffs in events — only summaries, counts, and digest hashes. Per-event size budget: 4 KB.

### 3.7 Failure modes

| Failure                     | Behavior                               | Recovery                                                                                 |
| --------------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------- |
| Disk full                   | `printf >> ...` fails, non-zero exit   | Orchestrator logs and continues; wave checkpoint still persists via HTTP. Operator page. |
| NDJSON file deleted mid-run | Next `>>` recreates it                 | Forwarder detects truncation (see §4.3), re-seeds offset to 0                            |
| Malformed JSON passed in    | `jq -e` fails, exit 2                  | Orchestrator's Bash invocation gets non-zero; event is lost — acceptable                 |
| Script missing on disk      | Orchestrator's Bash tool returns `127` | Job fails fast with `epic_failed` emitted via direct DDB fallback (see §7)               |

---

## 4. Daemon forwarder

Runs inside the existing `agent-daemon.mjs` process as a new module. Spawns on daemon startup; one instance per host.

### 4.1 Responsibilities

1. Discover NDJSON files for active jobs.
2. Tail each, line-by-line.
3. Parse, validate, enrich (assign `eventSeq`, `seq`, `expireAt`, stamp `ts` if missing).
4. Write to DynamoDB via existing repo.
5. Checkpoint file offset on successful write.
6. On restart, resume from checkpoint — zero duplicates, zero loss for committed lines.

### 4.2 Offset checkpointing

For each `<jobId>.ndjson`, maintain a sibling file `<jobId>.ndjson.offset` containing the last-forwarded byte offset as a decimal number.

```
/var/log/futurator/events/
  epic-dev-job-abc.ndjson
  epic-dev-job-abc.ndjson.offset    ← "41728\n"
```

Write protocol:

```
1. Read line from ndjson at offset N
2. Parse, enrich, assign eventSeq (in-memory counter + DDB bootstrap)
3. DynamoDB PutCommand with ConditionExpression: attribute_not_exists(eventSeq)
   - On ConditionalCheckFailedException: the line was already forwarded
     (e.g., crash between write and checkpoint) → skip silently
4. Update in-memory counter
5. fsync-write offset file to N + line-byte-length
```

The offset is written **after** the DynamoDB write. A crash between steps 3 and 5 causes the line to be retried on restart; step 3's `ConditionExpression` makes the retry idempotent.

### 4.3 Sequence assignment

Per-job monotonic counter lives in a `Map<jobId, number>` inside the forwarder. On first sight of a `jobId`:

1. Query DynamoDB for the highest existing `eventSeq` for this `jobId`.
2. Seed the counter with `max + 1`.
3. Cache for the rest of the process lifetime.

This coexists with the existing `jobEventSeqs` Map used by the daemon's own `pushEvent()`; the **forwarder writes through the same counter** so sequences are globally monotonic per job, regardless of whether the event came from the daemon (`compilation-started`, etc.) or the orchestrator's NDJSON.

### 4.4 Truncation detection

If `stat(ndjson).size < currentOffset`, the file was truncated or replaced. Reset offset to 0 and re-forward from the start. The `ConditionExpression` idempotency makes this safe.

### 4.5 Lifecycle

- **Start:** daemon startup scans `/var/log/futurator/events/*.ndjson`, begins tailing each.
- **New file:** detected via `fs.watch` on the dir; added to the tail pool.
- **Job complete:** when orchestrator writes `epic_complete` or job row transitions to `COMPLETED`/`FAILED`, forwarder processes remaining lines, then archives both files to `/var/log/futurator/events/archived/<jobId>/` (gzipped). Keeps the working dir clean.
- **Disk watermark:** if `/var/log/futurator/events` exceeds 1 GB, daemon emits a `diskPressure` alert and refuses new jobs until archived.

### 4.6 Concurrency

Tail loops run as independent `setInterval(fn, 250)` polls per file (250ms = UI real-time-enough, low CPU). No per-line async fan-out — serialized per file to preserve ordering.

Across files, the forwarder processes in parallel; each file is its own queue.

---

## 5. Local HTTP receiver (daemon-hosted)

Some orchestrator actions are request-response, not fire-and-forget, and need authoritative ACK. These use a local HTTP port (`127.0.0.1:{{daemonPort}}`, not exposed externally).

### 5.1 `POST /wave-complete`

Called once per wave after all verdicts land.

**Request:**

```json
{
  "jobId": "epic-dev-job-abc",
  "epicId": "EPIC-42",
  "wave": 1,
  "results": {
    "STORY-7": { "status": "APPROVED", "attempts": 1 },
    "STORY-8": { "status": "APPROVED", "attempts": 2 },
    "STORY-9": { "status": "BLOCKED", "blockerCode": "ambiguous-ac" }
  }
}
```

**Response:**

```json
{ "ok": true, "persistedAt": "2026-04-17T14:02:11.331Z" }
```

**Effect:** the daemon writes `waveResults[<wave>] = results` onto the job row in `agent-jobs` table via `agentJobsRepo.updateJob`. Crash-resume (Section 11 of the architecture doc) reads this back.

**Error handling:** orchestrator retries up to 3 times with exponential backoff. Persistent failure → the orchestrator emits `epic_failed` and exits; daemon will respawn from last known wave.

### 5.2 `POST /heartbeat`

Called every 30s by the orchestrator's Bash wrapper during long reviewer runs.

**Request:** `{ "jobId": "...", "ts": 1712345678901 }`
**Response:** `{ "ok": true }`
**Effect:** updates `agent-jobs` row `lastHeartbeatAt`. Daemon's stale-heartbeat detector (>5 min) uses this to trigger resume.

### 5.3 Port and binding

- Bound to `127.0.0.1:17631` (arbitrary chosen port, overridable via `FUTURATOR_DAEMON_PORT` env).
- No auth — loopback only. The EC2 security group never exposes it.
- Rendered into the orchestrator prompt as `{{daemonPort}}`.

---

## 6. DynamoDB schema extensions

The existing `AgentEvent` interface (`functions/shared/types/agent-orchestrator.ts`) needs additive fields. No breaking changes.

### 6.1 `AgentEventType` union — new variants

```ts
export type AgentEventType =
  // existing
  | 'text_delta'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'status'
  | 'step_start'
  | 'step_complete'
  | 'step_error'
  | 'extraction'
  | 'validation'
  | 'compilation-started'
  | 'compilation-completed'
  | 'compilation-failed'
  // new (epic-dev orchestrator)
  | 'epic_start'
  | 'epic_complete'
  | 'epic_failed'
  | 'wave_start'
  | 'wave_complete'
  | 'wave_split'
  | 'wave_collision'
  | 'subagent_dispatch'
  | 'subagent_return'
  | 'dev_blocker_reported'
  | 'story_blocked'
  | 'blocker_resolved'
  | 'touch_points_expanded'
  | 'context_expanded'
  | 'review_verdict'
  | 'remediation_start'
  | 'story_failed_terminally';
```

### 6.2 `AgentEvent` interface — new optional fields

```ts
export interface AgentEvent {
  // existing
  jobId: string;
  eventSeq: string;
  seq: number;
  timestamp: string;
  stepId: string;
  agentId: string;
  eventType: AgentEventType;

  // new (epic-dev)
  epicId?: string;
  waveNumber?: number;
  storyId?: string;
  role?: 'orchestrator' | 'dev' | 'reviewer';
  subagentId?: string;
  attempt?: number;
  correlationId?: string;
  payload?: Record<string, unknown>;

  // existing optional fields retained
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  cost?: number;
  sessionId?: string;
  durationMs?: number;
  expireAt?: number;
}
```

### 6.3 GSI considerations

Current table is `jobId`-keyed. Querying "all events for epic EPIC-42" today requires knowing `jobId`. Since one epic = one orchestrator job, this is fine — the epic row stores its `jobId`.

**Not adding a GSI on `epicId`.** Over-indexing for a read pattern we already satisfy via one lookup.

---

## 7. Direct-DDB fallback (daemon only)

There is exactly one case where the orchestrator cannot reach the filesystem: `emit-event.sh` is missing or unreadable. In that case, the daemon's startup verification refuses to dispatch the orchestrator and emits `epic_failed` itself via the existing `pushEvent()` path before the Claude subprocess ever spawns.

No other fallback exists. The NDJSON → forwarder → DDB path is the only emission path for orchestrator events.

---

## 8. Flat-log API endpoint

Grep-friendly plain-text view. Designed for paste-into-chat iteration.

### 8.1 Route

```
GET /api/epic-workflows/:epicId/flat-log
```

**Query params:**

| Param     | Default  | Purpose                                     |
| --------- | -------- | ------------------------------------------- |
| `since`   | `000000` | `eventSeq` floor (exclusive)                |
| `role`    | —        | filter: `orchestrator` / `dev` / `reviewer` |
| `storyId` | —        | filter to one story                         |
| `wave`    | —        | filter to one wave                          |
| `limit`   | `500`    | cap                                         |

### 8.2 Response

`Content-Type: text/plain; charset=utf-8`

One line per event, hierarchical correlation prefix:

```
EPIC-42/wave-1/-/orchestrator/-/epic_start  storyCount=4 totalWaves=2
EPIC-42/wave-1/-/orchestrator/-/wave_start  storyIds=[S-7,S-8,S-9,S-10]
EPIC-42/wave-1/S-7/orchestrator/-/subagent_dispatch  role=dev promptBytes=2341
EPIC-42/wave-1/S-7/dev/1/tool_use  Read src/use-costs.ts
EPIC-42/wave-1/S-7/dev/1/subagent_return  durationMs=42311
EPIC-42/wave-1/S-7/orchestrator/-/subagent_dispatch  role=reviewer
EPIC-42/wave-1/S-7/reviewer/1/review_verdict  verdict=REQUEST_CHANGES
  findings=[{severity:major,ruleId:R-TEST-001,description:"no test for error path"}]
EPIC-42/wave-1/S-7/orchestrator/-/remediation_start  targetFindings=1
EPIC-42/wave-1/S-7/dev/2/subagent_dispatch
...
```

### 8.3 Rendering rules

- Prefix: `{epicId}/wave-{N}/{storyId|-}/{role}/{attempt|-}/{eventType}`.
- Primary payload fields appear inline, space-separated, `key=value` form.
- Multi-line payloads (e.g., `findings`) indent with 2 spaces beneath the parent line.
- `-` is the explicit absence marker (no `undefined`, no empty).

### 8.4 Implementation location

Single Hono route in `functions/api/index.ts`. Reads via `agentEventsRepo.getEventsAfter` (already extant), renders via a new pure function `renderFlatLog(events: AgentEvent[]): string` colocated in `functions/shared/rendering/flat-log.ts`.

The event stream UI (existing) continues to use the JSON endpoint at `/api/agent-jobs/:id/events`. Flat-log is additive.

### 8.5 Auth

Standard Bearer JWT via `auth-middleware`. Same as all other `/api/epic-workflows/*` routes.

---

## 9. Event-emission ordering rules for the orchestrator

The orchestrator prompt instructs: "After every dispatch, every return, every verdict, every decision: emit." This section tightens what "after" means.

| Action              | Emit BEFORE         | Emit AFTER                                                                       |
| ------------------- | ------------------- | -------------------------------------------------------------------------------- |
| Invoke `Task` tool  | `subagent_dispatch` | —                                                                                |
| Receive Task result | —                   | `subagent_return`, then (conditional) `dev_blocker_reported` or `review_verdict` |
| Classify blocker    | —                   | `story_blocked` OR `touch_points_expanded` OR `context_expanded`                 |
| Split wave          | —                   | `wave_split`                                                                     |
| Detect collision    | —                   | `wave_collision`                                                                 |
| Start remediation   | `remediation_start` | —                                                                                |
| Finish wave         | —                   | `wave_complete` (after HTTP POST to `/wave-complete` returns 200)                |
| Exit epic           | —                   | `epic_complete` as final event before `<EPIC_COMPLETE>` write                    |

Ordering rationale: `subagent_dispatch` before the Task call means the UI animates the desk-lighting-up transition even for Tasks that time out.

---

## 10. Local dev vs EC2

| Concern                            | Local dev                                      | EC2 (production)               |
| ---------------------------------- | ---------------------------------------------- | ------------------------------ |
| NDJSON dir                         | `./tmp/events` (env `FUTURATOR_EVENT_LOG_DIR`) | `/var/log/futurator/events`    |
| Daemon port                        | `17631`                                        | `17631`                        |
| DynamoDB                           | real `futurator-agent-events` (not mocked)     | same                           |
| Script path in orchestrator prompt | `{{projectRoot}}/scripts/emit-event.sh`        | `/opt/futurator/emit-event.sh` |

The orchestrator prompt template has `{{emitEventScriptPath}}` rendered by the daemon based on environment.

---

## 11. Testing strategy

**Unit (Vitest):**

- `renderFlatLog([...])` against fixture events — deterministic snapshot.
- `assignEventSeq(jobId, existingMax)` — monotonic, no gaps on contention.
- NDJSON parse — rejects malformed lines, skips without halting tail.

**Integration:**

- Fake orchestrator script that writes N events via `emit-event.sh`; assert all land in DDB in order, no dupes after forced daemon restart mid-tail.
- Truncation simulation — delete NDJSON between tail polls; assert re-seed works.

**E2E (post-Phase 4):**

- Real epic-dev job with 2 stories; assert `/api/epic-workflows/:id/flat-log` returns grep-able output with every expected event in order.

---

## 12. Open items

1. **Log-rotation policy for NDJSON > 100 MB.** Unlikely to hit in normal epics (~10 KB/story typical), but an epic with 50 stories and heavy remediation could. Options: rotate via `logrotate(8)` + adjust offset tracking, or bound event size harder. Defer to first real incident.
2. **Multi-host EC2.** If we ever run >1 daemon host, each host has its own `/var/log/futurator/events`; the forwarder is host-local. Orchestrator + its NDJSON always live on the same host as the spawning daemon → safe for now. Revisit if scale-out ships.
3. **Flat-log pagination vs truncation.** Current contract: `limit=500`. Long epics exceed this. Follow-up: cursor-based pagination using `lastSeq` in a response header.

---

## 13. Implementation sequence

In order, to land in Phase 2 of the architecture doc:

1. `scripts/emit-event.sh` + install step in daemon bootstrap.
2. Extend `AgentEventType` union and `AgentEvent` interface (§6).
3. Add NDJSON forwarder module in `daemon/forwarder/` — consumed by `agent-daemon.mjs` at startup.
4. Add local HTTP receiver in daemon (Express or minimal http.createServer) for `/wave-complete` and `/heartbeat`.
5. Add flat-log endpoint + renderer to `functions/api/index.ts` and `functions/shared/rendering/flat-log.ts`.
6. Unit + integration tests per §11.
7. Smoke the full path end-to-end with a synthetic NDJSON producer before Phase 4 (epic-dev pipeline) lands.
