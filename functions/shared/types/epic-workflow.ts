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
  id: string; // e.g., "AC-1"
  text: string; // plain English description
  needsBrowser: boolean; // does verification require a running browser?
}

export interface VisualTestDef {
  id: string; // e.g., "VT-S5-1"
  criteriaRef: string; // which AC this tests
  description: string; // what to verify
  setup: string; // how to get to the testable state
  action?: string; // user interaction to simulate
  expect: string; // what the result should look like
}

// ── Testing profile & review steps ──

export interface TestingProfile {
  hasBrowserTests: boolean;
  viewport?: string; // e.g., "800x600"
  interactionModel?: string; // e.g., "keyboard", "mouse", "touch"
}

export interface ReviewStep {
  step: string; // e.g., "visual_qa", "po_review"
  status: 'pending' | 'running' | 'passed' | 'failed';
  jobId?: string;
  completedAt?: string;
}

// ── Story ──

export interface EpicStory {
  storyId: string;
  order: number;
  title: string;
  description: string; // full story text including AC
  status: StoryStatus;
  jobId?: string; // linked pipeline job ID
  dependsOn?: string[]; // story IDs this depends on
  wave?: number; // computed wave for parallel execution (0-indexed)
  hasBrowserTests?: boolean; // derived from criteria
  criteria?: AcceptanceCriterion[]; // structured criteria
  visualTests?: VisualTestDef[]; // populated by Dev agent

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
  testingProfile?: TestingProfile; // overall testing config
  reviewSteps?: ReviewStep[]; // dynamic review checklist
  waveBuildJobs?: Record<string, string>; // wave number → build-check job ID
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
