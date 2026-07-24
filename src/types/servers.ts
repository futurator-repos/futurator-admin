/**
 * Servers module — frontend types (subset of
 * functions/shared/types/compute-server.ts +
 * functions/shared/services/compute-providers/catalog.ts).
 */

export type ComputeProviderId = 'hetzner' | 'oracle' | 'gcp' | 'aws' | 'local';
export type ServerServiceType = 'vm' | 'serverless' | 'local-machine';

/**
 * ServerCapability — a binary host attribute the dispatcher uses to decide
 * whether a server may run a given job (a different axis from capacity/cost/
 * liveness/auth). Daemon-self-reported at heartbeat; operator may override.
 * Mirrors functions/shared/types/compute-server.ts.
 */
export type ServerCapability = 'browser' | 'docker' | 'graph' | 'git-push' | 'interactive';

export const ALL_SERVER_CAPABILITIES: ServerCapability[] = [
  'browser',
  'docker',
  'graph',
  'git-push',
  'interactive',
];

export const SERVER_CAPABILITY_LABELS: Record<ServerCapability, string> = {
  browser: 'Browser/VQA (Chromium)',
  docker: 'Docker',
  graph: 'Knowledge graph',
  'git-push': 'Git push (PAT)',
  interactive: 'Interactive sessions',
};
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
  /** Capability matrix — what this box can run. Daemon-reported; operator-overridable.
   *  Undefined = not yet reported (matcher treats permissively). */
  capabilities?: ServerCapability[];
  providerRef: { instanceId?: string; ip?: string; zone?: string; availabilityDomain?: string };
  iamUserName?: string;
  lastHeartbeatAt?: string;
  activeCount?: number;
  daemonVersion?: string;
  system?: { totalMem: number; freeMem: number; loadAvg: number[] };
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

export type CredentialFieldKind = 'text' | 'password' | 'textarea' | 'list';

export interface ProviderCredentialField {
  name: string;
  label: string;
  kind: CredentialFieldKind;
  placeholder?: string;
  help?: string;
}

export interface ProviderRegionOption {
  value: string;
  label: string;
}

export interface ProviderSizeOption {
  value: string;
  label: string;
  arch: 'arm64' | 'x86_64';
  vcpu: number;
  memGB: number;
  costPerHour: number;
  note?: string;
}

// Same shape as the backend `ProviderCatalogEntry`, plus the live `configured`
// flag and `placement` echo that `GET /servers/providers` merges in.
export interface ProviderCatalogEntry {
  provider: ComputeProviderId;
  label: string;
  summary: string;
  creatable: boolean;
  unavailableNote?: string;
  requiresCredentials: boolean;
  credentialFields: ProviderCredentialField[];
  credentialsHelpUrl?: string;
  serviceTypes: ProviderServiceTypeCatalogEntry[];
  regionSource: 'server' | 'credentials' | 'none';
  regions: ProviderRegionOption[];
  sizes: ProviderSizeOption[];
  defaultMaxConcurrent: number;
  configured: boolean;
  /** Oracle/GCP only: where the stored credentials place every VM. */
  placement: { region?: string; zone?: string } | null;
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
