# Story 20.3: `party-tool-hook.sh` PreToolUse + adversarial test suite

Status: DONE (2026-05-21)
Depends on: 19.1 (`git-deny-list.json` exists)

## Story

As a security-conscious daemon operator,
I want a PreToolUse Bash hook that denies every git mutation, gh mutation, system-danger command, and secret-path read the agent might attempt — and auto-approves only an enumerated read-only set — falling through to **default-allow with a `party.tool.default-allow` audit event**,
so that party agents can introspect the repo freely while being structurally unable to commit/push/branch-escape, and unenumerated commands are recoverable from audit data instead of silently failing.

## Acceptance Criteria

1. New file `daemon/pipelines/lib/party-tool-hook.sh` exists, executable.
2. Reads `CLAUDE_TOOL_NAME` + `CLAUDE_TOOL_INPUT` from env (Claude CLI PreToolUse contract).
3. **Tool-class fast-path**: if `CLAUDE_TOOL_NAME != Bash`, exit 0 (Edit/Write/Read/Glob/Grep are handled by `bypassPermissions` + the agent's prompt).
4. **Hard-deny tier** (Tier 1) — exit 1 with `DENIED: <reason>` on stderr — covers:
   - `git -c <anything>` (inline config bypass)
   - `git push --force`, `git push -f`, `git push --force-with-lease`
   - `git push --delete`, `git push -d`
   - Any `git push origin <ref>:<other-ref>` (refspec rewrite — implementing agent picks regex shape; party's branch is fixed at bootstrap)
   - Every git mutation: `push|commit|add|rm|reset|tag|remote|stash|cherry-pick|rebase|merge|filter-branch|replace|update-ref|symbolic-ref|fast-import|config|worktree`
   - `git checkout main`, `git checkout master`, `git checkout develop`, `git checkout release/*`, `git switch <same>`, `git checkout -b`, `git branch -D`, `git branch -d`, `git branch -m`
   - `gh pr create|merge|close|edit`, `gh repo create|delete|rename|transfer`, `gh release create|delete`
   - `gh api -X POST|PATCH|PUT|DELETE`
   - `rm -rf`, `chmod 777`, `chown`, `sudo`, `curl | bash`, `wget | sh`
   - Reads from secret paths: `.env`, `.git/config`, `~/.ssh`, `~/.aws`, `~/.claude/.credentials.json`, `secrets`, `id_rsa`, `id_ed25519`
5. **Auto-approve tier** (Tier 2) — exit 0 silently — covers:
   - `git status|diff|log|show|branch|fetch|ls-files|rev-parse|symbolic-ref|describe|blame|shortlog`
   - `git remote -v` and `git remote show <name>`
   - `ls|cat|head|tail|find|rg|grep|wc|file|stat|tree|pwd|echo`
   - `gh pr view|list|diff`, `gh issue view|list`, `gh repo view`, `gh api /repos` (GET only)
6. **Default-allow tier** (Tier 3) — exit 0 — covers everything else BUT emits an audit event:
   - Writes a structured JSON line to stderr: `{"event":"party.tool.default-allow","cmd":"<command>","timestamp":"<iso>"}`
   - The daemon's `pushEvent` integration (Story 20.7) reads stderr from the hook and surfaces this as a `party.tool.default-allow` row in `futurator-agent-events`
7. Hook header explicitly documents the default-allow posture per Free Explorer §13.1 — including the line about "load-bearing security is IAM + explicit deny tiers; default-allow is a deliberate trade-off accepting node-spawned-binary as an attack vector for low maintenance."
8. **CLAUDE.md amendment** ships in this story (per §13.1):
   > Both Bash PreToolUse hooks (free-agent path-confinement and party command-confinement) fall through to allow when no rule fires. The load-bearing security is (a) IAM least-privilege on the spawned subprocess and (b) per-hook explicit deny tiers (path escape for free-agent, command/gh/system for party). The hooks are necessary, not sufficient.
9. **Adversarial test suite** (`daemon/pipelines/__tests__/party-tool-hook.test.mjs`) per `plan.md` §11.3.10 — every command in the deny list has a deny-test, every command in the auto-approve list has an allow-test, plus tool-class fast-path tests for Edit/Write/Read/Glob/Grep.
10. **bash -n** syntax check passes.

## Tasks / Subtasks

- [ ] Task 1: Write `party-tool-hook.sh` per AC 1–7
- [ ] Task 2: CLAUDE.md amendment (AC: 8)
- [ ] Task 3: Adversarial test suite (AC: 9)
- [ ] Task 4: Syntax check (AC: 10)
- [ ] Task 5: Make executable (`chmod +x`)
- [ ] Task 6: Run vitest, confirm all deny/allow assertions pass

## Dev Notes

- For PR 1, the hook is **hand-maintained**. The generator (`scripts/build-agent-hooks.mjs`) that stamps it from `git-deny-list.json` is deferred to a follow-up. Mark the hand-maintained sections with a `# TODO: generate from git-deny-list.json` comment.
- The default-allow stderr JSON line: pick a format the daemon's existing stderr-parse path can already ingest. Don't invent a new format. The simplest shape is a single-line `[party-tool-hook] default-allow cmd=<cmd>` that the daemon greps for and converts to an event in Story 20.7.
- Per §13.1, there's a subtle but important boundary: `node script.js` will be default-allowed, but if `script.js` shells out to `git push --force`, the hook doesn't see the inner invocation. This is the documented attack-surface trade-off. The IAM role's denial of arbitrary AWS access is the second layer.
- See `plan.md` §11.3.4 for the structural sketch.
