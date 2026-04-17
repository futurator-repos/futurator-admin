/**
 * Epic-dev launcher helpers (EO-4.4).
 *
 * Pure functions that turn an `EpicWorkflow` into the payload stored on a
 * `phase: 'epic-dev'` agent job. Kept out of the route handler so they
 * can be unit-tested without mocking Hono, auth, or DynamoDB.
 */

import type { EpicStory, EpicWorkflow } from '../types/epic-workflow';
import type {
  EpicDevJobPayload,
  OrchestratorModel,
  StoryManifestEntry,
} from '../types/agent-orchestrator';

export type LauncherFailureCode =
  | 'flag-disabled'
  | 'invalid-status'
  | 'no-stories'
  | 'inference-missing';

export interface LauncherValidationFailure {
  ok: false;
  code: LauncherFailureCode;
  message: string;
  missingInferenceFor?: string[];
}

export interface LauncherValidationSuccess {
  ok: true;
  payload: EpicDevJobPayload;
}

export type LauncherValidationResult = LauncherValidationSuccess | LauncherValidationFailure;

const ALLOWED_START_STATUSES: ReadonlyArray<EpicWorkflow['status']> = ['ready', 'fixing'];

export interface LauncherOverrides {
  orchestratorModel?: OrchestratorModel;
  maxParallel?: number;
  maxRemediationRounds?: number;
  rubric?: string;
  contextDigest?: string;
}

export function validateEpicForOrchestratorStart(
  epic: EpicWorkflow,
  overrides: LauncherOverrides = {},
): LauncherValidationResult {
  if (!epic.useEpicOrchestrator) {
    return {
      ok: false,
      code: 'flag-disabled',
      message:
        'Epic Orchestrator is not enabled for this epic. Toggle useEpicOrchestrator to true to use the single-job flow.',
    };
  }

  if (!ALLOWED_START_STATUSES.includes(epic.status)) {
    return {
      ok: false,
      code: 'invalid-status',
      message: `Epic must be in 'ready' or 'fixing' status (current: ${epic.status}).`,
    };
  }

  if (!epic.stories || epic.stories.length === 0) {
    return { ok: false, code: 'no-stories', message: 'Epic has no stories to run.' };
  }

  const missing = epic.stories.filter(
    (s) => !s.touchPoints?.length || !s.complexity || !s.reviewRigor,
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'inference-missing',
      missingInferenceFor: missing.map((s) => s.storyId),
      message: `${missing.length} story/ies lack touch-point inference.`,
    };
  }

  const payload = buildEpicDevPayload(epic, overrides);

  return { ok: true, payload };
}

/**
 * Builds the EpicDevJobPayload from an epic. No validation — callers that
 * need the status/inference gates should use `validateEpicForOrchestratorStart`.
 * The resume flow (Epic 5 resolve-blocker) bypasses those gates because it
 * has already reset the story state and has its own preconditions.
 */
export function buildEpicDevPayload(
  epic: EpicWorkflow,
  overrides: LauncherOverrides = {},
): EpicDevJobPayload {
  const manifest = (epic.stories ?? []).map(buildStoryManifestEntry);

  return {
    orchestratorModel: overrides.orchestratorModel ?? 'opus',
    maxParallel: overrides.maxParallel ?? 4,
    maxRemediationRounds: overrides.maxRemediationRounds ?? 2,
    epicGoal: epic.title,
    contextDigest: overrides.contextDigest ?? epic.description ?? '',
    rubric: overrides.rubric ?? '',
    stories: manifest,
  };
}

export function buildStoryManifestEntry(story: EpicStory): StoryManifestEntry {
  return {
    storyId: story.storyId,
    title: story.title,
    wave: story.wave ?? 1,
    acceptanceCriteria: (story.criteria ?? []).map((c) => c.text),
    touchPoints: story.touchPoints ?? [],
    complexity: story.complexity!,
    reviewRigor: story.reviewRigor!,
    dependsOn: story.dependsOn,
  };
}
