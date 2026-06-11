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
 */

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
      escalations.push({ ownerId, handoffs });
      continue;
    }
    const owner = stories.find((s) => s.storyId === ownerId);
    const suspected = [...new Set(handoffs.flatMap((h) => h.triage?.suspectedFiles || []))];
    const acList = handoffs.map((h) => h.acId).join(', ');
    minted.push({
      storyId: uuid(),
      order: stories.length + minted.length,
      wave: maxWave + 1,
      title: `Fix visual regression: ${acList} — ${(owner?.title || ownerId).slice(0, 80)}`,
      description: renderHandoffMarkdown({ handoffs, waveNumber }),
      status: 'pending',
      dependsOn: [ownerId],
      touchPoints: suspected.length > 0 ? suspected : owner?.touchPoints || [],
      criteria: handoffs.map((h) => ({ id: h.acId, text: h.acText, needsBrowser: true })),
      hasBrowserTests: true,
      origin: 'wave-vqa-fix',
      complexity: 'standard',
      reviewRigor: 'standard',
    });
  }
  return { minted, escalations };
}

/** The handoff packet rendered as the fix story's description (markdown). */
export function renderHandoffMarkdown({ handoffs, waveNumber }) {
  return [
    `Auto-minted by the wave ${waveNumber} VQA gate (fix-forward). A judge`,
    `panel confirmed the browser criteria below FAIL on the MERGED candidate;`,
    `the in-gate fixer could not clear them. Full handoff packets are also at`,
    '`.context/vqa-handoffs/<acId>.json` in the repo.',
    '',
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
