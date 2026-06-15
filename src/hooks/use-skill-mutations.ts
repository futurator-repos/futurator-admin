'use client';

/**
 * Skills Management Phase 2, Story 2.4 (2026-06-15).
 *
 * Create / edit / delete operator-authored skills. Each mutation invalidates
 * the catalog query so the Registry reflects the change after the write commits
 * to futurator-repos/futurator-skills.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';

export interface SkillWriteInput {
  name: string;
  description: string;
  body: string;
  kind?: string;
  license?: string;
}

function useInvalidateCatalog() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['skills'] });
}

export function useCreateSkill() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: (input: SkillWriteInput) =>
      api.post<{ name: string; created: boolean }>('/skills', input),
    onSuccess: invalidate,
  });
}

export function useUpdateSkill() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: ({ name, ...body }: SkillWriteInput) =>
      api.put<{ name: string; created: boolean }>(`/skills/${encodeURIComponent(name)}`, body),
    onSuccess: invalidate,
  });
}

export function useDeleteSkill() {
  const invalidate = useInvalidateCatalog();
  return useMutation({
    mutationFn: (name: string) =>
      api.delete<{ name: string; bodyDeleted: boolean }>(`/skills/${encodeURIComponent(name)}`),
    onSuccess: invalidate,
  });
}
