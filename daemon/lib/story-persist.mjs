// story-persist — DynamoDB UpdateExpression builder for StoryNode write-backs.
//
// The single source of truth for how a story-dev run's output (state, verdict,
// bound ACs, cost metrics, commit SHA) maps onto the plan-spec-graph DynamoDB
// row. Caller supplies Key { storyId } + TableName and spreads the returned
// object into an UpdateCommand.
//
// Design invariants (development-plan G1):
//   • Alias EVERY attribute name (#key → avoid DynamoDB reserved words: `state`,
//     `status`, `name`, `cost`, etc.). Using a uniform alias strategy is safer
//     than maintaining a per-key allowlist.
//   • updatedAt is ALWAYS appended EXACTLY ONCE — never passed by the caller, so
//     "Two document paths overlap" (DDB validation error) is structurally impossible.
//   • `metrics` is flattened into costUsd / inputTokens / outputTokens / durationMs
//     (metrics wins over same-named top-level fields).
//   • Writes the WHOLE acceptanceCriteria array (post-run copy) — no item-level
//     surgery, consistent with the StoryNode schema.

/**
 * Build a DynamoDB UpdateCommand body for a StoryNode write-back.
 *
 * @param {{
 *   state?: string,
 *   verdict?: object,
 *   acceptanceCriteria?: object[],
 *   commitSha?: string,
 *   costUsd?: number,
 *   inputTokens?: number,
 *   outputTokens?: number,
 *   durationMs?: number,
 *   loadedSkills?: Array<{ skill: string, source: string }>,
 *   metrics?: {
 *     costUsd?: number,
 *     inputTokens?: number,
 *     outputTokens?: number,
 *     durationMs?: number,
 *     sessionId?: string,
 *     numTurns?: number,
 *   },
 * }} fields
 * @returns {{
 *   UpdateExpression: string,
 *   ExpressionAttributeNames: Record<string, string>,
 *   ExpressionAttributeValues: Record<string, any>,
 * }}
 */
export function buildStoryStateUpdate({
  state,
  verdict,
  acceptanceCriteria,
  commitSha,
  costUsd: costUsdDirect,
  inputTokens: inputTokensDirect,
  outputTokens: outputTokensDirect,
  durationMs: durationMsDirect,
  loadedSkills,
  metrics,
} = {}) {
  // Flatten metrics{} into individual fields (metrics wins on conflict).
  const costUsd =
    metrics?.costUsd !== undefined ? metrics.costUsd : costUsdDirect;
  const inputTokens =
    metrics?.inputTokens !== undefined ? metrics.inputTokens : inputTokensDirect;
  const outputTokens =
    metrics?.outputTokens !== undefined ? metrics.outputTokens : outputTokensDirect;
  const durationMs =
    metrics?.durationMs !== undefined ? metrics.durationMs : durationMsDirect;

  // An empty loadedSkills array must NOT clobber a prior non-empty write
  // (a failed retry with no skills shouldn't erase the set the green attempt saved).
  const loadedSkillsField =
    Array.isArray(loadedSkills) && loadedSkills.length > 0 ? loadedSkills : undefined;

  // Ordered field pairs. Entries with undefined values are excluded.
  const fieldPairs = [
    ['state', state],
    ['verdict', verdict],
    ['acceptanceCriteria', acceptanceCriteria],
    ['commitSha', commitSha],
    ['costUsd', costUsd],
    ['inputTokens', inputTokens],
    ['outputTokens', outputTokens],
    ['durationMs', durationMs],
    ['loadedSkills', loadedSkillsField],
  ].filter(([, v]) => v !== undefined);

  const names = {};
  const values = {};
  const expressions = [];

  for (const [key, value] of fieldPairs) {
    names[`#${key}`] = key;
    values[`:${key}`] = value;
    expressions.push(`#${key} = :${key}`);
  }

  // updatedAt — ALWAYS appended EXACTLY ONCE.
  // Never passed by the caller so DDB's "Two document paths overlap" error is
  // impossible (unlike updateJobFields which the caller must never pass updatedAt to).
  names['#updatedAt'] = 'updatedAt';
  values[':updatedAt'] = new Date().toISOString();
  expressions.push('#updatedAt = :updatedAt');

  return {
    UpdateExpression: `SET ${expressions.join(', ')}`,
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: values,
  };
}
