'use client';

/**
 * Refactoring Scan Engine v2 hooks.
 *
 *   useRunScanEngine(appId) — POST /party/projects/:id/scan-engine → { jobId }.
 *   useScanReport(appId)    — fetch the full scan.json the daemon uploads to S3.
 *
 * Poll the returned jobId with useAgentJob; the headline rides scanEngineSummary
 * on the job row, the full finding pool + phases ride S3 (like the code graph).
 *
 * NOTE: api-client base already ends in `/api` — do NOT prefix paths with `/api`.
 */

import { useMutation, useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

const S3_BASE = 'https://futurator-ai-website.s3.us-east-1.amazonaws.com/knowledge-live';

export interface RunScanEngineInput {
  src?: string;
  cap?: number;
}

export type ScanDimension =
  | 'architecture'
  | 'safety-security'
  | 'compliance'
  | 'code-quality-refactoring'
  | 'correctness';

export interface ScanFinding {
  id: string;
  dimension: ScanDimension;
  area: string;
  severity: 'High' | 'Medium' | 'Low–Med' | 'Low';
  effort: 'Trivial' | 'Small' | 'Medium' | 'Large';
  location: string;
  issue: string;
  suggestion: string;
  evidence?: Record<string, unknown>;
  source: 'deterministic' | 'llm';
  dependsOn?: string[];
  overlaps?: string[];
}

export interface ScanPhase {
  phase: number;
  name: string;
  why: string;
  tag: string;
  items: string[];
}

export interface ScanReport {
  findings: ScanFinding[];
  phases: ScanPhase[];
  gateViolations: Array<{ epicId: string; storyId: string; reason: string }>;
  counts: {
    total: number;
    deterministic: number;
    llm: number;
    byDimension: Record<string, number>;
  };
  lowConfidence: boolean;
  reportMarkdown?: string;
}

export function useRunScanEngine(appId: string | null) {
  return useMutation({
    mutationFn: (input: RunScanEngineInput = {}) =>
      api.post<{ jobId: string; projectId: string }>(`/party/projects/${appId}/scan-engine`, input),
  });
}

/** Fetch the full scan report from S3 (uploaded by the daemon). Gated by `enabled`. */
export function useScanReport(appId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ['scan-report', appId],
    queryFn: async (): Promise<ScanReport | null> => {
      const res = await fetch(
        `${S3_BASE}/${encodeURIComponent(appId!)}/_refactor/scan.json?t=${Date.now()}`,
      );
      if (!res.ok) return null;
      return (await res.json()) as ScanReport;
    },
    enabled: !!appId && enabled,
    staleTime: 60_000,
    retry: false,
  });
}
