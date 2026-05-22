# Story 22.3: POST /api/party/sessions/:id/checkpoints/:sha/pr

Status: DONE (2026-05-22)
Depends on: 22.1, 21.4

## Story

As the checkpoint card's "Open PR" action, I want one route that opens (or returns the existing) PR for a session's party branch, so the operator gets one click → PR URL.

## Acceptance Criteria

1. Route key uses sessionId (so the title/body can quote orchestrator state) + sha (commit SHA the checkpoint produced).
2. Validates session UUID + sha (`^[a-f0-9]{40}$`).
3. 400 NOT_BROWNFIELD when the project is greenfield or has no gitRepoUrl.
4. 409 PUSH_DISABLED when `project.pushEnabled !== true`.
5. 409 NO_PARTY_BRANCH when `session.partyBranch` is undefined.
6. Idempotent: GETs existing open PR via `listPullRequests({ head: '<owner>:<branch>' })` BEFORE creating; reuses if found.
7. Creates draft PR by default (override via `draft: false` in body).
8. Falls back to `listPullRequests` again on 422 "already exists" race.
9. Returns `{ prNumber, prUrl, title, state, reused }`.

## Notes

- Adds `createPullRequest(owner, name, input)` to `functions/shared/github/connector.ts`.
- Extends `listPullRequests` with optional `head` filter.
- Daemon EC2's PAT is contents:write per project; this endpoint uses the shared admin GitHub PAT (`loadPat()`) — that PAT needs `repo` scope on the brownfield repos to open PRs. Operator-managed.
