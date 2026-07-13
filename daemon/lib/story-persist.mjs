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
 *   invariants?: object[],
 *   stageSummaries?: object,
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
  invariants,
  stageSummaries,
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

  // Same clobber guard for invariants (dossier A1): the validator bindings on
  // the row are what let a RESUMED job rebind without a fresh <INVARIANTS>
  // manifest — an accidental empty write would recreate the deterministic
  // retry dead-end this field exists to fix.
  const invariantsField =
    Array.isArray(invariants) && invariants.length > 0 ? invariants : undefined;

  // Ordered field pairs. Entries with undefined values are excluded.
  const fieldPairs = [
    ['state', state],
    ['verdict', verdict],
    ['acceptanceCriteria', acceptanceCriteria],
    ['invariants', invariantsField],
    ['commitSha', commitSha],
    ['costUsd', costUsd],
    ['inputTokens', inputTokens],
    ['outputTokens', outputTokens],
    ['durationMs', durationMs],
    ['loadedSkills', loadedSkillsField],
    ['stageSummaries', stageSummaries],
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

// ── stageSummaries size caps (dossier B2 contract) ─────────────────────────────
// The row must stay well under the DynamoDB 400KB item limit even for a story
// whose Test-Author committed many/large test files: preview ≤2000 chars per
// file, total stageSummaries JSON ≤48KB. Previews are truncated FIRST (they are
// the only unbounded payload); structural fields (shas, bindings, attempts) are
// only trimmed as a last resort.

export const STAGE_SUMMARY_PREVIEW_CAP = 2000;
export const STAGE_SUMMARIES_MAX_BYTES = 48 * 1024;

const jsonBytes = (obj) => Buffer.byteLength(JSON.stringify(obj), 'utf8');

/**
 * Enforce the stageSummaries size caps. PURE (deep-copies the input; never
 * mutates the caller's object). Returns undefined for non-object/unserializable
 * input so the persist layer simply skips the field.
 *
 * @param {object|undefined} stageSummaries
 * @returns {object|undefined}
 */
export function capStageSummaries(stageSummaries) {
  if (!stageSummaries || typeof stageSummaries !== 'object') return undefined;
  let s;
  try { s = JSON.parse(JSON.stringify(stageSummaries)); } catch { return undefined; }
  if (!Object.keys(s).length) return undefined; // nothing recorded → skip the field

  const files = Array.isArray(s.testAuthor?.files) ? s.testAuthor.files : [];
  const capPreviews = (cap) => {
    for (const f of files) {
      if (!f || typeof f.preview !== 'string') continue;
      if (cap === 0) delete f.preview;
      else if (f.preview.length > cap) f.preview = f.preview.slice(0, cap);
    }
  };

  // Per-file cap always applies; then shrink previews progressively until the
  // whole object fits (2000 → 500 → gone).
  capPreviews(STAGE_SUMMARY_PREVIEW_CAP);
  for (const cap of [500, 0]) {
    if (jsonBytes(s) <= STAGE_SUMMARIES_MAX_BYTES) return s;
    capPreviews(cap);
  }
  // Previews are gone — trim the remaining unbounded arrays (pathological runs).
  if (jsonBytes(s) > STAGE_SUMMARIES_MAX_BYTES && files.length > 100) {
    s.testAuthor.files = files.slice(0, 100);
  }
  if (jsonBytes(s) > STAGE_SUMMARIES_MAX_BYTES && Array.isArray(s.implementer?.attempts)) {
    for (const a of s.implementer.attempts) {
      if (Array.isArray(a?.filesChanged) && a.filesChanged.length > 100) {
        a.filesChanged = a.filesChanged.slice(0, 100);
      }
    }
  }
  return s;
}
