/**
 * Servers module — frontend types (subset of
 * functions/shared/types/compute-server.ts +
 * functions/shared/services/compute-providers/catalog.ts).
 */

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

// The API strips `enrollTokenHash` before it ever reaches the frontend
// (functions/api/index.ts `sanitizeServer`) — it is not part of this type.
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

export interface ProviderServiceTypeCatalogEntry {
  type: ServerServiceType;
  label: string;
  available: boolean;
  note?: string;
}

// Same shape as the backend `ProviderCatalogEntry`, plus the live
// `configured` flag `GET /servers/providers` merges in from Secrets Manager.
export interface ProviderCatalogEntry {
  provider: ComputeProviderId;
  label: string;
  serviceTypes: ProviderServiceTypeCatalogEntry[];
  defaultRegions: string[];
  defaultSizes: string[];
  configured: boolean;
}

export interface ServerAssignment {
  jobId: string;
  jobType?: string;
  status: string;
  assignedServerId?: string;
  assignReason?: string;
  assignedAt?: string;
  createdAt: string;
}
