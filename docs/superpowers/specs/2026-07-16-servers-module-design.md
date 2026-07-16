# Servers Module — Multi-Provider Compute Fleet & Server-Aware Dispatcher

**Date:** 2026-07-16
**Status:** Approved design, pending implementation plan
**Reference:** `~/Downloads/futurator-compute-provider-reference.md` (provider cost/CLI/latency analysis, July 2026)

## 1. Purpose

Replace the single always-on EC2 daemon host with an operator-managed **fleet** of
compute servers across providers (Hetzner, Oracle Cloud Free, GCP — plus the
existing EC2 box and local machines), all running the same agent daemon and
`claude -p` workloads. A new **Servers** module in the admin UI provisions,
credentials, activates, caps, and monitors these servers. A new **server-aware
dispatcher** assigns every agent job (queue requests, pipeline dev, debates,
labs, free-agent, migrate, ultracode-reverse) to a server according to
operator-calibrated policies.

Drivers:

- EC2 24/7 burns the AWS credit budget; Oracle Always Free ($0), Hetzner
  (~€7–17/mo), and GCP ($300 credit, stop = billing pause) are the chosen
  first three providers.
- Work volume is bursty (pipeline batches, incoming Mycelium plans); capacity
  should be added/removed/re-weighted per day, not re-architected.

## 2. Decisions (settled during brainstorming)

| Decision              | Choice                                                                                                                                                                                                                  |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provisioning scope    | **Full provisioning from day 1** — module stores provider credentials and creates/destroys VMs itself                                                                                                                   |
| Work delivery         | **Pull** — every server runs the existing agent daemon; dispatcher assigns, daemons poll for their own jobs                                                                                                             |
| Dispatch architecture | **Approach A: central assignment dispatcher** (Lambda stamps `assignedServerId`; rejected: decentralized pool claiming — cannot enforce splits; API-relay control plane — daemon I/O rewrite, kept as future hardening) |
| Scope                 | **All job types migrate to the one dispatcher** behind a feature flag; `ec2`/`local` become just two registered servers                                                                                                 |
| Claude auth           | Fleet daemons **fetch OAuth creds from an admin API endpoint** (per-server enrollment token); operator Re-auth flow unchanged at the source                                                                             |
| Google shape          | **GCE VM in v1** (identical daemon); **Cloud Run Jobs registered as a disabled/"coming soon" service type** so it is not forgotten                                                                                      |
| Pipeline git state    | **Plan-level affinity in v1** (a plan's jobs stick to one server); distributed-plan mode designed for v2, not built                                                                                                     |

## 3. Data model

### 3.1 New table: `futurator-servers` (PK `serverId`)

```ts
interface ComputeServer {
  serverId: string; // 'srv_hetzner_a1b2', 'srv_ec2_main', 'srv_local_mac'
  name: string; // operator label
  provider: 'hetzner' | 'oracle' | 'gcp' | 'aws' | 'local';
  serviceType: 'vm' | 'serverless' | 'local-machine'; // 'serverless' visible but disabled in v1
  region: string;
  size: string; // provider instance type (cax11, VM.Standard.A1.Flex, e2-small…)
  arch: 'arm64' | 'x86_64';
  status:
    | 'PROVISIONING'
    | 'BOOTSTRAPPING'
    | 'ACTIVE'
    | 'PAUSED'
    | 'ERROR'
    | 'DEPROVISIONING'
    | 'DELETED';
  statusMessage?: string; // provider error text when status = ERROR
  enabled: boolean; // participates in dispatch
  maxConcurrent: number; // per-server cap
  costPerHour: number; // USD; informative + cheapest-first sort key
  providerRef: { instanceId?: string; ip?: string };
  enrollTokenHash: string; // hash of the per-server enrollment token
  iamUserName?: string; // 'futurator-server-<id>' (cloud servers only)
  // Heartbeat — written by the server's daemon every ~10s:
  lastHeartbeatAt?: string;
  activeCount?: number;
  daemonVersion?: string;
  system?: { totalMem: number; freeMem: number; loadAvg: number[] };
  createdAt: string;
  updatedAt: string;
}
```

Heartbeats live **on the server row**, replacing the single fixed-key
`DAEMON_HEARTBEAT` row (which EC2 and local daemons currently overwrite —
a known collision). The legacy row keeps being written during migration so the
EC2 Monitor UI continues to work.

Table access: repository file `functions/shared/repositories/servers-repository.ts`
(pure functions, same pattern as `queue-requests-repository.ts`). Table linked
to Lambdas via the **managed policy** (not inline links — the API role is at the
10KB inline-policy ceiling).

### 3.2 Dispatch policy (existing `futurator-agent-flags` table)

Key `dispatch.policy`:

```ts
interface DispatchPolicy {
  mode: 'priority' | 'weighted' | 'cheapest';
  priorityOrder: string[]; // serverIds, first = preferred
  weights: Record<string, number>; // serverId -> percentage (weighted mode)
  updatedAt: string;
}
```

Feature flag key `dispatch.serverAware` (boolean): off = legacy `target`
routing byte-for-byte; on = assignment-based dispatch. Instant rollback.

### 3.3 Job-row additions (`futurator-agent-jobs`)

```ts
assignedServerId?: string;   // stamped by the dispatcher
assignedAt?: string;
assignReason?: string;       // human-readable, e.g. "weighted 50/50: gcp 3/6, oracle 3/6"
affinityKey?: string;        // e.g. 'plan:<planId>' — sticky server assignment
pinnedServerId?: string;     // operator/API pin, bypasses policy (Local/EC2 toggle maps here)
claimOwner?, claimToken?, claimExpiresAt?  // generalized atomic-claim lease fields
```

New GSI on `futurator-agent-jobs`: `assignedServerId-status-index` so each
daemon polls only its own PENDING jobs.

### 3.4 Secrets

- **Provider credentials** (Hetzner API token, OCI signing key + config, GCP
  service-account JSON): AWS Secrets Manager at
  `futurator/compute-providers/<provider>`, written by
  `functions/shared/services/provider-credentials-sm.ts` (same
  create-or-update pattern as `broker-credentials-sm.ts`). Write-only from the
  UI: the frontend sees `configured: true` + a last-4 hint, never the secret.
- **Claude OAuth credentials**: unchanged at the source (operator Mac Keychain
  → SSM via `mac-oauth-sync.sh` + Re-auth button). Distribution changes — see §6.

## 4. Provisioning engine

### 4.1 Provider adapters

`functions/shared/services/compute-providers/` — one file per provider behind:

```ts
interface ComputeProviderAdapter {
  provision(spec: ProvisionSpec): Promise<ProviderRef>; // create VM + cloud-init
  destroy(ref: ProviderRef): Promise<void>; // DELETE (not stop) — Hetzner/Oracle bill stopped VMs
  status(ref: ProviderRef): Promise<ProviderStatus>;
  stop?(ref): Promise<void>; // GCP only — stop genuinely pauses compute billing
  start?(ref): Promise<void>;
}
```

- `hetzner.ts` — plain REST `https://api.hetzner.cloud/v1/servers`, bearer
  `HCLOUD_TOKEN`. Default type CAX11/CX22, location `fsn1`/`nbg1`.
- `oracle.ts` — OCI REST with request signing. Shape `VM.Standard.A1.Flex`
  (free cap 2 OCPU / 12 GB post-June-2026), region Frankfurt. Retries
  provisioning across availability domains on ARM "out of capacity" errors.
- `gcp.ts` — service-account JWT + Compute Engine REST, `europe-west3`,
  default `e2-small`/`e2-medium`. Startup script via instance metadata.
  Additionally registers a **Cloud Run Jobs entry with `available: false`**
  (renders greyed-out "Serverless — coming in v2" in the wizard).
- `local.ts` — no provisioning; generates an enrollment token + install
  one-liner for a machine the operator sets up (Mac, future desktop app).

Adapters are pure request-builders + fetch; no provider SDK dependencies
unless OCI signing forces a minimal one.

### 4.2 Async provisioning flow (Lambda never waits)

1. `POST /api/servers` validates (Zod), writes row `status: PROVISIONING`,
   mints enrollment token (hash stored), creates the per-server IAM user +
   access keys, calls `adapter.provision()` with a cloud-init payload
   (seconds), returns 202.
2. **cloud-init on the VM**: install Node LTS + git + claude CLI (native
   binary); create service user; pull the daemon bundle from S3 (same bundle
   `POST /api/ec2/start-daemon` syncs today) using the injected scoped AWS
   keys; write `/etc/futurator/daemon.env` (`SERVER_ID`, `ENROLL_TOKEN`,
   `ADMIN_API_URL`, AWS keys, `MAX_CONCURRENT`); fetch Claude OAuth creds from
   the API (§6); install + start the `futurator-daemon` systemd unit.
3. Daemon boots → first heartbeat writes to the server row → API-side check
   flips `BOOTSTRAPPING`→`ACTIVE`. (`PROVISIONING`→`BOOTSTRAPPING` flips when
   the provider reports the VM running, via the sweeper's `adapter.status()`
   or on-demand refresh.)
4. Failures (bad token, ARM capacity, cloud-init crash) land the row in
   `ERROR` with `statusMessage`; the UI offers Retry / Destroy.

### 4.3 Per-server AWS access (off-AWS servers)

One IAM user per cloud server (`futurator-server-<serverId>`), attached to a
single shared **managed policy** scoped to: the DynamoDB tables the daemon
touches, and read-only access to the S3 daemon-bundle prefix. Keys are
delivered only via cloud-init (never stored in DynamoDB).
**Destroy = full revocation**: delete VM at provider + delete IAM user/keys +
invalidate enrollment token + mark row `DELETED`.

Future hardening path (explicitly out of scope for v1): replace direct
DynamoDB access with an HTTP job API on the admin Lambda (Approach C), at
which point per-server IAM users disappear.

## 5. Dispatcher

`functions/shared/services/server-dispatcher.ts`, core function
`assignPendingJobs()`:

1. Load PENDING jobs with no `assignedServerId` (`status-createdAt-index`,
   oldest first).
2. Load eligible servers: `ACTIVE` + `enabled` + heartbeat < 60s stale + free
   capacity (`activeCount` + assigned-but-unclaimed < `maxConcurrent`).
3. **Affinity resolution first** (§5.1) — jobs whose `affinityKey` already has
   an owner go to that owner (or wait if it's at cap).
4. **Policy** for everything else:
   - `priority` — fill first server in `priorityOrder` to its cap, overflow to next.
   - `weighted` — deficit round-robin so the batch converges on the configured
     percentages, caps respected.
   - `cheapest` — sort eligible servers by `costPerHour` asc, then priority-fill.
5. Stamp `assignedServerId`, `assignedAt`, `assignReason`.
6. `pinnedServerId` bypasses policy entirely (used by the Local/EC2 header
   toggle and by queue-request `target` during migration).

Jobs with no capacity anywhere stay unassigned — that **is** the queue.

**Triggers:** inline after every enqueue path; after any policy/cap/enable
change; and a **1-minute EventBridge sweeper** that additionally:

- reassigns non-affinity jobs whose assigned server's heartbeat is > 2 min stale;
- releases expired claim leases (orphan recovery, reusing
  `buildOrphanReleaseParams` semantics);
- refreshes provider `status()` for rows in PROVISIONING/BOOTSTRAPPING.

### 5.1 Affinity (pipeline plans and other repo-stateful work)

Pipeline dev jobs carry `affinityKey: 'plan:<planId>'`. Rule: **all jobs
sharing an affinity key run on the server that owns the key** — ownership is
assigned by the normal policy when the first job of the key arrives, then
sticky. Rationale: a plan's app repo, story worktrees, and green-trunk merges
are server-local filesystem state; scattering one plan's stories across
servers would require distributed git (v2, §10).

Consequences (accepted):

- One plan's parallelism is bounded by its owner server's cap. Scale-out is
  **across plans** (plan A → Hetzner, plan B → Oracle, plan C → GCP), which
  matches the incoming-Mycelium-plans workload.
- If the owner server dies mid-plan, the plan's remaining jobs **pause**
  (`assignReason: 'affinity owner unreachable'`) and surface in the UI for an
  explicit operator "migrate plan" decision. No silent reassignment — the repo
  state lives on that box.

### 5.2 Daemon changes (deliberately small)

- New env `SERVER_ID` (fallback: map legacy `DAEMON_SOURCE` ec2→`srv_ec2_main`,
  local→`srv_local_mac`).
- Poll `assignedServerId-status-index` for own PENDING jobs (replaces
  global-pool polling + `isJobClaimableBySource` when the flag is on).
- Claim via the **generalized atomic-claim CAS** (conditional
  PENDING→RUNNING write + 15-min lease, renewed while running) — replaces the
  unconditional RUNNING write, making N servers race-proof.
- Heartbeat → own row in `futurator-servers` (legacy `DAEMON_HEARTBEAT` row
  kept during migration).
- Claude spawn, stream-json parsing, pipelines, watchdogs: untouched.

## 6. Claude OAuth distribution (fleet Re-auth)

- Source unchanged: operator logs in on the Mac, clicks **Re-auth**, creds
  sync Keychain → SSM.
- New endpoint `GET /api/servers/agent-credentials`, authenticated by header
  `x-server-token` (per-server enrollment token; **not** operator JWT; route
  added to the JWT-skip list with its own guard, like `/api/queue/ingest`).
  Returns the OAuth credentials JSON read from SSM.
- Each daemon fetches: on boot; when its hourly auth probe fails; and
  periodically (~6h). One Re-auth click re-arms the whole fleet within a
  poll cycle on any provider.
- Token lookup is by hash; revoking a server invalidates its token immediately.

## 7. API surface (all in `functions/api/index.ts`, operator JWT unless noted)

| Route                                               | Purpose                                                        |
| --------------------------------------------------- | -------------------------------------------------------------- |
| `GET /api/servers`                                  | List fleet (rows include heartbeat snapshot)                   |
| `POST /api/servers`                                 | Create + provision (202, async flow §4.2)                      |
| `PUT /api/servers/:id`                              | Update `name`, `enabled`, `maxConcurrent`, `costPerHour`       |
| `POST /api/servers/:id/destroy`                     | Deprovision + revoke (confirm in UI)                           |
| `POST /api/servers/:id/retry`                       | Re-run provisioning from ERROR                                 |
| `POST /api/servers/:id/stop` / `start`              | GCP billing pause (adapter capability-gated)                   |
| `GET /api/servers/policy` / `PUT`                   | Read/write `dispatch.policy` (re-runs assignment on write)     |
| `POST /api/servers/providers/:provider/credentials` | Store provider secret (write-only)                             |
| `GET /api/servers/providers`                        | Provider catalog + `configured` flags + disabled service types |
| `GET /api/servers/agent-credentials`                | **`x-server-token` auth** — Claude OAuth relay (§6)            |
| `GET /api/servers/assignments`                      | Recent jobs with `assignedServerId` + `assignReason` (UI feed) |

Zod schemas in `functions/shared/schemas/servers-schema.ts`; `.safeParse()`
throughout; errors via `AppError`/`ValidationError`.

## 8. Frontend

Sidebar → Development → **Servers** (`/development/servers`), pattern copied
from the Queues module (`queues-view.tsx` container + tabs; hook
`src/hooks/use-servers.ts` polling 5s; types mirror `src/types/servers.ts`).

- **Fleet tab** — card per server: provider, region/size/arch, status badge,
  heartbeat freshness, `activeCount`/`maxConcurrent`, cost/hr, enable toggle,
  actions (stop/start where supported, re-fetch credentials, retry, destroy —
  destroy confirms with "delete = billing stops on this provider").
- **Add Service wizard** — Provider → Service type (VM; Cloud Run Jobs greyed
  "coming in v2"; Local generates install one-liner) → Credentials step
  (skipped when configured) → Region/size/cap/estimated monthly cost →
  Provision → live PROVISIONING/BOOTSTRAPPING/ACTIVE progress from the row.
- **Dispatch Policy tab** — mode selector (Priority / Weighted / Cheapest),
  drag-to-order or per-server weight sliders, plus the recent-assignments feed
  (`assignReason` visible) to verify calibration; paused-plan (affinity owner
  down) alerts surface here with the "migrate plan" action stub (v1: shows
  guidance; actual migration is manual).
- Header **Local/EC2 toggle** remains; semantically it now sets
  `pinnedServerId` (`srv_local_mac`) vs auto-policy.

## 9. Migration & rollout

1. Deploy: new table + GSI, routes, daemon changes, UI (`sst deploy` — never
   manual S3 sync).
2. Seed `srv_ec2_main` and `srv_local_mac` rows; existing daemons enroll via
   the `DAEMON_SOURCE` fallback without config edits.
3. Flip `dispatch.serverAware` on; watch the Servers UI (assignments feed).
   Rollback = flip off.
4. Provision **Oracle first** ($0 crash-test dummy) → one queue-request e2e →
   then Hetzner → then GCP.
5. Later cleanup (separate change): remove legacy `target` routing +
   `DAEMON_HEARTBEAT` writes once the flag has been on and stable.

## 10. Scaling path — distributed plans (v2, designed, NOT built)

When one plan's stories must spread across servers:

- Each app gets a **central git remote** (GitHub private repo; `GithubPat`
  secret and one-way sync patterns already exist).
- Servers fetch trunk, create a branch per story, push story branches.
- The **integrator stays singular** (runs on the plan's affinity-owner
  server), performs green-trunk merges sequentially, pushes trunk; other
  servers fetch before starting dependent stories.
- Planner v3's disjoint-`touches` gating makes cross-server merges
  near-trivial; the topological frontier replaces wave barriers (the slowness
  of the legacy wave system was barrier + conflicts, not branching).
- Nothing in v1 contradicts this: story jobs already carry `planId`
  (→ `affinityKey`), and the integrator is already a distinct role. v2 is
  additive: remote-hub wiring + fetch/push steps + "migrate plan" automation.

Also v2: Cloud Run Jobs execution model (dispatcher triggers a job execution
per batch; container pulls assigned work, runs `claude -p`, exits;
state externalized) — enabled by flipping the catalog entry `available: true`
and adding a `serverless` dispatch branch.

## 11. Error handling

- Provisioning errors → row `ERROR` + `statusMessage` + Retry/Destroy actions.
- Stale server (heartbeat > 2 min): non-affinity jobs reassigned by sweeper;
  affinity jobs pause with visible reason.
- Claim-lease expiry → orphan release → job back to PENDING → reassignment.
- Creds endpoint: invalid/revoked `x-server-token` → 401; daemon backs off and
  surfaces `auth: failed` in its heartbeat (visible on the card).
- Provider API outages: adapters retry with backoff; sweeper tolerates
  `status()` failures without flapping server state.

## 12. Testing

- **Vitest (functions/)**: dispatcher policy engine as pure functions
  (priority/weighted/cheapest × caps × stale heartbeats × affinity ownership ×
  pinning); adapter request-builders with mocked fetch (auth headers, payload
  shapes, OCI signing); servers repository; Zod schemas; creds-endpoint token
  auth.
- **Vitest (daemon/)**: generalized CAS claim (contention: two claimers, one
  wins), assigned-poll filtering, `SERVER_ID` fallback mapping, heartbeat
  row writes (existing `daemon/pipelines/__tests__` patterns).
- **Playwright**: Servers page smoke (mocked routes) per existing conventions.
- **Live validation**: Oracle free e2e first, then Hetzner, then GCP;
  real pipeline plan on a fleet of 2 to observe affinity + policy behavior.

## 13. Out of scope (v1)

- Cloud Run Jobs execution (catalog-listed, disabled).
- Automatic plan migration between servers.
- Chrome-extension / desktop-app local runners (the `local` provider +
  enrollment token is the seam they will use).
- Auto-scaling (provisioning on queue depth) and scheduled stop/start.
- API-relay control plane (Approach C hardening).
