/**
 * QA-AUTHOR — the deterministic probe compiler (agentic-l2-autonomy-backlog §3).
 *
 * THE KEYSTONE. The pamcan6 disease: a `verify:'behavior'`/`'state'` AC reaches
 * QA as a visual test with `level:'L2'` but `flow:(none)` (the DEV agent, busy
 * building the app, skipped probe authoring) — so the deployed `CONTRACT_INCOMPLETE`
 * gate can only BLOCK it. This module turns the AC's INTENT (`verify`) + its BDD
 * triple (`when`/`then`/`thenObservable`) + the boilerplate's locked seam shape
 * into an EXECUTABLE probe `flow` (reach → act → observe → assert), so the gate
 * passes real verification instead of blocking honestly.
 *
 * Deterministic-first by law (no LLM): we only author a flow when the prose
 * `thenObservable`/`then` maps to a CONCRETE assertion against a key the app
 * actually publishes (RULE-4 — the emitted `expr` must be a member of the locked
 * snapshot shape). When it doesn't map, we leave the test flow-less on purpose:
 * the deployed `CONTRACT_INCOMPLETE` gate then blocks it honestly rather than us
 * fabricating an assertion the app can't satisfy.
 *
 * Pure functions, no I/O. Wired at the QA chokepoint (`launchPlanQaAggregate`,
 * after backfill / before classification) so every test that reaches QA — and the
 * operator's contract-review draft — has been through the compiler.
 */

import type {
  VisualTestDef,
  VisualTestFlowStep,
  AcceptanceCriterion,
  AssertOp,
} from '../types/epic-workflow';
import type { SeamContract } from './qa-boilerplate-resolver';

/** A compiled deterministic assertion against the seam snapshot. */
export interface CompiledAssert {
  expr: string;
  op: AssertOp;
  expected: string | number | boolean;
}

/**
 * Status-enum synonyms — prose rarely says the literal enum token ("the GAME
 * OVER overlay", not "status over"). Map common surface forms to the canonical
 * enum value so `thenObservable` compiles. Only applied when the mapped value is
 * actually in the boilerplate's declared `statusEnum` (no invented states).
 */
const STATUS_SYNONYMS: ReadonlyArray<{ re: RegExp; value: string }> = [
  { re: /\bgame[\s-]?over\b|\bdefeat(ed)?\b|\byou (?:lose|lost)\b/i, value: 'over' },
  {
    re: /\bwin(?:s|ning)?\b|\bvictor(?:y|ious)\b|\byou (?:win|won)\b|\blevel[\s-]?complete\b/i,
    value: 'win',
  },
  { re: /\bpaused?\b/i, value: 'paused' },
  { re: /\b(?:running|playing|in progress|gameplay|started)\b/i, value: 'running' },
  { re: /\b(?:idle|start screen|title screen|not started|ready to start)\b/i, value: 'idle' },
];

/** Camel/Pascal/snake key → a loose word-boundary matcher ("gameOver" → /game ?over/i). */
function keyToProseRegex(key: string): RegExp {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase()
    .trim();
  const escaped = words.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s-]?');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

/**
 * QAA-2 — compile a prose-observable outcome into a concrete `{expr, op, expected}`
 * against the seam snapshot. Deterministic pattern cascade (first match wins):
 *   1. a `status` enum value (literal or synonym) → `snapshot.status eq <value>`
 *   2. a numeric snapshot key + comparator/number → `snapshot.<key> <op> <n>`
 *   3. a snapshot key named in prose as shown/true → `snapshot.<key> truthy`
 * Returns null when nothing maps to a real key (caller leaves the test flow-less
 * so CONTRACT_INCOMPLETE blocks it honestly). RULE-4: the emitted `expr` is always
 * `snapshot.<key>` for a `key` proven to be in `seam.snapshotKeys`.
 */
export function compileObservableToAssert(
  prose: string | undefined,
  seam: SeamContract,
): CompiledAssert | null {
  if (!prose || !prose.trim()) return null;
  const text = prose.trim();
  const hasStatus = seam.snapshotKeys.includes('status');

  // 1. status enum — literal token or synonym, gated on the declared enum.
  if (hasStatus && seam.statusEnum && seam.statusEnum.length > 0) {
    for (const v of seam.statusEnum) {
      if (new RegExp(`\\b${v}\\b`, 'i').test(text)) {
        return { expr: 'snapshot.status', op: 'eq', expected: v };
      }
    }
    for (const { re, value } of STATUS_SYNONYMS) {
      if (seam.statusEnum.includes(value) && re.test(text)) {
        return { expr: 'snapshot.status', op: 'eq', expected: value };
      }
    }
  }

  // 2. numeric key + comparator/number (e.g. "score is at least 100", "score increases").
  for (const key of seam.snapshotKeys) {
    if (key === 'status') continue;
    const keyRe = keyToProseRegex(key);
    if (!keyRe.test(text)) continue;
    const numMatch = /\b(-?\d+(?:\.\d+)?)\b/.exec(text);
    const gte = /\b(at least|>=|minimum|min|or more|or greater)\b/i.test(text);
    const gt = /\b(greater|more than|above|increase[sd]?|goes? up|exceeds?|over)\b/i.test(text);
    const lte = /\b(at most|<=|maximum|max|or less|or fewer)\b/i.test(text);
    const lt = /\b(less than|below|fewer than|under|decrease[sd]?|goes? down)\b/i.test(text);
    if (numMatch) {
      const n = Number(numMatch[1]);
      const op: AssertOp = gte ? 'gte' : lte ? 'lte' : lt ? 'lt' : gt ? 'gt' : 'eq';
      return { expr: `snapshot.${key}`, op, expected: n };
    }
    if (gt || gte) return { expr: `snapshot.${key}`, op: 'gt', expected: 0 };
    // 3. key named, no number — treat as a truthiness/visibility claim.
    if (/\b(shown|visible|displayed|appears?|present|true|set|exists?)\b/i.test(text)) {
      return { expr: `snapshot.${key}`, op: 'truthy', expected: true };
    }
  }

  return null;
}

/**
 * Derive the "reach" steps that drive the app to the asserted state, from the
 * AC's `when` clause + the compiled assertion. Prefers the DETERMINISTIC seam
 * `force` for a status transition (no flaky gameplay); falls back to a key press
 * parsed from `when`. Returns [] when the state is observable at idle load.
 */
function deriveReachSteps(
  ac: Pick<AcceptanceCriterion, 'when' | 'verify'>,
  assert: CompiledAssert,
  seam: SeamContract,
): VisualTestFlowStep[] {
  const when = (ac.when || '').toLowerCase();

  // Deterministic reach: force a status transition (the seam's forceStatus).
  // Only for a non-idle target the boilerplate actually declares.
  if (
    assert.expr === 'snapshot.status' &&
    typeof assert.expected === 'string' &&
    assert.expected !== 'idle' &&
    (seam.statusEnum?.includes(assert.expected) ?? false)
  ) {
    return [
      { action: 'force', status: assert.expected },
      {
        action: 'waitForEvent',
        expr: 'snapshot.status',
        op: 'eq',
        expected: assert.expected,
        timeoutMs: 5000,
      },
    ];
  }

  // Key-press reach parsed from the `when` clause.
  const keyMap: ReadonlyArray<{ re: RegExp; key: string }> = [
    { re: /\b(space ?bar|space)\b/, key: 'Space' },
    { re: /\benter|return\b/, key: 'Enter' },
    { re: /\barrow ?up|up arrow\b/, key: 'ArrowUp' },
    { re: /\barrow ?down|down arrow\b/, key: 'ArrowDown' },
    { re: /\barrow ?left|left arrow\b/, key: 'ArrowLeft' },
    { re: /\barrow ?right|right arrow\b/, key: 'ArrowRight' },
    { re: /\bescape|esc\b/, key: 'Escape' },
  ];
  for (const { re, key } of keyMap) {
    if (re.test(when)) {
      return [
        { action: 'press', key },
        { action: 'wait', ms: 400 },
      ];
    }
  }

  // No deterministic reach derivable → observe at idle (the assert still runs).
  return [];
}

/** Does this flow already carry a deterministic oracle (assert / waitForEvent)? */
function hasOracle(flow: VisualTestFlowStep[] | undefined): boolean {
  return (
    Array.isArray(flow) && flow.some((s) => s.action === 'assert' || s.action === 'waitForEvent')
  );
}

export type AuthorAction = 'kept' | 'authored' | 'unmappable' | 'skipped';

export interface AuthorResult {
  test: VisualTestDef;
  action: AuthorAction;
  note: string;
}

/**
 * QAA-1 — author (or repair) the probe flow for ONE test against its AC + seam.
 *   • not a state/behavior AC, or no seam → `skipped` (untouched).
 *   • already has an assert/waitForEvent oracle → `kept` (DEV did its job).
 *   • prose compiles to a real assert → `authored` (flow synthesized, level L2).
 *   • prose doesn't map to any published key → `unmappable` (left flow-less; the
 *     deployed CONTRACT_INCOMPLETE gate blocks it honestly).
 */
export function authorProbeFlow(
  test: VisualTestDef,
  ac: AcceptanceCriterion | undefined,
  seam: SeamContract | undefined,
): AuthorResult {
  if (!seam || !ac || (ac.verify !== 'state' && ac.verify !== 'behavior')) {
    return { test, action: 'skipped', note: 'not a seam-verifiable state/behavior AC' };
  }
  if (hasOracle(test.flow)) {
    return { test, action: 'kept', note: 'test already carries an assert/waitForEvent oracle' };
  }

  // Compile the prose-observable (prefer the explicit thenObservable; fall back
  // to the `then` claim, then the legacy `expect` text).
  const assert =
    compileObservableToAssert(ac.thenObservable, seam) ||
    compileObservableToAssert(ac.then, seam) ||
    compileObservableToAssert(test.expect, seam);

  if (!assert) {
    return {
      test,
      action: 'unmappable',
      note: `no deterministic mapping from "${(ac.thenObservable || ac.then || test.expect || '').slice(0, 80)}" to a published snapshot key [${seam.snapshotKeys.join(', ')}] — left flow-less so CONTRACT_INCOMPLETE blocks it`,
    };
  }

  const reach = deriveReachSteps(ac, assert, seam);
  const flow: VisualTestFlowStep[] = [
    ...reach,
    { action: 'screenshot', label: 'after' },
    { action: 'assert', expr: assert.expr, op: assert.op, expected: assert.expected },
  ];

  return {
    test: { ...test, level: 'L2', flow },
    action: 'authored',
    note: `authored ${flow.length}-step probe → assert ${assert.expr} ${assert.op} ${JSON.stringify(assert.expected)}`,
  };
}

export interface AuthorProbeFlowsInput {
  tests: ReadonlyArray<VisualTestDef>;
  /** AC lookup by `criteriaRef` (id → criterion). */
  criteriaByRef: ReadonlyMap<string, AcceptanceCriterion>;
  seam: SeamContract | undefined;
}

export interface AuthorProbeFlowsOutput {
  tests: VisualTestDef[];
  log: Array<{ testId: string; action: AuthorAction; note: string }>;
}

/**
 * QAA-1 — run the compiler over every test in a plan. Returns the enriched test
 * list (authored flows in place) + a per-test log the launcher surfaces so the
 * operator sees exactly which probes were synthesized vs left to block.
 */
export function authorProbeFlows(input: AuthorProbeFlowsInput): AuthorProbeFlowsOutput {
  const tests: VisualTestDef[] = [];
  const log: AuthorProbeFlowsOutput['log'] = [];
  for (const t of input.tests) {
    const ac = t.criteriaRef ? input.criteriaByRef.get(t.criteriaRef) : undefined;
    const r = authorProbeFlow(t, ac, input.seam);
    tests.push(r.test);
    if (r.action !== 'skipped' && r.action !== 'kept') {
      log.push({ testId: t.id, action: r.action, note: r.note });
    }
  }
  return { tests, log };
}
