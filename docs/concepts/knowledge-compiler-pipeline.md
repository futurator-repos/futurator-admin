# Knowledge Compiler Pipeline — Analysis & Deficiencies

## Purpose

The Knowledge Compiler is a post-development pipeline phase that automatically builds a **living knowledge graph** from code changes. After each story's dev+review cycle completes, the compiler reads the changed files and produces structured wiki articles that form a navigable, interconnected documentation layer.

The end goal: any future agent (or human) working on the project can query a graph database (Memgraph) or browse markdown files to understand what every file does, what it depends on, and what depends on it — without reading the source code directly.

## Pipeline Steps

Each story pipeline runs 6 steps total: 3 for dev/review, 3 for compilation.

```
Story Pipeline (per story)
│
├─ Step 1: dev           (Agent DEV)       — Write code
├─ Step 2: review        (Agent REVIEWER)  — Review code, PASS/FAIL
├─ Step 3: retry         (Agent DEV)       — Fix review failures (loop-only)
│
├─ Step 4: compile-diff  (Shell)           — git diff to get changed file list
├─ Step 5: compile-knowledge (Agent COMPILER) — Write wiki articles
└─ Step 6: compile-sync  (Shell)           — Embed to Memgraph + S3 backup
```

### Step 4: compile-diff (Shell, ~1s, $0)

Runs `git diff --name-status HEAD~1 HEAD` to produce a manifest of changed files:

```
A   src/components/DinoSprite.tsx
A   src/components/DinoSprite.css
M   src/App.tsx
```

This output is captured as the `DIFF_MANIFEST` variable, injected into the compiler prompt.

### Step 5: compile-knowledge (Agent COMPILER, Sonnet, ~2.5min, ~$0.40)

A full Claude Code session (Sonnet model) with Read/Write/Edit/Glob/Grep tools. The agent receives:

- The compiler prompt (170 lines of instructions from `compiler-prompt.md`)
- The `DIFF_MANIFEST` (which files changed)
- The `WORK_SUMMARY` (what the developer did)
- Story and epic context metadata

For **each file** in the diff manifest, the agent:

1. **Reads** the source file to understand purpose, exports, imports
2. **Globs** `knowledge/**/*.md` to find existing articles
3. **Reads** `knowledge/index.md` (article catalog)
4. **Reads** `knowledge/log.md` (compilation history)
5. **Reads** `knowledge/system/dependency-map.md` (import graph)
6. **Greps** the codebase for files that import this file (to find dependents)
7. **Writes** a structured markdown article at `knowledge/code/{slug}.md`
8. **Updates** `knowledge/index.md` with the new entry
9. **Updates** `knowledge/system/dependency-map.md` with new edges
10. **Appends** to `knowledge/log.md` with a compilation record

Each article follows a strict format:

```markdown
---
title: 'DinoSprite Component'
type: code
status: active
maturity: 0.5
createdByStory: 'story-4'
lastMutatedByStory: 'story-4'
tags: [component, game, sprite]
---

## Purpose

Renders the dinosaur character with idle, running, jumping, and ducking animations.

## Key Exports

- `DinoSprite` — React component accepting `state: DinoState` prop

## Dependencies

- [[code/src--types--game.ts]] — imports DinoState interface
- [[code/src--constants.ts]] — imports GROUND_Y, GAME_WIDTH

## Dependents

- [[code/src--App.tsx]] — renders DinoSprite in game loop

## Signals

- Uses CSS sprite sheets for animation frames
- Pure presentational component with no side effects

## Missing Signals

- No error boundary for missing sprite assets
- No loading state for sprite images
```

The `[[wikilinks]]` become typed graph edges in Memgraph (DEPENDS_ON, DERIVED_FROM, etc.), enabling graph queries like "what breaks if I change this file?"

### Step 6: compile-sync (Shell, ~3s, ~$0.001)

```bash
node /home/ubuntu/scripts/graph-sync.mjs \
  --project dino-chrome \
  --knowledge-dir /home/ubuntu/projects/dino-chrome/knowledge \
  --state-file /home/ubuntu/projects/dino-chrome/.mycelium/compile-state.json

aws s3 sync knowledge/ s3://futurator-ai-website/knowledge-live/dino-chrome/
```

1. `graph-sync.mjs` parses the markdown articles, extracts wikilinks, and upserts nodes/edges into Memgraph
2. S3 sync backs up the knowledge directory for web access

## Observed Performance (Chrome Dinosaur Game, 10 stories)

| Metric                       | Per Story          | Total (10 stories) |
| ---------------------------- | ------------------ | ------------------ |
| compile-knowledge duration   | ~2.5 min           | ~25 min            |
| compile-knowledge cost       | ~$0.40             | ~$4.00             |
| compile-knowledge tokens     | ~36,000 (9.7k out) | ~360,000           |
| compile-knowledge tool calls | ~25                | ~250               |
| Model used                   | Sonnet             | —                  |

For comparison, the dev+review cycle per story costs ~$0.20-0.65 using Haiku. The compiler alone nearly doubles the total cost.

## Deficiencies

### 1. Wrong Model for the Task

**Problem:** The COMPILER agent uses Sonnet ($3/MTok output) for what is essentially structured text extraction and markdown templating. There is no complex reasoning — it reads a file, identifies exports/imports, and fills in a template.

**Impact:** 12x more expensive than necessary. $0.40/story vs ~$0.03/story with Haiku.

**Fix:** Switch `model: 'sonnet'` to `model: 'haiku'` in `getCompilerAgent()`. The article quality will be equivalent — Haiku can read code and write structured markdown just fine.

### 2. Redundant File Reads Per Story

**Problem:** The agent reads `knowledge/index.md`, `knowledge/log.md`, and `knowledge/system/dependency-map.md` for EVERY story, even though it just wrote them 2 minutes ago in the previous story. With 8 parallel stories in Wave 1, all 8 agents read and write the same 3 system files, creating race conditions and wasted reads.

**Impact:** ~8-12 unnecessary tool calls per story. With round-trip latency of ~1-2s per tool call, that's 10-20 seconds of pure overhead.

**Fix:** Inject the current state of system files into the prompt (from the previous compile's output), or defer system file updates to a single post-wave consolidation step.

### 3. Per-File Agent Sessions (Not Batched)

**Problem:** The agent spawns a full Claude Code session (with system prompt, tool definitions, context window setup) to process what is often a 1-2 file diff. The session overhead (system prompt + tool schema = ~27k cache tokens) dwarfs the actual work.

**Impact:** For a 2-file diff, the agent uses 27k tokens just for setup, then 9k tokens for actual work. 75% of tokens are overhead.

**Fix:** For small diffs (1-5 files), inline the source file contents directly in the prompt instead of having the agent Read them. This eliminates tool calls entirely for simple cases.

### 4. Parallel Compilers Cause OOM

**Problem:** With `MAX_CONCURRENT=5`, up to 5 compile-knowledge agents run simultaneously, each spawning a Sonnet session (~150MB per process). Combined with the daemon, SSM agent, and CloudWatch, this exceeds the t2.micro's 1.8GB RAM.

**Impact:** OOM killer terminates either the SSM agent (losing remote access) or the daemon itself. Observed twice on April 14-15.

**Fix:** Two options:

- Run compile steps with their own concurrency limit (max 1-2 compilers at a time)
- Defer all compilation to a single post-wave batch step instead of per-story

### 5. No Incremental Awareness

**Problem:** Each story's compiler runs independently with no knowledge of what other stories in the same wave compiled. When Wave 1 has 8 stories all touching `App.tsx`, the COMPILER creates/updates the `App.tsx` article 8 times, each time reading and rewriting the full article.

**Impact:** Massive duplication. The last compiler to finish "wins" and overwrites earlier updates. Earlier compilations' Dependents sections become stale because they don't reflect the other 7 stories' changes.

**Fix:** Move compilation to a **wave-level step** (after all stories in a wave complete), processing all diffs in a single batch. This eliminates duplicate work and produces a consistent knowledge state.

### 6. DIFF_MANIFEST Often Empty

**Problem:** The `compile-diff` shell step runs `git diff --name-status HEAD~1 HEAD`. But if the DEV agent didn't commit its changes (just wrote files without git), the diff is empty. The fallback `find -newer` only works if the marker file exists.

**Impact:** The COMPILER agent receives an empty DIFF_MANIFEST, processes zero files, but still incurs the session setup cost (~$0.08 for the system prompt alone).

**Fix:** Check if DIFF_MANIFEST is empty before spawning the COMPILER agent. Skip compile-knowledge entirely if there's nothing to compile.

### 7. compile-sync Depends on External Script

**Problem:** `compile-sync` calls `node /home/ubuntu/scripts/graph-sync.mjs` which must exist on the EC2 instance. If the script is missing, outdated, or has dependency issues, the sync silently fails.

**Impact:** Knowledge articles get written to disk but never reach Memgraph or S3. The graph database stays empty. No error is surfaced to the user.

**Fix:** Either bundle graph-sync with the daemon deployment, or make it a npm dependency of the daemon package.

## Recommended Architecture Changes

### Short-term (configuration only)

1. Switch COMPILER model to `haiku`
2. Skip compile-knowledge when DIFF_MANIFEST is empty
3. Reduce MAX_CONCURRENT from 5 to 3

### Medium-term (code changes)

4. Move compilation from per-story to per-wave (one compile job after all wave stories complete)
5. Batch all changed files from the wave into a single DIFF_MANIFEST
6. Inline small file contents in the prompt to eliminate Read tool calls
7. Run compile-sync once per wave instead of per story

### Long-term (architecture)

8. Make compilation opt-in per epic (toggle in the epic editor UI)
9. Build a "compile dashboard" showing article counts, graph stats, and compilation history
10. Add a "recompile" button that re-runs compilation for an entire epic on demand
