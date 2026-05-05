/**
 * App/Plan v1 — centralized link builders (Story 5.1).
 *
 * Every Link / router.push / window.location reference into the Labs area
 * MUST go through these helpers. One place to change when the URL shape
 * evolves (e.g., when GitHub integration in v2 introduces /branches/<ref>).
 */

export const links = {
  apps: () => '/labs',
  app: (appId: string) => `/labs?appId=${encodeURIComponent(appId)}`,
  plan: (appId: string, planId: string) =>
    `/labs?appId=${encodeURIComponent(appId)}&planId=${encodeURIComponent(planId)}`,
};
