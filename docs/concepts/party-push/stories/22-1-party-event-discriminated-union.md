# Story 22.1: PartyEvent discriminated union

Status: DONE (2026-05-22)
Depends on: 21.4

## Story

As any UI or audit consumer of party events, I want a strongly-typed PartyEvent union so the compiler tells me when I've missed a variant or misread a field, per Free Explorer §9.1 Q4 #7.

## Acceptance Criteria

1. `functions/shared/types/party-events.ts` exports `TypedPartyEvent` (union of CheckpointComposed/Pushed/Blocked/Failed, AgentQuestion, ToolDefaultAllow).
2. `parsePartyEvent(raw)` parses a raw DDB `PartyEvent` into the typed variant (or null when the event type is not in the union).
3. `isCheckpointEvent(raw)` type-guard for the four checkpoint variants.
4. 9 tests in `party-events.test.ts` covering all six variants + null + missing-fields tolerance.

## Notes

- The runtime DDB row stays `payload: Record<string, unknown>` — the union is a parsed view, not a write-shape change.
- Used by Story 22.7 (audit drawer) and (future) any consumer that wants exhaustiveness checking.
