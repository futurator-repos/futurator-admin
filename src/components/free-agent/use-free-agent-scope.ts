/**
 * use-free-agent-scope.ts — Story 18.4 (Epic 18: Free Claude Code Agent)
 *
 * Derives the widget's "lens" scope from the current Next.js route and keeps
 * the free-agent store in sync as the operator navigates.
 *
 * Rules (matches Story 18.4 AC #4):
 *   - /labs/projects/:id or /labs/party/:id → { kind: 'project', id }
 *   - /labs/plans/:id                       → { kind: 'plan', id }
 *   - /labs   with ?appId=…                 → { kind: 'app', id }    (prefer app over plan when both present)
 *   - /labs   with ?planId=…                → { kind: 'plan', id }
 *   - /apps/:id                             → { kind: 'app', id }
 *   - anything else                         → { kind: 'workspace' }
 *
 * Why app-over-plan precedence on /labs: the daemon needs a real bare repo at
 * /home/ubuntu/repos/<projectId>.git to spawn a worktree. Apps have one (from
 * Pipeline v2 bootstrap); plans don't. When both appId and planId are in the
 * URL, the appId points at a real working tree.
 */

'use client';

import { useEffect, useMemo } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { useFreeAgentStore, type FreeAgentScope } from '@/stores/free-agent-store';

export function deriveScope(pathname: string, searchParams: URLSearchParams): FreeAgentScope {
  // Strip trailing slash for stable matching against trailingSlash: true exports.
  const path = pathname.replace(/\/$/, '');

  // /labs/projects/:id
  const projectMatch =
    path.match(/^\/labs\/projects\/([^/]+)/) || path.match(/^\/labs\/party\/([^/]+)/);
  if (projectMatch) return { kind: 'project', id: projectMatch[1] };

  // /labs/plans/:id
  const planRouteMatch = path.match(/^\/labs\/plans\/([^/]+)/);
  if (planRouteMatch) return { kind: 'plan', id: planRouteMatch[1] };

  // /labs?appId=…  (preferred over planId — apps have real bare repos)
  const appQuery = searchParams.get('appId');
  if ((path === '/labs' || path === '') && appQuery) {
    return { kind: 'app', id: appQuery };
  }

  // /labs?planId=…  (the current Labs UI uses query params for plan selection)
  const planQuery = searchParams.get('planId');
  if ((path === '/labs' || path === '') && planQuery) {
    return { kind: 'plan', id: planQuery };
  }

  // /apps/:id
  const appMatch = path.match(/^\/apps\/([^/]+)/);
  if (appMatch) return { kind: 'app', id: appMatch[1] };

  return { kind: 'workspace' };
}

/**
 * Subscribes to route changes and pushes the derived scope into the store.
 * Returns the current scope for direct read access too.
 */
export function useFreeAgentScope(): FreeAgentScope {
  const pathname = usePathname() ?? '';
  const searchParams = useSearchParams();

  const scope = useMemo(
    () => deriveScope(pathname, searchParams ?? new URLSearchParams()),
    [pathname, searchParams],
  );

  const setScope = useFreeAgentStore((s) => s.setScope);
  useEffect(() => {
    setScope(scope);
  }, [scope, setScope]);

  return scope;
}

/** Human-readable label for the panel header. */
export function formatScopeLabel(scope: FreeAgentScope): string {
  switch (scope.kind) {
    case 'project':
      return `Project: ${scope.id ?? '?'}`;
    case 'plan':
      return `Plan: ${scope.id ?? '?'}`;
    case 'app':
      return `App: ${scope.id ?? '?'}`;
    default:
      return 'Workspace';
  }
}
