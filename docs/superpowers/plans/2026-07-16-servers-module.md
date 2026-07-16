# Servers Module Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Multi-provider compute fleet (Hetzner/Oracle/GCP/EC2/local) with full provisioning, per-server caps, and a central server-aware dispatcher that assigns every agent job by operator policy (priority / weighted / cheapest) with plan-level affinity.

**Architecture:** New `futurator-servers` DynamoDB table + pure-function policy engine + Lambda dispatcher (inline on enqueue + 1-min sweeper cron) stamping `assignedServerId` on `futurator-agent-jobs`; daemons poll a new GSI for their own jobs and claim via CAS lease. Provider adapters (plain REST + signing, no SDKs) provision VMs whose cloud-init self-registers the daemon. Everything gated behind agent-flag `dispatch.serverAware`.

**Tech Stack:** SST v4 (Pulumi), Hono.js Lambda, DynamoDB, Secrets Manager, Zod, TanStack Query + Zustand + shadcn/ui, node:test for daemon `.mjs`, Vitest for `functions/**` and `src/**`.

**Spec:** `docs/superpowers/specs/2026-07-16-servers-module-design.md` — read it before starting any task.

## Global Constraints

- Deploy ONLY with `sst deploy`. NEVER `aws s3 sync out/ s3://futurator-ai-website/` (breaks futurator.ai — see CLAUDE.md).
- One DynamoDB table per concern; never single-table design.
- New table/GSI Lambda permissions go in a **managed policy via the SST `policies:` prop** — never new inline `link:` entries (API role is at the 10KB inline ceiling; a new link breaks deploy and strips prod perms).
- All API validation via Zod `.safeParse()`; errors via `AppError`/`ValidationError` from `functions/shared/errors.ts`.
- Bearer JWT auth; no cookies. Machine endpoints self-guard with their own header + must be added to the JWT-skip list in `functions/api/index.ts` (~line 499).
- Frontend API paths: `api.get('/servers')` NOT `/api/servers` — the client base already ends in `/api`.
- `npm run lint` runs with `--max-warnings 0`; `npm run typecheck` is strict; run both before every commit.
- Daemon files are plain `.mjs` (no TypeScript); daemon deps install with `cd daemon && npm install`.
- Region is whatever SST injects (`AWS_REGION`, eu-central-1 account 421515025850) — never hardcode us-east-1.
- Providers bill stopped VMs (Hetzner/Oracle): `destroy` must DELETE, never stop. Only the GCP adapter implements `stop`/`start`.
- Feature flag `dispatch.serverAware` OFF ⇒ legacy behavior byte-for-byte. Every daemon/dispatcher change must be inert when the flag is off.

---

## Phase A — Dispatch core (tasks 1–7)

### Task 1: Shared types + Zod schemas

**Files:**

- Create: `functions/shared/types/compute-server.ts`
- Create: `functions/shared/schemas/servers-schema.ts`
- Test: `functions/shared/schemas/__tests__/servers-schema.test.ts`

**Interfaces:**

- Produces: `ComputeServer`, `ComputeServerStatus`, `ComputeProviderId`, `ServerServiceType`, `DispatchPolicy`, `DEFAULT_DISPATCH_POLICY`, `createServerSchema`, `updateServerSchema`, `dispatchPolicySchema`, `providerCredentialsSchema` — every later task imports from these two files.

- [ ] **Step 1: Write the failing test**

```ts
// functions/shared/schemas/__tests__/servers-schema.test.ts
import { describe, it, expect } from 'vitest';
import {
  createServerSchema,
  dispatchPolicySchema,
  providerCredentialsSchema,
} from '../servers-schema';

describe('servers-schema', () => {
  it('accepts a valid createServer payload', () => {
    const r = createServerSchema.safeParse({
      name: 'hetzner-fsn-1',
      provider: 'hetzner',
      serviceType: 'vm',
      region: 'fsn1',
      size: 'cax11',
      arch: 'arm64',
      maxConcurrent: 2,
      costPerHour: 0.008,
    });
    expect(r.success).toBe(true);
  });

  it('rejects serverless serviceType in v1', () => {
    const r = createServerSchema.safeParse({
      name: 'x',
      provider: 'gcp',
      serviceType: 'serverless',
      region: 'europe-west3',
      size: 'cloud-run',
      arch: 'x86_64',
      maxConcurrent: 1,
      costPerHour: 0,
    });
    expect(r.success).toBe(false);
  });

  it('rejects maxConcurrent outside 1-16', () => {
    const base = {
      name: 'x',
      provider: 'hetzner',
      serviceType: 'vm',
      region: 'fsn1',
      size: 'cax11',
      arch: 'arm64',
      costPerHour: 0,
    };
    expect(createServerSchema.safeParse({ ...base, maxConcurrent: 0 }).success).toBe(false);
    expect(createServerSchema.safeParse({ ...base, maxConcurrent: 17 }).success).toBe(false);
  });

  it('validates dispatch policy', () => {
    const r = dispatchPolicySchema.safeParse({
      mode: 'weighted',
      priorityOrder: ['srv_a', 'srv_b'],
      weights: { srv_a: 50, srv_b: 50 },
    });
    expect(r.success).toBe(true);
    expect(
      dispatchPolicySchema.safeParse({ mode: 'random', priorityOrder: [], weights: {} }).success,
    ).toBe(false);
  });

  it('validates provider credentials per provider', () => {
    expect(
      providerCredentialsSchema.safeParse({ provider: 'hetzner', credentials: { token: 'abc' } })
        .success,
    ).toBe(true);
    expect(
      providerCredentialsSchema.safeParse({ provider: 'hetzner', credentials: {} }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test -- functions/shared/schemas/__tests__/servers-schema.test.ts`
Expected: FAIL — cannot resolve `../servers-schema`.

- [ ] **Step 3: Implement types + schemas**

```ts
// functions/shared/types/compute-server.ts
export type ComputeProviderId = 'hetzner' | 'oracle' | 'gcp' | 'aws' | 'local';
export type ServerServiceType = 'vm' | 'serverless' | 'local-machine';
export type ComputeServerStatus =
  | 'PROVISIONING'
  | 'BOOTSTRAPPING'
  | 'ACTIVE'
  | 'PAUSED'
  | 'ERROR'
  | 'DEPROVISIONING'
  | 'DELETED';

export interface ComputeServer {
  serverId: string;
  name: string;
  provider: ComputeProviderId;
  serviceType: ServerServiceType;
  region: string;
  size: string;
  arch: 'arm64' | 'x86_64';
  status: ComputeServerStatus;
  statusMessage?: string;
  enabled: boolean;
  maxConcurrent: number;
  costPerHour: number;
  providerRef: { instanceId?: string; ip?: string; zone?: string; availabilityDomain?: string };
  enrollTokenHash: string;
  iamUserName?: string;
  lastHeartbeatAt?: string;
  activeCount?: number;
  daemonVersion?: string;
  system?: { totalMem: number; freeMem: number; loadAvg: number[] };
  createdAt: string;
  updatedAt: string;
}

export type DispatchMode = 'priority' | 'weighted' | 'cheapest';

export interface DispatchPolicy {
  mode: DispatchMode;
  priorityOrder: string[];
  weights: Record<string, number>;
  updatedAt: string;
}

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
  mode: 'priority',
  priorityOrder: [],
  weights: {},
  updatedAt: new Date(0).toISOString(),
};

// Heartbeat freshness for dispatch eligibility (spec §5 step 2)
export const HEARTBEAT_FRESH_MS = 60_000;
// Staleness threshold for reassignment by the sweeper (spec §11)
export const HEARTBEAT_STALE_MS = 120_000;
```

```ts
// functions/shared/schemas/servers-schema.ts
import { z } from 'zod';

const providerIds = ['hetzner', 'oracle', 'gcp', 'aws', 'local'] as const;

export const createServerSchema = z.object({
  name: z.string().min(1).max(64),
  provider: z.enum(providerIds),
  // 'serverless' is catalogued but not creatable in v1 (spec §2 Google shape)
  serviceType: z.enum(['vm', 'local-machine']),
  region: z.string().min(1),
  size: z.string().min(1),
  arch: z.enum(['arm64', 'x86_64']),
  maxConcurrent: z.number().int().min(1).max(16),
  costPerHour: z.number().min(0),
});

export const updateServerSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(16).optional(),
  costPerHour: z.number().min(0).optional(),
});

export const dispatchPolicySchema = z.object({
  mode: z.enum(['priority', 'weighted', 'cheapest']),
  priorityOrder: z.array(z.string()),
  weights: z.record(z.string(), z.number().min(0).max(100)),
});

const credentialShapes = {
  hetzner: z.object({ token: z.string().min(1) }),
  oracle: z.object({
    tenancyOcid: z.string().min(1),
    userOcid: z.string().min(1),
    fingerprint: z.string().min(1),
    privateKeyPem: z.string().min(1),
    compartmentId: z.string().min(1),
    region: z.string().min(1), // e.g. 'eu-frankfurt-1'
    imageId: z.string().min(1), // Ubuntu 24.04 ARM image OCID for the region
    availabilityDomains: z.array(z.string().min(1)).min(1),
  }),
  gcp: z.object({
    serviceAccountJson: z.string().min(1), // full SA key file content
    projectId: z.string().min(1),
    zone: z.string().min(1), // e.g. 'europe-west3-a'
  }),
} as const;

export const providerCredentialsSchema = z.discriminatedUnion('provider', [
  z.object({ provider: z.literal('hetzner'), credentials: credentialShapes.hetzner }),
  z.object({ provider: z.literal('oracle'), credentials: credentialShapes.oracle }),
  z.object({ provider: z.literal('gcp'), credentials: credentialShapes.gcp }),
]);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- functions/shared/schemas/__tests__/servers-schema.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add functions/shared/types/compute-server.ts functions/shared/schemas/servers-schema.ts functions/shared/schemas/__tests__/servers-schema.test.ts
git commit -m "feat(servers): compute-server types + zod schemas"
```

---

### Task 2: Infrastructure — table, GSI, envs, worker policy, sweeper cron shell

**Files:**

- Modify: `sst.config.ts`
- Modify: `functions/shared/dynamo-client.ts` (TABLE_NAMES)
- Create: `functions/cron/server-dispatch-sweeper.ts` (shell; real logic in Task 7)

**Interfaces:**

- Produces: env `SERVERS_TABLE` on API + sweeper Lambdas; env `SERVER_WORKER_POLICY_ARN`, `DAEMON_BUNDLE_S3_URI` on the API Lambda; `TABLE_NAMES.servers`; GSI `assignedServerId-status-index` on `futurator-agent-jobs`.
- Consumes: nothing from other tasks.

- [ ] **Step 1: Read the existing patterns first (do not guess)**

```bash
grep -n "sst.aws.Dynamo\|globalIndexes\|policies:" sst.config.ts | head -40
grep -n "agentJobs\|AgentJobs" sst.config.ts | head -20
grep -n "start-daemon" -A 20 functions/api/index.ts | grep -n "s3"   # find the daemon bundle bucket/prefix
grep -n "QUEUE_REQUESTS_TABLE" sst.config.ts functions/shared/dynamo-client.ts
```

Record: (a) exact style of table definitions, (b) the agent-jobs table construct name, (c) the S3 URI the daemon bundle syncs from (needed for `DAEMON_BUNDLE_S3_URI`), (d) how env vars are passed to the API function.

- [ ] **Step 2: Add the Servers table + GSI + envs + managed policies**

Following the recorded style, add to `sst.config.ts` (names adapted to match the file's conventions):

```ts
// 1) New table (PAY_PER_REQUEST like the rest)
const serversTable = new sst.aws.Dynamo('ServersTable', {
  fields: { serverId: 'string' },
  primaryIndex: { hashKey: 'serverId' },
});

// 2) New GSI on the EXISTING agent-jobs table definition — add to its globalIndexes:
//    'assignedServerId-status-index': { hashKey: 'assignedServerId', rangeKey: 'status' },
// DynamoDB allows only ONE GSI creation per deploy on a table — this is the only GSI change in this plan.

// 3) Managed policy the per-server IAM users attach to (daemon's table + bundle access).
//    Table ARNs via .arn outputs; bucket from the recorded bundle bucket.
const serverWorkerPolicy = new aws.iam.Policy('ServerWorkerPolicy', {
  policy: $resolve([
    agentJobsTable.arn,
    agentEventsTable.arn,
    agentFlagsTable.arn,
    queueRequestsTable.arn,
    serversTable.arn /* + other daemon tables recorded in Step 1 */,
  ]).apply((arns) =>
    JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Action: [
            'dynamodb:GetItem',
            'dynamodb:PutItem',
            'dynamodb:UpdateItem',
            'dynamodb:DeleteItem',
            'dynamodb:Query',
            'dynamodb:Scan',
            'dynamodb:BatchWriteItem',
          ],
          Resource: arns.flatMap((a) => [a, `${a}/index/*`]),
        },
        {
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:ListBucket'],
          Resource: ['arn:aws:s3:::<BUNDLE_BUCKET>', 'arn:aws:s3:::<BUNDLE_BUCKET>/*'],
        },
      ],
    }),
  ),
});
```

Replace `<BUNDLE_BUCKET>` with the bucket recorded in Step 1. Then wire the API function (and later the sweeper) via its existing `policies:`-prop managed policy — extend that policy document with:

```jsonc
// additions to the API role's managed policy statements:
{ "Effect": "Allow", "Action": ["dynamodb:GetItem","dynamodb:PutItem","dynamodb:UpdateItem","dynamodb:Query","dynamodb:Scan"], "Resource": ["<serversTable.arn>", "<serversTable.arn>/index/*", "<agentJobsTable.arn>/index/*"] },
{ "Effect": "Allow", "Action": ["secretsmanager:CreateSecret","secretsmanager:PutSecretValue","secretsmanager:GetSecretValue","secretsmanager:DescribeSecret"], "Resource": ["arn:aws:secretsmanager:*:*:secret:futurator/compute-providers/*", "arn:aws:secretsmanager:*:*:secret:futurator/claude-oauth-credentials*"] },
{ "Effect": "Allow", "Action": ["iam:CreateUser","iam:DeleteUser","iam:CreateAccessKey","iam:DeleteAccessKey","iam:ListAccessKeys","iam:AttachUserPolicy","iam:DetachUserPolicy","iam:TagUser"], "Resource": ["arn:aws:iam::*:user/futurator-servers/*"] }
```

Env additions on the API function: `SERVERS_TABLE: serversTable.name`, `SERVER_WORKER_POLICY_ARN: serverWorkerPolicy.arn`, `DAEMON_BUNDLE_S3_URI: '<recorded s3 uri>'`.

- [ ] **Step 3: Add the sweeper cron (shell handler)**

```ts
// functions/cron/server-dispatch-sweeper.ts
import { runDispatchSweep } from '../shared/services/server-dispatcher';

export const handler = async () => {
  const summary = await runDispatchSweep();
  console.log('[server-dispatch-sweeper]', JSON.stringify(summary));
};
```

(Task 6 creates `server-dispatcher.ts` — until then, export a temporary stub `runDispatchSweep = async () => ({ skipped: true, reason: 'not implemented' })` from a new file `functions/shared/services/server-dispatcher.ts` so typecheck passes.)

In `sst.config.ts`, next to the existing cron functions:

```ts
new sst.aws.Cron('ServerDispatchSweeper', {
  schedule: 'rate(1 minute)',
  function: {
    handler: 'functions/cron/server-dispatch-sweeper.handler',
    timeout: '60 seconds',
    memory: '256 MB',
    environment: {
      /* same table envs as the API function incl. SERVERS_TABLE, AGENT_JOBS_TABLE, AGENT_FLAGS_TABLE */
    },
    // permissions via the same managed-policy approach as the API function
  },
});
```

- [ ] **Step 4: Register the table name**

```ts
// functions/shared/dynamo-client.ts — add next to the other TABLE_NAMES entries:
servers: process.env.SERVERS_TABLE || 'futurator-servers',
```

- [ ] **Step 5: Verify + deploy + commit**

```bash
npm run typecheck && npm run lint
sst deploy   # watch for: ServersTable created, agent-jobs GSI ACTIVE, sweeper cron registered
aws dynamodb describe-table --table-name futurator-agent-jobs --query 'Table.GlobalSecondaryIndexes[].IndexName'
# Expected to include: assignedServerId-status-index
git add sst.config.ts functions/shared/dynamo-client.ts functions/cron/server-dispatch-sweeper.ts functions/shared/services/server-dispatcher.ts
git commit -m "feat(servers): servers table, assignedServerId GSI, worker policy, sweeper cron"
```

---

### Task 3: Servers repository

**Files:**

- Create: `functions/shared/repositories/servers-repository.ts`
- Test: `functions/shared/repositories/__tests__/servers-repository.test.ts`

**Interfaces:**

- Consumes: `TABLE_NAMES.servers` (Task 2), `ComputeServer` (Task 1), the shared DocumentClient from `functions/shared/dynamo-client.ts` (same import the queue repository uses — copy it).
- Produces:
  - `createServer(server: ComputeServer): Promise<void>`
  - `getServerById(serverId: string): Promise<ComputeServer | null>`
  - `listServers(opts?: { includeDeleted?: boolean }): Promise<ComputeServer[]>`
  - `updateServerFields(serverId: string, fields: Partial<ComputeServer>): Promise<void>` (partial SET, bumps `updatedAt`, aliases reserved words like the queue repo does)
  - `findServerByEnrollTokenHash(hash: string): Promise<ComputeServer | null>` (scan — fleet is small)

- [ ] **Step 1: Read the reference pattern**

Read `functions/shared/repositories/queue-requests-repository.ts` fully. Mirror its client import, marshalling style, `updateRequestFields` alias handling, and its test file's mocking approach (`functions/shared/repositories/__tests__/` — check how existing repo tests mock the DocumentClient; use `aws-sdk-client-mock` if that's what they use).

- [ ] **Step 2: Write failing tests**

```ts
// functions/shared/repositories/__tests__/servers-repository.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock'; // ADAPT to the project's existing repo-test mocking style
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  ScanCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import {
  createServer,
  getServerById,
  listServers,
  updateServerFields,
  findServerByEnrollTokenHash,
} from '../servers-repository';

const ddbMock = mockClient(DynamoDBDocumentClient);
const row = {
  serverId: 'srv_test_1',
  name: 't',
  provider: 'hetzner',
  serviceType: 'vm',
  region: 'fsn1',
  size: 'cax11',
  arch: 'arm64',
  status: 'ACTIVE',
  enabled: true,
  maxConcurrent: 2,
  costPerHour: 0.01,
  providerRef: {},
  enrollTokenHash: 'h1',
  createdAt: '2026-07-16T00:00:00Z',
  updatedAt: '2026-07-16T00:00:00Z',
};

beforeEach(() => ddbMock.reset());

describe('servers-repository', () => {
  it('createServer puts the row', async () => {
    ddbMock.on(PutCommand).resolves({});
    await createServer(row as never);
    expect(ddbMock.commandCalls(PutCommand)[0].args[0].input.Item?.serverId).toBe('srv_test_1');
  });

  it('getServerById returns null when missing', async () => {
    ddbMock.on(GetCommand).resolves({});
    expect(await getServerById('nope')).toBeNull();
  });

  it('listServers filters DELETED by default', async () => {
    ddbMock
      .on(ScanCommand)
      .resolves({ Items: [row, { ...row, serverId: 'srv_2', status: 'DELETED' }] });
    const list = await listServers();
    expect(list.map((s) => s.serverId)).toEqual(['srv_test_1']);
  });

  it('updateServerFields builds a partial SET and bumps updatedAt', async () => {
    ddbMock.on(UpdateCommand).resolves({});
    await updateServerFields('srv_test_1', { enabled: false, statusMessage: 'x' });
    const input = ddbMock.commandCalls(UpdateCommand)[0].args[0].input;
    expect(input.UpdateExpression).toContain('updatedAt');
    expect(input.UpdateExpression).toContain('enabled');
  });

  it('findServerByEnrollTokenHash scans for the hash', async () => {
    ddbMock.on(ScanCommand).resolves({ Items: [row] });
    const s = await findServerByEnrollTokenHash('h1');
    expect(s?.serverId).toBe('srv_test_1');
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test -- functions/shared/repositories/__tests__/servers-repository.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement the repository** (mirroring the queue repo verbatim in style; `listServers` = bounded `Scan` with in-code DELETED filter; `findServerByEnrollTokenHash` = `Scan` with `FilterExpression: 'enrollTokenHash = :h'`).

- [ ] **Step 5: Run tests, lint, typecheck, commit**

```bash
npm run test -- functions/shared/repositories/__tests__/servers-repository.test.ts && npm run lint && npm run typecheck
git add functions/shared/repositories/servers-repository.ts functions/shared/repositories/__tests__/servers-repository.test.ts
git commit -m "feat(servers): servers repository"
```

---

### Task 4: Dispatch policy engine (pure functions — the heart of the module)

**Files:**

- Create: `functions/shared/services/dispatch-policy.ts`
- Test: `functions/shared/services/__tests__/dispatch-policy.test.ts`

**Interfaces:**

- Consumes: `DispatchPolicy` (Task 1). NO I/O — pure functions only.
- Produces:

```ts
export interface EligibleServer {
  serverId: string;
  maxConcurrent: number;
  costPerHour: number;
  activeCount: number; // running now (from heartbeat)
  assignedPending: number; // assigned but not yet claimed
}
export interface PendingJobLite {
  jobId: string;
  createdAt: string;
  affinityKey?: string;
  pinnedServerId?: string;
}
export interface AssignmentDecision {
  jobId: string;
  serverId: string;
  reason: string;
}
export interface PlanResult {
  assignments: AssignmentDecision[];
  unassigned: { jobId: string; reason: string }[];
  affinityOwners: Record<string, string>; // input map + new ownerships
}
export function planAssignments(input: {
  jobs: PendingJobLite[]; // oldest first
  servers: EligibleServer[]; // pre-filtered: ACTIVE + enabled + fresh heartbeat
  policy: DispatchPolicy;
  affinityOwners: Record<string, string>;
}): PlanResult;
```

- [ ] **Step 1: Write the failing tests** (this is the behavior contract — implement to make exactly these pass)

```ts
// functions/shared/services/__tests__/dispatch-policy.test.ts
import { describe, it, expect } from 'vitest';
import { planAssignments, type EligibleServer, type PendingJobLite } from '../dispatch-policy';

const srv = (id: string, o: Partial<EligibleServer> = {}): EligibleServer => ({
  serverId: id,
  maxConcurrent: 2,
  costPerHour: 0.01,
  activeCount: 0,
  assignedPending: 0,
  ...o,
});
const job = (id: string, o: Partial<PendingJobLite> = {}): PendingJobLite => ({
  jobId: id,
  createdAt: `2026-07-16T00:00:0${id.slice(-1)}Z`,
  ...o,
});
const policy = (mode: 'priority' | 'weighted' | 'cheapest', o = {}) => ({
  mode,
  priorityOrder: [],
  weights: {},
  updatedAt: '',
  ...o,
});

describe('priority mode', () => {
  it('fills the first server to cap, overflows to the next', () => {
    const r = planAssignments({
      jobs: [job('j1'), job('j2'), job('j3')],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: {},
    });
    expect(r.assignments.map((a) => [a.jobId, a.serverId])).toEqual([
      ['j1', 'srv_a'],
      ['j2', 'srv_a'],
      ['j3', 'srv_b'],
    ]);
  });

  it('counts activeCount + assignedPending against the cap', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_a', { activeCount: 1, assignedPending: 1 }), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].serverId).toBe('srv_b');
  });

  it('servers missing from priorityOrder go last', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_new'), srv('srv_a')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].serverId).toBe('srv_a');
  });
});

describe('weighted mode', () => {
  it('splits a batch by weights ("half google half oracle")', () => {
    const r = planAssignments({
      jobs: ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'].map((j) => job(j)),
      servers: [srv('srv_gcp', { maxConcurrent: 6 }), srv('srv_oracle', { maxConcurrent: 6 })],
      policy: policy('weighted', { weights: { srv_gcp: 50, srv_oracle: 50 } }),
      affinityOwners: {},
    });
    const byServer = (id: string) => r.assignments.filter((a) => a.serverId === id).length;
    expect(byServer('srv_gcp')).toBe(3);
    expect(byServer('srv_oracle')).toBe(3);
  });

  it('respects caps even when weights say otherwise', () => {
    const r = planAssignments({
      jobs: ['j1', 'j2', 'j3', 'j4'].map((j) => job(j)),
      servers: [srv('srv_a', { maxConcurrent: 1 }), srv('srv_b', { maxConcurrent: 6 })],
      policy: policy('weighted', { weights: { srv_a: 90, srv_b: 10 } }),
      affinityOwners: {},
    });
    expect(r.assignments.filter((a) => a.serverId === 'srv_a').length).toBe(1);
    expect(r.assignments.filter((a) => a.serverId === 'srv_b').length).toBe(3);
  });

  it('a server with weight 0 or absent gets nothing while others have capacity', () => {
    const r = planAssignments({
      jobs: [job('j1'), job('j2')],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('weighted', { weights: { srv_a: 100 } }),
      affinityOwners: {},
    });
    expect(r.assignments.every((a) => a.serverId === 'srv_a')).toBe(true);
  });
});

describe('cheapest mode', () => {
  it('fills cheapest first (oracle $0 soaks up work)', () => {
    const r = planAssignments({
      jobs: [job('j1'), job('j2'), job('j3')],
      servers: [srv('srv_hetzner', { costPerHour: 0.01 }), srv('srv_oracle', { costPerHour: 0 })],
      policy: policy('cheapest'),
      affinityOwners: {},
    });
    expect(r.assignments.map((a) => a.serverId)).toEqual([
      'srv_oracle',
      'srv_oracle',
      'srv_hetzner',
    ]);
  });
});

describe('affinity', () => {
  it('first job of a key claims ownership via policy; siblings follow', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' }), job('j2', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a', { maxConcurrent: 6 }), srv('srv_b', { maxConcurrent: 6 })],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: {},
    });
    expect(r.assignments.every((a) => a.serverId === 'srv_a')).toBe(true);
    expect(r.affinityOwners['plan:p1']).toBe('srv_a');
  });

  it('existing owner is honored even if policy prefers another server', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a', 'srv_b'] }),
      affinityOwners: { 'plan:p1': 'srv_b' },
    });
    expect(r.assignments[0].serverId).toBe('srv_b');
  });

  it('owner at capacity => job waits (never reassigned to another server)', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a'), srv('srv_b', { activeCount: 2 })],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: { 'plan:p1': 'srv_b' },
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned[0].reason).toContain('affinity owner at capacity');
  });

  it('owner not in eligible set => job pauses with visible reason', () => {
    const r = planAssignments({
      jobs: [job('j1', { affinityKey: 'plan:p1' })],
      servers: [srv('srv_a')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: { 'plan:p1': 'srv_dead' },
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned[0].reason).toContain('affinity owner unreachable');
  });
});

describe('pinning', () => {
  it('pinnedServerId bypasses policy', () => {
    const r = planAssignments({
      jobs: [job('j1', { pinnedServerId: 'srv_b' })],
      servers: [srv('srv_a'), srv('srv_b')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].serverId).toBe('srv_b');
  });

  it('pinned server unavailable => job waits', () => {
    const r = planAssignments({
      jobs: [job('j1', { pinnedServerId: 'srv_gone' })],
      servers: [srv('srv_a')],
      policy: policy('priority'),
      affinityOwners: {},
    });
    expect(r.unassigned[0].reason).toContain('pinned server unavailable');
  });
});

describe('exhaustion', () => {
  it('no capacity anywhere => all jobs stay queued', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_a', { activeCount: 2 })],
      policy: policy('priority'),
      affinityOwners: {},
    });
    expect(r.assignments).toHaveLength(0);
    expect(r.unassigned[0].reason).toContain('no capacity');
  });

  it('every assignment carries a human-readable reason', () => {
    const r = planAssignments({
      jobs: [job('j1')],
      servers: [srv('srv_a')],
      policy: policy('priority', { priorityOrder: ['srv_a'] }),
      affinityOwners: {},
    });
    expect(r.assignments[0].reason).toMatch(/priority/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test -- functions/shared/services/__tests__/dispatch-policy.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// functions/shared/services/dispatch-policy.ts
import type { DispatchPolicy } from '../types/compute-server';

export interface EligibleServer {
  serverId: string;
  maxConcurrent: number;
  costPerHour: number;
  activeCount: number;
  assignedPending: number;
}
export interface PendingJobLite {
  jobId: string;
  createdAt: string;
  affinityKey?: string;
  pinnedServerId?: string;
}
export interface AssignmentDecision {
  jobId: string;
  serverId: string;
  reason: string;
}
export interface PlanResult {
  assignments: AssignmentDecision[];
  unassigned: { jobId: string; reason: string }[];
  affinityOwners: Record<string, string>;
}

export function planAssignments(input: {
  jobs: PendingJobLite[];
  servers: EligibleServer[];
  policy: DispatchPolicy;
  affinityOwners: Record<string, string>;
}): PlanResult {
  const { jobs, servers, policy } = input;
  const owners = { ...input.affinityOwners };
  const free = new Map<string, number>();
  for (const s of servers) {
    free.set(s.serverId, Math.max(0, s.maxConcurrent - s.activeCount - s.assignedPending));
  }
  const byId = new Map(servers.map((s) => [s.serverId, s]));
  const batchCount = new Map<string, number>(); // weighted-mode deficit tracking
  const assignments: AssignmentDecision[] = [];
  const unassigned: { jobId: string; reason: string }[] = [];

  const take = (serverId: string) => {
    free.set(serverId, (free.get(serverId) ?? 0) - 1);
    batchCount.set(serverId, (batchCount.get(serverId) ?? 0) + 1);
  };

  const policyPick = (): { serverId: string; reason: string } | null => {
    const withCapacity = servers.filter((s) => (free.get(s.serverId) ?? 0) > 0);
    if (withCapacity.length === 0) return null;
    if (policy.mode === 'priority') {
      const order = [
        ...policy.priorityOrder.filter((id) => byId.has(id)),
        ...servers.map((s) => s.serverId).filter((id) => !policy.priorityOrder.includes(id)),
      ];
      const id = order.find((sid) => (free.get(sid) ?? 0) > 0);
      return id
        ? { serverId: id, reason: `priority: ${order.indexOf(id) + 1} of [${order.join(', ')}]` }
        : null;
    }
    if (policy.mode === 'cheapest') {
      const cheapest = [...withCapacity].sort((a, b) => a.costPerHour - b.costPerHour)[0];
      return { serverId: cheapest.serverId, reason: `cheapest: $${cheapest.costPerHour}/h` };
    }
    // weighted: largest deficit = weight share minus share of this batch so far
    const weighted = withCapacity.filter((s) => (policy.weights[s.serverId] ?? 0) > 0);
    if (weighted.length === 0) return null;
    const totalW = weighted.reduce((sum, s) => sum + (policy.weights[s.serverId] ?? 0), 0);
    const totalAssigned = [...batchCount.values()].reduce((a, b) => a + b, 0);
    const pick = [...weighted].sort((a, b) => deficit(b) - deficit(a))[0];
    function deficit(s: EligibleServer): number {
      const target = (policy.weights[s.serverId] ?? 0) / totalW;
      const actual = totalAssigned === 0 ? 0 : (batchCount.get(s.serverId) ?? 0) / totalAssigned;
      return target - actual;
    }
    const pct = Object.entries(policy.weights)
      .map(([k, v]) => `${k} ${v}%`)
      .join(', ');
    return { serverId: pick.serverId, reason: `weighted [${pct}]` };
  };

  for (const j of jobs) {
    if (j.pinnedServerId) {
      if (byId.has(j.pinnedServerId) && (free.get(j.pinnedServerId) ?? 0) > 0) {
        assignments.push({
          jobId: j.jobId,
          serverId: j.pinnedServerId,
          reason: `pinned to ${j.pinnedServerId}`,
        });
        take(j.pinnedServerId);
      } else {
        unassigned.push({
          jobId: j.jobId,
          reason: `pinned server unavailable: ${j.pinnedServerId}`,
        });
      }
      continue;
    }
    if (j.affinityKey && owners[j.affinityKey]) {
      const owner = owners[j.affinityKey];
      if (!byId.has(owner)) {
        unassigned.push({
          jobId: j.jobId,
          reason: `affinity owner unreachable: ${owner} (${j.affinityKey})`,
        });
      } else if ((free.get(owner) ?? 0) <= 0) {
        unassigned.push({
          jobId: j.jobId,
          reason: `affinity owner at capacity: ${owner} (${j.affinityKey})`,
        });
      } else {
        assignments.push({
          jobId: j.jobId,
          serverId: owner,
          reason: `affinity ${j.affinityKey} -> ${owner}`,
        });
        take(owner);
      }
      continue;
    }
    const pick = policyPick();
    if (!pick) {
      unassigned.push({ jobId: j.jobId, reason: 'no capacity on any eligible server' });
      continue;
    }
    assignments.push({ jobId: j.jobId, serverId: pick.serverId, reason: pick.reason });
    take(pick.serverId);
    if (j.affinityKey) owners[j.affinityKey] = pick.serverId;
  }

  return { assignments, unassigned, affinityOwners: owners };
}
```

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -- functions/shared/services/__tests__/dispatch-policy.test.ts`
Expected: PASS (15 tests). If the weighted-split test is off-by-one, check the deficit tie-break: on equal deficit the sort must be stable w.r.t. server order — add `|| a.serverId.localeCompare(b.serverId)` as final tie-break and update the test only if genuinely ambiguous.

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck
git add functions/shared/services/dispatch-policy.ts functions/shared/services/__tests__/dispatch-policy.test.ts
git commit -m "feat(servers): pure dispatch policy engine (priority/weighted/cheapest/affinity/pin)"
```

---

### Task 5: Dispatch state — policy, flag, affinity owners in agent-flags

**Files:**

- Create: `functions/shared/services/dispatch-state.ts`
- Test: `functions/shared/services/__tests__/dispatch-state.test.ts`
- Modify: `functions/shared/repositories/agent-flags-repository.ts` (add three keys to `AGENT_FLAG_KEYS`)

**Interfaces:**

- Consumes: agent-flags repository's existing generic get/set functions (read the file first; reuse, don't reinvent).
- Produces:
  - `getDispatchPolicy(): Promise<DispatchPolicy>` (falls back to `DEFAULT_DISPATCH_POLICY`)
  - `setDispatchPolicy(p: Omit<DispatchPolicy, 'updatedAt'>): Promise<DispatchPolicy>`
  - `isServerAwareDispatchEnabled(): Promise<boolean>` (flag `dispatch.serverAware`, default **false**)
  - `getAffinityOwners(): Promise<Record<string, string>>` / `setAffinityOwners(map): Promise<void>` (flag key `dispatch.affinityOwners`; entries carry `lastSeenAt`, prune > 7 days on write)

- [ ] **Step 1: Read `functions/shared/repositories/agent-flags-repository.ts`**, note the existing key-constant pattern (`AGENT_FLAG_KEYS.maxConcurrentEc2 = 'concurrency.maxConcurrent.ec2'`) and its get/set function signatures. Add:

```ts
dispatchServerAware: 'dispatch.serverAware',
dispatchPolicy: 'dispatch.policy',
dispatchAffinityOwners: 'dispatch.affinityOwners',
```

- [ ] **Step 2: Write failing tests** covering: default policy when unset; round-trip set/get; flag default false; affinity-owner pruning (entry with `lastSeenAt` 8 days old dropped on write, fresh one kept). Mock the flags repository module with `vi.mock`.

- [ ] **Step 3: Implement `dispatch-state.ts`** — thin wrappers; store owners as `Record<string, { serverId: string; lastSeenAt: string }>` internally, expose flat `Record<string, string>`; validate policy reads with `dispatchPolicySchema.safeParse` and fall back to default on corrupt data.

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -- functions/shared/services/__tests__/dispatch-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck
git add functions/shared/services/dispatch-state.ts functions/shared/services/__tests__/dispatch-state.test.ts functions/shared/repositories/agent-flags-repository.ts
git commit -m "feat(servers): dispatch policy/flag/affinity state in agent-flags"
```

---

### Task 6: Server dispatcher service (I/O orchestration)

**Files:**

- Modify: `functions/shared/services/server-dispatcher.ts` (replace Task 2's stub)
- Test: `functions/shared/services/__tests__/server-dispatcher.test.ts`

**Interfaces:**

- Consumes: `planAssignments` (Task 4), `dispatch-state` (Task 5), `listServers` (Task 3), `TABLE_NAMES.agentJobs`, GSI `assignedServerId-status-index` + `status-createdAt-index`, `HEARTBEAT_FRESH_MS`/`HEARTBEAT_STALE_MS` (Task 1).
- Produces: `runDispatchSweep(): Promise<SweepSummary>` where

```ts
export interface SweepSummary {
  skipped: boolean;
  assigned: number;
  unassigned: number;
  reassignedFromStale: number;
  orphansReleased: number;
}
```

- [ ] **Step 1: Write failing tests** (mock DocumentClient + `dispatch-state` + `servers-repository` with `vi.mock`); cover at minimum:

1. Flag off ⇒ `{ skipped: true }` and zero DDB job writes.
2. Happy path: 2 unassigned PENDING jobs + 1 eligible server ⇒ 2 `UpdateCommand`s each with `ConditionExpression` containing `attribute_not_exists(assignedServerId)` and `SET` of `assignedServerId, assignedAt, assignReason`; summary `assigned: 2`.
3. Server with heartbeat older than `HEARTBEAT_FRESH_MS` is not eligible (jobs stay unassigned).
4. `ConditionalCheckFailedException` on one job write is swallowed (summary counts it as not assigned, sweep continues).
5. Stale reassignment: server heartbeat > `HEARTBEAT_STALE_MS`, one of its PENDING assigned jobs has no `affinityKey` ⇒ `REMOVE assignedServerId` write; one WITH `affinityKey` ⇒ only `assignReason = 'affinity owner unreachable: <id>'` update, assignment kept.
6. Orphan release: RUNNING job with `claimExpiresAt` in the past and `claimOwner` present ⇒ update back to `PENDING`, `REMOVE claimOwner, claimToken, claimExpiresAt`, with `ConditionExpression` checking `claimExpiresAt < :now` (a RUNNING job without claim fields is untouched).

- [ ] **Step 2: Run to verify failure**, then **Step 3: Implement**:

```ts
// functions/shared/services/server-dispatcher.ts — structure (full I/O, no stubs):
export async function runDispatchSweep(): Promise<SweepSummary> {
  if (!(await isServerAwareDispatchEnabled())) {
    return {
      skipped: true,
      assigned: 0,
      unassigned: 0,
      reassignedFromStale: 0,
      orphansReleased: 0,
    };
  }
  const now = Date.now();
  const servers = (await listServers()).filter((s) => s.status === 'ACTIVE');
  const fresh = servers.filter(
    (s) =>
      s.enabled && s.lastHeartbeatAt && now - Date.parse(s.lastHeartbeatAt) < HEARTBEAT_FRESH_MS,
  );

  // assignedPending per fresh server: Query GSI assignedServerId-status-index (Select COUNT, status=PENDING)
  // unassigned PENDING jobs: Query status-createdAt-index status=PENDING, ScanIndexForward true, Limit 100,
  //   FilterExpression 'attribute_not_exists(assignedServerId)'
  // -> map to PendingJobLite (jobId, createdAt, affinityKey, pinnedServerId)
  // plan = planAssignments({ jobs, servers: eligible, policy: await getDispatchPolicy(), affinityOwners: await getAffinityOwners() })
  // for each plan.assignments: UpdateCommand on agent-jobs
  //   ConditionExpression: 'attribute_not_exists(assignedServerId) AND #status = :pending'
  //   UpdateExpression: 'SET assignedServerId = :sid, assignedAt = :at, assignReason = :why'
  //   catch ConditionalCheckFailedException -> skip
  // persist plan.affinityOwners (stamp lastSeenAt for keys seen in this sweep)
  // STALE PASS: for ACTIVE servers with heartbeat > HEARTBEAT_STALE_MS:
  //   query their PENDING assigned jobs via the GSI;
  //   no affinityKey -> REMOVE assignedServerId, assignedAt SET assignReason=:requeued
  //   affinityKey    -> SET assignReason = 'affinity owner unreachable: <serverId>'
  // ORPHAN PASS: Query status-createdAt-index status=RUNNING,
  //   FilterExpression 'attribute_exists(claimOwner) AND claimExpiresAt < :nowIso'
  //   -> UpdateCommand SET #status=:pending REMOVE claimOwner, claimToken, claimExpiresAt
  //      ConditionExpression '#status = :running AND claimExpiresAt < :nowIso'
  // return counts
}
```

Write it as real code (the comment block above is the required control flow — every line becomes code; no TODOs may remain).

- [ ] **Step 4: Run tests to verify pass**

Run: `npm run test -- functions/shared/services/__tests__/server-dispatcher.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
npm run lint && npm run typecheck
git add functions/shared/services/server-dispatcher.ts functions/shared/services/__tests__/server-dispatcher.test.ts
git commit -m "feat(servers): server dispatcher — assign, stale-reassign, orphan release"
```

---

### Task 7: Wire dispatcher into API — enqueue hook, policy routes, assignments feed

**Files:**

- Modify: `functions/api/index.ts` (new "Servers module" route block + enqueue hook)
- Test: `functions/shared/services/__tests__/servers-routes.test.ts` (if the repo has a Hono route-test pattern, mirror it; otherwise test the handlers' service functions directly)

**Interfaces:**

- Consumes: `runDispatchSweep` (Task 6), `getDispatchPolicy`/`setDispatchPolicy` (Task 5), `dispatchPolicySchema` (Task 1).
- Produces routes (operator JWT):
  - `GET /api/servers/policy` → `{ policy: DispatchPolicy }`
  - `PUT /api/servers/policy` → validates body with `dispatchPolicySchema.safeParse`, saves, then `await runDispatchSweep()`, returns `{ policy, sweep }`
  - `GET /api/servers/assignments` → last 50 agent-jobs having `assignedServerId` (Query `status-createdAt-index` for PENDING+RUNNING, filter `attribute_exists(assignedServerId)`, newest first) → `[{ jobId, jobType, status, assignedServerId, assignReason, assignedAt, createdAt }]`

- [ ] **Step 1: Locate the Queues module block** (`functions/api/index.ts` ~line 6010) and add a parallel "Servers module" block after it with the three routes above, following the same error/JSON-envelope conventions.

- [ ] **Step 2: Enqueue hook.** In `enqueueQueueRequest()` (~line 6030), after the agent-job PutItem succeeds, add:

```ts
// fire-and-forget assignment; the 1-min sweeper covers any failure
try {
  await runDispatchSweep();
} catch (err) {
  console.warn('[dispatch] inline sweep failed (sweeper will retry)', err);
}
```

Also map the legacy `target` to a pin while the flag is on: when building `queueRequestPayload`, if `target === 'local'` set `pinnedServerId: 'srv_local_mac'` on the job row; if `'ec2'`, leave unpinned (policy decides). Legacy path (flag off) is untouched because the daemon ignores the new fields.

- [ ] **Step 3: Tests** — validate: PUT policy with invalid mode → 400; PUT policy happy path calls `setDispatchPolicy` and `runDispatchSweep` (mocked); GET assignments maps fields. Run + expect PASS.

- [ ] **Step 4: Verify the whole suite still passes**

Run: `npm run test && npm run lint && npm run typecheck`
Expected: all green (pre-existing failures, if any, must be proven pre-existing via `git stash && npm run test`).

- [ ] **Step 5: Commit**

```bash
git add functions/api/index.ts functions/shared/services/__tests__/servers-routes.test.ts
git commit -m "feat(servers): policy routes, assignments feed, enqueue dispatch hook"
```

---

## Phase B — Fleet plumbing (tasks 8–16)

### Task 8: Provider credentials service + routes + catalog

**Files:**

- Create: `functions/shared/services/provider-credentials-sm.ts`
- Create: `functions/shared/services/compute-providers/catalog.ts`
- Modify: `functions/api/index.ts` (2 routes)
- Test: `functions/shared/services/__tests__/provider-credentials-sm.test.ts`

**Interfaces:**

- Consumes: pattern from `functions/shared/services/broker-credentials-sm.ts` (read it first; mirror the create-or-update logic and client setup).
- Produces:
  - `putProviderCredentials(provider, credentials): Promise<void>` — secret name `futurator/compute-providers/<provider>`
  - `getProviderCredentials<T>(provider): Promise<T | null>`
  - `isProviderConfigured(provider): Promise<boolean>` (DescribeSecret, no value fetch)
  - `PROVIDER_CATALOG`: array of `{ provider, label, serviceTypes: [{ type, label, available, note? }], defaultRegions, defaultSizes }` — includes `{ provider: 'gcp', serviceTypes: [{ type: 'vm', available: true }, { type: 'serverless', available: false, note: 'Cloud Run Jobs — coming in v2' }] }` per spec §4.1, and `{ provider: 'local', serviceTypes: [{ type: 'local-machine', available: true }] }`.
  - Routes: `POST /api/servers/providers/:provider/credentials` (body via `providerCredentialsSchema.safeParse`; write-only; responds `{ configured: true }`) and `GET /api/servers/providers` (catalog + `configured` flag per provider; never returns secret material).

- [ ] **Step 1: Write failing tests** — mock SecretsManagerClient: create-then-update flow (`ResourceExistsException` → PutSecretValue), `getProviderCredentials` parses JSON, `isProviderConfigured` false on `ResourceNotFoundException`.
- [ ] **Step 2: Run to verify failure.**
- [ ] **Step 3: Implement** service + catalog + the two routes.
- [ ] **Step 4: Run tests + lint + typecheck** — PASS.
- [ ] **Step 5: Commit** — `feat(servers): provider credentials (Secrets Manager) + catalog routes`.

---

### Task 9: Claude OAuth relay — Secrets Manager push + fleet endpoint

**Files:**

- Modify: `scripts/mac-oauth-sync.sh` (add Secrets Manager mirror)
- Modify: `functions/api/index.ts` (endpoint + JWT-skip entry)
- Create: `functions/shared/services/agent-credentials-relay.ts`
- Test: `functions/shared/services/__tests__/agent-credentials-relay.test.ts`

**Interfaces:**

- Consumes: `findServerByEnrollTokenHash` (Task 3), SecretsManager client (Task 8 pattern).
- Produces:
  - Secret `futurator/claude-oauth-credentials` mirrored on every Re-auth.
  - `GET /api/servers/agent-credentials` — header `x-server-token`; sha256-hash it, look up the server; server must exist and be `ACTIVE`/`BOOTSTRAPPING`; return the raw credentials JSON. 401 on unknown/revoked token, 503 if the secret is missing.
  - `hashEnrollToken(token: string): string` (sha256 hex) — exported; Task 15 uses it when minting tokens.

- [ ] **Step 1: Read `scripts/mac-oauth-sync.sh`** to find where it currently pushes creds (SSM). After that push, add:

```bash
# Mirror to Secrets Manager so fleet servers (non-AWS) can fetch via the admin API
aws secretsmanager put-secret-value \
  --secret-id futurator/claude-oauth-credentials \
  --secret-string "$CREDS_JSON" 2>/dev/null \
|| aws secretsmanager create-secret \
  --name futurator/claude-oauth-credentials \
  --secret-string "$CREDS_JSON"
```

(`$CREDS_JSON` = the same JSON payload the script already reads from the Keychain — reuse its variable name.)

- [ ] **Step 2: Write failing tests** for the relay service: valid token → creds JSON; unknown token → `AuthError`; server status `DELETED` → `AuthError`; missing secret → 503-mapped error.
- [ ] **Step 3: Implement** `agent-credentials-relay.ts` + route. **Add `/api/servers/agent-credentials` to the JWT-skip list** (`functions/api/index.ts` ~line 499, next to `/api/queue/ingest`).
- [ ] **Step 4: Run tests + lint + typecheck** — PASS. Manually run `scripts/mac-oauth-sync.sh` once and verify: `aws secretsmanager get-secret-value --secret-id futurator/claude-oauth-credentials --query SecretString` returns the creds JSON.
- [ ] **Step 5: Commit** — `feat(servers): fleet Claude-OAuth relay endpoint + SM mirror in mac-oauth-sync`.

---

### Task 10: Per-server IAM users

**Files:**

- Create: `functions/shared/services/server-iam.ts`
- Test: `functions/shared/services/__tests__/server-iam.test.ts`

**Interfaces:**

- Consumes: env `SERVER_WORKER_POLICY_ARN` (Task 2).
- Produces:
  - `createServerIamUser(serverId): Promise<{ userName: string; accessKeyId: string; secretAccessKey: string }>` — user `futurator-server-<serverId>` under IAM path `/futurator-servers/`, tagged `{ futurator: 'server-worker', serverId }`, attach `SERVER_WORKER_POLICY_ARN`, create one access key.
  - `deleteServerIamUser(userName): Promise<void>` — list+delete access keys, detach policy, delete user; idempotent (`NoSuchEntityException` swallowed).

- [ ] **Step 1: Write failing tests** with mocked `IAMClient`: creation sequence (CreateUser → AttachUserPolicy → CreateAccessKey) and deletion idempotency.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** with `@aws-sdk/client-iam` (add to `package.json` if absent). **Step 4: PASS + lint + typecheck.**
- [ ] **Step 5: Commit** — `feat(servers): per-server scoped IAM users`.

---

### Task 11: Cloud-init / bootstrap builder

**Files:**

- Create: `functions/shared/services/compute-providers/cloud-init.ts`
- Test: `functions/shared/services/compute-providers/__tests__/cloud-init.test.ts`

**Interfaces:**

- Produces: `buildBootstrapScript(opts: BootstrapOpts): string` where

```ts
export interface BootstrapOpts {
  serverId: string;
  enrollToken: string;
  adminApiUrl: string; // 'https://hub.futurator.ai'
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  awsRegion: string;
  maxConcurrent: number;
  bundleS3Uri: string; // env DAEMON_BUNDLE_S3_URI
  arch: 'arm64' | 'x86_64';
}
```

- [ ] **Step 1: Write failing tests**: output starts with `#!/bin/bash`; contains `SERVER_ID=<id>`, `ENROLL_TOKEN=`, `DAEMON_SOURCE=<serverId>`, `aws s3 sync <bundleS3Uri>`, the systemd unit name `futurator-daemon`, the arch-correct awscli URL (`aarch64` for arm64, `x86_64` otherwise), a `curl` of the agent-credentials endpoint with the `x-server-token` header, and `chmod 600` of the credentials file.

- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** — template literal producing:

```bash
#!/bin/bash
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -y && apt-get install -y git curl unzip jq
curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs
# awscli v2 (arch-aware)
curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-<ARCH>.zip" -o /tmp/awscli.zip
unzip -q /tmp/awscli.zip -d /tmp && /tmp/aws/install
# claude native binary
curl -fsSL https://claude.ai/install.sh | bash
ln -sf "$HOME/.local/bin/claude" /usr/local/bin/claude || true
mkdir -p /opt/futurator/daemon /etc/futurator /root/.claude
cat > /etc/futurator/daemon.env <<'ENVEOF'
SERVER_ID=<serverId>
ENROLL_TOKEN=<enrollToken>
ADMIN_API_URL=<adminApiUrl>
AWS_ACCESS_KEY_ID=<awsAccessKeyId>
AWS_SECRET_ACCESS_KEY=<awsSecretAccessKey>
AWS_REGION=<awsRegion>
DAEMON_SOURCE=<serverId>
DAEMON_QUEUE_ONLY=0
MAX_CONCURRENT=<maxConcurrent>
CLAUDE_CREDENTIALS_PATH=/root/.claude/.credentials.json
ENVEOF
set -a; source /etc/futurator/daemon.env; set +a
# fetch Claude OAuth creds from the admin API
curl -fsS -H "x-server-token: $ENROLL_TOKEN" "$ADMIN_API_URL/api/servers/agent-credentials" -o /root/.claude/.credentials.json
chmod 600 /root/.claude/.credentials.json
aws s3 sync <bundleS3Uri> /opt/futurator/daemon/
cd /opt/futurator/daemon && npm install --omit=dev
cat > /etc/systemd/system/futurator-daemon.service <<'UNITEOF'
[Unit]
Description=Futurator agent daemon
After=network-online.target
[Service]
EnvironmentFile=/etc/futurator/daemon.env
ExecStart=/usr/bin/node /opt/futurator/daemon/agent-daemon.mjs
Restart=always
RestartSec=10
User=root
WorkingDirectory=/opt/futurator/daemon
[Install]
WantedBy=multi-user.target
UNITEOF
systemctl daemon-reload && systemctl enable --now futurator-daemon
```

(`<...>` are template substitutions filled by `buildBootstrapScript` — the generated output contains real values, never angle brackets.)

- [ ] **Step 4: PASS + lint + typecheck.** **Step 5: Commit** — `feat(servers): bootstrap/cloud-init builder`.

---

### Task 12: Hetzner adapter

**Files:**

- Create: `functions/shared/services/compute-providers/types.ts` (adapter contract)
- Create: `functions/shared/services/compute-providers/hetzner.ts`
- Test: `functions/shared/services/compute-providers/__tests__/hetzner.test.ts`

**Interfaces:**

- Produces (in `types.ts`, used by Tasks 13–15):

```ts
export interface ProvisionSpec {
  serverId: string;
  name: string;
  region: string;
  size: string;
  arch: 'arm64' | 'x86_64';
  userData: string;
}
export interface ProviderRef {
  instanceId?: string;
  ip?: string;
  zone?: string;
  availabilityDomain?: string;
}
export type ProviderState = 'creating' | 'running' | 'stopped' | 'terminated' | 'unknown';
export interface ProviderStatus {
  state: ProviderState;
  ip?: string;
  detail?: string;
}
export interface ComputeProviderAdapter {
  provision(spec: ProvisionSpec): Promise<ProviderRef>;
  destroy(ref: ProviderRef): Promise<void>;
  status(ref: ProviderRef): Promise<ProviderStatus>;
  stop?(ref: ProviderRef): Promise<void>;
  start?(ref: ProviderRef): Promise<void>;
}
```

- Consumes: `getProviderCredentials` (Task 8).

- [ ] **Step 1: Write failing tests** (stub `global.fetch` with `vi.stubGlobal`): provision POSTs to `https://api.hetzner.cloud/v1/servers` with bearer token and body `{ name, server_type: size, image: 'ubuntu-24.04', location: region, user_data }`, maps response `{ server: { id: 123, public_net: { ipv4: { ip } } } }` → `{ instanceId: '123', ip }`; destroy DELETEs `/servers/123` and treats 404 as success; status maps `running`→`running`, `initializing/starting`→`creating`, `off`→`stopped`; non-2xx (other than destroy-404) throws with the API error message.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement** (plain `fetch`; token from `getProviderCredentials<{token:string}>('hetzner')`). **Step 4: PASS.**
- [ ] **Step 5: Commit** — `feat(servers): hetzner adapter`.

---

### Task 13: OCI signer + Oracle adapter

**Files:**

- Create: `functions/shared/services/compute-providers/oci-signer.ts`
- Create: `functions/shared/services/compute-providers/oracle.ts`
- Test: `functions/shared/services/compute-providers/__tests__/oci-signer.test.ts`, `__tests__/oracle.test.ts`

**Interfaces:**

- Produces: `signOciRequest({ keyId, privateKeyPem, method, url, body? }): Record<string, string>` (headers incl. `authorization`, `date`, `host`, and for bodies `x-content-sha256`, `content-type`, `content-length`) implementing draft-cavage HTTP signatures exactly as OCI requires; `oracleAdapter: ComputeProviderAdapter`.

- [ ] **Step 1: Signer failing tests**: generate an RSA keypair in-test (`crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })`); assert (a) `authorization` header matches `/^Signature version="1",keyId=".+",algorithm="rsa-sha256",headers="\(request-target\) date host( x-content-sha256 content-type content-length)?",signature=".+"$/`, (b) the signature **verifies** with `crypto.createVerify('RSA-SHA256')` over the reconstructed signing string, (c) GET omits body headers, POST includes correct `x-content-sha256` = base64(sha256(body)).

- [ ] **Step 2: Implement the signer**:

```ts
// functions/shared/services/compute-providers/oci-signer.ts
import { createSign, createHash } from 'crypto';

export function signOciRequest(opts: {
  keyId: string; // tenancyOcid/userOcid/fingerprint
  privateKeyPem: string;
  method: string;
  url: string;
  body?: unknown;
}): Record<string, string> {
  const u = new URL(opts.url);
  const date = new Date().toUTCString();
  const names = ['(request-target)', 'date', 'host'];
  const lines = [
    `(request-target): ${opts.method.toLowerCase()} ${u.pathname}${u.search}`,
    `date: ${date}`,
    `host: ${u.host}`,
  ];
  const headers: Record<string, string> = { date, host: u.host };
  if (opts.body !== undefined) {
    const bodyStr = JSON.stringify(opts.body);
    const sha = createHash('sha256').update(bodyStr).digest('base64');
    headers['x-content-sha256'] = sha;
    headers['content-type'] = 'application/json';
    headers['content-length'] = String(Buffer.byteLength(bodyStr));
    names.push('x-content-sha256', 'content-type', 'content-length');
    lines.push(
      `x-content-sha256: ${sha}`,
      `content-type: application/json`,
      `content-length: ${headers['content-length']}`,
    );
  }
  const signature = createSign('RSA-SHA256')
    .update(lines.join('\n'))
    .sign(opts.privateKeyPem, 'base64');
  headers['authorization'] =
    `Signature version="1",keyId="${opts.keyId}",algorithm="rsa-sha256",headers="${names.join(' ')}",signature="${signature}"`;
  return headers;
}
```

- [ ] **Step 3: Oracle adapter failing tests** (stub fetch): `provision` POSTs `https://iaas.<region>.oraclecloud.com/20160918/instances/` with body `{ availabilityDomain, compartmentId, shape: 'VM.Standard.A1.Flex', shapeConfig: { ocpus: 2, memoryInGBs: 12 }, displayName: spec.name, sourceDetails: { sourceType: 'image', imageId }, metadata: { user_data: base64(spec.userData) } }`; **AD retry**: first AD responds 500 `Out of host capacity` → adapter retries the next AD in `availabilityDomains` and succeeds; all ADs exhausted → throws `'oracle: out of ARM capacity in all availability domains'`. `status` GETs `/instances/<id>` and maps `RUNNING→running`, `PROVISIONING/STARTING→creating`, `TERMINATED/TERMINATING→terminated`; ip comes from `GET /vnicAttachments?instanceId=` + `GET /vnics/<vnicId>` (mock both; acceptable v1: return `ip: undefined` until VNIC ready). `destroy` DELETEs `/instances/<id>?preserveBootVolume=false`, 404 = success.
- [ ] **Step 4: Implement + PASS + lint + typecheck.**
- [ ] **Step 5: Commit** — `feat(servers): oracle adapter with OCI request signing + AD capacity retry`.

---

### Task 14: GCP adapter

**Files:**

- Create: `functions/shared/services/compute-providers/gcp-auth.ts`
- Create: `functions/shared/services/compute-providers/gcp.ts`
- Test: `functions/shared/services/compute-providers/__tests__/gcp.test.ts`

**Interfaces:**

- Produces: `gcpAccessToken(saJson: string): Promise<string>` (RS256 self-signed JWT → `https://oauth2.googleapis.com/token` exchange, scope `https://www.googleapis.com/auth/compute`, 5-min in-memory cache); `gcpAdapter: ComputeProviderAdapter` **with `stop`/`start` implemented** (the only adapter that has them — GCP stop pauses billing).

- [ ] **Step 1: Failing tests** (stub fetch; sign JWT with an in-test RSA key): `provision` POSTs `https://compute.googleapis.com/compute/v1/projects/<p>/zones/<zone>/instances` with `{ name, machineType: 'zones/<zone>/machineTypes/<size>', disks: [{ boot: true, autoDelete: true, initializeParams: { sourceImage: 'projects/ubuntu-os-cloud/global/images/family/ubuntu-2404-lts-amd64' } }], networkInterfaces: [{ network: 'global/networks/default', accessConfigs: [{}] }], metadata: { items: [{ key: 'startup-script', value: spec.userData }] } }` and returns `{ instanceId: spec.name, zone }`; `status` maps `RUNNING→running`, `PROVISIONING/STAGING→creating`, `TERMINATED/STOPPING→stopped` and pulls `natIP`; `stop`/`start` POST the respective endpoints; `destroy` DELETEs the instance (404 = success). JWT assertion body asserts `iss`/`scope`/`aud` claims.
- [ ] **Step 2–4: Implement, PASS, lint, typecheck.**
- [ ] **Step 5: Commit** — `feat(servers): gcp adapter (vm + stop/start billing pause)`.

Also create `functions/shared/services/compute-providers/index.ts`:

```ts
import type { ComputeProviderAdapter } from './types';
import { hetznerAdapter } from './hetzner';
import { oracleAdapter } from './oracle';
import { gcpAdapter } from './gcp';

export function getAdapter(provider: string): ComputeProviderAdapter {
  const map: Record<string, ComputeProviderAdapter> = {
    hetzner: hetznerAdapter,
    oracle: oracleAdapter,
    gcp: gcpAdapter,
  };
  const a = map[provider];
  if (!a) throw new Error(`no compute adapter for provider: ${provider}`);
  return a;
}
```

---

### Task 15: Servers CRUD + provisioning flow routes

**Files:**

- Create: `functions/shared/services/server-provisioning.ts`
- Modify: `functions/api/index.ts` (routes), `functions/cron/server-dispatch-sweeper.ts` (status refresh + ACTIVE flip)
- Test: `functions/shared/services/__tests__/server-provisioning.test.ts`

**Interfaces:**

- Consumes: everything from Tasks 3, 8–14.
- Produces:
  - `provisionServer(input: z.infer<typeof createServerSchema>): Promise<ComputeServer>` — generates `serverId` (`srv_<provider>_<6-char nanoid>`) + enrollment token (32-byte hex; store only `hashEnrollToken(token)`); `local-machine` path: no cloud call, returns the row (status `BOOTSTRAPPING`) plus a one-liner install command containing the token; cloud path: `createServerIamUser` → `buildBootstrapScript` → `getAdapter(provider).provision` → row `PROVISIONING` with `providerRef`. On adapter throw: row saved as `ERROR` with `statusMessage`, IAM user cleaned up.
  - `destroyServer(serverId): Promise<void>` — status `DEPROVISIONING` → `adapter.destroy` → `deleteServerIamUser` → status `DELETED` + `enrollTokenHash = 'REVOKED'`.
  - `retryServer(serverId)` — re-runs provisioning for `ERROR` rows (fresh token + IAM keys).
  - `refreshProvisioningServers(): Promise<void>` — for rows in `PROVISIONING`: `adapter.status`; `running` → `BOOTSTRAPPING` (+ip). For rows in `BOOTSTRAPPING`: if `lastHeartbeatAt` exists → `ACTIVE` (spec §4.2 — the first heartbeat closes the loop). Called from the sweeper cron.
  - Routes: `GET /api/servers` (list, no `enrollTokenHash` in response), `POST /api/servers` (202 + row + `installCommand` for local), `PUT /api/servers/:id` (`updateServerSchema`), `POST /api/servers/:id/destroy`, `POST /api/servers/:id/retry`, `POST /api/servers/:id/stop`, `POST /api/servers/:id/start` (404-style error if adapter lacks the capability).

- [ ] **Step 1: Write failing tests** for `provisionServer` (happy cloud path order-of-operations; adapter failure → ERROR row + IAM cleanup; local path returns install command), `destroyServer` (revocation trio), `refreshProvisioningServers` (PROVISIONING+running→BOOTSTRAPPING; BOOTSTRAPPING+heartbeat→ACTIVE). Mock all collaborators with `vi.mock`.
- [ ] **Step 2: Run to verify failure.** **Step 3: Implement service + routes + sweeper wiring** (`runDispatchSweep` and `refreshProvisioningServers` both called from the cron handler; failures of one don't block the other).
- [ ] **Step 4: PASS + full `npm run ci`.**
- [ ] **Step 5: Commit** — `feat(servers): provisioning lifecycle + CRUD routes`.

---

### Task 16: Seed script for existing servers

**Files:**

- Create: `scripts/seed-servers.mjs`

**Interfaces:**

- Consumes: `SERVERS_TABLE` name; AWS credentials from the operator's shell.
- Produces: idempotent seeding of `srv_ec2_main` (provider `aws`, serviceType `vm`, region eu-central-1, `maxConcurrent` 2, `costPerHour` per current instance type, status `ACTIVE`, enabled true) and `srv_local_mac` (provider `local`, serviceType `local-machine`, status `ACTIVE`, enabled true, `costPerHour` 0). `enrollTokenHash: 'SEEDED'` (these two fetch creds the legacy way).

- [ ] **Step 1: Write the script** — plain AWS SDK v3 `PutCommand` with `ConditionExpression: 'attribute_not_exists(serverId)'`, catching `ConditionalCheckFailedException` with a "already seeded" log. Read table name from `process.env.SERVERS_TABLE || 'futurator-admin-production-...'` — print and confirm with `--yes` flag before writing.
- [ ] **Step 2: Run it**: `SERVERS_TABLE=$(aws dynamodb list-tables --query "TableNames[?contains(@,'Servers')]|[0]" --output text) node scripts/seed-servers.mjs --yes`
      Expected: `seeded srv_ec2_main`, `seeded srv_local_mac`; second run prints `already seeded`.
- [ ] **Step 3: Commit** — `feat(servers): seed script for ec2/local server rows`.

---

## Phase C — Daemon (tasks 17–19)

> Daemon files are `.mjs`, tests run with `node --test`. Work in `daemon/`; `cd daemon && npm install` if deps changed. Deploy of daemon code = the existing S3 sync path — after Phase C, upload the updated bundle so new fleet servers pull correct code.

### Task 17: Generalize atomic claim to agent jobs

**Files:**

- Modify: `daemon/lib/atomic-claim.mjs`
- Test: `daemon/lib/__tests__/atomic-claim-jobs.test.mjs`

**Interfaces:**

- Consumes: existing story-claim helpers in the same file (mirror their param-builder style).
- Produces (param builders — pure, testable without DDB):
  - `buildJobClaimParams({ tableName, jobId, serverId, nowIso, leaseMs })` → UpdateCommand input: Key `{ jobId }`, `ConditionExpression: '#status = :pending AND assignedServerId = :sid AND (attribute_not_exists(claimExpiresAt) OR claimExpiresAt < :now)'`, `UpdateExpression: 'SET #status = :running, claimOwner = :sid, claimToken = :tok, claimExpiresAt = :exp, startedAt = :now'` (claimToken = crypto random UUID, returned alongside).
  - `buildJobRenewParams({ tableName, jobId, serverId, claimToken, nowIso, leaseMs })` → condition `claimOwner = :sid AND claimToken = :tok`, SET new `claimExpiresAt`.
  - `buildJobReleaseParams({ tableName, jobId, serverId, claimToken, status })` → condition on owner+token, SET final status, REMOVE claim fields.

- [ ] **Step 1: Write failing tests** (`node --test daemon/lib/__tests__/atomic-claim-jobs.test.mjs`) asserting the exact expressions above and 15-min default lease.
- [ ] **Step 2–4: Implement, PASS.**
- [ ] **Step 5: Commit** — `feat(daemon): CAS claim param builders for agent jobs`.

---

### Task 18: Server-aware daemon — identity, assigned-poll, heartbeat

**Files:**

- Create: `daemon/lib/server-identity.mjs`
- Modify: `daemon/agent-daemon.mjs` (poll loop ~line 10220, heartbeat ~line 1640, claim in `runJobAsync`)
- Test: `daemon/lib/__tests__/server-identity.test.mjs`

**Interfaces:**

- Produces: `resolveServerId(env)`: returns `env.SERVER_ID` if set, else maps `DAEMON_SOURCE` `'ec2'→'srv_ec2_main'`, `'local'→'srv_local_mac'`, else `'srv_local_mac'`. Exported constant used everywhere below.
- Consumes: Task 17 param builders; agent-flags key `dispatch.serverAware` (daemon already re-reads flags each tick — extend that read).

- [ ] **Step 1: Failing tests** for `resolveServerId` (3 cases).
- [ ] **Step 2: Implement `server-identity.mjs`**, PASS.
- [ ] **Step 3: Wire the daemon (flag-gated, surgical):**

In the poll loop (~10220): when the `dispatch.serverAware` flag (read alongside `effectiveMaxConcurrent`) is **true**, replace the PENDING query with a Query on `assignedServerId-status-index` (`KeyConditionExpression: 'assignedServerId = :sid AND #status = :pending'`), keep the `retryAfter` filter; and in `runJobAsync`, replace the unconditional RUNNING write with `buildJobClaimParams` — on `ConditionalCheckFailedException`, log and skip the job (someone else claimed). Start a renew interval (`leaseMs/3`) using `buildJobRenewParams`; clear it in the job's finally-block with `buildJobReleaseParams`. When the flag is **false**: existing code path untouched (both query and claim).

In the heartbeat writer (~1640): in addition to the legacy `DAEMON_HEARTBEAT` row, `UpdateCommand` on `futurator-servers` (`SERVERS_TABLE` env, fallback `'futurator-servers'`): `SET lastHeartbeatAt = :now, activeCount = :n, daemonVersion = :v, system = :sys, updatedAt = :now` with `ConditionExpression: 'attribute_exists(serverId)'` (a deleted server's daemon must not resurrect its row; swallow the conditional failure and log once).

- [ ] **Step 4: Verify**: `node --test daemon/lib/__tests__/` PASS; run the daemon locally with the flag off and confirm identical behavior on a test queue job (`POST /api/queue/test` with `target: 'local'`).
- [ ] **Step 5: Commit** — `feat(daemon): server-aware poll/claim/heartbeat behind dispatch.serverAware`.

---

### Task 19: Daemon credentials fetch

**Files:**

- Create: `daemon/lib/creds-fetch.mjs`
- Modify: `daemon/agent-daemon.mjs` (boot + auth-probe hook)
- Test: `daemon/lib/__tests__/creds-fetch.test.mjs`

**Interfaces:**

- Produces: `fetchAgentCredentials({ adminApiUrl, enrollToken, credsPath }): Promise<boolean>` — GET `<adminApiUrl>/api/servers/agent-credentials` with `x-server-token`; on 200 writes the body to `credsPath` (mode 0o600) and returns true; on 401/503 logs and returns false (never throws — auth loss must not crash the daemon).
- Consumes: env `ADMIN_API_URL`, `ENROLL_TOKEN`, `CLAUDE_CREDENTIALS_PATH` (already read at `agent-daemon.mjs:309`).

- [ ] **Step 1: Failing tests** (stub fetch + tmp dir): success writes file with 0600; 401 returns false, file untouched.
- [ ] **Step 2: Implement**, PASS.
- [ ] **Step 3: Wire**: call on daemon boot (before first poll) and inside the existing hourly auth re-probe when the probe fails — only when `ENROLL_TOKEN` is set (EC2/local seeded daemons keep the legacy SSM path).
- [ ] **Step 4: `node --test daemon/lib/__tests__/` PASS.**
- [ ] **Step 5: Commit + upload the daemon bundle to S3** (use the same S3 URI recorded in Task 2, mirroring what `POST /api/ec2/start-daemon` syncs): `feat(daemon): fleet credentials fetch via enrollment token`.

---

## Phase D — Frontend (tasks 20–24)

### Task 20: Types mirror + use-servers hook

**Files:**

- Create: `src/types/servers.ts` (mirror `ComputeServer`, `DispatchPolicy`, catalog entry types — frontend copies, same as `src/types/queue.ts` mirrors the backend)
- Create: `src/hooks/use-servers.ts`
- Test: `src/hooks/__tests__/use-servers.test.tsx` (mirror an existing hook test if present; otherwise cover the pure helpers)

**Interfaces:**

- Produces (all wrapping the `api` client — paths WITHOUT `/api` prefix):
  - `useServers()` — `useQuery(['servers'], () => api.get('/servers'), { refetchInterval: 5000 })`
  - `useProviderCatalog()` — `['servers','providers']`, `api.get('/servers/providers')`
  - `useDispatchPolicy()` / `useSaveDispatchPolicy()` — GET/PUT `/servers/policy`, invalidates `['servers']`
  - `useCreateServer()` — POST `/servers`; `useUpdateServer()` — PUT `/servers/:id`; `useServerAction()` — POST `/servers/:id/<destroy|retry|stop|start>`; all invalidate `['servers']`
  - `useAssignments()` — `['servers','assignments']`, GET `/servers/assignments`, refetch 5s
  - Pure helper `heartbeatState(lastHeartbeatAt: string | undefined, now: number): 'fresh' | 'stale' | 'dead'` (<60s fresh, <120s stale, else dead) — unit-tested.

- [ ] Steps: failing test for `heartbeatState` → implement types + hook → PASS → `npm run lint && npm run typecheck` → commit `feat(servers-ui): types + hooks`.

---

### Task 21: Sidebar entry + page + Fleet tab

**Files:**

- Modify: `src/components/layout/sidebar.tsx` (add `{ href: '/development/servers', label: 'Servers', icon: '🖥️' }` to the Development section `items` array ~line 37)
- Create: `src/app/development/servers/page.tsx`
- Create: `src/components/development/servers/servers-view.tsx` (tab container: Fleet / Add Service / Dispatch Policy — copy the tab pattern from `src/components/development/queues/queues-view.tsx`)
- Create: `src/components/development/servers/fleet-tab.tsx`, `src/components/development/servers/server-card.tsx`

**Interfaces:**

- Consumes: Task 20 hooks; shadcn/ui primitives from `src/components/ui`; semantic theme tokens (`success`, `warning`).
- Produces: `<ServersView />` (page shell), `<FleetTab />`, `<ServerCard server={ComputeServer} />`.

- [ ] **Step 1: Build the card** — shows: provider + name + region/size/arch; status badge (`ACTIVE`→success, `ERROR`→destructive, `PROVISIONING/BOOTSTRAPPING`→warning, else muted); heartbeat dot via `heartbeatState` (fresh=green, stale=amber, dead=red + "last seen Xs ago"); `activeCount`/`maxConcurrent`; `costPerHour`; `enabled` Switch → `useUpdateServer`; cap stepper (1–16) → `useUpdateServer`; actions menu: Stop/Start (render only for `provider === 'gcp'`), Retry (only `ERROR`), Destroy — Destroy opens a confirm dialog whose body includes: _"This deletes the VM at the provider (delete = billing stops), revokes its AWS keys and enrollment token. Jobs assigned to it will be re-dispatched."_ Local-machine cards show the install command with a copy button instead of provider actions.
- [ ] **Step 2: FleetTab** — grid of cards from `useServers()`, empty-state ("No servers — add one in Add Service"), plus a summary strip (total active, total capacity, fleet cost/hr = Σ enabled `costPerHour`).
- [ ] **Step 3: Verify in dev**: `npm run dev`, open `http://localhost:3000/development/servers/` — page renders, sidebar shows Servers, seeded `srv_ec2_main`/`srv_local_mac` cards appear.
- [ ] **Step 4: `npm run lint && npm run typecheck`**, commit `feat(servers-ui): sidebar, page, fleet tab`.

---

### Task 22: Add Service wizard

**Files:**

- Create: `src/components/development/servers/add-service-wizard.tsx`

**Interfaces:**

- Consumes: `useProviderCatalog`, `useCreateServer`, credentials POST via `api.post('/servers/providers/:provider/credentials', ...)`.
- Produces: `<AddServiceWizard onDone={() => void} />` — 4 steps held in local `useState`:
  1. **Provider** — cards from the catalog; each shows `configured ✓` or "credentials needed".
  2. **Service type** — from `catalog.serviceTypes`; entries with `available: false` render disabled with their `note` ("Cloud Run Jobs — coming in v2") — non-clickable per spec §8.
  3. **Credentials** — rendered only if `!configured`; per-provider fields (hetzner: token; oracle: the 8 fields from `providerCredentialsSchema`; gcp: SA JSON textarea + projectId + zone); submit → credentials POST → advance.
  4. **Shape & confirm** — region/size selects (defaults from catalog), arch, cap (default 2), cost/hr input, estimated monthly = `costPerHour * 24 * 30` displayed; Provision button → `useCreateServer` → `onDone()` switches to Fleet tab where the new card shows live PROVISIONING → BOOTSTRAPPING → ACTIVE progress (5s poll already does this). Local provider skips steps 3–4's cloud parts and ends showing the returned `installCommand`.

- [ ] Steps: build → manual dev-server walkthrough (mock or real) → lint/typecheck → commit `feat(servers-ui): add-service wizard with disabled serverless option`.

---

### Task 23: Dispatch Policy tab + assignments feed

**Files:**

- Create: `src/components/development/servers/policy-tab.tsx`
- Create: `src/components/development/servers/assignments-feed.tsx`

**Interfaces:**

- Consumes: `useDispatchPolicy`, `useSaveDispatchPolicy`, `useServers`, `useAssignments`.
- Produces: `<PolicyTab />`:
  - Mode selector (RadioGroup): Priority / Weighted split / Cheapest-first with one-line explanations.
  - Priority mode: ordered list of enabled servers with ↑/↓ buttons (persist as `priorityOrder`).
  - Weighted mode: a slider (0–100) per enabled server + live total; warn (not block) when Σ ≠ 100 (engine normalizes).
  - Cheapest mode: read-only preview sorted by `costPerHour`.
  - Save → `useSaveDispatchPolicy` (backend re-sweeps immediately).
  - `<AssignmentsFeed />` below: table of recent assignments — jobId (short), jobType, status, server name, `assignReason` verbatim, age. Rows whose `assignReason` contains `affinity owner unreachable` render with a warning row-style + a "plan paused — server down; recover the server or destroy it to re-dispatch non-affinity work" callout (spec §8: v1 shows guidance, no auto-migration).

- [ ] Steps: build → verify against live policy PUT in dev → lint/typecheck → commit `feat(servers-ui): dispatch policy tab + assignments feed`.

---

### Task 24: Playwright smoke

**Files:**

- Create: `tests/e2e/servers.spec.ts` (mirror location/style of existing Playwright specs — check `playwright.config.ts` `testDir` first)

- [ ] **Step 1: Write the smoke test** following the existing pattern (auth pre-seeded in sessionStorage, API mocked via `page.route()`): mock `GET */api/servers` (two servers: one ACTIVE hetzner, one ERROR oracle), `GET */api/servers/providers`, `GET */api/servers/policy`, `GET */api/servers/assignments`; assert: page `/development/servers/` renders both cards, status badges visible, tab switch to Dispatch Policy shows the mode selector, no orphaned-component console errors (the suite's existing convention).
- [ ] **Step 2: Run**: `npm run test:e2e -- servers` — PASS.
- [ ] **Step 3: Commit** — `test(servers-ui): playwright smoke`.

---

## Phase E — Rollout & live validation (task 25)

### Task 25: Full verification + staged live rollout

**Files:** none new (runbook).

- [ ] **Step 1: Full CI**: `npm run ci` — green (lint + format:check + knip + typecheck + test + build). Fix anything yours; prove pre-existing failures pre-existing.
- [ ] **Step 2: Deploy**: `sst deploy`. Then `node scripts/seed-servers.mjs --yes` (if not yet run) and upload the daemon bundle to S3 (Task 19 step 5) and restart the EC2 daemon if it's running (`POST /api/ec2/start-daemon`).
- [ ] **Step 3: Flag on, EC2/local only**: set `dispatch.serverAware = true` (via `PUT /api/servers/policy` UI save or flags endpoint). Fire `POST /api/queue/test` with `target: 'local'` → verify in Assignments feed: pinned to `srv_local_mac`, claimed via CAS, completes. Fire one without target → policy assigns. **Rollback check**: flip the flag off, fire another test job, verify legacy routing still works.
- [ ] **Step 4: Oracle first** ($0 crash-test dummy): configure Oracle credentials in the wizard, provision `VM.Standard.A1.Flex` (2 OCPU/12GB, Frankfurt). Watch PROVISIONING → BOOTSTRAPPING → ACTIVE. Then: queue test job with no pin → runs on Oracle (check `dispatcher.host` in the queue request result). Click **Re-auth** on the Mac → confirm the Oracle daemon refetches creds (heartbeat `auth` stays ok).
- [ ] **Step 5: Hetzner** (CAX11 ARM Falkenstein, ~€4/mo): same drill. Then set policy **weighted 50/50 oracle/hetzner**, fire 6 test jobs, verify the Assignments feed shows a 3/3 split.
- [ ] **Step 6: GCP** (e2-small europe-west3): same drill + verify Stop/Start buttons work and a stopped server drops out of dispatch (heartbeat dead).
- [ ] **Step 7: Affinity**: dispatch one pipeline plan (small) → verify all its jobs carry the same `assignedServerId` and `assignReason` shows `affinity plan:<id>`.
- [ ] **Step 8: Kill test**: stop one provider VM mid-queue-job → within ~2 sweeps the job's lease expires, it returns to PENDING and reassigns to another server (non-affinity). Confirm in the feed.
- [ ] **Step 9: Commit any runbook fixes; update memory** (Servers module status) and mark the EC2 24/7 instance for downgrade/stop now that the fleet carries the load.

---

## Self-review notes (already applied)

- Spec §5 heartbeat thresholds are constants in Task 1 (`HEARTBEAT_FRESH_MS` 60s eligibility, `HEARTBEAT_STALE_MS` 120s reassignment) — single source, used by Tasks 6, 18, 20.
- Spec §4.1 "Cloud Run disabled" lands in Task 8 (catalog `available:false`) + Task 22 (disabled wizard option).
- Spec §6 relay = Task 9; §4.3 IAM = Tasks 2+10; §5.1 affinity = Tasks 4+5+6; §5.2 daemon = Tasks 17–19; §9 rollout = Tasks 16+25.
- `hashEnrollToken` defined once (Task 9), consumed by Task 15. `resolveServerId` (Task 18) matches seed IDs (Task 16) and the pin mapping (Task 7): `srv_ec2_main` / `srv_local_mac`.
- GSI constraint: only ONE new GSI on `futurator-agent-jobs` in the whole plan (Task 2).
