# Story 20.2: `party-checkpoint.sh` script (push disabled)

Status: DONE (2026-05-21) — script + tests shipped; JS push-wrapper (the "withPatRetry" half of 19.6 AC 3+4) deferred to Epic 21 (push itself is disabled in PR 1, so the wrapper has no callsite yet)

## Story

As the daemon's post-round hook,
I want a thin bash script that runs the system-driven commit (verify branch → status check → secrets scan → add → commit with composer-supplied message → emit events) inside the party worktree,
so that `[CHECKPOINT_SUMMARY]:` markers result in clean git history without push-to-GitHub (push is deferred until Epic 21).

## Acceptance Criteria

1. New file `daemon/pipelines/lib/party-checkpoint.sh` exists, executable (mode 0755).
2. Invocation contract (called from `party-turn.mjs` post-round hook):
   - `$1` = expected branch name (e.g. `party/applicator/c6b86fee`) — script aborts if `HEAD` doesn't match
   - `$2` = worktree path (cd target)
   - Commit message read from **stdin** (composed by `agent-commit-composer`; daemon pipes it in)
   - On success: echoes the new commit SHA on stdout, exits 0
   - On `STATUS_PORCELAIN_EMPTY`: exits 0 silently (no event, no commit)
   - On secrets-scan hit: exits 2 with `SECRETS_HIT: <regex-name>` on stderr; daemon emits `party.checkpoint.blocked`
   - On any other failure: non-zero exit with stderr context
3. Step sequence per `plan.md` §3.3 + §12.2.1:
   1. `cd "$2"`
   2. Verify `git symbolic-ref --short HEAD` equals `$1`; otherwise exit 3 `BRANCH_MISMATCH`
   3. `git status --porcelain` — if empty, exit 0
   4. Secrets-scan precheck: for each pattern in `daemon/lib/git-deny-list.json#secret_regex_patterns`, grep the staged diff (`git diff --cached`); on hit, exit 2
   5. `git add -A` (changes already staged from step 4's pre-scan add are reused)
   6. `git commit -F -` (reads stdin into commit-message file)
   7. **PUSH STEP REMOVED IN THIS STORY** — echo `PUSH_DEFERRED: Epic 21 enables push when PAT scope upgrades to contents:write` to stdout
   8. Echo the new HEAD SHA on stdout, exit 0
4. Script uses `sudo -u ubuntu` for all git operations (the daemon runs as a service; git's safe-directory protection requires this — verified during pipeline-v2 worktree work).
5. Test (`daemon/pipelines/lib/__tests__/party-checkpoint.test.mjs`):
   - Happy path: fixture repo with staged changes + clean branch → exits 0, echoes a SHA
   - Empty porcelain: clean repo → exits 0, no SHA
   - Branch mismatch: fixture is on `main`, expected `party/x/y` → exits 3
   - Secrets hit: file contains `AKIA....` matching the regex → exits 2 with `SECRETS_HIT:`
6. **bash -n** syntax check passes (`bash -n daemon/pipelines/lib/party-checkpoint.sh`).
7. Typecheck baseline maintained.

## Tasks / Subtasks

- [ ] Task 1: Write the script per the contract (AC: 1–4)
- [ ] Task 2: Write the test suite (AC: 5)
- [ ] Task 3: Syntax check (AC: 6)
- [ ] Task 4: `chmod +x` confirmation in CI script
- [ ] Task 5: Confirm typecheck (AC: 7)

## Dev Notes

- The push step **must be removed entirely**, not gated behind a flag — keeping a dead-but-callable push step risks accidentally re-enabling it before the PAT scope is upgraded.
- Epic 21's first task is to re-add the push step + flip the contract (`PUSH_DEFERRED` becomes `PUSH_OK <branch>`).
- Per Free Explorer §13.6, on the fallback path (when the composer's `warnings` array indicates noise), the caller should emit `party.checkpoint.fallback` to DDB events. The script doesn't see warnings (composer is upstream); event emission lives in the daemon caller (Story 20.7).
- See `plan.md` §12.2.1 for the contract sketch.
