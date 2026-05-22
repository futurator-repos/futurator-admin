# Story 22.5: checkpoint-card.tsx React component

Status: DONE (2026-05-22)
Depends on: 22.3, 22.4, 21.5

## Story

As the operator viewing a round that produced a checkpoint, I want one card that shows the commit metadata + three actions (Open PR / Continue locally / Start story-pipeline), so the inline UI fully closes the loop on the party-push design.

## Acceptance Criteria

1. `src/components/labs/party/v2/checkpoint-card.tsx` ships with:
   - Variant rendering: pushed (cloud + success accent) / composed (cloud-off + brand accent) / blocked (shield-alert + destructive) / failed (X + destructive).
   - Title + summary from the marker; SHA chip; branch chip.
   - Reason chip when non-trivial.
2. Three actions, rendered only on `composed` or `pushed`:
   - "Open PR" — calls `useOpenCheckpointPr` (Story 22.3); visible only when `pushed && pushEnabled`.
   - "View PR ↗" — appears after Open PR succeeds; opens in new tab.
   - "Start story-pipeline →" — Link to `/labs?createPlanForApp=<projectId>&sourceCommitSha=<sha>&sourceBranch=<branch>` (Story 22.4 deep-link).
3. Continue-locally is a no-op (the card already lets the operator just close it and keep chatting) — not a separate button.
4. "Elicit further" is deferred per Free Explorer §9.2.
5. Wired into `MainPane::RoundView` after `OrchestratorClose`.

## Tests

No unit tests (pure presentational); e2e smoke in Story 20.16.
