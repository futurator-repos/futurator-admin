# Story 20.15: Worktree-reaper real classifier (wire `findBySessionIdShort` into deps)

Status: TODO
Depends on: 19.7 (no-op classifier shipped), 19.8 (`findBySessionIdShort` exists)

## Story

As the worktree reaper looking at `/home/ubuntu/worktrees/<app>/_party/<sessionIdShort>/`,
I want to actually evaluate whether to reap by looking up the session and checking terminal-status + age,
so that the no-op classifier shipped in Story 19.7 starts doing real work, but only after the lookup dep exists.

## Acceptance Criteria

1. `daemon/agent-daemon.mjs` startup wiring for `startReaperTicker` gains a new dep:
   - `findPartySessionByShort: (sessionIdShort: string) => Promise<PartySession | null>` (delegates to `partySessionsRepo.findBySessionIdShort` from Story 19.8)
2. `daemon/lib/worktree-reaper.mjs::classifyPartyWorktree` now does its real work:
   - If `deps.findPartySessionByShort(entry.sessionIdShort)` returns null → `{ shouldReap: true, reason: 'session-row-missing' }`
   - If session.status NOT in `PARTY_TERMINAL_STATUSES` → `{ shouldReap: false, reason: 'session-active' }`
   - If session.updatedAt newer than `PARTY_STALE_TERMINAL_MS` ago → `{ shouldReap: false, reason: 'terminal-but-fresh' }`
   - Otherwise → `{ shouldReap: true, reason: 'terminal-and-stale' }`
3. Reap action when triggered: `git worktree remove --force` + `rm -rf` the path (mirror coordinator-worktree reap).
4. Test (`daemon/lib/__tests__/worktree-reaper-party-classifier.test.mjs`):
   - session-row-missing → reap
   - session active → no reap
   - session ENDED + 1h ago → no reap (terminal-but-fresh)
   - session ENDED + 8d ago → reap (terminal-and-stale)
   - session CANCELLED + 8d ago → reap
5. Existing reaper tests + Story 19.7's no-op test stay green (the no-op test still passes when `findPartySessionByShort` is omitted from deps).
6. Manual test post-rsync: end a party session, set `updatedAt` to 8 days ago in DDB (manually for the test), wait for the next reaper tick (or trigger via SSM), verify the worktree is reaped.
7. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Wire `findPartySessionByShort` into daemon's `startReaperTicker` call (AC: 1)
- [ ] Task 2: Real classifier logic (AC: 2)
- [ ] Task 3: Reap action (AC: 3)
- [ ] Task 4: Tests (AC: 4, 5)
- [ ] Task 5: Manual test (AC: 6)
- [ ] Task 6: Typecheck (AC: 7)

## Dev Notes

- The "no-op until wired" pattern from Story 19.7 means PR 0 and PR 1 can ship safely without reaping anything until both halves land. Once this story lands, the reaper goes live.
- Test fixture for "set updatedAt to 8 days ago" — use the existing `setUpdatedAt` repo helper if it exists, else add a test-only helper that direct-writes to DDB.
- Per `plan.md` §10.5 + §11.2.8 final paragraph.
