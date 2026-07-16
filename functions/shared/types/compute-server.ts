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
