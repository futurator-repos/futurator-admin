'use client';

/**
 * use-skill-proposals.ts — Skills Institution, Story 3.3/3.4.
 *
 * TanStack Query hooks for the curation Inbox. Paths are relative to the
 * api-client base (which already ends in `/api`), so no `/api` prefix here.
 */

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  ProvenanceClass,
  SecurityStatus,
  TrustTier,
  QualityGrade,
} from '@/hooks/use-skill-catalog';

// Re-export the facet unions so inbox components import them from one place.
export type { ProvenanceClass, SecurityStatus, TrustTier, QualityGrade };

export type ProposalStatus = 'pending' | 'quarantined' | 'ratified' | 'rejected' | 'deferred';
export type ProposalSource = 'reflect-graduate' | 'create' | 'paste-url' | 'bulk';

export interface PatternHit {
  id: string;
  category: string;
  severity: 'blocking' | 'advisory';
  description: string;
  evidence: string;
  location: string;
}

export interface SkillProposal {
  proposalId: string;
  source: ProposalSource;
  skillName: string;
  kind: string;
  proposedBody: string;
  proposedEntry: {
    name: string;
    description: string;
    provenanceClass?: ProvenanceClass;
    securityStatus?: SecurityStatus;
    qualityGrade?: QualityGrade;
    trustTier?: TrustTier;
  };
  gist: string;
  securityStatus: SecurityStatus;
  scanReport?: { securityStatus: SecurityStatus; patternsHit: PatternHit[] };
  qualityGrade: QualityGrade;
  status: ProposalStatus;
  createdAt: string;
  ratifiedBy?: string;
  ratifiedAt?: string;
}

export interface DiffLine {
  type: 'ctx' | 'add' | 'del';
  text: string;
}

export interface ProposalDetail {
  proposal: SkillProposal;
  currentBody: string;
  diff: { lines: DiffLine[]; added: number; removed: number };
}

export function useSkillProposals(status?: ProposalStatus) {
  const qs = status ? `?status=${status}` : '';
  return useQuery({
    queryKey: ['skill-proposals', status ?? 'all'],
    queryFn: () => api.get<{ proposals: SkillProposal[]; total: number }>(`/skill-proposals${qs}`),
    refetchInterval: 30_000,
  });
}

export function useSkillProposalDetail(id: string | null) {
  return useQuery({
    queryKey: ['skill-proposal', id],
    queryFn: () => api.get<ProposalDetail>(`/skill-proposals/${encodeURIComponent(id!)}`),
    enabled: !!id,
  });
}

type Decision = 'ratify' | 'reject' | 'defer';

export function useProposalDecision() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; decision: Decision; override?: boolean; reason?: string }) =>
      api.post<{ proposal: SkillProposal }>(
        `/skill-proposals/${encodeURIComponent(args.id)}/${args.decision}`,
        { override: args.override, reason: args.reason },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['skill-proposals'] });
      qc.invalidateQueries({ queryKey: ['skills', 'catalog'] });
    },
  });
}

export interface GateSubmit {
  mode: 'create' | 'paste-url';
  name: string;
  description: string;
  body?: string;
  sourceUrl?: string;
  kind?: string;
  license?: string;
}

export function useSubmitToGate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GateSubmit) => api.post<{ proposal: SkillProposal }>('/skills/gate', input),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['skill-proposals'] }),
  });
}
