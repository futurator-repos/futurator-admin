# Story 19.1: Canonical git deny list (`git-deny-list.json`)

Status: DONE (2026-05-21)

## Story

As a daemon operator,
I want a single source-of-truth file listing every git/gh/system command the agent must NOT run,
so that both the party-tool-hook and the free-agent-path-hook can stamp consistent enforcement from one place, and humans editing the policy don't have to keep two shell files in sync.

## Acceptance Criteria

1. New file `daemon/lib/git-deny-list.json` exists with the schema sketched in `plan.md` §11.2.5.
2. Top-level keys: `$comment`, `git_mutation_commands`, `$gitInlineFlagDanger`, `gh_mutation_commands`, `system_danger_commands`, `secret_paths`, `secret_regex_patterns`, `safe_readonly_commands`.
3. All `git_mutation_commands` entries from Free Explorer §9.1 Q2 are present (worktree add/remove, config, filter-branch, replace, update-ref, symbolic-ref, fast-import, branch -D/-d/-m, checkout main, switch master, push --force/--delete/-f/-d).
4. The `$gitInlineFlagDanger` block explicitly calls out `git -c ` with a `reason` field.
5. `secret_regex_patterns` covers AWS keys (`AKIA[0-9A-Z]{16}`), GitHub PATs (`github_pat_…`, `ghp_…`), OpenAI keys (`sk-…`), Anthropic API keys (`ANTHROPIC_API_KEY=sk-ant-…`).
6. `safe_readonly_commands` is structured into `git_readonly`, `fs_readonly`, `gh_readonly` sub-blocks.
7. File is valid JSON (`jq . daemon/lib/git-deny-list.json` exits 0).
8. No runtime consumers in this story (PR 0 wave is data-only); story 20.3 stamps the shell hook from this file.

## Tasks / Subtasks

- [x] Task 1: Write `daemon/lib/git-deny-list.json` per the §11.2.5 sketch (AC: 1–7)
- [x] Task 2: Validate with `jq` (AC: 7) — `jq .` exits 0
- [x] Task 3: ~~Add a one-line entry to `daemon/lib/README.md`~~ — N/A: `daemon/lib/README.md` does not exist; skipped per the conditional. Future maintainers will discover the file via Story 20.3's `party-tool-hook.sh` reference.

## Implementation notes (2026-05-21)

- File written at `daemon/lib/git-deny-list.json`, 142 lines, valid JSON.
- AC verification:
  - 8 top-level keys present (`$comment`, `git_mutation_commands`, `$gitInlineFlagDanger`, `gh_mutation_commands`, `system_danger_commands`, `secret_paths`, `secret_regex_patterns`, `safe_readonly_commands`)
  - 35 `git_mutation_commands` entries (all Free Explorer §9.1 Q2 additions present: worktree, config, filter-branch, replace, update-ref, symbolic-ref, fast-import, branch -D/-d/-m, checkout main/master/develop, switch variants, push --force/--delete/-f/-d)
  - 14 `gh_mutation_commands` entries
  - 5 `secret_regex_patterns` (AWS / github_pat / ghp / sk- / ANTHROPIC_API_KEY=sk-ant-)
  - `safe_readonly_commands` has all 3 sub-blocks (git_readonly / fs_readonly / gh_readonly) with `$comment`
- No runtime consumers yet — Story 20.3's `party-tool-hook.sh` is the first reader.

## Dev Notes

- This is pure data; no runtime impact. Tests live in story 20.3 where the hook reads from it.
- Treat the deny list as documentation as well as enforcement — future engineers should be able to read it top to bottom and understand the agent's threat model in 60s.
