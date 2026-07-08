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
  /** which module this quality axis rolls up under (infra|security|compliance|architecture|code-quality|testing|sdd). */
  module?: string;
}
/** Binary readiness check (present/absent) — separate from the quality RAG axes. */
export interface ReadinessItem {
  key: string;
  label: string;
  present: boolean;
  detail: string;
}
export interface Maturity {
  axes: MaturityAxis[];
  readiness?: ReadinessItem[];
  overall: number | null;
}

/** Deterministic stack/tech-profile of the scanned repo (scan.json key "stack"). */
export interface StackProfile {
  languages: { lang: string; files: number; pct: number }[];
  primaryLanguage: string | null;
  runtime: string | null;
  packageManager: string | null;
  frameworks: string[];
  ui: string[];
  databases: string[];
  buildTools: string[];
  monorepo: string | null;
  archetype: string;
  summary: string;
}

/** Potential-cost model (cost SURFACE, not dollars — live rates are not probed). */
export type CostModel =
  | 'standing'
  | 'metered'
  | 'subscription'
  | 'connectivity'
  | 'none'
  | 'unknown';
/** One concrete resource enumerated under a data-store service (e.g. a specific
 *  DynamoDB table, S3 bucket, RDS instance) — the per-resource drill-down under
 *  the service-level InfraService entry. */
export interface InfraResource {
  name: string;
  kind: string;
  declared: boolean;
  existence: 'declared' | 'unknown';
  evidence?: string;
  contains_pii?: boolean;
  piiReason?: string;
  orphanCandidate?: boolean;
  /** 'declared' = read from IaC/config only; 'verified' = confirmed against live state. */
  basis?: 'declared' | 'verified';
}

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
  /** graph-informed: number of files whose imports resolve to this service. */
  fanIn?: number;
  /** graph-informed: usage concentrated in <=3 files or behind one dir. */
  centralized?: boolean;
  /** per-resource drill-down (data-store services only) — individual tables/buckets/instances. */
  resources?: InfraResource[];
  /** this service looks provisioned but unreferenced anywhere in code (candidate for cleanup). */
  orphanCandidate?: boolean;
  orphanReason?: string;
  /** 'declared' = read from IaC/config only; 'verified' = confirmed against live state. */
  basis?: 'declared' | 'verified';
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
  /** finer-grained resource-level counterpart to provisionable/declared (per-table/bucket, not per-service). */
  resourcesTotal?: number;
  resourcesDeclared?: number;
  /** resourcesDeclared / resourcesTotal (null/undefined when nothing to measure). */
  resourceRatio?: number | null;
  platformConfigDeclared?: number;
}
/** One IaC-maturity dimension grade (state/env/modularity/testing/governance/drift-cost).
 *  Per-dimension grades are independent and MAY be uneven — that's the point. */
export interface IacDimension {
  level: number;
  evidence: string;
  gaps: string[];
  /** 'declared' = graded from IaC/config text only (unverified); 'verified' = confirmed against live state. */
  basis?: 'declared' | 'verified';
}

/** One fact the static scan could not confirm — surfaced instead of silently
 *  assumed. Each item carries the exact command an operator can run to verify it. */
export interface VerificationBacklogItem {
  id: string;
  fact: string;
  dimension: string;
  verifyCommand: string;
  basis: 'unknown';
}

/** Readiness gate for one downstream module (FinOps / Privacy / Policy-as-code),
 *  computed from the infra scan. 'declared' basis = inferred from what's declared
 *  in code, not from live cloud state. */
export interface ModuleReadinessGate {
  ready: boolean;
  basis: 'declared';
  blockedBy: string[];
}
export interface ModuleReadiness {
  finops: ModuleReadinessGate;
  privacy: ModuleReadinessGate;
  policyAsCode: ModuleReadinessGate;
}
/** A deprecated/EOL IaC tool detected in the repo (cdktf, tfsec, DM, Terraformer output, …). */
export interface DeprecatedTool {
  tool: string;
  status: string;
  eolDate: string | null;
  remediation: string;
  severity: 'high' | 'medium' | 'low';
}
/** IaC maturity grade of the scanned repo (5-level model, 6 dimensions), produced
 *  deterministically inside infra-extract.mjs. Roll-up is min-gated: overall level =
 *  the LOWEST blocking dimension. */
export interface IacMaturity {
  level: number;
  levelName: 'ClickOps' | 'Repeatable' | 'Defined' | 'Managed' | 'Optimizing';
  dimensions: {
    state: IacDimension;
    envSeparation: IacDimension;
    modularity: IacDimension;
    testing: IacDimension;
    governance: IacDimension;
    driftCost: IacDimension;
  };
  deprecated: DeprecatedTool[];
  regions: string[];
  regionPinned: boolean;
  tagTaxonomy: {
    present: string[];
    missing: string[];
    coveragePct: number;
    /** tags the rubric actually requires for this stack (drives the "missing" chips). */
    requiredTags?: string[];
    /** tags the platform enforces implicitly (e.g. sst:app, sst:stage) — not hand-declared,
     *  shown separately from the required-tag coverage. */
    platformImplicit?: string[];
    /** human phrasing of the coverage finding, e.g. "0% in declared IaC …". Prefer over the raw pct when present. */
    detail?: string;
  };
  findings: ScanFinding[];
  /** facts the static scan could not confirm — each with the exact command to verify it. */
  verificationBacklog?: VerificationBacklogItem[];
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
  /** hand-rolled deploy scripts / inline IAM policies (non-IaC / click-ops signal). */
  deployScripts?: { file: string; kind: 'shell-deploy' | 'iam-policy'; provisions: string[] }[];
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
  /** IaC maturity grade (5-level model, 6 dimensions) — produced by infra-extract.mjs. */
  iacMaturity?: IacMaturity;
  /** downstream-module readiness gates (FinOps/Privacy/Policy-as-code), computed from this scan. */
  moduleReadiness?: ModuleReadiness;
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
    iacMaturity?: IacMaturity;
  };
}

/** One resource to import into IaC — seeded from iacCoverage.undeclared + deployScripts.
 *  priority = graph fanIn × git churn (stateful + high-fan-in + hot imports first). */
export interface IacImport {
  resource: string;
  source: string;
  priority: number;
}
/** One step in the stack-aware Infrastructure migration track (rubric gap → doc playbook). */
export interface IacPlanStep {
  phase: number;
  title: string;
  dimension: string;
  why: string;
  /** stack-aware tooling: pulumi|terraform|opentofu|cdk|sst|gcp-im. */
  tool: string;
  commands: string[];
  imports?: IacImport[];
  /** "plan/preview must show zero changes before commit" — the characterization-gate analogue. */
  goldenRule: string;
  /** downstream modules this step unlocks once complete (e.g. ['finops','privacy','policy-as-code']). */
  unlocks?: string[];
}
/** Stack-aware Infrastructure migration track, produced by iac-phase-planner.mjs.
 *  Gap-driven: only emits steps for MISSING dimensions. */
export interface IacPlan {
  currentLevel: number;
  targetLevel: number;
  levelName: string;
  /** "Level N -> N+1: next 3 actions". */
  nextThree: { title: string; dimension: string; action: string }[];
  track: IacPlanStep[];
}

/** One entry in the scan's execution ledger (C-LEDGER) — a recon step, an
 *  analyzer/pass agent, or the report writer. tokens/costUsd are null when the
 *  step spent no LLM (deterministic recon) or the cost is unknown. */
export interface ScanStep {
  step: string;
  label: string;
  kind: 'recon' | 'analyzer' | 'pass' | 'report' | 'other';
  durationMs: number;
  tokens: number | null;
  costUsd: number | null;
}

/** Rolled-up cost of a scan (C-LEDGER), aggregated from the timeline steps. */
export interface ScanCost {
  totalTokens: number;
  totalUsd: number;
  byKind: Record<string, { tokens: number; usd: number; ms: number }>;
}

/** AI-readiness profile of the scanned repo (C-AI), from ai-readiness.mjs. */
export interface AiReadiness {
  hasClaudeCode: boolean;
  skillCount: number;
  agentCount: number;
  commandCount: number;
  hasMcp: boolean;
  hasHooks: boolean;
  tools: { name: string; present: boolean; detail: string; files: string[] }[];
  summary: string;
}

/** Git & Evolution profile of the scanned repo (C-GIT), from git-analyze.mjs.
 *  Deterministic parse of the repo's .git history; author emails never leak
 *  (aggregated to names/counts only). Degrades gracefully on shallow clones. */
export interface GitEvolution {
  isRepo: boolean;
  shallow: boolean;
  branches: { total: number; stale: number; current: string };
  commits: {
    total: number;
    last30d: number;
    avgSizeFiles: number;
    conventionalPct: number;
  };
  tags: number;
  /** file → commit count (change frequency). */
  churnByFile: Record<string, number>;
  /** top ~25 files by churn. */
  hotFiles: { file: string; churn: number }[];
  /** top co-change pairs (temporal coupling the import graph can't see). */
  temporalCoupling: { a: string; b: string; together: number; confidence: number }[];
  busFactor: {
    singleAuthorFiles: number;
    topAuthors: { name: string; pct: number }[];
  };
  summary: string;
  findings: ScanFinding[];
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
  /** Deterministic stack/tech profile of the scanned repo. */
  stack?: StackProfile;
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
  /** Execution ledger of the scan (C-LEDGER) — per-step timing/tokens/cost. */
  timeline?: ScanStep[];
  /** Rolled-up cost of the scan (C-LEDGER). */
  cost?: ScanCost;
  /** AI-readiness profile of the scanned repo (C-AI). */
  aiReadiness?: AiReadiness;
  /** Git & Evolution profile of the scanned repo (C-GIT). */
  gitEvolution?: GitEvolution;
  /** Stack-aware Infrastructure migration track (Part B) — produced by iac-phase-planner.mjs. */
  iacPlan?: IacPlan;
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
