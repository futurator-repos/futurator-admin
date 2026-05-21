# Story 20.7: Party-turn rewiring — cwd assertion + cancel-poller + settings.json + bypassPermissions

Status: DONE (2026-05-21) — Tasks 1-7, 9, 11 ✅ (feature-flagged behind PARTY_PUSH_V1_ENABLED); Tasks 8 + 10 deferred (settings cleanup in 20.10 cascade; manual smoke post-rsync)
Depends on: 19.2 (cancel-poller), 19.4 (PartySession fields), 20.3 (party-tool-hook), 20.6 (party worktree)

## Story

As the daemon spawning a party-mode `claude -p` subprocess,
I want the spawn to (a) assert the worktree exists before spawn, (b) wire the shared cancel-poller, (c) write `.claude/settings.json` to `/tmp/party-settings-<sid>.json` (NOT in the worktree), (d) pass `--settings <tmp-path>` and `--permission-mode bypassPermissions`,
so that the per-session worktree is isolated, the Stop button works, the hook intercepts every Bash invocation, and the settings file doesn't leak into the checkpoint commit.

## Acceptance Criteria

1. `daemon/pipelines/party-turn.mjs` rewires per `plan.md` §11.3.2 + §11.3.3 + §11.3.6 + §12.1.2:
   - **cwd assertion (§11.3.2)**: before spawn, `existsSync(session.projectPath)` — if false, throw `WORKTREE_MISSING` (defends against reaper-mid-flight). Operator's UI surfaces "Worktree missing; create a new session."
   - **clear-cancel-flag (pre-spawn)**: call `sessionsRepo.clearCancelFlag(sessionId)`, log warn on failure.
   - **settings.json at `/tmp/party-settings-<sid>.json`** (§12.1.2 fix — NOT inside the worktree). Resolves the hook script path via `new URL('./lib/party-tool-hook.sh', import.meta.url).pathname` (Free Explorer §9.1 #5). Written once per session at first-turn; reused on subsequent turns; deleted at session end.
   - **Spawn args**: add `--settings <tmp-path>` and change `--permission-mode` from `acceptEdits` to `bypassPermissions` (Free Explorer §9.1 #4).
   - **Cancel-poller wiring**: instantiate via `startCancelPoller({ sessionsRepo, sessionId, child, logger })` after spawn. Stop on child close.
   - **Close handler**: emit `party.turn.cancelled` if `poller.isCancelled()`, else emit existing `party.turn.completed`. `poller.stop()` is awaited.
   - **Default-allow audit ingest**: when stderr contains a line matching `[party-tool-hook] default-allow cmd=` (Story 20.3's format), parse it and `pushEvent(sessionId, 'turn', '__system__', 'party.tool.default-allow', { cmd, command, ... })`.
2. **Marker extraction**: after the turn completes, call `extractMarkers(assistantText)` (Story 20.1). For each marker:
   - `[CHECKPOINT_SUMMARY]`: stash for the post-round hook (Story 20.2 caller path)
   - `[ASK_HUMAN]`: emit `party.agent.question` event with `{ sessionId, question, turnCount }`
3. **Settings file lifecycle**:
   - Write at first-turn (`!session.claudeSessionId`)
   - Reuse on subsequent turns (don't re-write — saves IO + the file's hash doesn't change)
   - Delete on session terminal status (`ENDED|CANCELLED|EXPIRED`) — handled by `DELETE /api/party/sessions/:id` cascade in Story 20.10 OR by the worktree reaper
4. Test (`daemon/pipelines/__tests__/party-turn-rewire.test.mjs`):
   - Worktree missing → throws `WORKTREE_MISSING`
   - Happy path → spawn args include `--settings <tmp>` + `--permission-mode bypassPermissions`
   - Cancel during turn → close handler emits `party.turn.cancelled`, `clearCancelFlag` called via `poller.stop()`
   - `[party-tool-hook] default-allow cmd=mkdir x` in stderr → `party.tool.default-allow` event emitted with `cmd: 'mkdir x'`
5. **Smoke test post-rsync**: a brownfield session that ran cleanly pre-rewiring still runs cleanly post-rewiring (verify the conversation reads pre-existing CLAUDE.md, agent responds, files are written to the worktree path).
6. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: cwd assertion + WORKTREE_MISSING (AC: 1a)
- [ ] Task 2: clear-cancel-flag pre-spawn (AC: 1b)
- [ ] Task 3: Settings.json at `/tmp/party-settings-<sid>.json` (AC: 1c, 3)
- [ ] Task 4: Spawn args `--settings` + `bypassPermissions` (AC: 1d)
- [ ] Task 5: Cancel-poller wire (AC: 1e, 1f)
- [ ] Task 6: Default-allow stderr ingest → `party.tool.default-allow` event (AC: 1g)
- [ ] Task 7: Marker extraction post-turn (AC: 2)
- [ ] Task 8: Settings cleanup on session terminal (AC: 3)
- [ ] Task 9: Tests (AC: 4)
- [ ] Task 10: Manual smoke test post-rsync (AC: 5)
- [ ] Task 11: Typecheck (AC: 6)

## Dev Notes

- This is the highest-touch story in Epic 20 — `party-turn.mjs` is hot code, the diff is medium-sized. Land it BEHIND a feature flag if needed (`process.env.PARTY_PUSH_V1_ENABLED === '1'`) so the operator can roll back without a full revert.
- Settings.json content per `plan.md` §11.3.6:
  ```json
  { "hooks": { "PreToolUse": { "command": "<absolute-path-to-party-tool-hook.sh>" } } }
  ```
- The settings file MUST be at an absolute path; relative resolution via `import.meta.url` happens at the daemon side BEFORE writing, so the hook field in the JSON is always absolute. Free Explorer §9.1 #5 caught this bug in the free-agent rollout.
- Per Free Explorer §13.4, the `party.agent.question` event format matches what the UI's unified inline-questions list (Epic 22) will consume. Keep the event shape stable.
