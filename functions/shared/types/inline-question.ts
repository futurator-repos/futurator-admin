/**
 * Party Mode — inline Q&A on text selections.
 *
 * Each question represents a single user-asked clarification anchored to a
 * specific selection inside the chat (round + snippet + 40-char before/after
 * context, which the UI uses to re-locate the highlight on click). Answered
 * by a direct call to the Anthropic Messages API (claude-haiku) — NOT via
 * the Claude CLI / Max-subscription path.
 */

export interface InlineQuestionAnchor {
  /** Round the selection lives inside. */
  roundId: string;
  /** Optional agent name when the selection is inside a specific agent block. */
  agentName?: string;
  /** The exact text the user highlighted. */
  snippet: string;
  /** Up to 40 chars immediately preceding the snippet (helps disambiguate
   *  duplicate snippets like "DAG"). */
  contextBefore: string;
  /** Up to 40 chars immediately following the snippet. */
  contextAfter: string;
}

export interface InlineQuestion {
  questionId: string;
  sessionId: string;
  projectId: string;
  /** ISO-8601, also used as the GSI sort key (newest-first). */
  createdAt: string;
  createdBy: string;
  anchor: InlineQuestionAnchor;
  /** What the user asked. */
  question: string;
  /** Anthropic's answer. Populated synchronously on POST. */
  answer: string;
  /** Model used (claude-haiku-4-5 by default). */
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

export const INLINE_QUESTION_DEFAULT_MODEL = 'claude-haiku-4-5';
export const INLINE_QUESTION_MAX_TOKENS = 500;
export const INLINE_QUESTION_SNIPPET_MAX = 4000;
export const INLINE_QUESTION_QUESTION_MAX = 1000;
export const INLINE_QUESTION_CONTEXT_MAX = 80;
