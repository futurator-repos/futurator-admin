'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type {
  CreateMigrationInput,
  CreateMigrationResponse,
  DeleteMigrationResponse,
  ListMigrationsResponse,
  UpdateMigrationInput,
  UpdateMigrationResponse,
} from '@/types/migration';

/**
 * Migrate-module — list every brownfield Party project the operator
 * has registered. Refetches every 30s so newly-running bootstraps move
 * through INSTALLING → HEALTHY without manual refresh.
 */
export function useMigrations(enabled = true) {
  return useQuery({
    queryKey: ['migrations'],
    queryFn: () => api.get<ListMigrationsResponse>('/migrations'),
    staleTime: 30_000,
    refetchInterval: (query) => {
      const migrations = query.state.data?.migrations;
      if (!migrations) return false;
      const anyTransitional = migrations.some(
        (m) => m.bmadStatus === 'INSTALLING' || m.bmadStatus === 'REFRESHING',
      );
      return anyTransitional ? 2000 : 30_000;
    },
    enabled,
  });
}

/**
 * Create a new brownfield migration. POSTs to /party/projects with
 * the brownfield body shape (the route auto-creates the Apps row +
 * Secrets Manager secret + party-projects row + enqueues bootstrap).
 *
 * On success: invalidates the migrations list AND the apps list (since
 * the wizard auto-creates an Apps registry row).
 */
export function useCreateMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateMigrationInput) =>
      api.post<CreateMigrationResponse>('/party/projects', {
        kind: 'brownfield',
        name: input.name,
        gitRepoUrl: input.gitRepoUrl,
        gitBranch: input.gitBranch || 'main',
        ...(input.pat ? { pat: input.pat } : {}),
        ...(input.envVars && Object.keys(input.envVars).length > 0
          ? { envVars: input.envVars }
          : {}),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['migrations'] });
      qc.invalidateQueries({ queryKey: ['apps'] });
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    },
  });
}

/** PATCH /api/migrations/:id — rotate PAT and/or update env vars. */
export function useUpdateMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, ...input }: UpdateMigrationInput & { projectId: string }) =>
      api.patch<UpdateMigrationResponse>(`/migrations/${encodeURIComponent(projectId)}`, input),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['migrations'] });
    },
  });
}

/** DELETE /api/migrations/:id — full teardown (rows + secret schedule). */
export function useDeleteMigration() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api.delete<DeleteMigrationResponse>(`/migrations/${encodeURIComponent(projectId)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['migrations'] });
      qc.invalidateQueries({ queryKey: ['apps'] });
      qc.invalidateQueries({ queryKey: ['party', 'projects'] });
    },
  });
}
