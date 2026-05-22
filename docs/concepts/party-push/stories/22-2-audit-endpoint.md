# Story 22.2: GET /api/party/sessions/:id/audit

Status: DONE (2026-05-22)
Depends on: 22.1

## Story

As the audit drawer (Story 22.7), I want a server-side filtered slice of the session's event stream so I don't pull 1000s of token events into the browser to find the 5 audit-relevant ones.

## Acceptance Criteria

1. `GET /api/party/sessions/:id/audit` returns:
   - `{ sessionId, projectId, partyBranch, worktreePath, tally, events }`
   - `events` filtered to `party.checkpoint.{composed,pushed,blocked,failed} | party.agent.question | party.tool.default-allow`, sorted by eventSeq.
   - `tally` carries per-type counts so the drawer header doesn't need to recount.
2. Validates session id; 404 when session is missing.
3. Polls up to 500 events in one Query (sufficient for current per-session volumes).

## Notes

- No cursor pagination yet — the per-session audit volume is bounded. When this is a problem, fall back to `?after=<seq>` like the events endpoint.
- Reused by `usePartyAudit(sessionId)` React-Query hook in `use-party-audit.ts`.
