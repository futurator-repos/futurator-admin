// instinct-promote — graduate high-confidence instincts to Mycelium nodes
// (development-plan §5.5, Pillar 3).
//
// This is how the reflector loop closes WITHOUT the IAM block: instead of an LLM
// writing privileged CLAUDE.md/skill files, a high-confidence instinct is written
// as a Mycelium `Instinct` graph node (a graph write needs no repo privilege),
// with DERIVED_FROM / CONSTRAINS edges. From there the injector re-reads it as
// spawn context. Promotion also escalates enforcement advisory → gate → test.

const PROMOTE_CONFIDENCE = 0.6;
const GATE_CONFIDENCE = 0.8;

/** Which instincts are ready to promote, and at what enforcement level. PURE. */
export function selectPromotable(instincts = [], { promoteAt = PROMOTE_CONFIDENCE, gateAt = GATE_CONFIDENCE } = {}) {
  return instincts
    .filter((i) => i.status !== 'promoted' && i.confidence >= promoteAt)
    .map((i) => ({
      ...i,
      // Escalate enforcement with confidence: high → gate (live deny delta),
      // otherwise stay advisory (prompt nudge). 'test' is operator-driven only.
      enforcement: i.confidence >= gateAt && i.enforcement !== 'test' ? 'gate' : i.enforcement,
      status: 'promoted',
    }));
}

/** Shape a promoted instinct as a Mycelium Instinct node + edges. PURE. */
export function toMyceliumNode(instinct) {
  return {
    type: 'Instinct',
    id: instinct.id,
    properties: {
      text: instinct.text,
      role: instinct.role,
      touchesGlob: instinct.touchesGlob,
      enforcement: instinct.enforcement,
      confidence: instinct.confidence,
      support: instinct.support,
    },
    edges: [
      { kind: 'DERIVED_FROM', to: instinct.sample?.session || 'observations' },
      ...(instinct.touchesGlob && instinct.touchesGlob !== '*'
        ? [{ kind: 'CONSTRAINS', to: instinct.touchesGlob }]
        : []),
    ],
  };
}

/**
 * Promote eligible instincts via an injected graph writer (graph-sync /
 * propagator-ingest). Returns the promoted instincts. Best-effort per node — a
 * single write failure doesn't abort the batch.
 *
 * @param {{ instincts:object[], writeNode:(node)=>Promise<void>, log?:Function }} args
 */
export async function promoteInstincts({ instincts = [], writeNode, log = () => {}, promoteAt, gateAt }) {
  const promotable = selectPromotable(instincts, { promoteAt, gateAt });
  const promoted = [];
  for (const inst of promotable) {
    try {
      if (writeNode) await writeNode(toMyceliumNode(inst));
      promoted.push(inst);
    } catch (err) {
      log('warn', `[instinct-promote] failed to write ${inst.id}: ${err?.message || err}`);
    }
  }
  return promoted;
}
