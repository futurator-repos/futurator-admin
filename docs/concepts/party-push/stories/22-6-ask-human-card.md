# Story 22.6: ASK_HUMAN card surface in right rail

Status: DONE (2026-05-22)
Depends on: 20.7 (party-turn emits party.agent.question)

## Story

As the operator, when an agent emits `[ASK_HUMAN]:` mid-debate, I want a high-priority card in the right rail telling me what the agent is waiting on, so I don't miss it among general inline questions.

## Acceptance Criteria

1. `src/components/labs/party/v2/agent-questions-card.tsx` ships:
   - Section header "Agent waiting" with a count badge when ≥1 unanswered.
   - Toggle: "Show all" vs "Hide answered".
   - Each question row carries question text, round number, answered chip, MessageSquare icon (or X when answered).
2. Heuristic for "answered": any `party.turn.user` event with higher eventSeq than the question.
3. Click row → `jumpToAnchor(r-<turnCount+1>)` scrolls the chat to that round.
4. Rendered above InlineQuestionsList in the right rail.

## Notes

- Per Free Explorer §13.4 three-tier visual treatment, this is the tier-1 (blocking) surface; tier-2 + tier-3 stay in the existing inline-questions list.
- "Answered" is best-effort. A future story can add a server-side `party.agent.question.answered` event and switch the heuristic to authoritative.
