// Synthetic but realistic knowledge-graph snapshot for the "Mycelium / graphify" viz.
// Spans all 7 layers from the spec. Deterministic (seeded) so layout is stable.
// export: buildGraph() -> { projectId, generatedAt, nodes[], edges[], insights }

let _seed = 987654321;
function rnd() { _seed = (_seed * 1103515245 + 12345) & 0x7fffffff; return _seed / 0x7fffffff; }
function ri(a, b) { return a + Math.floor(rnd() * (b - a + 1)); }
function pick(a) { return a[Math.floor(rnd() * a.length)]; }
function chance(p) { return rnd() < p; }

export function buildGraph() {
  _seed = 987654321;
  const nodes = [];
  const edges = [];
  const byId = {};
  function add(n) { n.status = n.status || 'active'; nodes.push(n); byId[n.nodeId] = n; return n; }
  function link(source, target, type, provenance) {
    if (!byId[source] || !byId[target] || source === target) return;
    edges.push({ source, target, type, provenance: provenance || 'EXTRACTED' });
  }

  // ---- Subsystems = communities ----------------------------------------
  const subs = [
    { key: 'auth', dir: 'src/auth', label: 'auth', comm: 0 },
    { key: 'billing', dir: 'src/billing', label: 'billing', comm: 1 },
    { key: 'ingest', dir: 'src/ingestion', label: 'ingestion', comm: 2 },
    { key: 'query', dir: 'src/query', label: 'query', comm: 3 },
    { key: 'api', dir: 'src/api', label: 'api', comm: 4 },
    { key: 'ui', dir: 'src/components', label: 'components', comm: 5 },
  ];

  const fileNames = {
    auth: ['login', 'session', 'tokens', 'oauth', 'guard'],
    billing: ['invoice', 'stripeClient', 'usageMeter', 'plans', 'webhooks'],
    ingest: ['crawler', 'parser', 'embedder', 'chunker', 'pipeline', 'normalize'],
    query: ['retriever', 'reranker', 'cypherAgent', 'memgraph', 'cache'],
    api: ['router', 'handlers', 'middleware', 'schema', 'errors'],
    ui: ['GraphCanvas', 'Inspector', 'Toolbar', 'FilterChips', 'authForm'],
  };

  // ---- Layer 1: Code (dir -> file -> function/class) -------------------
  subs.forEach((s) => {
    const dirId = `code/${s.dir}`;
    add({ nodeId: dirId, kind: 'dir', label: s.label, title: `${s.dir}/`, community: s.comm });
    fileNames[s.key].forEach((fn) => {
      const isComp = s.key === 'ui' && /^[A-Z]/.test(fn);
      const ext = isComp ? 'tsx' : 'ts';
      const fileId = `code/${s.dir}/${fn}.${ext}`;
      add({
        nodeId: fileId, kind: 'file', label: `${fn}.${ext}`,
        title: `${fn} module`, community: s.comm,
        summary: `Module handling ${fn} in the ${s.label} subsystem.`,
      });
      link(dirId, fileId, 'CONTAINS');

      const defs = ri(1, 3);
      for (let i = 0; i < defs; i++) {
        const isClass = chance(0.28);
        const nm = isClass
          ? fn[0].toUpperCase() + fn.slice(1) + pick(['Service', 'Store', 'Client', 'Manager'])
          : pick(['handle', 'get', 'build', 'parse', 'run', 'sync', 'resolve', 'make']) + fn[0].toUpperCase() + fn.slice(1);
        const id = `code/${s.dir}/${fn}#${nm}`;
        add({
          nodeId: id, kind: isClass ? 'class' : 'function', label: nm,
          title: nm, community: s.comm, parentFile: fileId,
          exported: chance(0.6), params: isClass ? undefined : ri(0, 3),
        });
        link(fileId, id, 'DEFINES');
      }
    });
  });

  const files = nodes.filter((n) => n.kind === 'file');
  const fns = nodes.filter((n) => n.kind === 'function');

  // IMPORTS within & across subsystems
  files.forEach((f) => {
    const same = files.filter((o) => o.community === f.community && o !== f);
    for (let i = 0; i < ri(0, 2); i++) if (same.length) link(f.nodeId, pick(same).nodeId, 'IMPORTS');
    if (chance(0.45)) link(f.nodeId, pick(files).nodeId, 'IMPORTS'); // cross
  });
  // CALLS between functions (some cross-community = surprising)
  fns.forEach((fn) => {
    for (let i = 0; i < ri(0, 2); i++) {
      const t = pick(fns);
      if (t !== fn) link(fn.nodeId, t.nodeId, 'CALLS', chance(0.15) ? 'INFERRED' : 'EXTRACTED');
    }
  });

  // ---- Layer 5: API surface (endpoints) --------------------------------
  const endpoints = [
    { p: '/auth/login', m: 'POST', auth: false, comm: 0 },
    { p: '/auth/refresh', m: 'POST', auth: true, comm: 0 },
    { p: '/billing/checkout', m: 'POST', auth: true, comm: 1 },
    { p: '/billing/webhook', m: 'POST', auth: false, comm: 1 },
    { p: '/ingest/upload', m: 'PUT', auth: true, comm: 2 },
    { p: '/search', m: 'GET', auth: true, comm: 3 },
    { p: '/graph/snapshot', m: 'GET', auth: true, comm: 3 },
    { p: '/health', m: 'GET', auth: false, comm: 4 },
  ];
  endpoints.forEach((e) => {
    const id = `api/endpoint${e.p.replace(/\//g, '--')}`;
    add({ nodeId: id, kind: 'endpoint', label: `${e.m} ${e.p}`, title: e.p, method: e.m, path: e.p, auth: e.auth, community: e.comm });
  });

  // ---- Layer 3: Infrastructure -----------------------------------------
  const infra = [];
  function infraNode(kind, name, comm, extra) {
    const id = `infra/${kind}/${name}`;
    const n = add(Object.assign({ nodeId: id, kind, label: name, title: name, community: comm }, extra || {}));
    infra.push(n); return n;
  }
  infraNode('table', 'Users', 0, { fields: 'id, email, hash, plan, createdAt', primaryIndex: 'pk=USER#id' });
  infraNode('table', 'Sessions', 0, { fields: 'sid, userId, exp', primaryIndex: 'pk=SESS#sid' });
  infraNode('table', 'Invoices', 1, { fields: 'id, userId, amount, status', primaryIndex: 'pk=INV#id' });
  infraNode('table', 'Usage', 1, { fields: 'userId, tokens, ts', primaryIndex: 'pk=USER#id, sk=ts' });
  infraNode('table', 'Documents', 2, { fields: 'docId, hash, ownerId', primaryIndex: 'pk=DOC#id' });
  infraNode('table', 'Chunks', 2, { fields: 'chunkId, docId, vector', primaryIndex: 'pk=DOC#id, sk=chunk' });
  infraNode('table', 'GraphSnapshots', 3, { fields: 'projectId, generatedAt, blob', primaryIndex: 'pk=PROJ#id' });
  infraNode('lambda', 'authHandler', 0, { handler: 'src/auth/login.handler' });
  infraNode('lambda', 'checkoutFn', 1, { handler: 'src/billing/handlers.checkout' });
  infraNode('lambda', 'webhookFn', 1, { handler: 'src/billing/webhooks.handle' });
  infraNode('lambda', 'embedWorker', 2, { handler: 'src/ingestion/embedder.run' });
  infraNode('lambda', 'searchFn', 3, { handler: 'src/query/retriever.handle' });
  infraNode('lambda', 'snapshotFn', 3, { handler: 'src/query/memgraph.snapshot' });
  infraNode('cron', 'nightlySync', 2, { schedule: 'rate(1 day)', handler: 'src/ingestion/pipeline.sync' });
  infraNode('cron', 'usageRollup', 1, { schedule: 'rate(1 hour)', handler: 'src/billing/usageMeter.roll' });
  infraNode('secret', 'STRIPE_KEY', 1, {});
  infraNode('secret', 'OPENAI_KEY', 2, {});
  infraNode('secret', 'JWT_SECRET', 0, {});
  infraNode('bucket', 'uploads', 2, {});
  infraNode('bucketPath', 'uploads/raw/*', 2, {});
  infraNode('bucket', 'snapshots', 3, {});
  infraNode('iamRole', 'workerRole', 2, {});
  infraNode('cloudfront', 'cdn', 4, {});
  infraNode('vpc', 'main-vpc', 4, {});

  // ---- Layer 4: Events --------------------------------------------------
  infraNode('topic', 'doc-uploaded', 2, {});
  infraNode('queue', 'embed-queue', 2, {});
  infraNode('bus', 'platform-bus', 4, {});
  infraNode('eventSource', 's3:uploads', 2, {});

  // ---- Layer 6: External services --------------------------------------
  const ext = [
    { n: 'Stripe', billable: true, costUnit: 'request', comm: 1 },
    { n: 'OpenAI', billable: true, costUnit: 'token', comm: 2 },
    { n: 'Anthropic', billable: true, costUnit: 'token', comm: 3 },
    { n: 'SendGrid', billable: true, costUnit: 'request', comm: 0 },
    { n: 'Sentry', billable: false, costUnit: 'request', comm: 4 },
  ];
  ext.forEach((e) => add({ nodeId: `ext/${e.n}`, kind: 'externalService', label: e.n, title: e.n, billable: e.billable, costUnit: e.costUnit, community: e.comm }));

  // ---- Layer 7: Cross-project + Documents ------------------------------
  add({ nodeId: 'svc/futurator-core', kind: 'service', label: 'futurator-core', title: 'futurator-core service', community: 4 });
  add({ nodeId: 'cap/SearchContract', kind: 'capability', label: 'SearchContract', title: 'Search capability', community: 3 });
  add({ nodeId: 'cap/BillingContract', kind: 'capability', label: 'BillingContract', title: 'Billing capability', community: 1 });
  add({ nodeId: 'rev/r1842', kind: 'contractRevision', label: 'r1842', title: 'rev r1842', change: 'added Usage.tokens', atCommit: 'a3f9', community: 1 });

  const docs = [
    { id: 'prd', type: 'prd', title: 'Knowledge Graph PRD', secs: ['Overview', 'Goals', 'Search UX', 'Billing model'] },
    { id: 'ux', type: 'ux', title: 'Graph Viz UX Spec', secs: ['Layers', 'Blast radius', 'Inspector', 'Filters'] },
    { id: 'arch', type: 'architecture', title: 'Architecture', secs: ['Data model', 'Memgraph', 'Ingestion pipeline', 'API surface'] },
  ];
  docs.forEach((d) => {
    const did = `doc/${d.id}`;
    add({ nodeId: did, kind: 'document', label: d.title, title: d.title, docType: d.type, rev: 3, isDoc: true });
    d.secs.forEach((s, i) => {
      const sid = `doc/${d.id}#${i}`;
      add({ nodeId: sid, kind: 'docSection', label: s, title: `§ ${s}`, docId: did, level: 2, ordinal: i, isDoc: true });
      link(did, sid, 'SPECIFIES', 'INFERRED');
    });
  });
  link('doc/prd', 'doc/ux', 'DERIVED_FROM');
  link('doc/ux', 'doc/arch', 'DERIVED_FROM');

  // ---- Cross-layer wiring (the whole point) ----------------------------
  function fileOf(sub, name) { const f = files.find((x) => x.nodeId.includes(`/${sub}/`) && x.label.startsWith(name)); return f && f.nodeId; }
  // ROUTES: endpoint -> lambda ; HANDLED_BY: lambda -> file ; CALLS_ENDPOINT: ui file -> endpoint
  link('api/endpoint--auth--login', 'infra/lambda/authHandler', 'ROUTES');
  link('api/endpoint--billing--checkout', 'infra/lambda/checkoutFn', 'ROUTES');
  link('api/endpoint--billing--webhook', 'infra/lambda/webhookFn', 'ROUTES');
  link('api/endpoint--ingest--upload', 'infra/lambda/embedWorker', 'ROUTES');
  link('api/endpoint--search', 'infra/lambda/searchFn', 'ROUTES');
  link('api/endpoint--graph--snapshot', 'infra/lambda/snapshotFn', 'ROUTES');
  nodes.filter((n) => n.kind === 'lambda').forEach((l) => { if (l.handler) link(l.nodeId, `code/src/${l.handler.split('/')[1]}/${l.handler.split('/')[2].split('.')[0]}.ts`, 'HANDLED_BY'); });
  // UI files call endpoints
  files.filter((f) => f.community === 5).forEach((f) => { if (chance(0.7)) link(f.nodeId, pick(nodes.filter((n) => n.kind === 'endpoint')).nodeId, 'CALLS_ENDPOINT', 'INFERRED'); });

  // READS: file -> table
  [['auth', 'Users'], ['auth', 'Sessions'], ['billing', 'Invoices'], ['billing', 'Usage'], ['ingestion', 'Documents'], ['ingestion', 'Chunks'], ['query', 'GraphSnapshots'], ['query', 'Chunks']].forEach(([s, t]) => {
    const f = files.find((x) => x.community === subs.find((su) => su.dir.endsWith(s)).comm);
    if (f) link(f.nodeId, `infra/table/${t}`, 'READS');
  });
  // lambdas USE tables / secrets / external
  link('infra/lambda/checkoutFn', 'ext/Stripe', 'USES'); link('infra/lambda/checkoutFn', 'infra/secret/STRIPE_KEY', 'USES'); link('infra/lambda/checkoutFn', 'infra/table/Invoices', 'USES');
  link('infra/lambda/webhookFn', 'ext/Stripe', 'USES'); link('infra/lambda/webhookFn', 'infra/table/Usage', 'USES');
  link('infra/lambda/embedWorker', 'ext/OpenAI', 'USES'); link('infra/lambda/embedWorker', 'infra/secret/OPENAI_KEY', 'USES'); link('infra/lambda/embedWorker', 'infra/table/Chunks', 'USES');
  link('infra/lambda/searchFn', 'ext/Anthropic', 'USES'); link('infra/lambda/searchFn', 'infra/table/GraphSnapshots', 'USES');
  link('infra/lambda/authHandler', 'infra/secret/JWT_SECRET', 'USES'); link('infra/lambda/authHandler', 'infra/table/Users', 'USES');
  link('infra/lambda/embedWorker', 'infra/bucketPath/uploads/raw/*', 'WRITES');
  // CALLS_SERVICE: code -> external
  link(fileOf('billing', 'stripeClient'), 'ext/Stripe', 'CALLS_SERVICE');
  link(fileOf('ingestion', 'embedder'), 'ext/OpenAI', 'CALLS_SERVICE');
  link(fileOf('query', 'cypherAgent'), 'ext/Anthropic', 'CALLS_SERVICE');
  link(fileOf('auth', 'login'), 'ext/SendGrid', 'CALLS_SERVICE', 'INFERRED');
  // secret REPRESENTS external
  link('infra/secret/STRIPE_KEY', 'ext/Stripe', 'REPRESENTS'); link('infra/secret/OPENAI_KEY', 'ext/OpenAI', 'REPRESENTS');

  // Event chains
  link('infra/eventSource/s3:uploads', 'infra/topic/doc-uploaded', 'EMITS');
  link('infra/topic/doc-uploaded', 'infra/lambda/embedWorker', 'TRIGGERS');
  link('infra/lambda/embedWorker', 'infra/queue/embed-queue', 'EMITS');
  link('infra/cron/nightlySync', 'infra/lambda/snapshotFn', 'TRIGGERS');
  link('infra/cron/usageRollup', 'infra/lambda/webhookFn', 'TRIGGERS');
  link('infra/lambda/webhookFn', 'infra/bus/platform-bus', 'SUBSCRIBES');

  // bucket -> path containment, role, network
  link('infra/bucket/uploads', 'infra/bucketPath/uploads/raw/*', 'CONTAINS');
  link('infra/lambda/embedWorker', 'infra/iamRole/workerRole', 'USES');

  // Cross-project / capability
  link('svc/futurator-core', 'cap/SearchContract', 'CONSUMES_CONTRACT');
  link('svc/futurator-core', 'cap/BillingContract', 'CONSUMES_CONTRACT');
  link(fileOf('query', 'retriever'), 'cap/SearchContract', 'IMPLEMENTS');
  link(fileOf('billing', 'plans'), 'cap/BillingContract', 'IMPLEMENTS');
  link('cap/BillingContract', 'rev/r1842', 'REVISED');

  // Document -> code/infra governance
  link('doc/arch#0', 'infra/table/Users', 'GOVERNS');
  link('doc/arch#0', 'infra/table/Invoices', 'GOVERNS');
  link('doc/arch#1', 'infra/table/GraphSnapshots', 'GOVERNS');
  link('doc/arch#2', fileOf('ingestion', 'pipeline'), 'GOVERNS');
  link('doc/arch#3', 'api/endpoint--search', 'GOVERNS');
  link('doc/ux#1', fileOf('ui', 'GraphCanvas'), 'GOVERNS');
  link('doc/ux#2', fileOf('ui', 'Inspector'), 'GOVERNS');
  link('doc/prd#3', 'cap/BillingContract', 'REFERENCES');
  link('doc/arch#1', 'infra/table/Chunks', 'DESCRIBES', 'INFERRED');
  link('doc/arch#2', 'ext/OpenAI', 'DESCRIBES', 'INFERRED');

  // ---- a few intentional orphans + dead code ---------------------------
  add({ nodeId: 'code/src/legacy/oldMigrate.ts', kind: 'file', label: 'oldMigrate.ts', title: 'legacy migration', community: 4, summary: 'Only referenced by containment.' });
  add({ nodeId: 'code/src/legacy', kind: 'dir', label: 'legacy', title: 'src/legacy/', community: 4 });
  link('code/src/legacy', 'code/src/legacy/oldMigrate.ts', 'CONTAINS');
  add({ nodeId: 'infra/table/Orphaned', kind: 'table', label: 'Orphaned', title: 'Orphaned (no edges)', community: 4, fields: 'id', primaryIndex: 'pk=id' });
  add({ nodeId: 'code/src/query/unused#deadFn', kind: 'function', label: 'deadFn', title: 'deadFn', community: 3 });

  // ---- degree + centrality + insights ----------------------------------
  const deg = {};
  nodes.forEach((n) => (deg[n.nodeId] = 0));
  edges.forEach((e) => { deg[e.source]++; deg[e.target]++; });
  const maxDeg = Math.max(1, ...Object.values(deg));
  nodes.forEach((n) => {
    n.degree = deg[n.nodeId];
    // betweenness proxy: degree, boosted for hub kinds
    const boost = (n.kind === 'file' || n.kind === 'lambda' || n.kind === 'endpoint') ? 1.25 : 1;
    n.centrality = +Math.min(1, (deg[n.nodeId] / maxDeg) * boost).toFixed(3);
  });

  const godNodes = [...nodes].filter((n) => n.degree > 0)
    .sort((a, b) => b.centrality - a.centrality).slice(0, 8)
    .map((n) => ({ id: n.nodeId, kind: n.kind, title: n.title, centrality: n.centrality }));

  const commCounts = {};
  nodes.forEach((n) => { if (n.community != null) commCounts[n.community] = (commCounts[n.community] || 0) + 1; });
  const communities = Object.keys(commCounts).map((c) => ({ community: +c, count: commCounts[c], label: (subs[+c] && subs[+c].label) || `cluster ${c}` }));

  const surprising = edges
    .map((e) => ({ e, s: byId[e.source], t: byId[e.target] }))
    .filter((x) => x.s && x.t && x.s.community != null && x.t.community != null && x.s.community !== x.t.community)
    .map((x) => ({ source: x.e.source, sourceTitle: x.s.title, type: x.e.type, target: x.e.target, targetTitle: x.t.title, sourceCommunity: x.s.community, targetCommunity: x.t.community, score: +(x.s.centrality + x.t.centrality).toFixed(3) }))
    .sort((a, b) => b.score - a.score).slice(0, 12);

  const orphans = nodes.filter((n) => n.degree === 0 && n.status === 'active');
  const hardKinds = ['function', 'class', 'table', 'lambda', 'endpoint', 'externalService'];
  const hardFail = orphans.filter((n) => hardKinds.includes(n.kind));
  const deadCode = nodes.filter((n) => n.kind === 'file' && deg[n.nodeId] > 0 && edges.filter((e) => e.source === n.nodeId || e.target === n.nodeId).every((e) => e.type === 'CONTAINS'));

  return {
    projectId: 'brick1', generatedAt: new Date().toISOString(),
    nodeCount: nodes.length, edgeCount: edges.length,
    nodes, edges,
    insights: {
      mageAvailable: true,
      godNodes, communities, surprisingConnections: surprising,
      coverage: { filesWithArticle: 7, files: 10 },
      orphans: { status: hardFail.length ? 'fail' : 'pass', orphanCount: orphans.length, hardFailCount: hardFail.length, list: orphans.map((n) => ({ id: n.nodeId, kind: n.kind, title: n.title })), hardFail: hardFail.map((n) => ({ id: n.nodeId, kind: n.kind })) },
      deadCode: deadCode.map((n) => ({ id: n.nodeId, title: n.title })),
    },
  };
}
