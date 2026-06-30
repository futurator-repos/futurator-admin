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
/** Normalize a repo-relative path so git-diff output and shard members compare equal. */
const normRel = (s) => String(s || '').replace(/^\.\//, '').replace(/^\/+/, '');

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

/** Deterministic markdown report (no LLM) — used by the cheap 'deterministic' and
 *  'targeted' modes (targeted regenerates the report deterministically over the
 *  merged finding set, so a partial re-run never costs a writer agent). */
function deterministicReport(projectName, findings, phases, maturity, kind = 'deterministic') {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const note =
    kind === 'targeted'
      ? '> Targeted re-scan: a subset of the swarm was re-run and merged into the prior scan; report regenerated deterministically.'
      : '> Deterministic re-scan (no LLM swarm): structural + compliance + infra findings only.';
  const lines = [
    `# ${projectName} — Refactoring & System-Design Scan (${kind})`,
    '',
    note,
    '',
    `## Maturity — overall ${maturity?.overall != null ? Math.round(maturity.overall * 100) + '%' : 'n/a'}`,
    ...(maturity?.axes || []).map((a) => `- ${a.label}: ${a.measured ? a.status : 'unmeasured'} — ${a.detail}`),
    '',
    '## Priority Matrix',
    '| Finding | Severity | Effort | Dimension | Location |',
    '|---|---|---|---|---|',
    ...findings.map((f) => `| ${f.issue} | ${f.severity} | ${f.effort} | ${f.dimension} | ${f.location} |`),
    '',
    '## Recommended Sequencing',
    ...phases.flatMap((p) => [
      `**Phase ${p.phase} — ${p.name}** (${p.tag}) — ${p.why}`,
      ...p.items.slice(0, 30).map((id) => `- ${byId.get(id)?.issue || id}`),
      '',
    ]),
  ];
  return lines.join('\n');
}

/**
 * @param {object} job   AgentJob (jobType 'scan-engine'); scanEnginePayload {projectId,projectPath,src,cap,mode,targets,reuseRecon,autoTargetChanged}
 * @param {object} deps
 *   - runRecon({projectPath, src}) → { code }
 *   - runDecompose({projectPath, cap}) → { code }
 *   - readArtifacts({projectPath, reuseDetectors}) → { hotspots[], shards:{shards[],lowConfidence}, privacySummary?, anchoredPaths:Set<string>, hubs:[{file,inDegree}] }
 *   - spawnAgent({role, prompt}) → string  (agent stdout/output)
 *   - checkGate(planOutput) → violations[]
 *   - readPriorScan() → prior scan.json object | null      (targeted-merge source)
 *   - reconAvailable({projectPath}) → boolean              (can reuse cached recon?)
 *   - changedFiles(sinceSha) → string[] | null             (git diff for auto-target)
 *   - pushEvent(type, data?) / log(level,msg) / concurrency / projectName
 */
export async function runScanEngine(job, deps) {
  const p = job?.scanEnginePayload || {};
  const projectPath = p.projectPath || job?.workingDir;
  const projectName = deps.projectName || p.projectId || 'project';
  const pushEvent = deps.pushEvent || (() => {});
  const log = deps.log || (() => {});
  const concurrency = deps.concurrency || 6;

  // ── Mode resolution ──────────────────────────────────────────────────────
  // 'full'          recon + the whole swarm + an LLM-written report (the default).
  // 'deterministic' recon + detectors + plan, NO LLM swarm/writer (~0 tokens).
  // 'targeted'      reuse the persisted scan.json and re-run only a CHOSEN SUBSET of
  //                 swarm tasks (specific subsystems / cross-cutting passes), merging
  //                 the fresh results in — a few agents instead of ~48. Triggered by
  //                 an explicit `targets[]` OR `autoTargetChanged` (git-diff the
  //                 subsystems whose files moved since the last-scanned SHA).
  const explicitTargets = Array.isArray(p.targets) ? p.targets.filter(Boolean) : [];
  const autoTarget = !!p.autoTargetChanged;
  const targeted = explicitTargets.length > 0 || autoTarget;
  const mode = targeted ? 'targeted' : p.mode === 'deterministic' ? 'deterministic' : 'full';
  // autoTarget refreshes structure (code moved → fresh recon); explicit targets reuse
  // the cached recon by default (you're re-running an LLM pass over unchanged code).
  let reuseRecon = targeted && !autoTarget ? p.reuseRecon !== false : false;

  if (!projectPath) return { ok: false, reason: 'projectPath-missing' };
  pushEvent('scan.started', { projectId: p.projectId, mode });

  // ── (a) Load the prior scan first — targeted merges INTO it ──
  let priorScan = null;
  if (targeted && deps.readPriorScan) priorScan = await deps.readPriorScan();
  const priorFindings = Array.isArray(priorScan?.findings) ? priorScan.findings : [];
  // No prior scan to merge into → there is nothing to preserve, so a "targeted"
  // request degrades to a real full scan (every shard runs) and the user still
  // gets complete output instead of a sparse partial.
  const effectiveTargeted = targeted && !!priorScan;
  if (targeted && !priorScan) {
    log('warn', '[scan-engine] targeted/auto re-scan but no prior scan.json — running a full scan');
    reuseRecon = false;
  }

  // ── (b) recon — reused when targeted+reuseRecon AND the cached artifacts exist;
  //         missing artifacts fall back to a fresh recon (never swarm blind). ──
  const canReuse = reuseRecon && (!deps.reconAvailable || deps.reconAvailable({ projectPath }));
  if (reuseRecon && !canReuse) {
    log('info', '[scan-engine] reuseRecon requested but recon artifacts missing — running fresh recon');
  }
  if (canReuse) {
    pushEvent('scan.recon.reused', {});
  } else {
    const recon = await deps.runRecon({ projectPath, src: p.src });
    if (recon && recon.code !== 0) {
      if (recon.code === 2) return { ok: false, reason: 'graphify-missing' };
      if (recon.code === 3) return { ok: false, reason: 'degenerate-build' };
      return { ok: false, reason: `recon-error-${recon.code}` };
    }
    pushEvent('scan.recon.done', {});
    await deps.runDecompose({ projectPath, cap: p.cap });
  }
  reuseRecon = canReuse; // the EFFECTIVE value from here on

  const art = await deps.readArtifacts({ projectPath, reuseDetectors: reuseRecon });
  const hotspots = art.hotspots || [];
  const shards = art.shards?.shards || [];
  const lowConfidence = !!art.shards?.lowConfidence;
  const anchored = art.anchoredPaths || new Set();
  const hubSet = new Set((art.hubs || []).map((h) => h.file));
  pushEvent('scan.decomposed', { shards: shards.length, analyzed: shards.filter((s) => s.analyze).length, lowConfidence });

  // ── (c) Resolve the target set. Explicit targets pass through; auto-target maps
  //        the git-changed files onto the subsystems that own them. ──
  const targetSet = new Set(explicitTargets);
  if (effectiveTargeted && autoTarget) {
    const sinceSha = priorScan?.scannedSha || null;
    const changed = sinceSha && deps.changedFiles ? await deps.changedFiles(sinceSha) : null;
    if (changed && changed.length) {
      const changedSet = new Set(changed.map(normRel));
      for (const s of shards) {
        if ((s.members || []).some((f) => changedSet.has(normRel(f)))) targetSet.add(s.shardKey);
      }
    }
    pushEvent('scan.autotarget', { sinceSha, changedFiles: changed ? changed.length : 0, targets: [...targetSet] });
  }

  // ── (d-pre) deterministic findings — zero LLM. `producedBy` is the merge key. ──
  const detFindings = [
    ...hotspots.map((h) => hotspotToFinding(h, hubSet)),
    ...(art.privacySummary ? privacyToFindings(art.privacySummary) : []),
  ].map((f) => ({ ...f, producedBy: 'deterministic' }));

  /** Run a set of swarm tasks → flat findings, each stamped with its task key. */
  async function runSwarm(tasks) {
    const perAgent = [];
    await pool(tasks, concurrency, async (t, i) => {
      // Operator cancelled — stop spawning NEW agents (don't burn tokens re-running
      // tasks that will be killed anyway). In-flight children are SIGKILLed by the
      // daemon's abort poller.
      if (deps.shouldAbort && deps.shouldAbort()) { perAgent[i] = []; return; }
      pushEvent('scan.agent.start', { role: t.role, label: t.label });
      const text = await deps.spawnAgent({ role: t.role, prompt: t.prompt });
      const parsed = text && !text.__error ? parseAndValidate(text, t.ctx) : [];
      perAgent[i] = parsed.map((f) => ({ ...f, producedBy: t.ctx.area }));
      pushEvent('scan.agent.done', { role: t.role, label: t.label, findings: parsed.length });
      return text;
    });
    const out = [];
    perAgent.forEach((parsed) => { if (parsed) out.push(...parsed); });
    return out;
  }

  // ── (d) LLM swarm. full → every analyzed shard + all passes. targeted → only the
  //        shards/passes whose key ∈ targetSet. deterministic → none. ──
  let llmFindings = [];
  if (mode !== 'deterministic') {
    const analyzeShards = shards.filter((s) => s.analyze && (!effectiveTargeted || targetSet.has(s.shardKey)));
    const passes = CROSS_CUTTING.filter((pass) => !effectiveTargeted || targetSet.has(pass.area));
    const tasks = [
      ...analyzeShards.map((s) => ({ role: `scan-analyzer:${s.name}`, label: s.name, prompt: analyzerPrompt(s), ctx: { area: s.shardKey } })),
      ...passes.map((pass) => ({
        role: `scan-xcut:${pass.area}`,
        label: pass.title || pass.area,
        prompt: crossCuttingPrompt(pass, seedFor(pass, { hotspots, hubs: art.hubs || [] })),
        ctx: { area: pass.area, dimension: pass.dimension },
      })),
    ];
    pushEvent(effectiveTargeted ? 'scan.targeted.started' : 'scan.swarm.started', {
      agents: tasks.length,
      ...(effectiveTargeted ? { targets: [...targetSet], reuseRecon } : {}),
    });
    llmFindings = await runSwarm(tasks);
    const before = llmFindings.length;
    llmFindings = dropUnanchored(llmFindings, anchored); // hallucination guard
    pushEvent(effectiveTargeted ? 'scan.targeted.done' : 'scan.swarm.done', {
      llmFindings: llmFindings.length,
      droppedUnanchored: before - llmFindings.length,
    });
  } else {
    pushEvent('scan.swarm.skipped', { reason: 'deterministic-mode' });
  }

  // ── (e/f) union + dedupe. Targeted MERGES into the prior scan: keep every prior
  //         finding NOT produced by a re-run task; swap in the fresh results. A
  //         re-run task that now returns ZERO findings → its old findings simply
  //         vanish (= "confirm I fixed these"). ──
  let findings;
  if (effectiveTargeted) {
    const keptLlm = priorFindings.filter((f) => f.source === 'llm' && !targetSet.has(f.producedBy));
    const det = reuseRecon
      ? priorFindings.filter((f) => f.source === 'deterministic')
      : detFindings; // fresh recon → fresh deterministic layer
    findings = dedupe([...det, ...keptLlm, ...llmFindings]);
  } else {
    findings = dedupe([...detFindings, ...llmFindings]);
  }

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

  // (f) aggregator report (markdown). LLM only on a full scan; deterministic AND
  // targeted modes regenerate it deterministically over the (merged) finding set so
  // a partial re-run never costs a writer agent.
  // deterministic + targeted always skip the LLM writer; a cancelled run does too
  // (the result is being thrown away — don't spend a writer agent on it).
  const cheapReport = mode === 'deterministic' || effectiveTargeted || !!(deps.shouldAbort && deps.shouldAbort());
  let reportMarkdown = '';
  if (cheapReport) {
    reportMarkdown = deterministicReport(projectName, findings, plan.phases, maturity, effectiveTargeted ? 'targeted' : 'deterministic');
  } else
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
    mode,
    findings,
    phases: plan.phases,
    planOutput,
    gateViolations,
    reportMarkdown,
    lowConfidence,
    maturity,
    // targeted+reuse may not re-read infra.json — fall back to the prior scan's inventory.
    infra: art.infra || (effectiveTargeted ? priorScan?.infra : null) || null,
    counts: {
      total: findings.length,
      // derived from the MERGED set so targeted re-runs report accurate totals.
      deterministic: findings.filter((f) => f.source === 'deterministic').length,
      llm: findings.filter((f) => f.source === 'llm').length,
      byDimension: countsByDimension(findings),
    },
  };
}

// exported for unit tests
export const _internals = { pool, dedupe, seedFor };
