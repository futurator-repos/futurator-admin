/**
 * Concept v2 (E4 / Story 4.1a) — the SHARED marker constants for interactive
 * convergence.
 *
 * The free-agent substrate (`free-agent-session.mjs`) is a raw Claude CLI
 * session: it does NOT run the BMAD XML workflow engine. Convergence is driven
 * entirely by substring-extracted markers the agent emits. A typo in any marker
 * silently breaks extraction (the same failure class as `CONCEPT_PLAN_JSON`), so
 * the strings live HERE as single-source constants and are fence-parity tested.
 *
 * The three markers:
 *   • TEMPLATE_OUTPUT_*  — wraps a converged section's finalized markdown.
 *   • DECISION_CARD_*    — wraps a halt-point decision card (a numbered,
 *                          methodologically-grounded option menu — distilled
 *                          adv-elicit, NOT arbitrary forks).
 *   • CHECKPOINT         — emitted once the whole document has converged; the
 *                          daemon parses it to flip the node `drafting →
 *                          awaiting-you` and enable Approve (Story 4.3).
 */

export const TEMPLATE_OUTPUT_START = '---TEMPLATE_OUTPUT---';
export const TEMPLATE_OUTPUT_END = '---END_TEMPLATE_OUTPUT---';

export const DECISION_CARD_START = '---DECISION_CARD---';
export const DECISION_CARD_END = '---END_DECISION_CARD---';

/** Single-line sentinel the agent emits when the document is fully converged. */
export const CONVERGENCE_CHECKPOINT = '===CONVERGED:READY-FOR-APPROVAL===';

/** Every convergence marker, for fence-parity assertions + extraction wiring. */
export const CONCEPT_CONVERGENCE_MARKERS = {
  templateOutputStart: TEMPLATE_OUTPUT_START,
  templateOutputEnd: TEMPLATE_OUTPUT_END,
  decisionCardStart: DECISION_CARD_START,
  decisionCardEnd: DECISION_CARD_END,
  checkpoint: CONVERGENCE_CHECKPOINT,
} as const;

/** True iff the agent's text contains the convergence checkpoint sentinel. */
export function hasConvergenceCheckpoint(text: string): boolean {
  return typeof text === 'string' && text.includes(CONVERGENCE_CHECKPOINT);
}

/**
 * Extract the finalized document from the last TEMPLATE_OUTPUT block (the
 * converged markdown the Approve endpoint promotes). Returns null when absent.
 */
export function extractTemplateOutput(text: string): string | null {
  if (typeof text !== 'string') return null;
  const start = text.lastIndexOf(TEMPLATE_OUTPUT_START);
  if (start === -1) return null;
  const from = start + TEMPLATE_OUTPUT_START.length;
  const end = text.indexOf(TEMPLATE_OUTPUT_END, from);
  if (end === -1) return null;
  return text.slice(from, end).trim();
}

/** Extract every decision-card body (numbered option menus) the agent emitted. */
export function extractDecisionCards(text: string): string[] {
  if (typeof text !== 'string') return [];
  const cards: string[] = [];
  let cursor = 0;
  for (;;) {
    const start = text.indexOf(DECISION_CARD_START, cursor);
    if (start === -1) break;
    const from = start + DECISION_CARD_START.length;
    const end = text.indexOf(DECISION_CARD_END, from);
    if (end === -1) break;
    cards.push(text.slice(from, end).trim());
    cursor = end + DECISION_CARD_END.length;
  }
  return cards;
}
