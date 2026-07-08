// p3-lifecycle — the Pipeline-3 plan status machine + dev-deploy identity.
//
// QA-Review W1. Legacy's plan lifecycle lives in the epic-shaped `reducePlan`
// (functions/shared/services/plan-reducer.ts), which P3 plans (no epics) never
// enter — so a finished P3 plan stays `status:'concept'` forever and never
// reaches QA/deploy. These PURE helpers are the P3-native replacement for the
// three transitions we actually need; the daemon applies them behind
// P3_LIFECYCLE, and the cron reuses `isP3Plan`/`p3DevDeployIdentity` to build a
// plan-keyed dev deploy (no epic resolution).
//
// The full PlanStatus enum (functions/shared/types/plan.ts):
//   concept → developing → review → delivered   (+ fixing recoverable)

/** Statuses from which "every story done" should advance to review. */
const REVIEW_FROM = new Set(['concept', 'developing', 'fixing']);

/**
 * A P3 (pipeline-3 / quick-flow) plan: no epics, but an app slug. Legacy plans
 * always carry a non-empty `epicIds`. PURE.
 */
export function isP3Plan(plan) {
  if (!plan) return false;
  const hasEpics = Array.isArray(plan.epicIds) && plan.epicIds.length > 0;
  return !hasEpics && Boolean(plan.appId);
}

/**
 * The dev-deploy identity for a P3 plan. F29 keys the dev preview on the CLEAN
 * app slug (dev.futurator.ai/<appId>/), and the buildable worktree lives at
 * `<projectsRoot>/<appId>` on the EC2 box. PURE.
 * @returns {{ planSlug:string, appId:string, workingDir:string } | null}
 */
export function p3DevDeployIdentity(plan, projectsRoot = '/home/ubuntu/projects') {
  if (!isP3Plan(plan)) return null;
  const appId = plan.appId;
  return { planSlug: appId, appId, workingDir: `${projectsRoot}/${appId}` };
}

/**
 * Next status when the first story dispatches. concept→developing; otherwise a
 * no-op (returns null — caller writes nothing). PURE + idempotent by design.
 */
export function nextStatusOnDispatch(current) {
  return current === 'concept' ? 'developing' : null;
}

/**
 * Next status when EVERY story in the plan is done. Advances to review from any
 * pre-review state; null (no-op) if already review/delivered/archived. PURE.
 */
export function nextStatusOnAllDone(current) {
  return REVIEW_FROM.has(current) ? 'review' : null;
}

/**
 * True iff EVERY story node is TERMINAL — `done` OR `failed` — meaning there is
 * no more dev work possible and the plan should advance to `review` (where the
 * deployed-app QA + operator are the real gate). `justResolvedStoryId` counts as
 * terminal regardless of GSI propagation lag (its done/failed write may not be
 * visible on the eventually-consistent index yet).
 *
 * pacman4 forensic (2026-07-06): using an all-`done` predicate wedged a plan
 * with a single terminally-`failed` fix-story in `fixing` FOREVER — QA never got
 * to judge. PURE.
 *
 * @param {Array<{ state?: string, storyId?: string }>} nodes
 * @param {string} [justResolvedStoryId]
 */
export function allStoriesResolved(nodes, justResolvedStoryId) {
  if (!Array.isArray(nodes) || nodes.length === 0) return false;
  return nodes.every(
    (n) =>
      n?.state === 'done' ||
      n?.state === 'failed' ||
      (justResolvedStoryId != null && n?.storyId === justResolvedStoryId),
  );
}

/**
 * Reality-Spine P3 (redesign Part 2 P3, Part 3 #2) — is the INTEGRATE-RUN
 * satisfied for the CURRENT app-tree head? The Integrator's whole-tree green
 * pass stamps `plan.integrateVerifiedSha` = the SHA it committed; a plan may
 * only advance from all-stories-terminal to `review` once that stamp EXISTS and
 * still PINS the live head. A later fix-story commit moves the head, so the
 * stamp no longer matches → a fresh Integrator round is forced before review is
 * reachable again. This is the same SHA-pinned readiness discipline as
 * `qaVerifiedAt`, applied one stage earlier. PURE.
 *
 * @param {{ integrateVerifiedSha?: string, headSha?: string }} args
 * @returns {boolean}
 */
export function integrateSatisfied({ integrateVerifiedSha, headSha } = {}) {
  return Boolean(integrateVerifiedSha) && integrateVerifiedSha === headSha;
}
