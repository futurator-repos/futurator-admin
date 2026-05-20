'use client';

/**
 * Epic 7 (2026-05-20) — Skills digest hook.
 *
 * Fetches GET /api/apps/:appId/skills/digest. Returns the per-app
 * skill activity rollup: recent SKILL-SCOUT job history + aggregated
 * skill activation counts across recent plans.
 *
 * Conservative caching (5 min) — the digest is a summary; live activity
 * is on the plan dashboard itself.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface SkillScoutJobSummary {
  jobId: string;
  status: string;
  createdAt: string;
  trigger: string | null;
  rigor: string | null;
  planId: string | null;
  disposition: string | null;
  proposalCount: number;
  acceptedCount: number;
}

export interface SkillUsedAggregateEntry {
  skill: string;
  source: string;
  activationCount: number;
}

export interface SkillsDigest {
  appId: string;
  boilerplateType: string | null;
  bootstrappedAt: string | null;
  recentSkillScoutJobs: SkillScoutJobSummary[];
  skillsUsedAggregate: SkillUsedAggregateEntry[];
  plansAnalyzed: number;
}

export function useSkillsDigest(appId: string | undefined) {
  return useQuery({
    queryKey: ['skills-digest', appId],
    enabled: !!appId,
    queryFn: async (): Promise<SkillsDigest> => {
      return api.get<SkillsDigest>(`/apps/${encodeURIComponent(appId!)}/skills/digest`);
    },
    staleTime: 5 * 60 * 1000,
  });
}
