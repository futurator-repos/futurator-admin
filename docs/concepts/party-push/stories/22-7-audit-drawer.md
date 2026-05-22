# Story 22.7: Audit drawer in party session

Status: DONE (2026-05-22)
Depends on: 22.2

## Story

As the operator, I want one "Audit log" button in the session that opens a drawer showing every checkpoint + ASK_HUMAN + tool default-allow event chronologically, so I can review the full machine trail for a debate without diving into DDB.

## Acceptance Criteria

1. `src/components/labs/party/v2/audit-drawer.tsx` ships:
   - Right-side drawer (same shape as file-drawer), 560 px default width.
   - Three tabs: Checkpoints / Questions / Tool allows.
   - Header carries `partyBranch` + tally chip (`Np / Nc / Nb / Nf · Nq · Nt`).
   - Refresh button re-fetches the audit.
2. `usePartyAudit(sessionId, enabled)` React-Query hook (only fires when drawer is open).
3. "Audit log" button in the right-rail footer toggles open.
4. Drawer renders icon + accent per checkpoint variant.

## Notes

- Tool-allows tab is the operator's signal-channel for growing the deny-list per Free Explorer §13.1.
- Drawer is a controlled portal — survives right-rail scroll/resize.
