export type ComputeProviderId = 'hetzner' | 'oracle' | 'gcp' | 'aws' | 'local';
export type ServerServiceType = 'vm' | 'serverless' | 'local-machine';

/**
 * ServerCapability — a BINARY host attribute the dispatcher's eligibility check
 * uses to decide whether a server may run a given job *at all*. It is a DIFFERENT
 * axis from CAPACITY (`maxConcurrent`), COST (`costPerHour`), LIVENESS (heartbeat
 * freshness) and READINESS (`auth.valid`) — those answer "is it free / cheap /
 * alive / logged-in right now?". Capabilities answer "CAN this box do this kind
 * of work?".
 *
 * These are DAEMON-SELF-REPORTED at heartbeat (the box knows if Chromium is
 * installed, if a GitHub PAT is set, if the graph-table env is wired), NOT
 * hand-declared — so a fleet of heterogeneous machines (Oracle/EC2/GCP/laptop)
 * auto-advertises what it can do. The operator MAY override on the server row.
 *
 * Canonical seed (extensible — the matcher treats capabilities as an opaque set,
 * so adding one needs no matcher change):
 *   • browser     — Chromium + Playwright present → run browser / visual-QA acceptance checks
 *   • docker      — Docker daemon available → containerized steps
 *   • graph       — graph-store env wired (GRAPH_*_TABLE) → build/query the knowledge graph
 *   • git-push    — GitHub push creds (PAT) → create repos + push (greenfield bootstrap, party publish)
 *   • interactive — suited to low-latency interactive sessions (free-agent, party turns)
 */
export type ServerCapability = 'browser' | 'docker' | 'graph' | 'git-push' | 'interactive';

export const ALL_SERVER_CAPABILITIES: ServerCapability[] = [
  'browser',
  'docker',
  'graph',
  'git-push',
  'interactive',
];
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
  /**
   * What this box CAN run (capability matrix). Daemon-self-reported at heartbeat
   * (Chromium present? PAT set? graph env wired?); operator may override. Undefined
   * = not yet reported → the eligibility matcher treats it PERMISSIVELY (can run
   * anything) so existing/legacy servers are never silently starved during rollout.
   */
  capabilities?: ServerCapability[];
  providerRef: { instanceId?: string; ip?: string; zone?: string; availabilityDomain?: string };
  enrollTokenHash: string;
  iamUserName?: string;
  lastHeartbeatAt?: string;
  activeCount?: number;
  daemonVersion?: string;
  system?: { totalMem: number; freeMem: number; loadAvg: number[] };
  /** Reported by the daemon each heartbeat: can this box actually run Claude?
   *  Liveness (heartbeat) and readiness (auth) are different questions. */
  auth?: {
    valid: boolean;
    error?: string | null;
    checkedAt?: number | null;
    subscriptionType?: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export type DispatchMode = 'priority' | 'weighted' | 'cheapest';

/**
 * JobPriorityTier — one band in the JOB-priority ranking. This is a DIFFERENT
 * axis from `DispatchMode`/`priorityOrder`/`weights` (which answer "WHICH HOST
 * takes the next job") and from `ServerCapability` (which answers "CAN this host
 * run it"). Job-priority answers "WHICH JOB goes first" when a host has a free
 * slot and several eligible jobs are waiting.
 *
 * Tiers are an ORDERED list, highest-priority first. A job's tier is the first
 * tier whose `jobTypes` contains its `jobType`; an unrecognised jobType falls to
 * the LAST tier (the operator's "everything else" band). Within a tier, ties
 * break by `createdAt` (FIFO). See `services/job-priority.ts` `selectNext`.
 */
export interface JobPriorityTier {
  /** Stable id (used for React keys, reorder, and as the band's group name). */
  id: string;
  /** Operator-facing label. */
  label: string;
  /** jobTypes that fall in this band. The last tier also absorbs unknown types. */
  jobTypes: string[];
}

/**
 * Operator's proposed default ranking, highest-priority first. Mirrors the
 * spirit of the daemon ConcurrencyManager's binary interactive-vs-batch class,
 * generalised to configurable bands. App-agnostic — jobTypes only, no content.
 */
export const DEFAULT_JOB_PRIORITY_TIERS: JobPriorityTier[] = [
  {
    id: 'interactive',
    label: 'Interactive',
    jobTypes: ['free-agent-session', 'party-turn', 'party-bootstrap'],
  },
  { id: 'critical-path', label: 'Critical path', jobTypes: ['integrator', 'wave-merge'] },
  { id: 'dev', label: 'Development', jobTypes: ['story-dev', 'quick-planspec', 'epic-dev'] },
  {
    id: 'assess',
    label: 'Assessment',
    jobTypes: ['scan-engine', 'refactor-audit', 'scorecard-assess'],
  },
  { id: 'bench', label: 'Bench / misc', jobTypes: ['dual-agent-compare', 'ultracode-bench'] },
];

export interface DispatchPolicy {
  mode: DispatchMode;
  priorityOrder: string[];
  weights: Record<string, number>;
  /**
   * Optional JOB-priority ranking layered on top of host selection. Undefined =
   * use `DEFAULT_JOB_PRIORITY_TIERS`. Persisted through the same policy row.
   */
  jobPriority?: JobPriorityTier[];
  updatedAt: string;
}

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
  mode: 'priority',
  priorityOrder: [],
  weights: {},
  jobPriority: DEFAULT_JOB_PRIORITY_TIERS,
  updatedAt: new Date(0).toISOString(),
};

// Heartbeat freshness for dispatch eligibility (spec §5 step 2)
export const HEARTBEAT_FRESH_MS = 60_000;
// Staleness threshold for reassignment by the sweeper (spec §11)
export const HEARTBEAT_STALE_MS = 120_000;
