# Pipeline v3 — System Graph Test-Bench Rubric

**Status:** Standalone rubric (NOT part of `system-graph-prd.md`)
**Date:** 2026-06-15
**Purpose:** Four small, complete apps used as a **controlled-test rubric** to validate the System Graph PRD _after_ it's built. Run **one at a time**, by hand, scoring each against its assertions. These apps were originally used to stress-test the PRD's quality (they surfaced gaps W1–W10, now fixed in PRD v0.2); they are kept here as the empirical bench for the real implementation.

> Each app is chosen to **break a specific PRD assumption**, not to look impressive. Together they give full coverage of the node/edge taxonomy, the MCP retrieval path, the cross-project propagation engine, and the token-savings claim.

---

## 0. How to run a bench app (the common protocol)

For each app, in order:

1. **Build** the app to its spec (small, complete, deployable on the zero-cost-serverless stack).
2. **Bootstrap the graph** — run `ast-extract` + `infra-extract` + `route-extract` + `service-extract` → `graph-sync` for the app's `--project`.
3. **Graph assertions** — verify the expected nodes/edges exist (Cypher checks listed per app). Any miss = a real extractor/PRD gap.
4. **Retrieval check** — run `blast_radius` / `query_graph` for the app's "trap" scenario; confirm the answer is **complete** (no false all-clear).
5. **Token-savings A/B** (§0.1) — measure adoption + savings.
6. **Score** against the app's pass/fail rubric.

### 0.1 Token-savings A/B harness (the same for all four apps)

The PRD's success metric (G8/§10) is _self-measured_, not borrowed. The bench is how we measure it.

- **Fixed task set:** 5–8 scripted exploration/edit tasks per app (e.g. "add a field to the scores table and update every consumer", "which paid APIs does a chat turn touch?").
- **Control arm:** agent with **grep + raw file read only** (Mycelium-MCP disabled).
- **Treatment arm:** agent with **Mycelium-MCP** (`blast_radius`, `query_graph`).
- **Measured:**
  - `tokensIn` per task (the savings signal),
  - **adoption** = % of treatment tasks where the agent _actually invoked_ the MCP (from the G8 telemetry record — not self-report),
  - **correctness** = did the arm find all true dependents (graded against a hand-built answer key).
- **Pass:** treatment adoption ≥ agreed threshold AND treatment `tokensIn` < control AND treatment correctness ≥ control. A token "saving" that comes with a correctness drop is a **fail**, not a win.

> Adoption is graded from telemetry, never from the agent claiming it used the tool — directly guards the "looks-alive-isn't" façade.

---

## 1. App 1 — **Chomp** (Pac-Man) · code-density + the frontend↔table gap

|                        |                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------ |
| **Stack**              | Next.js + Canvas game → one API Lambda → one DynamoDB table                                                  |
| **Tables**             | `ScoresTable { playerName, score, lastStage, date }` (PK `playerName`, or `scoreId` + GSI)                   |
| **Endpoints**          | `POST /api/scores`, `GET /api/leaderboard`                                                                   |
| **Flow**               | Prompt name on start → play stages with scoring → on game-over, write score, read leaderboard from the table |
| **Deliberately dense** | game loop, sprite/ghost classes, collision, stage loader, scorer → many `function`/`class` nodes             |

**What it stresses:** W1 (endpoint node needed for the chain), W4 (frontend reads **no** env/table), MAGE communities/god-nodes on a real code cluster, orphan invariant.

**Graph assertions:**

- `endpoint/POST /api/scores` and `endpoint/GET /api/leaderboard` exist with `ROUTES → infra/lambda/*`.
- The leaderboard React component has `CALLS_ENDPOINT → endpoint/GET /api/leaderboard` and **no** `READS → ScoresTable`.
- The spine resolves: `component ─CALLS_ENDPOINT→ endpoint ─ROUTES→ lambda ─READS→ ScoresTable`.
- MAGE produces ≥1 sensible community around the game loop; god-node = the main loop or the renderer.
- Orphan count (degree-0, non-`file`) = 0.

**Trap scenario (retrieval):** "I want to add `level` to the score record — what must change?" `blast_radius` must return the table, the write endpoint, the leaderboard endpoint, the API handler, **and** the frontend component that renders the leaderboard — via the endpoint hop, not a (nonexistent) direct table read.

---

## 2. App 2 — **Jester** (joke chatbot) · 3rd-party + microservice + secrets

|            |                                                                                       |
| ---------- | ------------------------------------------------------------------------------------- |
| **Stack**  | Chat UI → API Lambda → **Anthropic Haiku** (`claude-haiku-4-5`) → DynamoDB chat state |
| **Auth**   | **Futurator Identity Broker** (Bearer JWT, JWKS, issuer) — the live microservice      |
| **Tables** | `ChatsTable { sessionId, turns[], updated }`                                          |
| **Secret** | `AnthropicApiKey`                                                                     |

**What it stresses:** the external-service + microservice + secret path end-to-end; W7 (`Resource.*` vs `process.env`); W10 (Haiku is billable — cost modeled?).

**Graph assertions:**

- `service/Anthropic` (`externalService`) exists with `costModel.billable = true` (W10).
- `secret/AnthropicApiKey ─REPRESENTS→ service/Anthropic`.
- `infra/lambda/* ─USES→ service/Anthropic` and the handler file `─CALLS_SERVICE→ service/Anthropic`.
- `service/IdentityBroker` exists; auth-guarded endpoints carry `endpoint.auth = true`; public ones (`/api/health`, `/api/auth/*`) carry `auth = false`.
- If the app reads the key via `Resource.AnthropicApiKey.value`, the edge still lands (W7) — not only via `process.env`.

**Trap scenario:** "Which paid/3rd-party services does one chat turn touch, and which require auth?" `query_graph`/`blast_radius` must name **Anthropic (billable)** and **Identity Broker (auth)** — and _not_ miss the broker because it's reached via `Resource.*`.

---

## 3. App 3 — **Twindle** (shared habit-tracker, TWO surfaces, ONE backend) · the propagation test ⭐

|                |                                                                                                            |
| -------------- | ---------------------------------------------------------------------------------------------------------- |
| **Backend**    | **ONE** SST app: `HabitsTable`, API Lambda, endpoints `GET/POST /api/habits`, `POST /api/habits/:id/check` |
| **Surface A**  | **Web** (Next.js)                                                                                          |
| **Surface B**  | **Mobile** (React Native / Expo)                                                                           |
| **Federation** | same table ARNs, same API origin — **built as one shared backend** to pin §12 = resource identity          |

**What it stresses:** the headline — Capability nodes, `CONSUMES_CONTRACT`, federated `--global` spine, drift markers, PROPAGATOR. Also W2 (drift needs `:ContractRevision`), W6, W8 (untagged capability), W9 (federation identity).

**Graph assertions:**

- Both surfaces appear as `service` subgraphs in the `--global` graph; both `CONSUMES_CONTRACT → infra/table/HabitsTable` and the shared endpoints.
- A `capability/habit-check` node `IMPLEMENTS←` both `Web:*` and `Mobile:*` components.
- The W8 detector flags a component touching the contract with **no** `IMPLEMENTS → capability` (deliberately leave one untagged and confirm it's surfaced).

**Two ritual tests (the core of the app):**

1. **Positive (propagation fires correctly):** add `streak:number` to `HabitsTable` + `GET /api/habits/:id/streak` in **Web**. At the wave gate a `:ContractRevision` is appended; PROPAGATOR drafts a **correct Mobile port-brief** naming `HabitScreen` + a streak hook. **Pass** = brief is correct and scoped; drift-count derived from the revision log, not guessed.
2. **Negative (no false positive — Risk 4):** perform a **Web-internal rename** that does **not** change the contract shape. **Pass** = **no** Mobile story fires. A Mobile brief here is a **fail**.

**Trap scenario:** confirm `shortest_path(Web:HabitList, Mobile:HabitScreen)` runs **through the shared contract node**, proving siblings are linked by contract, not code.

---

## 4. App 4 — **Echobox** (voice-memo → transcript, event-driven media) · S3 + async + cron + 2nd 3rd-party ⭐

|             |                                                                                                                                                                                                                                  |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flow**    | record memo → **presigned PUT to S3** `media/<id>/` → **S3/EventBridge event triggers** a processing Lambda → calls **ElevenLabs or Moises** (transcription) → writes `TranscriptsTable` → **daily cron** Lambda emails a digest |
| **Buckets** | scoped `media/<id>/` path (the dual-bucket safety rule, modeled as `bucketPath`)                                                                                                                                                 |

**What it stresses:** W5 (the **only** app where upload→table has **no synchronous call edge** — the chain is event-driven), `bucket`/`bucketPath`/presigned, `cron` node, scoped-write safety, a _second_ paid API (so service-extract isn't validated on a sample of one).

**Graph assertions:**

- `eventSource` (S3 notification / EventBridge) `─TRIGGERS→` the processing lambda; the cron `─TRIGGERS→` the digest lambda.
- The processing lambda `─CALLS_SERVICE→ service/ElevenLabs` (or Moises) and `─WRITES→ infra/table/TranscriptsTable`.
- `bucketPath` node for `media/*` exists with `lambda ─WRITES→ bucketPath`; the scoped path is distinct from other bucket paths (encodes the safety rule).
- `cron` node exists with schedule prop.

**Trap scenario (the false all-clear test):** "If I change the transcript shape written by the processing Lambda, what's affected?" `blast_radius` **must** reach the processing Lambda **via the S3/EventBridge `TRIGGERS` edge** from the upload path, plus the table, plus the digest cron that reads it. If blast-radius returns "nothing upstream touches this" because it only traversed synchronous `CALLS`, that is the **W5 false all-clear** — a hard fail.

---

## 5. Coverage matrix (apps × PRD capability)

✅ = exercises · 🔨 = the weakness this app was chosen to expose (now fixed in PRD v0.2; bench re-confirms)

| PRD capability                                    | Chomp | Jester | Twindle | Echobox |
| ------------------------------------------------- | :---: | :----: | :-----: | :-----: |
| Code nodes/edges + MAGE communities               | ✅✅  |   ✅   |   ✅    |   ✅    |
| Table + accessor-aware `READS` (W4)               |  🔨   |   ✅   |   ✅    |   ✅    |
| Lambda `HANDLED_BY`/`USES`                        |  ✅   |   ✅   |   ✅    |  ✅✅   |
| Endpoint/route node (W1)                          |  🔨   |   🔨   |   🔨    |   🔨    |
| externalService + `CALLS_SERVICE` + cost (W10)    |   —   |  ✅✅  |    —    |  ✅✅   |
| secret `REPRESENTS` + `Resource.*` (W7)           |   —   |   🔨   |    —    |   ✅    |
| Microservice (Identity Broker)                    |   —   |  ✅✅  |   ✅    |    —    |
| S3 `bucket`/`bucketPath`/presigned                |   —   |   —    |    —    |  ✅✅   |
| Async/event edges (W5)                            |   —   |   —    |    —    |   🔨    |
| Cron node                                         |   —   |   —    |    —    |   ✅    |
| Orphan **vs** dead-code query (W2)                |  🔨   |   🔨   |   🔨    |   🔨    |
| Capability + `IMPLEMENTS` + gap detector (W8)     |   —   |   —    |   🔨    |    —    |
| `CONSUMES_CONTRACT` federation                    |   —   |   —    |  ✅✅   |    —    |
| PROPAGATOR brief + `:ContractRevision` drift (W6) |   —   |   —    |   🔨    |    —    |
| Contract-diff false-positive guard (Risk 4)       |   —   |   —    |  ✅✅   |    —    |
| Federation identity (W9/§12)                      |   —   |   —    |   🔨    |    —    |
| MCP `blast_radius` retrieval                      |  ✅   |   ✅   |   ✅    |  ✅✅   |
| Token-savings A/B + adoption telemetry (W3/G8)    |  🔨   |   🔨   |   🔨    |   🔨    |

Four apps, full taxonomy coverage, every PRD weakness empirically re-checkable.

---

## 6. Build order (recommended)

1. **Chomp** — simplest; proves the code graph + the endpoint spine + the A/B harness end-to-end before adding integrations.
2. **Jester** — adds 3rd-party + microservice + secrets on top of a working harness.
3. **Echobox** — adds the async/event + S3 + cron dimension (the W5 trap).
4. **Twindle** — last, because it's the only multi-surface one and depends on everything else working before propagation can be trusted; it also pins the §12 federation-identity decision.
