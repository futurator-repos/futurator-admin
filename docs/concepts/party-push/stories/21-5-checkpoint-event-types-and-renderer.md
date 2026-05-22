# Story 21.5: party.checkpoint.pushed event type + minimal inline renderer

Status: DONE (2026-05-22)
Depends on: 21.4

## Story

As the operator watching a debate, I want each checkpoint event (composed | pushed | blocked | failed) to render inline in the round stream as a card so I see what landed in git without leaving the chat.

## Acceptance Criteria

1. `PartyEventType` (shared + frontend) carries the four checkpoint variants + `party.agent.question` + `party.tool.default-allow`.
2. `Round` adapter shape gains optional `checkpoint?: RoundCheckpoint`. The adapter collects the last checkpoint event in a round.
3. Round renderer (`main-pane.tsx::RoundView`) emits `<CheckpointCard />` after the orchestrator-close block when `round.checkpoint` is set.
4. The card variant is determined by `checkpoint.kind` and renders different icon + accent color + actions per variant.
5. Story 22.5 wires the three action buttons (Open PR / Continue locally / Start story-pipeline); 21.5 only requires the renderer to be wired with the correct event field flow.

## Notes

- "Open PR" button visibility is gated on `pushed === true` (no point opening a PR for a local-only commit) AND `pushEnabled === true` (the operator's project-level opt-in).
