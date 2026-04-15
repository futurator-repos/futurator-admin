# Story MY-1.3: Wiki Directory Structure & Article Format

Status: review

## Story

As a **developer**,
I want **the wiki directory structure created in each project workspace with a defined article format**,
So that **compiled knowledge has a consistent, organized home following the Karpathy wiki pattern**.

## Acceptance Criteria

1. The following directory structure is created under `/home/ubuntu/projects/{name}/knowledge/`:
   - `index.md` (master catalog)
   - `log.md` (append-only operations log)
   - `code/` (one article per source file)
   - `decisions/` (architecture choices)
   - `requirements/` (PRD-derived requirements)
   - `discovery/` (brainstorms, research)
   - `planning/` (epics, stories, roadmap)
   - `solutioning/` (arch, tech spec, API)
   - `qa/` (test plans, results)
   - `system/` (cross-cutting synthesis) with pre-created files: `dependency-map.md`, `deployment-manifest.md`, `debt-registry.md`, `pending-work.md`
   - `archive/` (pruned nodes)
2. `index.md` is initialized with the project name and empty catalog structure
3. `log.md` is initialized with a creation entry
4. `.mycelium/compile-state.json` is created with empty state `{}`
5. `.mycelium/embeddings-queue.json` is created with empty array `[]`
6. The initialization script takes `projectId` and `workingDir` as arguments
7. The script is idempotent — running it on an existing project does not overwrite existing content

## Tasks / Subtasks

- [x] Task 1: Create wiki initialization script `init-wiki.sh` (AC: #1, #6, #7)
  - [x] 1.1: Create `/home/ubuntu/scripts/init-wiki.sh` as a shell script
  - [x] 1.2: Accept two arguments: `projectId` (e.g., `spyhunter`) and `workingDir` (e.g., `/home/ubuntu/projects/spyhunter`)
  - [x] 1.3: Create all phase directories under `${workingDir}/knowledge/`: `code/`, `decisions/`, `requirements/`, `discovery/`, `planning/`, `solutioning/`, `qa/`, `system/`, `archive/`
  - [x] 1.4: Use `mkdir -p` to ensure idempotency — no errors if directories already exist
  - [x] 1.5: Create files only if they do not already exist (use `-f` check before writing)
  - [x] 1.6: Make script executable (`chmod +x`)

- [x] Task 2: Initialize `index.md` with catalog structure (AC: #2)
  - [x] 2.1: Create `${workingDir}/knowledge/index.md` with project name header
  - [x] 2.2: Include empty sections for each phase: Discovery, Planning, Solutioning, Implementation, QA, Release, Support, System
  - [x] 2.3: Each section has a placeholder for article listings (table or list format)

- [x] Task 3: Initialize `log.md` with creation entry (AC: #3)
  - [x] 3.1: Create `${workingDir}/knowledge/log.md` with operations log header
  - [x] 3.2: Append creation entry with timestamp: `| {date} | Wiki initialized for {projectId} | init-wiki.sh |`

- [x] Task 4: Create system articles (AC: #1)
  - [x] 4.1: Create `${workingDir}/knowledge/system/dependency-map.md` with frontmatter (type: system, phase: system, status: active)
  - [x] 4.2: Create `${workingDir}/knowledge/system/deployment-manifest.md` with frontmatter
  - [x] 4.3: Create `${workingDir}/knowledge/system/debt-registry.md` with frontmatter
  - [x] 4.4: Create `${workingDir}/knowledge/system/pending-work.md` with frontmatter

- [x] Task 5: Create `.mycelium/` metadata directory (AC: #4, #5)
  - [x] 5.1: Create `${workingDir}/.mycelium/` directory
  - [x] 5.2: Create `compile-state.json` with empty object `{}`
  - [x] 5.3: Create `embeddings-queue.json` with empty array `[]`

- [x] Task 6: Validate initialization (AC: #1, #2, #3, #4, #5)
  - [x] 6.1: Run `init-wiki.sh` with a test project
  - [x] 6.2: Verify all directories exist via `find`
  - [x] 6.3: Verify `index.md` contains project name
  - [x] 6.4: Verify `log.md` contains creation entry
  - [x] 6.5: Verify `.mycelium/compile-state.json` is valid JSON
  - [x] 6.6: Run script again on same project — verify no content is overwritten

## Dev Notes

### Architecture Context

This story establishes the wiki directory structure that serves as the **source of truth** for all compiled knowledge. The wiki follows the Karpathy pattern: the LLM writes and maintains all articles, humans read and direct. Every pipeline run (story, epic, deployment, conversation) automatically compiles new knowledge into wiki articles.

The directory layout mirrors the 7 project lifecycle phases from the Mycelium framework, plus `system/` for cross-cutting synthesis and `archive/` for pruned nodes. This structure is critical because:

1. **Phase directories** enable filtered queries — "show me all solutioning artifacts" becomes a simple directory listing.
2. **Article frontmatter** (type, phase, status, maturity, tags, wikilinks) maps directly to Memgraph node properties in Story 1.2.
3. **The `system/` articles** are special — they aggregate cross-cutting concerns (dependencies, deployments, debt, pending work) and are updated by compilation steps across all pipelines.
4. **`.mycelium/`** holds sync metadata — `compile-state.json` tracks content hashes so `graph-sync.mjs` (Story 1.5) only re-embeds changed articles.

### Article Format

Every wiki article follows this frontmatter structure (from architecture doc section 3.1):

```markdown
---
title: src/components/auth.tsx
type: code
phase: implementation
status: active
maturity: 0.7
created: 2026-04-13
updated: 2026-04-13
createdByEpic: E1
createdByStory: E1-S3
lastMutatedByStory: E2-S1
tags: [authentication, jwt, react-context]
---

## Purpose

## Key Exports

## Dependencies

## Dependents

## Signals

## Missing Signals

## Notes
```

**File naming convention:** `knowledge/{phase}/{slug}.md` where slug uses `--` for path separators in code files (e.g., `src--components--auth.tsx.md`).

### Article Types by Phase

| Phase          | Article Types                                                    |
| -------------- | ---------------------------------------------------------------- |
| Discovery      | brainstorm, brief, research, evidence, competitive-analysis      |
| Planning       | prd, requirement, epic-plan, story-plan, risk, decision          |
| Solutioning    | architecture, tech-spec, api-spec, data-model, adr, ux-spec      |
| Implementation | code (per file), decision (runtime choices)                      |
| QA             | test-plan, test-result, visual-qa-report                         |
| Release        | deployment-record, release-notes                                 |
| Support        | bug-report, feature-request, evolution-plan                      |
| System         | dependency-map, deployment-manifest, debt-registry, pending-work |

### File Locations

| File         | Path                                      | Purpose                              |
| ------------ | ----------------------------------------- | ------------------------------------ |
| init-wiki.sh | `/home/ubuntu/scripts/init-wiki.sh`       | Wiki directory initialization script |
| knowledge/   | `/home/ubuntu/projects/{name}/knowledge/` | Wiki directory root per project      |
| .mycelium/   | `/home/ubuntu/projects/{name}/.mycelium/` | Graph sync metadata per project      |

### Prerequisites

- No dependency on Story MY-1.1 — this story can run in parallel with Memgraph setup.
- The `/home/ubuntu/scripts/` directory should already exist from Story 1.1, but the script should create it if missing.

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#2-Architecture-Overview] — project workspace layout with knowledge/ and .mycelium/ directories
- [Source: docs/concepts/mycelium-labs-architecture.md#3.1-Wiki-Articles] — article format, frontmatter schema, file naming conventions, article types by phase
- [Source: docs/concepts/mycelium-labs-architecture.md#9-Decisions-Log] — D1 (wiki markdown as persistence), D7 (phase-organized directories with typed articles), D9 (wiki as source of truth)
- [Source: docs/epics-mycelium-devs.md#Story-1.3] — epic acceptance criteria

## Change Log

| Date       | Change                  | Author          |
| ---------- | ----------------------- | --------------- |
| 2026-04-14 | Story drafted           | Richie          |
| 2026-04-14 | Implementation complete | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](docs/stories/my-1-3-wiki-directory-structure-and-article-format.context.xml) — generated 2026-04-14

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created `daemon/scripts/init-wiki.sh` — idempotent wiki directory initialization script
- Takes two required args: `projectId` and `workingDir`
- Creates all 9 phase directories under `knowledge/` using `mkdir -p`
- Initializes `index.md` with project name, empty phase sections, and links to system articles
- Initializes `log.md` with operations log header and creation entry with timestamp
- Creates 4 system articles (`dependency-map.md`, `deployment-manifest.md`, `debt-registry.md`, `pending-work.md`) with proper frontmatter (type: system, phase: system, status: active)
- All system articles include standard wiki sections (Purpose, Dependencies, Dependents, Notes)
- Creates `.mycelium/compile-state.json` (empty `{}`) and `.mycelium/embeddings-queue.json` (empty `[]`)
- All file creation uses `-f` check — running twice on the same project skips existing files
- Script is marked executable (`chmod +x`)
- Added `init-wiki` npm script to `package.json`

### File List

| Status   | File                          |
| -------- | ----------------------------- |
| NEW      | `daemon/scripts/init-wiki.sh` |
| MODIFIED | `daemon/scripts/package.json` |

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-14
**Outcome:** Approve

### Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                | File                                                                                              | Recommendation                                                                                                                                                                                                                                                                                                                                 |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- |
| 1   | Med      | The `index.md` catalog sections list Discovery, Planning, Solutioning, Implementation, QA, Release, Support, System — but the architecture doc article types table also includes a "Release" and "Support" phase. The directory structure does not include `release/` or `support/` directories. Articles for these phases would need to go somewhere. | `daemon/scripts/init-wiki.sh:43-53`                                                               | The architecture doc section 3.1 shows article types for Release and Support phases but the wiki structure in section 2 only shows the 9 directories listed. This is consistent with the architecture diagram — release and support articles likely go in `planning/` or a future directory. Low risk since these phases are Epic 3+ concerns. |
| 2   | Low      | The `find` command in the summary section (`find "${KNOWLEDGE_DIR}/${dir}" -name "\*.md" 2>/dev/null                                                                                                                                                                                                                                                   | wc -l`) works but on macOS `wc -l`includes leading whitespace, hence the`tr -d ' '`. Good detail. | `daemon/scripts/init-wiki.sh:245`                                                                                                                                                                                                                                                                                                              | No action needed. |
| 3   | Low      | System articles include `createdByEpic: MY-1` and `createdByStory: MY-1.3` in frontmatter, which is good provenance tracking matching the architecture doc's node property schema.                                                                                                                                                                     | `daemon/scripts/init-wiki.sh:172-174`                                                             | No action needed — good practice.                                                                                                                                                                                                                                                                                                              |
| 4   | Low      | Heredoc markers (INDEXEOF, LOGEOF, SYSEOF) are not quoted with single quotes, which means shell variable expansion is active inside them. This is intentional here since `${PROJECT_ID}` and `${TODAY}` need to be expanded. Just noting that if any future content contains `$` or backticks, they would be interpreted.                              | `daemon/scripts/init-wiki.sh:68,129,163`                                                          | Be aware if article templates ever include shell-special characters. For this use case, it is correct.                                                                                                                                                                                                                                         |

### Action Items

- [x] All 9 phase directories created under `knowledge/` (AC #1)
- [x] `index.md` initialized with project name and empty catalog structure (AC #2)
- [x] `log.md` initialized with creation entry and timestamp (AC #3)
- [x] `.mycelium/compile-state.json` created with `{}` (AC #4)
- [x] `.mycelium/embeddings-queue.json` created with `[]` (AC #5)
- [x] Script takes `projectId` and `workingDir` arguments (AC #6)
- [x] Idempotent — all file creation guarded by `[ ! -f ]` checks (AC #7)
- [x] 4 system articles created with proper frontmatter matching architecture doc schema
- [x] `set -euo pipefail` for strict error handling
- [x] No hardcoded paths — all derived from arguments

### Summary

Well-crafted shell script that faithfully implements the wiki directory structure from the architecture document. The idempotency is properly implemented via `-f` checks on every file creation. Frontmatter on all created files follows the exact schema from architecture doc section 3.1. The system articles include correct provenance tracking (createdByEpic, createdByStory). Clean, readable code with good logging.
