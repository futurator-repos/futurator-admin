'use client';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { QueueRequest, QueueTarget } from '@/types/queue';

export interface EnqueueResult {
  requestId: string;
  jobId: string;
  status: string;
}

/** List recent queue-requests (Queues tab). Polls while the panel is mounted. */
export function useQueueRequests(pollMs = 2500) {
  return useQuery({
    queryKey: ['queue-requests'],
    queryFn: () => api.get<{ requests: QueueRequest[] }>('/queue/requests'),
    refetchInterval: pollMs,
    staleTime: 1000,
  });
}

/** One request, polled while non-terminal so the detail view stays live. */
export function useQueueRequest(requestId: string | null) {
  return useQuery({
    queryKey: ['queue-request', requestId],
    queryFn: () => api.get<QueueRequest>(`/queue/requests/${requestId}`),
    enabled: Boolean(requestId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === 'COMPLETED' || status === 'FAILED' || status === 'RESPONDED') return false;
      return 1500;
    },
  });
}

export interface TestCallInput {
  source: string;
  prompt?: string;
  body?: unknown;
  target?: QueueTarget;
  receiver?: string;
  callbackUrl?: string;
  autoRespond?: boolean;
}

/** Fire an operator test call from the Tests tab. */
export function useCreateTestRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: TestCallInput) => api.post<EnqueueResult>('/queue/test', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['queue-requests'] }),
  });
}

/** Manually deliver (or re-route) a captured response to a receiver. */
export function useRespondQueueRequest() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (vars: { requestId: string; receiverUrl?: string }) =>
      api.post<{ ok: boolean; respondedTo: string }>(`/queue/requests/${vars.requestId}/respond`, {
        receiverUrl: vars.receiverUrl,
      }),
    onSuccess: (_data, vars) => {
      queryClient.invalidateQueries({ queryKey: ['queue-requests'] });
      queryClient.invalidateQueries({ queryKey: ['queue-request', vars.requestId] });
    },
  });
}
