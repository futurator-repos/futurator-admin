/**
 * verify-graph.mjs — System-graph health probe.
 *
 * Reads the graph store and reports node-kind counts, grouped into the layers the
 * pipeline builds, so you can tell at a glance whether the NEW system-graph
 * layers (Epic 1 infra/route/service, Epic 5/6 capability/contract spine) have
 * actually populated — versus only the old AST + wiki-article layers.
 *
 * Usage:
 *   node verify-graph.mjs --project dino1 # one project (required — the store is
 *                                         #   project-partitioned; no whole-graph scan)
 *   node verify-graph.mjs --project dino1 --json  # machine-readable
 *
 * Env: GRAPH_NODES_TABLE, GRAPH_EDGES_TABLE, AWS_REGION (DynamoDB store); omit
 *      to fall back to the in-memory store. Bolt/Memgraph EXCISED (EU-migration S2.2).
 */

import { createGraphStore } from './lib/graph-store.mjs';

// Which kinds belong to which layer (for the verdict).
const LAYERS = {
  ast: ['function', 'class', 'file', 'import', 'symbol', 'method'],
  systemGraph: [
    'dir',
    'table',
    'bucket',
    'queue',
    'topic',
    'eventSource',
    'secret',
    'cron',
    'service',
    'externalService',
    'endpoint',
    'lambda',
    'resource',
  ],
  contractSpine: ['capability', 'contract', 'contractRevision'],
  wiki: ['<null>', 'article'],
};

/** Bucket {kind,count} rows into layers + a present/absent verdict. Pure. */
export function classifyGraph(rows) {
  const layerOf = (kind) => {
    for (const [layer, kinds] of Object.entries(LAYERS)) {
      if (kinds.includes(kind)) return layer;
    }
    return 'other';
  };
  const totals = { ast: 0, systemGraph: 0, contractSpine: 0, wiki: 0, other: 0 };
  const byKind = {};
  for (const { kind, count } of rows) {
    const n = Number(count) || 0;
    byKind[kind] = (byKind[kind] ?? 0) + n;
    totals[layerOf(kind)] += n;
  }
  return {
    byKind,
    totals,
    total: Object.values(totals).reduce((a, b) => a + b, 0),
    hasSystemGraph: totals.systemGraph > 0,
    hasContractSpine: totals.contractSpine > 0,
  };
}

function parseArgs(argv) {
  const a = argv.slice(2);
  const out = { project: null, json: false };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--project') out.project = a[++i];
    else if (a[i] === '--json') out.json = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.project) {
    console.error('[verify-graph] --project <id> is required (the graph store is project-partitioned)');
    process.exit(1);
  }

  const store = await createGraphStore();
  const label = process.env.GRAPH_NODES_TABLE || 'in-memory';

  const nodes = await store.listNodes(args.project);
  const byKind = new Map();
  for (const n of nodes) {
    const kind = n.kind || '<null>';
    byKind.set(kind, (byKind.get(kind) ?? 0) + 1);
  }
  const rows = [...byKind.entries()]
    .map(([kind, count]) => ({ kind, count }))
    .sort((a, b) => b.count - a.count);
  const summary = classifyGraph(rows);

  if (args.json) {
    console.log(JSON.stringify({ project: args.project, ...summary }, null, 2));
    return;
  }

  console.log(`\nGraph: project=${args.project} @ ${label}`);
  console.log(`Total nodes: ${summary.total}\n`);
  console.log('By kind:');
  for (const { kind, count } of rows) console.log(`  ${kind.padEnd(18)} ${count}`);
  console.log('\nBy layer:');
  for (const [layer, n] of Object.entries(summary.totals)) console.log(`  ${layer.padEnd(16)} ${n}`);
  console.log('\nVerdict:');
  console.log(`  AST layer (function/class/file):  ${summary.totals.ast > 0 ? 'present ✓' : 'EMPTY ✗'}`);
  console.log(`  System-graph (infra/service/route): ${summary.hasSystemGraph ? 'present ✓' : 'EMPTY ✗ — extractors have not run'}`);
  console.log(`  Contract spine (capability/contract): ${summary.hasContractSpine ? 'present ✓' : 'absent (needs --global federation)'}`);
  console.log('');
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[verify-graph] ${err.message}`);
    process.exit(1);
  });
}
