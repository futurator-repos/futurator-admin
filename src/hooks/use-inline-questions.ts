'use client';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { InlineQuestion, InlineQuestionInput } from '@/types/inline-question';

export function useInlineQuestions(sessionId: string | null) {
  return useQuery({
    queryKey: ['party', 'inline-questions', sessionId],
    queryFn: () =>
      api.get<{ questions: InlineQuestion[] }>(
        `/party/sessions/${sessionId}/inline-questions`,
      ),
    enabled: !!sessionId,
    staleTime: 5_000,
  });
}

export function useCreateInlineQuestion(sessionId: string | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: InlineQuestionInput) => {
      if (!sessionId) throw new Error('sessionId is required');
      return api.post<InlineQuestion>(
        `/party/sessions/${sessionId}/inline-questions`,
        input,
      );
    },
    onSuccess: (created) => {
      qc.setQueryData<{ questions: InlineQuestion[] }>(
        ['party', 'inline-questions', sessionId],
        (prev) => {
          const next = [created, ...(prev?.questions ?? [])];
          return { questions: next };
        },
      );
    },
  });
}
