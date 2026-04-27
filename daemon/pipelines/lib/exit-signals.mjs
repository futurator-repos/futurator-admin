// Pipeline v1 — Story 1.2. Universal escalation extractors.
//
// Every agent gets the same exit-signal protocol so the daemon has a uniform
// way to detect "I'm done", "I'm stuck", or "I need a human." Per PRD §8.6
// + §FR-4. Three extractors register globally on every step (in addition to
// per-step extractors); a presence match triggers the structured parse below.

/**
 * Prompt block appended to every agent's first turn (no `--resume`). Kept
 * as tight as possible — every token here is paid on every spawn, across
 * all jobs. Do not pad with prose.
 */
export const EXIT_SIGNALS_PROMPT_SUFFIX = [
  '─────────────────────────────────────────────────────────────────',
  'EXIT SIGNALS — when finishing, emit exactly one:',
  '  ---DONE--- followed by your structured output',
  '  ---ESCALATE--- followed by:',
  '    WHAT_FAILED: <one line>',
  '    WHAT_I_TRIED:',
  '      - <bullet>',
  '      - <bullet, max 5>',
  '    WHY_STUCK: <one paragraph>',
  '    RECOMMENDED_ACTION: retry-with-hint | skip-step | ask-human | abort-job',
  '    HUMAN_QUESTION: <only when ask-human>',
  '  ---NEED-HUMAN---',
  '    HUMAN_QUESTION: <single question>',
  '',
  'If you find yourself repeating the same operation, please use ---ESCALATE---.',
  '─────────────────────────────────────────────────────────────────',
].join('\n');

/**
 * Reserved variable names produced by the universal extractors. Per-step
 * pipelines must not redefine these — the merger drops conflicting step
 * definitions to keep the protocol stable across pipelines.
 */
export const UNIVERSAL_EXTRACTOR_NAMES = Object.freeze(['EXIT_DONE', 'ESCALATION', 'HUMAN_QUESTION']);

/**
 * The three universal extractors. Presence-only — they detect the marker;
 * the structured payload is then parsed from the full result text via
 * `parseEscalationPayload` / `parseHumanQuestion`. We keep the patterns
 * literal to avoid regex foot-guns and let the parsers own the structure.
 *
 * Shape matches the daemon's `runExtractors` (regex with optional capture).
 */
export const UNIVERSAL_EXTRACTORS = Object.freeze({
  EXIT_DONE: { type: 'regex', pattern: '---DONE---' },
  ESCALATION: { type: 'regex', pattern: '---ESCALATE---' },
  HUMAN_QUESTION: { type: 'regex', pattern: '---NEED-HUMAN---' },
});

/**
 * Merge per-step extractors with the universal set. Universal names always
 * win — even if a pipeline tries to redefine them, the protocol stays
 * stable. Returns a fresh object; does not mutate inputs.
 *
 * @param {Record<string, object> | undefined} stepExtractors
 * @returns {Record<string, object>}
 */
export function mergeUniversalExtractors(stepExtractors) {
  const merged = { ...(stepExtractors || {}) };
  for (const name of UNIVERSAL_EXTRACTOR_NAMES) {
    merged[name] = UNIVERSAL_EXTRACTORS[name];
  }
  return merged;
}

/**
 * Parse the structured ---ESCALATE--- payload out of the full result text.
 * Returns null if the marker is missing OR no fields could be parsed.
 * Tolerant of:
 *   - varying whitespace
 *   - missing optional fields (HUMAN_QUESTION is only required when
 *     RECOMMENDED_ACTION === 'ask-human')
 *   - extra prose after the block
 *
 * @param {string} text
 * @returns {{
 *   whatFailed: string,
 *   whatTried: string[],
 *   whyStuck: string,
 *   recommendedAction?: 'retry-with-hint' | 'skip-step' | 'ask-human' | 'abort-job',
 *   humanQuestion?: string,
 * } | null}
 */
export function parseEscalationPayload(text) {
  if (typeof text !== 'string' || !text.includes('---ESCALATE---')) return null;

  // Slice from the marker forward so prose before the block doesn't pollute
  // the field regexes.
  const startIdx = text.indexOf('---ESCALATE---');
  const body = text.slice(startIdx + '---ESCALATE---'.length);

  const whatFailed = matchSingleLine(body, /WHAT_FAILED:\s*(.+)/i);
  const whyStuck = matchParagraph(body, /WHY_STUCK:\s*([\s\S]*?)(?=\n\s*(?:RECOMMENDED_ACTION|HUMAN_QUESTION|---|$))/i);
  const whatTried = parseBulletList(body, /WHAT_I_TRIED:\s*([\s\S]*?)(?=\n\s*(?:WHY_STUCK|RECOMMENDED_ACTION|HUMAN_QUESTION|---|$))/i);
  const recommendedAction = matchAction(body);
  const humanQuestion = matchSingleLine(body, /HUMAN_QUESTION:\s*(.+)/i);

  // Require at least one structured field — if the agent emitted just the
  // marker with no payload we treat it as malformed and let the caller
  // synthesize a generic payload.
  if (!whatFailed && !whyStuck && whatTried.length === 0 && !recommendedAction && !humanQuestion) {
    return null;
  }

  return {
    whatFailed: whatFailed || '',
    whatTried,
    whyStuck: whyStuck || '',
    ...(recommendedAction ? { recommendedAction } : {}),
    ...(humanQuestion ? { humanQuestion } : {}),
  };
}

/**
 * Parse the ---NEED-HUMAN--- shortcut. Returns the operator's question or
 * null if the marker is missing or no question line follows.
 *
 * @param {string} text
 * @returns {string | null}
 */
export function parseHumanQuestion(text) {
  if (typeof text !== 'string' || !text.includes('---NEED-HUMAN---')) return null;
  const startIdx = text.indexOf('---NEED-HUMAN---');
  const body = text.slice(startIdx + '---NEED-HUMAN---'.length);
  return matchSingleLine(body, /HUMAN_QUESTION:\s*(.+)/i);
}

/**
 * Pure decision function: given the variables extracted from an agent turn
 * (after merging universal + per-step extractors) and the full result text,
 * decide whether the agent escalated and produce the structured handoff
 * payload. Returns null when no escalation marker fired.
 *
 * Extracted out of the daemon so the dispatch logic is unit-testable.
 *
 * @param {Record<string, string>} extracted
 * @param {string} resultText
 * @returns {{
 *   triggeredBy: 'AGENT_ESCALATED' | 'AGENT_NEEDS_HUMAN',
 *   escalationPayload: {
 *     whatFailed: string,
 *     whatTried: string[],
 *     whyStuck: string,
 *     recommendedAction?: string,
 *     humanQuestion?: string,
 *   },
 *   salvageableExtractors: string[],
 * } | null}
 */
export function detectEscalation(extracted, resultText) {
  if (!extracted) return null;
  const sawEscalation = Boolean(extracted.ESCALATION);
  const sawHumanQuestion = Boolean(extracted.HUMAN_QUESTION);
  if (!sawEscalation && !sawHumanQuestion) return null;

  const parsedEscalation = sawEscalation ? parseEscalationPayload(resultText) : null;
  const parsedHumanQuestion = sawHumanQuestion ? parseHumanQuestion(resultText) : null;

  const escalationPayload = parsedEscalation
    ? {
        ...parsedEscalation,
        // Only fall back to the ---NEED-HUMAN--- block when the structured
        // ---ESCALATE--- payload didn't carry its own HUMAN_QUESTION.
        ...(parsedHumanQuestion && !parsedEscalation.humanQuestion
          ? { humanQuestion: parsedHumanQuestion }
          : {}),
      }
    : {
        whatFailed: '(agent invoked ---NEED-HUMAN--- shortcut)',
        whatTried: [],
        whyStuck: 'Agent requested human input.',
        humanQuestion: parsedHumanQuestion || '',
      };

  const universalNames = new Set(UNIVERSAL_EXTRACTOR_NAMES);
  const salvageableExtractors = Object.keys(extracted).filter((n) => !universalNames.has(n));

  return {
    triggeredBy: parsedEscalation ? 'AGENT_ESCALATED' : 'AGENT_NEEDS_HUMAN',
    escalationPayload,
    salvageableExtractors,
  };
}

// ── helpers ───────────────────────────────────────────────────────────────

function matchSingleLine(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  // Trim trailing whitespace/newlines; single-line semantics by design.
  return m[1].split(/\r?\n/, 1)[0].trim() || null;
}

function matchParagraph(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  return m[1].trim() || null;
}

function matchAction(text) {
  const m = /RECOMMENDED_ACTION:\s*(retry-with-hint|skip-step|ask-human|abort-job)/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

function parseBulletList(text, re) {
  const m = re.exec(text);
  if (!m) return [];
  return m[1]
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*]\s*/, '').trim())
    .filter((line) => line.length > 0)
    .slice(0, 5); // PRD §FR-4 caps at 5 bullets
}
