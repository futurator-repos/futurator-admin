/**
 * Service Extract — external/3rd-party service nodes from imports + fetch hosts.
 * Story SG-1.5 (W10 — cost-aware blast radius).
 *
 * Input: same file list as ast-extract (--files / --stdin). For each file it
 * maps known SDK imports and `fetch()` hostnames to `externalService` nodes and
 * `CALLS_SERVICE` (file → service) edges, in the shared envelope.
 *
 * W10: every `externalService` node carries a flattened cost model
 * (`billable` + `costUnit`) so blast-radius can answer "does this touch a *paid*
 * API?". Unknown hosts → `ambiguous[]` for the Compiler to label once (→
 * INFERRED), never silently EXTRACTED.
 *
 * Usage:
 *   node service-extract.mjs --root <dir> --files a.ts,b.ts
 *   echo "a.ts\nb.ts" | node service-extract.mjs --root <dir> --stdin
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildEnvelope, writeEnvelope } from './lib/extractor-envelope.mjs';

// package name (or prefix) → service label
const PACKAGE_SERVICE = [
  [/^@anthropic-ai\//, 'Anthropic'],
  [/^(eleven-?labs|@elevenlabs\/)/, 'ElevenLabs'],
  [/^@?moises/, 'Moises'],
  [/^@googlemaps\//, 'GoogleMaps'],
  [/^voyageai$/, 'Voyage'],
  [/^openai$/, 'OpenAI'],
  [/^@aws-sdk\/client-s3$/, 'AWS_S3'],
  [/^@aws-sdk\/(lib-dynamodb|client-dynamodb)$/, 'AWS_DynamoDB'],
  [/^@aws-sdk\/client-secrets-manager$/, 'AWS_SecretsManager'],
  [/^@aws-sdk\/client-ssm$/, 'AWS_SSM'],
];

const HOST_SERVICE = [
  [/api\.anthropic\.com/, 'Anthropic'],
  [/api\.elevenlabs\.io/, 'ElevenLabs'],
  [/(^|\.)moises\.ai/, 'Moises'],
  [/maps\.googleapis\.com/, 'GoogleMaps'],
  [/api\.voyageai\.com/, 'Voyage'],
  [/auth\.futurator\.ai/, 'IdentityBroker'],
];

// W10 — per-service cost model. `billable` is the queryable signal for "is this
// a paid API?"; IdentityBroker is the internal microservice (free). Anything
// known-but-unlisted defaults to billable (false-alarm beats a missed cost).
const COST_MODEL = {
  Anthropic: { unit: 'token', billable: true },
  OpenAI: { unit: 'token', billable: true },
  Voyage: { unit: 'token', billable: true },
  ElevenLabs: { unit: 'character', billable: true },
  Moises: { unit: 'request', billable: true },
  GoogleMaps: { unit: 'request', billable: true },
  IdentityBroker: { unit: 'request', billable: false },
  AWS_S3: { unit: 'request', billable: true },
  AWS_DynamoDB: { unit: 'request', billable: true },
  AWS_SecretsManager: { unit: 'request', billable: true },
  AWS_SSM: { unit: 'request', billable: true },
};

export function costModelFor(svc) {
  return COST_MODEL[svc] ?? { unit: 'request', billable: true };
}

function serviceForPackage(pkg) {
  return PACKAGE_SERVICE.find(([re]) => re.test(pkg))?.[1] ?? null;
}
function serviceForHost(host) {
  return HOST_SERVICE.find(([re]) => re.test(host))?.[1] ?? null;
}

// Light scan regexes (the standalone fallback when no ast-facts handed in).
const IMPORT_RE = /import[^'"]*from\s*['"]([^'"]+)['"]/g;
const REQUIRE_RE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
const FETCH_RE = /fetch\(\s*[`'"]([^`'"]+)[`'"]/g;
const HOST_RE = /https?:\/\/([^/`'"]+)/;

/**
 * Pure per-file extraction (exported for tests). Returns CALLS_SERVICE edges,
 * the set of service labels seen, and any unknown hosts (ambiguous).
 *
 * @param {string} rel  file path relative to root (becomes the `code/` nodeId)
 * @param {string} src  file contents
 */
export function extractServicesFromSource(rel, src) {
  const edges = [];
  const ambiguous = [];
  const services = new Set();
  const fileNodeId = `code/${rel.replace(/\//g, '--')}`;

  const addService = (svc) => {
    if (services.has(svc)) return;
    services.add(svc);
    edges.push({ type: 'CALLS_SERVICE', source: fileNodeId, target: `service/${svc}` });
  };

  let m;
  for (const re of [IMPORT_RE, REQUIRE_RE]) {
    re.lastIndex = 0;
    while ((m = re.exec(src))) {
      const svc = serviceForPackage(m[1]);
      if (svc) addService(svc);
    }
  }

  FETCH_RE.lastIndex = 0;
  while ((m = FETCH_RE.exec(src))) {
    const host = (m[1].match(HOST_RE) || [])[1];
    if (!host) continue;
    const svc = serviceForHost(host);
    if (svc) addService(svc);
    else ambiguous.push({ file: rel, host, reason: 'unknown-host' }); // Compiler labels once → INFERRED
  }

  return { edges, ambiguous, services };
}

/** Build externalService nodes (with flattened cost model) for a service set. */
export function buildServiceNodes(serviceSet) {
  return [...serviceSet].map((svc) => {
    const cm = costModelFor(svc);
    return {
      nodeId: `service/${svc}`,
      kind: 'externalService',
      label: svc,
      billable: cm.billable,
      costUnit: cm.unit,
    };
  });
}

// ── Arg parsing + main ────────────────────────────────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const out = { root: null, files: null, stdin: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root') out.root = a[++i];
    else if (a[i] === '--files') out.files = a[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a[i] === '--stdin') out.stdin = true;
    else if (a[i] === '--help' || a[i] === '-h') {
      console.log('node service-extract.mjs --root <dir> (--files a.ts,b.ts | --stdin)');
      process.exit(0);
    }
  }
  return out;
}

async function readStdin() {
  const c = [];
  for await (const x of process.stdin) c.push(x);
  return Buffer.concat(c).toString('utf-8');
}

async function main() {
  const args = parseArgs();
  if (!args.root) {
    console.error('[service-extract] --root required');
    process.exit(2);
  }
  let files = args.files;
  if (!files && args.stdin) files = (await readStdin()).split('\n').map((s) => s.trim()).filter(Boolean);
  files = files || [];

  const allEdges = [];
  const allAmbiguous = [];
  const services = new Set();

  for (const rel of files) {
    const abs = join(args.root, rel);
    if (!existsSync(abs)) continue;
    let src;
    try {
      src = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const { edges, ambiguous, services: fileServices } = extractServicesFromSource(rel, src);
    allEdges.push(...edges);
    allAmbiguous.push(...ambiguous);
    for (const s of fileServices) services.add(s);
  }

  const nodes = buildServiceNodes(services);
  writeEnvelope(buildEnvelope({ root: args.root, nodes, edges: allEdges, ambiguous: allAmbiguous }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[service-extract] fatal:', err.message);
    writeEnvelope(buildEnvelope({ root: process.cwd(), nodes: [], edges: [], ambiguous: [], extra: { error: err.message } }));
    process.exit(1);
  });
}
