'use client';

/**
 * Skills Management Phase 1, Story 1.3 (2026-06-15).
 *
 * Fetches GET /api/skills/reconciliation?appId= — the on-disk ↔ federation
 * drift view for one app: which loaded skills the catalog knows (managed),
 * which it doesn't (unmanaged drift), and which catalog skills aren't loaded.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface SkillReconciliationResponse {
  appId: string;
  onDisk: { count: number; sourceJobId: string | null; captured: boolean };
  catalog: { count: number; fetchedAt: string };
  onDiskCount: number;
  catalogCount: number;
  managed: string[];
  unmanaged: string[];
  availableNotLoaded: string[];
  inSync: boolean;
}

export function useSkillReconciliation(appId: string | undefined) {
  return useQuery({
    queryKey: ['skills', 'reconciliation', appId],
    queryFn: () =>
      api.get<SkillReconciliationResponse>(
        `/skills/reconciliation?appId=${encodeURIComponent(appId as string)}`,
      ),
    enabled: !!appId,
    staleTime: 5 * 60 * 1000,
  });
}
