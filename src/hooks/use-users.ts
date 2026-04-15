'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api-client';
import type { DirectoryUser } from '@/types/user';

export function useUsers(projectId?: string) {
  return useQuery({
    queryKey: ['users', projectId],
    queryFn: () => api.get<DirectoryUser[]>(projectId ? `/users?projectId=${projectId}` : '/users'),
  });
}
