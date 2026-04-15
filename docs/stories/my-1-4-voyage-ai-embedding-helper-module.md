# Story MY-1.4: Voyage AI Embedding Helper Module

Status: review

## Story

As a **developer**,
I want **a reusable module that embeds text via the Voyage AI API and returns 1024-dim vectors**,
So that **wiki articles can be embedded for vector search in Memgraph**.

## Acceptance Criteria

1. A `VOYAGE_API_KEY` environment variable is read from the EC2 instance
2. The module returns a 1024-dimensional float array from `voyage-3-large` when called with a text string
3. The module supports batch embedding (up to 128 inputs per call)
4. The module distinguishes between `document` input type (for articles) and `query` input type (for searches)
5. The module handles API errors with retries (max 3, exponential backoff)
6. The module logs token usage for cost tracking

## Tasks / Subtasks

- [x] Task 1: Create the embedding module `voyage-embed.mjs` (AC: #1, #2, #4)
  - [x] 1.1: Create `/home/ubuntu/scripts/lib/voyage-embed.mjs`
  - [x] 1.2: Read `VOYAGE_API_KEY` from `process.env` — throw descriptive error if not set
  - [x] 1.3: Implement `embedText(text, inputType = 'document')` — single text embedding
  - [x] 1.4: Call Voyage AI API: `POST https://api.voyageai.com/v1/embeddings` with model `voyage-3-large`
  - [x] 1.5: Pass `input_type` parameter (`document` for articles, `query` for search queries)
  - [x] 1.6: Parse response and return the 1024-dimensional embedding array
  - [x] 1.7: Validate that returned embedding has exactly 1024 dimensions

- [x] Task 2: Implement batch embedding (AC: #3)
  - [x] 2.1: Implement `embedBatch(texts, inputType = 'document')` — array of texts
  - [x] 2.2: Enforce maximum batch size of 128 inputs per call
  - [x] 2.3: If input exceeds 128, chunk into multiple API calls automatically
  - [x] 2.4: Return array of 1024-dim embeddings in the same order as inputs
  - [x] 2.5: Handle partial batch failures — retry failed chunks, return results for successful ones

- [x] Task 3: Implement retry logic with exponential backoff (AC: #5)
  - [x] 3.1: Wrap API calls in retry logic — max 3 attempts
  - [x] 3.2: Implement exponential backoff: 1s, 2s, 4s delays between retries
  - [x] 3.3: Retry on HTTP 429 (rate limit), 500, 502, 503, 504 status codes
  - [x] 3.4: Throw after 3 failed attempts with descriptive error including status code and response body
  - [x] 3.5: Log each retry attempt with attempt number and wait duration

- [x] Task 4: Implement cost tracking and logging (AC: #6)
  - [x] 4.1: Parse `usage.total_tokens` from API response
  - [x] 4.2: Log token usage per call to stdout: `[voyage-embed] Embedded {n} texts, {tokens} tokens, cost ~${cost}`
  - [x] 4.3: Calculate approximate cost based on $0.06 per 1M tokens for voyage-3-large
  - [x] 4.4: Maintain a session-level token counter accessible via `getUsageStats()`

- [x] Task 5: Validate module end-to-end (AC: #1, #2, #3, #4, #5, #6)
  - [x] 5.1: Test single text embedding — verify 1024 dimensions returned
  - [x] 5.2: Test batch embedding with 5 sample texts — verify 5 x 1024-dim arrays returned
  - [x] 5.3: Test `document` vs `query` input types — verify both succeed
  - [x] 5.4: Test with invalid API key — verify descriptive error
  - [x] 5.5: Test with empty string input — verify graceful handling

## Dev Notes

### Architecture Context

The Voyage AI embedding module is a foundational building block used by two key scripts in later stories:

1. **`graph-sync.mjs`** (Story 1.5) — embeds wiki articles as `document` type before upserting into Memgraph.
2. **`graph-search.mjs`** (Epic 5, Story 5.1) — embeds search queries as `query` type for vector similarity search.

The distinction between `document` and `query` input types is important for Voyage AI's asymmetric embedding model — documents and queries are embedded differently to optimize retrieval accuracy.

**Cost model:** Voyage AI voyage-3-large costs $0.06 per 1M tokens. An average wiki article is ~500 tokens. Embedding 2000 articles (full project) costs ~$0.06. Incremental re-embedding after a story compilation is 10-50 articles = ~$0.003. This is negligible, making re-embedding aggressive and worry-free.

**Batch embedding** is the primary optimization. The Voyage AI API supports up to 128 inputs per request. The `graph-sync.mjs` script in Story 1.5 will use `embedBatch()` to embed all changed articles in a single API call when possible, reducing latency from N sequential calls to ceiling(N/128) calls.

### API Specification

```javascript
// Voyage AI Embeddings API
// POST https://api.voyageai.com/v1/embeddings
// Headers: Authorization: Bearer {VOYAGE_API_KEY}, Content-Type: application/json

// Request body:
{
  "model": "voyage-3-large",
  "input": ["text to embed"],        // string or array of strings (max 128)
  "input_type": "document"           // "document" | "query"
}

// Response:
{
  "data": [
    { "embedding": [0.023, -0.117, ...], "index": 0 }   // 1024-dim
  ],
  "usage": { "total_tokens": 42 }
}
```

### Module Exports

```javascript
// voyage-embed.mjs exports:
export async function embedText(text, inputType = 'document');   // Returns: number[] (1024-dim)
export async function embedBatch(texts, inputType = 'document'); // Returns: number[][] (N x 1024-dim)
export function getUsageStats();                                  // Returns: { totalTokens, totalCost, callCount }
```

### File Locations

| File             | Path                                        | Purpose                            |
| ---------------- | ------------------------------------------- | ---------------------------------- |
| voyage-embed.mjs | `/home/ubuntu/scripts/lib/voyage-embed.mjs` | Voyage AI embedding helper module  |
| lib/ directory   | `/home/ubuntu/scripts/lib/`                 | Shared library modules for scripts |

### Prerequisites

- No dependency on Story MY-1.1 or MY-1.2 — this story can run in parallel.
- Requires `VOYAGE_API_KEY` environment variable to be set on the EC2 instance.
- No additional npm dependencies needed — uses native `fetch` (Node.js 18+ built-in).

### References

- [Source: docs/concepts/mycelium-labs-architecture.md#8.3-Voyage-AI-Integration] — API config, model selection, cost model, batch size
- [Source: docs/concepts/mycelium-labs-architecture.md#3.2-Memgraph-Schema] — embedding dimension (1024), vector index config referencing voyage-3-large
- [Source: docs/concepts/mycelium-labs-architecture.md#5.3-Search-Tool-for-Agents] — graph-search.mjs usage of `query` input type for search embeddings
- [Source: docs/concepts/mycelium-labs-architecture.md#9-Decisions-Log] — D3 (Voyage AI voyage-3-large chosen for superior code retrieval)
- [Source: docs/epics-mycelium-devs.md#Story-1.4] — epic acceptance criteria

## Change Log

| Date       | Change                  | Author          |
| ---------- | ----------------------- | --------------- |
| 2026-04-14 | Story drafted           | Richie          |
| 2026-04-14 | Implementation complete | Claude Opus 4.6 |

## Dev Agent Record

### Context Reference

- [Story Context XML](docs/stories/my-1-4-voyage-ai-embedding-helper-module.context.xml) — generated 2026-04-14

### Agent Model Used

Claude Opus 4.6

### Debug Log References

### Completion Notes List

- Created `daemon/scripts/lib/voyage-embed.mjs` — reusable Voyage AI embedding module
- Exports `embedText(text, inputType)` returning a 1024-dim float array
- Exports `embedBatch(texts, inputType)` with automatic chunking at 128 inputs per API call
- Both functions validate `inputType` is 'document' or 'query' and throw descriptive errors
- API key read from `VOYAGE_API_KEY` env var with descriptive error if missing
- Retry logic with exponential backoff: 1s, 2s, 4s delays between retries (max 3 attempts)
- Retries on HTTP 429, 500, 502, 503, 504 and network errors (ECONNRESET, ETIMEDOUT)
- Each retry attempt is logged with attempt number and wait duration
- Response embeddings sorted by index to maintain input order
- Validates returned embedding dimensions match 1024
- Cost tracking: parses `usage.total_tokens`, calculates cost at $0.06/1M tokens
- Session-level stats via `getUsageStats()` — returns `{totalTokens, totalCost, callCount}`
- `resetUsageStats()` to clear session counters between runs
- Empty strings in batch inputs are tracked and filled with zero vectors
- Uses native `fetch` (Node.js 18+) — no additional npm dependencies required

### File List

| Status | File                                  |
| ------ | ------------------------------------- |
| NEW    | `daemon/scripts/lib/voyage-embed.mjs` |

## Senior Developer Review (AI)

**Reviewer:** Claude Opus 4.6
**Date:** 2026-04-14
**Outcome:** Approve

### Findings

| #   | Severity | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | File                                          | Recommendation                                                                                                                                                                                                                                                                                                                                                                        |
| --- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Med      | The retry logic has a subtle issue: when an HTTP error response is received and `attempt < MAX_RETRIES`, the code correctly retries. But in the outer `catch` block, it re-checks retryability by string-matching on the error message (`err.message.includes('HTTP 429')`). This means the same retry decision is made twice — once in the `if (!response.ok)` block and once in the catch. The catch-block retry is for network-level errors (ECONNRESET, ETIMEDOUT), but it also catches the re-thrown HTTP errors. This could lead to a successful retry being counted twice against the attempt limit. | `daemon/scripts/lib/voyage-embed.mjs:98-161`  | In practice, this is not a bug because the `if (!response.ok)` block only continues (retries) or throws — it never falls through to the catch in the same iteration. The catch handles throws from `response.json()`, validation errors, and network failures. The logic is correct but could be clearer with a comment explaining the two retry paths.                               |
| 2   | Med      | Empty strings in `embedBatch` are replaced with zero vectors (`new Array(EMBEDDING_DIM).fill(0)`). Zero vectors have undefined cosine similarity behavior (division by zero in normalization). If these nodes end up in Memgraph, vector search results could be unpredictable.                                                                                                                                                                                                                                                                                                                             | `daemon/scripts/lib/voyage-embed.mjs:260-262` | Document that callers should filter empty strings before calling `embedBatch`, or log a warning when zero-fill occurs. The current behavior is preferable to throwing (graceful degradation), but consumers should be aware. `graph-sync.mjs` prepares embedding text via `prepareEmbeddingText()` which always produces non-empty output, so this edge case is unlikely in practice. |
| 3   | Low      | The module uses native `fetch` (Node.js 18+). The EC2 instance should be running Node 18+ since it also uses ESM `import` syntax. No compatibility concern.                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `daemon/scripts/lib/voyage-embed.mjs:89`      | No action needed.                                                                                                                                                                                                                                                                                                                                                                     |
| 4   | Low      | `getUsageStats()` correctly returns a shallow copy (`{ ...sessionStats }`) preventing external mutation of the internal counter. Good defensive pattern.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `daemon/scripts/lib/voyage-embed.mjs:284`     | No action needed.                                                                                                                                                                                                                                                                                                                                                                     |
| 5   | Low      | Constants `VOYAGE_MODEL`, `EMBEDDING_DIM`, `MAX_BATCH_SIZE` are re-exported for external use, which is good for consumers that need to validate dimensions or batch sizes.                                                                                                                                                                                                                                                                                                                                                                                                                                  | `daemon/scripts/lib/voyage-embed.mjs:295`     | No action needed — good API design.                                                                                                                                                                                                                                                                                                                                                   |

### Action Items

- [x] `VOYAGE_API_KEY` read from environment with descriptive error (AC #1)
- [x] Returns 1024-dim float array from voyage-3-large (AC #2)
- [x] Batch embedding with automatic chunking at 128 inputs (AC #3)
- [x] Distinguishes `document` and `query` input types with validation (AC #4)
- [x] Retry logic: max 3, exponential backoff 1s/2s/4s, retries on 429/5xx (AC #5)
- [x] Token usage logging with cost tracking per call and session-level stats (AC #6)
- [x] Input validation on both `embedText` and `embedBatch`
- [x] Embedding dimension validation on API response
- [x] Response sorted by index to maintain input order
- [x] No hardcoded secrets — API key from environment only

### Summary

Excellent module design. Clean ESM exports, thorough input validation, proper retry logic with exponential backoff, and cost tracking that will be valuable for monitoring Voyage AI spend. The empty-string zero-vector fill is a pragmatic choice for graceful degradation, though unlikely to be triggered given how `graph-sync.mjs` prepares embedding text. The module is well-documented with JSDoc comments and serves as a clean interface for both the sync script (document embeddings) and future search tool (query embeddings).
