# EU Migration Completion — Master Implementation Plan

**Status:** MASTER PLAN (consolidated from keystone redesign + cross-cutting coordination + Workstreams A–F) · **Date:** 2026-07-22 · **Branch context:** feat/aws-migration-eu · **Account:** 421515025850 / eu-central-1

This document is the single sequenced source of truth. Where inputs disagreed, the **Graph Store Redesign (keystone)** and the **Cross-cutting Coordination layer** win. Workstream A and Workstream F both planned the graph rewrite independently — they are **merged here into one graph lane** (canonical S-numbered stories); the A*/F* ids are cross-referenced so nothing is lost.

---

## 1. Executive summary

The EU migration is live (tables, API, UI on hub.futurator.ai) but four capability clusters are dead because they assume the old-account singleton EC2 (`i-0826d68c316ae97dd`) and the old `futurator-ai-website` bucket:

1. **Knowledge graph** — Memgraph ran only in Docker on the dead EC2. Every consumer degrades gracefully, so only the dev Graph tab visibly broke, but graph-sync, MCP tools, search, self-reflection, and app-purge are all silently inert.
2. **File Explorer / party file drawer / plan-folder writes / EC2 Monitor** — all SSM into the dead instance.
3. **Debates (party engine)** — blocked on PAT secrets (SST secret DUMMY; fleet IAM has zero Secrets Manager grant) + repo materialization on fleet hosts.
4. **Free Agent** — deployed and wired; needs a gate-copy fix, config verification, and a live smoke.

### Key design decisions (ratified)

| #             | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Verdict |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| **KD-1**      | **Memgraph is EXCISED, not re-provisioned.** Replaced by a DynamoDB source-of-truth graph store (`futurator-graph-nodes` + `futurator-graph-edges`, adjacency-list + reverse GSI) with an S3 **snapshot projection** that keeps `graph-snapshot.json` / `_refactor/graph.json` byte-compatible — **zero UI changes** on the read path. Embeddings move to a per-project S3 sidecar; KNN stays client-side JS. Agent navigation tools (`neighbors`, `transitive_reach`, `path_between`, `dependency_subgraph`, `get_file_symbols`, `list_kind`, `god_nodes`, `orphans`) run over the store from **any** fleet host AND from Lambda — bolt never could. Dossier items F4 ("run Memgraph on target host") and "MEMGRAPH_URI in cloud-init" are **DEAD — do not schedule.**                                                            |
| **KD-2 (D1)** | **Retire the singleton-EC2 model.** The fleet/`futurator-servers` model is the only compute abstraction. `EC2_INSTANCE_ID` global const is deleted; a future EC2 onboards as just another fleet server (`providerRef.instanceId`). The **control-job round-trip** (enqueue job pinned to `assignedServerId` → daemon executes locally → result on job row → API polls) is promoted to the **universal inbound-channel primitive** replacing every SSM call.                                                                                                                                                                                                                                                                                                                                                                        |
| **KD-3 (D2)** | **Bucket const SPLIT, not wholesale flip.** New `FUTURATOR_KNOWLEDGE_BUCKET='futurator-knowledge-live-eu'` for knowledge-live/timing/party-docs/git-graph reads **AND for the media-upload write path** — these were all derived from the DEAD `FUTURATOR_PUBLIC_BUCKET`, so the API read/write code AND its IAM grants must repoint together (S0.3 + §2.1), or they split-brain (grant on new bucket, read on dead one). Homepage `data/projects.json` publish + CF `E1BI1YWMTLSDTE` stay on the old const; the homepage's `media/<projectId>/` **read** base-URL repoint is a deferred operator follow-up in the homepage repo. The `apps/<name>/` prefix at `index.ts:5520/:7039` requires an **operator decision** before repointing (published user apps may still live on the old public bucket — historical incident risk). |
| **KD-4 (D3)** | **DeployerLambda RETIRED** — it fires SSM at a dead instance every 60s today. Fleet self-deploy = daemon-bundle pull (already shipped). Split `ENABLE_DAEMON_CRONS` so WaveCompletionCheck stays ON.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **KD-5 (D4)** | Legacy `POST /api/plans` fatal-on-SSM path → **hotfix to non-fatal now** (warn-and-continue), deprecate in favor of `POST /api/apps/:appId/plans` in tier-2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

### Verified gaps folded in (found by workstream verification, missing from the redesign)

- **Five extra Memgraph/neo4j references** surfaced by verification; **four are importers to rewire** before excision: `daemon/scripts/lib/phase-gates.mjs`, `daemon/pipelines/lib/concept-ground-truth.mjs`, `daemon/scripts/bootstrap-decisions.mjs`, `daemon/scripts/__tests__/query-impact.test.mjs`. Owned by S2.2. The fifth — `daemon/scripts/refactor-recon/infra-extract.mjs` (`:221` `/^neo4j-driver/`, `:386` `/^(MEMGRAPH_|NEO4J_)/i`, + test `infra-extract.test.mjs:1475/1477`) — is **CONFIRMED a legitimate brownfield graph-DB _detector_, not a Memgraph client; it is RETAINED** and carved out of the §7 zero-hit grep (see §7).
- **Two more stray refs outside the excision map** (would otherwise break the "grep → zero hits" gate or linger): `daemon/pipelines/lib/__tests__/story-compile-graph.test.mjs:139` `'memgraph down'` fixture string (updated by S1.3 with the message rewrite) and the infra-extract detector above (carved out, not rewired).
- **`daemon/scripts/package.json` declares no DynamoDB SDK** — only `neo4j-driver ^5.27.0`. `graph-store-dynamo.mjs` lands in `daemon/scripts/lib/` and needs `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (present in root `daemon/package.json`, absent here). Add owned by S0.2; neo4j removal owned by S3.1.
- **Fleet IAM has zero `secretsmanager:GetSecretValue`** — a real PAT value alone cannot fix brownfield clones. Owned by S0.1.
- **Party jobs get zero materialize-on-claim coverage** (`party-turn`/`party-bootstrap` carry no planId fields) and no `affinityKey` — turn 2 can land on a host without the checkout. Owned by C-3.
- `party-worktree.mjs` hardcodes `sudo -u ubuntu` (no `isRemapActive()` branch) — latent PARTY_PUSH_V1 bug. Owned by C-4.
- `apiRestorePolicy` wildcard `table/futurator-*` **already covers** the new graph tables for the API role — no `link:`, no 10KB-ceiling risk, by construction.
- `ServerWorkerPolicy` is **missing `dynamodb:BatchGetItem`** (MCP node hydration needs it). Owned by S0.1.

---

## 2. Shared-file ordered edit maps (conflict prevention)

### 2.1 `sst.config.ts` — RULE: exactly ONE story (S0.1) edits this file

All workstream asks are folded into the single Wave-0 infra story. No other story touches it. Consolidated edit list:

| Region (today)                                                                                                                          | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Origin           |
| --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| `:154` (+CF `:155`)                                                                                                                     | Split const: add `FUTURATOR_KNOWLEDGE_BUCKET='futurator-knowledge-live-eu'`; homepage publish stays on old const (KD-3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | A0.2             |
| after `:1027` (table defs; model on `PlanSpecGraphTable :311-335`)                                                                      | Add `GraphNodesTable` (`futurator-graph-nodes`: PK `projectId`, SK `nodeId`) + `GraphEdgesTable` (`futurator-graph-edges`: PK `src`, SK `sk`; GSIs reverse-index [`dst`/`rsk`, ALL], project-index [`projectId`/`sk`]). **Node-table GSIs are project-scoped** (mirror the EDGE `\|`-delimited derivation in S0.2 so no query crosses projects): fields `kindKey`/`fileKey` (strings) + `centrality` (number). `kind-index` = hashKey `kindKey` (=`${projectId}\|${kind}`), rangeKey `nodeId` → per-project `queryByKind`/`list_kind`; `file-index` = hashKey `fileKey` (=`${projectId}\|${file}`), rangeKey `nodeId` → per-project `queryByFile`/`get_file_symbols`; `centrality-index` = hashKey `projectId`, rangeKey `centrality` → per-project descending rank for `god_nodes` (and `degree`=0 filter for `orphans`). S1.4 writes `centrality`/`degree` onto node rows; the write-path (S0.2) must set `kindKey`/`fileKey` on every node put. PAY_PER_REQUEST, PITR, born-tagged. **Do NOT `link:`** | A1/F2            |
| `:1084-1156` FreeAgentSessionRolePolicy (`:1095,:1102`)                                                                                 | Knowledge ARNs → knowledge bucket (auto-propagates via const)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | A / D2           |
| `:1158-1228` `apiRestorePolicy`                                                                                                         | **NO CHANGE** — wildcard already covers graph tables (verified)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Graph            |
| `:1230-1283` `ServerWorkerPolicy`                                                                                                       | (a) new `KnowledgeLiveS3Write` statement: `s3:PutObject/GetObject/DeleteObject` on `arn:aws:s3:::futurator-knowledge-live-eu/knowledge-live/*` + `ListBucket` on bucket ARN (dossier F1); (b) add `dynamodb:BatchGetItem` to `DaemonDynamoTables :1240-1248`; (c) new `BrownfieldPatSecrets` statement: `secretsmanager:GetSecretValue` on `futurator/labs-brownfield-github-pat-*` + `futurator/brownfield-pat/*` (eu-central-1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | F1 + Graph + C-1 |
| `:1340-1447` API `environment`                                                                                                          | Add `GRAPH_NODES_TABLE`, `GRAPH_EDGES_TABLE`, `FUTURATOR_KNOWLEDGE_BUCKET`; optional `AGENT_DAILY_SPEND_CAP_USD` (operator decides; code default $200/day)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Graph + A + D3   |
| `:1448-1530` API `permissions` S3 ARNs (`:1464` party-docs, `:1475` timing, `:1486-1487` apps/knowledge-live, `:1498,:1525` ListBucket) | Re-target per KD-3 split; `data :1455` (homepage `projects.json`) stays on old const; **`media :1456` re-targets to knowledge bucket** (must move with the media-upload code repoint in S0.3 — else grant/read disagree again)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | A0.2             |
| `:1864-1893` DeployerLambda                                                                                                             | Retire (KD-4); keep WaveCompletionCheck `:1766` ON                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | X                |

Workstream E needs **no** sst.config.ts change (CloudWatch/SSM/EC2 grants already wildcard). Workstream B needs **none** (reuses agent-jobs table + `assignedServerId-status-index` GSI `:283`).

### 2.2 `functions/api/index.ts` — ordered, disjoint line-range ownership

**Freeze rule:** shared helpers `:6064-6098` (`sendSsmCommand`, `getInstanceState`, `waitForSsmOutput`) are FROZEN until S3.4 deletes them. New transport code goes in **new files** (`functions/shared/services/control-jobs.ts`, `graph-purge.ts`); index.ts edits are route-handler swaps only, merged in this order:

| Seq      | Lines (today)                                                                                                                                             | Region                                                                                               | Owner       | Edit                                                                                                                                                                                                                                                                                     |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0a       | `:390` (add `resolveAwsInstanceId` seam beside `EC2_INSTANCE_ID`)                                                                                         | EC2-id seam                                                                                          | **S0.4**    | **Wave-0, merges before all seq below.** Shared touch with **S3.4 (seq-9)**, which later _deletes_ the `EC2_INSTANCE_ID` const at `:390`; S0.4 only _adds_ the seam next to it. Temporal order safe (Wave 0 ≪ last)                                                                      |
| 0b       | `:2222,:2289` (plan-create bootstrap try/catch)                                                                                                           | non-fatal hotfix                                                                                     | **S0.4**    | **Wave-0.** Shared touch with **S3.3a (seq-8)**, which later full-rewires these to control-jobs; S0.4 downgrades the SSM path to warn-and-continue now (KD-5). Temporal order safe                                                                                                       |
| 1        | `:14329` (FORENSIC const) · `:9605` (`partyDocsBucket()`) · `:662` (media-upload) · `:14981` · `:5520,:7039` (+comments `:6887,:14319`)                   | bucket derivations / FORENSIC const                                                                  | **S0.3**    | Repoint `FORENSIC_S3_BUCKET` (:14329), `partyDocsBucket()` (:9605) and media-upload (:662) off `FUTURATOR_PUBLIC_BUCKET` → new `FUTURATOR_KNOWLEDGE_BUCKET`; swap `:14981`; apps/-prefix `:5520,:7039` behind decision gate. Merges FIRST (Wave-0, after S0.4's 0a/0b — disjoint ranges) |
| 2        | `:13636-13670`                                                                                                                                            | mgconsole purge in DELETE `/api/apps/:appId`                                                         | **S2.3**    | → DynamoDB partition delete (`graph-purge.ts`); result step renamed `'graph'`                                                                                                                                                                                                            |
| 3        | `:6892-7391`                                                                                                                                              | `/api/ec2/files*` (3 routes + chunked-read helpers `:6803-6890`)                                     | **B4/B7**   | → control-job enqueue + server-side wait (≤12s, under 30s Lambda cap); `getInstanceState` gates removed; helpers die with the range                                                                                                                                                      |
| 4        | `:6099-6143` · `:7393-7497` · `:7498-7560`                                                                                                                | `/api/ec2/status`, `/metrics`, `/snapshot`                                                           | **E3/SE.2** | status→heartbeat-derived; metrics parameterized `?instanceId=` (fallback preserved); snapshot→heartbeat `processes[]` (later)                                                                                                                                                            |
| 5        | `:6685-6801`                                                                                                                                              | enable/disable/start-daemon power routes                                                             | **SX.2**    | serverId-parameterized, `provider==='aws'` gated                                                                                                                                                                                                                                         |
| 6        | `:10750-10899`                                                                                                                                            | party files route                                                                                    | **SC.2**    | → control-fs (after B4 lands)                                                                                                                                                                                                                                                            |
| 7        | `:11107`                                                                                                                                                  | free-agent `workingDir` literal                                                                      | **D5**      | drop `/home/ubuntu/` prefix, keep `free-agent-worktrees/<projectId>/<sessionId>` segment pair (delete-cascade matcher contract) — separate small commit                                                                                                                                  |
| 8        | `:2222,:2289,:2756,:2792,:3515,:3780,:3819,:3845,:3939` · `:9122-9290` · `:9535-9630` · `:9905-10553` · `:11264-11518` · `:13537,:13677,:13744` · `:5548` | tier-2 SSM clusters (plan-folder / brownfield / self-edit / party git / FA open-pr / delete-cascade) | **S3.3a-d** | serial chain onto control-job primitive; interim: S0.4 makes `:2222/:2289` non-fatal (row 0b)                                                                                                                                                                                            |
| 9 (last) | `:320-322,:390` + `:6064-6098`                                                                                                                            | SDK imports, `EC2_INSTANCE_ID` const, frozen helpers                                                 | **S3.4**    | delete after zero-caller grep (the `resolveAwsInstanceId` seam added at `:390` by S0.4/row 0a stays; only the dead const goes)                                                                                                                                                           |

Anything not in this table (~279 routes) is **out of bounds** for all workstreams during this plan.

### 2.3 `daemon/agent-daemon.mjs` (soft-hot)

Three writers, coordinate merge order: **B2** (dispatch-switch branch `:8372-8419` + `executeFileBrowseJob`), **C-3** (materialize sibling fn `:8233-8278` + pre-dispatch call `:8371`), **S2.2** (selective-regression `:2523-2546`). Disjoint regions; land B2 → C-3 → S2.2.

---

## 3. Global dependency DAG

```
SEC.1 secrets (operator) ─────────────────────────────────────┐
                                                              ▼
S0.1 INFRA (sst.config.ts, sole owner) ──► DEPLOY-1 ──► C-6 debates registration
   ▲                                          │
S0.4 EC2-decision code + plan-create hotfix ──┘ (same deploy)
   │
S0.2 GraphStore adapter (code-only, ∥) ──► S1.1/S1.2 ──► S1.3 ──► S1.4, S1.5   [graph write path]
S0.3 A-repoints (∥, merges index.ts FIRST)          │
                                                    ▼
B1→B2→B3 control-job primitive (∥ with Wave 1) ──► S2.1, S2.2, S2.3, S2.4      [graph consumers]
   │                                                    │
   ├─► B4 ─► B5 ─► B6 ─► B7 (File Explorer)             ▼
   ├─► SC.2 party drawer (also needs C-3)          S3.1 excision ─► S3.2 (opt)
   └─► S3.3a→b→c→d tier-2 SSM chain (serial)            │
                                                        ▼
E1 ─► E2 (Monitoring MVP, ∥ from day 0)            DEPLOY-2 ─► OPS (bundle+restart)
E3 ─► E4 (AWS enrichment, latent) ─► E5                 │
D1/D2/D4/D5, C-4, SX.2 (∥, no deps)                     ▼
C-3 ─► (C-6 done) ─► debates live               SV.1 VERIFY battery ─► S3.4 final deletion
```

**Hard-serial (never parallelize):** (1) `sst.config.ts` = one story; (2) `sst deploy` invocations — exactly two planned; (3) tier-2 chain S3.3a→d (shared-service test overlap); (4) secrets sets before C-6; (5) daemon bundle publish + fleet restart per wave, not per story.

**Freely parallel lanes (disjoint files):** Graph lane (daemon/scripts + daemon/mcp) ∥ B lane (control-job + explorer UI) ∥ E lane (servers frontend) ∥ D lane (FA config/copy) ∥ C-4/C-3 (party daemon libs).

**Phase sequence:** Phase 0 Foundation (SEC.1, S0.1–S0.4, DEPLOY-1) → Phase 1 Quick wins ∥ Graph write path ∥ Control-job primitive → Phase 2 Consumers + feature lanes → Phase 3 Excision + tier-2 + DEPLOY-2 → Phase 4 Ops + Verify.

---

## 4. Stories by workstream

Model tiers: **sonnet** = mechanical/config/copy/verification · **opus** = complex build/refactor/cross-cutting · **fable** = high-cognitive design. (Note: FABLE 5 is deactivated on the Max pipeline — fable-tier work runs in operator-attended sessions; only S0.0 is fable and it is already complete.)

### 4.0 Phase 0 — Foundation

**S0.0 — Master plan + decision ratification** _(this document + the keystone redesign)_ — **fable — DONE.**

**SEC.1 — Secrets (operator ops)** — **sonnet** _(absorbs C-2 + C-1 ops half)_

- `npx sst secret set BrownfieldGithubPat <fine-grained PAT: contents:read (+pull_requests:write) on debatator/applicator/songster/futurator> --stage production`.
- Create AWS Secrets Manager secret in 421515025850/eu-central-1: `futurator/labs-brownfield-github-pat` (or per-project via `POST /api/party/projects {pat}` after C-6). Secrets Manager did NOT migrate with the tables.
- Audit remaining DUMMY secrets (`npx sst secret list`).
- **AC:** `GET /api/github/repos/<org>/<repo>` returns 200 post-DEPLOY-1; daemon startup probe logs `[brownfield-pat] startup probe: legacy shared secret reachable` (after S0.1 IAM lands).
- **Deps:** none. Gates C-6.

**S0.1 — Consolidated `sst.config.ts` infra story** — **opus** _(= A0.2 + A1 + F1 + F2 + C-1 IAM + D3-optional + KD-4)_

- Every edit in §2.1, one PR, one owner. IAM blast radius demands judgment: API role via wildcard managed policy (NOT `link:` — 10KB inline ceiling incident), fleet via `ServerWorkerPolicy`.
- **AC:** `sst deploy` creates both tables (born-tagged, PITR); API Lambda env carries `GRAPH_*_TABLE` + `FUTURATOR_KNOWLEDGE_BUCKET`; `ServerWorkerPolicy` v-next shows S3 + BatchGetItem + secretsmanager statements; API role inline policy size unchanged; DeployerLambda gone, WaveCompletionCheck alive.
- **Tests:** post-deploy CLI checks (§6 step 3). **Risk: HIGH** (API-role deploy path). **Deps:** none; DEPLOY-1 follows.

**S0.2 — `GraphStore` adapter + two impls + tests** — **opus** _(= A2 = F3)_

- **Add deps to `daemon/scripts/package.json`:** `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` (copy the `^3.1024.0` pins from root `daemon/package.json:12,16`). This package currently declares **only `neo4j-driver`** — `graph-store-dynamo.mjs` lands under `daemon/scripts/lib/` and has no DynamoDB SDK to import without this. Regenerate the scripts lockfile. (neo4j-driver itself is removed later in S3.1.)
- New `daemon/scripts/lib/graph-store.mjs` (interface: `putNodes, putEdges, getNode, outEdges, inEdges, queryByKind, queryByFile, listNodes, listEdges, setNodeAttrs, deleteProject`), `graph-store-dynamo.mjs` (BatchWriteItem chunks of 25, exponential backoff on UnprocessedItems; EDGE keys `src=${projectId}|${nodeId}`, `sk=${edgeType}|${targetId}`, `dst`/`rsk` mirrors; **NODE keys** `projectId` (PK) / `nodeId` (SK) plus the project-scoped GSI projection attrs set on every `putNodes` write — `kindKey=${projectId}|${kind}`, `fileKey=${projectId}|${file}`, and `centrality` (number, defaulted 0 until S1.4 back-fills) — so `queryByKind`/`queryByFile` and `god_nodes`/`orphans` never cross projects; `SYSTEM_GRAPH_NODE_PROPS` allowlist enforced on `props`), `graph-store-memory.mjs` (replaces fake-session helpers `fake-graph.mjs`, `fake-analytics-graph.mjs`, `fake-mcp-graph.mjs`), + `__tests__/graph-store.test.mjs` (shared suite: idempotent upsert, in/out symmetry, kind/file queries scoped to one project, partition delete, chunk boundary at 25/50).
- **AC:** both impls pass one shared interface suite; double-put = same state; `queryByKind`/`queryByFile` on a two-project fixture return only the queried project's nodes; `deleteProject` removes exactly one partition on both tables; optional env-guarded live-Dynamo round-trip (100 nodes / 200 edges).
- **Risk: MEDIUM** (key derivation must exactly match schema or every traversal silently breaks). **Deps:** S0.1 (table names). Blocks all graph stories.

**S0.3 — API bucket repoints (read-side split-brain fix) + region fix** — **sonnet** _(= A0.1 + A0.3; merges index.ts FIRST)_

- **Close the read-side split-brain.** Today `functions/api/index.ts` derives the knowledge/forensic/party-docs/media bucket from `process.env.FUTURATOR_PUBLIC_BUCKET`, which the plan deliberately keeps pointed at the DEAD `futurator-ai-website`. §2.1 moves the `timing/*` (:1475) and `party-docs/*` (:1464) IAM grants to `futurator-knowledge-live-eu`, so **the grants and the code must be repointed together or reads hit a bucket the role can no longer access.** Repoint all three derivations off `FUTURATOR_PUBLIC_BUCKET` onto the **new single env `FUTURATOR_KNOWLEDGE_BUCKET`** (set in sst.config.ts by S0.1, flipped into the API Lambda env at DEPLOY-1), fallback literal `'futurator-knowledge-live-eu'` (so it resolves correctly even before the env lands):
  - `:14329` `FORENSIC_S3_BUCKET = process.env.FUTURATOR_KNOWLEDGE_BUCKET || 'futurator-knowledge-live-eu'` — fixes the timing/forensic reads at `:14373`/`:14446`/`:14513`. **This is the correction of the old, inert "keep env override" instruction:** merely swapping the `|| 'futurator-ai-website'` literal did nothing because the `FUTURATOR_PUBLIC_BUCKET` env (still the dead bucket) always won.
  - `:9605` `partyDocsBucket()` → same env — fixes party-docs reads at `:9654`/`:9733`/`:9769` (agrees with the `:1464` grant move).
  - `:662` media-upload presigned-PUT → same env (agrees with the media grant move in §2.1). **Operator note:** project media now lands in the EU knowledge bucket; the public homepage reads `media/<projectId>/` from `futurator-ai-website`, so the homepage repo's media base-URL must be repointed as a follow-up (out of scope here, tracked like the apps/ decision).
- `:14981` `readBareRepoGitGraph` hardcoded bucket → `FUTURATOR_KNOWLEDGE_BUCKET`-or-fallback; `:5520,:7039` apps/ purge — **gated on operator decision** (if published apps still live on old bucket, leave these two and split the IAM grant instead).
- `daemon/run-local.sh:32` `us-east-1` → `eu-central-1`.
- **AC:** forensic/party-docs/media derivations resolve to `futurator-knowledge-live-eu` (CloudWatch shows new bucket); no code path still reads `FUTURATOR_PUBLIC_BUCKET` for knowledge/forensic/party-docs/media (grep clean); apps/ decision documented in PR; typecheck+lint clean.
- **Risk: MEDIUM** (apps/-bucket ambiguity = the historical index.html incident footgun; media homepage-read follow-up). **Deps:** rides DEPLOY-1 for the env flip; the fallback literal keeps it correct pre-deploy.

**S0.4 — EC2-decision code side + plan-create hotfix** — **sonnet**

- Delete `EC2_INSTANCE_ID` dead default usage at `functions/api/index.ts:390` call sites that S0.4 owns; add `resolveAwsInstanceId(serverId)` seam reading `futurator-servers.providerRef.instanceId` (`provider==='aws'` only). Const itself deleted in S3.4.
- Downgrade legacy `POST /api/plans` fatal SSM path (`:2222/:2289`, archives plan on failure) to warn-and-continue (KD-5). Modern `POST /api/apps/:appId/plans :13695` already non-fatal.
- **§2.2 ownership:** S0.4's two `index.ts` edits are **rows 0a (`:390` seam) and 0b (`:2222/:2289` hotfix)** — Wave-0 merges, disjoint from the ranges S3.4 (seq-9, deletes the `:390` const) and S3.3a (seq-8, full-rewires `:2222/:2289`) own later. Temporal order is safe.
- `functions/cron/deployer-lambda.ts` retirement code side + `deployer-orchestrator.ts` deprecation.
- **AC:** plan creation succeeds with zero live SSM targets; no route resolves the dead default id. **Deps:** rides DEPLOY-1 with S0.1.

**DEPLOY-1 — `sst deploy`** (exclusive window) after S0.3 → S0.1 → S0.4 merge + `npm run ci`.

### 4.1 Graph lane (Waves 1–3; merged A+F rosters)

**S1.1 — `graph-sync.mjs` full rewrite over GraphStore** — **opus** _(= A4 core = F4 part; ~15 call-site clusters, 24 `.run(` sites)_

- Replace driver/session with store instance. Rewrite: Step 6 wiki upsert (`:509`), Step 7 wikilinks (`:576`), `processAstFacts` (`:743`; keep `fileToCodeNodeId :712` / `subNodeId :717` id scheme), `processSystemGraphFacts` (`:1057`), `processTestCoverFacts` (`:1015`), `processDocumentFacts` (`:1198`), plus the analytics/contract/federation/propagator sections in coordination with S1.4. Keep `isEphemeralScanRoot` guard (`:32`).
- **Sole owner of `graph-sync.mjs`** — S1.2/S1.3/S1.4/S1.5 edits to this file serialize behind it.
- **AC:** compile-sync on a fixture writes expected node/edge counts (memory store test + live smoke); re-run idempotent; two-writer concurrency test (wave width 2) loses zero edges.
- **Risk: HIGH** (bulk of migration). **Deps:** S0.2, S1.2 (calls its functions).

**S1.2 — `system-graph-ingest.mjs` rewrite** — **opus** _(= A3 = F4 part)_

- `upsertExtractedFacts` (`:95`, MERGE `:134-137`, `:155-159`), `upsertEnvReads` (`:220`, `:244-266`), `upsertCallsEndpoint` (`:335`): `(session,…)` → `(store,…)`. **Keep verbatim:** `SYSTEM_GRAPH_EDGE_TYPES :20-47`, `SYSTEM_GRAPH_NODE_PROPS :53-79`, edge-type allowlist (`:147` — stays as governance).
- **AC:** the four `.mycelium/*-facts.json` envelopes produce the identical node/edge inventory the Cypher produced (direct heir of fake-session tests, now on memory store); out-of-set edges still rejected.
- **Risk: MEDIUM.** **Deps:** S0.2.

**S1.3 — `writeGraphSnapshot` → store→JSON projection** — **sonnet** _(= A4 part = F5; golden test is mandatory)_

- `graph-sync.mjs:1904-2016`: two Cypher reads (`:1909`, `:1929`) → `listNodes` + `listEdges` (project-index GSI); assemble **byte-compatible** `GraphSnapshot` (`{projectId, generatedAt, nodeCount, edgeCount, nodes[], edges[]}` incl. per-kind shaping `:1938-1981` and `similarTo`); write `knowledge/_graph/graph-snapshot.json` (s3-backup carries it; optional direct PutObject via new fleet grant). `story-compile-graph.mjs:341` message → "graph store write failed?"; update the paired test fixture `daemon/pipelines/lib/__tests__/story-compile-graph.test.mjs:139` (`'memgraph down'` stub stdout → `'graph store write failed'`) so no stray Memgraph copy lingers.
- **AC:** golden-file diff vs a captured legacy snapshot = zero schema drift (modulo `generatedAt`); `readSnapshotStats` telemetry (`story-compile-graph.mjs:326-344`) fires; dev Graph tab renders with **zero UI change**.
- **Risk: MEDIUM** (byte-compat is load-bearing). **Deps:** S1.1.

**S1.4 — integrity / prune / analytics / propagation / contract-revision / federation** — **sonnet** _(= A5 = F6; session-injected pure fns, mechanical swap + write-back)_

- `lib/graph-integrity.mjs`, `lib/graph-prune.mjs` (prune = `status` flip via `setNodeAttrs` — reversible, never hard-delete), `lib/impact-propagation.mjs`, `lib/contract-revision.mjs`, `lib/federation.mjs`; `graph-analytics.mjs` (already plain-JS math — swap fetch + **write back** `centrality`/`community`/`degree`/`fanIn` onto node rows, feeding GSI-3 and `orphans`); graph-sync call sections (`:1407, :1549, :1603, :1637, :1715, :1793` + driver `:1879-1891`) in coordination with S1.1.
- **AC:** god-nodes GSI returns ranked; `degree` populated (orphans filter works); integrity/propagation match Memgraph-era counts on fixture.
- **Deps:** S0.2, S1.1 (file ownership).

**S1.5 — Embeddings sidecar + `graph-search.mjs` KNN rewrite** — **opus** _(= A6 = F7)_

- graph-sync Step 5 (Voyage) kept; vectors → per-project sidecar `knowledge/_graph/embeddings.json` (`{nodeId: f16[1024]}`, local + S3 backup, NOT public). `embedding-knn.mjs` reads sidecar; `graph-search.mjs` (neo4j import `:18`) → embed query (`input_type:'query'`) → cosine KNN → hop-expand via store edges. `search-cascade.mjs:151-171` Layer 1 unchanged beyond the call.
- **AC:** same top-K ids as the vector index on fixture (±ordering); cascade Layer 1 works; sidecar not publicly readable.
- **Deps:** S0.2, S1.1.

**S2.1 — Mycelium MCP rewrite + new navigation tools** — **opus** _(= A7 = F8)_

- `daemon/mcp/mycelium-mcp.mjs`: drop `createDriver :28`, driver `:368`, neo4j coercion `:335-352`; rewrite 7 tool impls (`:71,:95,:120,:142,:160,:178`) over the store. **Keep verbatim:** `BLAST_EDGE_TYPES :35-39` (incl. W5 event edges), `TOOL_DEFS`/`dispatchTool`/telemetry `:196-333`.
- **Add:** `get_file_symbols` (file-index), `list_kind` (kind-index), `dependency_subgraph` (BFS-out, depth≤3, cap 500), `path_between` (bidirectional meet-in-middle, ≤12 hops), `god_nodes` (GSI-3 desc), `orphans` (degree=0 ∧ active); rename `blast_radius`→`transitive_reach` (alias kept), `touchesPaidService` from `billable`.
- `daemon/lib/mcp-config.mjs:47`: `MEMGRAPH_URI` → `GRAPH_NODES_TABLE`/`GRAPH_EDGES_TABLE`/`AWS_REGION`; update `MYCELIUM_TOOLS`.
- **AC:** MCP boots on a fleet host with per-server IAM keys only (no bolt — finally host-agnostic); 7 originals equivalent on fixture; new tools correct + capped + read-only; telemetry preserved.
- **Deps:** S0.2 (unit), S1.x (live smoke).

**S2.2 — Remaining daemon/pipeline consumer rewires** — **opus** _(= A8 = F10; breadth + the 4 gap importers are the trap; infra-extract detector explicitly NOT touched)_

- `agent-daemon.mjs:2523-2546` selective-regression (+comments `:1032-1034, :6331-6334`); `predev-compile-pipeline.mjs:21, :641-655`; `self-reflection-pipeline.mjs:17,21` + 3 Cypher constants (`:28,:55,:72`) + inline `node -e` runners (`:340-341, :379-380`) → store queries (low-maturity = list + `maturity<0.6`; flagged = `status=flagged`; prune = superseded + zero active in-edges via reverse GSI); `ground-truth-context.mjs:13,27` + `ground-truth-injection.mjs:77-89`; `pruning-scan.mjs`, `decompose-requirements.mjs`, `bootstrap-verify.mjs`, `generate-system-articles.mjs`, `extract-decisions.mjs` (verify), `bootstrap-ast.mjs` (docs/env); `verify-graph.mjs` → re-implement as store health probe; **PLUS the gap quartet:** `lib/phase-gates.mjs`, `pipelines/lib/concept-ground-truth.mjs`, `scripts/bootstrap-decisions.mjs`, and rewrite `__tests__/query-impact.test.mjs` onto memory store. **DO NOT touch `refactor-recon/infra-extract.mjs`** — its `neo4j-driver`/`MEMGRAPH_`/`NEO4J_` strings (`:221`, `:386`) are a brownfield graph-DB _detector_ (identifies Memgraph/neo4j usage in _scanned target repos_), not a Memgraph client of ours; it is RETAINED verbatim and carved out of the grep gates below.
- **AC:** `grep -rlE "neo4j-driver\|memgraph-driver" daemon/ --exclude-dir=refactor-recon` (detector excluded) returns ONLY files slated for deletion in S3.1; each pipeline runs boltless. The `refactor-recon/infra-extract.mjs(+test)` detector matches are expected and intentional.
- **Deps:** S0.2, S1.1.

**S2.3 — App-delete graph purge → DynamoDB partition delete** — **sonnet** _(= A9 = F9; HOT index.ts seq-2)_

- `functions/api/index.ts:13636-13670`: delete SSM/mgconsole block; new `functions/shared/services/graph-purge.ts` = Query nodes PK + edges project-index → BatchWriteItem deletes (chunks of 25). Result step `{step:'graph', detail:'N nodes + M edges deleted'}`.
- **AC:** app delete purges both partitions from Lambda, zero EC2/SSM; no cross-partition deletion. **Deps:** S0.1 (grants/env), S0.2 (pattern), after S0.3 merge.

**S2.4 — `graphify-import.mjs`: scan recon → store** — **opus** _(= A10 = F11)_

- New `daemon/scripts/lib/graphify-import.mjs`: map `graphify-out` (`graph.resolved.json`, `resolved-imports.json` from `alias-resolve.mjs:225`, `graph-ui.json` from `graph-project.mjs:124`) into the canonical envelope — file → `code/<path / → -->` (parity with `fileToCodeNodeId`), symbols → `#fn:`/`#class:` (parity with `subNodeId`), IMPORTS from `resolved-imports.json.edges`, `fileRoles`/providers/community as attrs. Registered apps only (`isEphemeralScanRoot` guard). `_refactor/graph.json` projection + upload path (`agent-daemon.mjs:9762, :10042`) unchanged.
- **AC:** scan of registered app lands under its projectId; ephemeral roots land nothing; Assess Graph tab renders unchanged.
- **Risk:** id-scheme parity with S1.1 is the correctness hinge. **Deps:** S0.2, S1.1.

**S3.1 — Memgraph excision sweep** — **sonnet** _(= A12 = F13; gated behind ALL rewires incl. S2.2 gap quartet)_

- **Delete:** `daemon/memgraph/` (whole dir), `memgraph-driver.mjs`, `init-memgraph.mjs`, `test-memgraph.mjs`, 3 fake-session helpers.
- **Deps drop:** `daemon/package.json:18` `neo4j-driver ^6.0.1`; `daemon/scripts/package.json` `neo4j-driver ^5.27.0` + the `test-memgraph*`/`init-memgraph*` npm scripts (top of `scripts` block); regenerate lockfiles. **Keep** the `@aws-sdk/client-dynamodb`/`@aws-sdk/lib-dynamodb` deps that S0.2 added to `daemon/scripts/package.json` — the store depends on them.
- **Env purge (`MEMGRAPH_*`):** `self-reflection-pipeline.mjs:21,341,380`, `predev-compile-pipeline.mjs:641`, `bootstrap-verify.mjs:33,145-147`, `boilerplate/system-graph/wave-gate-hook.mjs:21-22`, `daemon/pipelines/compile-sync-step.sh:15`, `daemon/scripts/disk-gc.sh:15`.
- **Copy sweep:** `src/app/development/graph/page.tsx:15`; `labs/plan-dashboard/views/graph-view.tsx:6`; `labs3/plan-spec-dashboard/index.tsx:59`, `constants.ts:45`, `delete-app-dialog.tsx:23,86`; `graph-viewer.tsx:216-217`; `functions/shared/pipelines/story-pipeline.ts:2299-2335`, `wave-compile-pipeline.ts:36,200`, `derive-project-id.ts:5,12`; `types/attention.ts:26`; `daemon/scripts/init-wiki.sh:250`. Legacy: `scripts/rsync-daemon.sh` retired (dead host, `debatator-memgraph.pem :35`).
- **AC:** see §7 checklist; `cd daemon && npm ci` clean; daemon boots + completes graph-sync with no `neo4j` in node_modules; full `npm run ci` green.

**S3.2 (optional, trails) — `/api/graph/*` live-query routes** — **sonnet** _(= A11 = F12; mechanical port of S2.1 query patterns to auth-gated Hono routes)_

- `GET /api/graph/:projectId/nodes/:nodeId`, `/neighbors?dir=&type=`, `/subgraph?root=&depth=`, `/path?from=&to=`. Enables graph-viewer's deferred live-query seam. Enhancement, not migration-critical.
- **Deps:** S0.1, S2.1. HOT index.ts — append away from owned ranges, sequence last among graph edits.

### 4.2 Workstream B — File Explorer (control-job primitive lane)

**B1 — Contract: `file-browse` job type + validator + router branch** — **sonnet**

- `functions/shared/types/agent-orchestrator.ts`: `fileBrowsePayload {op:'list'|'read'; path; serverId}` + `fileBrowseResult` mirror (FileEntry shape per `use-ec2-files.ts:5-11`). `daemon/pipelines/job-router.mjs`: `JOB_HANDLER_FILE_BROWSE`, `selectHandler` branch, `validateFileBrowseJob` (mirror `:150`).
- **AC:** select+validator unit cases green; typecheck clean. **Deps:** none.

**B2 — Daemon handler: local fs read + result write-back** — **opus**

- New `daemon/pipelines/file-browse.mjs`: list via `readdirSync`/`statSync`; read via size-capped (2MB) `readFileSync` + classifier; **path safety** = server-scoped root (`FUTURATOR_BROWSE_ROOT`), reject `..`/metachars/root-escape (`path.resolve` + `startsWith`). Extract `classifyFile`/`TEXT_EXTS`/`IMAGE_EXTS` (`index.ts:7226-7311`) to `daemon/pipelines/lib/file-classify.mjs` (duplicate table acceptable over cross-package import). `agent-daemon.mjs`: `executeFileBrowseJob` + dispatch branch (`:8372-8419` area).
- **AC:** list/read/too-large/PNG-base64 cases green; traversal rejected without reading; runs on Mac, no SSM. **Risk: MEDIUM** (security). **Deps:** B1.

**B3 — Claim gate: pin `file-browse` to `assignedServerId` even with serverAware OFF** — **sonnet**

- `job-router.mjs` `isJobClaimableBySource` (`:138`) + `agent-daemon.mjs` `canClaimJob` (`:1694`): claimable only when `job.assignedServerId === SERVER_ID`.
- **AC:** mismatching daemon skips, matching claims; other job types unaffected (wrong predicate strands jobs PENDING — cover both branches). **Deps:** B1.

**B4 — API file routes → enqueue + server-side wait** — **opus** _(HOT index.ts seq-3)_

- Rewrite `GET /api/ec2/files :7175` + `GET /api/ec2/files/content :7313`: validate `?serverId=` via `getServerById` + heartbeat-fresh (`HEARTBEAT_FRESH_MS`); enqueue with `assignedServerId`; `waitForJobResult(jobId, ~12s)` (well under 30s Lambda cap); relay `fileBrowseResult` in the existing wire shapes. Remove `getInstanceState` gates (`:7176-7179, :7314-7317`) and SSM path; drop hard `EC2_BROWSE_ROOT='/home/ubuntu' :7165`.
- **AC:** fresh server → entries/content within window; stale/unknown → 4xx; timeout → 504; no route calls `getInstanceState`. **No sst.config change.** **Deps:** B1, B2 (B3 for OFF-flag correctness).

**B5 — Hook: server-scoped `useEc2Files`/`useEc2FileContent`** — **sonnet**

- `src/hooks/use-ec2-files.ts`: thread `serverId` into keys + querystring; `enabled` gate until selected. **Deps:** B4.

**B6 — File Explorer UI: server-picker + heartbeat gate** — **opus**

- `file-explorer.tsx`: replace `useEc2Status`/`ec2Running` (`:386-387`) with `useServers()` + `heartbeatState()`; server `<select>` (default first fresh, prefer local); drop `ROOT_PATH='/home/ubuntu' :11` + placeholder `:452`; thread `serverId` through `DirectoryNode` (`:141-150,236,491`); `file-viewer.tsx:10` passes serverId. Empty states: "pick a server" / "heartbeat stale".
- **AC:** no selection → zero file calls; fresh server → that box's tree; switching re-roots; dead EC2 never blocks the panel; no `/home/ubuntu` in browse UI. **Tests:** Playwright with mocked `/api/servers` + files routes. **Deps:** B4, B5.

**B7 — Delete generalized to fleet (`op:'delete'`)** — **opus** _(HOT index.ts; ship after B4/B6 proven)_

- Daemon: `rm -rf` only under server-relative projects/`.claude` roots (port realpath-guard `:6919-6925`). API `DELETE /api/ec2/files :6892`: drop gate, generalize allow-list regexes (`:6899-6901`) + `transcriptDir` server-relative; fs delete via job, **AWS cascade (Dynamo/S3) stays in Lambda**. UI regexes `:27-28`, dialog `:280`.
- **AC:** folder gone via daemon + cascade intact; out-of-allow-list refused. **Risk: HIGH** (destructive, two-surface allow-list). **Deps:** B1, B2, B4.

**B8 (optional, last) — Rename `ec2`→`fs` across file surface** — **sonnet.** Cosmetic; churns hot file; only after B7.

### 4.3 Workstream C — Debates (party)

**C-4 — `party-worktree.mjs` sudo fix** — **sonnet** _(independent, ship anytime)_

- Import `isRemapActive` (per `story-worktree.mjs:20`); branch `runGit` (`:60-77`) exactly like `story-worktree.mjs:41-48`.
- **AC:** remap-on → plain `git`; remap-off → `sudo -n -u ubuntu git` preserved. **Deps:** none.

**C-3 — Party materialize-on-claim** — **opus** _(foundation for SC.2)_

- `agent-daemon.mjs`: new sibling `materializePartyWorkingDirIfMissing(job)` called at `:8371` beside the existing one. **Skip `party-bootstrap`** (does its own clone, mirror `app-bootstrap` exclusion `:8251`). For `party-turn` with missing `workingDir`: look up project; brownfield → `cloneRepo` with `loadBrownfieldPat` token (mirror `party-bootstrap.mjs:488-496`); greenfield → throw loudly. Early-return fast for all non-party job types (this is the pre-dispatch path EVERY job flows through).
- Also: add `affinityKey: \`party:${projectId}\`` at party-turn creation (`index.ts:10688-10734`) for future serverAware routing (inert today, cheap now — fold into SC.2's index.ts touch if preferred).
- **AC:** missing-workingDir brownfield turn triggers clone before `runPartyTurn`; party-bootstrap never double-cloned; two-host fleet test: session survives turn landing on a different host.
- **Risk: MEDIUM** (blast radius = every job type). **Deps:** none; blocks SC.2.

**C-6 — Register migrated apps as party projects (ops)** — **sonnet**

- Run existing `scripts/migrate-brownfield.mjs --path <clone> --pat-file <f>` per repo (debatator, applicator, songster, futurator). No code.
- **AC:** 4 rows `bmadStatus: HEALTHY`; visible in New Debate picker. **Deps:** SEC.1 + S0.1 (IAM) + DEPLOY-1; fleet Claude auth healthy.

**SC.2 — Party file drawer onto control-fs** — **sonnet** _(HOT index.ts seq-6; thin wiring on B's primitive — do NOT rebuild a parallel job type)_

- `GET /api/party/projects/:projectId/files :10750-10899`: drop `getInstanceState` gate (`:10789-10792`) + SSM block; enqueue `file-browse` (or party-scoped op) with party root resolution (session → worktreePath/projectPath → project.path, per `:10773-10787`), realpath containment, 200-entry dir cap, `.git`/`node_modules`/`.party-uploads` exclusions, 1MiB file cap; poll route or server-side wait to preserve `usePartyFile`'s returned shape so `file-drawer.tsx` **diff is empty**.
- Daemon side calls C-3's materialize helper first (self-heal on any host).
- **AC:** drawer shows real content from the session's fleet host; traversal 403; drawer component untouched. **Deps:** B1/B2/B4, C-3.

**C-7 folds into SV.1** (debate e2e is part of the verify battery).

### 4.4 Workstream D — Free Agent

**D1 — FAB gate copy/rename (not protocol)** — **sonnet**

- `src/components/free-agent/fab.tsx`: tooltip `:59` → "Switch to Fleet (remote daemon)…", doc-comment, optional local `ec2Mode`→`remoteMode`. **Storage key `futurator.labs.runtimeMode` and value `'ec2'` byte-for-byte unchanged** (load-bearing wire value: `DAEMON_SOURCE`/`QueueTarget`/concurrency flags). `widget.test.tsx:121` assertion updated. Wire-value rename explicitly out of scope (future E-lane story).
- **Deps:** none.

**D2 — STS trust + IAM verification checklist** — **sonnet** _(verification-only; re-run after each sst deploy)_

- ApiRole matches `sst.config.ts:1069` StringLike; `FREE_AGENT_SESSION_ROLE_ARN` env present; no `assumeFreeAgentSessionRole` errors in logs. Note: FreeAgent knowledge-live S3 reads heal automatically when S0.1's const split deploys.

**D4 — Bare-repo prerequisite verification on fleet host** — **sonnet** _(ops)_

- `FUTURATOR_BARE_REPOS_ROOT` resolved correctly per host; greenfield app's bare repo exists; FAB message doesn't hit `BARE_REPO_MISSING`. Region fix owned by S0.3 — verify only.

**D5 — Clean `workingDir` literal `index.ts:11107`** — **sonnet** _(HOT index.ts seq-7, separate small commit)_

- Drop `/home/ubuntu/` prefix, keep `free-agent-worktrees/<projectId>/<sessionId>` segment pair (contract with `workingDirMatchesApp`, `agent-jobs-repository.ts:84-90`); add pointer comment.
- **AC:** `listAppJobIds` still matches free-agent rows pre/post (unit test in repositories `__tests__`).

**D6 folds into SV.1** (FA activation smoke is part of the verify battery).

### 4.5 Workstream E — Monitoring (EC2 Monitor → Servers tab)

**E1 — Lift `MetricChart` to shared component** — **sonnet**

- Move verbatim from `monitor/page.tsx:17-119` → `src/components/development/servers/metric-chart.tsx`; import-swap in the still-live page. **Deps:** none. Blocks E4.

**E2 — Monitoring tab MVP (heartbeat gauges)** — **opus** _(ships value day 0, no backend)_

- `servers-view.tsx:19-30`: third tab. New `monitoring-tab.tsx`: `useServers()` (5s poll), server selector, gauges from heartbeat `system` (RAM%, loadAvg, slots `activeCount/maxConcurrent`, auth badge, `heartbeatState` freshness; dead → "last seen Ns ago" empty state). No `processes[]` yet (E6 deferred).
- **AC:** fresh server shows live gauges; dead shows empty state; zero API/sst change. **Deps:** none.

**E3 — Parameterize `/api/ec2/metrics` + `/snapshot` by `?instanceId=`** — **sonnet** _(HOT index.ts seq-4)_

- `:7393`: `instanceId = query ?? EC2_INSTANCE_ID` fallback (back-compat); swap 4 dimension refs (`:7417,:7429,:7442,:7458,:7470`); `i-…` format guard else 400. `:7498` snapshot same (optional `instanceId` arg on the SSM call, inline if needed). No sst change (grants already `*`).
- **Deps:** none. Latent until an AWS fleet server exists.

**E4 — AWS-only CloudWatch/SSM enrichment in the tab** — **opus**

- `use-ec2-metrics.ts`: optional `instanceId` in params + queryKey. `monitoring-tab.tsx`: when `provider==='aws' && providerRef.instanceId` → range buttons + 4 MetricChart panels + snapshot card; else one-line "AWS-only enrichment" note.
- **Deps:** E1, E2, E3. Live verification latent until an AWS server onboards via the Servers module.

**E5 — Delete standalone Monitor page + nav** — **sonnet** _(sequence last in E)_

- Delete `src/app/development/monitor/` dir; remove `sidebar.tsx:39` entry; keep `use-ec2-metrics.ts` (consumed by E4) + all control endpoints/`use-ec2-daemon.ts`; `CapControl` dies with the page (superseded by `CapStepper`). Run `npm run knip`.
- **AC:** route gone; knip+typecheck+lint clean; controls still function. **Deps:** E2 (ideally E4, avoids transient knip orphan).

**E6 — Per-server `processes[]` + CPU% in heartbeat — DEFERRED** (post-MVP; fleet-wide daemon write-path blast radius).

### 4.6 Workstream X — Power controls + tier-2 + cleanup

**SX.2 — Power controls → serverId-parameterized, aws-gated** — **sonnet** _(HOT index.ts seq-5)_

- `:6685-6801` enable/disable/start-daemon → `provider==='aws'` gated, instance-id via `resolveAwsInstanceId` (S0.4 seam); `/api/ec2/status :6099` → heartbeat-derived from `futurator-servers` (drop legacy `DAEMON_HEARTBEAT` read). Frontend: `ec2-control.tsx`, `labs/ec2-toggle.tsx`, `reauthorize-button.tsx`, `runtime-controls.tsx`, `use-ec2-daemon.ts` generalized to selected server; AWS-only power controls shown iff `provider==='aws'`.
- **Deps:** S0.4, DEPLOY-1.

**S3.3a–d — Tier-2 SSM→control-job chain (STRICTLY SERIAL)** — **opus × 4**

- **a)** `plan-folder-service.ts` (34 SSM refs; plan.md materialization moves daemon-side on claim, API writes → best-effort control-jobs on affinity host; `:2222,:2289,:2756,:2792,:3515,:3780,:3819,:3845,:3939`).
- **b)** Party git ops + session cleanup (`:9905-10553` archive/push/checkpoint on the session's claiming host) + delete-cascade host `rm -rf` (`:5548,:13537,:13677` → control-fs broadcast or accepted skip: hosts GC their own worktrees).
- **c)** `free-agent-open-pr.ts` (`:11264-11518`, routed to the host owning the session worktree).
- **d)** `brownfield-topology-converter.ts` (`:9122-9290`) + `admin-self-edit-bootstrap.ts` (`:9535-9630`).
- Each rewires a shared service with overlapping tests — one at a time, after B1/B2 land. **Deps:** B-lane primitive.

**S3.4 — Final helper/import deletion** — **sonnet** _(HOT index.ts seq-9, LAST)_

- Delete `:320-322` SDK imports, `:390` `EC2_INSTANCE_ID`, `:6064-6098` frozen helpers — only after grep shows zero remaining callers. Also `scripts/mac-oauth-sync.sh:11` generalized per-server; `scripts/rotate-github-pat.sh:30,77` drops the EC2-push half (rotation = SSM param + SST secret).
- **Deps:** everything that consumed them (B4/B7, SC.2, SX.2, S3.3a-d, S2.3).

**SV.1 — Verification battery** — **sonnet** _(operator-attended; absorbs A13/F15/C-7/D6)_

- (a) scan → Assess Graph renders; (b) dev story → tables populate → snapshot in `knowledge-live/<pid>/_graph/` → dev Graph tab renders (byte-diff vs legacy capture = zero); (c) MCP smoke `neighbors`/`transitive_reach`/`path_between`/`dependency_subgraph` from BOTH Mac and GCP; (d) delete expendable app → both partitions empty + S3 purged, no SSM; (e) File Explorer vs Mac and GCP; (f) Monitoring gauges for every fleet host; (g) one full debate turn on a migrated app surviving a host switch, file drawer opens real content, zero `sendSsmCommand`/`EC2_NOT_RUNNING` in CloudWatch; (h) one free-agent session to Rung-0 diff + streamed reply; (i) `graph-search`/`query_graph` ranked results via sidecar KNN; (j) feature-degrade parity: host without graph-table env skips graph features non-blockingly.

**Optional backfill** — **sonnet**: ~50-line one-shot importing surviving S3 `graph-snapshot.json`s into the tables (nice-to-have; store otherwise repopulates on next sync).

---

## 5. Per-model story count

| Tier       | Count    | Stories                                                                                                                                         |
| ---------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **fable**  | 1 (done) | S0.0 (this plan + keystone redesign — completed in operator session; FABLE deactivated on the Max pipeline, so no scheduled fable work remains) |
| **opus**   | 19       | S0.1, S0.2, S1.1, S1.2, S1.5, S2.1, S2.2, S2.4, B2, B4, B6, B7, C-3, E2, E4, S3.3a, S3.3b, S3.3c, S3.3d                                         |
| **sonnet** | 25       | SEC.1, S0.3, S0.4, S1.3, S1.4, S2.3, S3.1, S3.2, S3.4, B1, B3, B5, B8, C-4, C-6, SC.2, D1, D2, D4, D5, E1, E3, E5, SX.2, SV.1                   |
| **Total**  | **45**   | (+1 optional backfill, sonnet; E6 deferred)                                                                                                     |

**Adversarial-review gap closure (no story-count change):** the five reviewer gaps were folded into existing stories, not new ones — (1) read-side bucket split-brain → S0.3 (repoint `FORENSIC_S3_BUCKET`/`partyDocsBucket()`/media-upload onto `FUTURATOR_KNOWLEDGE_BUCKET`) + §2.1 media grant + §2.2 rows; (2) missing DynamoDB SDK deps → S0.2 (add) / S3.1 (retain); (3) grep carve-out → S2.2 + §7 (retain `infra-extract.mjs` detector, S1.3 fixes the `story-compile-graph.test.mjs` fixture); (4) project-scoped node GSIs → §2.1 + S0.2; (5) S0.4 shared-touch rows → §2.2 (0a/0b). Tiers of the affected stories are unchanged, so **fable 1 / opus 19 / sonnet 25 / total 45** holds.

**Critical path:** S0.1 → DEPLOY-1 → S1.2/S1.1 → S1.3 → S2.1/S2.2 → S3.1 → DEPLOY-2 → OPS → SV.1. B/C/D/E lanes hang off DEPLOY-1 and B1/B2 only.

---

## 6. Ops / deploy runbook (ordered)

1. **Secrets (operator, first):** SEC.1 — `npx sst secret set BrownfieldGithubPat … --stage production`; create Secrets Manager PAT secret in eu-central-1; audit DUMMY secrets.
2. **Merge Wave 0:** S0.3 (repoints, merges index.ts first) → S0.1 (infra) → S0.4 (EC2-decision code). `npm run ci`.
3. **DEPLOY-1 — `sst deploy`** (exclusive window). Creates `futurator-graph-nodes/-edges`; **sets the API Lambda env — `FUTURATOR_KNOWLEDGE_BUCKET=futurator-knowledge-live-eu` (activates the S0.3 forensic/party-docs/media repoints) + `GRAPH_NODES_TABLE`/`GRAPH_EDGES_TABLE`**; updates `ServerWorkerPolicy` (S3 write + BatchGetItem + secretsmanager); swaps FreeAgent role ARNs; retires DeployerLambda. **Post-checks:** `aws dynamodb describe-table --table-name futurator-graph-nodes` (+edges, all three project-scoped node GSIs + edge reverse/project GSIs); `aws lambda get-function-configuration` (env vars incl. `FUTURATOR_KNOWLEDGE_BUCKET`); `aws iam get-policy-version` on `futurator-server-worker`; API role inline policy size unchanged (10KB ceiling); worker-user `aws s3 cp` probe to `knowledge-live/` + `get-secret-value` probe; CloudWatch confirms forensic/party-docs reads resolve to the knowledge bucket (not `futurator-ai-website`).
4. **AWS out-of-band:** none — no new buckets, no instance provisioning (retired by KD-2). Per-server IAM users pick up the managed-policy update automatically.
5. **Host env sweep:** remove `MEMGRAPH_URI/USER/PASSWORD` from Mac + GCP daemon `.env`s; verify `AWS_REGION=eu-central-1` everywhere (`run-local.sh` fix rode S0.3). Add nothing (table names via bundle env / mcp-config).
6. **Daemon bundle publish + fleet restart** after each daemon wave (minimum: after Wave 1, after Wave 3): re-sync bundle to the daemon-bundle S3 prefix; Mac → restart local daemon; GCP → systemd restart via bundle-pull. **Never `rsync-daemon.sh`** (targets the dead host; retired in S3.1).
7. **Graph repopulation:** none required (store starts empty; next compile-sync/scan populates). Optional one-shot snapshot backfill.
8. **Debates activation:** C-6 registration → bootstrap → HEALTHY on a fleet host; verify Claude auth on hosts that may claim `party-turn`.
9. **Free Agent activation:** D1 copy live, D2/D4 checklists pass, bare repo present on claiming host, spend-cap headroom confirmed.
10. **DEPLOY-2 — `sst deploy`** after Waves 1–3 API merges (purge route, files/metrics/status rewrites, tier-2 clusters as they land). Mid-plan hotfix deploys allowed but exclusive.
11. **SV.1 verify battery** (§4.6) — evidence before claims.
12. **S3.4 final deletion** after zero-caller grep, then one last `npm run ci` + deploy if needed.

---

## 7. "Memgraph fully excised" checklist

- [ ] `daemon/memgraph/` directory deleted (docker-compose.yml, setup-memgraph.sh)
- [ ] `daemon/scripts/lib/memgraph-driver.mjs`, `init-memgraph.mjs`, `test-memgraph.mjs` deleted
- [ ] `fake-graph.mjs`, `fake-analytics-graph.mjs`, `fake-mcp-graph.mjs` deleted (replaced by `graph-store-memory.mjs`)
- [ ] `@aws-sdk/client-dynamodb` + `@aws-sdk/lib-dynamodb` ADDED to `daemon/scripts/package.json` (S0.2) so `graph-store-dynamo.mjs` in `daemon/scripts/lib/` can import them (previously only `neo4j-driver` was declared)
- [ ] `neo4j-driver` removed from `daemon/package.json` AND `daemon/scripts/package.json` (+ both lockfiles regenerated; `init-memgraph*`/`test-memgraph*` npm scripts gone)
- [ ] All 12 redesign importers + the **4 gap importers** (`phase-gates.mjs`, `concept-ground-truth.mjs`, `bootstrap-decisions.mjs`, `query-impact.test.mjs`) rewired to `GraphStore`; `story-compile-graph.test.mjs:139` `'memgraph down'` fixture updated (S1.3)
- [ ] **`refactor-recon/infra-extract.mjs` (+ its test) RETAINED** — brownfield graph-DB detector, intentionally NOT rewired
- [ ] `grep -rnE "neo4j-driver|memgraph-driver|MEMGRAPH_|bolt://|mgconsole" daemon/ functions/ src/ scripts/ boilerplate/ --exclude-dir=refactor-recon` → **zero hits** (excludes the retained `refactor-recon/infra-extract.mjs(+test)` detector and intentional historical docs)
- [ ] `mcp-config.mjs` injects `GRAPH_NODES_TABLE`/`GRAPH_EDGES_TABLE`/`AWS_REGION`, not `MEMGRAPH_URI`
- [ ] `index.ts:13636-13670` mgconsole/SSM purge replaced by DynamoDB partition delete — app delete works from Lambda with no host
- [ ] Host `.env`s (Mac, GCP, any `/opt/futurator-daemon/.env`) carry no `MEMGRAPH_*`
- [ ] Cloud-init confirmed Memgraph/Docker-free (verified: already true — nothing to remove, nothing to add)
- [ ] `scripts/rsync-daemon.sh` (dead host, `debatator-memgraph.pem`) retired; `disk-gc.sh` `/var/lib/memgraph` path dropped
- [ ] UI/comment copy sweep done (delete-app-dialog "Memgraph knowledge nodes" → "graph rows", graph pages, pipeline comments, `init-wiki.sh`)
- [ ] "Memgraph-down → skip" degrade posture replaced by "table env missing → skip" (same non-blocking behavior, verified in SV.1-j)
- [ ] Daemon boots and completes a full graph-sync with no `neo4j` package in `node_modules`
- [ ] `npm run ci` green; daemon test suite green; Playwright smoke green

---

## 8. Contradiction resolutions (record)

1. **A vs F duplicate graph rosters** → merged into canonical S-numbered lane (§4.1); A1/F2→S0.1, A2/F3→S0.2, A3/F4→S1.2, A4/F4-F5→S1.1+S1.3, A5/F6→S1.4, A6/F7→S1.5, A7/F8→S2.1, A8/F10→S2.2, A9/F9→S2.3, A10/F11→S2.4, A11/F12→S3.2, A12/F13→S3.1, A13/F15+C-7+D6→SV.1, F14→S0.4/S3.1/S3.4.
2. **Gap-importer counts** (A found 3, F found 5) → superset of 5 candidates adopted; on verification **4 are genuine importers rewired by S2.2** (gating S3.1) and the 5th (`infra-extract.mjs`) is a retained brownfield graph-DB detector, carved out of the §7 zero-hit grep — not a rewire.
3. **Snapshot-projection tier** (coordination: sonnet; A/F: opus) → **sonnet** kept, with the golden-file byte-diff test made mandatory (the spec fully constrains the work).
4. **Consumer-rewire tier** (coordination: sonnet; A/F: opus) → **opus** adopted: the self-reflection Cypher→store query translations and the 4 gap importers exceed mechanical scope.
5. **C-5 self-contained party job type vs reuse of B's primitive** → B sequences first; SC.2 is thin wiring on `file-browse` (sonnet), per coordination and C's own recommendation.
6. **Dossier F4 "run Memgraph on target host" / "MEMGRAPH_URI in cloud-init"** → superseded by KD-1; not scheduled.
7. **E's "keep EC2_INSTANCE_ID for metrics"** vs coordination's deletion → reconciled by sequencing: E3 keeps the fallback until S3.4 deletes the const after SX.2/E-lane fully migrate to `resolveAwsInstanceId`.
8. **B's B1/B2/B3 vs coordination's single SB.1** → B's finer split adopted (better parallelism + tier accuracy); B1+B3 may fold into one router PR at the coordinator's discretion.
