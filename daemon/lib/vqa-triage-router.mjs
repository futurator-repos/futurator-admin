/**
 * vqa-triage-router.mjs — FL-1 (agentic-l2-autonomy-backlog §5).
 *
 * Deterministic routing for a confirmed VQA failure → a DISTINCT fix action +
 * operator-facing copy, instead of one generic "send back to dev". Two signals:
 *
 *   1. the structural verdict prefix in the failure rationale, when present —
 *      the plan-QA deterministic gates (`SEAM_NEVER_PUBLISHED`, `SEAM_ABSENT`,
 *      `CONTRACT_INCOMPLETE`, `FLOW_NOOP`). These pin the exact remedy.
 *   2. otherwise the wave-gate LLM triage class (`code-bug` | `environment` |
 *      `ac-wording`) — the existing behavior, preserved as the fallback.
 *
 * Pure — no I/O. Consumed by the wave-gate fix-story mint (`wave-vqa-fix-story`)
 * to set per-class title/route, and by the operator claims surface for copy.
 */

/** Route a failure resolves to — what *kind* of work clears it. */
export const VQA_ROUTE = Object.freeze({
  DEV_BUILD: 'dev-build', // the feature/seam isn't built → build it
  DEV_FIX: 'dev-fix', // a code bug in a built feature → fix it
  REAUTHOR: 'reauthor-probe', // the probe (selector/key/flow) is wrong → re-author
  ENVIRONMENT: 'environment', // cache/boot damage → reboot + re-run
  OPERATOR: 'operator', // not machine-actionable → operator decides
});

// Title priority when one fix story bundles several failures: a missing
// feature/seam dominates a probe re-author dominates a code fix.
const ROUTE_PRIORITY = [
  VQA_ROUTE.DEV_BUILD,
  VQA_ROUTE.REAUTHOR,
  VQA_ROUTE.DEV_FIX,
  VQA_ROUTE.ENVIRONMENT,
  VQA_ROUTE.OPERATOR,
];

const STRUCTURAL = [
  {
    re: /\bSEAM_NEVER_PUBLISHED\b/,
    routeClass: 'seam-not-mounted',
    route: VQA_ROUTE.DEV_BUILD,
    autoMint: true,
    title: 'Build the feature — the verifiability seam never publishes',
    guidance:
      'No source file imports the seam hook, so window.__harness can never publish: the app is a static preview, not the live feature. Mount the real feature that calls the seam hook.',
  },
  {
    re: /\bSEAM_ABSENT\b/,
    routeClass: 'seam-not-ready',
    route: VQA_ROUTE.DEV_BUILD,
    autoMint: true,
    title: 'Wire the feature to the seam (it never became ready)',
    guidance:
      'A seam-asserting probe ran but window.__harness never became ready. Wire the feature to publish the seam (call the seam hook, run the loop/input).',
  },
  {
    re: /\bCONTRACT_INCOMPLETE\b/,
    routeClass: 'no-probe',
    route: VQA_ROUTE.DEV_BUILD,
    autoMint: true,
    title: 'Build the interactive feature (no executable probe)',
    guidance:
      'The L2 test had no executable flow — either the interactive feature is not built, or the AC observable could not be compiled to a seam assertion. Build the feature, or reword the AC observable to name a published state.',
  },
  {
    re: /\bFLOW_NOOP\b/,
    routeClass: 'flow-noop',
    route: VQA_ROUTE.REAUTHOR,
    autoMint: true,
    title: 'Fix the interaction — the probe had no visible effect',
    guidance:
      'The probe ran but the post-interaction frame was byte-identical to idle: the selector/key was wrong or the feature did not respond. Fix the interaction wiring (or the probe).',
  },
];

const BY_CLASS = {
  'code-bug': {
    routeClass: 'code-bug',
    route: VQA_ROUTE.DEV_FIX,
    autoMint: true,
    title: 'Fix visual regression',
    guidance: 'A judge panel confirmed the criterion FAILS on the merged candidate. Fix the code.',
  },
  environment: {
    routeClass: 'environment',
    route: VQA_ROUTE.ENVIRONMENT,
    autoMint: false,
    title: 'Environment issue — reboot and re-run',
    guidance: 'The failure looked environmental (cache/boot). Re-run after a clean reboot.',
  },
  'ac-wording': {
    routeClass: 'ac-wording',
    route: VQA_ROUTE.OPERATOR,
    autoMint: false,
    title: 'Criterion not verifiable as worded',
    guidance:
      'The criterion could not be verified as worded — there is no machine-checkable observable. Operator: reword the AC or accept it.',
  },
};

/**
 * Route ONE failure. `rationale` is the failure text (the plan-QA verdict
 * rationale, or the concatenated wave-gate FAIL observations); `classification`
 * is the wave-gate LLM triage class. Structural prefix wins; class is fallback.
 * Returns { routeClass, route, autoMint, title, guidance }.
 */
export function routeVqaFailure({ classification, rationale } = {}) {
  const text = String(rationale || '');
  for (const s of STRUCTURAL) {
    if (s.re.test(text)) return { ...s };
  }
  return { ...(BY_CLASS[classification] || BY_CLASS['code-bug']) };
}

/**
 * Reduce several routed failures (one owner's bundle) to the dominant route for
 * the fix-story framing. `autoMint` is true iff AT LEAST ONE failure is
 * machine-actionable (a bundle of only operator/environment items is escalated,
 * not minted as a dev story).
 */
export function summarizeRoutes(routes) {
  const list = routes.filter(Boolean);
  if (list.length === 0) return { ...BY_CLASS['code-bug'] };
  for (const route of ROUTE_PRIORITY) {
    const hit = list.find((r) => r.route === route);
    if (hit) {
      return { ...hit, autoMint: list.some((r) => r.autoMint) };
    }
  }
  return { ...list[0], autoMint: list.some((r) => r.autoMint) };
}
