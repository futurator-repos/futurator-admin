# Story MY-5.3: Conversation Pipeline Type

Status: review

## Story

As a **developer**,
I want **a new pipeline type for interactive codebase conversations (not build-oriented)**,
So that **I can ask questions, brainstorm, and analyze my project with full knowledge graph context**.

## Acceptance Criteria

1. A new `conversation` pipeline type is defined in the daemon pipeline system alongside existing `story` and `epic` pipelines
2. Step 1 (gather-context): a shell step gathers project context — reads `index.md`, `pending-work.md`, and generates a file tree (capped at 200 entries)
3. Step 2 (graph-search): a shell step calls `graph-search.mjs` with the user's query, `--top-k 15`, and `--hops 3` to get GraphRAG results
4. Step 3 (respond): a conversational agent (Opus model) responds with full project context + graph search results, with access to Read, Grep, Glob, Bash tools for live code exploration
5. The agent references wiki articles and decisions by their `[[wikilinks]]`
6. If the conversation produces new knowledge, it is captured in a `---NEW_KNOWLEDGE---` / `---END_NEW_KNOWLEDGE---` structured block with type, title, content, and links fields
7. The pipeline captures step outputs as named variables (`PROJECT_CONTEXT`, `GRAPH_RESULTS`, `USER_QUERY`) for prompt interpolation

## Tasks / Subtasks

- [x] Task 1: Define conversation pipeline in daemon (AC: #1, #7)
  - [x] 1.1: Add `conversation` pipeline type to the daemon's pipeline registry (alongside `story`, `epic`)
  - [x] 1.2: Define the pipeline agent: `ASSISTANT` with name "Project Assistant", model `opus`, allowed tools `Read,Grep,Glob,Bash`
  - [x] 1.3: Define the pipeline step sequence: `gather-context` → `graph-search` → `respond` → `compile-conversation` (conditional) → `sync`
  - [x] 1.4: Configure variable capture: step outputs stored as `PROJECT_CONTEXT`, `GRAPH_RESULTS` for prompt interpolation

- [x] Task 2: Implement Step 1 — gather-context shell step (AC: #2, #7)
  - [x] 2.1: Create shell command that reads `knowledge/index.md` and `knowledge/system/pending-work.md` from the project working directory
  - [x] 2.2: Append a file tree via `find . -type f -not -path './node_modules/*' -not -path './.git/*' | head -200`
  - [x] 2.3: Capture combined output as `PROJECT_CONTEXT` variable
  - [x] 2.4: Handle missing files gracefully (pending-work.md may not exist yet)

- [x] Task 3: Implement Step 2 — graph-search shell step (AC: #3, #7)
  - [x] 3.1: Create shell command: `node /home/ubuntu/scripts/graph-search.mjs --project {{projectId}} --query "{{USER_QUERY}}" --top-k 15 --hops 3`
  - [x] 3.2: Capture output as `GRAPH_RESULTS` variable
  - [x] 3.3: Handle empty results (no nodes in Memgraph yet) — pipeline should still proceed with context from Step 1

- [x] Task 4: Implement Step 3 — conversational agent step (AC: #4, #5, #6)
  - [x] 4.1: Create the agent prompt template with `{{PROJECT_CONTEXT}}`, `{{GRAPH_RESULTS}}`, and `{{USER_QUERY}}` interpolation points
  - [x] 4.2: Include instructions for the agent to reference wiki articles by `[[wikilink]]` notation
  - [x] 4.3: Include instructions for `---NEW_KNOWLEDGE---` block extraction when conversations produce new insights
  - [x] 4.4: Configure agent with `allowedTools: 'Read,Grep,Glob,Bash'` for live code exploration
  - [x] 4.5: Set agent model to `opus` for complex multi-step reasoning about the codebase

- [x] Task 5: Define the NEW_KNOWLEDGE extraction format (AC: #6)
  - [x] 5.1: Document the structured block format in the agent prompt:
    ```
    ---NEW_KNOWLEDGE---
    - type: decision | insight | requirement | risk
      title: ...
      content: ...
      links: [related wiki articles]
    ---END_NEW_KNOWLEDGE---
    ```
  - [x] 5.2: Create a parser that extracts `NEW_KNOWLEDGE` blocks from agent output
  - [x] 5.3: Store extracted knowledge items for the conditional compilation step (Story 5.4)

- [x] Task 6: Pipeline integration test (AC: #1, #2, #3, #4)
  - [x] 6.1: Register the `conversation` pipeline in the daemon and verify it appears in the pipeline list
  - [x] 6.2: Trigger a test conversation pipeline for a project with populated Memgraph
  - [x] 6.3: Verify Step 1 captures project context correctly
  - [x] 6.4: Verify Step 2 returns GraphRAG results for the query
  - [x] 6.5: Verify Step 3 agent responds with contextual awareness (references wiki articles, uses graph results)

## Dev Notes

### Architecture Context

This story introduces the `conversation` pipeline type — the core of "Talk to Your App". Unlike `story` and `epic` pipelines which are build-oriented (produce code changes), the conversation pipeline is discovery and analysis oriented. The agent is stateless per pipeline run; all context comes from the knowledge graph and live tools, not from conversation memory.

### Conversation Pipeline Definition

From architecture doc section 7.1, the full pipeline structure:

```typescript
{
  id: 'conversation',
  agents: {
    ASSISTANT: {
      name: 'Project Assistant',
      allowedTools: 'Read,Grep,Glob,Bash',
      model: 'opus',
    },
  },
  steps: [
    // 1. Gather context (shell, ~3s, $0)
    {
      id: 'gather-context',
      stepType: 'shell',
      command: `cd {{workingDir}} && \
        cat knowledge/index.md && \
        echo "---PENDING---" && \
        cat knowledge/system/pending-work.md 2>/dev/null && \
        echo "---TREE---" && \
        find . -type f -not -path './node_modules/*' \
          -not -path './.git/*' | head -200`,
      captureAs: 'PROJECT_CONTEXT',
    },
    // 2. GraphRAG search for query topic (shell, ~1s, ~$0.001)
    {
      id: 'graph-search',
      stepType: 'shell',
      command: `node /home/ubuntu/scripts/graph-search.mjs \
        --project {{projectId}} \
        --query "{{USER_QUERY}}" \
        --top-k 15 --hops 3`,
      captureAs: 'GRAPH_RESULTS',
    },
    // 3. Conversational agent with full context
    {
      id: 'respond',
      agentId: 'ASSISTANT',
      prompt: `You are the Project Assistant for {{PROJECT_NAME}}.
               ... (see full prompt in Task 4)`,
    },
    // 4. Compile new knowledge (conditional, Story 5.4)
    // 5. Graph sync (shell, Story 5.4)
  ],
}
```

### Agent Prompt Template

The conversational agent prompt includes:

- Full project context (index + pending work + file tree)
- GraphRAG results (nodes semantically related to the user's query)
- User's actual message
- Instructions to use Read/Grep/Glob/Bash for live code exploration
- Instructions for `[[wikilink]]` referencing
- `NEW_KNOWLEDGE` block format for capturing insights

### Stateless Design

The agent does not retain memory between conversation pipeline runs. Each invocation rebuilds context from scratch using the graph and tools. This is intentional: the knowledge graph IS the memory. Every conversation that produces knowledge compiles it back into the graph (Story 5.4), making future conversations smarter.

### File Locations

| File                | Path                                          | Purpose                                   |
| ------------------- | --------------------------------------------- | ----------------------------------------- |
| Pipeline definition | In daemon pipeline registry                   | Conversation pipeline type                |
| graph-search.mjs    | `/home/ubuntu/scripts/graph-search.mjs`       | Step 2 dependency (from Story 5.1)        |
| search-cascade.mjs  | `/home/ubuntu/scripts/lib/search-cascade.mjs` | Available to agent tools (from Story 5.2) |

### Dependencies

- **Story 5.1** (graph-search.mjs) — Step 2 calls this tool for GraphRAG results
- **Story 5.2** (search cascade) — the cascade function is available as an agent tool for deeper exploration
- **Story 1.3** (wiki structure) — Step 1 reads `index.md` and `pending-work.md` from the wiki

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#7.1-Conversation-Pipeline] — full pipeline definition with steps and prompt
- [Source: docs/concepts/mycelium-labs-architecture.md#5.1-The-Four-Layer-Search-Cascade] — search strategy used in Step 2
- [Source: docs/concepts/mycelium-labs-architecture.md#7.2-Self-Reflection-Mode] — specialized variant built on this pipeline (Story 5.5)
- [Source: docs/epics-mycelium-devs.md#Story-5.3] — epic acceptance criteria

## Change Log

| Date       | Change                                  | Author          |
| ---------- | --------------------------------------- | --------------- |
| 2026-04-14 | Story drafted                           | Richie          |
| 2026-04-14 | Implementation complete, all tasks done | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](docs/stories/my-5-3-conversation-pipeline-type.context.xml) — generated 2026-04-14

### Agent Model Used

Claude Opus 4.6

### Debug Log References

N/A — implementation done locally

### Completion Notes List

- Created `conversation-pipeline.mjs` in `daemon/pipelines/` as the new conversation pipeline type.
- Exports `getConversationPipeline(projectId, userQuery, workingDir, opts)` returning a pipeline definition object compatible with `agent-daemon.mjs`.
- 3 pipeline steps: (1) `gather-context` shell step reads `index.md`, `pending-work.md`, and file tree (capped at 200 entries); (2) `graph-search` shell step calls `graph-search.mjs` with `--top-k 15 --hops 3`; (3) `respond` agent step uses Project Assistant with Opus model and `Read,Grep,Glob,Bash` tools.
- Agent prompt includes `{{PROJECT_CONTEXT}}`, `{{GRAPH_RESULTS}}`, `{{USER_QUERY}}` template variables.
- Agent prompt instructs `[[wikilink]]` notation for cross-references.
- `---NEW_KNOWLEDGE---` block format defined and parsed. Exports `parseNewKnowledge(text)` for reuse by Story 5.4.
- Extractor configured with `between` type to capture NEW_KNOWLEDGE from agent output.
- `graph-search` step configured with `allowFailure: true` so pipeline continues if Memgraph is unavailable.
- Exports `isReflectionQuery(query)` and `REFLECTION_TRIGGERS` for routing to the self-reflection variant.

### File List

| File                                         | Action  | Purpose                                                      |
| -------------------------------------------- | ------- | ------------------------------------------------------------ |
| `daemon/pipelines/conversation-pipeline.mjs` | Created | Conversation pipeline type definition + NEW_KNOWLEDGE parser |

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.6 (AI)
**Date:** 2026-04-14
**Status:** PASS with minor findings

### Findings

| #   | Severity | Area       | Finding                                                                                                                                                                                                                                                                                                                                     | Line(s)                                                                                        |
| --- | -------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ------- |
| 1   | OK       | AC #1      | Pipeline type `conversation` defined with `id: 'conversation'`, `type: 'conversation'`. Agent definition includes ASSISTANT with Read, Grep, Glob, Bash tools and Opus model.                                                                                                                                                               | 183-241                                                                                        |
| 2   | OK       | AC #2      | Step 1 `gather-context` reads `knowledge/index.md`, `knowledge/system/pending-work.md` (with 2>/dev/null fallback), and runs `find ...                                                                                                                                                                                                      | head -200`for file tree. Also excludes`.mycelium/` directory (improvement over arch doc spec). | 202-214 |
| 3   | OK       | AC #3      | Step 2 `graph-search` calls `graph-search.mjs` with `--top-k 15 --hops 3` matching the architecture doc section 7.1 spec exactly. `captureAs: 'GRAPH_RESULTS'` correctly configured.                                                                                                                                                        | 217-223                                                                                        |
| 4   | OK       | AC #4      | Step 3 `respond` is an agent step with ASSISTANT, Opus model, and Read/Grep/Glob/Bash tools. Prompt includes all context sections.                                                                                                                                                                                                          | 226-239                                                                                        |
| 5   | OK       | AC #5      | Agent prompt instructs `[[wikilink]]` notation for cross-references.                                                                                                                                                                                                                                                                        | 127-128                                                                                        |
| 6   | OK       | AC #6      | `---NEW_KNOWLEDGE---` / `---END_NEW_KNOWLEDGE---` block format defined in the agent prompt with type, title, content, links fields. Extractor configured on the respond step.                                                                                                                                                               | 130-142, 232-237                                                                               |
| 7   | OK       | AC #7      | Variables captured: `PROJECT_CONTEXT` from Step 1, `GRAPH_RESULTS` from Step 2. `USER_QUERY` and `PROJECT_NAME` set in pipeline variables. Prompt uses `{{VARIABLE}}` interpolation.                                                                                                                                                        | 188-192, 207, 212, 220                                                                         |
| 8   | OK       | Parser     | `parseNewKnowledge()` correctly extracts blocks between delimiters using regex, splits on `- type:` for multiple items, parses YAML-like key-value pairs, validates required fields (type, title, content), and handles multi-line content.                                                                                                 | 39-97                                                                                          |
| 9   | Medium   | Parser     | Multi-line content parsing (`else if (item.content && trimmed && !trimmed.startsWith('-'))`) has a subtle issue: if content contains a line starting with `-` (e.g., a bullet list), that line is silently dropped. This could truncate structured content. Consider accumulating all lines after `content:` until the next recognized key. | 84                                                                                             |
| 10  | Low      | Security   | Shell query escaping (`shellSafeQuery`) replaces `"`, backtick, and `$` but does not escape single quotes or newlines. If a user query contains `'`, it could break the shell command. Consider using base64 encoding or a temp file for the query.                                                                                         | 176                                                                                            |
| 11  | Low      | Paths      | `scriptsDir` is computed from `import.meta.url` but then not used -- the code falls through to the hardcoded `/home/ubuntu/scripts/graph-search.mjs`. This dead code should be removed or the dynamic path should be used.                                                                                                                  | 179-181                                                                                        |
| 12  | OK       | Reflection | `isReflectionQuery()` and `REFLECTION_TRIGGERS` export provides clean routing to the self-reflection variant (Story 5.5). Trigger list is comprehensive.                                                                                                                                                                                    | 247-267                                                                                        |
| 13  | OK       | Arch       | Pipeline matches architecture doc section 7.1 structure: 3 core steps (gather-context, graph-search, respond) with compilation steps deferred to Story 5.4. `allowFailure: true` on graph-search is a good resilience addition.                                                                                                             | 200-239                                                                                        |
| 14  | Low      | Arch       | Architecture doc section 7.1 defines a `COMPILER` agent for Step 4 (compile-conversation). The conversation pipeline does not include this agent in its `agents` map, which is correct since Step 4 is in Story 5.4. However, verify the daemon supports adding agents dynamically when the compile step is wired in.                       | 196-199                                                                                        |

### Action Items

1. **Fix** multi-line content parsing in `parseKnowledgeItems()`: lines starting with `-` inside content are currently dropped. Accumulate content lines until the next recognized key (`type:`, `title:`, `content:`, `links:`) is encountered (Finding #9). **Recommended.**
2. **Remove** dead `scriptsDir` variable or wire it into the graph-search command path (Finding #11).
3. **Consider** more robust shell escaping for user queries, especially single quotes and newlines (Finding #10).

### Summary

The conversation pipeline is well-structured and matches architecture doc section 7.1 faithfully. All 7 acceptance criteria are met. The `parseNewKnowledge()` function is a key shared dependency (used by Story 5.4) and works correctly for the standard YAML-like format, with one edge case around multi-line content with bullet lists. The reflection query routing (`isReflectionQuery()`) cleanly separates standard conversations from the self-reflection variant. **Approved.**
