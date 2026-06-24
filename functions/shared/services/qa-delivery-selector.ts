/**
 * qa-delivery-selector.ts — Stage B (qa-review-delivery-rethink.md §3.1, §4).
 *
 * The reframe: FINAL QA verifies the DELIVERED product's key journeys on the
 * merged plan (dev) — NOT a replay of every per-AC test grouped by epic. The
 * exhaustive per-AC verification already happened at the WAVE GATE on merged
 * code; final QA should be the small, high-signal "does the integrated product
 * deliver its value" pass.
 *
 * This selector turns the flat per-AC test list into a curated DELIVERY set:
 *
 *   • KEEP every interaction test — state/behavior probes, human-tier tests, and
 *     anything carrying a real interaction flow. These ARE the journeys ("load &
 *     start", "move & eat", "game over") and the operator-approval items.
 *   • KEEP a capped, representative set of APPEARANCE/idle tests per capability
 *     (epic) — enough to confirm "the delivered screens look right" without
 *     re-litigating every static AC.
 *   • DEFER the rest (redundant static/intermediate appearance tests) to the wave
 *     gate, which verified them exhaustively on merged code.
 *
 * Pure, deterministic, no I/O. Backward-safe: with `cap = Infinity` (or a plan
 * that is all-interaction) it returns everything, i.e. today's behavior.
 */

import type { VisualTestDef, AcceptanceCriterion } from '../types/epic-workflow';

export type DeliveryTest<T extends VisualTestDef = VisualTestDef> = T & {
  epicId?: string;
  storyId?: string;
};

/** A real interaction flow = any step beyond passive screenshot/navigate. */
function hasInteractionFlow(t: VisualTestDef): boolean {
  return (
    Array.isArray(t.flow) &&
    t.flow.some((s) => s && s.action !== 'screenshot' && s.action !== 'navigate')
  );
}

/**
 * Is this a JOURNEY/delivery-critical test (always kept at final QA)?
 *  - carries an interaction flow (a reach → observe probe), OR
 *  - human-tier (operator approves), OR
 *  - the linked AC is state/behavior (a dynamic capability, even if its flow
 *    hasn't been authored yet — we never want to silently drop a behavior claim).
 */
export function isJourneyTest(t: VisualTestDef, ac: AcceptanceCriterion | undefined): boolean {
  if (t.humanVerify) return true;
  if (hasInteractionFlow(t)) return true;
  const v = ac?.verify;
  return v === 'state' || v === 'behavior';
}

export interface SelectDeliveryInput<T extends VisualTestDef> {
  tests: ReadonlyArray<DeliveryTest<T>>;
  criteriaByRef: ReadonlyMap<string, AcceptanceCriterion>;
  /** Max representative APPEARANCE/idle tests kept per epic (capability). Default 2. */
  appearanceCapPerEpic?: number;
}

export interface SelectDeliveryResult<T extends VisualTestDef> {
  /** The curated delivery set final QA runs. */
  selected: DeliveryTest<T>[];
  /** Appearance/idle tests deferred to the wave gate (NOT a coverage loss — the
   *  gate verified them on merged code). Surfaced so the operator sees what moved. */
  deferred: DeliveryTest<T>[];
  /** Per-test reason, for the operator-facing log. */
  log: Array<{ testId: string; kept: boolean; reason: string }>;
}

/**
 * Curate the final-QA delivery set. Interaction/state/behavior/human tests are
 * always kept; appearance/idle tests are capped per epic; the overflow is deferred
 * to the wave gate. Stable order preserved.
 */
export function selectDeliveryTests<T extends VisualTestDef>(
  input: SelectDeliveryInput<T>,
): SelectDeliveryResult<T> {
  const cap = input.appearanceCapPerEpic ?? 2;
  const selected: DeliveryTest<T>[] = [];
  const deferred: DeliveryTest<T>[] = [];
  const log: SelectDeliveryResult<T>['log'] = [];
  const appearanceKeptByEpic = new Map<string, number>();

  for (const t of input.tests) {
    const ac = t.criteriaRef ? input.criteriaByRef.get(t.criteriaRef) : undefined;
    if (isJourneyTest(t, ac)) {
      selected.push(t);
      log.push({
        testId: t.id,
        kept: true,
        reason: 'journey/interaction/human — always run at delivery QA',
      });
      continue;
    }
    // Appearance / idle test — keep up to the per-epic cap, defer the rest.
    const epic = t.epicId ?? '∅';
    const kept = appearanceKeptByEpic.get(epic) ?? 0;
    if (kept < cap) {
      appearanceKeptByEpic.set(epic, kept + 1);
      selected.push(t);
      log.push({
        testId: t.id,
        kept: true,
        reason: `representative appearance check (${kept + 1}/${cap} for this capability)`,
      });
    } else {
      deferred.push(t);
      log.push({
        testId: t.id,
        kept: false,
        reason:
          'redundant static appearance — deferred to the wave gate (already verified on merged code)',
      });
    }
  }

  return { selected, deferred, log };
}
