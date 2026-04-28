'use client';
/**
 * use-rotate-pat.ts — Story 1.7.1 (Pipeline v2 Phase 1)
 *
 * Mutation hook that calls PUT /api/github/pat to rotate the GitHub PAT.
 *
 * SECURITY RULES:
 *  - The PAT value is passed directly to the API; it is never stored in
 *    React state beyond the textarea the user is typing in.
 *  - On submit the caller is responsible for clearing the textarea.
 *  - Do NOT log or persist the PAT anywhere on the client.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface RotatePATInput {
  pat: string;
}

export interface RotatePATResult {
  rotated: boolean;
  login: string;
  rotatedAt: string;
}

export function useRotatePAT() {
  const qc = useQueryClient();

  return useMutation<RotatePATResult, Error, RotatePATInput>({
    mutationFn: ({ pat }) => api.put<RotatePATResult>('/github/pat', { pat }),
    onSuccess: () => {
      // Refetch both status + rotated-at after a successful rotation.
      void qc.invalidateQueries({ queryKey: ['github-status'] });
      void qc.invalidateQueries({ queryKey: ['github-rotated-at'] });
    },
  });
}
