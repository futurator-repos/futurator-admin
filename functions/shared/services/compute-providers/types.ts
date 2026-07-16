/**
 * Shared adapter contract for compute provider integrations (Hetzner, Oracle,
 * GCP, ...). Each provider module implements `ComputeProviderAdapter` against
 * plain `fetch` (no provider SDKs) so cold-start and bundle size stay small.
 */
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
