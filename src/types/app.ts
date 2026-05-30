/**
 * App/Plan v1 — frontend mirror of `functions/shared/types/app.ts`.
 *
 * Kept in sync by hand. Update both files together when the App schema evolves.
 */

export type AppExecutionMode = 'pipeline' | 'orchestrator';
export type AppWorkingTreeStatus = 'clean' | 'dirty-from-abandoned-plan';
export type AppDerivedStatus = 'live' | 'building' | 'dirty-tree' | 'no-deploy';

/**
 * Story 1.4 contract — boilerplate type for GitHub-backed Apps.
 * Added as optional so pre-1.4 legacy apps keep their existing shape.
 *
 * PR-13 — `nextjs` renamed to `nextjs-base`; new starter packs added.
 * Legacy 'nextjs' kept as a union member for App rows already in DDB; the
 * client-side `getBoilerplateClientView` normalizes it to `nextjs-base`.
 */
export type BoilerplateType =
  | 'nextjs-base'
  | 'nextjs-canvas-game'
  | 'nextjs-form-app'
  | 'nextjs-dashboard'
  | 'sst'
  | 'vite'
  | 'mobile'
  | 'nextjs'; // legacy

export interface App {
  appId: string;
  displayName: string;
  icon?: string;
  workingDir: string;
  executionMode: AppExecutionMode;
  currentlyDeployedPlanId: string | null;
  deployJobIds: string[];
  workingTreeStatus: AppWorkingTreeStatus;
  createdAt: string;
  updatedAt: string;
  /** Story 1.4 — set when app was created from a boilerplate template. */
  boilerplateType?: BoilerplateType;
  /** Story 1.4 — true when BMAD pre-install ran during bootstrap. */
  bmadEnabled?: boolean;
  /** Story 1.4 — ISO timestamp set once the bootstrap saga completes. */
  bootstrappedAt?: string;
  /** 2026-05-30 — brownfield: the App's real GitHub repo URL (any org). */
  githubRepoUrl?: string;
  /** 2026-05-30 — default branch tracked for githubRepoUrl (default 'main'). */
  githubBranch?: string;
}

export interface AppCardData extends App {
  planCount: number;
  currentlyLiveLabel: string | null;
  derivedStatus: AppDerivedStatus;
}

export interface CreateAppInput {
  appId: string;
  displayName: string;
  icon?: string;
  executionMode?: AppExecutionMode;
  /** Story 1.4 — selected from the registry; defaults to `'nextjs'` server-side. */
  boilerplateType?: BoilerplateType;
  /** Story 1.4 — only meaningful when the chosen type's `bmadSupported`. */
  bmadEnabled?: boolean;
}

export interface UpdateAppInput {
  displayName?: string;
  icon?: string;
  executionMode?: AppExecutionMode;
  workingTreeStatus?: AppWorkingTreeStatus;
}
