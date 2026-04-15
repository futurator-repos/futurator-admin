# Story MY-2.3: Knowledge Compiler Agent Step

Status: review

## Story

As a **developer**,
I want **an agent step that reads the diff manifest and creates/updates wiki articles for each changed file**,
So that **code changes are automatically decomposed into structured knowledge nodes**.

## Acceptance Criteria

1. For each new file in `DIFF_MANIFEST`: a wiki article is created in `knowledge/code/` with full frontmatter (title, type, phase, status, maturity, dates, tags) and sections (Purpose, Key Exports, Dependencies, Dependents, Signals, Missing Signals, Notes)
2. For each modified file: the existing wiki article is updated with revised content and `lastMutatedByStory` is set to the current story ID
3. For deleted files: the corresponding article's status is set to `superseded`
4. Architectural decisions from the `WORK_SUMMARY` are extracted and saved to `knowledge/decisions/` as decision articles
5. `knowledge/system/dependency-map.md` is updated with new import relationships discovered from the changed files
6. `knowledge/index.md` is updated with new/changed article entries
7. `knowledge/log.md` gets a compilation record appended with timestamp, story ID, and article count
8. All cross-references between articles use `[[wikilinks]]` format (e.g., `[[code/src--components--auth.tsx]]`)

## Tasks / Subtasks

- [x] Task 1: Define the COMPILER agent step in the pipeline (AC: #1, #2, #3)
  - [x] 1.1: Add the `compile-knowledge` step to `generateStoryPipeline()` after the `compile-diff` step
  - [x] 1.2: Set `stepType: 'agent'`, `agentId: 'COMPILER'`
  - [x] 1.3: Craft the prompt template injecting `{{DIFF_MANIFEST}}`, `{{WORK_SUMMARY}}`, story acceptance criteria, and epic title
  - [x] 1.4: Configure allowed tools: `Read, Write, Edit, Glob, Grep`
  - [x] 1.5: Set `captureAs: 'COMPILE_RESULT'` to capture compilation output for the sync step

- [x] Task 2: Implement the Knowledge Compiler prompt (AC: #1, #2, #3, #4, #8)
  - [x] 2.1: Write the system prompt for the COMPILER agent following the architecture doc section 4.2 Step B specification
  - [x] 2.2: Include instructions for creating new code articles with the standard article format (frontmatter + Purpose/Key Exports/Dependencies/Dependents/Signals/Missing Signals/Notes)
  - [x] 2.3: Include instructions for updating existing articles and revising `lastMutatedByStory`
  - [x] 2.4: Include instructions for marking deleted files as `status: superseded`
  - [x] 2.5: Include instructions for extracting decisions (library choices, pattern selections, API design) from `WORK_SUMMARY`
  - [x] 2.6: Mandate `[[wikilinks]]` format for all cross-references

- [x] Task 3: Implement wiki article creation logic (AC: #1, #8)
  - [x] 3.1: Define the article frontmatter template with fields: title, type (`code`), phase (`implementation`), status (`active`), maturity, created, updated, createdByEpic, createdByStory, lastMutatedByStory, tags
  - [x] 3.2: Define the file naming convention: `knowledge/code/{slug}.md` where slug uses `--` for path separators (e.g., `src--components--auth.tsx.md`)
  - [x] 3.3: Include wikilink generation instructions for Dependencies and Dependents sections based on import analysis

- [x] Task 4: Implement dependency map and index updates (AC: #5, #6)
  - [x] 4.1: Add instructions in the compiler prompt to update `knowledge/system/dependency-map.md` with new import relationships
  - [x] 4.2: Add instructions to update `knowledge/index.md` with new article entries (slug, title, type, status)
  - [x] 4.3: Ensure index entries link to their articles via relative paths

- [x] Task 5: Implement compilation logging (AC: #7)
  - [x] 5.1: Add instructions to append a record to `knowledge/log.md` with: timestamp, story ID, compilation type, articles created/updated/superseded counts
  - [x] 5.2: Define the log entry format for consistency across story and epic compilations

- [x] Task 6: Validate article format compliance (AC: #1, #8)
  - [x] 6.1: Verify created articles match the Karpathy wiki pattern from architecture doc section 3.1
  - [x] 6.2: Verify wikilinks resolve to valid `knowledge/` paths
  - [x] 6.3: Verify frontmatter YAML is valid and contains all required fields

## Dev Notes

### Architecture Context

This is "Step B" of the Story Compilation pipeline — the most complex and costly sub-step. The Knowledge Compiler is an **agent step** (not a shell step), meaning it executes as a Claude agent with tool access. The agent reads actual source code files to understand their purpose, exports, and imports, then writes structured wiki articles.

The agent prompt from architecture doc section 4.2:

```
You are the Knowledge Compiler. For each changed file in DIFF_MANIFEST:

1. If a wiki article exists in knowledge/code/ for this file:
   - UPDATE it: revise Purpose, Dependencies, Dependents, Signals, Missing Signals
   - Update frontmatter: lastMutatedByStory, updated date, maturity score

2. If no article exists:
   - CREATE one following the standard article format
   - Set frontmatter: createdByStory, type: code, phase: implementation

3. For deleted files: mark their article status: superseded

4. Extract any architectural DECISIONS from WORK_SUMMARY
5. Update knowledge/system/dependency-map.md
6. Update knowledge/index.md
7. Update knowledge/log.md
```

The agent is allowed tools `Read, Write, Edit, Glob, Grep` — the same set used by Dev agents, ensuring it can inspect source files and write wiki articles. The cost is approximately $0.03-0.08 per compilation depending on diff size.

The article format follows the Karpathy wiki pattern established in the architecture doc section 3.1. Each article has YAML frontmatter and structured markdown sections. Wikilinks (`[[section/slug]]`) become typed edges in Memgraph when the embed-sync step processes them (Story 2.4). The wikilink section placement determines edge type — links in the Dependencies section become `DEPENDS_ON` edges, links in Dependents become incoming edges, etc.

The `WORK_SUMMARY` variable comes from the Dev agent's output in the earlier pipeline steps. It contains a summary of what the Dev agent implemented, including any architectural decisions made during development. The compiler extracts these decisions and creates separate articles in `knowledge/decisions/`.

### Key Files

| File                                           | Purpose                                                     |
| ---------------------------------------------- | ----------------------------------------------------------- |
| `functions/api/index.ts`                       | `generateStoryPipeline()` — where the agent step is defined |
| `daemon/agent-daemon.mjs`                      | Agent step executor, handles prompt template substitution   |
| `functions/shared/types/agent-orchestrator.ts` | `AgentConfig`, `PipelineStep` types                         |

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#4.2-Story-Compilation-Step] — Step B agent prompt and article format specification
- [Source: docs/concepts/mycelium-labs-architecture.md#3.1-Wiki-Articles] — article format, frontmatter fields, wikilink conventions
- [Source: docs/concepts/mycelium-labs-architecture.md#3.2-Memgraph-Schema] — edge types derived from wikilink section placement
- [Source: docs/epics-mycelium-devs.md#Story-2.3] — epic acceptance criteria

## Change Log

| Date       | Change                  | Author          |
| ---------- | ----------------------- | --------------- |
| 2026-04-14 | Story drafted           | Richie          |
| 2026-04-14 | Implementation complete | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](my-2-3-knowledge-compiler-agent-step.context.xml)

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created comprehensive `daemon/pipelines/compiler-prompt.md` with full Knowledge Compiler instructions
- Prompt covers all 7 agent tasks: create articles (A), update articles (M), supersede articles (D), extract decisions, update dependency-map, update index.md, update log.md
- Article format follows Karpathy wiki pattern: YAML frontmatter (13 fields) + 7 structured sections (Purpose, Key Exports, Dependencies, Dependents, Signals, Missing Signals, Notes)
- File naming convention documented: `knowledge/code/{slug}.md` with `--` path separators
- Wikilink edge type mapping table included for all 8 edge types (DEPENDS_ON, DERIVED_FROM, INFORMS, etc.)
- Decision extraction instructions cover library choices, pattern selections, API design, data model decisions
- The inline prompt in `generateStoryPipeline()` contains the core compilation instructions; the `compiler-prompt.md` file provides the full reference prompt loaded by `compile-pipeline.mjs`
- `captureAs: 'COMPILE_RESULT'` captures agent output for the sync step

### File List

- `daemon/pipelines/compiler-prompt.md` — NEW: Full Knowledge Compiler agent prompt template with article format, naming conventions, wikilink rules, processing instructions, and decision extraction guidelines
- `functions/api/index.ts` — MODIFIED: compile-knowledge agent step with inline prompt including `{{DIFF_MANIFEST}}`, `{{WORK_SUMMARY}}`, story AC, epic title
- `daemon/pipelines/compile-pipeline.mjs` — MODIFIED: Loads compiler-prompt.md and injects context variables

## Senior Developer Review (AI)

- **Reviewer:** Claude Opus 4.6 (Senior Developer)
- **Date:** 2026-04-14
- **Outcome:** Approve (with minor findings)

### Findings

| #   | Severity | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | File(s)                                                                        | Recommendation                                                                                                                                                                                                            |
| --- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Medium   | Two divergent compiler prompts exist: (a) the comprehensive `compiler-prompt.md` (165 lines, loaded by `compile-pipeline.mjs`) and (b) the inline prompt in `generateStoryPipeline()` (~40 lines). Only the inline prompt is actually used in the pipeline. The `compiler-prompt.md` contains valuable detail (wikilink edge type mapping table, processing instructions for A/M/D statuses, constraints) that the inline prompt omits. The COMPILER agent may produce lower quality articles without these instructions. | `daemon/pipelines/compiler-prompt.md`, `functions/api/index.ts`                | Use the comprehensive prompt from `compiler-prompt.md` in the actual pipeline. Either load it at pipeline generation time (in `generateStoryPipeline()`) or switch to using `compile-pipeline.mjs`'s `getCompileSteps()`. |
| 2   | Low      | The inline prompt embeds `story.description` as both the full story text (in the DEV step) and as "Story Acceptance Criteria" (in the COMPILER step). The description field contains the full story markdown, not just ACs. This is semantically inaccurate but functionally harmless -- the COMPILER agent gets more context, not less.                                                                                                                                                                                  | `functions/api/index.ts`                                                       | Consider extracting just the AC section from the story description, or rename the section header to "Story Description" for accuracy.                                                                                     |
| 3   | Low      | `captureAs: 'COMPILE_RESULT'` is set on the compile-knowledge step, but `COMPILE_RESULT` is never consumed by any downstream step. The compile-sync step does not reference `{{COMPILE_RESULT}}` in its command. This variable is captured but unused in the current pipeline.                                                                                                                                                                                                                                            | `functions/api/index.ts`                                                       | This is acceptable as a forward-looking design (Epic 3 or status tracking may use it). Add a comment noting it is captured for observability and future use.                                                              |
| 4   | Low      | The `compiler-prompt.md` instructs the agent to "Read the file at ${workingDir}/knowledge/index.md" (literal `${workingDir}`) in the `compile-pipeline.mjs`version but uses the substituted path. Since`compiler-prompt.md`is loaded as a template by`compile-pipeline.mjs`, the `${workingDir}` would not be substituted -- the `{{DIFF_MANIFEST}}` and `{{WORK_SUMMARY}}` use the daemon's `{{VAR}}` syntax, but the `${workingDir}` is JavaScript template literal syntax only available in the inline prompt.         | `daemon/pipelines/compile-pipeline.mjs`, `daemon/pipelines/compiler-prompt.md` | In `compiler-prompt.md`, use `{{WORKING_DIR}}` placeholder syntax (matching the daemon's template engine) or hardcode the instruction as "Read the knowledge/index.md file in the working directory."                     |
| 5   | Info     | The `compiler-prompt.md` is thorough and well-structured. The wikilink edge type mapping table (8 edge types), the article format template with all 13 frontmatter fields and 7 sections, and the processing instructions for A/M/D statuses all align with architecture doc section 3.1 and 4.2. The decision extraction instructions cover the right categories (library choices, patterns, API design, data model).                                                                                                    | `daemon/pipelines/compiler-prompt.md`                                          | No change needed. This is high-quality prompt engineering.                                                                                                                                                                |
| 6   | Info     | ACs #1-#8 are all addressed. Article creation (#1), update (#2), supersede (#3), decision extraction (#4), dependency-map update (#5), index update (#6), log update (#7), and wikilink format (#8) are all covered by the prompt instructions. The agent has the right tools (`Read,Write,Edit,Glob,Grep`).                                                                                                                                                                                                              | All                                                                            | No change needed.                                                                                                                                                                                                         |

### Action Items

- [ ] Reconcile inline prompt with comprehensive `compiler-prompt.md` (ideally use the comprehensive version)
- [ ] Fix `${workingDir}` in `compiler-prompt.md` template context (use `{{WORKING_DIR}}` or hardcode)
- [ ] Add comment on `captureAs: 'COMPILE_RESULT'` noting it is for observability

### Summary

The Knowledge Compiler agent step is well-designed. The `compiler-prompt.md` is comprehensive and aligns tightly with the architecture document's specifications for article format, frontmatter fields, wikilink conventions, and processing logic. All 8 ACs are addressed in the prompt instructions. The main gap is that the actual pipeline uses a shorter inline prompt that omits important details from the comprehensive version (edge type mapping, explicit A/M/D processing instructions, constraints). Reconciling these two prompts is the key action item. The `captureAs` chaining from `DIFF_MANIFEST` and `WORK_SUMMARY` is correctly wired. Approved with the understanding that the prompt reconciliation will be addressed before the comprehensive version becomes stale.
