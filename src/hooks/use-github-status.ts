'use client';
/**
 * use-github-status.ts — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Fetches the current GitHub connection status from GET /api/github/status
 * (public route) and the last-rotation timestamp from GET /api/github/rotated-at
 * (auth-required).
 *
 * staleTime: 60_000 — connection status is operational data, refresh every minute.
 */

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface RateLimit {
  limit: number;
  remaining: number;
  reset: number; // Unix timestamp (seconds)
}

export interface GitHubStatusConnected {
  connected: true;
  login: string;
  rateLimit: RateLimit;
}

export interface GitHubStatusDisconnected {
  connected: false;
  error?: string;
  rateLimit?: RateLimit;
}

export type GitHubStatus = GitHubStatusConnected | GitHubStatusDisconnected;

export function useGitHubStatus() {
  return useQuery<GitHubStatus>({
    queryKey: ['github-status'],
    queryFn: () =>
      api.get<GitHubStatus>('/github/status').catch(() => ({
        connected: false as const,
        error: 'Could not reach the status endpoint',
      })),
    staleTime: 60_000,
    retry: 1,
  });
}

export interface RotatedAtData {
  rotatedAt: string | null;
}

export function useGitHubRotatedAt() {
  return useQuery<RotatedAtData>({
    queryKey: ['github-rotated-at'],
    queryFn: () => api.get<RotatedAtData>('/github/rotated-at'),
    staleTime: 60_000,
    retry: 1,
  });
}
