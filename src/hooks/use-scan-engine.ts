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
  /** 'internal' (our own scanner, default) | 'external' (GDPR service). */
  privacyMode?: 'internal' | 'external';
  /** 'full' (default, recon + swarm) | 'deterministic' (no swarm; ~0 LLM tokens). */
  mode?: 'full' | 'deterministic';
  /** Granular re-scan: re-run ONLY these swarm tasks (subsystem shardKeys and/or
   *  cross-cutting pass areas) and merge into the persisted scan — a few agents
   *  instead of ~48. */
  targets?: string[];
  /** Reuse cached recon (skip graphify/decompose/deps). Default true when targeted. */
  reuseRecon?: boolean;
  /** Auto-target the subsystems whose files changed since the last-scanned SHA. */
  autoTargetChanged?: boolean;
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
  /** The swarm task that produced this finding — a subsystem shardKey, a
   *  cross-cutting pass area, or 'deterministic'. The merge key for granular
   *  re-scans (group findings by it to offer per-task re-runs). */
  producedBy?: string;
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

export interface MaturityAxis {
  key: string;
  label: string;
  score: number | null;
  status: 'good' | 'fair' | 'poor' | 'unmeasured';
  detail: string;
  measured: boolean;
}
export interface Maturity {
  axes: MaturityAxis[];
  overall: number | null;
}

/** Potential-cost model (cost SURFACE, not dollars — live rates are not probed). */
export type CostModel =
  | 'standing'
  | 'metered'
  | 'subscription'
  | 'connectivity'
  | 'none'
  | 'unknown';
export interface InfraService {
  name: string;
  kind: string;
  cloud: string;
  residency: string | null;
  dataStore: boolean;
  /** how it was found: iac-declared | iac-import | platform-config | env-key | sdk-import. */
  detectedBy: string[];
  confidence: 'high' | 'medium' | 'low';
  declares: string[];
  fileCount: number;
  files: string[];
  /** billing model of this cost surface (see CostModel). */
  costModel?: CostModel;
}
export interface CostSurface {
  standing: number;
  metered: number;
  subscription: number;
  connectivity: number;
}
export interface IacCoverage {
  /** own-cloud resources that should be declared in code. */
  provisionable: number;
  /** ...of which are actually declared (IaC/CDK/SST/platform-config). */
  declared: number;
  /** declared / provisionable (null when nothing is provisionable). */
  ratio: number | null;
  /** names of own-cloud resources used in code but declared nowhere (click-ops smell). */
  undeclared: string[];
}
export interface InfraInventory {
  services: InfraService[];
  iac: {
    provider: string;
    file: string;
    tier?:
      | 'resource'
      | 'migrations'
      | 'orchestration'
      | 'config-mgmt'
      | 'container'
      | 'platform'
      | 'ci'
      | 'other';
  }[];
  external: { provider: string; kind: string; fileCount: number; detectedBy?: string[] }[];
  clouds: string[];
  boundaries: { clientFiles: number; serverFiles: number; externalTouchingFiles: number };
  signalQuality: {
    level: 'high' | 'medium' | 'low';
    iacDeclared: boolean;
    iacFiles: number;
    hasEnvExample: boolean;
    detail: string;
  };
  costSurface?: CostSurface;
  iacCoverage?: IacCoverage;
  summary: {
    serviceCount: number;
    dataStoreCount: number;
    aiCount: number;
    externalProcessorCount: number;
    clouds: string[];
    iacProviders: string[];
    resourceIacFiles?: number;
    iacByTier?: Record<string, string[]>;
    costSurface?: CostSurface;
    iacCoverage?: IacCoverage;
  };
}

export interface ScanReport {
  findings: ScanFinding[];
  phases: ScanPhase[];
  /** The generated planOutput (epics/stories) — present in scan.json. */
  planOutput?: unknown;
  /** Codebase maturity scorecard (the high-level RAG overview). */
  maturity?: Maturity;
  /** Infrastructure inventory (AWS/db/AI/3rd-party + IaC) — feeds compliance. */
  infra?: InfraInventory;
  gateViolations: Array<{ epicId: string; storyId: string; reason: string }>;
  counts: {
    total: number;
    deterministic: number;
    llm: number;
    byDimension: Record<string, number>;
  };
  lowConfidence: boolean;
  reportMarkdown?: string;
  /** Provenance for granular re-scans (set by the daemon on upload). */
  scannedSha?: string | null;
  scannedAt?: string;
  mode?: 'full' | 'deterministic' | 'targeted';
}

export function useRunScanEngine(appId: string | null) {
  return useMutation({
    mutationFn: (input: RunScanEngineInput = {}) =>
      api.post<{ jobId: string; projectId: string }>(`/party/projects/${appId}/scan-engine`, input),
  });
}

/**
 * Cancel a running (or pending) scan. The daemon SIGKILLs the scan's child
 * processes (npm/graphify/knip/eslint/swarm) and flips the job terminal.
 */
export function useCancelScan(appId: string | null) {
  return useMutation({
    mutationFn: (jobId: string) =>
      api.post<{ ok: boolean; jobId: string; status: string }>(
        `/party/projects/${appId}/scan-engine/${jobId}/cancel`,
        {},
      ),
  });
}

/**
 * Fetch the full scan report from S3 (uploaded by the daemon, keyed by appId).
 * Enabled whenever appId is set — so a PRIOR scan PERSISTS across reloads /
 * fresh sessions WITHOUT needing the producing job in the URL (scans are
 * expensive; the S3 object is the durable store). Returns null if none yet.
 */
export function useScanReport(appId: string | null) {
  return useQuery({
    queryKey: ['scan-report', appId],
    queryFn: async (): Promise<ScanReport | null> => {
      const res = await fetch(
        `${S3_BASE}/${encodeURIComponent(appId!)}/_refactor/scan.json?t=${Date.now()}`,
      );
      if (!res.ok) return null;
      return (await res.json()) as ScanReport;
    },
    enabled: !!appId,
    staleTime: 60_000,
    retry: false,
  });
}
