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
import { isInteractionGated } from './visual-test-classifier';

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
 * Gap 1 (pacman7) — is this a START-GATED app? A boilerplate whose status enum
 * carries both `idle` and `running` boots to a "Press ENTER to Start" screen, so
 * the idle frame is the start screen — gameplay content (maze, sprites, HUD) is
 * NOT visible until the game starts. Probes must leave idle before observing.
 * Guards undefined seam (non-canvas apps).
 */
function isStartGated(seam: SeamContract | undefined): boolean {
  return (
    !!seam?.statusEnum && seam.statusEnum.includes('idle') && seam.statusEnum.includes('running')
  );
}

/** True when the observable is explicitly ABOUT the start/title screen — those
 *  ACs must still be judged on the idle frame, never started past. */
function isStartScreenObservable(text: string | undefined): boolean {
  return /\b(start screen|title screen|press\s+(enter|space|start)|main menu|splash|landing screen|start button|how to play|instructions screen)\b/i.test(
    text || '',
  );
}

/** The reach that leaves a start-gated app's idle screen and enters gameplay. */
function deriveStartReach(): VisualTestFlowStep[] {
  return [
    { action: 'press', key: 'Enter' },
    { action: 'wait', ms: 600 },
  ];
}

/** Normalize a captured key word into a Playwright key name (null if not a key). */
function normalizeKey(raw: string | undefined): string | null {
  const k = String(raw || '')
    .toLowerCase()
    .replace(/[^a-z]/g, '');
  if (!k) return null;
  if (k === 'space' || k === 'spacebar') return 'Space';
  if (k === 'enter' || k === 'return') return 'Enter';
  if (k === 'escape' || k === 'esc') return 'Escape';
  if (k === 'arrowup' || k === 'up') return 'ArrowUp';
  if (k === 'arrowdown' || k === 'down') return 'ArrowDown';
  if (k === 'arrowleft' || k === 'left') return 'ArrowLeft';
  if (k === 'arrowright' || k === 'right') return 'ArrowRight';
  if (k.length === 1) return k; // single-letter key (w/a/s/d/etc.)
  return null;
}

/** Parse the first key press described in prose ("press ArrowRight", "pressing W",
 *  "the Space key", "right arrow"). Returns a Playwright key name or null. */
function parseKey(text: string): string | null {
  let m =
    /\bpress(?:ing|es|ed)?\s+(?:and\s+hold\s+)?(?:the\s+)?["'`]?(arrow\s?(?:up|down|left|right)|space\s?bar|space|enter|return|escape|esc|[a-z])\b/i.exec(
      text,
    );
  if (m) return normalizeKey(m[1]);
  m = /\b(arrow\s?(?:up|down|left|right)|space\s?bar|enter|escape)\s+key\b/i.exec(text);
  if (m) return normalizeKey(m[1]);
  m = /\b(up|down|left|right)\s+arrow\b/i.exec(text);
  if (m) return normalizeKey('arrow' + m[1]);
  return null;
}

/** Parse "click(ing) the <label> button/toggle/…" → the control's visible label. */
function parseClickLabel(text: string): string | null {
  const m =
    /(?:clic\w*|tap\w*)\s+(?:on\s+)?(?:the\s+)?["'`]?([A-Za-z0-9][\w .-]*?)["'`]?\s+(?:button|toggle|tab|link|switch|control|icon)\b/i.exec(
      text,
    );
  return m ? m[1].trim() : null;
}

/** Parse an elapsed-time reach ("after 3 seconds", "a few seconds", "over time"). */
function parseWaitMs(text: string): number {
  const m = /\b(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/i.exec(text);
  if (m) return Math.min(Math.round(parseFloat(m[1]) * 1000), 15000);
  if (/\b(a few|several|some|a couple of|a number of)\s+seconds\b/i.test(text)) return 3000;
  if (
    /\bover time\b|\bafter (?:a|some) (?:while|moment|few moments|time)\b|\beventually\b/i.test(
      text,
    )
  )
    return 3000;
  return 0;
}

/**
 * Derive the interaction reach (the steps that change app state before the
 * screenshot) from the AC/test prose. Order:
 *   1. force a status transition — ONLY when prose describes NO explicit
 *      interaction (terminal states like game-over/win that are hard to script);
 *   2. an explicit click on a named control;
 *   3. an explicit key press;
 *   4. an elapsed-time wait (additive — can follow a press).
 * Returns { steps, isForce }. `isForce` tells the caller to skip the start-gate
 * prefix (force sets state directly, bypassing the keyboard start screen).
 */
function deriveReach(
  srcText: string,
  whenText: string,
  assert: CompiledAssert | null,
  seam: SeamContract | undefined,
): { steps: VisualTestFlowStep[]; isForce: boolean } {
  const explicitInteraction =
    !!parseKey(whenText) ||
    !!parseClickLabel(whenText) ||
    /\b(press|click|tap|type|drag|swipe|move|arrow|key)\b/i.test(whenText);

  // 1. force — deterministic reach to a declared non-idle status, only when no
  // explicit interaction is scriptable from the prose.
  const waitMs = parseWaitMs(srcText);
  if (
    assert &&
    assert.expr === 'snapshot.status' &&
    typeof assert.expected === 'string' &&
    assert.expected !== 'idle' &&
    (seam?.statusEnum?.includes(assert.expected) ?? false) &&
    !explicitInteraction
  ) {
    const steps: VisualTestFlowStep[] = [
      { action: 'force', status: assert.expected },
      {
        action: 'waitForEvent',
        expr: 'snapshot.status',
        op: 'eq',
        expected: assert.expected,
        timeoutMs: 5000,
      },
    ];
    // Elapsed-time observable ("after a few seconds…") — let the forced state run
    // so time-dependent content (ghosts dispersing, animations) actually develops.
    if (waitMs) steps.push({ action: 'wait', ms: waitMs });
    return { steps, isForce: true };
  }

  const steps: VisualTestFlowStep[] = [];
  const label = parseClickLabel(whenText) || parseClickLabel(srcText);
  const key = parseKey(whenText) || parseKey(srcText);
  if (label) {
    steps.push({ action: 'click', selector: `text=${label}` }, { action: 'wait', ms: 400 });
  } else if (key) {
    steps.push({ action: 'press', key }, { action: 'wait', ms: 400 });
  }
  if (waitMs) steps.push({ action: 'wait', ms: waitMs });
  return { steps, isForce: false };
}

/** Passive steps that don't change app state — a flow of only these is NOT a
 *  real authored reach and should be (re)authored. */
const PASSIVE_ACTIONS = new Set(['screenshot', 'navigate']);

/** True when the flow already carries a real interaction/oracle the author/dev
 *  built (any step beyond passive screenshot/navigate). Don't clobber it. */
function hasAuthoredFlow(flow: VisualTestFlowStep[] | undefined): boolean {
  return Array.isArray(flow) && flow.some((s) => s && !PASSIVE_ACTIONS.has(s.action));
}

/**
 * pacman3 — the post-interaction END STATE the vision judge must score, in plain
 * words. CRITICAL: the recurring backwards-FAIL came from the judge reading a
 * "transitions FROM title TO running" AC and fixating on the TITLE (the pre-state)
 * — it then FAILED a screenshot that correctly showed the running game. We strip
 * the "from … to" preamble and keep only the END state, so the judge scores what
 * the final frame should actually show. Prefer thenObservable/then; else parse the
 * "to <X>" clause; else the whole claim.
 */
function deriveEndStateExpectation(
  test: VisualTestDef,
  ac: AcceptanceCriterion | undefined,
): string {
  const obs = (ac?.thenObservable || ac?.then || '').trim();
  if (obs) return obs.replace(/[.;]\s*$/, '');
  const text = (ac?.text || test.expect || '').trim();
  const m =
    /\b(?:transitions?|changes?|switch(?:es)?|goes|moves?|advances?|turns?)\b[^.]*?\bto\b\s+(.+)/i.exec(
      text,
    );
  if (m) return m[1].trim().replace(/[.;]\s*$/, '');
  return text.replace(/[.;]\s*$/, '');
}

/** A judge directive that pins the vision judge to the POST-interaction frame. */
function postInteractionJudge(test: VisualTestDef, ac: AcceptanceCriterion | undefined): string {
  return (
    `After the scripted interaction runs, the FINAL screenshot must show: ${deriveEndStateExpectation(test, ac)}. ` +
    `Judge ONLY this post-interaction state — do NOT expect a title, start, or pre-interaction screen.`
  );
}

/** Combined natural-language source for reach/observable parsing — the AC's BDD
 *  prose when available, plus the test's own fields (so authoring works at the
 *  EXECUTE chokepoint where only the visual test, not the AC, is in hand). */
function sourceTextFor(test: VisualTestDef, ac: AcceptanceCriterion | undefined): string {
  return [
    ac?.thenObservable,
    ac?.then,
    ac?.when,
    ac?.text,
    test.expect,
    test.action,
    test.setup,
    test.description,
  ]
    .filter(Boolean)
    .join('  ');
}
function whenTextFor(test: VisualTestDef, ac: AcceptanceCriterion | undefined): string {
  return [ac?.when, test.action, test.expect, test.setup].filter(Boolean).join('  ');
}

export type AuthorAction = 'kept' | 'authored' | 'unmappable' | 'skipped';

export interface AuthorResult {
  test: VisualTestDef;
  action: AuthorAction;
  note: string;
}

/**
 * QAA-1 (pacman3 rewrite) — author (or repair) the probe flow for ONE visual
 * test so the QA capture stage takes a POST-INTERACTION screenshot, not the idle
 * frame. Works off the TEST's own fields (expect/action/setup) when no AC is in
 * hand (the execute chokepoint), enriched by the AC's BDD prose when available.
 *
 * Crucially it is NOT gated on `verify` (old plans have none) — the trigger is
 * the test's interaction INTENT: `level:'L2'`, a `state`/`behavior` verify, or
 * interaction/temporal-gated prose ("after pressing…", "when…reaches…", "after a
 * few seconds…", "game over"). The seam is OPTIONAL: with it we add a
 * deterministic `assert` (L2-state) and detect the start-gate; without it we
 * still author a reach → screenshot (L2-vision).
 *
 * Outcomes:
 *   • flow already has a real interaction step → `kept` (don't clobber DEV/author).
 *   • not interaction-driven (a static "at load" claim) → `skipped` (idle judge).
 *   • the observable IS the start screen itself → `skipped` (idle judge).
 *   • otherwise → `authored`: [start-reach?] → reach → screenshot → [assert?].
 *   • interaction-implied but no reach AND not start-gated → `unmappable`.
 *
 * Start-gate: on a start-gated app every keyboard/click reach is prefixed with a
 * press-Enter start (the keyboard is inert on the title screen); a `force` reach
 * is exempt (it sets state directly). The start reach alone guarantees a non-idle
 * frame even when no specific reach is parseable.
 */
export function authorProbeFlow(
  test: VisualTestDef,
  ac: AcceptanceCriterion | undefined,
  seam: SeamContract | undefined,
): AuthorResult {
  // Don't clobber a flow the DEV/author already built with a real interaction.
  if (hasAuthoredFlow(test.flow)) {
    return { test, action: 'kept', note: 'test already carries an authored interaction flow' };
  }

  const verify = ac?.verify;
  const srcText = sourceTextFor(test, ac);
  const whenText = whenTextFor(test, ac);
  const startGated = isStartGated(seam);
  const isL2 = test.level === 'L2';
  const gated = isInteractionGated(srcText);

  // ── appearance (Gap 1) ── A start-gated gameplay-content appearance AC can't be
  // seen on the idle (start) frame — press to start, then judge the gameplay
  // frame. Start-screen ACs and non-gated appearance stay idle-judged.
  if (verify === 'appearance') {
    if (!startGated || isStartScreenObservable(srcText)) {
      return { test, action: 'skipped', note: 'appearance judged on the idle frame as-is' };
    }
    const flow: VisualTestFlowStep[] = [
      ...deriveStartReach(),
      { action: 'screenshot', label: 'after-start' },
    ];
    return {
      test: { ...test, level: 'L1', flow, judge: postInteractionJudge(test, ac) },
      action: 'authored',
      note: 'start-gated appearance → press to start; judge the gameplay frame, not the start screen',
    };
  }

  // Does this test imply an interaction at all?
  const needsFlow = isL2 || verify === 'state' || verify === 'behavior' || gated;
  if (!needsFlow) {
    return { test, action: 'skipped', note: 'static/idle claim — no interaction implied' };
  }
  // The observable IS the start screen itself (e.g. "title shows Press ENTER") and
  // nothing happens "after/when" → judge it on the idle frame.
  if (isStartScreenObservable(srcText) && !/\b(after|once|when)\b/i.test(srcText)) {
    return { test, action: 'skipped', note: 'observable is the start screen itself — idle judge' };
  }

  // Compile a deterministic seam assert when possible (L2-state); else null (L2-vision).
  const assert = seam
    ? compileObservableToAssert(ac?.thenObservable, seam) ||
      compileObservableToAssert(ac?.then, seam) ||
      compileObservableToAssert(test.expect, seam)
    : null;

  const { steps: reach, isForce } = deriveReach(srcText, whenText, assert, seam);

  // Start-gate prefix — unless force (bypasses it) or the reach already starts by
  // pressing Enter (don't double-press the start key).
  const startsWithEnter = reach[0]?.action === 'press' && reach[0]?.key === 'Enter';
  const startReach: VisualTestFlowStep[] =
    startGated && !isForce && !startsWithEnter ? deriveStartReach() : [];

  const allReach = [...startReach, ...reach];
  if (allReach.length === 0) {
    return {
      test,
      action: 'unmappable',
      note: `interaction implied but no reach derivable from "${srcText.slice(0, 70)}" (and not start-gated) — left flow-less so CONTRACT_INCOMPLETE blocks it`,
    };
  }

  const flow: VisualTestFlowStep[] = [
    ...allReach,
    { action: 'screenshot', label: 'after' },
    ...(assert
      ? [{ action: 'assert' as const, expr: assert.expr, op: assert.op, expected: assert.expected }]
      : []),
  ];
  return {
    test: { ...test, level: 'L2', flow, judge: postInteractionJudge(test, ac) },
    action: 'authored',
    note: assert
      ? `authored ${flow.length}-step L2-state probe → assert ${assert.expr} ${assert.op} ${JSON.stringify(assert.expected)}`
      : `authored ${flow.length}-step L2-vision probe (reach → screenshot; observable is visual / no seam key)`,
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
