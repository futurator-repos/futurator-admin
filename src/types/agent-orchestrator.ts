import type { AuditHotspot, HotspotKind, PrivacyAuditSummary } from './refactor-audit';

// ── Job status ──
//
// Pipeline v1 (Story 1.1) extends the enum with NEEDS_ATTENTION,
// COMPLETED_VIA_SALVAGE, and MANUALLY_SKIPPED. See
// `functions/shared/types/agent-orchestrator.ts` for the canonical
// definition + state-machine documentation.

export type AgentJobStatus =
  | 'PENDING'
  | 'RUNNING'
  | 'COMPLETED'
  | 'FAILED'
  | 'COMPLETE_WITH_BLOCKED_STORIES'
  | 'STALE'
  | 'NEEDS_ATTENTION'
  | 'COMPLETED_VIA_SALVAGE'
  | 'COMPLETED_VIA_TALK'
  | 'MANUALLY_SKIPPED';

export type JobTriggeredBy =
  | 'AGENT_ESCALATED'
  | 'AGENT_NEEDS_HUMAN'
  | 'LOOP_DETECTED'
  | 'PREFLIGHT_FAILED'
  | 'POSTVALIDATE_FAILED'
  | 'COST_CEILING'
  | 'TIME_CEILING'
  | 'QUOTA_EXHAUSTED'
  | 'CAPACITY_TIMEOUT'
  | 'RETRY_EXHAUSTED'
  | 'OPERATOR_ABORT';

export interface EscalationPayload {
  whatFailed: string;
  whatTried: string[];
  whyStuck: string;
  recommendedAction?: 'retry-with-hint' | 'skip-step' | 'ask-human' | 'abort-job';
  humanQuestion?: string;
}

// ── Pipeline definition (user-configured) ──

export interface AgentConfig {
  name: string;
  allowedTools?: string;
  disallowedTools?: string;
  model?: string;
}

export type ExtractorType = 'regex' | 'between';

export interface ExtractorConfig {
  type: ExtractorType;
  pattern?: string;
  startDelimiter?: string;
  endDelimiter?: string;
}

export type ValidationType = 'equals' | 'not_contains' | 'contains';

export interface ValidationConfig {
  type: ValidationType;
  left: string;
  right: string;
  label: string;
}

// Step type discriminator
export type PipelineStepType = 'agent' | 'shell';

export type PreflightCheck = { check: 'folder-exists'; path: string; writable_by?: string };

export type ConcurrencyClass = 'interactive' | 'critical' | 'background';

export interface PipelineStep {
  id: string;
  stepType?: PipelineStepType; // default 'agent' for backward compat
  agentId?: string; // required for agent steps, absent for shell
  prompt?: string; // supports {{VAR_NAME}} template substitution

  // Agent-specific
  resumeFromStep?: string;
  extractors?: Record<string, ExtractorConfig>;
  validations?: ValidationConfig[];
  loopTo?: string;

  // Shell-specific
  command?: string;
  timeout?: number;
  expectExitCode?: number;
  captureAs?: string;
  captureStderrAs?: string;
  onFail?: {
    action: 'fail' | 'retry_step';
    targetStep?: string;
    injectAs?: string;
  };

  // Pipeline v1 — failure-recovery + scheduling metadata.
  preconditions?: PreflightCheck[];
  skipTolerant?: boolean;
  salvageable?: boolean;
  timeCeilingMs?: number;
  concurrencyClass?: ConcurrencyClass;
  maxConsecutiveRetries?: number;
}

export interface PipelineDefinition {
  agents: Record<string, AgentConfig>;
  steps: PipelineStep[];
  maxIterations?: number;
}

// ── Job ──

export interface StepResult {
  stepId: string;
  agentId: string;
  status: 'running' | 'complete' | 'error';
  sessionId?: string;
  cost?: number;
  durationMs?: number;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  contextWindow?: number;
  numTurns?: number;
  extractedVariables?: Record<string, string>;
  validationResults?: ValidationResult[];
  errorMessage?: string;
}

export interface ValidationResult {
  label: string;
  passed: boolean;
  details: string;
}

/**
 * One lane (agent) of a dual-agent comparison run. Mirror of
 * `DualAgentLaneResult` in `functions/shared/types/agent-orchestrator.ts`.
 */
export interface DualAgentLaneResult {
  lane: 'A' | 'B';
  label: string;
  withGraph: boolean;
  answer: string;
  latencyMs: number;
  tokens: { input: number; output: number };
  costUsd: number | null;
  toolCalls: number;
  graphToolCalls: number;
  error?: string;
}

export interface AgentJob {
  jobId: string;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  workingDir: string;
  pipeline: PipelineDefinition;
  currentStepIndex?: number;
  /**
   * PR-50 (2026-05-07) — denormalized current step ID written by the
   * daemon on every step transition. Used by per-story status badges
   * (`src/lib/step-status-labels.ts::formatStepStatus`).
   */
  currentStepId?: string;
  variables?: Record<string, string>;
  sessions?: Record<string, string>;
  stepResults?: StepResult[];
  totalCost?: number;
  errorMessage?: string;
  /** Phase A.3 retry ladder: 0 for original run, increments on each re-queue. */
  retryAttempt?: number;
  /** Phase A.3 retry ladder: ISO timestamp gating daemon re-pick. */
  retryAfter?: string;

  // Servers module — dispatch provenance written by server-dispatcher.ts.
  // `assignedServerId` resolves to a ComputeServer.name via useServers().
  assignedServerId?: string;
  assignedAt?: string;
  assignReason?: string;

  // Pipeline v1 — Failure recovery surface (Stories 1.1–1.8).
  attentionItemIds?: string[];
  salvageableExtractors?: string[];
  triggeredBy?: JobTriggeredBy;
  escalationPayload?: EscalationPayload;
  retryOf?: string;
  epicId?: string;
  projectId?: string;

  /**
   * v2.6 M5 — wave-merge gate job summary (jobType 'wave-merge'), written by
   * the daemon on terminal status. `vqa` is the wave-gate visual-QA summary
   * (null when the VQA hook wasn't armed for this wave).
   */
  waveMergeResult?: {
    outcome?: string;
    mergedStoryIds?: string[];
    pushSha?: string;
    vqa?: {
      outcome: 'pass' | 'fixed' | 'fix-forward' | 'skipped' | 'env-blocked';
      reason?: string;
      pass?: number;
      fixed?: number;
      fixForward?: Array<{
        storyId: string;
        acId: string;
        observed?: string;
        screenshotUrl?: string | null;
      }>;
      unverifiable?: number;
      reportPath?: string | null;
    } | null;
  };

  /**
   * Refactoring Assessment Module (Epic B) — denormalized headline summary
   * written by the daemon's `executeRefactorAuditJob` on terminal status, so
   * the hotspot dashboard can render counts straight from the polled job.
   * Mirror of `AgentJob.refactorAuditSummary` in
   * `functions/shared/types/agent-orchestrator.ts`.
   */
  /** Refactoring Scan Engine v2 summary (jobType 'scan-engine'), denormalized
   *  onto the job row. Full scan rides S3 (_refactor/scan.json). */
  scanEngineSummary?: {
    auditId: string;
    findingCount: number;
    counts: {
      total: number;
      deterministic: number;
      llm: number;
      byDimension: Record<string, number>;
    };
    phaseCount: number;
    gateViolations: number;
    lowConfidence: boolean;
    scanAvailable: boolean;
    reportPath: string | null;
  };

  /** Dual-agent comparison result (jobType 'dual-agent-compare'), denormalized
   *  onto the job row by the daemon. Mirror of the backend field. */
  dualAgentCompareResult?: {
    question: string;
    model: string;
    agentA: DualAgentLaneResult;
    agentB: DualAgentLaneResult;
  };

  refactorAuditSummary?: {
    hotspotCount: number;
    counts: Partial<Record<HotspotKind, number>>;
    /** Full ranked hotspot list (MVP transport — see backend mirror). */
    hotspots?: AuditHotspot[];
    auditId?: string;
    reportPath: string | null;
    /** Whether the file-level graph projection was uploaded to S3 (Graph tab). */
    graphAvailable?: boolean;
    /** Total hotspots detected vs shown (surfaces any cap). */
    detectedCount?: number;
    shownCount?: number;
    /** Recon tool availability (e.g. { graphify:'ok', knip:'unavailable' }). */
    toolStatus?: Record<string, string>;
    /** Data Privacy Assessment summary (when runPrivacy was set). */
    privacy?: PrivacyAuditSummary;
  };
}

// ── Events ──

export type AgentEventType =
  | 'text_delta'
  | 'tool_use'
  | 'tool_result'
  | 'result'
  | 'status'
  | 'step_start'
  | 'step_complete'
  | 'step_error'
  | 'extraction'
  | 'validation'
  | 'skill_loaded';

export interface AgentEvent {
  jobId: string;
  eventSeq: string;
  seq: number;
  timestamp: string;
  stepId: string;
  agentId: string;
  eventType: AgentEventType;
  text?: string;
  toolName?: string;
  toolInput?: string;
  toolOutput?: string;
  cost?: number;
  sessionId?: string;
  durationMs?: number;
  variableName?: string;
  variableValue?: string;
  /** For `skill_loaded` events — the skills PUSH-injected into this story-dev agent. */
  skills?: string[];
  extractorType?: string;
  validationLabel?: string;
  validationPassed?: boolean;
  validationDetails?: string;
  /**
   * Story A.7: 6-char uppercase prefix derived from the story UUID, attached
   * by the daemon when a per-story pipeline emits the event. Empty/absent for
   * orchestrator/party jobs. The Logs tab UI renders this as `[ABC123]` in
   * the action header so parallel-story logs are easy to disambiguate.
   */
  storyShortId?: string;
}

// ── Create input ──

export interface CreateAgentJobInput {
  workingDir: string;
  pipeline: PipelineDefinition;
}

// ── Orchestrator events (Epic Orchestrator, arch doc §9) ──

export type OrchestratorEventType =
  | 'epic_start'
  | 'epic_complete'
  | 'epic_failed'
  | 'wave_start'
  | 'wave_complete'
  | 'wave_split'
  | 'wave_collision'
  | 'touch_points_expanded'
  | 'subagent_dispatch'
  | 'subagent_return'
  | 'dev_blocker_reported'
  | 'story_blocked'
  | 'review_verdict'
  | 'remediation_start'
  | 'story_failed_terminally'
  | 'blocker_resolved';

export type OrchestratorRole = 'orchestrator' | 'dev' | 'reviewer';

export interface OrchestratorEvent {
  jobId: string;
  epicId?: string;
  storyId?: string;
  role?: OrchestratorRole;
  subagentId?: string;
  attempt?: number;
  correlationId?: string;
  eventType: OrchestratorEventType | string;
  payload?: Record<string, unknown>;
  ts: number;
}
