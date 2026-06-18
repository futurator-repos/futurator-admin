// Plan Retrospect — Development-stage deterministic detector (rubric §3 / §0.6)
//
// `scoreDevelopment(ctx)` returns one ScorecardSlice per development criterion
// this detector owns. It is the §4a deterministic scorer for the DEV stage —
// no LLM, no I/O: every value is computed from the DetectorContext bag the
// scorer entrypoint assembled (plan / epics / events / slices / aggregate).
//
// HONESTY GUARD (spec §4a, types.ts Verdict doc): a criterion whose evidence is
// NOT reachable from the Lambda inputs (a daemon-log tally, a `.context/` file,
// a git-topology read, the build-check job result — none of which ride on the
// DetectorContext) is emitted with verdict '⚪', score null, and a
// `[needs-instrumentation: …]` note. It is then EXCLUDED from the rollup
// denominator (rubric §0.4). We NEVER fabricate a value to avoid the ⚪.
//
// Criteria implemented here (rubric §0.6 rows 99–131):
//   computed precisely (ratios / counts off the forensic primitives):
//     D-TA2, D-CC1, D-CC3, D-MG4, D-VQ5, D-WS1
//   needs-instrumentation → ⚪ (evidence not on the Lambda inputs):
//     D-PW1, D-PW2, D-TA3, D-CC2, D-MG1, D-MG2, D-MG3, D-VQ1, D-VQ3, D-VQ4,
//     D-WS2
//
// The SK*/D-KC*/D-TA4/D-RV* development criteria are owned by other detectors
// (skills.ts / knowledge-graph.ts) — this module deliberately does not emit
// them so the composer never double-counts a criterion.

import type { ScorecardSlice, EvidenceRef, FixRef, DetectorContext } from '../types';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes } from '../ie-to-f-map';

// ── Slice construction helpers ───────────────────────────────────────────────

/**
 * Resolve the reconciled fix(es) for a criterion by unioning every IE it links
 * to (criteria-meta `ieLink`) through the canonical IE→Fix map. De-dupes by
 * fix id so a criterion linked to two IEs that share a fix lists it once.
 */
function fixesForCriterion(criterionId: string): FixRef[] {
  const ieIds = CRITERIA_META[criterionId]?.ieLink ?? [];
  const seen = new Set<string>();
  const out: FixRef[] = [];
  for (const ieId of ieIds) {
    for (const fix of mapIeToFixes(ieId)) {
      if (seen.has(fix.id)) continue;
      seen.add(fix.id);
      out.push(fix);
    }
  }
  return out;
}

/** Base slice fields every criterion shares. */
function baseSlice(criterionId: string) {
  const meta = CRITERIA_META[criterionId];
  return {
    criterionId,
    stage: meta.stage,
    ieIds: [...(meta.ieLink ?? [])],
    fixIds: fixesForCriterion(criterionId),
    engine: 'deterministic' as const,
  };
}

/**
 * A scored slice. `score` is 0–4 on the rubric scale; `verdict` is the traffic
 * light; `value` is the computed number/label; `evidence` is a ref (never a
 * data dump).
 */
function scored(
  criterionId: string,
  score: 0 | 1 | 2 | 3 | 4,
  verdict: '🟢' | '🟡' | '🔴',
  value: number | string,
  evidence: EvidenceRef,
  note?: string,
): ScorecardSlice {
  return { ...baseSlice(criterionId), score, verdict, value, evidence, ...(note ? { note } : {}) };
}

/**
 * A needs-instrumentation slice (honesty guard): score null, verdict ⚪,
 * excluded from the rollup. `missing` describes precisely what input is absent.
 */
function needsInstrumentation(
  criterionId: string,
  missing: string,
  evidence: EvidenceRef,
): ScorecardSlice {
  return {
    ...baseSlice(criterionId),
    score: null,
    verdict: '⚪',
    value: 'n/a',
    evidence,
    note: `[needs-instrumentation: ${missing}]`,
  };
}

// ── Ratio → verdict band helpers ─────────────────────────────────────────────

/** Round a ratio to 3 dp for stable `value` display (avoids float noise). */
function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Map a "lower is better" ratio onto the rubric 0–4 scale + traffic light given
 * a 🟢 ceiling and a 🔴 floor. 🟢→4, 🟡→2, 🔴→0 (the §0.6 dev ratios use a
 * three-band 4/2/0 mapping; there is no partial-credit band in these rows).
 *   ratio ≤ green        → 🟢 / 4
 *   green < ratio ≤ red  → 🟡 / 2
 *   ratio > red          → 🔴 / 0
 */
function bandLowerIsBetter(
  ratio: number,
  green: number,
  red: number,
): { score: 0 | 2 | 4; verdict: '🟢' | '🟡' | '🔴' } {
  if (ratio <= green) return { score: 4, verdict: '🟢' };
  if (ratio <= red) return { score: 2, verdict: '🟡' };
  return { score: 0, verdict: '🔴' };
}

// ── Forensic primitives ──────────────────────────────────────────────────────

/**
 * devJobCount (spec §4a) — the number of distinct epic-dev daemon jobs (the
 * unit that owns story implementation). The DetectorContext does NOT carry
 * AgentJob rows, so we derive the count from the resolved epics: each epic that
 * ran through the orchestrator owns exactly one `phase: 'epic-dev'` job
 * (`epic.orchestratorJobId`). De-duped across epics.
 *
 * Returns 0 when no epic exposes an orchestratorJobId (legacy per-story plans);
 * callers treat 0 as "can't form the per-story ratio" → ⚪.
 */
function devJobCount(ctx: DetectorContext): number {
  const ids = new Set<string>();
  for (const epic of ctx.epics) {
    if (epic.orchestratorJobId) ids.add(epic.orchestratorJobId);
  }
  return ids.size;
}

/**
 * waveCount — distinct waves that produced a build-check job across all epics
 * (`epic.waveBuildJobs` is a wave→buildJobId map). This is the denominator for
 * D-MG4. Waves are scoped per-epic, so we sum the per-epic wave counts (a wave
 * "0" in two epics is two distinct merge gates).
 */
function waveCount(ctx: DetectorContext): number {
  let n = 0;
  for (const epic of ctx.epics) {
    n += Object.keys(epic.waveBuildJobs ?? {}).length;
  }
  return n;
}

/**
 * wallMs (rubric §0.9 / spec §4a) — `max(event.timestamp) − min(event.timestamp)`
 * across the plan's collected events: the observed agent-work span. NOT the
 * plan createdAt→completedAt (which includes idle/paused gaps). Returns 0 when
 * fewer than two timestamps are present (no span to measure).
 */
function wallMs(ctx: DetectorContext): number {
  let min = Infinity;
  let max = -Infinity;
  for (const ev of ctx.events) {
    const t = Date.parse(ev.timestamp);
    if (Number.isNaN(t)) continue;
    if (t < min) min = t;
    if (t > max) max = t;
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return 0;
  return max - min;
}

/** Total story count across the plan's epics (D-WS1 is multi-story-only). */
function totalStoryCount(ctx: DetectorContext): number {
  return ctx.epics.reduce((sum, e) => sum + (e.stories?.length ?? 0), 0);
}

// ── The detector ─────────────────────────────────────────────────────────────

export function scoreDevelopment(ctx: DetectorContext): ScorecardSlice[] {
  const out: ScorecardSlice[] = [];
  const { byCat, aggregate } = ctx;
  const totalMs = aggregate.totalMs;

  // ── D-PW1 — prework skip-vs-spawn decision correct (3 signals) ────────────
  // Needs the daemon prework-gate verdict (commits / AC-export / typecheck
  // signals vs actual need). That verdict is a daemon-log decision; it is not
  // emitted as an AgentEvent and is not on any context input.
  out.push(
    needsInstrumentation(
      'D-PW1',
      'daemon prework-gate verdict (commits/AC-export/typecheck signals) not emitted as an event',
      { kind: 'log', ref: 'daemon:prework-gate' },
    ),
  );

  // ── D-PW2 — `.context/wave-N-story.md` gate-evidence file present ─────────
  // Filesystem artifact in the project worktree; not collected into the Lambda.
  out.push(
    needsInstrumentation(
      'D-PW2',
      '.context/wave-N-story.md is a worktree file not collected into the Lambda inputs',
      { kind: 'artifact', ref: '.context/wave-N-story.md' },
    ),
  );

  // ── D-TA2 — authoring cost ratio (test-author ÷ dev) ──────────────────────
  // F.byCat('test-author').totalMs ÷ F.byCat('dev').totalMs. 🟢≤0.6 🟡0.6–1.0 🔴>1.0
  {
    const taMs = byCat('test-author').totalMs;
    const devMs = byCat('dev').totalMs;
    const evidence: EvidenceRef = {
      kind: 'forensic',
      ref: 'aggregate.byCategory.test-author.totalMs ÷ aggregate.byCategory.dev.totalMs',
    };
    if (devMs === 0) {
      // No dev time → the ratio is undefined (can't divide). If there was no
      // authoring time either, this plan simply did no TDD work to grade.
      out.push(
        needsInstrumentation(
          'D-TA2',
          'byCategory.dev.totalMs is 0 — no dev time to form the authoring-cost ratio',
          evidence,
        ),
      );
    } else {
      const ratio = round3(taMs / devMs);
      const { score, verdict } = bandLowerIsBetter(ratio, 0.6, 1.0);
      out.push(scored('D-TA2', score, verdict, ratio, evidence));
    }
  }

  // ── D-TA3 — red-gate honored (`test-gate-red` step present) ───────────────
  // Requires the `test-gate-red` pipeline step's presence at production rigor.
  // No event marks that step; the timer categories don't distinguish it.
  out.push(
    needsInstrumentation(
      'D-TA3',
      'test-gate-red step presence is not surfaced on events or timer slices',
      { kind: 'log', ref: 'pipeline:test-gate-red' },
    ),
  );

  // ── D-CC1 — compiles per story (compile slices ÷ devJobCount) ─────────────
  // byCategory.compile.count ÷ devJobCount. 🟢≤15 🟡15–40 🔴>40.
  // `count` is the slice-count proxy for tsc invocations (rubric §3.5 caveat).
  {
    const compileCount = byCat('compile').count;
    const jobs = devJobCount(ctx);
    const evidence: EvidenceRef = {
      kind: 'forensic',
      ref: 'aggregate.byCategory.compile.count ÷ devJobCount(epics.orchestratorJobId)',
    };
    if (jobs === 0) {
      out.push(
        needsInstrumentation(
          'D-CC1',
          'no epic-dev job resolvable (no epic.orchestratorJobId) — devJobCount denominator is 0',
          evidence,
        ),
      );
    } else {
      const ratio = round3(compileCount / jobs);
      const { score, verdict } = bandLowerIsBetter(ratio, 15, 40);
      out.push(
        scored(
          'D-CC1',
          score,
          verdict,
          ratio,
          evidence,
          'value is the slice-count proxy for tsc invocations (rubric §3.5 count caveat)',
        ),
      );
    }
  }

  // ── D-CC2 — compile caching active (cache-hit signature) ──────────────────
  // "repeated identical tsc slices with no input change" — detecting a cache
  // hit needs per-tsc input hashes (no input change), which the timer slices do
  // not carry. ⚪ until a compileInvocation digest is instrumented.
  out.push(
    needsInstrumentation(
      'D-CC2',
      'cache-hit signature needs per-tsc input digests; timer slices carry no input hash',
      { kind: 'forensic', ref: 'aggregate.byCategory.compile (no per-slice input digest)' },
    ),
  );

  // ── D-CC3 — compile share of stage time ───────────────────────────────────
  // byCategory.compile.totalMs ÷ aggregate.totalMs. 🟢≤0.15 🟡0.15–0.25 🔴>0.25
  {
    const evidence: EvidenceRef = {
      kind: 'forensic',
      ref: 'aggregate.byCategory.compile.totalMs ÷ aggregate.totalMs',
    };
    if (totalMs === 0) {
      out.push(
        needsInstrumentation(
          'D-CC3',
          'aggregate.totalMs is 0 — no attributed time to form a share',
          evidence,
        ),
      );
    } else {
      const ratio = round3(byCat('compile').totalMs / totalMs);
      const { score, verdict } = bandLowerIsBetter(ratio, 0.15, 0.25);
      out.push(scored('D-CC3', score, verdict, ratio, evidence));
    }
  }

  // ── D-MG1 — clean merges (classifyWaveMergeOutcome per wave) ──────────────
  // The merge outcome (success / fix-forward / merge-conflict / wave-build-
  // failed) is computed by the daemon's wave-merge runner and lives on the
  // build-check job result (epic.waveBuildJobs → jobId). The DetectorContext
  // carries epic rows + events, but NOT the build-check job results, so the
  // per-wave outcome cannot be reconstructed deterministically here.
  out.push(
    needsInstrumentation(
      'D-MG1',
      'per-wave classifyWaveMergeOutcome lives on the build-check job result, not on the DetectorContext',
      { kind: 'ddb', ref: 'epic.waveBuildJobs[wave] → buildJob.result' },
    ),
  );

  // ── D-MG2 — git-graph integrity (waveBaseRef chain) ───────────────────────
  out.push(
    needsInstrumentation(
      'D-MG2',
      'git topology / waveBaseRef SHA chain requires a repo read not available to the Lambda',
      { kind: 'artifact', ref: 'git:wave-base-ref-chain' },
    ),
  );

  // ── D-MG3 — commit-metadata trailers complete ─────────────────────────────
  out.push(
    needsInstrumentation(
      'D-MG3',
      'merge-commit trailers (Agent/Plan-Id/Epic/Wave/Story) require a git log read',
      { kind: 'artifact', ref: 'git:merge-commit-trailers' },
    ),
  );

  // ── D-MG4 — merge-gate latency ────────────────────────────────────────────
  // byCategory.merge-gate.totalMs ÷ waveCount. 🟢≤60000ms/wave 🔴>120000ms/wave
  {
    const waves = waveCount(ctx);
    const evidence: EvidenceRef = {
      kind: 'forensic',
      ref: 'aggregate.byCategory.merge-gate.totalMs ÷ waveCount(epics.waveBuildJobs)',
    };
    if (waves === 0) {
      out.push(
        needsInstrumentation(
          'D-MG4',
          'no waves with a build-check job (epic.waveBuildJobs empty) — no per-wave latency to grade',
          evidence,
        ),
      );
    } else {
      const msPerWave = Math.round(byCat('merge-gate').totalMs / waves);
      // Two-band 🟢/🔴 row (no explicit 🟡 in §0.6). Treat the gap between the
      // green ceiling and the red floor as 🟡 (partial credit) for fairness.
      let score: 0 | 2 | 4;
      let verdict: '🟢' | '🟡' | '🔴';
      if (msPerWave <= 60000) {
        score = 4;
        verdict = '🟢';
      } else if (msPerWave <= 120000) {
        score = 2;
        verdict = '🟡';
      } else {
        score = 0;
        verdict = '🔴';
      }
      out.push(scored('D-MG4', score, verdict, msPerWave, evidence));
    }
  }

  // ── D-VQ1 — verdict reliability (unverifiable rate) ───────────────────────
  // daemon `unverifiable=n` tally ÷ total VQA verdicts. The unverifiable tally
  // is a daemon-log VQA-judge line, not an AgentEvent — not on the context.
  out.push(
    needsInstrumentation(
      'D-VQ1',
      "daemon 'unverifiable=n' VQA tally is a log line, not an AgentEvent on the context",
      { kind: 'log', ref: 'daemon:vqa-judge#unverifiable' },
    ),
  );

  // ── D-VQ3 — no wasted fix rounds (improved-nothing reverts) ───────────────
  // daemon `improved nothing — reverting` count — a daemon-log FIXER line.
  out.push(
    needsInstrumentation(
      'D-VQ3',
      "daemon 'improved nothing — reverting' count is a FIXER log line, not on the context",
      { kind: 'log', ref: 'daemon:vqa-fixer#reverting' },
    ),
  );

  // ── D-VQ4 — fix-forward handoff preserved (vqa-handoffs json) ─────────────
  // `.context/vqa-handoffs/*.json` (evidence + prior diff) — worktree files.
  out.push(
    needsInstrumentation(
      'D-VQ4',
      '.context/vqa-handoffs/*.json are worktree files not collected into the Lambda inputs',
      { kind: 'artifact', ref: '.context/vqa-handoffs/*.json' },
    ),
  );

  // ── D-VQ5 — VQA share of stage time ───────────────────────────────────────
  // byCategory.vqa-gate.totalMs ÷ aggregate.totalMs. 🟢≤0.15 🟡0.15–0.25 🔴>0.25
  {
    const evidence: EvidenceRef = {
      kind: 'forensic',
      ref: 'aggregate.byCategory.vqa-gate.totalMs ÷ aggregate.totalMs',
    };
    if (totalMs === 0) {
      out.push(
        needsInstrumentation(
          'D-VQ5',
          'aggregate.totalMs is 0 — no attributed time to form a share',
          evidence,
        ),
      );
    } else {
      const ratio = round3(byCat('vqa-gate').totalMs / totalMs);
      const { score, verdict } = bandLowerIsBetter(ratio, 0.15, 0.25);
      out.push(scored('D-VQ5', score, verdict, ratio, evidence));
    }
  }

  // ── D-WS1 — parallelism factor (cumulative ÷ wall span) ───────────────────
  // aggregate.totalMs ÷ wallMs. Multi-story plans only (rubric §11 Q2 — a
  // single-story plan has no parallel opportunity, so the factor is meaningless
  // and we ⚪ it rather than score a fake 🔴). 🟢≥1.5 🟡1.2–1.5 🔴<1.2.
  {
    const evidence: EvidenceRef = {
      kind: 'forensic',
      ref: 'aggregate.totalMs ÷ wallMs(max−min event.timestamp)',
    };
    const stories = totalStoryCount(ctx);
    const wall = wallMs(ctx);
    if (stories <= 1) {
      out.push(
        needsInstrumentation(
          'D-WS1',
          'single-story plan has no parallel opportunity — parallelism factor not applicable (rubric §11 Q2)',
          evidence,
        ),
      );
    } else if (wall === 0) {
      out.push(
        needsInstrumentation(
          'D-WS1',
          'fewer than two distinct event timestamps — no wall span to measure parallelism against',
          evidence,
        ),
      );
    } else {
      const factor = round3(totalMs / wall);
      // "Higher is better" three-band: 🟢≥1.5 / 🟡1.2–1.5 / 🔴<1.2.
      let score: 0 | 2 | 4;
      let verdict: '🟢' | '🟡' | '🔴';
      if (factor >= 1.5) {
        score = 4;
        verdict = '🟢';
      } else if (factor >= 1.2) {
        score = 2;
        verdict = '🟡';
      } else {
        score = 0;
        verdict = '🔴';
      }
      out.push(scored('D-WS1', score, verdict, factor, evidence));
    }
  }

  // ── D-WS2 — parallelism not throttled to mask host saturation ─────────────
  // Needs the daemon concurrency config compared against host (CPU/mem/swap)
  // metrics — neither rides on the DetectorContext.
  out.push(
    needsInstrumentation(
      'D-WS2',
      'concurrency config vs host saturation metrics are not collected into the Lambda inputs',
      { kind: 'log', ref: 'host:concurrency-vs-saturation' },
    ),
  );

  return out;
}
