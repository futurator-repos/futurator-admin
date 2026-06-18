/**
 * doc-references.mjs — turn [[wikilinks]] in knowledge articles into graph edges.
 *
 * Two layers:
 *   1. Structured edges — a link under a known section header (## Dependencies,
 *      ## Informs, …) becomes a typed edge (DEPENDS_ON, INFORMS, …).
 *   2. Inline REFERENCES — for LIVING documents only, any other [[link]] (in
 *      prose sections like ## Implementation, or under an H1 like # Code
 *      Articles) becomes a generic REFERENCES edge. This is what connects
 *      architecture / decision / index docs — which describe the code but carry
 *      no structured dependency section — into the graph instead of floating.
 *
 * "Controlled" by construction: the caller MERGEs each edge with
 *   MATCH (a {nodeId}), (b {nodeId}) MERGE (a)-[:TYPE]->(b)
 * so an edge only ever exists when BOTH the doc AND the referenced node exist.
 * Aspirational / `(suggested)` / typo links resolve to nothing — no phantom
 * edges. A doc is connected only when it actually refers to a real node.
 *
 * Plan-scoped documents (a specific plan's PRD, its epics/stories) are EXCLUDED
 * from inline REFERENCES — those are wired separately/later. They still get
 * their structured-section edges (layer 1) unchanged.
 */

/** Section header (lower-cased) → typed edge. Mirrors the article generators. */
export const SECTION_EDGE_MAP = {
  dependencies: { type: 'DEPENDS_ON', direction: 'outgoing', weight: 1.0 },
  dependents: { type: 'DEPENDS_ON', direction: 'incoming', weight: 1.0 },
  'derived from': { type: 'DERIVED_FROM', direction: 'outgoing', weight: 0.7 },
  informs: { type: 'INFORMS', direction: 'outgoing', weight: 0.3 },
  refines: { type: 'REFINES', direction: 'outgoing', weight: 0.5 },
  validates: { type: 'VALIDATES', direction: 'outgoing', weight: 0.6 },
  supersedes: { type: 'SUPERSEDES', direction: 'outgoing', weight: 0.8 },
  'conflicts with': { type: 'CONFLICTS_WITH', direction: 'bidirectional', weight: 0.9 },
  enables: { type: 'ENABLES', direction: 'outgoing', weight: 0.5 },
};

/** The generic edge emitted for an inline reference in a living document. */
export const REFERENCE_EDGE = { type: 'REFERENCES', direction: 'outgoing', weight: 0.2 };

/**
 * Document `type:` values that belong to a single plan run — ephemeral, plan-
 * scoped specs. Excluded from inline REFERENCES auto-linking; the operator wires
 * these deliberately later.
 */
export const PLAN_SCOPED_TYPES = new Set([
  'prd',
  'epic',
  'epics',
  'story',
  'stories',
  'requirement',
  'requirements',
  'spec',
  'tech-spec',
  'plan',
  'brief',
  'project-brief',
  'workflow',
]);

/**
 * Is this an "alive" document (architecture, component, decision, system,
 * index, …) that should be connected to the nodes it references — as opposed to
 * a plan-run document we leave out for now?
 *
 * Living unless: its type is plan-scoped, it carries an explicit plan marker, or
 * it lives under a plan/prd/epic/story path.
 */
export function isLivingDoc(frontmatter = {}, nodeId = '') {
  const type = String(frontmatter.type || '')
    .trim()
    .toLowerCase();
  if (PLAN_SCOPED_TYPES.has(type)) return false;
  if (frontmatter.planId || frontmatter.plan_id) return false;
  if (String(frontmatter.scope || '').toLowerCase() === 'plan') return false;
  if (/(^|\/)(plans?|prds?|epics?|stories|requirements?)(\/|$)/i.test(String(nodeId))) {
    return false;
  }
  return true;
}

/** Normalize a raw [[target|alias]] payload to a bare nodeId, or '' to skip. */
function cleanTarget(raw) {
  // alias syntax [[id|label]] → id; strip surrounding whitespace.
  const id = String(raw).split('|')[0].trim();
  return id;
}

/**
 * Extract graph edges from an article body's [[wikilinks]].
 *
 * @param {string} body                 markdown body (frontmatter already stripped)
 * @param {{ inlineRefs?: boolean }} opts  inlineRefs=true emits REFERENCES for
 *                                         links outside a structured section
 *                                         (set this only for living docs).
 * @returns {Array<{type,direction,weight,target}>}
 */
export function extractWikilinks(body, { inlineRefs = false } = {}) {
  const edges = [];
  let currentSection = null;

  for (const line of String(body).split('\n')) {
    // Only H2 headers define a structured section (matches the generators).
    const headerMatch = line.match(/^##\s+(.+)$/);
    if (headerMatch) {
      currentSection = headerMatch[1].trim().toLowerCase();
      continue;
    }

    const linkRegex = /\[\[([^\]]+)\]\]/g;
    let m;
    while ((m = linkRegex.exec(line)) !== null) {
      const target = cleanTarget(m[1]);
      if (!target) continue;

      const mapped = currentSection ? SECTION_EDGE_MAP[currentSection] : null;
      if (mapped) {
        edges.push({ ...mapped, target });
      } else if (inlineRefs) {
        edges.push({ ...REFERENCE_EDGE, target });
      }
    }
  }

  return dedupe(edges);
}

/**
 * Drop duplicate edges, and never emit a REFERENCES edge to a target that
 * already has a stronger structured edge in the same doc (DEPENDS_ON wins over a
 * prose mention of the same node).
 */
function dedupe(edges) {
  const typedTargets = new Set(
    edges.filter((e) => e.type !== 'REFERENCES').map((e) => e.target),
  );
  const seen = new Set();
  const out = [];
  for (const e of edges) {
    if (e.type === 'REFERENCES' && typedTargets.has(e.target)) continue;
    const key = `${e.type}:${e.direction}:${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}
