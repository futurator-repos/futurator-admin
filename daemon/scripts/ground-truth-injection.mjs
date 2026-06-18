/**
 * ground-truth-injection.mjs — Story 4.4 (PRD §5.6).
 *
 * Before a DEV agent edits a story's `touchPoints`, the context-assembly step
 * calls `blast_radius(touchPoints)` and injects the grouped result as a
 * `<ground_truth>` block — extending the existing AST-facts injection so the
 * agent edits with structural awareness and stops breaking unseen dependents
 * (incl. the W5 async event chains).
 *
 * This is ADDITIVE context, not a new gate. On a cold Memgraph (no session, or
 * the query throws) it degrades to the caller-supplied `fallback` (the existing
 * ast-extract facts + grep) and NEVER fails the story.
 *
 * Pure formatting + a thin async orchestrator, both unit-tested with a fake
 * session — the live wiring imports `blastRadius` + a real Bolt session.
 */

import { blastRadius } from '../mcp/mycelium-mcp.mjs';

/** Wiki nodeId convention: `src/components/auth.tsx` → `code/src--components--auth.tsx`. */
export function touchPointToNodeId(relPath) {
  return `code/${String(relPath).replace(/^\.?\//, '').replace(/\//g, '--')}`;
}

/**
 * Render a blast_radius result as a `<ground_truth>` block. Groups are listed
 * largest-impact-first (table/lambda/endpoint/event before plain files), each
 * node as `kind: title`. A paid-service touch is called out explicitly.
 *
 * @returns {string} the block, or '' when nothing is reached.
 */
export function buildGroundTruthBlock(blast) {
  const groups = blast?.groups ?? {};
  const kinds = Object.keys(groups).sort(
    (a, b) => (KIND_ORDER[a] ?? 99) - (KIND_ORDER[b] ?? 99) || a.localeCompare(b),
  );
  if (kinds.length === 0) return '';

  const lines = ['<ground_truth>'];
  lines.push(
    `Blast radius for the files you are about to edit — everything reachable in ≤2 hops`,
    `across code + infra + services (including async event/cron chains). Do not break these:`,
    '',
  );
  for (const kind of kinds) {
    const items = groups[kind];
    lines.push(`${kind} (${items.length}):`);
    for (const it of items) lines.push(`  - ${it.title || it.id}`);
  }
  if (blast.touchesPaidService) {
    lines.push('', '⚠ This change reaches a PAID external service — verify cost/quota impact.');
  }
  lines.push('</ground_truth>');
  return lines.join('\n');
}

const KIND_ORDER = {
  table: 0,
  lambda: 1,
  endpoint: 2,
  eventSource: 3,
  topic: 4,
  queue: 5,
  externalService: 6,
  bucket: 7,
  function: 8,
  file: 9,
};

/**
 * Assemble the `<ground_truth>` block for a story's touch points.
 *
 * @param {object} args
 * @param {string[]} args.touchPoints - story touch-point file paths (or nodeIds).
 * @param {string} args.projectId
 * @param {object} [ctx]
 * @param {object} [ctx.session] - live Bolt session; null/absent ⇒ cold Memgraph.
 * @param {() => (string|Promise<string>)} [ctx.fallback] - existing ast+grep facts.
 * @param {(msg:string)=>void} [ctx.logger]
 * @returns {Promise<{block:string, source:'blast_radius'|'fallback', reached:number}>}
 */
export async function assembleGroundTruth({ touchPoints, projectId }, ctx = {}) {
  const fallbackBlock = async (reason) => {
    ctx.logger?.(`ground-truth: falling back to ast+grep (${reason})`);
    const fb = ctx.fallback ? await ctx.fallback() : '';
    return { block: fb || '', source: 'fallback', reached: 0 };
  };

  if (!ctx.session) return fallbackBlock('no Memgraph session');
  const fileIds = (touchPoints ?? []).map((tp) =>
    tp.startsWith('code/') ? tp : touchPointToNodeId(tp),
  );
  if (fileIds.length === 0) return fallbackBlock('no touch points');

  try {
    const blast = await blastRadius(ctx.session, { files: fileIds, projectId });
    if (!blast || blast.totalReached === 0) {
      // Nothing connected (new files, or cold/empty graph) → keep ast+grep facts.
      return fallbackBlock('empty blast radius');
    }
    return { block: buildGroundTruthBlock(blast), source: 'blast_radius', reached: blast.totalReached };
  } catch (err) {
    return fallbackBlock(err.message);
  }
}
