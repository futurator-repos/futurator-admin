/**
 * Infra Extract — deterministic infrastructure facts from sst.config.ts
 * Story SG-1.2 (core) + SG-1.3 (event/async edges).
 *
 * Drop-in sibling of `ast-extract.mjs`. Parses SST/Pulumi resource declarations
 * via tree-sitter and emits, in the shared extractor envelope:
 *   - nodes:  table | lambda | cron | secret | bucket | bucketPath | cloudfront
 *             | iamRole | iamRolePolicy | externalService
 *             (+ topic | queue | bus | eventSource — SG-1.3)
 *   - edges:  HANDLED_BY (lambda/cron→file), USES (lambda→table/secret/service),
 *             WRITES (lambda→bucketPath), REPRESENTS (secret→externalService)
 *             (+ TRIGGERS / SUBSCRIBES / EMITS — SG-1.3)
 *   - envJoin: { ENV_VAR_NAME: { kind, id } } — consumed by graph-sync (SG-1.6)
 *             to build File ─READS→ Table edges from process.env.X references.
 *
 * Usage:
 *   node infra-extract.mjs --root /home/ubuntu/projects/X --config sst.config.ts
 *
 * Honesty: every node/edge is EXTRACTED (deterministic). Unresolvable joins are
 * recorded under `ambiguous[]`, never guessed.
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

// Secret-name → external service hints (extend freely).
const SECRET_SERVICE_HINTS = [
  [/anthropic/i, 'Anthropic'],
  [/elevenlabs|eleven_labs/i, 'ElevenLabs'],
  [/moises/i, 'Moises'],
  [/google.?maps|gmaps/i, 'GoogleMaps'],
  [/voyage/i, 'Voyage'],
  [/openai/i, 'OpenAI'],
  [/github|ghp|pat/i, 'GitHub'],
];

// Env-value hostnames → external service (for IDENTITY_BROKER_URL etc.)
const URL_SERVICE_HINTS = [
  [/auth\.futurator\.ai|identity.?broker/i, 'IdentityBroker'],
  [/api\.anthropic\.com/i, 'Anthropic'],
  [/api\.elevenlabs\.io/i, 'ElevenLabs'],
  [/moises\.ai/i, 'Moises'],
  [/maps\.googleapis\.com/i, 'GoogleMaps'],
];

// SST/Pulumi constructor → node kind. RolePolicy MUST be tested before Role
// since `aws.iam.RolePolicy` would also satisfy a loose Role match.
function kindForConstructor(ctor) {
  if (/\.Dynamo$/.test(ctor)) return 'table';
  if (/\.Function$/.test(ctor)) return 'lambda';
  if (/\.Cron$/.test(ctor)) return 'cron';
  if (/\.Bucket$/.test(ctor)) return 'bucket';
  if (/\.SnsTopic$/.test(ctor)) return 'topic';
  if (/\.Queue$/.test(ctor)) return 'queue';
  if (/\.Bus$/.test(ctor)) return 'bus';
  if (/iam\.RolePolicy$/.test(ctor)) return 'iamRolePolicy';
  if (/iam\.Role$/.test(ctor)) return 'iamRole';
  if (/Secret$/.test(ctor)) return 'secret';
  if (/\.Router$/.test(ctor) || /Cdn$|CloudFront$/.test(ctor)) return 'cloudfront';
  return null;
}

// ── Small AST helpers for the object-literal config blocks ───────────────
function stringText(node) {
  if (!node) return null;
  if (node.type === 'string') return node.text.slice(1, -1);
  if (node.type === 'template_string') return node.text.slice(1, -1); // keep ${...} markers
  return null;
}

/** Find a `pair` value by key name inside an `object` node. */
function pairValue(objNode, keyName) {
  if (!objNode || objNode.type !== 'object') return null;
  for (const child of objNode.namedChildren) {
    if (child.type !== 'pair') continue;
    const key = child.childForFieldName('key');
    const k = key?.text?.replace(/['"]/g, '');
    if (k === keyName) return child.childForFieldName('value');
  }
  return null;
}

/** Base identifier of a member-expression: `costsTable.name` → "costsTable". */
function baseIdentifier(node) {
  if (!node) return null;
  if (node.type === 'identifier') return node.text;
  if (node.type === 'member_expression') {
    let o = node.childForFieldName('object');
    while (o && o.type === 'member_expression') o = o.childForFieldName('object');
    return o?.type === 'identifier' ? o.text : null;
  }
  return null;
}

/**
 * Resolve an SST `handler: 'functions/api/index.handler'` to the canonical file
 * nodeId graph-sync uses (`code/` + path with `/`→`--`). Probes .ts|.tsx|.mjs|.js
 * on disk; falls back to .ts so the edge still points somewhere meaningful (the
 * orphan check surfaces it if the file genuinely doesn't exist).
 */
function handlerToFileNodeId(handler, root) {
  if (!handler) return null;
  const lastDot = handler.lastIndexOf('.');
  const stem = lastDot > 0 ? handler.slice(0, lastDot) : handler;
  const exts = ['.ts', '.tsx', '.mjs', '.js'];
  let rel = `${stem}.ts`;
  if (root) {
    for (const ext of exts) {
      if (existsSync(join(root, `${stem}${ext}`))) {
        rel = `${stem}${ext}`;
        break;
      }
    }
  }
  return `code/${rel.replace(/\//g, '--')}`;
}

// ── Main extraction (pure; exported for tests) ───────────────────────────
/**
 * @param {string} source  contents of sst.config.ts
 * @param {object} [opts]
 * @param {object} opts.Parser   tree-sitter Parser ctor
 * @param {object} opts.tsLang   tree-sitter TypeScript language
 * @param {string} [opts.root]   project root, for handler-file probing
 * @returns {{nodes:Array, edges:Array, envJoin:object, ambiguous:Array}}
 */
export function extractInfra(source, { Parser, tsLang, root } = {}) {
  const parser = new Parser();
  parser.setLanguage(tsLang);
  const tree = parseSource(parser, source);

  const nodes = [];
  const edges = [];
  const envJoin = {}; // ENV_VAR → { kind, id }
  const ambiguous = [];
  const varToResource = {}; // local var name → { kind, id }
  const services = new Set();

  // PASS 1 — collect every `new sst.* / new aws.*` and its logical id + bound var.
  const newExprs = [];
  walk(tree.rootNode, (node) => {
    if (node.type !== 'new_expression') return;
    const ctor = node.childForFieldName('constructor')?.text;
    const kind = kindForConstructor(ctor || '');
    if (!kind) return;
    const args = node.childForFieldName('arguments');
    const argList = args ? args.namedChildren : [];
    const id = stringText(argList[0]); // logical id, e.g. 'CostsTable'
    if (!id) return;
    const configObj = argList.find((a) => a.type === 'object') || null;
    let p = node.parent;
    let varName = null;
    if (p?.type === 'variable_declarator') varName = p.childForFieldName('name')?.text ?? null;
    newExprs.push({ kind, id, configObj, varName, line: node.startPosition.row + 1 });
    if (varName) varToResource[varName] = { kind, id };
  });

  // Shared: emit HANDLED_BY / USES / env-join / WRITES from a function config
  // object (the `{ handler, link, environment, permissions }` block). Reused by
  // plain Functions, inline Cron functions, and SNS/EventBridge subscribers.
  function emitFunctionConfig(lambdaNodeId, fnObj, line, props) {
    if (!fnObj || fnObj.type !== 'object') return;

    const handler = stringText(pairValue(fnObj, 'handler'));
    if (handler) {
      if (props) props.handler = handler;
      const fileNodeId = handlerToFileNodeId(handler, root);
      if (fileNodeId) edges.push({ type: 'HANDLED_BY', source: lambdaNodeId, target: fileNodeId });
    }

    const linkArr = pairValue(fnObj, 'link');
    if (linkArr?.type === 'array') {
      for (const el of linkArr.namedChildren) {
        if (el.type !== 'identifier') continue;
        const res = varToResource[el.text];
        if (res) edges.push({ type: 'USES', source: lambdaNodeId, target: `infra/${res.kind}/${res.id}` });
        else ambiguous.push({ at: lambdaNodeId, reason: `link var '${el.text}' unresolved` });
      }
    }

    const envObj = pairValue(fnObj, 'environment');
    if (envObj?.type === 'object') {
      for (const pair of envObj.namedChildren) {
        if (pair.type !== 'pair') continue;
        const envName = pair.childForFieldName('key')?.text?.replace(/['"]/g, '');
        const val = pair.childForFieldName('value');
        if (!envName || !val) continue;
        const base = baseIdentifier(val);
        if (base && varToResource[base]) {
          envJoin[envName] = varToResource[base]; // ENV → resource (drives File─READS→Table)
          if (varToResource[base].kind === 'secret') {
            const svc = SECRET_SERVICE_HINTS.find(([re]) => re.test(varToResource[base].id))?.[1];
            if (svc) {
              services.add(svc);
              edges.push({ type: 'USES', source: lambdaNodeId, target: `service/${svc}` });
            }
          }
        } else {
          const litUrl = stringText(val);
          const svc = litUrl && URL_SERVICE_HINTS.find(([re]) => re.test(litUrl))?.[1];
          if (svc) {
            services.add(svc);
            edges.push({ type: 'USES', source: lambdaNodeId, target: `service/${svc}` });
          }
        }
      }
    }

    const permsArr = pairValue(fnObj, 'permissions');
    if (permsArr?.type === 'array') {
      for (const perm of permsArr.namedChildren) {
        if (perm.type !== 'object') continue;
        const resArr = pairValue(perm, 'resources');
        if (resArr?.type !== 'array') continue;
        for (const res of resArr.namedChildren) {
          const arn = stringText(res);
          const m = arn && arn.match(/s3:::([^/]+)\/([^'"`]*)/);
          if (m) {
            const bucketRaw = m[1];
            const path = m[2];
            const bucketLabel = bucketRaw.replace(/\$\{[^}]+\}/g, ''); // strip ${...} for label
            const bpId = `infra/bucketPath/${bucketRaw}/${path}`;
            nodes.push({
              nodeId: bpId,
              kind: 'bucketPath',
              label: `${bucketLabel || '${bucket}'}/${path}`,
              line,
            });
            edges.push({ type: 'WRITES', source: lambdaNodeId, target: bpId });
          }
        }
      }
    }
  }

  // PASS 2 — emit nodes + edges now that varToResource is complete.
  for (const r of newExprs) {
    const nodeId = `infra/${r.kind}/${r.id}`;
    const props = { nodeId, kind: r.kind, label: r.id, logicalId: r.id, line: r.line };

    if (r.kind === 'table' && r.configObj) {
      const fieldsObj = pairValue(r.configObj, 'fields');
      const piObj = pairValue(r.configObj, 'primaryIndex');
      if (fieldsObj) props.fields = fieldsObj.text;
      if (piObj) props.primaryIndex = piObj.text;
    }

    if (r.kind === 'secret') {
      const svc = SECRET_SERVICE_HINTS.find(([re]) => re.test(r.id))?.[1] ?? null;
      if (svc) {
        services.add(svc);
        edges.push({ type: 'REPRESENTS', source: nodeId, target: `service/${svc}` });
      }
    }

    if (r.kind === 'lambda' && r.configObj) {
      emitFunctionConfig(nodeId, r.configObj, r.line, props);
    }

    if (r.kind === 'cron' && r.configObj) {
      const sched = stringText(pairValue(r.configObj, 'schedule'));
      if (sched) props.schedule = sched;
      const fnVal = pairValue(r.configObj, 'function');
      // `function: existingFnVar` → the cron triggers a separate lambda (W5).
      // `function: { handler, ... }` (inline) → the cron node owns the handler.
      if (fnVal?.type === 'identifier' && varToResource[fnVal.text]?.kind === 'lambda') {
        const lam = varToResource[fnVal.text];
        edges.push({ type: 'TRIGGERS', source: nodeId, target: `infra/lambda/${lam.id}` });
      } else {
        emitFunctionConfig(nodeId, fnVal || r.configObj, r.line, props);
      }
    }

    nodes.push(props);
  }

  // PASS 3 — event/async wiring (W5): topic/bus `.subscribe()`, bucket
  // `.notify()`, and best-effort `.publish()` call-sites. These are call
  // expressions (not `new`), so they need their own walk after varToResource
  // is complete. A subscriber's handler becomes a first-class lambda node so
  // blast-radius can traverse the async chain instead of returning a false
  // all-clear.
  walk(tree.rootNode, (node) => {
    if (node.type !== 'call_expression') return;
    const fn = node.childForFieldName('function');
    if (!fn || fn.type !== 'member_expression') return;
    const method = fn.childForFieldName('property')?.text;
    if (method !== 'subscribe' && method !== 'notify' && method !== 'publish') return;
    const objBase = baseIdentifier(fn.childForFieldName('object'));
    const src = objBase ? varToResource[objBase] : null;
    const line = node.startPosition.row + 1;
    const args = node.childForFieldName('arguments');
    const argList = args ? args.namedChildren : [];

    if (method === 'subscribe') {
      const logicalId = stringText(argList[0]);
      const cfg = argList.find((a) => a.type === 'object');
      if (!logicalId || !cfg) {
        ambiguous.push({ reason: 'dynamic-subscribe', line });
        return;
      }
      const lambdaId = `infra/lambda/${logicalId}`;
      const lprops = { nodeId: lambdaId, kind: 'lambda', label: logicalId, logicalId, line };
      emitFunctionConfig(lambdaId, cfg, line, lprops);
      nodes.push(lprops);
      if (src) {
        const srcId = `infra/${src.kind}/${src.id}`;
        edges.push({ type: 'TRIGGERS', source: srcId, target: lambdaId });
        edges.push({ type: 'SUBSCRIBES', source: lambdaId, target: srcId });
      } else {
        ambiguous.push({ reason: `subscribe source '${objBase}' unresolved`, line });
      }
    } else if (method === 'notify') {
      // S3/EventBridge bucket notification → an eventSource node that triggers
      // each subscriber handler. Best-effort: only resolvable handlers wire up.
      if (!src) {
        ambiguous.push({ reason: `notify source '${objBase}' unresolved`, line });
        return;
      }
      const evtId = `infra/eventSource/${src.id}-notify`;
      nodes.push({ nodeId: evtId, kind: 'eventSource', label: `${src.id} notify`, line });
      edges.push({ type: 'TRIGGERS', source: `infra/${src.kind}/${src.id}`, target: evtId });
      const cfgObj = argList.find((a) => a.type === 'object');
      const subsArr = cfgObj && pairValue(cfgObj, 'subscribers');
      const handlerVal = cfgObj && pairValue(cfgObj, 'function');
      const wired = [];
      if (subsArr?.type === 'array') {
        for (const el of subsArr.namedChildren) {
          const res = el.type === 'identifier' ? varToResource[el.text] : null;
          if (res?.kind === 'lambda') wired.push(`infra/lambda/${res.id}`);
        }
      } else if (handlerVal?.type === 'identifier' && varToResource[handlerVal.text]?.kind === 'lambda') {
        wired.push(`infra/lambda/${varToResource[handlerVal.text].id}`);
      }
      if (wired.length === 0) ambiguous.push({ reason: 'notify target dynamic/inline', line });
      for (const t of wired) edges.push({ type: 'TRIGGERS', source: evtId, target: t });
    } else if (method === 'publish') {
      // EMITS is best-effort: only the topic/bus target is resolvable from the
      // config; the emitting code site isn't visible here, so dynamic targets
      // are recorded honestly rather than guessed.
      if (src) {
        const srcId = `infra/${src.kind}/${src.id}`;
        ambiguous.push({ reason: `publish to ${srcId} (emitter not in config)`, line });
      } else {
        ambiguous.push({ reason: 'dynamic-publish', line });
      }
    }
  });

  // emit external-service nodes discovered above
  for (const svc of services) {
    nodes.push({ nodeId: `service/${svc}`, kind: 'externalService', label: svc });
  }

  return { nodes, edges, envJoin, ambiguous };
}

// ── Arg parsing + main (mirrors ast-extract.mjs) ─────────────────────────
function parseArgs() {
  const a = process.argv.slice(2);
  const out = { root: null, config: 'sst.config.ts' };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--root') out.root = a[++i];
    else if (a[i] === '--config') out.config = a[++i];
    else if (a[i] === '--help' || a[i] === '-h') {
      console.log('node infra-extract.mjs --root <dir> [--config sst.config.ts]');
      process.exit(0);
    } else {
      console.error(`[infra-extract] unknown arg: ${a[i]}`);
      process.exit(2);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs();
  if (!args.root) {
    console.error('[infra-extract] --root required');
    process.exit(2);
  }
  const abs = join(args.root, args.config);
  const extra = { config: args.config, envJoin: {} };
  if (!existsSync(abs)) {
    writeEnvelope(emptyEnvelope({ root: args.root, extra: { ...extra, skipped: 'config-not-found' } }));
    return;
  }
  const ts = await loadTsParser('infra-extract');
  if (!ts) {
    writeEnvelope(emptyEnvelope({ root: args.root, extra: { ...extra, error: 'tree-sitter not installed' } }));
    return;
  }
  const source = await readFile(abs, 'utf-8');
  const { nodes, edges, envJoin, ambiguous } = extractInfra(source, { ...ts, root: args.root });
  writeEnvelope(
    buildEnvelope({ root: args.root, nodes, edges, ambiguous, extra: { config: args.config, envJoin } }),
  );
}

// Only run the CLI when invoked directly (keeps extractInfra importable in tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[infra-extract] fatal:', err.message);
    writeEnvelope(emptyEnvelope({ root: process.cwd(), extra: { error: err.message } }));
    process.exit(1);
  });
}
