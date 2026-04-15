// ── Job status ──

export type AgentJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

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

export interface AgentJob {
  jobId: string;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  workingDir: string;
  pipeline: PipelineDefinition;
  currentStepIndex?: number;
  variables?: Record<string, string>;
  sessions?: Record<string, string>;
  stepResults?: StepResult[];
  totalCost?: number;
  errorMessage?: string;
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
  | 'validation';

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
  extractorType?: string;
  validationLabel?: string;
  validationPassed?: boolean;
  validationDetails?: string;
}

// ── Create input ──

export interface CreateAgentJobInput {
  workingDir: string;
  pipeline: PipelineDefinition;
}
