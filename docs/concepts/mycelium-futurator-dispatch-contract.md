# Mycelium ↔ Futurator — Pipeline-Dispatch Integration Contract

> How Mycelium hands a **sealed Development Plan** (the Seal, DD91) to Futurator over
> HTTP, and how it tracks the resulting Pipeline-3 dev run until the app is built and
> deployed. Written from the implemented contract in
> `functions/shared/schemas/pipeline-dispatch-schema.ts` and
> `functions/shared/services/pipeline-dispatch.ts` (deployed, proven e2e).

## 1. The flow in one picture

```
Mycelium                                     Futurator-Admin (Lambda API)
────────                                     ────────────────────────────
Dev Plan seals (rollup gate + authority)
        │
        │  POST /api/pipeline/dispatch
        │  x-queue-key: <shared secret>
        │  { source, app, seal, git? }
        ├───────────────────────────────────►  resolve identity:
        │                                        app.ref  → deterministic appId
        │                                        seal.id+version → deterministic runId
        │                                      greenfield (scaffold repo) or
        │                                      iteration (brownfield plan on same app)
        │  ◄── 202 { runId, appId, isNewApp,
        │           idempotent, statusUrl }
        │
        │  GET /api/pipeline/runs/:runId        stage ∈ queued|concept|developing|
        │  x-queue-key: <shared secret>                 vqa|deployment|completed|
        ├───────────────────────────────────►          failed|blocked
        │  ◄── { stage, detail, stories,
        │        currentWave, devUrl,
        │        deployUrl, provenance … }
        ▼
   poll until terminal (v1 is poll-only; no callback yet — see §8)
```

## 2. Endpoints

| Method | Path                        | Purpose                                                      |
| ------ | --------------------------- | ------------------------------------------------------------ |
| `POST` | `/api/pipeline/dispatch`    | Submit a seal (or bare intent) → starts a Pipeline-3 dev run |
| `GET`  | `/api/pipeline/runs/:runId` | Poll the run's external stage                                |

**Base URL (production, eu-central-1 account 421515025850):**

```
https://3hc6clgy32vtbd5xtmbpfjzase0ajqqq.lambda-url.eu-central-1.on.aws
```

This is the API Lambda's Function URL — the same origin the hub UI calls. `hub.futurator.ai`
serves only the static UI; do **not** call the API through it. If the Lambda is ever
recreated, the fresh URL is printed by `sst deploy` (`apiUrl` output) and recorded in
`docs/plans/futurator-admin-aws-migration-runbook.md`.

## 3. Authentication — `x-queue-key`

Both routes are outside the operator-JWT middleware and instead require the shared
secret header, identical to `/api/queue/ingest`:

```
x-queue-key: <value of the QueueIngestSecret SST secret>
```

- Fail-closed: missing/mismatched header **or** unset server secret → `401 AUTH_REQUIRED`.
- The secret is managed in this repo with `npx sst secret set QueueIngestSecret <value>`
  (read back with `npx sst secret list`). Rotate there, then hand the new value to
  every external caller (Mycelium, atlassinator, applicator, …) — one shared key in v1.

## 4. Dispatch request — two caller shapes

### 4a. Mycelium shape (identity-aware — the one to use)

```jsonc
POST /api/pipeline/dispatch
{
  "source": "mycelium",              // required — stamped as createdBy: external:mycelium
  "app": {
    "ref": "pacman-web",             // required in this shape — Mycelium's STABLE app id
    "name": "Pacman"                 // optional — readable slug on first create only
  },
  "seal": {
    "id": "seal-pacman-mvp",         // required — idempotency key (one seal+version = one run)
    "version": "v1",                 // optional — new version → NEW run (re-develop)
    "document": "…the converged, approved Dev Plan text…"   // required — the contract
  },
  "git": {                           // optional — provenance ONLY in v1 (recorded + echoed,
    "repoUrl": "https://…",          //             never cloned; Futurator owns the dev repo)
    "branch": "main",
    "commit": "abc123"
  }
}
```

Semantics (all deterministic, all derived server-side):

- **`app.ref` → appId.** `deriveAppId(source, ref)` = readable kebab slug + 6-char hash,
  stable across seals. **Unknown ref → GREENFIELD**: Futurator scaffolds a fresh GitHub
  repo from the `nextjs-canvas-game` boilerplate, creates the app + bootstrap job, and
  runs the quick-P3 flow. **Known ref → ITERATION**: a new `kind: 'change'` Plan on the
  existing app + worktree with `brownfield: true` — the planner plans against real code.
- **`seal.id` (+ `version`) → runId** (UUID-shaped hash). Re-sending the same
  seal+version is **idempotent**: HTTP `200` with `idempotent: true` and the existing
  run — safe to retry blindly. A **new version** mints a **new run** on the same app.
- **`seal.document`** is the payload the concept stage transforms into StoryNodes. Send
  the full converged plan text (markdown fine, ≥3 chars enforced, no upper bound).
- Everything is echoed back as `provenance` on the status endpoint
  (`{ source, appRef, sealId, sealVersion, git, dispatchedAt }`) so Mycelium can
  correlate runs to seals without keeping a mapping table.

### 4b. Simple shape (throwaway — smoke tests only)

```json
{ "source": "mycelium", "intent": "Build a pomodoro timer", "name": "pomo" }
```

No `app`/`seal` → random ids, no dedup, always greenfield. Either `seal.document` or
`intent` must be present.

## 5. Dispatch response

Fresh dispatch → `202 Accepted`; idempotent replay → `200 OK`:

```json
{
  "runId": "0be95f31-64c1-4c9e-9f7a-2ab4c1d0e881",
  "appId": "pacman-web-9emxb1",
  "repoUrl": "https://github.com/futurator-repos/pacman-web-9emxb1",
  "isNewApp": true,
  "idempotent": false,
  "statusUrl": "/api/pipeline/runs/0be95f31-64c1-4c9e-9f7a-2ab4c1d0e881",
  "status": "accepted"
}
```

`repoUrl` (added 2026-07-18, live after the next `sst deploy`) is the app's dev repo —
greenfield always lands at `futurator-repos/<appId>`; brownfield apps echo their real
`githubRepoUrl`. Store it as the project→repo binding on the first greenfield run.

Errors (JSON envelope `{ "error": { "code", "message" } }`):

| Status  | Code               | Meaning                                                             |
| ------- | ------------------ | ------------------------------------------------------------------- |
| 400     | `VALIDATION_ERROR` | Body failed the Zod schema (message lists each issue)               |
| 401     | `AUTH_REQUIRED`    | Bad/missing `x-queue-key`                                           |
| 409     | `REPO_EXISTS`      | Greenfield collision — a GitHub repo named `<appId>` already exists |
| 4xx/502 | `GITHUB_ERROR`     | Scaffold failed upstream (bad PAT relays as 502)                    |

## 6. Status poll — `GET /api/pipeline/runs/:runId`

```json
{
  "runId": "0be95f31-…",
  "appId": "pacman-web-9emxb1",
  "repoUrl": "https://github.com/futurator-repos/pacman-web-9emxb1",
  "provenance": {
    "source": "mycelium",
    "appRef": "pacman-web",
    "sealId": "seal-pacman-mvp",
    "sealVersion": "v1",
    "dispatchedAt": "2026-07-18T12:00:00.000Z"
  },
  "stage": "developing",
  "detail": "stories in flight (claimed/developing/merging/verifying)",
  "stories": { "done": 3, "total": 7 },
  "currentWave": 1,
  "totalWaves": 3,
  "branch": "plan/pacman-web-9emxb1",
  "devUrl": "https://dev.futurator.ai/pacman-web-9emxb1/"
}
```

The eight external stages, in pipeline order (mapper is strictly first-match and never
reports a later stage than reality):

| Stage        | Meaning                                                                                             | What Mycelium should do                            |
| ------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `queued`     | Accepted; concept not started or planSpec awaiting first daemon claim                               | keep polling                                       |
| `concept`    | Planner turning the seal into StoryNodes                                                            | keep polling                                       |
| `developing` | Story waves in flight (`stories`/`currentWave` progress; `devUrl` appears)                          | keep polling                                       |
| `vqa`        | Built; deployed-app QA cycle not yet green                                                          | keep polling                                       |
| `deployment` | QA passed; climbing the promote ladder (`detail` says which rung; `stagingUrl`/`deployUrl` fill in) | near-done — `deployUrl` present = live in prod     |
| `completed`  | Operator marked the plan **delivered** in the hub                                                   | terminal ✅                                        |
| `failed`     | Plan abandoned/archived — terminal without delivery                                                 | terminal ❌                                        |
| `blocked`    | Needs a human: `detail` names the wedge (`START-GATE`, `QA-EXHAUSTED`, `GRAPH-DEADLOCK`)            | alert the operator; run resumes after human action |

Polling guidance: every 60 s is plenty (runs take tens of minutes). Treat
`completed`/`failed` as terminal. Note `completed` requires the **operator's**
"delivered" mark — if Mycelium only cares that the app is live, treat
`stage === 'deployment' && deployUrl` as shipped. `blocked` is not terminal; it clears
when the operator acts in the hub.

## 7. Operational prerequisites (per environment)

1. **`QueueIngestSecret` set to a real value** in the target stage (the EU migration
   initially set placeholder secrets — verify with `npx sst secret list`).
2. **GitHub PAT secret valid** — greenfield scaffolds a repo from the boilerplate
   template; a dead PAT surfaces as `GITHUB_ERROR`.
3. **A daemon fleet online** — dispatch only writes DynamoDB rows; PENDING jobs are
   claimed by the EC2/Mac/GCP daemons. No daemon → the run sits in `queued` forever.
4. **One run per app at a time** — iteration plans share the app's worktree. Wait for
   the previous run to reach `deployment`/`completed` before dispatching the next seal
   for the same `app.ref`.

## 8. Inform-back (v1 = poll-only) and future callback

v1 has **no push callback** — Mycelium polls `statusUrl`. The designed next step is an
optional `callback` field on the dispatch payload:

```jsonc
"callback": { "url": "https://<mycelium>/futurator/runs", "secret": "…" }
```

Futurator would POST the same stage view on every stage **transition** (at minimum on
`completed`/`failed`/`blocked`), signed with the shared secret. Not built yet — don't
send the field today (the Zod schema silently strips unknown keys, so it would be
ignored, not erred). Track this in the pipeline-v3 backlog.

## 9. Copy-paste smoke test

```bash
API=https://3hc6clgy32vtbd5xtmbpfjzase0ajqqq.lambda-url.eu-central-1.on.aws
KEY=<QueueIngestSecret value>

# dispatch
curl -s -X POST "$API/api/pipeline/dispatch" \
  -H "x-queue-key: $KEY" -H "content-type: application/json" \
  -d '{"source":"mycelium","app":{"ref":"pacman-web","name":"Pacman"},
       "seal":{"id":"seal-pacman-mvp","version":"v1","document":"<the sealed plan>"}}'

# poll (runId from the 202 body)
curl -s "$API/api/pipeline/runs/<runId>" -H "x-queue-key: $KEY"
```
