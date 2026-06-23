/**
 * refactor-audit-job-runner.mjs — Refactoring Assessment Module (Epic B2).
 *
 * Daemon-side runner for a PENDING `jobType: 'refactor-audit'` row. UNLIKE the
 * reflector / scorecard-assess runners, this is NOT an agent step — the recon
 * stage is DETERMINISTIC and spends ~0 LLM tokens. The runner orchestrates a
 * plain `recon.mjs` Node child:
 *
 *   1. Validate the job-row shape (validateRefactorAuditJob).
 *   2. Emit `assess.started`.
 *   3. Run `recon.mjs` (injected `deps.runRecon`) streaming chunks → the runner
 *      detects stage transitions from recon's `▶ <cmd>` markers and emits
 *      `assess.step.started` / `assess.step.output` per stage (graphify → knip →
 *      alias-resolve → hotspot-detect).
 *   4. On a non-zero exit, classify the failure (graphify-missing / degenerate-
 *      build / recon-error) and emit `assess.failed` + an attention item.
 *   5. On success, read `graphify-out/hotspots.json` + `REPORT.md` (injected
 *      `deps.readArtifacts`), emit `assess.completed{ hotspotCount, counts,
 *      reportPath }`, and return the counts for the job-row summary.
 *
 * The runner triggers nothing else — Create-plan (Epic D3) and the optional L3
 * adjudication (Epic C) are separate, operator-gated steps.
 *
 * Test mode: every effect (`runRecon`, `readArtifacts`, `pushEvent`,
 * `writeAttentionItem`) is injected, so unit tests exercise the routing +
 * step-detection + failure classification without spawning a process or
 * touching DDB. Production wiring lives in `agent-daemon.mjs::executeRefactorAuditJob`.
 */

/** The four deterministic recon stages, in order. */
export const ASSESS_STEPS = ['graphify', 'knip', 'alias-resolve', 'hotspot-detect'];

/** Cap a streamed chunk before it goes into a DDB event row. */
const MAX_CHUNK = 4000;

/**
 * Validate the job-row shape. Mirrors validateScorecardAssessJob /
 * validatePartyBootstrapJob so the daemon can reject malformed jobs with a
 * clear reason.
 *
 * @param {object} job
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateRefactorAuditJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'refactor-audit') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.refactorAuditPayload;
  if (!p || typeof p !== 'object') return { ok: false, reason: 'refactorAuditPayload-missing' };
  if (typeof p.projectId !== 'string' || p.projectId.length === 0) {
    return { ok: false, reason: 'projectId-missing' };
  }
  if (typeof p.projectPath !== 'string' || p.projectPath.length === 0) {
    return { ok: false, reason: 'projectPath-missing' };
  }
  return { ok: true };
}

/**
 * Detect which recon stage a streamed line belongs to, from recon.mjs's
 * `▶ <cmd>` markers. Returns one of ASSESS_STEPS or null (not a stage line).
 */
export function detectStep(line) {
  if (typeof line !== 'string') return null;
  if (!line.includes('▶')) return null;
  if (/graphify-build\.py/.test(line)) return 'graphify';
  if (/\bknip\b/.test(line)) return 'knip';
  if (/alias-resolve\.mjs/.test(line)) return 'alias-resolve';
  if (/hotspot-detect\.mjs/.test(line)) return 'hotspot-detect';
  return null;
}

/**
 * Classify a recon exit code into a stable `assess.failed` reason.
 *   2 → graphify-missing (recon.mjs process.exit(2))
 *   3 → degenerate-build (graphify-build.py exit 3, re-raised by recon.mjs)
 *   * → recon-error (any other thrown failure)
 */
export function classifyReconFailure(code) {
  if (code === 2) return 'graphify-missing';
  if (code === 3) return 'degenerate-build';
  return 'recon-error';
}

/**
 * Build the terminal event for the runner. Pure so tests can assert the shape.
 */
export function buildAssessEvent(kind, data = {}) {
  if (kind === 'completed') {
    return {
      eventType: 'assess.completed',
      payload: {
        hotspotCount: data.hotspotCount ?? 0,
        counts: data.counts ?? {},
        reportPath: data.reportPath ?? null,
        ...(data.auditId ? { auditId: data.auditId } : {}),
      },
    };
  }
  if (kind === 'failed') {
    return {
      eventType: 'assess.failed',
      payload: { reason: data.reason ?? 'recon-error', message: String(data.message ?? '').slice(0, 1500) },
    };
  }
  return { eventType: 'assess.started', payload: { projectId: data.projectId } };
}

// ── Epic C: optional L3 adjudication (the agentic stage after recon) ──
// The daemon path uses a SELF-CONTAINED inline prompt (the .claude workflow +
// version-adjudicator agent are the operator-invocable local equivalents, not
// shipped to the EC2 box). A single agent reads the hotspots + code, adversarially
// confirms/rejects each, and judges the confirmed set into a planOutputSchema plan.

/** Build the inline L3 adjudication prompt. Pure. */
export function buildL3Prompt(hotspots, topN = 40) {
  const top = (hotspots || []).slice(0, topN);
  return `You are the L3 refactoring adjudicator + judge. You are in a migrated brownfield repo;
\`graphify-out/\` holds the deterministic recon artifacts. A detector flagged these ${top.length} hotspots:

${JSON.stringify(top, null, 2)}

For EACH hotspot, ADVERSARIALLY verify it from the actual code (Read/Grep/Glob the implicated files +
their real importers; prefer graphify-out/graph.resolved.json + resolved-imports.json for trustworthy
fan-in — raw graph in-degree is NOT reliable on alias-heavy code). The detector has known blind spots
(unresolved @/ aliases, AST-blind JSX/instance dispatch, filename collisions that look like duplication).
The canonical false-positive: a 'primitives' dir flagged as a duplicate design system was actually a
separate CV-export rendering layer — REJECT findings you cannot prove from code. Default to skepticism.

Then FUSE the CONFIRMED findings (exclude rejected ones) into a draft plan. Sequence every refactor as a
Strangler-Fig: extract shared core → repoint dependents → delete old path (deletion dependsOn its
extract/repoint). Add a characterization-net (Playwright) story BEFORE any deletion/repoint on a route
lacking tests. touchPoints MUST be REAL existing relative paths (or <EPIC_WIDE>); never package.json/
tsconfig/lockfiles/absolute paths. Each story ≥1 criterion; UI-bearing → ≥1 needsBrowser:true. name is
kebab-case; description ≥20 chars; ids E1.., S1.. dependsOn earlier siblings only.

End your reply with EXACTLY this block and nothing after:

---L3---
{
  "verdicts": [{ "hotspotTitle": "...", "kind": "...", "verdict": "confirmed"|"rejected", "rationale": "...", "confidence": 0.0 }],
  "plan": { "plan": { "name": "...", "description": "...", "epics": [ { "id": "E1", "title": "...", "goal": "...", "stories": [ { "id": "S1", "touchPoints": ["..."], "criteria": [ { "id": "AC1", "text": "...", "needsBrowser": false } ] } ] } ] } }
}
---END_L3---

If every hotspot is rejected, emit "plan": null.`;
}

/** Parse the agent's ---L3--- block into { verdicts, confirmed, plan }. Pure. */
export function parseL3Output(text) {
  const out = { verdicts: [], confirmed: [], plan: null };
  if (!text || typeof text !== 'string') return out;
  const m = text.match(/---L3---\s*([\s\S]*?)\s*---END_L3---/);
  const raw = m ? m[1] : text;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // tolerate a trailing-prose wrapper: grab the outermost {...}
    const brace = raw.match(/\{[\s\S]*\}/);
    if (!brace) return out;
    try { parsed = JSON.parse(brace[0]); } catch { return out; }
  }
  out.verdicts = Array.isArray(parsed?.verdicts) ? parsed.verdicts : [];
  out.confirmed = out.verdicts.filter((v) => v && v.verdict === 'confirmed');
  out.plan = parsed?.plan ?? null;
  return out;
}

/**
 * Run the L3 adjudication stage. Spawns ONE agent (the LLM-spend path) via the
 * injected runL3Agent, parses its output, and returns the structured result.
 *
 * @param {object} job
 * @param {AuditHotspot[]} hotspots  the recon hotspots (from the job summary)
 * @param {{ runL3Agent: (prompt: string) => Promise<{ output: string }>,
 *           topN?: number, pushEvent?: Function }} deps
 * @returns {Promise<{ ok: boolean, verdicts: object[], confirmed: object[], plan: any, error?: string }>}
 */
export async function runL3Adjudication(job, hotspots, deps) {
  const topN = deps?.topN ?? job?.refactorAuditPayload?.topN ?? 40;
  const prompt = buildL3Prompt(hotspots, topN);
  let res;
  try {
    res = await deps.runL3Agent(prompt);
  } catch (err) {
    return { ok: false, verdicts: [], confirmed: [], plan: null, error: String(err?.message || err) };
  }
  const parsed = parseL3Output(res?.output || '');
  const gateViolations = findCharacterizationGateViolations(parsed.plan);
  return { ok: true, ...parsed, gateViolations };
}

// ── Epic E1: characterization-net gate ──
// A deletion/repoint story is dangerous on a no-test app. This deterministic
// check scans a generated planOutput and flags any deletion/repoint story that
// does NOT (transitively, within its epic) depend on a characterization-net
// story (a thin Playwright net authored first). It's a guard rail on the L3
// plan — the dev pipeline is what actually enforces tests-before-mutation at
// run time (E2), but flagging here catches a mis-sequenced plan before it ships.

const DELETION_RE = /\b(delete|remove|drop|retire|repoint|consolidat|migrat|extract)\b/i;
const CHAR_NET_RE = /\b(characteriz|playwright|test net|e2e|smoke|golden|snapshot|baseline test)\b/i;

/**
 * @param {any} planOutput  a { plan: { epics: [{ stories: [...] }] } } tree
 * @returns {Array<{ epicId: string, storyId: string, reason: string }>}
 */
export function findCharacterizationGateViolations(planOutput) {
  const epics = planOutput?.plan?.epics;
  if (!Array.isArray(epics)) return [];
  const violations = [];
  for (const epic of epics) {
    const stories = Array.isArray(epic?.stories) ? epic.stories : [];
    // ids of stories that ARE a characterization net (by title/criteria text).
    const netIds = new Set(
      stories
        .filter((s) => {
          const text = `${s?.title || ''} ${(s?.criteria || []).map((c) => c?.text || '').join(' ')}`;
          return CHAR_NET_RE.test(text) || (s?.criteria || []).some((c) => c?.needsBrowser);
        })
        .map((s) => s.id),
    );
    for (const s of stories) {
      const text = `${s?.title || ''} ${(s?.criteria || []).map((c) => c?.text || '').join(' ')}`;
      const isMutator = DELETION_RE.test(text);
      if (!isMutator || netIds.has(s.id)) continue;
      const deps = Array.isArray(s?.dependsOn) ? s.dependsOn : [];
      const guardedByNet = deps.some((d) => netIds.has(d));
      // a net story anywhere earlier in the epic also counts (sequenced before).
      const hasAnyNet = netIds.size > 0;
      if (!guardedByNet && !hasAnyNet) {
        violations.push({
          epicId: epic.id,
          storyId: s.id,
          reason: 'deletion/repoint story with no characterization-net dependency or sibling',
        });
      }
    }
  }
  return violations;
}

/**
 * @param {object} job  the AgentJob row (jobType 'refactor-audit')
 * @param {{
 *   paused?: boolean,
 *   runRecon: (args: { projectPath: string, src?: string, skipGraphify?: boolean,
 *                       onChunk: (stream: 'stdout'|'stderr', data: string) => void })
 *             => Promise<{ code: number, killed?: boolean, stderrTail?: string }>,
 *   readArtifacts: (args: { projectPath: string })
 *             => Promise<{ hotspotCount: number, counts: Record<string, number>, reportPath: string }>,
 *   pushEvent?: (jobId: string, stepId: string, agentId: string, eventType: string, data: object) => Promise<void>,
 *   writeAttentionItem?: (item: object) => Promise<void>,
 * }} deps
 * @returns {Promise<{ ok: boolean, status?: string, reason?: string, error?: string,
 *                     hotspotCount?: number, counts?: object, reportPath?: string }>}
 */
export async function runRefactorAuditJob(job, deps) {
  const validation = validateRefactorAuditJob(job);
  if (!validation.ok) return { ok: false, reason: `validation: ${validation.reason}` };

  // Gate behind agent.paused like the other runners; the daemon re-enqueues.
  if (deps?.paused === true) return { ok: true, status: 'gated', reason: 'agent.paused' };

  const { jobId } = job;
  const { projectId, projectPath, src, skipGraphify } = job.refactorAuditPayload;
  const emit = async (eventType, data) => {
    if (typeof deps.pushEvent === 'function') {
      await deps.pushEvent(jobId, `assess.${eventType.split('.')[1] || 'step'}`, 'RECON', eventType, data);
    }
  };

  await emit('assess.started', { projectId });

  // Stream chunks → detect stage transitions → emit per-stage events.
  let currentStep = null;
  let buffered = '';
  const onChunk = (stream, data) => {
    const text = String(data ?? '');
    // stage detection runs line-wise so a marker split across chunks is still caught.
    buffered += text;
    let nl;
    while ((nl = buffered.indexOf('\n')) >= 0) {
      const line = buffered.slice(0, nl);
      buffered = buffered.slice(nl + 1);
      const step = detectStep(line);
      if (step && step !== currentStep) {
        currentStep = step;
        void emit('assess.step.started', { step });
      }
    }
    void emit('assess.step.output', {
      step: currentStep ?? 'recon',
      stream,
      data: text.slice(0, MAX_CHUNK),
    });
  };

  let recon;
  try {
    recon = await deps.runRecon({ projectPath, src, skipGraphify, onChunk });
  } catch (err) {
    const message = String(err?.message || err);
    await emit('assess.failed', { reason: 'recon-error', message });
    await deps.writeAttentionItem?.({
      projectId,
      severity: 'medium',
      category: 'other',
      title: `Refactor audit recon threw for ${projectId}`,
      body: message.slice(0, 1500),
      dedupKey: `refactor-audit-recon-threw:${projectId}`,
    });
    return { ok: false, reason: 'recon-threw', error: message };
  }

  const code = recon?.code ?? 1;
  if (code !== 0) {
    const reason = classifyReconFailure(code);
    const message = recon?.killed
      ? 'recon child was killed (timeout)'
      : recon?.stderrTail || `recon exited ${code}`;
    await emit('assess.failed', { reason, message });
    await deps.writeAttentionItem?.({
      projectId,
      severity: 'medium',
      category: 'other',
      title: `Refactor audit failed (${reason}) for ${projectId}`,
      body: String(message).slice(0, 1500),
      dedupKey: `refactor-audit-failed:${reason}:${projectId}`,
    });
    return { ok: false, reason, error: String(message) };
  }

  // Success → read the machine + human artifacts.
  let artifacts;
  try {
    artifacts = await deps.readArtifacts({ projectPath });
  } catch (err) {
    const message = String(err?.message || err);
    await emit('assess.failed', { reason: 'recon-error', message: `artifact read failed: ${message}` });
    await deps.writeAttentionItem?.({
      projectId,
      severity: 'medium',
      category: 'other',
      title: `Refactor audit produced no readable hotspots.json for ${projectId}`,
      body: message.slice(0, 1500),
      dedupKey: `refactor-audit-artifacts:${projectId}`,
    });
    return { ok: false, reason: 'artifacts-unreadable', error: message };
  }

  const hotspotCount = artifacts?.hotspotCount ?? 0;
  const counts = artifacts?.counts ?? {};
  const hotspots = Array.isArray(artifacts?.hotspots) ? artifacts.hotspots : [];
  const reportPath = artifacts?.reportPath ?? null;

  // The completed EVENT stays lean (counts only — events have a 7-day TTL and a
  // size budget); the full array travels on the durable job-row summary.
  await emit('assess.completed', { hotspotCount, counts, reportPath });

  return { ok: true, status: 'completed', hotspotCount, counts, hotspots, reportPath };
}
