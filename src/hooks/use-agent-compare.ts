'use client';

/**
 * Dual-agent comparison harness hook (the "ultimate goal").
 *
 *   useRunAgentCompare(appId) — POST /party/projects/:id/agent-compare → { jobId }.
 *
 * Poll the returned jobId with the existing `useAgentJob`; when COMPLETED the
 * daemon denormalizes `dualAgentCompareResult` (agentA vanilla vs agentB +graph)
 * onto the job row, which the comparison panel renders side-by-side.
 *
 * NOTE: api-client base already ends in `/api` — do NOT prefix paths with `/api`.
 */

import { useMutation } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface RunAgentCompareInput {
  question: string;
  model?: string;
  timeoutMs?: number;
}

interface RunAgentCompareResponse {
  jobId: string;
  projectId: string;
}

/** A few starter questions that exercise the graph (privacy/architecture lens). */
export const COMPARE_PRESETS: string[] = [
  'Where is the user’s personal information stored, and how?',
  'What 3rd-party services does this app use, and what data flows to them?',
  'Which AI provider does this app use and how (e.g. Claude API vs AWS Bedrock)?',
  'Where is the infrastructure defined (Terraform/Pulumi/SST/CDK) and in which region?',
  'What is the blast radius of changing the authentication module?',
];

export function useRunAgentCompare(appId: string | null) {
  return useMutation({
    mutationFn: (input: RunAgentCompareInput) =>
      api.post<RunAgentCompareResponse>(`/party/projects/${appId}/agent-compare`, input),
  });
}
