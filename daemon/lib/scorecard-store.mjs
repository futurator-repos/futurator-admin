// daemon/lib/scorecard-store.mjs — Plan Retrospect (plan-retrospect-spec §4b).
//
// Daemon-side DDB access to `futurator-scorecards`. The daemon MIRRORS
// functions/shared rather than importing it, so this is a small standalone
// reader/writer the Assessor job uses: the API writes the deterministic stage
// row first; the Assessor reads it (ground-truth context) and merges its graded
// `[LLM]` slices back onto the same row (additive — never clobbers the
// deterministic verdicts).
//
// SK = `<stage>#<rubricVersion>` (matches functions/shared/repositories/
// scorecard-repository.ts). Table name defaults to the literal SST table name
// so it works even if the daemon env doesn't set SCORECARDS_TABLE.

import { GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

const SCORECARDS_TABLE =
  process.env.SCORECARDS_TABLE || process.env.FUTURATOR_SCORECARDS || 'futurator-scorecards';

function scorecardKey(stage, rubricVersion) {
  return `${stage}#${rubricVersion}`;
}

/** Read the stored deterministic row for one (planId, stage, rubricVersion), or null. */
export async function getStoredStageRow(ddb, { planId, stage, rubricVersion }) {
  const res = await ddb.send(
    new GetCommand({
      TableName: SCORECARDS_TABLE,
      Key: { planId, scorecardKey: scorecardKey(stage, rubricVersion) },
    }),
  );
  return res.Item || null;
}

/** Merge the Assessor's graded slices onto the stage row (additive). */
export async function putAssessorSlices(ddb, { planId, stage, rubricVersion, slices, scoredBy }) {
  await ddb.send(
    new UpdateCommand({
      TableName: SCORECARDS_TABLE,
      Key: { planId, scorecardKey: scorecardKey(stage, rubricVersion) },
      UpdateExpression: 'SET assessorSlices = :s, assessorScoredBy = :by, assessorScoredAt = :at',
      ExpressionAttributeValues: {
        ':s': Array.isArray(slices) ? slices : [],
        ':by': scoredBy || 'assessor',
        ':at': new Date().toISOString(),
      },
    }),
  );
}
