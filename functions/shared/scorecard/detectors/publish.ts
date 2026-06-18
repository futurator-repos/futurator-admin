// Plan Retrospect — publish-stage deterministic detector (rubric §0.6 P-*)
//
// Scores the `[DET]` publish criteria — the act of publishing a built app to
// the PUBLIC bucket (`futurator-ai-website`) under its scoped paths. No LLM, no
// I/O — every verdict is a pure function of the DetectorContext.
//
// HONESTY GUARD (spec §4a / §2 safety posture): the publish-write evidence (the
// actual S3 PUT paths, the `data/projects.json` write, the `media/<projectId>/`
// uploads, the homepage `index.html` mtime, the re-publish dedupe behavior)
// lives in a PUBLISH LOG / S3 write manifest that is NOT surfaced to the
// deterministic scorer. Those criteria emit verdict '⚪' with a
// `[needs-instrumentation: …]` note and score `null` — excluded from the rollup
// denominator and NEVER fabricated. The one criterion we CAN compute from the
// Lambda inputs is P-A1: `plan.devUrl` completeness + appId interpolation +
// publish-readiness from `plan.status`.
//
// SAFETY NOTE (rubric §0.4 rule 2): P-S1 = 0 forces overall pipeline health to
// grade `F`. The catastrophic root-sync signal (admin `out/` synced to the
// public-bucket root, the 2026-04-15 incident class) is only observable from
// the publish COMMAND / write manifest, which the deterministic scorer does not
// parse. We therefore emit P-S1 as '⚪' (not a false-green) and disclaim the
// detection seam — a missing safety witness must never silently read as pass.
//
// Criteria: P-A1, P-X1, P-S1, P-M1, P-I1.
//
// Sources:
//   - rubric §0.6 rows 160–164 (evidenceField + thresholdExpr per criterion)
//   - rubric §0.4 rule 2 (P-S1=0 → forces F)
//   - functions/shared/types/plan.ts (Plan.devUrl / status / appId / name)
//   - CLAUDE.md "DEPLOY SAFETY" 4-path allowlist (data/projects.json,
//     media/<projectId>/, apps/<appName>/, knowledge-live/<projectId>/)

import type { DetectorContext, ScorecardSlice, EvidenceRef, Verdict, FixRef } from '../types';
import { CRITERIA_META } from '../criteria-meta';
import { mapIeToFixes } from '../ie-to-f-map';

// ── slice helpers ────────────────────────────────────────────────────────────

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
    // yellow). A green/⚪ slice carries no open improvement action.
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

const LOG_REF = (anchor: string): EvidenceRef => ({ kind: 'log', ref: anchor });
const DDB_REF = (anchor: string): EvidenceRef => ({ kind: 'ddb', ref: `plan#${anchor}` });

// ── helpers ──────────────────────────────────────────────────────────────────

/** A full http(s) URL with a host (not a bare path / truncated fragment). */
function isFullUrl(url: string | undefined): url is string {
  if (!url) return false;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0;
  } catch {
    return false;
  }
}

/**
 * The published app slug = the canonical plan `name` (= folder slug = deploy
 * slug, locked after creation — plan.ts), falling back to the last segment of
 * `workingDir`. This is the `<appName>` in `apps/<appName>/`.
 */
function appSlug(ctx: DetectorContext): string {
  const fromWorkingDir = (ctx.plan.workingDir ?? '').split('/').filter(Boolean).pop();
  return ctx.plan.name || fromWorkingDir || '';
}

// ── the detector ───────────────────────────────────────────────────────────────

export function scorePublish(ctx: DetectorContext): ScorecardSlice[] {
  const slices: ScorecardSlice[] = [];
  const slug = appSlug(ctx);

  // ── P-A1 — published app URL resolves + plan.devUrl interpolates appId ───────
  // §0.6: "published `apps/<appName>/` URL status + `plan.devUrl` resolves &
  // interpolates appId". 4=200 & correct app; 0=404/wrong app/uninterpolated slug.
  //
  // The deterministic scorer cannot issue the HTTP-200 probe (no network I/O),
  // so the live-status half is disclaimed. We DO statically score `plan.devUrl`:
  //   - completeness (a full http(s) URL, not a truncated fragment), and
  //   - appId interpolation (the slug actually appears in the URL — an
  //     un-interpolated `apps/<appName>/` template literal is the 0 case).
  {
    const ev = DDB_REF('devUrl');
    const devUrl = ctx.plan.devUrl;
    if (!devUrl) {
      slices.push(
        needsInstrumentation(
          'P-A1',
          'plan.devUrl not recorded (nothing published yet); published-URL HTTP-200 status is not probed by the deterministic scorer',
          ev,
        ),
      );
    } else if (!isFullUrl(devUrl)) {
      // Truncated / non-URL shape — uninterpolated or malformed (the 0 case).
      slices.push(
        makeSlice({
          criterionId: 'P-A1',
          score: 0,
          value: devUrl,
          evidence: ev,
          verdict: '🔴',
          note: 'plan.devUrl is not a full http(s) URL (truncated/uninterpolated); live HTTP-200 status is not probed by the deterministic scorer',
        }),
      );
    } else {
      // Uninterpolated template-literal slug is the explicit 0 case in §0.6.
      const stillTemplated = /<appName>|<appId>|\$\{/.test(devUrl);
      // The app slug should appear in the published URL (apps/<slug>/ or a
      // subdomain). When we have a slug and it is absent, the URL likely points
      // at the wrong app — score it down but disclaim the liveness check.
      const slugPresent = !slug || devUrl.includes(slug);
      if (stillTemplated) {
        slices.push(
          makeSlice({
            criterionId: 'P-A1',
            score: 0,
            value: devUrl,
            evidence: ev,
            verdict: '🔴',
            note: 'plan.devUrl still contains an un-interpolated slug placeholder (<appName>/<appId>/${…})',
          }),
        );
      } else if (!slugPresent) {
        slices.push(
          makeSlice({
            criterionId: 'P-A1',
            score: 1,
            value: devUrl,
            evidence: ev,
            verdict: '🟡',
            note: `plan.devUrl does not contain the app slug "${slug}" — possible wrong-app target; live HTTP-200/correct-app status not probed by the deterministic scorer`,
          }),
        );
      } else {
        // Full, interpolated URL that names the app. Shape is good; the live
        // 200 + correct-render half is out of the deterministic scorer's reach.
        slices.push(
          makeSlice({
            criterionId: 'P-A1',
            score: 3,
            value: devUrl,
            evidence: ev,
            verdict: '🟢',
            note: '[needs-instrumentation: published-URL HTTP-200 status not probed by the deterministic scorer; URL shape verified full & appId interpolated]',
          }),
        );
      }
    }
  }

  // ── P-X1 — data/projects.json integrity (valid JSON, scoped, no homepage corruption)
  // §0.6: "`data/projects.json` integrity (valid JSON, scoped)". 4=valid &
  // scoped, no homepage corruption; 0=overwrites/corrupts.
  //
  // The published `data/projects.json` content + the homepage-corruption signal
  // live in the public bucket / publish write manifest, which the deterministic
  // scorer does not read (it is itself read-only against that bucket — §2). The
  // integrity of the exported JSON is therefore not witnessable here.
  slices.push(
    needsInstrumentation(
      'P-X1',
      'data/projects.json write content/validity is in the public-bucket publish manifest (export-public-projects.ts output), not surfaced to the deterministic scorer',
      LOG_REF('publish-manifest#data/projects.json'),
    ),
  );

  // ── P-S1 — scoped-path safety (writes confined to the 4-path allowlist) ──────
  // §0.6: "S3 write paths vs 4-path allowlist; homepage `index.html` mtime
  // unchanged". 4=confined; **0=touches homepage root (2026-04-15 incident class
  // → forces F, §0.4)**. SAFETY HARD-CAP criterion (weight 3).
  //
  // The set of S3 write paths and the homepage `index.html` mtime are publish-
  // COMMAND / write-manifest facts not surfaced to the deterministic scorer.
  // A missing safety witness must NOT read as a false-green (that would be the
  // most dangerous possible fabrication for an F-forcing criterion), nor as a
  // false-red (which would gratuitously force the whole run to F). We emit '⚪'
  // and disclaim the detection seam explicitly.
  slices.push(
    needsInstrumentation(
      'P-S1',
      'scoped-path safety (S3 write paths vs the 4-path allowlist + homepage index.html mtime, the 2026-04-15 incident class) is observable only from the publish command / S3 write manifest, not surfaced to the deterministic scorer — emitting ⚪ rather than a false-green on an F-forcing safety criterion',
      LOG_REF('publish-manifest#s3-write-paths + homepage-index.html.mtime'),
    ),
  );

  // ── P-M1 — media uploads land under media/<projectId>/ only ──────────────────
  // §0.6: "upload paths". 4=under `media/<projectId>/` only; 0=stray writes.
  //
  // Media is uploaded via the API pre-signed upload endpoint (CLAUDE.md
  // allowlist), not by the publish step the scorer can see; the upload key paths
  // are not surfaced to the deterministic scorer.
  slices.push(
    needsInstrumentation(
      'P-M1',
      'media upload key paths (pre-signed-upload endpoint writes to media/<projectId>/) are not surfaced to the deterministic scorer',
      LOG_REF('publish-manifest#media-upload-keys'),
    ),
  );

  // ── P-I1 — publish idempotent & re-runnable ──────────────────────────────────
  // §0.6: "re-publish behavior". 4=idempotent; 0=duplicates/breaks.
  //
  // Re-publish dedupe behavior requires observing two publish runs' write
  // manifests (do the same keys overwrite vs duplicate); the scorer sees neither.
  slices.push(
    needsInstrumentation(
      'P-I1',
      're-publish idempotency requires comparing write manifests across two publish runs; neither is surfaced to the deterministic scorer',
      LOG_REF('publish-manifest#rerun-key-diff'),
    ),
  );

  return slices;
}
