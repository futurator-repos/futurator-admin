export type EpicStatus =
  | 'draft'
  | 'ready'
  | 'in_progress'
  | 'in_review'
  | 'fixing'
  | 'completed'
  | 'failed'
  | 'deployed';
export type StoryStatus =
  | 'pending' // never launched (no jobId yet)
  | 'queued' // job created PENDING; waiting for daemon slot
  | 'running' // daemon actively executing
  | 'in_review'
  | 'fixing'
  | 'done'
  | 'failed'
  | 'skipped'
  | 'blocked';
export type CompilationStatus = 'success' | 'failed' | 'skipped';

// ── Blocker taxonomy (Epic 5) ──

export type BlockerCode =
  | 'ambiguous-ac'
  | 'insufficient-touch-points'
  | 'missing-dependency'
  | 'architectural-conflict'
  | 'context-gap'
  | 'environment';

export type BlockerSeverity = 'hard' | 'soft';

export type BlockerResolutionAction = 'amend' | 'skip' | 'retry';

// ── Touch-point inference (Epic 3) ──

export type StoryComplexity = 'trivial' | 'standard' | 'complex' | 'architectural';
export type ReviewRigor = 'light' | 'standard' | 'strict';
export type InferenceConfidence = 'low' | 'medium' | 'high';

export interface InferenceMetadata {
  inferredAt: string;
  model: 'haiku';
  confidence: InferenceConfidence;
  reasoning?: string;
  retries?: number;
}

export interface BlockerRecord {
  code: BlockerCode;
  severity: BlockerSeverity;
  description: string;
  affectedPath?: string;
  suggestedResolution: string;
  requestedTouchPointExpansion?: string[];
  attemptsBeforeBlock: number;
  reportedAt: string;
  reportedByAttempt: number;
  waveNumber: number;
  subagentId?: string;
}

export interface BlockerResolutionRecord {
  resolvedAt: string;
  resolvedBy: string;
  action: BlockerResolutionAction;
  reason: string;
  amendedFields?: Array<keyof EpicStory>;
}

export interface CompilationArticleCounts {
  created: number;
  updated: number;
  superseded: number;
}

// ── Acceptance criteria & visual test definitions ──

export interface AcceptanceCriterion {
  id: string;
  text: string;
  needsBrowser: boolean;
}

export interface VisualTestDef {
  id: string;
  criteriaRef: string;
  description: string;
  setup: string;
  action?: string;
  expect: string;
}

// ── Testing profile & review steps ──

export interface TestingProfile {
  hasBrowserTests: boolean;
  viewport?: string;
  interactionModel?: string;
}

export interface ReviewStep {
  step: string;
  status: 'pending' | 'running' | 'passed' | 'failed';
  jobId?: string;
  completedAt?: string;
}

// ── Story ──

export interface EpicStory {
  storyId: string;
  order: number;
  title: string;
  description: string;
  status: StoryStatus;
  jobId?: string;
  dependsOn?: string[];
  wave?: number;
  hasBrowserTests?: boolean;
  criteria?: AcceptanceCriterion[];
  visualTests?: VisualTestDef[];

  // ── Compilation metadata (MY-2 Story Compilation Pipeline) ──
  compilationStatus?: CompilationStatus;
  compilationStartedAt?: string;
  compilationCompletedAt?: string;
  compilationArticleCounts?: CompilationArticleCounts;

  // ── Work summary (Epic B.6) ──
  // Verbatim WORK_SUMMARY block extracted from the DEV / retry agent and
  // persisted by the daemon. Sibling stories in the same wave read it via
  // the Story Context Pack. Last-write-wins.
  workSummary?: string;
  workSummaryAt?: string;

  // ── Touch-point inference (Epic 3) ──
  touchPoints?: string[];
  /** Story D.1 — file paths / globs the story MUST NOT modify. */
  forbiddenAreas?: string[];
  complexity?: StoryComplexity;
  reviewRigor?: ReviewRigor;
  inferenceMetadata?: InferenceMetadata;

  // ── Blocker state (Epic 5) ──
  blocker?: BlockerRecord;
  resolutionHistory?: BlockerResolutionRecord[];
}

// ── Epic ──

export interface EpicWorkflow {
  epicId: string;
  /** FK to Plan (Epic 17). */
  planId?: string;
  /** Epic-level dependency graph — IDs of epics that must complete first. */
  dependsOnEpics?: string[];
  /** Computed from dependsOnEpics. 0 = runs first. */
  epicWave?: number;
  title: string;
  description: string;
  acceptanceCriteria: string;
  workingDir: string;
  status: EpicStatus;
  stories: EpicStory[];
  testingProfile?: TestingProfile;
  reviewSteps?: ReviewStep[];
  waveBuildJobs?: Record<string, string>;
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  yoloMode?: boolean;
  qaJobId?: string;
  poJobId?: string;
  deployJobId?: string;
  deployUrl?: string;
  deployedAt?: string;

  // ── Epic Orchestrator (Epic 4) ──
  useEpicOrchestrator?: boolean;
  orchestratorJobId?: string;

  createdAt: string;
  updatedAt: string;
  createdBy: string;
}

export interface CreateEpicInput {
  title: string;
  description: string;
  acceptanceCriteria: string;
  workingDir: string;
  stories: { title: string; description: string; dependsOn?: string[] }[];
  devModel?: string;
  devEffort?: string;
  reviewerModel?: string;
  reviewerEffort?: string;
  yoloMode?: boolean;
}
