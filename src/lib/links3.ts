/**
 * Labs3 — centralized link builders (Story U1).
 *
 * Mirrors `src/lib/links.ts`'s role for legacy Labs. Every Link / router.push
 * / window.location reference into the Labs3 area SHOULD go through these
 * helpers instead of hand-building `/labs3?...` strings inline.
 *
 * Static-export friendly: app/plan identity is always a query param, never a
 * dynamic path segment. Trailing slash before the query string matches the
 * existing inline hrefs across labs3 (`/labs3/?planId=...`).
 */

export const links3 = {
  home: () => '/labs3',
  app: (appId: string) => `/labs3/?appId=${encodeURIComponent(appId)}`,
  plan: (planId: string, subtab?: string) => {
    const params = new URLSearchParams({ planId });
    if (subtab) params.set('subtab', subtab);
    return `/labs3/?${params.toString()}`;
  },
};
