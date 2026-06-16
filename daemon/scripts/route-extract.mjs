/**
 * Route Extract — deterministic API-surface facts from a Hono app.
 * Story SG-1.4 (W1 — the missing middle node of the component→endpoint→table
 * contract spine).
 *
 * Drop-in sibling of `infra-extract.mjs`. Parses `app.<method>('<path>',
 * [authMiddleware,] handler)` calls and emits, in the shared envelope:
 *   - nodes:  endpoint { method, path, auth }
 *   - edges:  ROUTES (endpoint → lambda)   — the single Api Function
 *
 * `auth` is true iff `authMiddleware` appears in the middleware chain (the args
 * between the path and the final handler) — turning the public-route contract
 * (`/api/health`, `/api/auth/*`, `/api/public/projects`) into queryable
 * structure, a security-review surface for free.
 *
 * The CALLS_ENDPOINT (frontend → endpoint) side is resolved later in graph-sync
 * (SG-1.6), NOT here.
 *
 * Honesty: a route with a dynamically-built path → `ambiguous[]`, never invented.
 *
 * Usage:
 *   node route-extract.mjs --root <dir> --app functions/api/index.ts --lambda infra/lambda/Api
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  loadTsParser,
  walk,
  parseSource,
  buildEnvelope,
  emptyEnvelope,
  writeEnvelope,
} from './lib/extractor-envelope.mjs';

const HTTP_METHODS = new Set(['get', 'post', 'put', 'delete', 'patch', 'options', 'all']);

function stringText(n) {
  if (!n) return null;
  if (n.type === 'string' || n.type === 'template_string') return n.text.slice(1, -1);
  return null;
}

/**
 * @param {string} source  contents of the Hono app file
 * @param {string} lambdaId  the infra nodeId the routes resolve to (ROUTES target)
 * @param {object} opts  { Parser, tsLang }
 * @returns {{nodes:Array, edges:Array, ambiguous:Array}}
 */
export function extractRoutes(source, lambdaId, { Parser, tsLang } = {}) {
  const parser = new Parser();
  parser.setLanguage(tsLang);
  const tree = parseSource(parser, source);

  const nodes = [];
  const edges = [];
  const ambiguous = [];
  const seen = new Set();

  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') return;
    const obj = fn.childForFieldName('object');
    const prop = fn.childForFieldName('property');
    // match `app.<method>(...)`
    if (obj?.text !== 'app' || !HTTP_METHODS.has(prop?.text)) return;

    const args = node.childForFieldName('arguments');
    const argList = args ? args.namedChildren : [];
    const path = stringText(argList[0]);
    const line = node.startPosition.row + 1;
    if (!path) {
      ambiguous.push({ reason: 'dynamic-path', line });
      return;
    }

    const method = prop.text.toUpperCase();
    // Inspect ONLY the middleware positions (between the path and the final
    // handler), so an `authMiddleware` reference inside a handler body can't
    // false-positive the auth flag.
    const middleware = argList.slice(1, -1);
    const auth = middleware.some((a) => /\bauthMiddleware\b/.test(a.text));

    const nodeId = `endpoint/${method} ${path}`;
    if (seen.has(nodeId)) return; // dedupe duplicate registrations
    seen.add(nodeId);

    nodes.push({ nodeId, kind: 'endpoint', label: `${method} ${path}`, method, path, auth, line });
    edges.push({ type: 'ROUTES', source: nodeId, target: lambdaId });
  });

  return { nodes, edges, ambiguous };
}

// ── Arg parsing + main ────────────────────────────────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const out = { root: null, app: 'functions/api/index.ts', lambda: 'infra/lambda/Api' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root') out.root = a[++i];
    else if (a[i] === '--app') out.app = a[++i];
    else if (a[i] === '--lambda') out.lambda = a[++i];
    else if (a[i] === '--help' || a[i] === '-h') {
      console.log('node route-extract.mjs --root <dir> [--app functions/api/index.ts] [--lambda infra/lambda/Api]');
      process.exit(0);
    } else {
      console.error(`[route-extract] unknown arg: ${a[i]}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.root) {
    console.error('[route-extract] --root required');
    process.exit(2);
  }
  const abs = join(args.root, args.app);
  const extra = { app: args.app, lambda: args.lambda };
  if (!existsSync(abs)) {
    writeEnvelope(emptyEnvelope({ root: args.root, extra: { ...extra, skipped: 'app-not-found' } }));
    return;
  }
  const ts = await loadTsParser('route-extract');
  if (!ts) {
    writeEnvelope(emptyEnvelope({ root: args.root, extra: { ...extra, error: 'tree-sitter not installed' } }));
    return;
  }
  const source = await readFile(abs, 'utf-8');
  const { nodes, edges, ambiguous } = extractRoutes(source, args.lambda, ts);
  writeEnvelope(buildEnvelope({ root: args.root, nodes, edges, ambiguous, extra }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[route-extract] fatal:', err.message);
    writeEnvelope(emptyEnvelope({ root: process.cwd(), extra: { error: err.message } }));
    process.exit(1);
  });
}
