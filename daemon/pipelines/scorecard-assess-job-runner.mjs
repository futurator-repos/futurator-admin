/**
 * scorecard-assess-job-runner.mjs — Plan Retrospect / The Assessor
 * (plan-retrospect-spec §4b, 2026-06-18).
 *
 * Daemon-side runner for a PENDING `jobType: 'scorecard-assess'` row. The
 * Assessor is a single-shot *read → grade → emit-JSON* agent, the exact same
 * shape as REFLECTOR (`reflector-job-runner.mjs`) and SKILL-SCOUT
 * (`skill-scout-job-runner.mjs`) — NOT the concept-gen autopilot pipeline. This
 * module is modelled on `reflector-job-runner.mjs`:
 *
 *   1. Validate the job-row shape (validateScorecardAssessJob).
 *   2. Load the STORED deterministic slice for the stage (the API computed +
 *      stored the deterministic half before enqueueing this job). This is the
 *      ground-truth context the Assessor is told to treat as authoritative —
 *      the §4b "never invent metrics" guard (Q-C8 applied reflexively).
 *   3. Build the templated Assessor prompt (buildAssessorPrompt): Role + the
 *      stage's [LLM] rubric slice + deterministic context + the stage artifact
 *      read-set + the §0.5 output contract (one object per [LLM] criterion,
 *      each with a VERBATIM evidence quote — an Assessor score with no citable
 *      quote is itself a `[needs-instrumentation]` red).
 *   4. Spawn the Claude CLI the same way reflector/skill-scout do (the injected
 *      `runAgentStep`, which the daemon wires to `spawnGateAgent`/`executeStep`
 *      so events stream and `StoryLiveOutput` renders the Assessor like any
 *      other agent).
 *   5. Parse the emitted JSON into §0.5-shape substage objects
 *      (parseAssessorOutput), normalize them into `ScorecardSlice`-shaped
 *      Assessor slices, and persist via the injected `writeAssessorSlices`.
 *   6. Trigger nothing else — the composer (§4c) runs API-side on read.
 *
 * Honesty (the feature's core credibility, spec §4a/§4b): a [LLM] criterion the
 * agent could not ground in a verbatim quote is emitted with verdict `⚪` and a
 * `[needs-instrumentation: …]` note — NEVER a fabricated score. parseAssessorOutput
 * enforces this: a graded criterion missing a non-empty `evidence` quote is
 * downgraded to `⚪`.
 *
 * Test mode: every effectful dep (`loadDeterministicSlice`, `runAgentStep`,
 * `writeAssessorSlices`, `pushEvent`, `writeAttentionItem`) is injected, so unit
 * tests exercise the routing without spawning Claude or touching DDB. Production
 * wiring lives in `agent-daemon.mjs::executeScorecardAssessJob` (the human adds
 * the jobType dispatch branch + the classifyAgentForSpend line — see the report).
 */

const STAGES = new Set(['concept', 'development', 'qa', 'deployment', 'publish', 'overview']);

/**
 * Validate the job-row shape. Mirrors validateReflectorJob /
 * validateSkillScoutJob so the daemon can reject malformed jobs at dispatch
 * time with a clear reason.
 *
 * @param {object} job
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function validateScorecardAssessJob(job) {
  if (!job || typeof job !== 'object') return { ok: false, reason: 'job-missing' };
  if (job.jobType !== 'scorecard-assess') return { ok: false, reason: 'jobType-mismatch' };
  if (!job.jobId) return { ok: false, reason: 'jobId-missing' };
  const p = job.scorecardAssessPayload;
  if (!p || typeof p !== 'object') {
    return { ok: false, reason: 'scorecardAssessPayload-missing' };
  }
  if (typeof p.planId !== 'string' || p.planId.length === 0) {
    return { ok: false, reason: 'planId-missing' };
  }
  if (!STAGES.has(p.stage)) return { ok: false, reason: 'stage-invalid' };
  if (typeof p.rubricVersion !== 'string' || p.rubricVersion.length === 0) {
    return { ok: false, reason: 'rubricVersion-missing' };
  }
  return { ok: true };
}

/**
 * The §0.6 [LLM] criteria per stage. The Assessor grades ONLY these — the DET
 * rows were already scored deterministically and are passed in as authoritative
 * context. Kept as a small local table (rather than importing the TS
 * criteria-meta) so this module stays cleanly `.mjs` with no cross-package
 * static import; the daemon may inject `ctx.llmCriteriaForStage` to override
 * from the compiled CRITERIA_META once that is wired (single source of truth).
 *
 * Source: functions/shared/scorecard/criteria-meta.ts (engine === 'LLM').
 */
export const LLM_CRITERIA_BY_STAGE = {
  concept: ['C-R1', 'C-D1', 'C-D2', 'C-D3', 'C-P1', 'C-P2', 'C-G1'],
  development: ['D-TA1', 'D-DV1', 'D-DV2', 'D-DV3', 'D-RV1', 'D-VQ2'],
  qa: ['Q-C1', 'Q-C2', 'Q-C3', 'Q-C4', 'Q-C8'],
  deployment: [],
  publish: [],
  overview: ['OV9'],
};

/**
 * Resolve the stage's [LLM] criterion ids. Prefers an injected resolver (the
 * daemon can wire the compiled CRITERIA_META so this never drifts); falls back
 * to the local table above.
 */
function llmCriteriaForStage(stage, ctx) {
  if (typeof ctx?.llmCriteriaForStage === 'function') {
    const ids = ctx.llmCriteriaForStage(stage);
    if (Array.isArray(ids)) return ids;
  }
  return LLM_CRITERIA_BY_STAGE[stage] || [];
}

/**
 * The stage artifact read-set descriptions (spec §4b table). Pure prose for the
 * prompt — the agent reads these from the working dir with Read/Grep/Glob.
 */
const STAGE_READSET = {
  concept:
    'concept/<kind>.md + <kind>.sections.json, the plan PRD/UX/architecture docs, the epic/story tree, the concept gate card.',
  development:
    'story diffs (git log/show on the plan branch), review event notes, the authored visualTests (flow/assert/level), the ship-contract touchPoints.',
  qa: 'the qa-report (claims table + per-test rationale), the verdict strip, the remediation decisions. (VQA PNGs only in Phase-3 depth mode — not this run.)',
  deployment:
    'the deploy report, the DEPLOY agent log (config edits), the deploy-targets resolution.',
  publish: 'the publish log, the S3 write paths vs the 4-path CLAUDE.md allowlist.',
  overview: 'the reflections inbox / reflection rows and the cross-stage plan summary.',
};

/**
 * Build the Assessor agent prompt (spec §4b "Prompt structure").
 *
 * @param {{
 *   stage: string,
 *   rubricVersion: string,
 *   criterionIds: string[],
 *   rubricSlice: string,         // pre-rendered [LLM]-criteria rubric text (anchors + 0-4 scale + tags)
 *   deterministicContext: string,// pre-rendered DeterministicSlice[] for this stage (numbers + verdicts)
 *   planSummary?: string,
 * }} args
 * @returns {string}
 */
export function buildAssessorPrompt({
  stage,
  rubricVersion,
  criterionIds,
  rubricSlice,
  deterministicContext,
  planSummary,
}) {
  const ids = Array.isArray(criterionIds) ? criterionIds : [];
  const readset = STAGE_READSET[stage] || '(no read-set defined for this stage)';
  return `You are The Assessor. You grade a completed pipeline stage against a fixed rubric. You never invent metrics; the deterministic scores below are authoritative — treat them as ground truth and add ONLY the judgment layer the rubric asks of you.

You are in the project working directory. You may Read/Grep/Glob the artifacts named below to gather evidence, but you must NOT modify anything — you only GRADE.

Stage under review: ${stage} (rubric ${rubricVersion}).

<plan_summary>
${String(planSummary || '(no summary provided)').slice(0, 4000)}
</plan_summary>

<rubric_slice criteria="${ids.join(',')}">
${String(rubricSlice || '(rubric slice not provided)').slice(0, 12000)}
</rubric_slice>

<deterministic_context>
The following deterministic IE/OV/SK verdicts + values for this stage are AUTHORITATIVE. Do not re-derive, contradict, or restate them as your own findings — they are the numbers. Your job is the judgment the rubric reserves for an LLM reader.
${String(deterministicContext || '(no deterministic slices for this stage)').slice(0, 12000)}
</deterministic_context>

Artifacts you may read for this stage:
${readset}

Grade EXACTLY these criteria (one object each): ${ids.join(', ') || '(none — emit an empty array)'}.

For each criterion emit the rubric §0.5 substage shape:
- "criterionId": one of the ids above.
- "score": integer 0..4 on the rubric scale.
- "evidence": a VERBATIM quote or precise anchor copied from an artifact you read (e.g. an exact AC line, a sentence from the doc, a test name, a log line). This is mandatory. A score you cannot back with a citable quote is itself a [needs-instrumentation] red — for those, set "score" to null and write the reason in "note" prefixed with "[needs-instrumentation: ...]".
- "note": one or two sentences of justification (or the needs-instrumentation reason).

End your reply with EXACTLY this block:

---ASSESSOR---
[
  {
    "criterionId": "${ids[0] || 'C-XX'}",
    "score": 3,
    "evidence": "<verbatim quote/anchor from an artifact>",
    "note": "<why this score>"
  }
]
---END_ASSESSOR---

Emit one object per criterion above and NOTHING outside the markers. If you genuinely cannot read an artifact a criterion needs, still emit that criterion with "score": null and a "[needs-instrumentation: ...]" note — never guess a number.`;
}

/**
 * Map a §0.5 substage score (0..4) to a traffic-light verdict. Matches the
 * rubric §0.4 banding the deterministic detectors use (4 → 🟢, 2-3 → 🟡,
 * 0-1 → 🔴; null → ⚪).
 */
function verdictForScore(score) {
  if (score == null) return '⚪';
  if (score >= 4) return '🟢';
  if (score >= 2) return '🟡';
  return '🔴';
}

/**
 * Parse the Assessor's output into normalized Assessor slices (the body the
 * job runner persists; provenance/stage are attached by the runner). Tolerant:
 * finds the ---ASSESSOR--- block, else the first JSON array in the text.
 *
 * Honesty enforcement (spec §4b): a graded criterion (numeric score) that has
 * NO non-empty verbatim `evidence` quote is DOWNGRADED to score=null / ⚪ with a
 * `[needs-instrumentation: missing evidence quote]` note — an Assessor score
 * without a citable quote is not trustworthy and must not be fabricated upward.
 *
 * @param {string} raw         agent stdout
 * @param {string[]} expectedIds  the criterion ids the prompt asked for (drops
 *                                 stray ids the model invents; keeps order)
 * @returns {Array<{criterionId, score: 0|1|2|3|4|null, verdict, evidence: string, note?: string}>}
 */
export function parseAssessorOutput(raw, expectedIds = []) {
  if (typeof raw !== 'string' || raw.length === 0) return [];
  let jsonText = null;
  const fenced = raw.match(/---ASSESSOR---\s*([\s\S]*?)\s*---END_ASSESSOR---/);
  if (fenced) {
    jsonText = fenced[1];
  } else {
    const arr = raw.match(/\[[\s\S]*\]/);
    if (arr) jsonText = arr[0];
  }
  if (!jsonText) return [];
  jsonText = jsonText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const allow = expectedIds.length > 0 ? new Set(expectedIds) : null;
  const seen = new Set();
  const out = [];
  for (const o of parsed) {
    if (!o || typeof o !== 'object') continue;
    const criterionId = typeof o.criterionId === 'string' ? o.criterionId.trim() : '';
    if (!criterionId) continue;
    if (allow && !allow.has(criterionId)) continue; // drop hallucinated ids
    if (seen.has(criterionId)) continue; // first wins on dupes
    seen.add(criterionId);

    const evidence = typeof o.evidence === 'string' ? o.evidence.trim() : '';
    let score =
      typeof o.score === 'number' && Number.isFinite(o.score)
        ? Math.min(4, Math.max(0, Math.round(o.score)))
        : null;
    let note = typeof o.note === 'string' ? o.note.trim() : '';

    // Honesty guard: a numeric score with no verbatim evidence quote is not
    // citable → downgrade to needs-instrumentation rather than trust it.
    if (score != null && evidence.length === 0) {
      score = null;
      note = `[needs-instrumentation: missing evidence quote] ${note}`.trim();
    }

    out.push({
      criterionId,
      score,
      verdict: verdictForScore(score),
      evidence: evidence.slice(0, 2000),
      note: note ? note.slice(0, 1000) : undefined,
    });
  }
  return out;
}

/**
 * Forensic / live-output event factory. The daemon emits this via pushEvent so
 * Timer Intelligence + StoryLiveOutput pick up Assessor activity, the same way
 * reflector/skill-scout emit their step events.
 */
export function buildAssessorEvent({ stage, planId, sliceCount, gradedCount, durationMs, tokensConsumed, error }) {
  return {
    eventType: `step.scorecard-assess.${stage}`,
    payload: {
      stage,
      planId,
      sliceCount: sliceCount ?? 0,
      gradedCount: gradedCount ?? 0,
      durationMs,
      tokensConsumed,
      error,
    },
  };
}

/**
 * Run a scorecard-assess (Assessor) job end-to-end. Returns a structured result
 * the daemon's caller maps to job status (COMPLETED / FAILED).
 *
 * @param {object} job   — agent-jobs row with `scorecardAssessPayload`
 * @param {object} deps
 * @param {function} deps.loadDeterministicSlice
 *   `({ planId, stage, rubricVersion, deterministicSliceRef }) => Promise<{
 *      rubricSlice: string, deterministicContext: string,
 *      criterionIds?: string[], planSummary?: string } | null>`
 *   Loads the STORED deterministic slice for the stage (the scorecard repo
 *   read the daemon wires) and renders the prompt context. Mirrors how the
 *   reflector runner reads its inputs (DDB on the daemon side, not the agent).
 * @param {function} deps.runAgentStep
 *   `(job, prompt) => Promise<{ output: string, durationMs?: number, tokensConsumed?: number }>`
 *   The daemon wraps this around spawnGateAgent/executeStep so events stream
 *   and StoryLiveOutput renders it. Tests inject a canned response.
 * @param {function} deps.writeAssessorSlices
 *   `({ planId, stage, rubricVersion, pipelineVersion, scoredBy, slices }) => Promise<void>`
 *   Persists the Assessor slices into futurator-scorecards (engine:'assessor').
 * @param {function} [deps.pushEvent]
 *   `(jobId, stepId, agentId, eventType, payload) => Promise<void>`
 * @param {function} [deps.writeAttentionItem]
 * @param {function} [deps.llmCriteriaForStage]  optional override for the [LLM] id set.
 * @param {boolean}  [deps.paused]  when true the run is gated (mirrors agent.paused).
 *
 * @returns {Promise<{
 *   ok: boolean, status?: string, reason?: string, error?: string,
 *   stage?: string, sliceCount?: number, gradedCount?: number,
 * }>}
 */
export async function runScorecardAssessJob(job, deps) {
  const validation = validateScorecardAssessJob(job);
  if (!validation.ok) {
    return { ok: false, reason: `validation: ${validation.reason}` };
  }

  // Gate behind agent.paused, like reflector/skill-scout. The daemon passes the
  // cached pause flag; a paused run is a no-op the daemon can re-enqueue later.
  if (deps?.paused === true) {
    return { ok: true, status: 'gated', reason: 'agent.paused' };
  }

  const { planId, stage, rubricVersion, pipelineVersion, deterministicSliceRef } =
    job.scorecardAssessPayload;

  // 1. Load the stored deterministic slice for the stage (ground-truth context).
  let det;
  try {
    det = await deps.loadDeterministicSlice({
      planId,
      stage,
      rubricVersion,
      deterministicSliceRef,
    });
  } catch (err) {
    await deps.writeAttentionItem?.({
      planId,
      severity: 'medium',
      category: 'other',
      title: `Assessor could not load the deterministic slice for ${stage} (plan ${planId})`,
      body: String(err?.message || err).slice(0, 1500),
      dedupKey: `scorecard-assess-det-read:${stage}:${planId}:${rubricVersion}`,
    });
    return { ok: false, reason: 'deterministic-slice-read-failed', error: String(err?.message || err) };
  }
  if (!det || typeof det !== 'object') {
    return { ok: false, reason: 'deterministic-slice-missing' };
  }

  // The criteria the Assessor grades: the loader may pin them; else the local
  // [LLM] table. If the stage has no [LLM] criteria there is nothing to assess —
  // the deterministic slice already stands alone (e.g. deployment/publish).
  const criterionIds =
    Array.isArray(det.criterionIds) && det.criterionIds.length > 0
      ? det.criterionIds
      : llmCriteriaForStage(stage, deps);

  if (criterionIds.length === 0) {
    return { ok: true, status: 'no-llm-criteria', stage, sliceCount: 0, gradedCount: 0 };
  }

  // 2. Build the templated Assessor prompt.
  const prompt = buildAssessorPrompt({
    stage,
    rubricVersion,
    criterionIds,
    rubricSlice: det.rubricSlice,
    deterministicContext: det.deterministicContext,
    planSummary: det.planSummary,
  });

  // 3. Spawn the agent (daemon wraps spawnGateAgent/executeStep → streams).
  let stepResult;
  const t0 = Date.now();
  try {
    stepResult = await deps.runAgentStep(job, prompt);
  } catch (err) {
    await deps.writeAttentionItem?.({
      planId,
      severity: 'medium',
      category: 'other',
      title: `Assessor agent step failed for ${stage} (plan ${planId})`,
      body: String(err?.message || err).slice(0, 1500),
      dedupKey: `scorecard-assess-agent-failed:${stage}:${planId}:${rubricVersion}`,
    });
    return { ok: false, reason: 'agent-step-failed', error: String(err?.message || err) };
  }
  const durationMs = Date.now() - t0;

  // 4. Parse the emitted JSON → normalized Assessor slices (honesty-guarded).
  const parsed = parseAssessorOutput(stepResult?.output || '', criterionIds);

  // Backfill any criterion the agent omitted entirely as ⚪ needs-instrumentation
  // (an un-emitted criterion is NOT a 0 — never fabricate; mark it honestly).
  const emitted = new Set(parsed.map((s) => s.criterionId));
  const slices = criterionIds.map((cid) => {
    const hit = parsed.find((s) => s.criterionId === cid);
    if (hit) {
      return {
        criterionId: cid,
        stage,
        engine: 'assessor',
        score: hit.score,
        verdict: hit.verdict,
        // §5: store an anchor + the (capped) verbatim quote, not a dump.
        value: hit.score == null ? 'N/A' : hit.score,
        evidence: { kind: 'artifact', ref: hit.evidence || `[needs-instrumentation: no quote for ${cid}]` },
        note: hit.note,
        ieIds: [],
        fixIds: [],
      };
    }
    return {
      criterionId: cid,
      stage,
      engine: 'assessor',
      score: null,
      verdict: '⚪',
      value: 'N/A',
      evidence: { kind: 'artifact', ref: `[needs-instrumentation: Assessor emitted no slice for ${cid}]` },
      note: `[needs-instrumentation: Assessor did not grade ${cid}]`,
      ieIds: [],
      fixIds: [],
    };
  });
  const gradedCount = criterionIds.filter((cid) => emitted.has(cid) && parsed.find((s) => s.criterionId === cid)?.score != null).length;

  // 5. Emit the forensic / live event so the dashboard sees the run.
  await deps.pushEvent?.(
    job.jobId,
    `scorecard-assess.${stage}`,
    'ASSESSOR',
    buildAssessorEvent({
      stage,
      planId,
      sliceCount: slices.length,
      gradedCount,
      durationMs,
      tokensConsumed: stepResult?.tokensConsumed ?? 0,
    }).eventType,
    buildAssessorEvent({
      stage,
      planId,
      sliceCount: slices.length,
      gradedCount,
      durationMs,
      tokensConsumed: stepResult?.tokensConsumed ?? 0,
    }).payload,
  );

  // 6. Persist the Assessor slices. The composer (§4c) runs API-side on read —
  //    this runner triggers nothing else.
  try {
    await deps.writeAssessorSlices({
      planId,
      stage,
      rubricVersion,
      pipelineVersion: pipelineVersion ?? null,
      scoredBy: `assessor:${job.jobId}`,
      slices,
    });
  } catch (err) {
    await deps.writeAttentionItem?.({
      planId,
      severity: 'medium',
      category: 'other',
      title: `Assessor could not persist slices for ${stage} (plan ${planId})`,
      body: String(err?.message || err).slice(0, 1500),
      dedupKey: `scorecard-assess-write:${stage}:${planId}:${rubricVersion}`,
    });
    return { ok: false, reason: 'persist-failed', error: String(err?.message || err) };
  }

  return {
    ok: true,
    status: 'completed',
    stage,
    sliceCount: slices.length,
    gradedCount,
  };
}
