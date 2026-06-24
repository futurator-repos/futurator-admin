// case1-to-decision.mjs — AST parser over a captured ultracode workflow .js → DecisionPlan.
// Design doc §3. The load-bearing net-new piece.
//
// Library: the TypeScript compiler API (repo already ships `typescript` ^5 — zero new dep).
// `workflow-lint.mjs` is regex-only and NOT reusable for call-graph extraction (its C0–C9
// post-hoc-invariant idea is reusable; its parser is not).
//
// Run: `node spikes/ultra-reverse/lib/case1-to-decision.mjs <path-to-workflow.js>` prints the IR.
// Import: `import { case1ToDecision } from './case1-to-decision.mjs'`.

import ts from 'typescript';
import { makeDecisionPlan } from './decision-schema.mjs';
import { classifyPattern } from './pattern-classify.mjs';

const REDUCE_METHODS = new Set(['filter', 'reduce', 'sort', 'flatMap', 'flat']);
const VERDICT_TOKENS = ['ACCEPT', 'REJECT', 'PASS', 'FAIL'];

/** @param {string} source  @param {{source?: 'case1-script'}} [opts] */
export function case1ToDecision(source, opts = {}) {
  const lossy = [];
  let plan;
  try {
    plan = parse(source, lossy);
  } catch (err) {
    plan = makeDecisionPlan();
    lossy.push(`parse-failed: ${err && err.message ? err.message : String(err)}`);
  }
  plan.source = 'case1-script';
  plan.extraction = { lossy: [...new Set([...(plan.extraction?.lossy ?? []), ...lossy])] };
  return plan;
}

function parse(source, lossy) {
  const sf = ts.createSourceFile('wf.js', source, ts.ScriptTarget.Latest, /* setParentNodes */ true, ts.ScriptKind.JS);
  const pos = (n) => n.getStart(sf);
  const txt = (n) => (n ? n.getText(sf) : '');

  // ── pass 1: collect nodes of interest in source order ──────────────────────
  const metaPhases = [];              // titles from `export const meta = { phases: [...] }`
  const phaseMarkers = [];            // { pos, title } from phase('X')
  const agentCalls = [];             // { pos, opts, promptText }
  const fanoutCalls = [];            // { pos, kind:'parallel'|'pipeline', axis, width }
  const reduceCalls = [];            // { pos } reduce-ish member calls (not feeding fan-out)
  let earlyExit = false;
  let hasVerdictLiteral = false;
  const allStringLiterals = [];

  // track which `.map`/array nodes feed a parallel/pipeline so we don't count them as reduces
  const fanoutSeedNodes = new Set();

  const visit = (node) => {
    // meta.phases
    if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        if (decl.name && ts.isIdentifier(decl.name) && decl.name.text === 'meta' && decl.initializer && ts.isObjectLiteralExpression(decl.initializer)) {
          const phasesProp = decl.initializer.properties.find(
            (p) => ts.isPropertyAssignment(p) && propName(p) === 'phases',
          );
          if (phasesProp && ts.isPropertyAssignment(phasesProp) && ts.isArrayLiteralExpression(phasesProp.initializer)) {
            for (const el of phasesProp.initializer.elements) {
              if (ts.isObjectLiteralExpression(el)) {
                const title = el.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === 'title');
                if (title && ts.isPropertyAssignment(title)) metaPhases.push(literalString(title.initializer) ?? '');
              }
            }
          }
        }
      }
    }

    if (ts.isStringLiteralLike(node)) {
      allStringLiterals.push(node.text);
      if (VERDICT_TOKENS.includes(node.text)) hasVerdictLiteral = true;
    }

    // early-exit guard: an IfStatement whose then-branch contains a ReturnStatement
    if (ts.isIfStatement(node) && containsReturn(node.thenStatement)) {
      const cond = txt(node.expression);
      if (/\.length|=== *0|! *\w|empty|none|GRAPH-EMPTY|\bnot\b/i.test(cond) || true) {
        // any guarded early return counts (broad heuristic, design doc §3.1 step 4)
        earlyExit = true;
      }
    }

    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // bare-identifier primitives: phase / agent / parallel / pipeline / workflow
      if (ts.isIdentifier(callee)) {
        const name = callee.text;
        if (name === 'phase') {
          phaseMarkers.push({ pos: pos(node), title: literalString(node.arguments[0]) ?? '' });
        } else if (name === 'agent') {
          agentCalls.push({
            pos: pos(node),
            promptText: literalString(node.arguments[0]) ?? txt(node.arguments[0]),
            opts: node.arguments[1] && ts.isObjectLiteralExpression(node.arguments[1]) ? node.arguments[1] : null,
          });
        } else if (name === 'parallel' || name === 'pipeline') {
          const seed = node.arguments[0];
          const { axis, width, seedNode } = arrayAxisWidth(seed, sf, lossy);
          if (seedNode) fanoutSeedNodes.add(seedNode);
          fanoutCalls.push({ pos: pos(node), kind: name, axis, width });
        }
      }
      // member-call reduces: x.filter(...) / x.reduce(...) etc. — but not the .map feeding a fan-out
      if (ts.isPropertyAccessExpression(callee)) {
        const m = callee.name.text;
        if (REDUCE_METHODS.has(m)) reduceCalls.push({ pos: pos(node) });
        // a `.map` that is NOT a fan-out seed is also a reduce-ish transform
        if (m === 'map' && !fanoutSeedNodes.has(node)) {
          // defer: decided after we know seeds (we approximate by skipping map here)
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);

  // ── pass 2: phase regions ──────────────────────────────────────────────────
  // Boundaries come from phase() markers (authoritative; all real scripts emit them and they
  // mirror meta.phases). Fall back to meta.phases as a single region if no markers.
  const markers = phaseMarkers.slice().sort((a, b) => a.pos - b.pos);
  const regions = [];
  if (markers.length > 0) {
    for (let i = 0; i < markers.length; i++) {
      const start = markers[i].pos;
      const end = i + 1 < markers.length ? markers[i + 1].pos : Infinity;
      regions.push({ name: markers[i].title || metaPhases[i] || `phase-${i + 1}`, start, end });
    }
  } else if (metaPhases.length > 0) {
    regions.push({ name: metaPhases[0], start: 0, end: Infinity });
    if (metaPhases.length > 1) lossy.push('no-phase-markers: collapsed multi-phase meta into one region');
  } else {
    regions.push({ name: 'phase-1', start: 0, end: Infinity });
    lossy.push('no-meta-no-markers');
  }

  const inRegion = (p, r) => p >= r.start && p < r.end;
  const phases = regions.map((r) => {
    const fan = fanoutCalls.find((f) => inRegion(f.pos, r));
    const agentsInRegion = agentCalls.filter((a) => inRegion(a.pos, r));
    const mode = fan ? (fan.kind === 'parallel' ? 'parallel-barrier' : 'streaming') : 'sequential';
    const agents = agentsInRegion.map((a) => agentFromOpts(a, sf));
    const phase = {
      name: r.name,
      mode,
      fanOut: fan ? { axis: fan.axis, width: fan.width } : null,
      agents,
    };
    if (mode === 'parallel-barrier') {
      phase.barrierReason = inferBarrierReason(agents, hasVerdictLiteral);
    }
    return phase;
  });

  // ── pass 3: rollups ────────────────────────────────────────────────────────
  const phaseNames = phases.map((p) => p.name);
  const verify = inferVerify(phases, hasVerdictLiteral, allStringLiterals);
  const edges = phaseNames.slice(0, -1).map((n, i) => /** @type {[string,string]} */ ([n, phaseNames[i + 1]]));
  const groundingFirst = /scout|map|cartograph|ground|recon|inventory/i.test(phaseNames[0] || '');
  const allFanOutNoBuild = phases.every((p) => p.fanOut || p.mode !== 'sequential') &&
    !phaseNames.some((n) => /build|implement|merge/i.test(n));

  return makeDecisionPlan({
    pattern: classifyPattern(phaseNames, { groundingFirst, allFanOutNoBuild }),
    qualityPatterns: inferQualityPatterns(phases, verify),
    phases,
    verify,
    reduceSteps: reduceCalls.length,
    earlyExit,
    edges,
    source: 'case1-script',
    extraction: { lossy },
  });
}

// ── helpers ───────────────────────────────────────────────────────────────────

function propName(p) {
  if (!p.name) return null;
  if (ts.isIdentifier(p.name)) return p.name.text;
  if (ts.isStringLiteralLike(p.name)) return p.name.text;
  return null;
}

function literalString(node) {
  if (!node) return null;
  if (ts.isStringLiteralLike(node)) return node.text; // StringLiteral + NoSubstitutionTemplateLiteral
  if (ts.isTemplateExpression(node)) {
    // approximate: head + literal parts, placeholders elided
    return node.head.text + node.templateSpans.map((s) => s.literal.text).join(' ');
  }
  return null;
}

function containsReturn(stmt) {
  let found = false;
  const walk = (n) => {
    if (found) return;
    if (ts.isReturnStatement(n)) { found = true; return; }
    // don't descend into nested functions (their returns aren't this guard's exit)
    if (ts.isFunctionLike(n)) return;
    ts.forEachChild(n, walk);
  };
  if (stmt) walk(stmt);
  return found;
}

/** Extract fan-out axis + width from the array expression a parallel()/pipeline() consumes. */
function arrayAxisWidth(seed, sf, lossy) {
  if (!seed) return { axis: 'unknown', width: 'dynamic', seedNode: null };
  // seed is usually `<arrayExpr>.map(cb)` — descend to the array the .map is called on
  let arrayExpr = seed;
  if (ts.isCallExpression(seed) && ts.isPropertyAccessExpression(seed.expression) && seed.expression.name.text === 'map') {
    arrayExpr = seed.expression.expression;
  } else if (ts.isCallExpression(seed)) {
    // e.g. parallel(items) where items is itself produced by a call — keep as-is
    arrayExpr = seed;
  }
  // unwrap a leading .filter()/.slice() chain to reach the source name
  let cursor = arrayExpr;
  while (ts.isCallExpression(cursor) && ts.isPropertyAccessExpression(cursor.expression)) {
    cursor = cursor.expression.expression;
  }

  const axis = axisName(cursor);
  const width = arrayWidth(arrayExpr);
  if (width === 'dynamic') lossy.push(`dynamic-fanout-width: '${axis}' (runtime-decided; excluded from fanout_width_delta)`);
  return { axis, width, seedNode: seed };
}

function axisName(node) {
  if (!node) return 'unknown';
  if (ts.isPropertyAccessExpression(node)) return node.name.text;                 // breakdown.epics → 'epics'
  if (ts.isIdentifier(node)) return node.text.toLowerCase();                      // DIMENSIONS → 'dimensions'
  if (ts.isCallExpression(node)) {
    // Array.from({length:n}) → 'count'
    if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'from') return 'count';
    return 'computed';
  }
  if (ts.isArrayLiteralExpression(node)) return 'inline-list';
  return 'unknown';
}

function arrayWidth(node) {
  if (!node) return 'dynamic';
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'map') {
    return arrayWidth(node.expression.expression);
  }
  if (ts.isArrayLiteralExpression(node)) return node.elements.length;
  // Array.from({ length: N }, ...)
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'from') {
    const first = node.arguments[0];
    if (first && ts.isObjectLiteralExpression(first)) {
      const len = first.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === 'length');
      if (len && ts.isPropertyAssignment(len) && ts.isNumericLiteral(len.initializer)) return Number(len.initializer.text);
    }
    return 'dynamic';
  }
  return 'dynamic';
}

function agentFromOpts(a, sf) {
  const o = a.opts;
  const get = (name) => {
    if (!o) return null;
    const prop = o.properties.find((p) => ts.isPropertyAssignment(p) && propName(p) === name);
    return prop && ts.isPropertyAssignment(prop) ? prop.initializer : null;
  };
  const label = literalString(get('label'));
  const agentType = literalString(get('agentType'));
  const model = literalString(get('model')) ?? 'default';
  const isoNode = get('isolation');
  const isolation = literalString(isoNode) === 'worktree' ? 'worktree' : 'none';
  const hasSchema = get('schema') != null;
  return {
    role: label || agentType || inferRole(a.promptText),
    hasSchema,
    model,
    isolation,
    agentType: agentType ?? null, // Case 1 scripts rarely set agentType (pipeline-spec §6.1)
  };
}

function inferRole(promptText) {
  if (!promptText) return 'agent';
  return String(promptText).trim().split(/\s+/).slice(0, 6).join(' ').toLowerCase() || 'agent';
}

function inferBarrierReason(agents, hasVerdictLiteral) {
  if (hasVerdictLiteral && agents.some((a) => /refut|review|judge|critic|verif/i.test(a.role))) return 'verify-join';
  return 'fan-out join';
}

function inferVerify(phases, hasVerdictLiteral, strings) {
  const verifyPhase = phases.find((p) => p.agents.some((a) => /refut|review|judge|critic|verif|assess/i.test(a.role)) || /review|refut|critic|verif|assess|judge/i.test(p.name));
  if (!verifyPhase) return { present: false, kind: 'none' };

  // A fanned verify phase has ONE agent() node in source but runs N times → use fan-out, not
  // source-agent-count, as the "multiple verifiers" signal (e.g. fixswarm's refuters).
  const isFanout = verifyPhase.mode === 'parallel-barrier' || verifyPhase.fanOut != null;
  const roleStr = verifyPhase.agents.map((a) => a.role).join(' ');
  const judgey = strings.some((s) => /winner|\bscore\b|\brank\b|\bjudge\b/i.test(s));

  if (hasVerdictLiteral && isFanout && /refut/i.test(roleStr)) return { present: true, kind: 'adversarial' };
  if (judgey && isFanout) return { present: true, kind: 'judge-panel' };
  if (isFanout && verifyPhase.agents.length >= 2) return { present: true, kind: 'perspective-diverse' };
  // a single / sequential verify gate IS present, but matches no named multi-agent pattern
  return { present: true, kind: 'none' };
}

function inferQualityPatterns(phases, verify) {
  const out = new Set();
  if (phases.some((p) => p.fanOut) && phases.length >= 2) out.add('fan-out-and-synthesize');
  if (verify.kind === 'adversarial') out.add('adversarial-verification');
  if (verify.kind === 'perspective-diverse') out.add('perspective-diverse-verify');
  if (verify.kind === 'judge-panel') out.add('tournament');
  return [...out];
}

// ── CLI ─────────────────────────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const fs = await import('node:fs');
  const path = process.argv[2];
  if (!path) { console.error('usage: node case1-to-decision.mjs <workflow.js>'); process.exit(2); }
  const src = fs.readFileSync(path, 'utf8');
  console.log(JSON.stringify(case1ToDecision(src), null, 2));
}
