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
