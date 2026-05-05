# Develope-IT Mobile — Backend Handoff & Agent Brief

> **This file is meant to be dropped into the mobile-app repo as its `CLAUDE.md`**
> (or pasted into the mobile agent's first message). It tells a fresh Claude Code
> session in the mobile repo everything it needs to know about the backend it's
> integrating with — without needing to read the Futurator-Admin codebase.

---

## IDENTITY CHECK

When you start ANY session or task in this project, your very first message must begin with:

> 🟢 CLAUDE.md loaded — Develope-IT Mobile context active

## What this app is

**Develope-IT Mobile** is an iPhone companion to `admin.futurator.ai`'s Labs
module. Operator speaks an idea → phone transcribes it → POSTs to the Futurator
Lambda API → phone polls the PM agent's output and renders it in real time →
phone signals when the plan is ready.

**Scope (MVP, three things only):**

1. **Voice → Text → POST** — on-device STT, user can edit transcript, submit as a new *plan*.
2. **Poll → Stream** — poll the PM agent's events every 2–3s, render tool calls + text chunks as a terminal-style feed.
3. **Detect → Signal** — detect PM completion, badge the app icon + show in-app banner.

Everything else (dev agents, review, deploy, publish) stays on `admin.futurator.ai`.

## Mental model: the backend speaks "Plans", not "Epics"

The original mobile spec (`develope-it-mobile-integration-spec.md`) was drafted
against an older API. As of 2026-04-21 the Futurator-Admin backend was
reorganized around a first-class **Plan** object:

> One intent → one Plan → 1..N Epics → Stories → Waves.

The PM agent's job is to read the operator's raw `intent` string and emit a
structured Plan JSON blob listing epics + stories. **Plans are the unit the
mobile app creates and tracks.** Epic-level endpoints still exist but are
legacy — ignore them.

**Rule:** The mobile app adapts to the backend, not the other way around. Do
**not** ask the backend team to add `/api/epics` routes — everything below
already works with the existing Plan-centric API.

## Base URL

Production Lambda Function URL (set `API_BASE_URL` in mobile env):

```
https://<function-id>.lambda-url.us-east-1.on.aws
```

The exact host is the SST-deployed Lambda Function URL. Ask the Futurator-Admin
operator for the current value, or grep the admin production build for
`NEXT_PUBLIC_API_URL`. CORS on that Function URL currently allowlists
`admin.futurator.ai`, `futurator.ai`, and `localhost:3000` — **React Native
native builds ignore CORS, so this is a non-issue for iOS/Android builds.**
If you run Expo Web for dev, you'll hit CORS and need your origin added to the
`sst.config.ts` allowlist.

## Auth — required from day one

Every API route below `/api/*` requires `Authorization: Bearer <accessToken>`
except `/api/health`, `/api/auth/*`, and `/api/public/projects`.

Auth is via **Futurator Identity Broker** (OAuth + OTP). The mobile app needs:

1. **Obtain OTP code** — operator logs in via Identity Broker (out of band; follow whatever flow admin.futurator.ai uses — usually email OTP).
2. **Exchange OTP for tokens:**
   ```
   POST /api/auth/exchange
   Body: { "code": "<otp>" }
   Response: { accessToken, refreshToken, familyId, tokenId, expiresIn, user }
   ```
3. **Include on every subsequent request:**
   ```
   Authorization: Bearer <accessToken>
   ```
4. **Refresh proactively** (before expiration, e.g., <2 min remaining):
   ```
   POST /api/auth/refresh
   Body: { refreshToken, familyId, tokenId }
   Response: { accessToken, refreshToken, familyId, tokenId, expiresIn }
   ```
5. **On 401** — try refresh once, retry the original request, else bounce to login.

**Storage:** use `expo-secure-store` (Keychain on iOS, EncryptedSharedPreferences on Android). Never `AsyncStorage` for tokens.

## The three endpoints the mobile app actually uses

### 1. Create a plan (one-shot: plan row + PM job)

```
POST /api/plans/from-intent
Body: {
  "name": "recipe-converter",          // REQUIRED. kebab-case slug, 3–41 chars, /^[a-z][a-z0-9-]{2,40}$/
  "intent": "Build me a recipe converter with unit toggles and favorites",  // REQUIRED. min 10 chars
  "displayName": "Recipe Converter",   // optional, human-readable
  "rigor": "mvp"                        // optional: 'prototype' | 'mvp' | 'production' (default 'mvp')
}
Response (201): {
  "planId": "<uuid>",
  "pmJobId": "<uuid>",                  // POLL THIS
  "bmadJobId": "<uuid> | undefined",
  "plan": { ... full Plan object ... }
}
```

**`name` is the slug, locked forever at creation.** It becomes the EC2 folder
slug AND the deploy URL (`futurator.ai/apps/<name>/`). Generate it client-side
from the transcript — sanitize to kebab-case, prepend a letter if needed, and
dedupe by appending a short suffix if it collides (the API will return 400 on
collision).

**`pmJobId` is what you poll** — not `planId`. Hold onto both: `planId` for the
plan detail view, `pmJobId` for the live event stream.

### 2. Poll the PM agent's events

```
GET /api/agent-jobs/:jobId/events?after=<cursor>
Response: {
  "events": AgentEvent[],
  "lastSeq": "000042"                   // pass this as `after` on the next poll
}
```

First call: `after=000000`. `lastSeq` is a zero-padded 6-digit string — pass it
back verbatim. Events are returned in seq order; payloads are small because
only new events flow through.

**Poll cadence:** 2–3s while the detail view is foregrounded. Stop polling when
the job reaches a terminal state (see §3 below) or when the view backgrounds.

**AgentEvent shape (the fields you care about):**

```ts
interface AgentEvent {
  jobId: string;
  eventSeq: string;       // "000042" — cursor value
  seq: number;            // numeric version of eventSeq
  timestamp: string;      // ISO 8601
  stepId: string;         // pipeline step (e.g., 'pm-plan')
  agentId: string;        // 'PM' for PM-plan jobs; mobile can display this
  eventType:
    | 'text_delta'        // streaming assistant text — concatenate .text
    | 'tool_use'          // agent invoked a tool — render .toolName + .toolInput as a collapsed card
    | 'tool_result'       // tool output — render .toolOutput inside the matching card
    | 'status'            // step milestone — .text describes it
    | 'step_start'        // pipeline step began
    | 'step_complete'     // pipeline step finished
    | 'step_error'        // pipeline step errored
    | 'result';           // final result block (.cost, .durationMs available)
  text?: string;          // text_delta | status
  toolName?: string;      // tool_use
  toolInput?: string;     // tool_use
  toolOutput?: string;    // tool_result
  cost?: number;          // result | step_complete
  durationMs?: number;    // result | step_complete
}
```

**What to render:**
- `text_delta` → append `.text` to a running text buffer (monospace terminal view).
- `tool_use` → render a collapsed card with `toolName` as the header and `toolInput` (truncated JSON) as the body. Common tools to pretty-label: `Read`, `Write`, `Edit`, `Grep`, `Bash`, `WebFetch`.
- `tool_result` → attach `.toolOutput` to the most recent `tool_use` card with the same `stepId`.
- `status` → render as a muted system-message line.
- `step_start` / `step_complete` / `step_error` → section dividers.

**Ignore** the rest for MVP (they're orchestrator internals for multi-story epics — PM-plan jobs shouldn't emit them).

### 3. Detect "plan ready"

**There is no `pm_complete` event in the stream** (as of 2026-04-24). The
daemon marks `agent-jobs.status → 'COMPLETED'` but doesn't emit a corresponding
terminal event row.

**Mobile's workaround:** in parallel with the events poll, hit:

```
GET /api/agent-jobs/:jobId
Response: {
  "jobId": ...,
  "status": "PENDING" | "RUNNING" | "COMPLETED" | "FAILED",
  "updatedAt": ...,
  ...
}
```

Watch for `status === 'COMPLETED'`. When it flips:

1. Do **one final** events poll to flush anything in flight.
2. Trigger the ready signal: `Notifications.setBadgeCountAsync(1)` + in-app banner.
3. Stop polling both endpoints.
4. (Optional, if mobile owns the full flow) call:
   ```
   POST /api/plans/:planId/apply-plan?jobId=<pmJobId>
   ```
   This parses the PM's `---PLAN_JSON---` block and materializes epic + story
   rows. **Skip for MVP** — the operator can hit "Apply plan" in
   admin.futurator.ai later. Only implement if the mobile flow needs to show
   the resulting epics/stories before the operator touches the admin.

### 4. List plans (dashboard view)

```
GET /api/plans
Response: PlanSummary[] = [
  {
    "planId": "<uuid>",
    "name": "recipe-converter",
    "displayName": "Recipe Converter",
    "intent": "Build me a recipe converter...",
    "status": "concept" | "developing" | "fixing" | "review" | "delivered" | "archived",
    "totalStories": 6,
    "doneStories": 0,
    "totalCostUsd": 0.42,
    "createdAt": "2026-04-24T14:30:00Z",
    "updatedAt": "2026-04-24T14:35:00Z",
    "deployUrl": "https://futurator.ai/apps/recipe-converter/"  // set once deployed
  }
]
```

For plan detail (full epics + stories), use `GET /api/plans/:planId`.

## End-to-end flow (reference)

```
iPhone                          Lambda API                                EC2 Daemon
  │                                │                                        │
  │  [operator speaks]             │                                        │
  │  expo-speech-recognition       │                                        │
  │  → "Build me a recipe          │                                        │
  │     converter"                 │                                        │
  │                                │                                        │
  │  generate slug: "recipe-       │                                        │
  │  converter"                    │                                        │
  │                                │                                        │
  ├─ POST /api/plans/from-intent ─►│                                        │
  │  { name, intent }              ├─ putItem plans ──►                     │
  │                                ├─ putItem agent-jobs (pmJobId) ──►      │
  │◄─ { planId, pmJobId, plan } ──┤                                        │
  │                                │                          ◄── poll ─────┤
  │                                │                          ◄── pmJob ────┤
  │                                │                          claude CLI spawns
  │                                │                                        │
  │  setInterval(2500ms):          │                           ◄── events ──┤
  ├─ GET /agent-jobs/:pmJobId/     │                                        │
  │   events?after=<lastSeq> ─────►│                                        │
  │                                ├─ query agent-events ──►                │
  │◄─ { events, lastSeq } ─────────┤                                        │
  │                                │                                        │
  │  render text_delta + tool_use  │                                        │
  │                                │                                        │
  │  setInterval(2500ms):          │                                        │
  ├─ GET /agent-jobs/:pmJobId ────►│                                        │
  │◄─ { status: 'RUNNING' } ───────┤                                        │
  │  ... repeat ...                │                                        │
  │                                │                        job COMPLETED ──┤
  │◄─ { status: 'COMPLETED' } ─────┤                                        │
  │                                │                                        │
  │  setBadgeCountAsync(1)         │                                        │
  │  show "Plan Ready" banner      │                                        │
  │  stop polling                  │                                        │
```

## Tech stack (recommended, not mandated)

- **Expo SDK** (managed workflow, EAS Build for iOS).
- **`expo-speech-recognition`** for on-device STT (preferred) — or `@react-native-voice/voice` if you need deeper control. No server-side STT; audio never leaves the phone.
- **`expo-secure-store`** for tokens.
- **`expo-notifications`** for `setBadgeCountAsync` + in-app banners.
- **React Query (`@tanstack/react-query`)** for the polling loops — `refetchInterval: 2500` is the natural fit.
- **NativeWind or Tamagui** for styling (pick one, don't mix).
- **Zustand** for local UI state.

## Backend assumptions (document these as you discover drift)

- Routes and shapes above are accurate as of 2026-04-24. If a response shape
  differs, **trust the live API** and update this doc — do not ask the backend
  to change.
- `agentId: 'PM'` is the convention for PM-plan jobs but isn't a hard contract.
  If you see other values on a `from-intent`-created job, log them and render
  verbatim.
- There is no webhook / push mechanism. Polling is the only option.
- No pagination on `/events` — `after` is the only scoping. For very long PM
  runs the single response could grow; the API hasn't set a cap as of this
  writing. If you hit >1MB responses in practice, file a bug to add a `limit`
  query param.

## Gotchas

- **Slug collisions return 400.** Generate the slug client-side; on 400,
  append `-2`, `-3`, etc., and retry. Don't auto-generate silently — show the
  slug to the operator before submit so they can edit it.
- **`intent` < 10 chars is rejected.** Block submit client-side when the
  transcript is too short rather than let the API 400.
- **Polling while backgrounded drains battery fast.** Pause polls on
  `AppState` change to `background`, resume on `active`. On resume, do one
  immediate poll (don't wait 2.5s).
- **Tokens expire at ~1 hour.** The app will be useless the next morning if
  you don't implement refresh. Build the refresh flow before shipping the
  first TestFlight.
- **The slug locks at creation.** There is no rename endpoint. Operator cannot
  fix a typo after submit — warn them on the confirmation screen.

## What NOT to build for MVP

- User management / team features — single-operator app.
- Epic/story editing — read-only views of what the PM produced.
- Dev/review/deploy controls — those stay on admin.futurator.ai.
- Push notifications from a backend — badge + local in-app banner only.
- Offline support — if there's no network, fail the request and show a retry button.

## When you get stuck

- API shape drift → verify against `functions/api/index.ts` in the
  Futurator-Admin repo. The routes above link to line numbers at time of writing.
- Auth issues → reference `src/lib/api-client.ts` in Futurator-Admin for the
  proactive-refresh pattern (adapt to native).
- Events rendering → reference `src/hooks/use-agent-events.ts` and
  `src/components/labs/agentic-workflow/` in Futurator-Admin for how the admin
  hub consumes the same stream.

---

*Backend reference: `/Users/ricardoarayafarias/GetReal/Futurator-Admin` (git, main branch).
Upstream spec: `docs/concepts/develope-it-mobile-integration-spec.md`.*
