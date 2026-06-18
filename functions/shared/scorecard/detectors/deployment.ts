// Plan Retrospect — deployment-stage deterministic detector (rubric §0.6 DP-*)
//
// Scores the `[DET]` deployment criteria directly from the plan, the deploy
// report (`deploy-report-aggregator`), and the resolved deploy targets. No LLM,
// no I/O — every verdict is a pure function of the DetectorContext.
//
// HONESTY GUARD (spec §4a): criteria whose evidence is NOT available from the
// Lambda inputs — a live HTTP probe (DP-U1 status), promote-hash equality
// (DP-L2), shared-worktree overlap (DP-I1), the actual deploy COMMAND used
// (DP-S1 root-sync signal) — emit verdict '⚪' with a `[needs-instrumentation:
// …]` note and score `null`. They are excluded from the rollup denominator and
// never fabricated.
//
// Criteria: DP-B1, DP-L1, DP-R1, DP-S1, DP-S2, DP-D1, DP-T1, DP-U1, DP-L2,
//           DP-I1, DP-E1, DP-O1.
//
// Sources:
//   - rubric §0.6 rows 147–159 (evidenceField + thresholdExpr per criterion)
//   - functions/shared/repositories/deploy-report-aggregator.ts (DeployReport)
//   - functions/shared/types/deploy-report.ts (DeployReport / DeployRecord /
//     DeployEnvironmentStatus)
//   - functions/shared/deploy/deploy-targets.ts (resolveDeployTarget.provisioned)

import type { DetectorContext, ScorecardSlice, EvidenceRef, Verdict, FixRef } from '../types';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes } from '../ie-to-f-map';
import type {
  DeployReport,
  DeployRecord,
  DeployEnvironmentStatus,
} from '../../types/deploy-report';
import { resolveDeployTarget } from '../../deploy/deploy-targets';

// ── Slice helpers ────────────────────────────────────────────────────────────

/** Score → its conventional traffic light (used when the row has no custom map). */
function verdictForScore(score: ScorecardSlice['score']): Verdict {
  if (score === null) return '⚪';
  if (score >= 3) return '🟢';
  if (score >= 1) return '🟡';
  return '🔴';
}

/** Union of every fix mapped from the criterion's IE links (rubric §8). */
function fixesForCriterion(criterionId: string): FixRef[] {
  const ieIds = CRITERIA_META[criterionId]?.ieLink ?? [];
  const out: FixRef[] = [];
  const seen = new Set<string>();
  for (const ie of ieIds) {
    for (const f of mapIeToFixes(ie)) {
      const key = `${f.kind}:${f.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(f);
    }
  }
  return out;
}

interface SliceInput {
  criterionId: string;
  score: ScorecardSlice['score'];
  value: number | string;
  evidence: EvidenceRef;
  verdict?: Verdict;
  note?: string;
}

function makeSlice(input: SliceInput): ScorecardSlice {
  const meta = CRITERIA_META[input.criterionId];
  const verdict = input.verdict ?? verdictForScore(input.score);
  return {
    criterionId: input.criterionId,
    stage: meta.stage,
    score: input.score,
    verdict,
    value: input.value,
    evidence: input.evidence,
    ...(input.note ? { note: input.note } : {}),
    // Only attribute fixes when the criterion actually reproduces its IE (red/
    // yellow). A green slice carries no open improvement action.
    ieIds: verdict === '🔴' || verdict === '🟡' ? meta.ieLink : [],
    fixIds: verdict === '🔴' || verdict === '🟡' ? fixesForCriterion(input.criterionId) : [],
    engine: 'deterministic',
  };
}

/** A `⚪` needs-instrumentation slice (score null, excluded from the rollup). */
function needsInstrumentation(
  criterionId: string,
  missing: string,
  evidence: EvidenceRef,
  value: number | string = 'n/a',
): ScorecardSlice {
  return makeSlice({
    criterionId,
    score: null,
    verdict: '⚪',
    value,
    evidence,
    note: `[needs-instrumentation: ${missing}]`,
  });
}

// ── Deploy-report narrowing ────────────────────────────────────────────────────

/** Narrow the untyped `ctx.deployReport` to a DeployReport (best-effort). */
function asDeployReport(v: unknown): DeployReport | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Partial<DeployReport>;
  if (!Array.isArray(r.environments)) return null;
  return v as DeployReport;
}

const REPORT_REF = (anchor: string): EvidenceRef => ({
  kind: 'report',
  ref: `deploy-report#${anchor}`,
});
const FORENSIC_REF = (anchor: string): EvidenceRef => ({ kind: 'forensic', ref: anchor });
const LOG_REF = (anchor: string): EvidenceRef => ({ kind: 'log', ref: anchor });

function envByName(
  report: DeployReport,
  name: DeployEnvironmentStatus['environment'],
): DeployEnvironmentStatus | undefined {
  return report.environments.find((e) => e.environment === name);
}

/** A full http(s) URL with a host (not a bare path / truncated fragment). */
function isFullUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0;
  } catch {
    return false;
  }
}

// ── The detector ───────────────────────────────────────────────────────────────

export function scoreDeployment(ctx: DetectorContext): ScorecardSlice[] {
  const slices: ScorecardSlice[] = [];
  const report = asDeployReport(ctx.deployReport);
  const current: DeployRecord | null = report?.current ?? null;
  const everDeployed = !!current || (report?.environments.some((e) => !!e.url) ?? false);

  // ── DP-B1 — build reproducible & green (deploy report build step) ───────────
  // 4=clean reproducible static export; 0=fails/non-reproducible.
  if (!report) {
    slices.push(
      needsInstrumentation(
        'DP-B1',
        'deploy report not available to the scorer',
        REPORT_REF('current.steps'),
      ),
    );
  } else if (!current) {
    slices.push(
      needsInstrumentation(
        'DP-B1',
        'no deploy job on record — nothing built yet',
        REPORT_REF('current'),
      ),
    );
  } else {
    const build = current.steps.find((s) => s.id === 'build');
    const ev = REPORT_REF('current.steps[build].status');
    if (build?.status === 'pass') {
      slices.push(makeSlice({ criterionId: 'DP-B1', score: 4, value: 'pass', evidence: ev }));
    } else if (build?.status === 'fail') {
      slices.push(makeSlice({ criterionId: 'DP-B1', score: 0, value: 'fail', evidence: ev }));
    } else {
      // running/pending/skipped — build did not complete this slice's window.
      slices.push(
        makeSlice({
          criterionId: 'DP-B1',
          score: 2,
          value: build?.status ?? 'unknown',
          evidence: ev,
        }),
      );
    }
  }

  // ── DP-L1 — environment-ladder progression honored (preview→…→prod, no skips)
  // 4=ordered preview→…→prod, no skips; 0=jumps to prod.
  if (!report) {
    slices.push(
      needsInstrumentation(
        'DP-L1',
        'deploy report not available to read environment ladder',
        REPORT_REF('environments'),
      ),
    );
  } else {
    const dev = envByName(report, 'dev');
    const staging = envByName(report, 'staging');
    const prod = envByName(report, 'production');
    const ev = REPORT_REF('environments[].url');
    const prodLive = !!prod?.url;
    if (!prodLive) {
      // No prod release yet — nothing has skipped the ladder. Honor-by-default.
      slices.push(
        makeSlice({
          criterionId: 'DP-L1',
          score: 4,
          value: 'no-prod-yet',
          evidence: ev,
          verdict: '🟢',
        }),
      );
    } else {
      const skippedDev = !dev?.url;
      const skippedStaging = !staging?.url;
      if (skippedDev || skippedStaging) {
        // Production reached without a lower rung live → ladder skip.
        slices.push(
          makeSlice({
            criterionId: 'DP-L1',
            score: 0,
            value: `prod-without-${skippedDev ? 'dev' : 'staging'}`,
            evidence: ev,
            verdict: '🔴',
          }),
        );
      } else {
        slices.push(makeSlice({ criterionId: 'DP-L1', score: 4, value: 'ordered', evidence: ev }));
      }
    }
  }

  // ── DP-R1 — release recorded with rollback handle (release-strip/deploy-history)
  // 4=versioned + rollbackable; 0=no record.
  if (!report) {
    slices.push(
      needsInstrumentation(
        'DP-R1',
        'deploy report not available to read deploy-history',
        REPORT_REF('history'),
      ),
    );
  } else if (!everDeployed) {
    slices.push(
      needsInstrumentation(
        'DP-R1',
        'no deploy on record — no release to version',
        REPORT_REF('current'),
      ),
    );
  } else {
    const ev = REPORT_REF('current.sha + history[]');
    const hasSha = !!current?.sha;
    const recordCount = (current ? 1 : 0) + (report.history?.length ?? 0);
    if (hasSha) {
      // A recorded release pinned to a commit SHA is rollbackable.
      slices.push(
        makeSlice({
          criterionId: 'DP-R1',
          score: 4,
          value: current?.sha ?? recordCount,
          evidence: ev,
        }),
      );
    } else if (recordCount > 0) {
      // Recorded but no commit handle — limited rollback.
      slices.push(
        makeSlice({
          criterionId: 'DP-R1',
          score: 2,
          value: 'recorded-no-sha',
          evidence: ev,
          verdict: '🟡',
        }),
      );
    } else {
      slices.push(
        makeSlice({
          criterionId: 'DP-R1',
          score: 0,
          value: 'no-record',
          evidence: ev,
          verdict: '🔴',
        }),
      );
    }
  }

  // ── DP-S1 — deploy safety (scoped paths; sst-only). 0 forces overall F. ──────
  // 4=scoped & SST-only; 0=any root sync to `futurator-ai-website` (catastrophic).
  // The catastrophic root-sync signal is only visible in the DEPLOY COMMAND /
  // daemon log, which the deterministic scorer does not parse. We CAN witness
  // the scoped target the report resolved to (apps/<slug>/…), which is a
  // positive scoped-path signal. We score the positive shape and explicitly
  // disclaim the catastrophic-detection seam.
  {
    const appSlug =
      (ctx.plan.workingDir || ctx.plan.name).split('/').filter(Boolean).pop() || ctx.plan.name;
    const prodTarget = resolveDeployTarget(appSlug, 'production');
    const ev = REPORT_REF('target.s3Prefix');
    const prefix = report?.target?.s3Prefix ?? prodTarget.s3Prefix;
    const bucket = report?.target?.s3Bucket ?? prodTarget.s3Bucket;
    const scoped = !!prefix && prefix.startsWith('apps/');
    const publicBucketRoot =
      bucket === 'futurator-ai-website' && (!prefix || prefix === '' || prefix === '/');
    if (!everDeployed) {
      slices.push(
        needsInstrumentation(
          'DP-S1',
          'no deploy on record; root-sync safety is observable only from the deploy command/daemon log, not surfaced to the scorer',
          ev,
        ),
      );
    } else if (publicBucketRoot) {
      // The catastrophic case, if it ever surfaces in the resolved target.
      slices.push(
        makeSlice({
          criterionId: 'DP-S1',
          score: 0,
          value: 'root-sync-to-public-bucket',
          evidence: ev,
          verdict: '🔴',
          note: 'catastrophic: deploy target resolves to the public-bucket root (futurator-ai-website)',
        }),
      );
    } else if (scoped) {
      slices.push(
        makeSlice({
          criterionId: 'DP-S1',
          score: 4,
          value: prefix,
          evidence: ev,
          note: 'scoped target prefix witnessed; the actual `aws s3 sync` command (root-sync detection) is log-only and NOT parsed by the deterministic scorer',
        }),
      );
    } else {
      slices.push(
        needsInstrumentation(
          'DP-S1',
          `target prefix "${prefix}" is non-standard; deploy-command safety is log-only and not parsed by the scorer`,
          ev,
          prefix || 'unknown',
        ),
      );
    }
  }

  // ── DP-S2 — smoke verification (SMOKE_STATUS surfaced per rung) ──────────────
  // 4=ran+surfaced+soft-gates failed staging smoke; 0=absent/silent. (F21)
  if (!report) {
    slices.push(
      needsInstrumentation(
        'DP-S2',
        'deploy report not available to read SMOKE_STATUS',
        REPORT_REF('environments[].smokeStatus'),
      ),
    );
  } else {
    const ev = REPORT_REF('environments[].smokeStatus');
    const withSmoke = report.environments.filter((e) => e.smokeStatus !== undefined);
    const deployedRungs = report.environments.filter((e) => !!e.url || !!e.activeJobId);
    if (deployedRungs.length === 0) {
      slices.push(needsInstrumentation('DP-S2', 'no deployed rung to smoke-test', ev));
    } else if (withSmoke.length === 0) {
      // Deployed but no smoke status surfaced anywhere → absent/silent.
      slices.push(
        makeSlice({ criterionId: 'DP-S2', score: 0, value: 'absent', evidence: ev, verdict: '🔴' }),
      );
    } else {
      const anyFail = withSmoke.some((e) => e.smokeStatus === 'fail');
      // Ran + surfaced. A surfaced FAIL is the soft-gate working as designed (4);
      // all-pass is also 4. Partial coverage (some rungs missing) → 3 (still green).
      const fullCoverage = withSmoke.length >= deployedRungs.length;
      const value = anyFail ? 'surfaced-fail' : 'surfaced-pass';
      slices.push(
        makeSlice({
          criterionId: 'DP-S2',
          score: fullCoverage ? 4 : 3,
          value,
          evidence: ev,
        }),
      );
    }
  }

  // ── DP-D1 — deploy report complete (artifacts, URLs, timings) ───────────────
  // 4=full (artifacts,URLs,timings); 0=opaque.
  if (!report) {
    slices.push(
      needsInstrumentation('DP-D1', 'deploy report not produced for this plan', REPORT_REF('')),
    );
  } else {
    const ev = REPORT_REF('current{publicUrl,durationSec,steps}');
    if (!current) {
      // Report exists but nothing deployed — it's complete for its (empty) state.
      slices.push(
        makeSlice({
          criterionId: 'DP-D1',
          score: 3,
          value: 'no-deploy-yet',
          evidence: ev,
          verdict: '🟢',
        }),
      );
    } else {
      const hasUrl = !!current.publicUrl;
      const hasTiming = current.durationSec !== undefined;
      const hasSteps = current.steps.length > 0;
      const filled = [hasUrl, hasTiming, hasSteps].filter(Boolean).length;
      const score = (
        filled === 3 ? 4 : filled === 2 ? 3 : filled === 1 ? 2 : 0
      ) as ScorecardSlice['score'];
      slices.push(
        makeSlice({
          criterionId: 'DP-D1',
          score,
          value: `url:${hasUrl} timing:${hasTiming} steps:${hasSteps}`,
          evidence: ev,
        }),
      );
    }
  }

  // ── DP-T1 — deploy latency (forensic deploy-job durationMs vs budget) ───────
  // 🟢 within budget; 🔴 durationMs>2×budget. No deploy-latency budget is
  // declared in the Lambda inputs (no `deploy` timer category, no budget field),
  // so the threshold comparison is uncomputable. We report the observed duration
  // and ⚪ the verdict.
  {
    const durationSec = current?.durationSec;
    const ev = REPORT_REF('current.durationSec');
    if (durationSec === undefined) {
      slices.push(needsInstrumentation('DP-T1', 'no deploy job duration on record', ev));
    } else {
      slices.push(
        needsInstrumentation(
          'DP-T1',
          `deploy-latency budget not declared in the scorer inputs (no deploy timer category / budget field); observed ${Math.round(durationSec)}s`,
          ev,
          Math.round(durationSec * 1000),
        ),
      );
    }
  }

  // ── DP-U1 — published-URL integrity (DEPLOY_URL full & resolves 200) ─────────
  // 4=full URL & returns 200; 0=truncated/dead. The deterministic scorer cannot
  // issue the HTTP probe (no network I/O), so the 200 half is needs-
  // instrumentation. We DO score URL completeness (truncation is the IE20
  // defect and is statically detectable from the recorded string).
  {
    const recordedUrl = current?.publicUrl ?? report?.environments.find((e) => !!e.url)?.url;
    const ev = REPORT_REF('current.publicUrl');
    if (!everDeployed || !recordedUrl) {
      slices.push(needsInstrumentation('DP-U1', 'no published URL recorded yet', ev));
    } else if (!isFullUrl(recordedUrl)) {
      // Truncated / non-resolvable shape — this is the IE20 red (statically caught).
      slices.push(
        makeSlice({
          criterionId: 'DP-U1',
          score: 0,
          value: recordedUrl,
          evidence: ev,
          verdict: '🔴',
          note: 'recorded URL is not a full http(s) URL (truncated/dead per IE20); live HTTP-200 probe is not run by the deterministic scorer',
        }),
      );
    } else {
      // Full URL shape is good; the 200 liveness check is out of the scorer's reach.
      slices.push(
        makeSlice({
          criterionId: 'DP-U1',
          score: 3,
          value: recordedUrl,
          evidence: ev,
          verdict: '🟢',
          note: '[needs-instrumentation: rendered-link HTTP-200 status not probed by the deterministic scorer; URL shape verified full]',
        }),
      );
    }
  }

  // ── DP-L2 — build-once promotion (promotedHash == sourceHash) ───────────────
  // 4=byte-copy promote; 🟡 rebuild-per-rung; 0=staging-bypassing fresh prod
  // build. The deploy report carries no promotedHash/sourceHash, and the
  // `provisioned` flag tells us only whether copy-promote is *available*. We use
  // provisioning as a proxy signal but disclaim the hash-equality witness.
  {
    const appSlug =
      (ctx.plan.workingDir || ctx.plan.name).split('/').filter(Boolean).pop() || ctx.plan.name;
    const stagingProvisioned = resolveDeployTarget(appSlug, 'staging').provisioned;
    const prodProvisioned = resolveDeployTarget(appSlug, 'production').provisioned;
    const ev = REPORT_REF('target.provisioned');
    if (!everDeployed) {
      slices.push(
        needsInstrumentation('DP-L2', 'no deploy on record to assess promotion mode', ev),
      );
    } else if (stagingProvisioned && prodProvisioned) {
      // Subdomain mode → byte-copy promote is the path; but we cannot witness
      // promotedHash==sourceHash, so cap at green-but-unverified (3) and disclaim.
      slices.push(
        makeSlice({
          criterionId: 'DP-L2',
          score: 3,
          value: 'copy-capable',
          evidence: ev,
          verdict: '🟢',
          note: '[needs-instrumentation: promotedHash==sourceHash not recorded; provisioned subdomains imply byte-copy promote but equality is unverified]',
        }),
      );
    } else {
      // Fallback prefix mode → promotion rebuilds per rung (the 🟡 fallback).
      slices.push(
        makeSlice({
          criterionId: 'DP-L2',
          score: 2,
          value: 'rebuild-per-rung',
          evidence: ev,
          verdict: '🟡',
          note: 'fallback prefix mode: promotion rebuilds per rung rather than byte-copying (IE22 / DP-E1 subdomain gap)',
        }),
      );
    }
  }

  // ── DP-I1 — deploy stage isolation (deploy workingDir vs QA workingDir) ──────
  // 4=isolated build dir / env-injected base; 0=rewrites shared tree mid-run.
  // Requires overlapping job-window + shared-workingDir + config-rewrite signals
  // that are NOT surfaced to the scorer (daemon-log / job-window cross-product).
  // Same evidence as Q-C9 (IE13/F11) — counted once there, disclaimed here.
  slices.push(
    needsInstrumentation(
      'DP-I1',
      'deploy×QA worktree-overlap detection requires overlapping job windows + shared workingDir + mid-run next.config rewrite signals (daemon-log/job-window), not surfaced to the deterministic scorer (IE13/F11)',
      LOG_REF('deploy-job.workingDir vs qa-job.workingDir'),
    ),
  );

  // ── DP-E1 — environment provisioning isolation (deploy-targets.provisioned) ──
  // 4=own subdomain+bucket; 🟡 shared-bucket apps/_dev|_staging prefixes;
  // 0=collides with prod path.
  {
    const appSlug =
      (ctx.plan.workingDir || ctx.plan.name).split('/').filter(Boolean).pop() || ctx.plan.name;
    const dev = resolveDeployTarget(appSlug, 'dev');
    const staging = resolveDeployTarget(appSlug, 'staging');
    const prod = resolveDeployTarget(appSlug, 'production');
    const ev = REPORT_REF('target.provisioned + s3Prefix');
    const prodPrefix = prod.s3Prefix;
    const collides = [dev, staging].some((t) => t.s3Prefix === prodPrefix);
    if (collides) {
      slices.push(
        makeSlice({
          criterionId: 'DP-E1',
          score: 0,
          value: 'collides-with-prod-path',
          evidence: ev,
          verdict: '🔴',
        }),
      );
    } else if (dev.provisioned && staging.provisioned) {
      slices.push(
        makeSlice({
          criterionId: 'DP-E1',
          score: 4,
          value: 'own-subdomain+bucket',
          evidence: ev,
        }),
      );
    } else {
      // Shared bucket with reserved apps/_dev|_staging prefixes — the 🟡 fallback.
      slices.push(
        makeSlice({
          criterionId: 'DP-E1',
          score: 2,
          value: `${dev.s3Prefix} / ${staging.s3Prefix}`,
          evidence: ev,
          verdict: '🟡',
        }),
      );
    }
  }

  // ── DP-O1 — per-environment deploy observability (active-env job binding) ────
  // 4=all envs (dev/staging/prod) stream; 0=non-prod deploys dark. We read each
  // rung's activeJobId binding (F21): a rung that deployed (has a url) but has no
  // activeJobId is "dark".
  if (!report) {
    slices.push(
      needsInstrumentation(
        'DP-O1',
        'deploy report not available to read per-env job bindings',
        REPORT_REF('environments[].activeJobId'),
      ),
    );
  } else {
    const ev = REPORT_REF('environments[].activeJobId');
    const deployedRungs = report.environments.filter((e) => !!e.url || !!e.activeJobId);
    if (deployedRungs.length === 0) {
      slices.push(needsInstrumentation('DP-O1', 'no deployed rung to observe', ev));
    } else {
      const darkRungs = deployedRungs.filter((e) => !e.activeJobId);
      if (darkRungs.length === 0) {
        slices.push(
          makeSlice({ criterionId: 'DP-O1', score: 4, value: 'all-bound', evidence: ev }),
        );
      } else if (darkRungs.length < deployedRungs.length) {
        slices.push(
          makeSlice({
            criterionId: 'DP-O1',
            score: 2,
            value: `dark:${darkRungs.map((e) => e.environment).join(',')}`,
            evidence: ev,
            verdict: '🟡',
          }),
        );
      } else {
        slices.push(
          makeSlice({
            criterionId: 'DP-O1',
            score: 0,
            value: 'all-non-prod-dark',
            evidence: ev,
            verdict: '🔴',
          }),
        );
      }
    }
  }

  return slices;
}
