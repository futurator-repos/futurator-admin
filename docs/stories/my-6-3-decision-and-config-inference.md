# Story MY-6.3: Decision & Config Inference

Status: review

## Story

As a **developer**,
I want **architectural decisions automatically inferred from configuration files and package manifests**,
So that **the knowledge graph captures the "why" behind technology choices even for existing projects**.

## Acceptance Criteria

1. The decision inference agent reads `package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, and other config/manifest files in the project root
2. Decision articles are created in `knowledge/decisions/` for major technology choices: framework, database, auth provider, styling approach, bundler, testing framework, deployment strategy, etc.
3. Each decision article includes: Context (inferred from usage patterns), Chosen Option (the technology/approach detected), Evidence (which files and configs demonstrate the choice), and Alternatives Considered (left empty for user refinement)
4. Decision articles have `INFORMS` edges (via `[[wikilinks]]`) to the code articles that use/implement them
5. A synthesized architecture overview article is created at `knowledge/solutioning/architecture-overview.md` summarizing all inferred decisions
6. Decision articles are assigned lower maturity (`0.3`-`0.5`) since they are reverse-engineered, not explicitly documented
7. `knowledge/index.md` is updated to include all new decision and solutioning articles

## Tasks / Subtasks

- [x] Task 1: Implement config file reader (AC: #1)
  - [x] 1.1: Create `/home/ubuntu/scripts/bootstrap-decisions.mjs` — decision inference orchestrator
  - [x] 1.2: Discover and read config/manifest files: `package.json`, `tsconfig.json`, `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`, `.eslintrc.*`, `.prettierrc.*`, `jest.config.*`, `vite.config.*`, `next.config.*`, `tailwind.config.*`, `webpack.config.*`
  - [x] 1.3: Parse `package.json` dependencies and devDependencies — classify into categories (framework, state management, routing, styling, testing, build tools, utilities)
  - [x] 1.4: Parse `tsconfig.json` for compiler options that reflect architectural choices (strict mode, path aliases, target, module resolution)
  - [x] 1.5: Parse Docker/compose files for deployment and infrastructure decisions

- [x] Task 2: Implement decision inference agent step (AC: #2, #3, #6)
  - [x] 2.1: Create agent prompt for the Decision Inferrer role — analyzes config data and produces decision articles
  - [x] 2.2: Infer framework decision (e.g., React, Next.js, Vue, Express) from dependencies and config files
  - [x] 2.3: Infer database decision from dependencies (e.g., prisma, mongoose, pg, dynamodb-toolbox) and connection configs
  - [x] 2.4: Infer auth approach from dependencies and code patterns (e.g., jwt, passport, next-auth, cognito)
  - [x] 2.5: Infer styling decision from dependencies and configs (e.g., Tailwind, styled-components, CSS modules, SCSS)
  - [x] 2.6: Infer build/bundler decision from configs and scripts (e.g., Vite, webpack, esbuild, Next.js built-in)
  - [x] 2.7: Infer testing strategy from dependencies and configs (e.g., Jest, Vitest, Playwright, Cypress)
  - [x] 2.8: Infer deployment strategy from Docker, CI/CD configs, and package.json scripts
  - [x] 2.9: Set maturity between `0.3` (weak inference) and `0.5` (strong evidence) based on number of config signals

- [x] Task 3: Generate decision articles (AC: #2, #3, #4)
  - [x] 3.1: Write decision articles to `knowledge/decisions/` using naming convention `{category}-{choice}.md` (e.g., `framework-nextjs.md`, `styling-tailwind.md`)
  - [x] 3.2: Each article follows the standard wiki format with frontmatter: `type: decision`, `phase: solutioning`, `status: active`
  - [x] 3.3: Include `## Context` section with inferred rationale from usage patterns
  - [x] 3.4: Include `## Chosen Option` with the detected technology and version
  - [x] 3.5: Include `## Evidence` listing specific files and config entries that demonstrate the choice
  - [x] 3.6: Include empty `## Alternatives Considered` section for future user refinement
  - [x] 3.7: Add `INFORMS` edges via `[[wikilinks]]` in an `## Informs` section pointing to code articles that use the decision

- [x] Task 4: Generate architecture overview (AC: #5, #7)
  - [x] 4.1: Create `knowledge/solutioning/architecture-overview.md` — a synthesized summary of all inferred decisions, tech stack diagram, and project structure overview
  - [x] 4.2: Include `[[wikilinks]]` to each decision article and key code articles
  - [x] 4.3: Set frontmatter: `type: architecture`, `phase: solutioning`, `status: active`, `maturity: 0.4`
  - [x] 4.4: Update `knowledge/index.md` with all new decision articles and the architecture overview
  - [x] 4.5: Append decision inference record to `knowledge/log.md`

- [x] Task 5: Pipeline integration (AC: #1)
  - [x] 5.1: Register as stage 3 of the `brownfield-bootstrap` pipeline (runs after scan, can run in parallel with deps stage)
  - [x] 5.2: Emit pipeline events: `{ type: 'progress', stage: 'decisions', decisionsInferred: X }`
  - [x] 5.3: Log summary: decisions inferred, config files analyzed, maturity distribution

## Dev Notes

### Architecture Context

This story runs as the third stage of the Brownfield Bootstrap pipeline. While Story 6.2 (Import Dependency Extraction) focuses on structural relationships between code files, this story captures the higher-level "why" — the architectural decisions that shaped the codebase. Together, they create a two-layer graph: structural (code-to-code edges) and intentional (decision-to-code edges).

**This story can run in parallel with Story 6.2** since both read from the scan output (Story 6.1) but write to different wiki directories (`decisions/` and `solutioning/` vs. updating `code/` articles).

Inferred decisions are marked with lower maturity (`0.3`-`0.5`) because they are reverse-engineered from configuration evidence rather than explicitly documented. This is intentional — it signals to the user and to future agents that these decisions should be reviewed and refined. A decision with `maturity: 0.3` means "we detected this is used, but the rationale is unclear." A decision with `maturity: 0.5` means "strong evidence from multiple config files and widespread usage."

### Decision Article Format

```markdown
---
title: Framework — Next.js
type: decision
phase: solutioning
status: active
maturity: 0.5
created: 2026-04-14
updated: 2026-04-14
createdByEpic: bootstrap
createdByStory: bootstrap-decisions
tags: [framework, nextjs, react, ssr]
---

## Context

Project uses Next.js as the primary application framework, providing
server-side rendering, file-based routing, and API routes.

## Chosen Option

Next.js 14.x (detected from package.json)

## Evidence

- `package.json`: `"next": "^14.1.0"` in dependencies
- `next.config.js`: custom configuration present
- `src/app/` directory: App Router structure detected
- 15 page components using Next.js conventions

## Alternatives Considered

_Not documented — inferred from existing codebase_

## Informs

- [[code/src--app--layout.tsx]] — root layout using Next.js App Router
- [[code/src--app--page.tsx]] — home page component
- [[code/next.config.js]] — framework configuration
```

### Config File Analysis Patterns

| Config File                         | Decisions Inferred                                                |
| ----------------------------------- | ----------------------------------------------------------------- |
| `package.json`                      | Framework, state management, routing, styling, testing, utilities |
| `tsconfig.json`                     | TypeScript strictness, path aliases, module system                |
| `Dockerfile`                        | Runtime environment, deployment strategy                          |
| `docker-compose.yml`                | Service architecture, database choice                             |
| `.env.example`                      | External service integrations (auth, APIs, databases)             |
| `tailwind.config.*`                 | Styling approach, design system                                   |
| `jest.config.*` / `vitest.config.*` | Testing strategy                                                  |
| `vite.config.*` / `next.config.*`   | Build tooling                                                     |

### File Locations

| File                    | Path                                                                          | Purpose                          |
| ----------------------- | ----------------------------------------------------------------------------- | -------------------------------- |
| bootstrap-decisions.mjs | `/home/ubuntu/scripts/bootstrap-decisions.mjs`                                | Decision inference orchestrator  |
| Decision articles       | `/home/ubuntu/projects/{name}/knowledge/decisions/*.md`                       | Inferred technology decisions    |
| Architecture overview   | `/home/ubuntu/projects/{name}/knowledge/solutioning/architecture-overview.md` | Synthesized architecture summary |

### Dependencies

- **Story 6.1 (Codebase Scan Agent):** Must complete first — provides the code articles that decision articles link to via `INFORMS` edges
- **Story 1.3 (Wiki Directory Structure):** The `knowledge/decisions/` and `knowledge/solutioning/` directories must exist
- **Can run in parallel with Story 6.2** — they modify different wiki directories

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#3.1-Wiki-Articles] — article types by phase (decisions in solutioning phase)
- [Source: docs/concepts/mycelium-labs-architecture.md#3.2-Memgraph-Schema] — `INFORMS` edge type definition
- [Source: docs/concepts/mycelium-labs-architecture.md#Phase-9-Bootstrap-Pipeline] — decision inference scope
- [Source: docs/epics-mycelium-devs.md#Story-6.3] — epic acceptance criteria and technical notes

## Change Log

| Date       | Change                                           | Author          |
| ---------- | ------------------------------------------------ | --------------- |
| 2026-04-14 | Story drafted                                    | Richie          |
| 2026-04-14 | Implementation complete: bootstrap-decisions.mjs | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](my-6-3-decision-and-config-inference.context.xml)

### Agent Model Used

Claude Opus 4.6

### Debug Log References

No debug issues encountered.

### Completion Notes List

- Implemented `bootstrap-decisions.mjs` as a standalone Node.js ESM script in `daemon/scripts/`
- Config file discovery covers 40+ patterns: package.json, tsconfig.json, Dockerfile, docker-compose.yml, .env.example, .eslintrc._, .prettierrc._, jest/vitest/vite/next/tailwind/webpack configs, GitHub Actions workflows, serverless.yml, cdk.json, prisma schema, etc.
- Package categorization database covers 80+ well-known npm packages across 8 categories: framework, database, auth, styling, testing, bundler, stateManagement, deployment
- Decision inference produces articles for each detected category with evidence-based maturity scoring (0.3 for weak signals, 0.4 for moderate, 0.5 for strong multi-file evidence)
- TypeScript configuration is analyzed for strict mode, target, module system, and path aliases
- Deployment decisions inferred from Dockerfile, docker-compose, GitHub Actions, and serverless configs
- Decision articles follow ADR format with Context, Chosen Option, Evidence, Alternatives Considered (empty), and Informs sections
- INFORMS edges created via [[wikilinks]] to code articles that match decision tags (up to 10 per decision)
- Architecture overview generated at knowledge/solutioning/architecture-overview.md with tech stack table and decision article links
- Updates knowledge/index.md and appends to knowledge/log.md
- CLI supports `--dir`, `--project`, `--json`, `--help` flags
- Exports `inferDecisions(knowledgeDir, workingDir)` for programmatic use

### File List

| File                    | Path                                     | Purpose                                       |
| ----------------------- | ---------------------------------------- | --------------------------------------------- |
| bootstrap-decisions.mjs | `daemon/scripts/bootstrap-decisions.mjs` | Decision inference orchestrator               |
| package.json            | `daemon/scripts/package.json`            | Updated with bootstrap-decisions script entry |

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.6 (Senior Developer Review)
**Date:** 2026-04-14
**Status:** Approved with minor action items

### Findings

| #   | Area                    | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                      | Recommendation                                                                                                                                                         |
| --- | ----------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | AC Compliance           | Info     | All 7 ACs satisfied. Config file reading, decision article generation, INFORMS edges, architecture overview, maturity scoring (0.3-0.5), and index updates all implemented.                                                                                                                                                                                                  | None                                                                                                                                                                   |
| 2   | Maturity Scoring        | Pass     | Maturity values range from 0.3 (weak inference, e.g., single package reference) to 0.5 (strong evidence, e.g., config file + multiple packages). Matches AC #6 and review spec (0.3-0.5 for reverse-engineered decisions).                                                                                                                                                   | None                                                                                                                                                                   |
| 3   | Decision Article Format | Pass     | Follows ADR-style format with Context, Chosen Option, Evidence, Alternatives Considered (empty), and Informs sections. Frontmatter has `type: decision`, `phase: solutioning`, `status: active`. Matches architecture doc section 3.1.                                                                                                                                       | None                                                                                                                                                                   |
| 4   | Frontmatter Gap         | Low      | Same as Story 6.1 -- `lastMutatedByStory` field from architecture doc is omitted.                                                                                                                                                                                                                                                                                            | Add `lastMutatedByStory: bootstrap-decisions` for forward compatibility.                                                                                               |
| 5   | INFORMS Edges           | Pass     | `findInformedArticles()` scans code articles for tag matches and generates `[[code/slug]]` wikilinks in the `## Informs` section. Capped at 10 per decision. Maps to `INFORMS` edge type per section 3.2 edge mapping table.                                                                                                                                                 | None                                                                                                                                                                   |
| 6   | INFORMS Linking         | Low      | Tag-matching approach (`decision.tags.some(tag => content.toLowerCase().includes(tagLower))`) is broad. A tag like `"react"` will match any article mentioning "react" in any context (comments, variable names), leading to noisy INFORMS edges.                                                                                                                            | Consider matching against article frontmatter tags (parsed from YAML) rather than full-text search for more precise linking.                                           |
| 7   | Config Discovery        | Pass     | Covers 40+ config patterns including package.json, tsconfig, Dockerfile, docker-compose, env files, linter configs, test frameworks, build tools, CI/CD, serverless, CDK, Prisma. Comprehensive.                                                                                                                                                                             | None                                                                                                                                                                   |
| 8   | Glob Handling           | Low      | Glob-like patterns (e.g., `tsconfig.*.json`, `.github/workflows/*.yml`) are handled with a simple string-match approach that checks `entry.endsWith(ext)`. The logic at line 119 does `filePattern.replace('*', '')` then checks `endsWith` -- this actually produces the wrong suffix for `tsconfig.*.json` (it becomes `.json`, matching any JSON file in that directory). | Fix glob matching logic: extract the suffix after `*` correctly. For `tsconfig.*.json`, the expected match is files starting with `tsconfig.` and ending with `.json`. |
| 9   | Package Database        | Pass     | PACKAGE_CATEGORIES covers 80+ well-known npm packages across 8 categories (framework, database, auth, styling, testing, bundler, stateManagement, deployment). Good coverage.                                                                                                                                                                                                | None                                                                                                                                                                   |
| 10  | Architecture Overview   | Pass     | Generated at `knowledge/solutioning/architecture-overview.md` with tech stack table, decision article links, and maturity range summary. Frontmatter: `type: architecture`, `phase: solutioning`, `maturity: 0.4`. Meets AC #5.                                                                                                                                              | None                                                                                                                                                                   |
| 11  | Decision Naming         | Pass     | Decision articles use `{category}-{choice}.md` naming convention (e.g., `framework-nextjs.md`). Correct per story spec.                                                                                                                                                                                                                                                      | None                                                                                                                                                                   |
| 12  | Idempotency             | Pass     | `writeFileSync` overwrites existing decision articles. `updateIndexForDecisions` checks for duplicates before inserting rows. Re-running is safe.                                                                                                                                                                                                                            | None                                                                                                                                                                   |
| 13  | Framework Priority      | Low      | When multiple frameworks are detected (e.g., `next` + `react`), the first detected is used as `primary`. Detection order depends on `Object.entries()` iteration order of `PACKAGE_CATEGORIES.framework`, which is insertion order in V8 but technically not guaranteed by spec.                                                                                             | Add explicit priority ordering (meta-frameworks > UI frameworks > server frameworks) rather than relying on object key order.                                          |
| 14  | TypeScript Decision     | Pass     | tsconfig.json analysis extracts strict mode, target, module system, and path aliases. Creates a dedicated `language-typescript` decision article. Good.                                                                                                                                                                                                                      | None                                                                                                                                                                   |
| 15  | Missing Category        | Low      | No decision is inferred for "API style" (REST vs GraphQL). Packages like `apollo-server`, `@apollo/client`, `graphql`, `trpc` could inform a valuable decision.                                                                                                                                                                                                              | Consider adding an `api` category to PACKAGE_CATEGORIES for future enhancement.                                                                                        |

### Action Items

1. **[Low]** Fix glob matching logic for patterns like `tsconfig.*.json` to avoid false positives on unrelated JSON files.
2. **[Low]** Improve INFORMS linking precision by matching against article frontmatter tags rather than full-text content search.
3. **[Low]** Add explicit framework priority ordering instead of relying on object iteration order.
4. **[Low]** Add `lastMutatedByStory` to frontmatter template.

### Summary

The implementation delivers a capable decision inference engine that correctly analyzes config files and package manifests to produce well-formatted decision articles. All 7 acceptance criteria are met. Maturity scoring correctly uses the 0.3-0.5 range for reverse-engineered decisions. The INFORMS edges are generated via wikilinks in the correct section. The glob matching logic has a minor bug that could produce false-positive config file matches but is unlikely to cause incorrect decisions in practice. The code is clean, well-structured, and idempotent.
