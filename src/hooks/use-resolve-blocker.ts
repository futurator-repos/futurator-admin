'use client';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  AcceptanceCriterion,
  BlockerResolutionAction,
  StoryComplexity,
  ReviewRigor,
} from '@/types/epic-workflow';

export interface AmendFields {
  title?: string;
  description?: string;
  criteria?: AcceptanceCriterion[];
  touchPoints?: string[];
  complexity?: StoryComplexity;
  reviewRigor?: ReviewRigor;
  dependsOn?: string[];
}

export type ResolveBlockerBody =
  | {
      action: 'amend';
      amendedStory: AmendFields;
      reason: string;
      expectedBlockerReportedAt?: string;
    }
  | {
      action: 'skip';
      reason: string;
      expectedBlockerReportedAt?: string;
    }
  | {
      action: 'retry';
      reason: string;
      resumeImmediately?: boolean;
      expectedBlockerReportedAt?: string;
    };

export interface ResolveBlockerResponse {
  ok: true;
  storyId: string;
  newStatus: 'pending' | 'skipped';
  resumeJobId: string | null;
  resolvedAt: string;
  warnings?: string[];
}

export interface ResolveBlockerInput {
  storyId: string;
  body: ResolveBlockerBody;
}

export function useResolveBlocker(epicId: string) {
  const queryClient = useQueryClient();

  return useMutation<ResolveBlockerResponse, Error, ResolveBlockerInput>({
    mutationFn: (input) =>
      api.post<ResolveBlockerResponse>(
        `/epic-workflows/${epicId}/stories/${input.storyId}/resolve-blocker`,
        input.body,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['epic-workflow', epicId] });
      queryClient.invalidateQueries({ queryKey: ['agent-jobs'] });
    },
  });
}

export function isBlockerChangedError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'blocker-changed';
}

export function isNotBlockedError(err: unknown): boolean {
  return err instanceof Error && (err as Error & { code?: string }).code === 'not-blocked';
}

export const RESOLVE_ACTIONS: BlockerResolutionAction[] = ['amend', 'skip', 'retry'];
