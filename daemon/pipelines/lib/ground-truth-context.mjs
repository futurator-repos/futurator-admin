/**
 * ground-truth-context.mjs — Story 4.4 live adapter.
 *
 * Owns the GraphStore lifecycle so the pure `assembleGroundTruth` core stays
 * store-free and unit-testable. Called from the context-pack resolver to append
 * a `<ground_truth>` blast-radius block to the assembled DEV prompt body.
 *
 * Strictly additive + non-blocking: any failure (cold graph, query error)
 * returns the body UNCHANGED — the AST facts already serialized into the body
 * are the fallback, so the story never fails for lack of structural context.
 * Bolt/Memgraph EXCISED (EU-migration S2.2) — the store runs from any fleet host.
 */

import { createGraphStore } from '../../scripts/lib/graph-store.mjs';
import { assembleGroundTruth } from '../../scripts/ground-truth-injection.mjs';

export async function appendGroundTruth(body, { touchPoints, projectId, storyId, log } = {}) {
  // Opt-in: only attempt a live graph query where the daemon has provisioned it
  // (MYCELIUM_GROUND_TRUTH=on). Off elsewhere (incl. unit tests) ⇒ no store read,
  // body unchanged. Mirrors the AST-facts injection's "degrade silently" contract.
  if (process.env.MYCELIUM_GROUND_TRUTH !== 'on') return body;
  if (!Array.isArray(touchPoints) || touchPoints.length === 0 || !projectId) return body;

  try {
    const store = await createGraphStore();
    const { block, source, reached } = await assembleGroundTruth(
      { touchPoints, projectId },
      {
        store,
        storyId,
        // The AST facts are already in `body`; the resolver's fallback is "add nothing".
        fallback: () => '',
        logger: (m) => log?.info?.(`ground-truth: ${m}`),
      },
    );
    await store.close?.();
    if (source === 'blast_radius' && block) {
      log?.info?.(`ground-truth: injected blast radius (${reached} nodes) for ${storyId ?? '?'}`);
      return `${body}\n\n${block}\n`;
    }
    return body;
  } catch (err) {
    log?.warn?.(`ground-truth: skipped (${err.message})`);
    return body;
  }
}
