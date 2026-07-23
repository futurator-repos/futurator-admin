# EU-Migration Completion Dossier — investigation for the ultracode plan

**Date:** 2026-07-22 · **Account:** 421515025850 / eu-central-1 · **Status:** investigation complete, ready to plan
**Scope:** finish the AWS-account migration for six broken/absent capabilities: Graph/scan storage, File Explorer, Debates, Free Agent, EC2 Monitor→Servers, and the EC2/Memgraph compute host.

This is a **findings + fix-scope** document (not an implementation). Each workstream has: current state → root cause → fix scope → effort → files. Cross-cutting root causes and a suggested sequence are at the end.

---

## 0. TL;DR — four root causes explain almost everything

1. **The old EC2 box no longer exists.** Hardcoded `i-0826d68c316ae97dd` was in the OLD account and was never migrated. `describe-instances` is empty in every region. Anything keyed to that instance shows "EC2 not running": File Explorer, EC2 Monitor, party file-drawer, EC2 controls.
2. **The fleet is pull-only.** Daemons (Mac/GCP/EC2) poll DynamoDB, claim jobs, and self-report a heartbeat into `futurator-servers`. There is **no inbound channel** from the API/browser to a box (SSM is AWS-EC2-only; the daemon HTTP receiver is loopback-only). Any "reach into a box" feature must be modeled as a claimed job, not a direct call.
3. **The knowledge/graph S3 bucket was never migrated — and the repoint is currently split-brain.** New public bucket `futurator-knowledge-live-eu` (eu-central-1) now exists. The **write path** (daemon) is repointed; the **read path** (5 UI files done, but the **API-side reads + Lambda env + sst.config const are NOT**) still targets the dead `futurator-ai-website`.
4. **Memgraph (originally neo4j-on-EC2) is being REMOVED — not provisioned.** The dev-pipeline Graph tab's `graph-snapshot.json` is currently built _from_ Memgraph (Docker, bolt://localhost:7687), which is why it's broken. **New direction (2026-07-22):** excise Memgraph/neo4j entirely and replace the graph store with a **queryable knowledge graph backed by DynamoDB** (nodes table + edges table, adjacency-list + reverse-lookup GSI; source of truth) with an **S3 snapshot projection** for the UI's fast full-graph render. Populate it deterministically from the AST/graphify recon facts (no Cypher/bolt). Add **AI-agent navigation tools** over the store — e.g. dependency subgraph of a function/library, transitive reach across the app, in/out neighbors — so agents can fully navigate a codebase. The same Graph-tab UI keeps working, now reading the new store. (DynamoDB-vs-S3 + schema to be finalized in the design phase; DynamoDB is the recommendation.)

---

## A. Graph / scan storage (Assess "Graph" + Dev-pipeline "Graph" tabs)

**Current state:** Both graph tabs fail. The scan itself succeeds (233 findings + `graphify-out/graph-ui.json` built on disk); the dev-pipeline compile step logs `graph snapshot not found after sync (Memgraph unavailable?)`.

**Root causes (two, independent):**

- **Storage** (affects scan graph + scan report + dev graph): everything read/wrote the dead old-account `futurator-ai-website` bucket.
- **Compute** (dev graph only): Memgraph absent → no snapshot generated at all. (Scan graph is unaffected — it comes from deterministic graphify recon, no Memgraph.)

**Already done (this session):**

- ✅ Created `futurator-knowledge-live-eu` (eu-central-1): block-public-access off, public-read on `knowledge-live/*`, CORS GET \*.
- ✅ Backfilled + verified public-readable: `knowledge-live/mycelium/_refactor/graph.json` (216 KB, HTTP 200).
- ✅ Repointed **5 UI direct-read files** → new bucket: `src/hooks/use-scan-engine.ts`, `src/hooks/use-app-audit.ts`, `src/components/labs/app-detail/assess/refactor-graph.tsx`, `src/components/labs/plan-dashboard/views/growth-view.tsx`, `src/components/development/graph-viewer.tsx`.
- ✅ Repointed **daemon write** defaults: `daemon/agent-daemon.mjs` (4 lines) + `daemon/scripts/lib/s3-backup.mjs:26` (was hardcoded const → env-aware new default).
- ✅ Fixed `writeFileSync` missing from `daemon/agent-daemon.mjs:25` fs import (was throwing on local report write).

**Remaining fix scope (⚠️ the API read-side was MISSED in the first pass — split-brain):**

- Repoint the **API-side S3 reads** still on the old bucket:
  - `functions/api/index.ts:14329` `FORENSIC_S3_BUCKET = ... || 'futurator-ai-website'`
  - Hardcoded `Bucket: 'futurator-ai-website'` at `functions/api/index.ts:14981` (git-graph.json), and `:5520`, `:7039`.
  - `sst.config.ts:154` `const FUTURATOR_PUBLIC_BUCKET = 'futurator-ai-website'` → new bucket (this also sets the API Lambda env, currently `FUTURATOR_PUBLIC_BUCKET=futurator-ai-website`).
  - `sst.config.ts:1487` API role S3 read grant → new bucket.
- **Memgraph**: run it on whatever host builds snapshots (see Workstream F).
- **Redeploy** the API/UI (`sst deploy`) + restart the daemon.
- Fix stale `AWS_REGION=us-east-1` in `daemon/run-local.sh:32` → `eu-central-1` (run-fleet-local.sh already correct).

**Effort:** S for the code repoint; the deploy + daemon restart + Memgraph are shared ops (Workstream F).

---

## B. File Explorer

**Current state:** shows "EC2 instance is not running", empty. Reads files via **AWS SSM `SendCommand` into the single hardcoded EC2 instance**; both frontend and backend gate on `state === 'running'` of the dead instance.

**Files:** page `src/app/development/files/page.tsx`; component `src/components/development/file-explorer.tsx` (hardcoded `ROOT_PATH='/home/ubuntu'`, gate at :386-437); `file-viewer.tsx`; hooks `src/hooks/use-ec2-files.ts` (`GET/DELETE /api/ec2/files`, `/api/ec2/files/content`). Backend: `functions/api/index.ts:7175` (list), `:7313` (read), `:6892` (delete) — all via `sendSsmCommand` (`:6064`) to `EC2_INSTANCE_ID`.

**Root cause:** the instance doesn't exist → `DescribeInstances` → `not-found` → gate renders the empty panel; no file calls ever fire. SSM only works for AWS-account EC2 anyway — it can't reach Mac/GCP/Hetzner.

**Fix scope — recommended Option A (job round-trip, fits pull-only fleet):** model file-browse as a control job the **target daemon claims and executes locally** (`readdirSync`/`readFileSync` — daemon already imports these) and writes results to a DynamoDB row the API polls. Works uniformly for Mac + every provider; no inbound networking. New job type + repo, a daemon handler branch, two API routes (enqueue + poll-result), frontend server-picker + polling. **Effort: L (~2–4 days).**

- (Option B — parameterize SSM by `serverId`→`providerRef.instanceId` — only covers AWS boxes; insufficient for the Mac/fleet ask. Option C — direct daemon HTTP — breaks the pull-only model. Not recommended.)
- **Frontend (all options):** replace the `ec2Running` gate with a **heartbeat-freshness** check on the selected server; drop hardcoded `ROOT_PATH`; server-scoped projects root; generalize `/home/ubuntu` delete-allow-list regexes.

---

## C. Debates (run debates on migrated apps)

**Current state:** "Debates" is a thin portfolio UI over the existing **Party/BMAD engine** — a debate _is_ a party session. No separate backend/table/pipeline. Core create→turn→display runs on the **fleet daemon** and does **not** need EC2.

**Files:** page `src/app/debates/page.tsx`; `src/components/debates/new-debate-dialog.tsx` (only lists projects with `bmadStatus HEALTHY|DRIFTED`); hooks `use-party-sessions.ts`, `use-party-projects.ts`. Backend `functions/api/index.ts`: `POST /api/party/sessions` (:9802, **rejects unless HEALTHY** :9810), `POST /sessions/:id/messages` (:10688 → enqueues `jobType:'party-turn'`), events (:10902). Daemon: `daemon/pipelines/party-turn.mjs` (spawns Claude CLI `/bmad-party-mode` in a per-session worktree), `party-bootstrap.mjs`.

**Blockers to running on migrated apps:**

1. **`BrownfieldGithubPat` secret is DUMMY** → brownfield clone fails → project never reaches HEALTHY → never appears in the new-debate dialog. **#1 blocker.** Fix: `npx sst secret set BrownfieldGithubPat <fine-grained-PAT>` (contents:read on the migrated repos).
2. **No party projects registered** — populate `futurator-party-projects` (register each migrated app as brownfield, wait for bootstrap → HEALTHY on a fleet host).
3. **Repo must be materialized on the executing host** (cf. commit `2a6842b9` "repo-materialize on ALL hosts").
4. **Stale `EC2_INSTANCE_ID`** breaks the party **file-preview drawer** (SSM) + monitoring, but NOT create/turn/display. Fix via the shared EC2 instance-id resolution (Workstream F).
5. **Fleet Claude auth** on each host that may claim `party-turn`.

**Effort:** S–M (mostly secrets + registration + a smoke test), assuming the fleet daemon + auth are healthy.

---

## D. Free Agent (start using it)

**Current state:** **fully built and deployed on the EU account** (Epic 18). Global FAB widget, per-session STS role, confined git worktree, daemon `claude --print` pipeline, streaming events, Rung-0/1 merge flow. It is **NOT EC2-only** — `free-agent-session` jobs are claimable by any daemon; worktree/bare-repo roots are env-overridable.

**Files:** widget `src/components/free-agent/*` (mounted globally in `src/app/layout.tsx`); hooks `use-free-agent-session.ts` etc.; store `src/stores/free-agent-store.ts`. Backend `functions/api/index.ts:10913-11640` (STS AssumeRole → `jobType:'free-agent-session'`); IAM `functions/shared/lib/free-agent-iam.ts`; daemon `daemon/pipelines/free-agent-session.mjs` + `lib/free-agent-worktree.mjs`. SST: `FreeAgentSessionRole` (`sst.config.ts:1054`), tables `futurator-free-agent-sessions/-conversations`.

**Activation (no build needed, just wiring):**

1. **Flip the client gate:** the FAB is disabled unless `localStorage['futurator.labs.runtimeMode'] === 'ec2'` (`fab.tsx:20-48`). Despite the name, the daemon can be Mac/fleet. (Consider renaming/generalizing this gate as part of the fleet work.)
2. **Open the widget on a project or app page** (`/labs/projects/:id`, `/apps/:id`, `/labs?appId=`). `plan`/`workspace` scopes get synthetic ids → immediate `BARE_REPO_MISSING`.
3. **A bare repo** `<FUTURATOR_BARE_REPOS_ROOT>/<projectId>.git` must exist on the claiming daemon host (greenfield apps already have one; brownfield needs migrate first).
4. Verify the STS trust ARN pattern `futurator-admin-production-Api*` (`sst.config.ts:1069`) matches the deployed API role name; confirm daily spend cap headroom.

**Cleanup (optional):** stale `workingDir` written at `functions/api/index.ts:11107` (daemon recomputes; cosmetic).

**Effort:** S (config/verification). Rungs 2–5 (auto-merge, deployer self-update) are deferred.

---

## E. EC2 Monitor → Servers "Monitoring" tab

**Goal:** delete the standalone EC2 Monitor and re-implement it as a dynamic per-server Monitoring view in the Servers module (select any established server, watch its live monitoring).

**EC2 Monitor today:** single file `src/app/development/monitor/page.tsx` (nav `sidebar.tsx:39`). Data: `GET /api/ec2/metrics` (CloudWatch `GetMetricData`, `index.ts:7393`), `/api/ec2/snapshot` (SSM, `:7498`), `/api/ec2/status` (legacy `DAEMON_HEARTBEAT` row, `:6099`) — all hardcoded to `EC2_INSTANCE_ID`. Charts are a custom CSS sparkline `MetricChart` (no lib).

**Servers module today:** `src/components/development/servers/servers-view.tsx` — **2 tabs (Fleet, Dispatch Policy)**. Table `futurator-servers` (`sst.config.ts:646`); type `ComputeServer` (`functions/shared/types/compute-server.ts`) carries `system{totalMem,freeMem,loadAvg}`, `activeCount`, `auth`, `providerRef{instanceId,ip}`. **Every server already self-reports `system`+`activeCount`+`auth` via its heartbeat** (`daemon/agent-daemon.mjs:1782-1826`) — the universal cross-provider signal.

**Integration plan (scope):**

- Add a per-server **Monitoring** view (3rd tab with a server selector, or server-card drill-in). MVP = **live gauges from the heartbeat `system` block** → works for Local/EC2/GCP/Hetzner _today, no backend change_ (~1 story).
- **AWS-only enrichment:** parameterize `/api/ec2/metrics` + `/snapshot` by target instance (`server.providerRef.instanceId`), gate to `provider==='aws'`, show CloudWatch charts only then (~1–2 stories).
- **Per-job `processes[]` per server:** currently only on the legacy `DAEMON_HEARTBEAT` row (fleet daemons skip it, `agent-daemon.mjs:1729-1780`). To show per server, add `processes` to the per-server heartbeat write.
- **CPU% gap:** heartbeat reports mem+load but not CPU% — add to the heartbeat payload if a universal CPU gauge is wanted.
- **Time-series for non-EC2** (defer): server rows hold only the latest heartbeat; a history table + daemon append would be needed. MVP = live gauges only.
- **Delete:** `src/app/development/monitor/page.tsx` + nav entry. **Keep** the `/api/ec2/*` _control_ endpoints (enable/disable/start-daemon/cap/status) — used by header runtime controls, `ec2-toggle.tsx`, `reauthorize-button.tsx`. Only relocate the metrics/snapshot _presentation_.
- Reuse: lift `MetricChart` to a shared component; consolidate `CapControl`/`CapStepper`.

**Effort:** M overall (Low MVP + Medium enrichment).

---

## F. EC2 / Memgraph / IAM compute host (shared foundation)

**Live facts (verified read-only):**

- **No EC2 instance exists** in the new account, any region. Hardcoded `i-0826d68c316ae97dd` returns `InvalidInstanceID.NotFound`. Live API Lambda has **no `EC2_INSTANCE_ID` env** → falls back to the dead default.
- **No IAM instance profiles.** New model = **per-server IAM user** with static keys via cloud-init (`functions/shared/services/server-iam.ts`, `compute-providers/cloud-init.ts`). One live worker user: `futurator-server-srv_gcp_t4shwd`.
- **`futurator-server-worker` managed policy (v3) has NO `s3:PutObject`** on any knowledge bucket (only GetObject on the daemon-bundle bucket) → scoped fleet daemons **cannot write graph snapshots**. Definition `sst.config.ts:1230-1284`. (The 10KB inline-policy ceiling is on the **API role**, not this managed policy — headroom exists here.)
- **Memgraph = Docker** (`daemon/memgraph/docker-compose.yml`, `memgraph/memgraph:latest`, bolt 7687 no-auth). Snapshot built from it at `daemon/scripts/graph-sync.mjs:1906`. Driver `daemon/scripts/lib/memgraph-driver.mjs` (`MEMGRAPH_URI || bolt://localhost:7687`). Cloud-init does **not** install it.
- **Deploy:** legacy `scripts/rsync-daemon.sh` targets the dead old-account host (`ec2-54-86-226-233.compute-1` = us-east-1). New fleet model = `server-provisioning.ts` + cloud-init + systemd `futurator-daemon`. Cloud-init injects per-server AWS keys, `DAEMON_SOURCE`, region, etc., but **not** `FUTURATOR_PUBLIC_BUCKET` or `MEMGRAPH_URI`.

**Fix scope:**

1. **Add `s3:PutObject`/GetObject/DeleteObject/ListBucket on `futurator-knowledge-live-eu/knowledge-live/*`** to `ServerWorkerPolicy` (`sst.config.ts:1230`) so scoped fleet users can write snapshots.
2. **Repoint the API read side** (Workstream A) + `sst deploy` so the Lambda env flips.
3. **Provision a real compute host** — either an eu-central-1 EC2 (then set `EC2_INSTANCE_ID` env on the API + DeployerLambda) or lean on the GCP/fleet box. Decide whether to keep the EC2 control panel at all given the fleet model.
4. **Run Memgraph** on whatever host builds snapshots: add the `daemon/memgraph` compose step to cloud-init, or `docker compose up -d` in `daemon/memgraph/` (Mac short-term). `MEMGRAPH_URI` default works if co-located.
5. **Deploy current daemon code** to the host + restart systemd unit (fleet: re-provision/re-sync bundle; legacy rsync needs its host/SSH updated first).
6. Fix `daemon/run-local.sh:32` `AWS_REGION` → eu-central-1.

**Shortest path to a working Graph tab from the Mac (no EC2):** run Memgraph in Docker on the Mac + Mac daemon has admin creds (it does) + do Workstream-A read-side repoint & redeploy. That closes the loop because the write path already targets the new bucket.

---

## Cross-cutting fixes (shared across workstreams)

- **`EC2_INSTANCE_ID` resolution** — a single dead default poisons File Explorer, EC2 Monitor, party file-drawer, EC2 controls. Decide: (a) provision a real instance + set the env, or (b) generalize these features to the fleet/`futurator-servers` model and retire the single-instance assumption. This choice gates B, C(4), E, F(3).
- **Pull-only fleet transport** — File Explorer (Workstream B) and any future "reach into a box" feature need the **claimed-job round-trip** pattern. Consider building it once, reusably.
- **Bucket repoint completion** — finish the API side (A) so read/write agree; then redeploy.
- **Fleet host provisioning gaps** (from prior sessions): greenfield clone needs the `insteadOf` PAT rewrite or tokenized clone on non-EC2 hosts; the scan report-writer's OAuth-reload path is EC2-hardcoded. Fold into the fleet-provisioning work.

## Suggested sequencing for the ultracode plan

1. **Foundation (unblocks the most):** finish the bucket repoint (A read-side) + ServerWorkerPolicy S3 (F1) + `sst deploy`; run Memgraph on the target host (F4); decide the `EC2_INSTANCE_ID` strategy (cross-cutting).
2. **Quick wins:** Free Agent activation (D — config only); Debates secrets + project registration (C1–C2).
3. **Build:** EC2 Monitor→Servers Monitoring tab (E); File Explorer job round-trip (B).
4. **Verify:** re-run a scan (graph persists + Assess Graph tab renders), a dev plan (dev Graph tab renders from Memgraph), a debate on a migrated app, a free-agent session, and per-server monitoring.

## Out of scope / parked

- **Brickbreaker plan 1** is parked on a real paddle-input bug (VQA probe `paddle.x didn't increase` failed twice). Independent of this migration work; fix as a separate dev-quality item.
