'use client';

/**
 * Skills Management Phase 1, Story 1.3 (2026-06-15).
 *
 * Fetches GET /api/skills/catalog — the flattened federation catalog for the
 * Skills Registry UI. The catalog is a cross-source list of every skill the
 * pipeline knows about; the API caches it 5 min server-side, so a 5-min client
 * staleTime here is conservative-but-fine.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface CatalogSkill {
  name: string;
  kind: string;
  framework: boolean;
  version: string;
  license: string;
  description: string;
  source: string;
  autoTrust: boolean;
}

export interface SkillCatalogResponse {
  skills: CatalogSkill[];
  sources: Array<{ id: string; url: string; ok: boolean; skillCount: number; error?: string }>;
  fetchedAt: string;
  cached: boolean;
}

export function useSkillCatalog() {
  return useQuery({
    queryKey: ['skills', 'catalog'],
    queryFn: () => api.get<SkillCatalogResponse>('/skills/catalog'),
    staleTime: 5 * 60 * 1000,
  });
}
