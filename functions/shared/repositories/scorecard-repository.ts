/**
 * scorecard-repository.ts — Plan Retrospect (plan-retrospect-spec §5).
 *
 * DDB layer for the `futurator-scorecards` table — the durable, comparable,
 * operator-visible Reality Check verdicts (the internal "scorecard" identifier
 * survives only in storage/job contracts; the operator-facing name is "Plan
 * Retrospect / Reality Check" — see scorecard/types.ts).
 *
 * Schema (spec §5):
 *   PK  planId
 *   SK  `<stage>#<rubricVersion>`   e.g. `development#v0`, `overview#v0`
 *
 * Why `rubricVersion` in the SK: re-scoring a stage under a NEWER rubric writes
 * a NEW row (different SK), PRESERVING the prior verdict. Never silently
 * overwrite a verdict under a changed ruler — that corrupts the §9 trend. The
 * "latest row per stage" is a Query on `planId` + `begins_with(SK, '<stage>#')`
 * ordered descending (newest rubric first).
 *
 * Read-only against the public bucket: this repo only touches its own DDB
 * table — never `aws s3 sync`, never `out/`, never the public bucket root
 * (CLAUDE.md 2026-04-15 guardrail; the feature grades the safety criterion it
 * itself satisfies).
 */

import { PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { docClient, TABLE_NAMES } from '../dynamo-client';
import type {
  StageId,
  Verdict,
  EvidenceRef,
  ImprovementAction,
  ScorecardSlice,
} from '../scorecard/types';
import type { GradeBand } from '../scorecard/rollup';

/**
 * One stored row = one stage's full verdict under one rubric version (spec §5
 * "Item fields"). Maps a `ScorecardSlice[]` into the rubric §0.5 storage view:
 * the per-criterion maps (`scores`/`verdicts`/`evidenceRefs`) are keyed by
 * `criterionId`; the rollup fields (`pipelineHealth`/`gradeBand`) live only on
 * the `overview#` row.
 */
export interface ScorecardItem {
  /** PK — never hardcoded; the plan under retrospect. */
  planId: string;
  /** SK — `<stage>#<rubricVersion>`. */
  scorecardKey: string;
  stage: StageId;

  /** Every graded criterion's 0–4 score (⚪/null criteria are omitted). */
  scores: Record<string, 0 | 1 | 2 | 3 | 4>;
  /** Traffic-light per graded criterion (⚪ criteria are omitted). */
  verdicts: Record<string, Verdict>;
  /** Evidence ref/anchor per criterion — NOT a data dump (spec §5). */
  evidenceRefs: Record<string, EvidenceRef>;
  /**
   * The full graded slices for this stage (refs, not dumps — each slice's
   * `evidence` is an `EvidenceRef`). Carried so `GET /scorecard` can return the
   * UI's `RealityCheck.slices[]` without re-deriving from the compact maps.
   */
  slices?: ScorecardSlice[];

  /** Rollup health 0–1 — only on the `overview#` row. */
  pipelineHealth?: number;
  /** §9 grade band — only on the `overview#` row. */
  gradeBand?: GradeBand;
  /** vs v0 baseline (Phase 1–2). */
  topRegressions?: string[];
  /** vs v0 baseline (Phase 1–2). */
  topWins?: string[];
  /** Generated so-what actions (composer output). */
  actions?: ImprovementAction[];

  /** The ruler used (also in the SK). */
  rubricVersion: string;
  /** daemon+prompts SHA stamped on the plan (§9 V1). */
  pipelineVersion?: string;
  /** From `ForensicPayload.schemaVersion` (§9 V3). */
  forensicSchemaVersion?: string;
  /** OV4 cost-honesty flag (§8 SQ4). */
  confidence?: 'reconciled' | 'unreconciled';
  /** `'deterministic'` or the Assessor job id (+model). */
  scoredBy: string;
  /** ISO timestamp. */
  scoredAt: string;
}

/** The fields a caller supplies; the repo derives `planId`/`scorecardKey`/`stage`. */
export type ScorecardItemInput = Omit<ScorecardItem, 'planId' | 'scorecardKey' | 'stage'>;

/** Build the composite sort key `<stage>#<rubricVersion>`. */
export function scorecardKey(stage: StageId, rubricVersion: string): string {
  return `${stage}#${rubricVersion}`;
}

/**
 * Upsert one stage's verdict row. A given `(planId, stage, rubricVersion)` is a
 * single SK, so re-running the SAME stage under the SAME rubric overwrites
 * (latest wins) — intentional: a re-score under an UNCHANGED ruler is a
 * correction, not history. A NEWER rubric → a different SK → a new row (history
 * preserved). The stored `rubricVersion`/`scoredAt` always match the SK + run.
 */
export async function putScorecardSlice(
  planId: string,
  stage: StageId,
  rubricVersion: string,
  item: ScorecardItemInput,
): Promise<ScorecardItem> {
  const row: ScorecardItem = {
    ...item,
    planId,
    stage,
    scorecardKey: scorecardKey(stage, rubricVersion),
    // The SK is the authority — pin the stored fields to it regardless of what
    // the caller passed, so they can never drift apart.
    rubricVersion,
  };
  await docClient.send(new PutCommand({ TableName: TABLE_NAMES.scorecards, Item: row }));
  return row;
}

/**
 * Reduce a `planId`'s rows to ONE-per-stage: the latest `rubricVersion`. We
 * Query the whole partition (one plan = at most a handful of rows: ≤6 stages ×
 * a few rubric versions) and keep, per stage, the row whose SK sorts highest
 * (`<stage>#<rubricVersion>` — rubric versions are `v0`,`v1`,… so lexical
 * descending == newest). DDB Query already sorts by SK; we walk descending and
 * take the first row seen for each stage.
 */
export async function getScorecard(planId: string): Promise<ScorecardItem[]> {
  const rows = await queryPlanRows(planId);
  // Descending SK so the first row per stage is its newest rubric.
  rows.sort((a, b) => b.scorecardKey.localeCompare(a.scorecardKey));
  const latestByStage = new Map<StageId, ScorecardItem>();
  for (const row of rows) {
    if (!latestByStage.has(row.stage)) latestByStage.set(row.stage, row);
  }
  return [...latestByStage.values()];
}

/**
 * One stage's latest slice (newest `rubricVersion`). Uses `begins_with` so we
 * only read that stage's rows, then keeps the highest SK.
 */
export async function getScorecardStage(
  planId: string,
  stage: StageId,
): Promise<ScorecardItem | null> {
  const result = await docClient.send(
    new QueryCommand({
      TableName: TABLE_NAMES.scorecards,
      KeyConditionExpression: 'planId = :planId AND begins_with(scorecardKey, :prefix)',
      ExpressionAttributeValues: { ':planId': planId, ':prefix': `${stage}#` },
      // Newest rubric first (lexical descending over `<stage>#vN`).
      ScanIndexForward: false,
      Limit: 1,
    }),
  );
  const items = (result.Items as ScorecardItem[] | undefined) ?? [];
  return items[0] ?? null;
}

/** Query every row for a plan (paginated). Partition is small per plan. */
async function queryPlanRows(planId: string): Promise<ScorecardItem[]> {
  const out: ScorecardItem[] = [];
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const result = await docClient.send(
      new QueryCommand({
        TableName: TABLE_NAMES.scorecards,
        KeyConditionExpression: 'planId = :planId',
        ExpressionAttributeValues: { ':planId': planId },
        ExclusiveStartKey,
      }),
    );
    if (result.Items) out.push(...(result.Items as ScorecardItem[]));
    ExclusiveStartKey = result.LastEvaluatedKey as Record<string, unknown> | undefined;
  } while (ExclusiveStartKey);
  return out;
}
