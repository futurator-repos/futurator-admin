# Debates — Mobile Integration Handoff

**Audience:** mobile developer agent building the Futurator companion app.
**Authoritative as of:** 2026-04-30.
**Backing system:** `admin.futurator.ai` (Lambda + DynamoDB + EC2 daemon, deployed via SST).

## TL;DR

- A "debate" is a Party Mode chat session — a conversation with a roster of BMAD agents about a specific App's codebase.
- Each debate now has its **own shareable URL**: `https://admin.futurator.ai/debates?sessionId=<uuid>`.
- The mobile app's job (MVP) is to give the operator a phone-friendly surface to **open, read, and continue** debates from anywhere. No new entities to design — the backend is fully built.
- All debate state is owned by the backend. The mobile app is a thin client over the REST API. No local persistence beyond auth tokens.

---

## URL Contract (browser canon — mirror it on mobile)

Static-export-safe (query params, since `next export` can't render dynamic path segments at build time):

| URL | Renders |
|---|---|
| `/debates` | Portfolio list — every debate the operator owns, grouped by App, newest activity first. |
| `/debates?sessionId=<uuid>` | **Full-screen chat for that debate.** This is the canonical permalink. Bookmarkable, shareable, refresh-safe. |
| `/labs?appId=<slug>&tab=party` | App-detail Party tab (desktop-oriented; shows the debate inside the App's full surface). |
| `/labs?appId=<slug>&tab=party&sessionId=<uuid>` | Same as above with a specific debate pre-opened. |

**Mobile deep-link strategy:** map your app's routes 1:1 to these. Recommended:
- `futurator://debates` → list
- `futurator://debates/<uuid>` → debate detail
- Universal links: `https://admin.futurator.ai/debates?sessionId=<uuid>` → opens app if installed, falls back to web. The sessionId UUID is the stable handle.

---

## Auth

- **Identity provider:** Identity Broker at `https://auth.futurator.ai/v1` (issuer for JWTs).
- **Flow:** OTP login → `POST /api/auth/exchange` → `{ accessToken, refreshToken, expiresAt }`.
- **Header:** `Authorization: Bearer <accessToken>` on every API call. **No cookies — never use cookies.** The Lambda's CORS does not allow `credentials: 'include'` either.
- **Token refresh:** `POST /api/auth/refresh` with `{ refreshToken }`. Refresh proactively when `expiresAt - now < 2 minutes` (the web app does this in `src/lib/api-client.ts`). Auto-retry once on `401`.
- **Logout:** `POST /api/auth/logout` (server-side revokes refresh token).
- **Public routes (no auth):** `/api/health`, `/api/auth/*`, `/api/public/projects`, `/api/github/status`. Everything else requires the bearer.

---

## Data Model (the entities the app touches)

### App
The product/codebase the debate is about. One App ≡ one working tree under `/home/ubuntu/projects/<appId>` on the EC2 daemon.

```ts
interface App {
  appId: string;              // slug, URL-safe, immutable
  displayName: string;
  icon?: string;              // single emoji
  workingDir: string;         // /home/ubuntu/projects/<appId>
  createdAt: string;          // ISO-8601
  updatedAt: string;
  boilerplateType?: 'nextjs' | 'sst' | 'vite' | 'mobile';
  bmadEnabled?: boolean;
  bootstrappedAt?: string;
  // ... plus a few fields the mobile app likely won't need (deployJobIds, etc.)
}
```

### PartyProject
The BMAD install registered for an App. Keyed by `projectId` which **equals `appId`** (1:1). This is what the daemon uses to route messages to the right working dir.

```ts
type BmadStatus =
  | 'MISSING' | 'INSTALLING' | 'HEALTHY' | 'DRIFTED' | 'CORRUPTED' | 'FAILED';

interface PartyProject {
  projectId: string;          // = appId
  path: string;               // /home/ubuntu/projects/<appId>
  bmadStatus: BmadStatus;
  bmadVersion?: string;
  agentCount?: number;
  expectedAgentCount: number; // currently 6 (BMAD 6.3.x stock install)
  lastInspectedAt?: string;
  failureReason?: string;
  allowedTools?: string[];    // optional toggle for WebSearch/WebFetch
  createdAt: string;
  updatedAt: string;
}
```

A debate can only run when `bmadStatus === 'HEALTHY'` (or `'DRIFTED'`). The web UI surfaces an "Enable Party Mode" CTA otherwise; the mobile app should treat non-HEALTHY apps as read-only and surface the same install affordance (or just hide them in v1).

### PartySession (the debate)
The shareable, durable artifact. **This is the entity the mobile app revolves around.**

```ts
type PartySessionStatus = 'ACTIVE' | 'PROCESSING' | 'IDLE' | 'ERROR' | 'ARCHIVED';

interface PartySession {
  sessionId: string;          // UUID — the canonical "debate ID"
  projectId: string;          // = appId — which App this debate is about
  projectPath: string;        // /home/ubuntu/projects/<appId>
  claudeSessionId: string | null; // internal — Claude CLI's --resume handle
  status: PartySessionStatus;
  turnCount: number;          // == "rounds" in UI
  lastTurnAt?: string;        // ISO-8601 — sort key for "recent" lists
  createdAt: string;
  topic?: string;             // user-editable title; null = "Untitled session"
  bmadVersionAtStart: string;
}
```

**Status semantics:**
- `IDLE` — agent finished, awaiting next user message. Default state.
- `PROCESSING` — agent is mid-turn. Show a typing/thinking indicator.
- `ACTIVE` — same idle baseline but flagged as "recent activity". Treat like IDLE for UX.
- `ERROR` — last turn failed. Show an error banner. Sending a new message starts a fresh round (server side handles recovery).
- `ARCHIVED` — read-only. Don't allow new messages.

### PartyEvent (chat content)
Events are append-only and indexed by `eventSeq` (zero-padded string). The mobile app polls them to render the conversation. **All chat content — user messages, agent responses, tool calls, errors — flows through this stream.**

```ts
type PartyEventType =
  | 'party.turn.user'              // user message
  | 'party.turn.started'           // agent starts processing
  | 'party.turn.assistant.token'   // agent streaming text chunk
  | 'party.turn.assistant.tool'    // agent invoked a tool (Read, Grep, WebSearch, etc.)
  | 'party.turn.assistant.agent'   // agent block boundary (which BMAD agent is "speaking")
  | 'party.turn.awaiting_user'     // turn complete, waiting for next user input
  | 'party.turn.completed'         // turn done
  | 'party.turn.error';            // turn failed

interface PartyEvent {
  jobId: string;                   // == sessionId for party events
  eventSeq: string;                // zero-padded, sortable; cursor for polling
  timestamp: string;               // ISO-8601
  eventType: PartyEventType;
  // type-specific payload (text, tool name, agent name, error reason, etc.)
  [key: string]: unknown;
}
```

### InlineQuestion (text-selection Q&A — new feature)
The web client has a "highlight text → ask" mini-panel that calls Anthropic Haiku directly via the Lambda (not via the Claude CLI / daemon path). Each Q&A is anchored to a specific round + snippet so it can be jumped to. **Mobile MVP: read-only display + ability to ask.** Highlighting on phone is awkward; consider a "tap to ask about this paragraph" affordance instead.

```ts
interface InlineQuestionAnchor {
  roundId: string;                 // r-1, r-2, ... (1-indexed round)
  agentName?: string;              // optional — which BMAD agent's text
  snippet: string;                 // the highlighted text (≤4000 chars)
  contextBefore: string;           // ±40 chars for disambiguation
  contextAfter: string;
}

interface InlineQuestion {
  questionId: string;
  sessionId: string;               // FK to PartySession
  projectId: string;
  createdAt: string;               // sort key, newest first
  createdBy: string;               // userId
  anchor: InlineQuestionAnchor;
  question: string;
  answer: string;                  // populated synchronously on POST
  model: string;                   // 'claude-haiku-4-5'
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}
```

---

## REST API (every endpoint the mobile app needs)

Base URL: `https://admin.futurator.ai/api` (or the Lambda Function URL — both work; the admin-domain path is preferred for CORS).

### Listing & navigation

```
GET /apps                                       → AppCardData[]
GET /apps/:appId                                → { app, plans, activePlan, recentDeploys }
GET /party/projects                             → { projects: PartyProject[], expectedAgentCount }
GET /party/projects/:projectId                  → PartyProject
GET /party/projects/:projectId/sessions         → { sessions: PartySession[] } (for one App)
GET /party/sessions                             → { sessions: PartySession[] } (ALL, newest first — backs /debates)
```

### Session lifecycle

```
POST /party/sessions                            { projectId, topic? }
                                                → PartySession (newly created)

GET  /party/sessions/:id                        → PartySession

PATCH /party/sessions/:id                       { topic: string | null }
                                                → PartySession (rename; null clears)

POST /party/sessions/:id/messages               { content: string }   (≤8192 bytes UTF-8)
                                                → { jobId, sessionId } (turn enqueued)
```

### Event stream (chat content)

```
GET /party/sessions/:id/events                  query: ?after=<eventSeq>
                                                → { events: PartyEvent[], lastSeq: string }
```

**Polling cadence (mirrors web):**
- 600 ms while `session.status === 'PROCESSING'` (live streaming).
- 600 ms after a token-burst event (more likely on the way).
- 2 s when `IDLE` / `ACTIVE`.
- **Stop polling** entirely once status is terminal-ish AND no in-flight burst — wakes only on user-driven sends.

The cursor is `lastSeq` from the previous response. Pass it as `?after=<lastSeq>` next call. Initial call: `?after=000000`.

There is **no SSE** for party events — Lambda Function URLs don't support long-lived connections cleanly. Polling is the contract.

### Inline Q&A (Anthropic-backed)

```
POST /party/sessions/:id/inline-questions       { question, anchor: InlineQuestionAnchor }
                                                → InlineQuestion (synchronous; ~1–2s; uses Anthropic Haiku 4.5)

GET  /party/sessions/:id/inline-questions       → { questions: InlineQuestion[] } (newest first)
```

**Note:** these calls happen on the Lambda using a server-held `ANTHROPIC_API_KEY` SST secret. The mobile app never sees a key. Errors from upstream Anthropic surface as `502` (server) or `429` (rate limit) with `{ code, message }`. Handle them like any other API error.

### Doc tray (per-debate file uploads)

Two-step upload — get a presigned S3 URL, PUT the bytes, then notify the daemon to rsync the file into the project worktree so Claude's `Read` tool can see it.

```
POST /party/projects/:id/docs/upload-url        { filename, contentType }
                                                → { uploadUrl, s3Bucket, s3Key, filename }

PUT  <uploadUrl>                                <bytes>   (5-min expiry; direct to S3)

POST /party/projects/:id/docs/synced            { filename, s3Key }
                                                → { jobId, filename }   (daemon job enqueued)

GET  /party/projects/:id/docs                   → { projectId, docs: PartyDoc[] }

DELETE /party/projects/:id/docs/:filename       → 204
```

**Allowed content types:** `text/plain`, `text/markdown`, `text/x-markdown`, `application/pdf`, `application/json`, `text/csv`, `application/yaml`, `text/yaml`. **Max 10 MiB per file.** Filename is sanitized server-side (`[^\w.\-]` → `_`, capped at 200 chars).

**Where the file ends up:** `s3://futurator-ai-website/party-docs/<projectId>/<filename>` (durable) AND `/home/ubuntu/projects/<projectId>/docs/<filename>` (live, read by the agents).

**To make agents see the file in a turn:** prepend `[Attached: ./docs/<filename>]` to the user's message, OR ensure the message text references the filename. The web client does this automatically — mobile should too.

---

## Rendering chat content (the part that takes effort)

Agent responses come through as a stream of `party.turn.assistant.token` events with text deltas. They're punctuated by `party.turn.assistant.agent` markers that delimit which BMAD agent is "speaking" — the marker format is:

```
\n\n⟪AGENT:Name⟫\n
```

…where `Name` is from a fixed roster (see below). The web parser is at `src/components/labs/party/turn-parser.ts` — port the logic, don't reinvent it.

**Roster (case-sensitive, exact spelling):**

```
BMad Master, BMad Builder, Mary, John, Sally, Winston, Amelia, Paige, Bob,
Murat, Carson, Dr. Quinn, Maya, Victor, Sophia, Ludwig, Pedrock, Dave ups!,
Sean Tinel, Nimbus, Kube Rick, Sue Render, Rick.
```

There's also a `⟪SYSTEM⟫` marker for orchestrator notes. Anything else between markers is normal GFM markdown — render with your preferred markdown renderer.

**Legacy fallback:** older sessions use `📋 **Name:**` headers. Match `(?:[\p{Emoji}\s]*)\*\*([A-Za-z .!]+):\*\*` and validate the name against the roster (lowercase compare). Reject misses to avoid catching `**My take:**`-style false positives.

**Rounds:** every `party.turn.user` event opens a new round; ID is `r-<turnCount>`. The mobile UI should at minimum group bubbles by round — the web UI shows a "Round N" divider.

---

## Real-world considerations for the phone app

### What "open the debate URL" should do
1. Authenticate (resume from stored refresh token, or kick off OTP flow).
2. `GET /party/sessions/<uuid>` — if 404, show "debate not found / archived". If 200, proceed.
3. `GET /party/sessions/<uuid>/events?after=000000` — render the historical conversation.
4. Start the polling loop at the cadence above.

### What "send a message" should do
1. `POST /party/sessions/<uuid>/messages` with `{ content }`.
2. Optimistically render the user bubble; the server will echo it back as a `party.turn.user` event with a real `eventSeq`.
3. The session flips to `PROCESSING`; ramp up polling to 600 ms.
4. Token-stream events arrive; render incrementally.
5. `party.turn.completed` lands; status returns to `IDLE`; back off polling.

### Layout suggestions (not prescriptive)
- **Default landing surface = the chat itself.** The list of debates is the secondary screen. People come to the app to continue a conversation, not to browse.
- **Round dividers are valuable** — long debates get long. Make them collapsible.
- **Don't try to port the desktop's three-pane layout.** The web has Left (chat history per round) | Main (conversation) | Right (rounds + inline Q&A). On phone, collapse to a single column and put rounds + Q&A behind a drawer / bottom sheet.
- **Sessions list within a debate** (the left pane on web) → secondary action, accessible from a header menu, not always-on.

### Push notifications (future, not in MVP)
Not built yet. When it lands, it'll be opt-in per session. The trigger event is `party.turn.completed` for sessions the user has subscribed to. **Do not poll while backgrounded** — drain on resume.

### What the mobile app does NOT do
- No agent orchestration (that's the EC2 daemon).
- No direct Anthropic API calls (key is server-held).
- No write access to App definitions, plans, or pipelines (those are admin-only).
- No editing of past messages (the daemon's `--resume` model is append-only).

---

## Architecture diagram (one screenful)

```
┌──────────────┐  HTTPS + Bearer JWT  ┌──────────────────────┐
│  Mobile app  │ ───────────────────▶ │  Lambda (Hono API)   │
│              │                       │  admin.futurator.ai  │
│  - Login     │ ◀─── JSON, REST ──── │                      │
│  - List      │                       │  - JWT validation    │
│  - Chat      │                       │  - DDB reads/writes  │
│  - Send msg  │                       │  - Anthropic SDK     │
│  - Poll evt  │                       │  - S3 presign        │
└──────────────┘                       └────────┬─────────────┘
                                                │ enqueue agent-jobs
                                                ▼
                                        ┌─────────────────────┐
                                        │  DynamoDB           │
                                        │  - party-sessions   │
                                        │  - party-projects   │
                                        │  - agent-events     │
                                        │  - inline-questions │
                                        │  - agent-jobs       │
                                        └────────┬────────────┘
                                                 │ poll for PENDING jobs
                                                 ▼
                                        ┌─────────────────────┐
                                        │  EC2 daemon         │
                                        │  (Node 22 systemd)  │
                                        │                     │
                                        │  - spawns Claude    │
                                        │    CLI subprocesses │
                                        │  - rsyncs docs      │
                                        │  - writes events    │
                                        └─────────────────────┘
```

The mobile app talks **only** to the Lambda. It doesn't know the EC2 daemon exists; the daemon is invisible behind the agent-jobs queue.

---

## Pitfalls / things mobile devs hit

- **CORS lives at the Lambda Function URL level.** If a request fails preflight, the fix is in `sst.config.ts`, not in Hono. (Recent example: PATCH was missing from `allowMethods` and silently broke session rename + tool-toggle. Fixed 2026-04-30.)
- **`message.content` is plain text up to 8192 bytes UTF-8.** Auto-prepending `[Attached: ./docs/...]` lines counts toward that. If you also auto-quote selected text or add a system header, watch the size.
- **Polling cadence matters.** Phones hate 600ms polls when backgrounded — ramp the cadence way down (or stop) on `applicationDidEnterBackground` and resume on foreground.
- **Token refresh races.** `api-client.ts` on web serializes refreshes via a single in-flight promise — without it, two simultaneous 401s spawn two refreshes and one of the tokens gets revoked. Mirror that pattern.
- **Event polling cursors are strings, not numbers.** They're zero-padded for sortability. Don't `parseInt` them.
- **Sessions can have `claudeSessionId === null`** — that means turn 0 (newly created, never sent a message). Treat the chat as empty until the first `party.turn.user` event arrives.
- **`status` lags by a tick** after the last `party.turn.completed` event. Don't gate "stop polling" on `status === 'IDLE'` alone; gate on "no events received in last 2 polls AND status is non-PROCESSING".
- **The roster is fixed.** New names won't appear in chat; if you see one, it's a parser bug or the daemon shipped a new agent we forgot to whitelist on the client. Drop unknown markers silently.

---

## Open questions / decisions for the mobile dev

1. **Native-only, or React Native sharing the existing turn-parser?** Reusing the parser saves a port; rewriting in Swift/Kotlin gives a snappier UI.
2. **Offline read mode?** All event content is small text + structured tool calls. Caching the last N rounds for offline reading is cheap. Worth doing in v1?
3. **Voice input?** The existing `develope-it-mobile-integration-spec.md` has a voice → epic flow; reuse that transcription pipeline for sending Party messages?
4. **How to surface inline-Q on phone?** Suggested: long-press a paragraph → action-sheet with "Ask about this". Avoid trying to implement a desktop-style highlight + popover.
5. **Push notification trigger.** Recommend opt-in per debate (the `?subscribed` flag would land on `PartySession` server-side). Not built yet — call it out in your roadmap.

---

## Authoritative source-of-truth files (when in doubt, read these)

| File | What it tells you |
|---|---|
| `functions/api/index.ts` | Every endpoint above, exact params, exact response shapes |
| `functions/shared/types/party.ts` | Canonical types (mirrored client-side in `src/types/party.ts`) |
| `functions/shared/types/inline-question.ts` | Inline Q&A types |
| `src/components/labs/party/turn-parser.ts` | Stream parser (port to mobile or reuse via RN) |
| `src/components/labs/party/v2/session-chat-v2.tsx` | Reference UI for layout patterns + state machine |
| `src/lib/api-client.ts` | Auth refresh + 401 retry pattern — mirror this |
| `src/app/debates/page.tsx` | The web list/chat router; mirror its URL contract on mobile |
| `docs/deployment.md` | Backend deploy flow (read-only for mobile dev, but useful context) |

If a doc and the source disagree, **the source wins**. Update this handoff doc to match.
