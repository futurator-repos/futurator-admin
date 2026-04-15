// ── Job status ──

export type AgentJobStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED';

// ── Pipeline definition (user-configured) ──

export interface AgentConfig {
  name: string;
  allowedTools?: string;
  disallowedTools?: string;
  model?: string; // e.g. 'sonnet', 'opus', 'haiku', 'claude-sonnet-4-6'
}

export type ExtractorType = 'regex' | 'between';

export interface ExtractorConfig {
  type: ExtractorType;
  pattern?: string; // for regex: first capture group is the value
  startDelimiter?: string; // for between: extract text between these
  endDelimiter?: string;
}

export type ValidationType = 'equals' | 'not_contains' | 'contains';

export interface ValidationConfig {
  type: ValidationType;
  left: string; // variable name
  right: string; // variable name or literal (prefixed with "literal:" if not a var)
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
  resumeFromStep?: string; // step ID whose session to --resume
  extractors?: Record<string, ExtractorConfig>;
  validations?: ValidationConfig[];
  loopTo?: string; // step ID: if validations fail, run that step then re-check this one

  // Shell-specific
  command?: string; // bash command to execute
  timeout?: number; // ms, default 30000
  expectExitCode?: number; // default 0
  captureAs?: string; // store stdout in this variable name
  captureStderrAs?: string; // store stderr in this variable name
  onFail?: {
    action: 'fail' | 'retry_step';
    targetStep?: string;
    injectAs?: string; // variable name to inject error output into
  };
}

export interface PipelineDefinition {
  agents: Record<string, AgentConfig>;
  steps: PipelineStep[];
  maxIterations?: number; // max loop retries (default 1 = no retry)
  initialVariables?: Record<string, string>; // variables injected at pipeline start (e.g., STORY_ID, EPIC_ID)
}

// ── Job (stored in DynamoDB) ──

export interface AgentJob {
  jobId: string;
  status: AgentJobStatus;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  workingDir: string;
  pipeline: PipelineDefinition;

  // Runtime state (written by daemon)
  currentStepIndex?: number;
  variables?: Record<string, string>;
  sessions?: Record<string, string>; // stepId → Claude session ID
  stepResults?: StepResult[];
  totalCost?: number;
  errorMessage?: string;

  // Compilation metadata (MY-2 Story Compilation Pipeline)
  compilationStatus?: 'success' | 'failed' | 'skipped';
  compilationStartedAt?: string;
  compilationCompletedAt?: string;
}

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

// ── Events (stored in DynamoDB) ──

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
  | 'compilation-started'
  | 'compilation-completed'
  | 'compilation-failed';

export interface AgentEvent {
  jobId: string;
  eventSeq: string;
  seq: number;
  timestamp: string;
  stepId: string;
  agentId: string;
  eventType: AgentEventType;

  // text_delta / status
  text?: string;

  // tool_use
  toolName?: string;
  toolInput?: string;

  // tool_result
  toolOutput?: string;

  // result / step_complete
  cost?: number;
  sessionId?: string;
  durationMs?: number;

  // extraction
  variableName?: string;
  variableValue?: string;
  extractorType?: string;

  // validation
  validationLabel?: string;
  validationPassed?: boolean;
  validationDetails?: string;

  // compilation events
  compilationEvent?: 'compilation-started' | 'compilation-completed' | 'compilation-failed';
  compilationStatus?: 'success' | 'failed' | 'skipped';
  compilationStartedAt?: string;
  compilationCompletedAt?: string;
  errorMessage?: string;
  errorStack?: string;
  storyId?: string;
  epicId?: string;
  projectId?: string;
  articlesCreated?: number;
  articlesUpdated?: number;
  articlesSuperseded?: number;

  // TTL
  expireAt: number;
}
