# Develope-IT Command — Mobile Integration Spec (MVP)

> **Companion doc — read alongside [`debates-mobile-handoff.md`](./debates-mobile-handoff.md).**
> The Debates handoff (added 2026-04-30) covers the **read-and-continue-conversation** surface — Party Mode chat sessions with shareable URLs (`/debates?sessionId=<uuid>`). Same auth model, same Lambda, same polling pattern as below — different domain entity (`PartySession`/`PartyEvent` instead of epic/agent jobs). The two surfaces should ship as different tabs/screens in the same app.

## Scope

The mobile app does exactly three things:

1. **Voice → Text → POST** — operator speaks an app idea, phone transcribes it, sends it to the backend as a new epic
2. **Poll → Stream** — phone polls for agent events and renders the PM agent's work in real-time (tool calls, text output)
3. **Detect → Signal** — phone detects when the PM plan is complete and signals the operator (badge + in-app)

Everything else (dev agents, review, deploy, publish) stays on admin.futurator.ai for now.

> **Companion scope (Debates):** read & continue Party Mode debates from anywhere. See `debates-mobile-handoff.md` for the full URL contract, REST surface, event-stream cadence, agent roster, and parser handoff.

---

## What the Backend Needs to Expose

### Endpoint 1: Create Epic

The mobile app needs to submit a raw idea string and get back an epic ID to track.

```
POST /api/epics
Content-Type: application/json

{
  "idea": "Build me a recipe converter with unit toggles and favorites"
}
```

**Response:**
```json
{
  "epicId": "ep-abc123",
  "status": "pm_pending"
}
```

**What happens server-side:**
- Creates the epic record in DynamoDB (`epic-workflows` table)
- Creates the PM agent job in DynamoDB (`agent-jobs` table) with status `pending`
- The EC2 daemon picks it up on next poll (within 3s) and spawns the PM agent

**Does this exist already?**
Check how the admin hub's "Intent Design" button currently creates the epic. The mobile app needs to hit the same Lambda endpoint with the same payload shape. If the admin hub does this via a different mechanism (e.g., direct DynamoDB write from the frontend), then this endpoint needs to be created.

---

### Endpoint 2: Poll Agent Events

The mobile app needs to stream the PM agent's output in real-time — the same tool calls and text chunks that the admin hub renders.

```
GET /api/epics/{epicId}/events?after={lastEventTimestamp}
```

**Response:**
```json
{
  "events": [
    {
      "eventId": "evt-001",
      "timestamp": "2026-04-24T14:32:01.234Z",
      "type": "tool_call",
      "tool": "Read",
      "args": { "file": "requirements.md" },
      "agentRole": "pm"
    },
    {
      "eventId": "evt-002",
      "timestamp": "2026-04-24T14:32:02.567Z",
      "type": "text",
      "content": "I'll structure this as a React application with three main components...",
      "agentRole": "pm"
    },
    {
      "eventId": "evt-003",
      "timestamp": "2026-04-24T14:32:05.891Z",
      "type": "status",
      "status": "pm_complete",
      "agentRole": "pm"
    }
  ],
  "cursor": "2026-04-24T14:32:05.891Z",
  "epicStatus": "pm_complete"
}
```

**Key design decisions:**

- **`after` cursor** — the mobile app passes the timestamp of the last event it received. The backend returns only newer events. This keeps payloads small and lets the phone poll every 2-3 seconds without downloading the full history each time.
- **`epicStatus` in every response** — the mobile app uses this to detect when the PM phase is done. When it flips from `pm_running` to `pm_complete`, the phone triggers the badge/notification.
- **`type: "status"` events** — the daemon should emit an explicit status event when the PM agent finishes (job completes or pipeline step ends). This is the phone's signal.

**Does this exist already?**
The admin hub already polls `agent-events` from DynamoDB. Check if there's an existing GET endpoint that returns events for an epic. If the admin hub reads DynamoDB directly from the frontend (via Cognito-scoped credentials), then this endpoint needs to be created as a Lambda route.

---

### Endpoint 3: List Epics (optional but useful)

For the dashboard view — the phone needs to know what epics exist and their current status.

```
GET /api/epics
```

**Response:**
```json
{
  "epics": [
    {
      "epicId": "ep-abc123",
      "name": "Recipe Converter",
      "status": "pm_complete",
      "createdAt": "2026-04-24T14:30:00Z",
      "updatedAt": "2026-04-24T14:35:00Z",
      "storySummary": { "total": 6, "done": 0 }
    }
  ]
}
```

**Does this exist already?**
The admin hub must have a way to list/display epics. Expose the same data via the Lambda API.

---

## What the Backend Does NOT Need to Change

- **EC2 daemon** — no changes. It already polls `agent-jobs` from DynamoDB and pushes events back. It doesn't care whether the job was created by the admin hub or the mobile app.
- **PM agent prompt/pipeline** — no changes. The PM agent receives the idea text the same way regardless of source.
- **DynamoDB schema** — no changes. The mobile app creates records with the same shape the admin hub does.
- **CloudFront/S3** — no changes. The mobile app is a separate repo, separate build, separate distribution.

---

## What the Mobile App Handles Locally

| Concern | How | Notes |
|---------|-----|-------|
| **Voice capture** | `expo-speech-recognition` or `@react-native-voice/voice` | On-device STT, no server round-trip |
| **Transcription display** | Local state, interim results update a text input | User can edit before sending |
| **Event polling** | `setInterval` every 2-3s on the events endpoint | Only while viewing an active epic |
| **Terminal rendering** | FlatList or ScrollView with monospace text | Tool calls as collapsed cards, text as streaming output |
| **Badge** | `Notifications.setBadgeCountAsync(n)` via `expo-notifications` | Increment on status change, clear on app foreground |
| **Plan-ready signal** | Detect `epicStatus === 'pm_complete'` in poll response | Trigger badge + in-app banner |

---

## MVP Data Flow

```
iPhone                          Lambda API                    DynamoDB                EC2 Daemon
  │                                │                            │                       │
  │  User speaks: "build me       │                            │                       │
  │  a recipe converter"          │                            │                       │
  │                               │                            │                       │
  │  expo-speech-recognition      │                            │                       │
  │  transcribes locally          │                            │                       │
  │                               │                            │                       │
  ├─ POST /api/epics ────────────►│                            │                       │
  │  { idea: "build me a..." }    ├─ putItem epic-workflows ──►│                       │
  │                               ├─ putItem agent-jobs ──────►│                       │
  │◄─ { epicId: "ep-123" } ──────┤                            │                       │
  │                               │                            │                       │
  │                               │                            │◄── daemon polls ──────┤
  │                               │                            │                       │
  │                               │                            │── job: pm, pending ──►│
  │                               │                            │                       │
  │                               │                            │   claude -p "..." spawns
  │                               │                            │                       │
  │  poll every 2s:               │                            │◄── putItem events ────┤
  ├─ GET /epics/ep-123/events ───►│                            │                       │
  │  ?after=0                     ├─ query agent-events ──────►│                       │
  │                               │◄─────────────────────────  │                       │
  │◄─ { events: [...],           │                            │                       │
  │     epicStatus: "pm_running"} │                            │                       │
  │                               │                            │                       │
  │  render tool calls + text     │                            │                       │
  │  in terminal view             │                            │                       │
  │                               │                            │                       │
  │  ... more polls ...           │                            │                       │
  │                               │                            │                       │
  │◄─ { events: [...],           │                            │                       │
  │     epicStatus: "pm_complete"}│                            │                       │
  │                               │                            │                       │
  │  setBadgeCountAsync(1)        │                            │                       │
  │  show "Plan Ready" banner     │                            │                       │
  │                               │                            │                       │
```

---

## Task for admin.futurator.ai

**Check and expose these three routes in the Lambda API (Hono router):**

1. `POST /api/epics` — accepts `{ idea: string }`, creates epic + PM job, returns `{ epicId }`
2. `GET /api/epics` — returns list of epics with status and story summary
3. `GET /api/epics/:epicId/events?after=:cursor` — returns new events since cursor, plus current `epicStatus`

**If these already exist** (even with slightly different shapes), document the exact request/response format so the mobile app can conform to it. Do not change the existing admin hub to accommodate the mobile app — the mobile app adapts to whatever the backend already speaks.

**If they don't exist**, implement them as new Hono routes in the existing Lambda function. They are thin wrappers around DynamoDB queries that the admin hub frontend already performs — the logic just moves behind the API boundary.

**One new requirement:** the daemon (or the Lambda's server-side YOLO logic) needs to emit a `type: "status"` event with `status: "pm_complete"` when the PM pipeline finishes. If this event doesn't already exist in `agent-events`, add it. This is the phone's only reliable signal that the plan is ready.

---

## CORS

The mobile app makes HTTP requests from a native context (not a browser), so CORS headers are technically not required. However, if the Lambda already serves CORS for admin.futurator.ai, no changes needed — the mobile app will work through the same headers or ignore them entirely.

If you later want to test from Expo Go in a web browser during development, ensure the Lambda returns:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

---

## Auth (defer for MVP)

For the MVP, the mobile app can call the Lambda API without auth — the same way the admin hub currently works if it's unauthenticated. If the Lambda requires Cognito JWT tokens, the mobile app will need to implement the Cognito auth flow via `aws-amplify` or direct `amazon-cognito-identity-js` calls. This is a known pattern you've already architected for the admin hub — replicate it in the Expo app when needed.

For now: ship without auth, lock it down after the flow works end-to-end.
