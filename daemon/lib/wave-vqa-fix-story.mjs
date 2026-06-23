/**
 * wave-vqa-fix-story.mjs — v2.6 M5 (2026-06-11).
 *
 * Pure builder for the wave gate's fix-forward → auto-minted fix stories.
 * Each surviving judged failure becomes a NORMAL story in the epic's next
 * wave: dependsOn the owning story, description = the handoff packet, so
 * self-correction flows through the standard story pipeline with zero new
 * launch machinery (the wave-reducer launches wave N+1 when wave N
 * completes — pinned by wave-reducer.test.ts).
 *
 * Cap (decision, do not re-litigate): ONE auto-fix story per owning story
 * per plan. A recurrence becomes an `escalations` entry — the caller writes
 * a HIGH operator card instead of minting; that is the end of the
 * self-correction ladder.
 *
 * FL-1 (agentic-l2-autonomy-backlog §5) — routes the bundle through
 * `vqa-triage-router`: a SEAM_NEVER_PUBLISHED / SEAM_ABSENT / CONTRACT_INCOMPLETE
 * failure mints a "build the feature" story (not a generic "fix visual
 * regression"); a FLOW_NOOP a "fix the interaction" story; and a bundle that is
 * ONLY operator/environment is escalated to the operator instead of minted.
 * FL-2 — the minted criteria preserve the AC's `verify` + `thenObservable`
 * (+ given/when/then) so the fix story's QA re-run re-authors a DETERMINISTIC
 * probe (qa-author), closing the loop on a seam assert, not a vision re-judge.
 */
import { routeVqaFailure, summarizeRoutes } from './vqa-triage-router.mjs';

/**
 * @param {object} args
 * @param {Array} args.existingStories epic.stories at mint time
 * @param {Array} args.fixForward      handoff packets from the VQA runner
 * @param {number} args.waveNumber     the wave that just merged
 * @param {() => string} args.uuid     id factory (injected for tests)
 * @returns {{ minted: Array, escalations: Array<{ownerId: string, handoffs: Array}> }}
 */
export function buildVqaFixStories({ existingStories, fixForward, waveNumber, uuid }) {
  const stories = Array.isArray(existingStories) ? existingStories : [];
  const byOwner = new Map();
  for (const h of fixForward || []) {
    const arr = byOwner.get(h.storyId) || [];
    arr.push(h);
    byOwner.set(h.storyId, arr);
  }

  const maxWave = stories.reduce((m, s) => Math.max(m, s.wave ?? 0), 0);
  const minted = [];
  const escalations = [];

  for (const [ownerId, handoffs] of byOwner) {
    const alreadyTried = stories.some(
      (s) => s.origin === 'wave-vqa-fix' && (s.dependsOn || []).includes(ownerId),
    );
    if (alreadyTried) {
      escalations.push({ ownerId, handoffs, reason: 'recurrence' });
      continue;
    }
    const owner = stories.find((s) => s.storyId === ownerId);
    const suspected = [...new Set(handoffs.flatMap((h) => h.triage?.suspectedFiles || []))];
    const acList = handoffs.map((h) => h.acId).join(', ');

    // FL-1 — route each failure, then reduce to the bundle's dominant remedy.
    const routes = handoffs.map((h) =>
      routeVqaFailure({ classification: h.triage?.classification, rationale: h.observed }),
    );
    const route = summarizeRoutes(routes);
    // A bundle that is ONLY operator/environment is not a dev story — hand it to
    // the operator (a HIGH card) instead of minting work no dev agent can clear.
    if (!route.autoMint) {
      escalations.push({ ownerId, handoffs, route, reason: 'operator-route' });
      continue;
    }

    minted.push({
      storyId: uuid(),
      order: stories.length + minted.length,
      wave: maxWave + 1,
      title: `${route.title}: ${acList} — ${(owner?.title || ownerId).slice(0, 80)}`,
      description: renderHandoffMarkdown({ handoffs, waveNumber, route }),
      status: 'pending',
      dependsOn: [ownerId],
      touchPoints: suspected.length > 0 ? suspected : owner?.touchPoints || [],
      // FL-2 — carry the AC's verify intent + observable through so the fix
      // story's QA re-run re-authors a deterministic probe (qa-author) and the
      // loop exits on a seam assert, not a fresh vision judge.
      criteria: handoffs.map((h) => ({
        id: h.acId,
        text: h.acText,
        needsBrowser: true,
        ...(h.verify ? { verify: h.verify } : {}),
        ...(h.thenObservable ? { thenObservable: h.thenObservable } : {}),
        ...(h.given ? { given: h.given } : {}),
        ...(h.when ? { when: h.when } : {}),
        ...(h.then ? { then: h.then } : {}),
      })),
      hasBrowserTests: true,
      origin: 'wave-vqa-fix',
      // FL-1 — machine-readable route so the claims surface / fixer can branch.
      fixRoute: route.route,
      fixRouteClass: route.routeClass,
      // P3 (pong1 2026-06-12) — machine-readable provenance: the wave whose
      // VQA gate confirmed the failure. The daemon uses this to rebuild the
      // originating card's dedupKey (wave-vqa:<plan>:<epic>:<fixesWave>:
      // <ownerId>) and AUTO-RESOLVE it when this story's criteria pass a
      // later gate — closing the fix-forward loop end-to-end. (minted wave
      // is maxWave+1, NOT fixesWave+1, so this cannot be derived later.)
      fixesWave: waveNumber,
      complexity: 'standard',
      reviewRigor: 'standard',
    });
  }
  return { minted, escalations };
}

/** The handoff packet rendered as the fix story's description (markdown). */
export function renderHandoffMarkdown({ handoffs, waveNumber, route }) {
  return [
    `Auto-minted by the wave ${waveNumber} VQA gate (fix-forward). A judge`,
    `panel confirmed the browser criteria below FAIL on the MERGED candidate;`,
    `the in-gate fixer could not clear them. Full handoff packets are also at`,
    '`.context/vqa-handoffs/<acId>.json` in the repo.',
    '',
    // FL-1 — the routed remedy so the dev agent fixes the RIGHT layer.
    ...(route ? [`**Remedy (${route.route}):** ${route.guidance}`, ''] : []),
    ...handoffs.flatMap((h) =>
      [
        `## ${h.acId}: ${h.acText}`,
        `- Expected: ${h.expected}`,
        `- Observed: ${h.observed || '(see verdicts)'}`,
        `- Captured surface: ${h.evidence?.capturedSurface || '?'}`,
        h.evidence?.screenshotUrl ? `- Screenshot: ${h.evidence.screenshotUrl}` : null,
        h.triage?.summary ? `- Triage: ${h.triage.summary}` : null,
        h.triage?.suspectedFiles?.length
          ? `- Suspected files: ${h.triage.suspectedFiles.join(', ')}`
          : null,
        h.attempts?.length
          ? `- Prior fixer attempts: ${h.attempts.map((a) => `round ${a.round} → ${a.result}`).join('; ')}`
          : null,
        `- Verify: ${h.verifyCommand}`,
        '',
      ].filter(Boolean),
    ),
  ].join('\n');
}
