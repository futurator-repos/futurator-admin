'use client';
import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { StoryNodeRow, StoryNodeState } from '@/types/plan-spec';

/**
 * The lifecycle states that mean a plan-spec graph is still moving — any row in
 * one of these makes the snapshot worth polling. Exported so B2-B7 reuse the
 * exact same "is this plan live?" predicate (no drift between poll-gating and
 * pulse animation).
 */
export const ACTIVE_STORY_NODE_STATES: ReadonlySet<StoryNodeState> = new Set<StoryNodeState>([
  'ready',
  'claimed',
  'developing',
  'merging',
  'verifying',
]);

/** True when any row is in an active (still-moving) state. */
export function hasActiveStory(rows: StoryNodeRow[] | undefined): boolean {
  return !!rows?.some((r) => ACTIVE_STORY_NODE_STATES.has(r.state));
}

/**
 * The full plan-spec-graph snapshot for a plan (GET /plans/:id/story-nodes).
 * Polls every 2s while any story is active (ready/claimed/developing/merging/
 * verifying), otherwise stops — mirroring the live-graph driver. Returns []
 * (not an error) for a plan that hasn't been ingested as Pipeline-3 yet.
 */
export function useStoryNodes(planId: string | null): UseQueryResult<StoryNodeRow[]> {
  return useQuery({
    queryKey: ['story-nodes', planId],
    queryFn: () =>
      api.get<{ stories: StoryNodeRow[] }>(`/plans/${planId}/story-nodes`).then((d) => d.stories),
    enabled: !!planId,
    // COLD-START TRAP (pacman4, 2026-07-04): `hasActiveStory([])` is false, so a
    // page opened BEFORE ingest settled into never-poll and showed "0/0 · No
    // StoryNodes" while the plan was actually building. Empty/undefined data =
    // pre-ingest → keep polling (5s) until stories exist; then the active-story
    // cadence takes over (2s while building, stop when settled).
    refetchInterval: (query) => {
      const data = query.state.data;
      if (!data || data.length === 0) return 5_000;
      return hasActiveStory(data) ? 2_000 : false;
    },
  });
}

/**
 * The ready-frontier (or any single-state slice) for a plan via the
 * planId-state-index GSI. Defaults to 'ready' — the stories the daemon's
 * ready-frontier is about to dispatch.
 */
export function useStoryFrontier(
  planId: string | null,
  state: StoryNodeState = 'ready',
): UseQueryResult<StoryNodeRow[]> {
  return useQuery({
    queryKey: ['story-nodes', planId, state],
    queryFn: () =>
      api
        .get<{ stories: StoryNodeRow[] }>(`/plans/${planId}/story-nodes?state=${state}`)
        .then((d) => d.stories),
    enabled: !!planId,
    // A frontier of an active state is inherently churny — poll it; a terminal
    // slice ('done'/'failed'/'blocked') is stable, so don't.
    refetchInterval: ACTIVE_STORY_NODE_STATES.has(state) ? 2_000 : false,
  });
}

/**
 * Operator retry for a wedged story (failed, or a dead claim after a daemon
 * crash). POST /plans/:id/stories/:storyId/retry → the API validates the story
 * isn't ACTIVELY running (409), retires the dead job, resets the row to
 * 'ready', and the frontier re-mints. The retry-idempotent test-author reuses
 * any committed RED tests, so a re-run converges instead of duplicating work.
 */
export function useRetryStory(planId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (storyId: string) =>
      api.post<{ ok: boolean; storyId: string; state: string }>(
        `/plans/${planId}/stories/${storyId}/retry`,
        {},
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['story-nodes', planId] });
    },
  });
}
