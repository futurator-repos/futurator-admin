/**
 * privacy-audit-job-runner.mjs — Data Privacy Assessment lane (sibling to the
 * refactoring recon). Runs the LOCAL privacy-recon.mjs on the EC2 clone: it
 * fetches the tier rulepack from the live service (rules in), scans the clone
 * in place, and writes findings to a local --out file (only findings out — the
 * SOURCE NEVER LEAVES THE BOX). This runner spawns it as a plain Node child
 * (deterministic, ~0 LLM tokens — no spawnGateAgent), parses the output, and
 * caps/groups the (potentially huge, ~10k) finding set for transport.
 *
 * Report-only · decision-support, not legal advice.
 *
 * Pure + dependency-injected: deps.runPrivacy spawns the child, deps.readReport
 * reads the --out JSON, deps.pushEvent streams events. Unit-testable without a
 * process or DDB.
 */

/** Cap per regulation for the row/UI; the full set is uploaded to S3 for export. */
export const PRIVACY_TOP_PER_REG = 80;

export function validatePrivacyAuditJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.refactorAuditPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'refactorAuditPayload-missing' };
  if (typeof p.projectPath !== 'string' || !p.projectPath) {
    return { ok: false, reason: 'projectPath-missing' };
  }
  return { ok: true };
}

/** Classify a privacy-recon exit code into a stable failure reason. */
export function classifyPrivacyFailure(code, stderrTail = '') {
  if (/rulepack fetch failed/i.test(stderrTail)) return 'rulepack-fetch-failed';
  if (/unauthor|401|403/i.test(stderrTail)) return 'auth-failed';
  return 'privacy-error';
}

/**
 * Reduce a raw privacy report into the capped, grouped summary that rides the
 * job row + durable record. Keeps full counts (by regulation/severity/category)
 * but only the top-N hotspots per regulation (by score). Pure.
 */
export function summarizePrivacyReport(report) {
  const regulations = Array.isArray(report?.regulations) ? report.regulations : [];
  const byRegulation = {};
  let totalAll = 0;
  for (const reg of regulations) {
    const slice = report.by_regulation?.[reg] || {};
    const all = Array.isArray(slice.hotspots) ? slice.hotspots : [];
    totalAll += all.length;
    // counts by category (for honest grouping even though we cap the list)
    const byCategory = {};
    for (const h of all) byCategory[h.category || 'uncategorized'] = (byCategory[h.category || 'uncategorized'] || 0) + 1;
    const top = [...all].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).slice(0, PRIVACY_TOP_PER_REG);
    byRegulation[reg] = {
      scannedFiles: slice.scanned_files ?? 0,
      summary: slice.summary || {},
      detectedCount: all.length,
      shownCount: top.length,
      byCategory,
      hotspots: top,
    };
  }
  return {
    tier: report?.tier ?? 'unknown',
    rulepackVersion: report?.rulepack_version ?? null,
    cardsLoaded: report?.cards_loaded ?? 0,
    regulations,
    totalDetected: totalAll,
    durationMs: report?.duration_ms ?? null,
    byRegulation,
  };
}

/**
 * @param {object} job
 * @param {{ runPrivacy: (args:{projectPath,outPath,onChunk}) => Promise<{code,stderrTail?,killed?}>,
 *           readReport: (outPath:string) => Promise<object>,
 *           pushEvent?: Function, paused?: boolean }} deps
 */
export async function runPrivacyAuditJob(job, deps) {
  const v = validatePrivacyAuditJob(job);
  if (!v.ok) return { ok: false, reason: `validation: ${v.reason}` };
  if (deps?.paused === true) return { ok: true, status: 'gated', reason: 'agent.paused' };

  const { jobId } = job;
  const { projectPath } = job.refactorAuditPayload;
  const outPath = `/tmp/privacy-${jobId}.json`;
  const emit = (eventType, data) =>
    typeof deps.pushEvent === 'function'
      ? deps.pushEvent(jobId, 'privacy', 'PRIVACY', eventType, data)
      : Promise.resolve();

  // serviceHost — host only (never the key), so the log shows WHERE rules came
  // from without leaking the token. The 3rd-party boundary is auditable.
  const serviceHost = (() => {
    try { return deps?.serviceUrl ? new URL(deps.serviceUrl).host : null; } catch { return deps?.serviceUrl ?? null; }
  })();
  await emit('privacy.started', { projectPath, serviceHost });
  // Audit the data boundary BEFORE the run: only rules cross in, only findings
  // (to a LOCAL file) cross out — the source code never leaves the box.
  await emit('privacy.transfer', {
    direction: 'boundary',
    note: serviceHost
      ? `outbound: GET ${serviceHost}/v1/rulepack (rules in) · source code NOT transmitted · findings written to ${outPath} (local)`
      : 'no service configured — using bundled rulepack (no network)',
  });

  let run;
  try {
    run = await deps.runPrivacy({
      projectPath,
      outPath,
      onChunk: (stream, data) =>
        void emit('privacy.step.output', { stream, data: String(data).slice(0, 4000) }),
    });
  } catch (err) {
    const message = String(err?.message || err);
    await emit('privacy.failed', { reason: 'privacy-error', message });
    return { ok: false, reason: 'privacy-threw', error: message };
  }

  const code = run?.code ?? 1;
  if (code !== 0) {
    const reason = classifyPrivacyFailure(code, run?.stderrTail || '');
    const message = run?.killed ? 'privacy-recon killed (timeout)' : run?.stderrTail || `exit ${code}`;
    await emit('privacy.failed', { reason, message: String(message).slice(0, 1500) });
    return { ok: false, reason, error: String(message) };
  }

  let report;
  try {
    report = await deps.readReport(outPath);
  } catch (err) {
    const message = String(err?.message || err);
    await emit('privacy.failed', { reason: 'privacy-error', message: `report read failed: ${message}` });
    return { ok: false, reason: 'report-unreadable', error: message };
  }

  const summary = summarizePrivacyReport(report);
  // Audit the inbound transfer that actually happened: which rulepack came back
  // from the 3rd party (source URL, version, tier, card count) — traceability.
  await emit('privacy.rulepack', {
    source: report?.rulepack_source ?? null,
    version: report?.rulepack_version ?? null,
    tier: report?.tier ?? null,
    cards: report?.cards_loaded ?? 0,
  });
  // Per-regulation finding counts (so the log shows the result breakdown, not
  // just a total).
  for (const reg of summary.regulations) {
    const s = summary.byRegulation[reg];
    if (s) await emit('privacy.regulation', { regulation: reg, detected: s.detectedCount, scannedFiles: s.scannedFiles });
  }
  await emit('privacy.completed', {
    totalDetected: summary.totalDetected,
    tier: summary.tier,
    regulations: summary.regulations,
    durationMs: summary.durationMs,
  });
  return { ok: true, status: 'completed', summary, report, outPath };
}
