/**
 * triage-relevance.ts — Pipeline v2 Phase 3 / Story 3-E-6-1 (PR-81).
 *
 * Pure scoring for cross-plan triage history matching. v2.5 §43:
 *
 *   relevance_score = base_similarity × project_match_modifier
 *
 *   project_match_modifier:
 *     same project        1.0
 *     same product family 0.7  (Songster main + Songster live-perf)
 *     same org (default)  0.4  (cross-product Futurator)
 *
 * Operator "this isn't relevant" decay lives in
 * `inbox/triage-decline-history.md` — the runner reads that file and
 * passes a `declinedPairs` set so this helper can apply the decay.
 */

export type ProjectMatchTier = 'same-project' | 'same-family' | 'cross-product';

export const MATCH_MODIFIERS: Record<ProjectMatchTier, number> = {
  'same-project': 1.0,
  'same-family': 0.7,
  'cross-product': 0.4,
};

/** Multiplicative decay applied when the operator flagged this case-pair as not relevant. */
export const NOT_RELEVANT_DECAY = 0.3;

export interface RelevanceArgs {
  baseSimilarity: number;
  sourceProject: string;
  targetProject: string;
  /**
   * Map: family name → set of project slugs in that family. Optional —
   * when absent, only the same-project / cross-product tiers apply.
   */
  productFamilies?: Record<string, ReadonlySet<string> | readonly string[]>;
  /**
   * Set of `"<sourceCase>::<targetCase>"` keys the operator marked
   * not-relevant. Membership decays the score by `NOT_RELEVANT_DECAY`.
   */
  declinedPairs?: ReadonlySet<string>;
  /** Stable case ids (story id / plan id) the pair refers to — used to look up declinedPairs. */
  sourceCaseId?: string;
  targetCaseId?: string;
}

export interface RelevanceResult {
  score: number;
  tier: ProjectMatchTier;
  modifier: number;
  decayed: boolean;
}

export function classifyMatchTier(
  sourceProject: string,
  targetProject: string,
  productFamilies?: RelevanceArgs['productFamilies'],
): ProjectMatchTier {
  if (sourceProject === targetProject) return 'same-project';
  if (productFamilies) {
    for (const slugs of Object.values(productFamilies)) {
      const set = Array.isArray(slugs) ? new Set(slugs) : slugs;
      if (set.has(sourceProject) && set.has(targetProject)) return 'same-family';
    }
  }
  return 'cross-product';
}

export function computeRelevance(args: RelevanceArgs): RelevanceResult {
  if (
    typeof args.baseSimilarity !== 'number' ||
    args.baseSimilarity < 0 ||
    args.baseSimilarity > 1
  ) {
    throw new Error(`baseSimilarity must be in [0,1], got ${args.baseSimilarity}`);
  }
  const tier = classifyMatchTier(args.sourceProject, args.targetProject, args.productFamilies);
  const modifier = MATCH_MODIFIERS[tier];

  let decayed = false;
  let score = args.baseSimilarity * modifier;
  if (args.sourceCaseId && args.targetCaseId && args.declinedPairs) {
    const key = `${args.sourceCaseId}::${args.targetCaseId}`;
    if (args.declinedPairs.has(key)) {
      decayed = true;
      score *= NOT_RELEVANT_DECAY;
    }
  }

  return { score, tier, modifier, decayed };
}

/**
 * Rank a list of candidate cases by relevance, returning the top N with
 * tier-aware ordering. v2.5 §43 surfaces top 3 by default.
 */
export function topRelevant<TCase>(args: {
  candidates: Array<{ case: TCase; relevance: RelevanceResult }>;
  limit?: number;
}): Array<{ case: TCase; relevance: RelevanceResult }> {
  const limit = args.limit ?? 3;
  return [...args.candidates].sort((a, b) => b.relevance.score - a.relevance.score).slice(0, limit);
}
