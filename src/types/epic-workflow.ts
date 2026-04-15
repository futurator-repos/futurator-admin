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
  | 'pending'
  | 'running'
  | 'in_review'
  | 'fixing'
  | 'done'
  | 'failed'
  | 'skipped';
export type CompilationStatus = 'success' | 'failed' | 'skipped';

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
}

// ── Epic ──

export interface EpicWorkflow {
  epicId: string;
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
