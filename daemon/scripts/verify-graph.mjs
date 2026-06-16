/**
 * verify-graph.mjs — System-graph health probe.
 *
 * Connects to Memgraph and reports node-kind counts, grouped into the layers the
 * pipeline builds, so you can tell at a glance whether the NEW system-graph
 * layers (Epic 1 infra/route/service, Epic 5/6 capability/contract spine) have
 * actually populated — versus only the old AST + wiki-article layers.
 *
 * Usage:
 *   node verify-graph.mjs                 # whole graph
 *   node verify-graph.mjs --project dino1 # one project
 *   node verify-graph.mjs --json          # machine-readable
 *
 * Env: MEMGRAPH_URI (default bolt://localhost:7687), MEMGRAPH_USER,
 *      MEMGRAPH_PASSWORD (omit both for an unauthenticated local instance).
 */

import neo4j from 'neo4j-driver';

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
  const uri = process.env.MEMGRAPH_URI || 'bolt://localhost:7687';
  const user = process.env.MEMGRAPH_USER || '';
  const pass = process.env.MEMGRAPH_PASSWORD || '';
  const auth = user ? neo4j.auth.basic(user, pass) : undefined;

  const driver = neo4j.driver(uri, auth);
  const session = driver.session();
  try {
    const where = args.project ? 'WHERE n.projectId = $project' : '';
    const r = await session.run(
      `MATCH (n:Node) ${where}
       RETURN coalesce(n.kind, '<null>') AS kind, count(*) AS count
       ORDER BY count DESC`,
      { project: args.project },
    );
    const rows = r.records.map((rec) => ({
      kind: rec.get('kind'),
      count: rec.get('count').toNumber ? rec.get('count').toNumber() : Number(rec.get('count')),
    }));
    const summary = classifyGraph(rows);

    if (args.json) {
      console.log(JSON.stringify({ project: args.project ?? 'all', ...summary }, null, 2));
      return;
    }

    console.log(`\nGraph: ${args.project ? `project=${args.project}` : 'all projects'} @ ${uri}`);
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
  } finally {
    await session.close();
    await driver.close();
  }
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(`[verify-graph] ${err.message}`);
    process.exit(1);
  });
}
