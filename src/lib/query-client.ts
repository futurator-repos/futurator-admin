import { QueryClient } from '@tanstack/react-query';
import { STALE_TIME } from './constants';

export function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME,
        retry: 1,
        refetchOnWindowFocus: false,
      },
    },
  });
}
