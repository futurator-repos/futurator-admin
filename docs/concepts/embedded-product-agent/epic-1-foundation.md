# Signal — Epic E1: Service Foundation (Tier 0)

> **Parent concept:** [concept.md](./concept.md)
> **Status:** Ready for dev
> **Goal of E1:** Drop the Signal widget onto _any registered app_ and capture
> bug/feature/question conversations to storage — no agentic resolution yet. This is the
> Tier 0 slice: the data spine, the public intake endpoint, the widget bundle, and the embed
> snippet. Lanes A/B/C resolution (E3–E5) build on top of this without re-embedding.
> **Last updated:** 2026-06-20

---

## Shared conventions (apply to every story)

These mirror existing Futurator-Admin patterns the codebase already uses — match them exactly.

- **IDs:** ULID, time-sortable. Helper already exists (`generateULID()` used by plans/jobs).
  Prefix by concern: `conv_<ulid>`, `proj is the existing projectId`, keys below.
- **DynamoDB:** `DynamoDBDocumentClient` from `/functions/shared/dynamo-client.ts`,
  `removeUndefinedValues: true`. Tables added in `sst.config.ts` via `new sst.aws.Dynamo(...)`,
  `PAY_PER_REQUEST`, name override, PITR on. Table names injected as env vars and surfaced in
  `TABLE_NAMES` in `dynamo-client.ts`.
- **Repositories:** pure functions in `/functions/shared/repositories/<concern>-repository.ts`.
  Signatures follow `agent-jobs-repository.ts`: `createX`, `getXById`, `listX...`,
  `updateXFields(id, fields: Partial<X>)` with dynamic `ExpressionAttributeNames/Values`.
- **Validation:** Zod schemas in `/functions/shared/schemas/`, always `.safeParse()`.
- **Errors:** `AppError` / `ValidationError` from `/functions/shared/errors.ts`. Envelope:
  `{ error: { code, message } }`.
- **Types:** `/functions/shared/types/<concern>.ts`.
- **Routes:** Hono app in `/functions/api/index.ts`. Authed routes use `authMiddleware`. Public
  routes must be added to the public-allowlist branch of the fallthrough middleware (currently
  only `/api/public/projects` bypasses auth).
- **No Hono CORS middleware** — CORS is set at the Lambda Function URL level in `sst.config.ts`.
- **Tests:** Vitest, jsdom, `@/` alias. Co-locate `*.test.ts` next to source or under `tests/`.

**Wave order:** S1.1 → (S1.2 ∥ S1.4) → S1.3 → S1.5. S1.1 is the spine; S1.2 (registry) and
S1.4 (widget) are independent and parallelizable; S1.3 depends on both; S1.5 ties it together.

---

## Story S1.1 — `signal-conversations` table + repository

**Goal:** The intake-organ data store. One conversation = one user session with the widget;
it holds the transcript, captured context, evidence pointers, and which intents were detected.

**Depends on:** nothing.

**Touch points:**

- `functions/shared/types/signal-conversation.ts` _(new)_
- `functions/shared/repositories/signal-conversations-repository.ts` _(new)_
- `functions/shared/dynamo-client.ts` — add `signalConversations` to `TABLE_NAMES`
- `sst.config.ts` — add `SignalConversationsTable` + wire env var into API + cron Lambdas
- `functions/shared/schemas/signal-conversation-schema.ts` _(new — shared with S1.3)_
- `tests/repositories/signal-conversations-repository.test.ts` _(new)_

**Spec:**

```ts
// types/signal-conversation.ts
export type SignalEnvironment = 'dev' | 'staging' | 'prod';
export type SignalIntent = 'bug' | 'feature' | 'question';
export type ConversationStatus = 'OPEN' | 'SCREENED' | 'ROUTED' | 'CLOSED';

export interface TranscriptMessage {
  role: 'user' | 'agent';
  text: string;
  ts: string;
}

export interface SignalConversation {
  conversationId: string; // PK, `conv_<ulid>`
  projectId: string; // tenant partition
  environment: SignalEnvironment;
  status: ConversationStatus; // OPEN on create
  createdAt: string; // ISO, GSI range key
  updatedAt: string;
  reporter: { userId?: string; anonId?: string; email?: string; consent?: boolean };
  page: { url: string; route?: string; appVersion?: string; gitSha?: string; buildId?: string };
  device: { browser?: string; os?: string; viewport?: string; dpr?: number; connection?: string };
  transcript: TranscriptMessage[];
  detectedIntents: SignalIntent[];
  evidence: {
    screenshotKey?: string;
    replayKey?: string;
    consoleLogKey?: string;
    networkLogKey?: string;
  };
  spawned: { bugReportIds: string[]; featureRequestIds: string[] }; // populated by E3/E4
  embeddingVector?: number[]; // populated by dedup in E3/E4
}
```

**Table (`sst.config.ts`):** PK `conversationId`. GSI `project-createdAt-index`
(hashKey `projectId`, rangeKey `createdAt`) for "recent conversations per app". Status is
filtered in-query at Tier 0 volume; add a `project-status-createdAt` composite GSI later if
volume warrants. Name: `futurator-signal-conversations`, PITR on.

**Repository functions:**

- `createConversation(c: SignalConversation): Promise<SignalConversation>` — `PutCommand`
- `getConversationById(id: string): Promise<SignalConversation | null>` — `GetCommand`
- `listConversationsByProject(projectId, opts?: { limit?; before? }): Promise<SignalConversation[]>` — `QueryCommand` on `project-createdAt-index`, `ScanIndexForward: false`
- `updateConversationFields(id, fields: Partial<SignalConversation>): Promise<void>` — dynamic `UpdateCommand`, always bumps `updatedAt`
- `appendTranscriptMessage(id, msg: TranscriptMessage): Promise<void>` — `UpdateCommand` `list_append` (idempotent-safe pattern from `appendWaveResult`)

**Acceptance criteria:**

- [ ] Table provisioned by `sst deploy`; env var reaches API Lambda; `TABLE_NAMES.signalConversations` resolves.
- [ ] All five repo functions implemented and exported as pure functions.
- [ ] `createConversation` strips undefined (no empty-string-key errors).
- [ ] `listConversationsByProject` returns newest-first, respects `limit`.
- [ ] Zod schema validates a well-formed conversation and rejects a malformed one.

**Tests:** unit-test each repo fn against a mocked `DynamoDBDocumentClient` (follow existing
repo test style); assert command shapes (PK/GSI, `list_append`, dynamic update expressions).

**Out of scope:** dedup/embedding population, bug/feature spawns (E3/E4).

---

## Story S1.2 — Project Registry + publishable key + origin allowlist

**Goal:** A registry of which projects may embed Signal, their public credentials, allowed
origins, onboarding tier, enabled lanes, theme, and per-env capture rules. This is the tenancy
spine — the public endpoint (S1.3) and config endpoint (S1.5) resolve everything through it.

**Depends on:** nothing (parallel with S1.1).

**Touch points:**

- `functions/shared/types/signal-registration.ts` _(new)_
- `functions/shared/repositories/signal-registrations-repository.ts` _(new)_
- `functions/shared/dynamo-client.ts` — add `signalRegistrations` to `TABLE_NAMES`
- `sst.config.ts` — add `SignalRegistrationsTable` (+ `publishableKey-index` GSI) + env var
- `functions/shared/schemas/signal-registration-schema.ts` _(new)_
- `functions/shared/signal/keys.ts` _(new — key generation)_
- `functions/api/index.ts` — authed admin CRUD routes (minimal; full UI is E2)
- `tests/repositories/signal-registrations-repository.test.ts` _(new)_

**Spec:**

```ts
export type OnboardingTier = 0 | 1 | 2 | 3; // REGISTERED → MIGRATED → GRAPHED → LIVE

export interface SignalRegistration {
  projectId: string; // PK (the existing Futurator projectId)
  publishableKey: string; // `sig_pub_<base62(16B)>` — public, embedded
  active: boolean;
  originAllowlist: string[]; // normalized origins, e.g. "https://applicator.ai"
  onboardingTier: OnboardingTier; // 0 at registration
  enabledLanes: SignalIntent[]; // default ['bug','feature','question']
  theme: { accent?: string; position?: 'right'; logoUrl?: string };
  captureRules: {
    // per environment
    dev: { replay: boolean; networkBodies: boolean };
    staging: { replay: boolean; networkBodies: boolean };
    prod: { replay: boolean; networkBodies: boolean }; // bodies:false in prod by default
  };
  createdAt: string;
  updatedAt: string;
}
```

**Key generation (`signal/keys.ts`):** `generatePublishableKey()` → `sig_pub_` + 16 random
bytes base62 (use `crypto.randomBytes`/`randomUUID`-derived; **server-side only**, never
client-generated). Keys are opaque identifiers, _not_ secrets — security comes from the
origin allowlist (S1.3), so a leaked publishable key alone can't post from an unlisted origin.

**Table:** PK `projectId`. GSI `publishableKey-index` (hashKey `publishableKey`) — the public
endpoints look up registrations by key. Name `futurator-signal-registrations`, PITR on.

**Repository functions:**

- `createRegistration(projectId, opts?): Promise<SignalRegistration>` — generates key, tier 0, sensible defaults
- `getRegistrationByProjectId(projectId): Promise<SignalRegistration | null>`
- `getRegistrationByPublishableKey(key): Promise<SignalRegistration | null>` — `QueryCommand` on GSI
- `updateRegistrationFields(projectId, fields): Promise<void>`
- `rotatePublishableKey(projectId): Promise<SignalRegistration>` — new key, old invalidated immediately
- `setOnboardingTier(projectId, tier): Promise<void>` — used by migration/graphify hooks later

**Admin routes (authed, minimal):**

- `POST /api/signal/registrations` `{ projectId }` → creates, returns registration + embed snippet
- `GET  /api/signal/registrations/:projectId`
- `PATCH /api/signal/registrations/:projectId` `{ originAllowlist?, enabledLanes?, theme?, active?, captureRules? }`
- `POST /api/signal/registrations/:projectId/rotate-key`

**Acceptance criteria:**

- [ ] Table + GSI provisioned; lookup-by-key works.
- [ ] Publishable keys generated server-side, unique, `sig_pub_` prefixed.
- [ ] Origins normalized on write (lowercase scheme+host, no trailing slash, no path).
- [ ] `createRegistration` defaults: tier 0, all lanes, prod `networkBodies:false`.
- [ ] Admin CRUD routes require auth and validate with Zod.
- [ ] `rotatePublishableKey` invalidates the old key (subsequent lookup misses).

**Tests:** repo unit tests (incl. GSI lookup, key uniqueness, origin normalization); route tests
asserting auth enforcement + validation rejects bad origins.

**Out of scope:** onboarding state-machine automation (E6), full registry UI (E2).

---

## Story S1.3 — Public intake endpoint (gate · rate-limit · screen)

**Goal:** The single unauthenticated entry point where the widget submits a conversation, plus
the presigned-upload endpoint for evidence blobs. This is the attack surface — defenses are
part of the story, not a follow-up.

**Depends on:** S1.1 (store), S1.2 (registry).

**Touch points:**

- `functions/api/index.ts` — public routes + extend public-allowlist middleware branch
- `functions/shared/signal/gate.ts` _(new — key+origin validation)_
- `functions/shared/signal/rate-limit.ts` _(new — DynamoDB token bucket)_
- `functions/shared/signal/screen.ts` _(new — cheap screening, pluggable)_
- `functions/shared/repositories/signal-rate-limit-repository.ts` _(new)_
- `sst.config.ts` — add `SignalRateLimitTable` (TTL enabled) + grant the API Lambda
  presigned-PUT permission to the scoped S3 evidence prefix
- `functions/shared/schemas/signal-conversation-schema.ts` — `signalConversationCreateSchema`
- `tests/api/signal-public.test.ts` _(new)_

**Endpoints (all public, must bypass `authMiddleware`):**

1. `POST /api/public/widget/uploads` → returns presigned PUT URLs for evidence blobs.
   - Body: `{ kinds: ('screenshot'|'replay'|'console'|'network')[] }`
   - Gated (key+origin), rate-limited. Returns `{ urls: { kind: { putUrl, key } } }` where `key`
     is a scoped S3 path `signal/<projectId>/<conv-or-temp-id>/<kind>`.
   - **Never** write to the bucket root (see CLAUDE.md deploy-safety; scoped prefix only).
2. `POST /api/public/widget/conversations` → creates a conversation.
   - Body validated by `signalConversationCreateSchema` (transcript, page, device,
     detectedIntents, evidence keys — _keys only_, blobs already uploaded via #1).
   - Gate → rate-limit → screen → `createConversation` with status `OPEN`→`SCREENED`.
   - Returns `{ conversationId }`.

**Gate (`signal/gate.ts`):** read `X-Signal-Key` header (or body `publishableKey`) + `Origin`
header. `getRegistrationByPublishableKey` → must exist, `active`, and `Origin ∈ originAllowlist`.
Else `403 { error: { code: 'SIGNAL_ORIGIN_REJECTED' } }`. Unknown key → `401
SIGNAL_KEY_INVALID`.

**Rate limit (`signal/rate-limit.ts` + repo):** DynamoDB fixed-window counter, key
`<publishableKey>#<minute>` and `<ip>#<minute>`, atomic `ADD` increment, item TTL ~2 min.
Limits configurable (default e.g. 20/min/key, 10/min/IP). Over limit → `429
SIGNAL_RATE_LIMITED`. Table `futurator-signal-rate-limit`, PK `bucketKey`, TTL attr `expiresAt`.

**Screening (`signal/screen.ts`):** Tier-0 heuristic now, LLM-pluggable later. Reject/flag:
empty or <3-char descriptions, payloads over size cap, obvious spam patterns. Output sets
status `SCREENED` (pass) or stores with a `screenedOut: true` flag (quarantine — never auto-
enriched downstream). **Screening gates the expensive lanes**: nothing reaches E3/E4 enrichment
until SCREENED-pass.

**Payload caps:** reject conversation bodies over ~256 KB (blobs go through presigned S3, not
inline); reject transcripts over N messages.

**Acceptance criteria:**

- [ ] Both public routes reachable **without** a JWT; all _other_ `/api/*` still require auth.
- [ ] Valid `(key, origin)` accepted; unknown key → 401; unlisted origin → 403; inactive reg → 403.
- [ ] Rate limit returns 429 past threshold; counters expire via TTL.
- [ ] Oversized payload → 413/400; under-length description → screened-out.
- [ ] Presigned URLs target the scoped `signal/<projectId>/...` prefix only — never bucket root.
- [ ] Happy path persists an `OPEN→SCREENED` conversation and returns its id.

**Tests:** route tests for each gate/limit/screen branch (mock registry + rate-limit repo);
assert public-allowlist middleware lets these two paths through and blocks a sample authed path.

**Out of scope:** LLM screening, captcha/proof-of-work (E6 open question), dedup (E3).

---

## Story S1.4 — Widget bundle MVP (rrweb capture, masking, slide-out)

**Goal:** The standalone embeddable bundle: a right-edge slide-out conversational panel that
captures rich context and submits a conversation. Tiny, framework-light, self-contained.

**Depends on:** nothing for build; integrates with S1.3/S1.5 at runtime (parallel with S1.1/S1.2).

**Touch points:**

- `widget/` _(new top-level package, separate `package.json` like `daemon/`)_
  - `widget/package.json`, `widget/tsconfig.json`, `widget/vite.config.ts` (library/IIFE build → `dist/widget.js`)
  - `widget/src/index.ts` — bootstrap, reads config, mounts panel
  - `widget/src/capture/recorder.ts` — rrweb ring buffer (~60s), console + fetch/XHR interceptors
  - `widget/src/capture/redact.ts` — PII masking config
  - `widget/src/ui/panel.ts` — slide-out conversational UI (Preact or vanilla; keep < ~50 KB gz)
  - `widget/src/ui/screenshot.ts` — capture + box-annotate
  - `widget/src/net/client.ts` — presigned upload + conversation POST
- `widget/README.md`

**Spec:**

- **Mount:** injects a shadow-DOM-isolated launcher button + right-edge slide-out panel (no CSS
  bleed into host app). Conversational input; agent echoes/clarifies (server routing in later
  epics — Tier 0 just collects + tags `detectedIntents` from a lightweight client classifier or
  a explicit lane picker).
- **Capture — buffer, don't stream:** rrweb records into a rolling ~60s in-memory ring buffer;
  console + `fetch`/`XHR` interceptors keep capped recent logs. **Serialize and upload only on
  submit.** Zero network/cost while idle.
- **PII masking at SDK layer (non-negotiable):** rrweb `maskAllInputs: true`,
  `maskInputOptions` for password/email, block-class for `data-signal-mask`; never transmit
  masked values. Respect per-env `captureRules` (no network bodies in prod).
- **Screenshot + annotate:** one-click capture of the viewport with a draggable highlight box.
- **Env-aware:** reads `publishableKey`, `apiBase`, `environment`, `gitSha` from script
  data-attributes / injected global (provided by S1.5 config fetch).
- **Submit flow:** request presigned URLs (`/uploads`) → PUT blobs to S3 → POST conversation
  (evidence = keys) → show confirmation + (anonymous) a reference id.

**Acceptance criteria:**

- [ ] Single-file `dist/widget.js` builds; mounts without leaking styles into the host (shadow DOM).
- [ ] Idle = zero network calls; submit = exactly the upload + POST calls.
- [ ] Inputs masked by default; `data-signal-mask` honored; prod build omits network bodies.
- [ ] rrweb buffer bounded (~60s / size cap) — memory does not grow unbounded.
- [ ] Works embedded in a throwaway test page hitting a local API.
- [ ] Bundle gz size budget documented and met (target < ~80 KB gz incl. rrweb).

**Tests:** unit-test redaction + interceptors + buffer bounds (jsdom); a Playwright smoke test
mounting the widget on a fixture page and asserting a submit produces the expected requests
(API mocked via `page.route()`, matching existing e2e style).

**Out of scope:** conversational LLM routing (server-side, E3–E5), session replay _playback_
(admin viewer is E2).

---

## Story S1.5 — Embed snippet + per-project config fetch + versioned hosting

**Goal:** The one-line install, the runtime config endpoint that personalizes the widget per
project, and the versioned hosting path. Closes the Tier 0 loop end to end.

**Depends on:** S1.2 (registry), S1.3 (public middleware), S1.4 (bundle).

**Touch points:**

- `functions/api/index.ts` — `GET /api/public/widget/config` (public, gated)
- `functions/shared/schemas/signal-config-schema.ts` _(new — response shape)_
- `widget/src/index.ts` — fetch config by key on boot, apply theme/lanes/captureRules
- `scripts/deploy-widget.sh` _(new — build + upload to scoped path; **never** root sync)_
- `sst.config.ts` — serve `widget/dist` from a **scoped** path / versioned prefix (e.g.
  `signal/widget/v1/widget.js`) behind the existing CloudFront dist or a Signal subdomain
- `tests/api/signal-config.test.ts` _(new)_

**Spec:**

- **Config endpoint:** `GET /api/public/widget/config?key=<publishableKey>` (Origin-gated like
  S1.3). Resolves registration → returns `{ enabledLanes, theme, captureRules[env], environment,
active }`. Inactive/unknown → 403/401. Cache-Control short (e.g. 60s).
- **Embed snippet** (what an operator pastes into a brownfield app):
  ```html
  <script
    src="https://signal.futurator.ai/v1/widget.js"
    data-signal-key="sig_pub_xxxxx"
    data-signal-env="prod"
    async
  ></script>
  ```
  On load: bundle reads `data-signal-key`, fetches config, applies theme + enabled lanes +
  env capture rules, mounts. The `POST /api/signal/registrations` response (S1.2) returns this
  exact snippet pre-filled.
- **Versioned hosting:** widget served from a versioned, scoped path. `scripts/deploy-widget.sh`
  builds `widget/dist` and uploads to `signal/widget/v1/` — **respect CLAUDE.md deploy safety:
  scoped prefix only, never `aws s3 sync out/ s3://futurator-ai-website/`.** One bundle update
  reaches every embedding app with no re-embed.

**Acceptance criteria:**

- [ ] Config endpoint returns per-project config, Origin-gated, public (no JWT).
- [ ] Inactive/unknown key → rejected; response cacheable briefly.
- [ ] Registration-create response includes a ready-to-paste, key-filled snippet.
- [ ] `deploy-widget.sh` uploads to the versioned scoped path and is guarded against root sync.
- [ ] End-to-end: paste snippet on a fixture page → widget loads, themed, captures, submits, and
      the conversation lands in `signal-conversations` (Tier 0 happy path proven).

**Tests:** config route tests (gate + shape); a doc-checked dry-run of `deploy-widget.sh`
asserting the destination prefix; reuse the S1.4 Playwright smoke as the e2e seam.

**Out of scope:** multi-version pinning/rollback, CDN cache invalidation automation (E6).

---

## E1 definition of done

- [ ] All five stories' acceptance criteria met.
- [ ] `npm run ci` green (lint, format, knip, typecheck, test, build) for `functions/` + `src/`;
      `widget/` builds and lints under its own package.
- [ ] A registered fixture project can embed the snippet and produce a stored conversation in
      every environment, with prod redaction verified.
- [ ] No write path touches the `futurator-ai-website` bucket root — evidence + widget assets
      use scoped prefixes only.
- [ ] Tier 0 demoable on one **real** target (recommend applicator) behind a feature flag.

**Next:** E2 (admin intake/triage UI) to view what E1 captures, then the spike (concept §10) to
de-risk the bug-fix loop before E3.
