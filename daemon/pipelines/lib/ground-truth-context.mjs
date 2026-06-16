/**
 * ground-truth-context.mjs — Story 4.4 live adapter.
 *
 * Owns the Bolt session lifecycle so the pure `assembleGroundTruth` core stays
 * Memgraph-free and unit-testable. Called from the context-pack resolver to
 * append a `<ground_truth>` blast-radius block to the assembled DEV prompt body.
 *
 * Strictly additive + non-blocking: any failure (no Memgraph, cold graph, query
 * error) returns the body UNCHANGED — the AST facts already serialized into the
 * body are the fallback, so the story never fails for lack of structural context.
 */

import { createDriver } from '../../scripts/lib/memgraph-driver.mjs';
import { assembleGroundTruth } from '../../scripts/ground-truth-injection.mjs';

export async function appendGroundTruth(body, { touchPoints, projectId, storyId, log } = {}) {
  // Opt-in: only attempt a live Memgraph query where the daemon has provisioned
  // it (MYCELIUM_GROUND_TRUTH=on). Off elsewhere (incl. unit tests) ⇒ no Bolt
  // connection attempt, body unchanged. Mirrors the AST-facts injection's
  // "degrade silently" contract.
  if (process.env.MYCELIUM_GROUND_TRUTH !== 'on') return body;
  if (!Array.isArray(touchPoints) || touchPoints.length === 0 || !projectId) return body;

  let driver;
  let session;
  try {
    driver = createDriver();
    session = driver.session();
    const { block, source, reached } = await assembleGroundTruth(
      { touchPoints, projectId },
      {
        session,
        storyId,
        // The AST facts are already in `body`; the resolver's fallback is "add nothing".
        fallback: () => '',
        logger: (m) => log?.info?.(`ground-truth: ${m}`),
      },
    );
    if (source === 'blast_radius' && block) {
      log?.info?.(`ground-truth: injected blast radius (${reached} nodes) for ${storyId ?? '?'}`);
      return `${body}\n\n${block}\n`;
    }
    return body;
  } catch (err) {
    log?.warn?.(`ground-truth: skipped (${err.message})`);
    return body;
  } finally {
    try {
      await session?.close();
      await driver?.close();
    } catch {
      /* ignore */
    }
  }
}
