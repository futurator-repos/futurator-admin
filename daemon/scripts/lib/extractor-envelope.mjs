/**
 * Extractor Envelope — shared scaffold for the system-graph extractors.
 * Story SG-1.1 (System Graph Foundation).
 *
 * The system-graph extractors (`infra-extract`, `route-extract`,
 * `service-extract`) are deterministic, zero-LLM siblings of `ast-extract.mjs`.
 * They all emit the SAME output envelope so `graph-sync` can ingest any of them
 * through one path (`upsertExtractedFacts`). This module is the single source of
 * truth for:
 *
 *   1. the envelope contract  (buildEnvelope / emptyEnvelope / writeEnvelope)
 *   2. the shared tree-sitter TypeScript loader + cursor walk (loadTsParser / walk)
 *
 * Envelope shape (node/edge-oriented — distinct from ast-extract's file-oriented
 * `{ files[] }`, but sharing the `generatedAt`/`root` preamble convention):
 *
 *   {
 *     generatedAt: "ISO-8601",
 *     root:        "/absolute/working/dir",
 *     nodeCount:   number,
 *     edgeCount:   number,
 *     nodes:  [{ nodeId, kind, label, ...props }],
 *     edges:  [{ type, source, target, ...props }],
 *     ambiguous: [{ ...reason }],   // never-guessed; Compiler labels later (INFERRED)
 *     ...extra                       // e.g. { config }, { app }, { envJoin }
 *   }
 *
 * Honesty discipline: every node/edge an extractor emits is EXTRACTED
 * (deterministic). Anything it cannot resolve goes to `ambiguous[]`, never
 * invented. graph-sync turns `ambiguous` into work for the Compiler, which is
 * the only thing allowed to write INFERRED facts.
 */

// ── Envelope contract ────────────────────────────────────────────────────

/**
 * Build the standard extractor output envelope.
 *
 * @param {object} p
 * @param {string} p.root        absolute working dir the extractor ran against
 * @param {Array}  [p.nodes]     node facts
 * @param {Array}  [p.edges]     edge facts
 * @param {Array}  [p.ambiguous] unresolved items (never guessed)
 * @param {object} [p.extra]     extractor-specific top-level fields (config/app/envJoin)
 * @returns {object} the envelope, with generatedAt + counts filled in
 */
export function buildEnvelope({ root, nodes = [], edges = [], ambiguous = [], extra = {} }) {
  return {
    generatedAt: new Date().toISOString(),
    root,
    nodeCount: nodes.length,
    edgeCount: edges.length,
    nodes,
    edges,
    ambiguous,
    ...extra,
  };
}

/**
 * An empty-but-valid envelope — used by an extractor's `main()` when its input
 * file is missing or tree-sitter is unavailable, so the pipeline step still
 * succeeds gracefully (exit 0, parseable JSON) the way ast-extract does.
 *
 * @param {object} p
 * @param {string} p.root
 * @param {object} [p.extra]  extra top-level fields (e.g. { config }, { skipped })
 */
export function emptyEnvelope({ root, extra = {} }) {
  return buildEnvelope({ root, nodes: [], edges: [], ambiguous: [], extra });
}

/** Write an envelope to stdout as pretty JSON + newline (matches ast-extract). */
export function writeEnvelope(doc) {
  process.stdout.write(JSON.stringify(doc, null, 2) + '\n');
}

// ── Shared tree-sitter setup (mirrors ast-extract.mjs) ─────────────────────

/**
 * Lazily import tree-sitter + the TypeScript grammar. Returns
 * `{ Parser, tsLang }` on success or `null` (with a stderr warning) when the
 * grammar isn't installed — callers should fall back to an empty envelope.
 *
 * Kept here so infra-extract and route-extract don't each re-implement the
 * dynamic-import dance. service-extract uses a regex scan and doesn't need it.
 */
export async function loadTsParser(label = 'extractor') {
  try {
    const Parser = (await import('tree-sitter')).default;
    const TS = (await import('tree-sitter-typescript')).default;
    const tsLang = TS.typescript;
    if (Parser && tsLang) return { Parser, tsLang };
    return null;
  } catch (err) {
    console.error(`[${label}] tree-sitter unavailable: ${err.message}`);
    return null;
  }
}

/**
 * Parse `source` with a configured tree-sitter `parser`, working around the
 * Node binding's ~32 KB default string-buffer cap (a plain `parser.parse(str)`
 * throws "Invalid argument" once the input exceeds it — the real sst.config.ts
 * is ~58 KB). For larger inputs we size `bufferSize` to the byte length so the
 * whole file parses in one shot.
 */
export function parseSource(parser, source) {
  const bytes = Buffer.byteLength(source, 'utf-8');
  if (bytes <= 32 * 1024) return parser.parse(source);
  return parser.parse(source, undefined, { bufferSize: bytes + 1024 });
}

/**
 * Recursive descent over a tree-sitter syntax tree, invoking `visit` for every
 * node. The Node SDK ships no built-in walker, so we drive the cursor API —
 * identical to ast-extract.mjs's `walk`.
 */
export function walk(rootNode, visit) {
  const cursor = rootNode.walk();
  (function descend() {
    visit(cursor.currentNode);
    if (cursor.gotoFirstChild()) {
      do {
        descend();
      } while (cursor.gotoNextSibling());
      cursor.gotoParent();
    }
  })();
}
