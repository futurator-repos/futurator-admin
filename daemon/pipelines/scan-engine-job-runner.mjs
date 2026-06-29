// scan-engine-job-runner.mjs — Refactoring Scan Engine v2, B3+B5 orchestration core.
//
// Pure orchestration (all I/O + spawning injected via `deps`) so it unit-tests
// without recon or real agents. The daemon's executeScanEngineJob wires the real
// deps. Flow (design §2): recon → subsystem-decompose → map deterministic
// findings → LLM swarm (per-subsystem + cross-cutting, recon-seeded) →
// anchored-path guard → union+dedupe → phase-planner → char-net gate →
// aggregator report. Deterministic-first: compliance + structure cost zero LLM.

import { hotspotToFinding, privacyToFindings, dropUnanchored, locPath } from './lib/scan-finding-map.mjs';
import { planPhases, toPlanOutput } from './lib/phase-planner.mjs';
import { computeMaturity } from './lib/maturity-score.mjs';
import {
  analyzerPrompt,
  crossCuttingPrompt,
  reportWriterPrompt,
  parseAndValidate,
  CROSS_CUTTING,
} from './lib/scan-engine-prompts.mjs';

/** Bounded-concurrency map over async tasks (preserves order). */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); } catch (e) { out[idx] = { __error: String(e?.message || e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Seed a cross-cutting pass with the deterministic candidate sites it should confirm. */
function seedFor(pass, { hotspots, hubs }) {
  let files = [];
  if (pass.area === 'ui-centralization') {
    files = hotspots.filter((h) => h.kind === 'design-system-consolidation').flatMap((h) => h.files || []);
  }
  if (!files.length) {
    // high-fan-in hubs are where cross-cutting issues concentrate
    files = (hubs || []).slice(0, 12).map((h) => `${h.file} (fan-in ${h.inDegree})`);
  }
  return files.slice(0, 15).map((f) => `- ${f}`).join('\n');
}

const norm = (s) => String(s || '').toLowerCase().split(/\s+/).slice(0, 5).join(' ');

/** Union + collapse duplicates: same file+issue → keep deterministic / higher severity. */
function dedupe(findings) {
  const SEV = ['High', 'Medium', 'Low–Med', 'Low'];
  const rank = (f) => SEV.indexOf(f.severity);
  const byKey = new Map();
  for (const f of findings) {
    const key = `${locPath(f.location)}::${norm(f.issue)}`;
    const prev = byKey.get(key);
    if (!prev) { byKey.set(key, f); continue; }
    // winner: deterministic beats llm; then lower severity-rank (more severe)
    const better =
      (prev.source === 'deterministic') !== (f.source === 'deterministic')
        ? (f.source === 'deterministic' ? f : prev)
        : (rank(f) < rank(prev) ? f : prev);
    const loser = better === f ? prev : f;
    better.overlaps = [...new Set([...(better.overlaps || []), loser.id])];
    byKey.set(key, better);
  }
  return [...byKey.values()];
}

function countsByDimension(findings) {
  const c = {};
  for (const f of findings) c[f.dimension] = (c[f.dimension] || 0) + 1;
  return c;
}

/**
 * @param {object} job   AgentJob (jobType 'scan-engine'); scanEnginePayload {projectId,projectPath,src,cap}
 * @param {object} deps
 *   - runRecon({projectPath, src}) → { code }
 *   - runDecompose({projectPath, cap}) → { code }
 *   - readArtifacts({projectPath}) → { hotspots[], shards:{shards[],lowConfidence}, privacySummary?, anchoredPaths:Set<string>, hubs:[{file,inDegree}] }
 *   - spawnAgent({role, prompt}) → string  (agent stdout/output)
 *   - checkGate(planOutput) → violations[]
 *   - pushEvent(type, data?) / log(level,msg) / concurrency / projectName
 */
export async function runScanEngine(job, deps) {
  const p = job?.scanEnginePayload || {};
  const projectPath = p.projectPath || job?.workingDir;
  const projectName = deps.projectName || p.projectId || 'project';
  const pushEvent = deps.pushEvent || (() => {});
  const log = deps.log || (() => {});
  const concurrency = deps.concurrency || 6;
  if (!projectPath) return { ok: false, reason: 'projectPath-missing' };

  pushEvent('scan.started', { projectId: p.projectId });

  // (b) recon — reused. Trust gate on exit code.
  const recon = await deps.runRecon({ projectPath, src: p.src });
  if (recon && recon.code !== 0) {
    if (recon.code === 2) return { ok: false, reason: 'graphify-missing' };
    if (recon.code === 3) return { ok: false, reason: 'degenerate-build' };
    return { ok: false, reason: `recon-error-${recon.code}` };
  }
  pushEvent('scan.recon.done', {});

  // (c) subsystem decomposition.
  await deps.runDecompose({ projectPath, cap: p.cap });
  const art = await deps.readArtifacts({ projectPath });
  const hotspots = art.hotspots || [];
  const shards = art.shards?.shards || [];
  const lowConfidence = !!art.shards?.lowConfidence;
  const anchored = art.anchoredPaths || new Set();
  const hubSet = new Set((art.hubs || []).map((h) => h.file));
  pushEvent('scan.decomposed', { shards: shards.length, analyzed: shards.filter((s) => s.analyze).length, lowConfidence });

  // (d-pre) deterministic findings — zero LLM.
  const detFindings = [
    ...hotspots.map((h) => hotspotToFinding(h, hubSet)),
    ...(art.privacySummary ? privacyToFindings(art.privacySummary) : []),
  ];

  // (d) LLM swarm — analyzers for analyzed shards + cross-cutting passes.
  const analyzeShards = shards.filter((s) => s.analyze);
  const tasks = [
    ...analyzeShards.map((s) => ({ role: `scan-analyzer:${s.name}`, prompt: analyzerPrompt(s), ctx: { area: s.shardKey } })),
    ...CROSS_CUTTING.map((pass) => ({
      role: `scan-xcut:${pass.area}`,
      prompt: crossCuttingPrompt(pass, seedFor(pass, { hotspots, hubs: art.hubs || [] })),
      ctx: { area: pass.area, dimension: pass.dimension },
    })),
  ];
  pushEvent('scan.swarm.started', { agents: tasks.length });
  const outputs = await pool(tasks, concurrency, (t) => deps.spawnAgent({ role: t.role, prompt: t.prompt }));
  let llmFindings = [];
  outputs.forEach((text, i) => {
    if (text && !text.__error) llmFindings.push(...parseAndValidate(text, tasks[i].ctx));
  });
  const before = llmFindings.length;
  llmFindings = dropUnanchored(llmFindings, anchored); // hallucination guard
  pushEvent('scan.swarm.done', { llmFindings: llmFindings.length, droppedUnanchored: before - llmFindings.length });

  // (e/f) union + dedupe.
  const findings = dedupe([...detFindings, ...llmFindings]);

  // Maturity scorecard — the high-level RAG overview (deterministic, ~0 LLM).
  const maturity = computeMaturity({
    findings,
    hotspots,
    tests: art.tests || null,
    eslint: art.eslint || null,
    graphAvailable: anchored.size > 0,
    knipRan: !!art.knipRan,
    sdd: art.sdd || null,
  });
  pushEvent('scan.maturity', { overall: maturity.overall });

  // (g) phased plan + char-net gate.
  const plan = planPhases(findings);
  const byId = new Map(findings.map((f) => [f.id, f]));
  const planOutput = toPlanOutput(plan, byId);
  const gateViolations = deps.checkGate ? deps.checkGate(planOutput) : [];
  if (gateViolations.length) log('warn', `[scan-engine] ${gateViolations.length} characterization-gate violation(s) — review before executing`);
  pushEvent('scan.planned', { phases: plan.phases.length, gateViolations: gateViolations.length });

  // (f) aggregator report (markdown).
  let reportMarkdown = '';
  try {
    reportMarkdown = await deps.spawnAgent({
      role: 'scan-report-writer',
      prompt: reportWriterPrompt({ projectName, findings, phases: plan.phases, lowConfidence }),
    });
  } catch (e) {
    log('warn', `[scan-engine] report writer failed: ${e?.message || e}`);
  }
  pushEvent('scan.report.done', { bytes: (reportMarkdown || '').length });

  return {
    ok: true,
    findings,
    phases: plan.phases,
    planOutput,
    gateViolations,
    reportMarkdown,
    lowConfidence,
    maturity,
    infra: art.infra || null,
    counts: {
      total: findings.length,
      deterministic: detFindings.length,
      llm: llmFindings.length,
      byDimension: countsByDimension(findings),
    },
  };
}

// exported for unit tests
export const _internals = { pool, dedupe, seedFor };
