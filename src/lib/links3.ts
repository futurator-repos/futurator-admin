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

/**
 * Stage-first deep link options. `stage` selects the lifecycle panel; `subtab`
 * selects the surface within it. Both are optional and deep-linkable.
 * A bare string is accepted for back-compat (treated as `subtab`).
 */
export interface Labs3PlanLinkOpts {
  stage?: string;
  subtab?: string;
}

export const links3 = {
  home: () => '/labs3',
  app: (appId: string) => `/labs3/?appId=${encodeURIComponent(appId)}`,
  plan: (planId: string, opts?: Labs3PlanLinkOpts | string) => {
    const params = new URLSearchParams({ planId });
    const o: Labs3PlanLinkOpts = typeof opts === 'string' ? { subtab: opts } : (opts ?? {});
    if (o.stage) params.set('stage', o.stage);
    if (o.subtab) params.set('subtab', o.subtab);
    return `/labs3/?${params.toString()}`;
  },
};
