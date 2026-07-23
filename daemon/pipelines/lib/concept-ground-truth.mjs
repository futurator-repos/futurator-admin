/**
 * Concept v2 (E2 / Story 2.5) — brownfield grounding for arch-gen.
 *
 * For a `kind === 'change'` plan, the Architect must build on what ALREADY
 * exists, not invent a greenfield design. This module pulls the real structural
 * facts (data stores, lambdas/functions, API endpoints, key files) from the
 * project's Mycelium system graph and formats them as a `<ground_truth>` block
 * the daemon injects into the arch-gen prompt (the same daemon-side substitution
 * seam Story 3.2a uses for `{{PRIOR_ARTIFACTS}}`).
 *
 * Greenfield plans run COLD: an empty graph yields an empty block, and the
 * arch-gen prompt simply omits the section. Ground truth is additive context
 * ONLY — a missing/empty graph never blocks generation.
 *
 * The block is marked graph-sourced (provenance) and the arch prompt (Story 2.3)
 * forbids contradicting it.
 */

// Map a graph node `kind` → the ground-truth category it belongs to. Kinds not
// listed here (e.g. generic 'function'/'class' interior to files) are omitted to
// keep the block to the load-bearing structural surface.
const KIND_TO_CATEGORY = {
  table: 'tables',
  dynamodb: 'tables',
  datastore: 'tables',
  bucket: 'tables',
  lambda: 'lambdas',
  function: 'lambdas',
  service: 'lambdas',
  endpoint: 'endpoints',
  route: 'endpoints',
  api: 'endpoints',
  file: 'files',
};

const CATEGORY_LABELS = [
  ['tables', 'Data stores'],
  ['lambdas', 'Lambdas / services'],
  ['endpoints', 'API endpoints / routes'],
  ['files', 'Key files'],
];

/**
 * Pure formatter: bucketed facts → a `<ground_truth>` markdown block, or '' when
 * every bucket is empty (greenfield → cold run).
 *
 * @param {{ tables?: string[], lambdas?: string[], endpoints?: string[], files?: string[] }} facts
 * @returns {string}
 */
export function formatGroundTruth(facts) {
  const f = facts || {};
  const lines = [];
  for (const [key, label] of CATEGORY_LABELS) {
    const items = Array.isArray(f[key]) ? f[key].filter(Boolean) : [];
    if (items.length === 0) continue;
    lines.push(`### ${label}`);
    for (const it of items) lines.push(`- ${it}`);
    lines.push('');
  }
  if (lines.length === 0) return ''; // greenfield / empty graph → no block
  return [
    '<ground_truth source="system-graph">',
    'These already exist in the system. Do NOT contradict, rename, or duplicate',
    'them — design the change to build on what is here.',
    '',
    ...lines,
    '</ground_truth>',
  ]
    .join('\n')
    .trimEnd();
}

/**
 * Bucket a flat list of `{kind,title}` graph nodes into ground-truth categories,
 * de-duplicated and capped per category.
 *
 * @param {Array<{kind?: string, title?: string, id?: string}>} nodes
 * @param {{ perCategory?: number }} [opts]
 */
export function bucketNodes(nodes, opts = {}) {
  const perCategory = opts.perCategory || 25;
  const buckets = { tables: [], lambdas: [], endpoints: [], files: [] };
  const seen = { tables: new Set(), lambdas: new Set(), endpoints: new Set(), files: new Set() };
  for (const n of nodes || []) {
    const cat = KIND_TO_CATEGORY[(n.kind || '').toLowerCase()];
    if (!cat) continue;
    const label = n.title || n.id;
    if (!label || seen[cat].has(label)) continue;
    if (buckets[cat].length >= perCategory) continue;
    seen[cat].add(label);
    buckets[cat].push(label);
  }
  return buckets;
}

/**
 * Daemon-side collector: read the project's structural nodes from the graph
 * store and return the formatted `<ground_truth>` block. Returns '' on any
 * failure or an empty graph (never throws — grounding is additive). Requires a
 * GraphStore instance (bolt EXCISED, EU-migration S2.2).
 *
 * @param {object} store - GraphStore instance
 * @param {{ projectId: string, perCategory?: number }} args
 * @returns {Promise<string>}
 */
export async function collectGroundTruth(store, { projectId, perCategory = 25 }) {
  if (!store || !projectId) return '';
  try {
    const nodes = (await store.listNodes(projectId))
      .filter((n) => (n.status ?? 'active') !== 'pruned')
      .map((n) => ({ kind: n.kind ?? 'file', title: n.title ?? n.nodeId }))
      .sort((a, b) => a.kind.localeCompare(b.kind) || String(a.title).localeCompare(String(b.title)));
    return formatGroundTruth(bucketNodes(nodes, { perCategory }));
  } catch {
    // Graph unavailable / cold → run greenfield. Never block arch-gen.
    return '';
  }
}
