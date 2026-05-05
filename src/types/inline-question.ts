/**
 * Frontend mirror of `functions/shared/types/inline-question.ts`.
 * Keep in sync by hand.
 */

export interface InlineQuestionAnchor {
  roundId: string;
  agentName?: string;
  snippet: string;
  contextBefore: string;
  contextAfter: string;
}

export interface InlineQuestion {
  questionId: string;
  sessionId: string;
  projectId: string;
  createdAt: string;
  createdBy: string;
  anchor: InlineQuestionAnchor;
  question: string;
  answer: string;
  model: string;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens?: number;
    cacheCreationInputTokens?: number;
  };
}

export interface InlineQuestionInput {
  question: string;
  anchor: InlineQuestionAnchor;
}
