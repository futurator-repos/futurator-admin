# Story 20.1: Party marker extractor (`[CHECKPOINT_SUMMARY]:` + `[ASK_HUMAN]:`)

Status: DONE (2026-05-21)

## Story

As the daemon parsing party-mode agent output,
I want a pure-function extractor that pulls `[CHECKPOINT_SUMMARY]:` (title + body) and `[ASK_HUMAN]:` (single-line question) markers out of assistant text,
so that the checkpoint composer + ASK_HUMAN event emitter have a single, deterministic, adversarial-input-safe parser to consume.

## Acceptance Criteria

1. New file `daemon/pipelines/lib/party-marker-extractor.mjs` exports:
   - `extractMarkers(assistantText: string) → { displayText: string, markers: Marker[] }`
   - `type Marker = { kind: 'CHECKPOINT_SUMMARY' | 'ASK_HUMAN'; title?: string; body?: string; lineRange: [number, number] }`
2. Recognizes `^\[(CHECKPOINT_SUMMARY|ASK_HUMAN)\]:` markers at line start (no leading whitespace allowed).
3. For `[CHECKPOINT_SUMMARY]:`, captures everything on the marker line after the colon as `title`, and following lines until a blank line OR another marker OR end of text as `body`.
4. For `[ASK_HUMAN]:`, captures the rest of the line as `title` (the question); `body` is undefined.
5. **Adversarial edge cases must be handled correctly** (test coverage at AC 7):
   - Marker inside a markdown code fence (` ``fenced```` `) → IGNORED (markers in code blocks are documentation, not instructions)
   - Marker preceded by leading whitespace → IGNORED (must be at column 0)
   - Marker repeated for the same kind → **last wins** (per `plan.md` §3.4)
   - Marker missing the colon (`[CHECKPOINT_SUMMARY] foo`) → IGNORED
   - Marker followed by zero-width Unicode or control chars in the title → sanitized via `agent-commit-composer::sanitize`
   - Multi-line CHECKPOINT_SUMMARY body separated from title by a single newline → captured
   - Mixed CHECKPOINT_SUMMARY + ASK_HUMAN in same assistant block → both extracted
6. `displayText` is the assistant text with marker lines stripped (so the UI's rendered prose doesn't show the markers).
7. **Required tests** (`daemon/pipelines/lib/__tests__/party-marker-extractor.test.mjs`):
   - Each edge case in AC 5 has at least one test
   - Happy path: title + 3-line summary → both captured, displayText is the rest
   - Empty input → `{ displayText: '', markers: [] }`
   - Input with no markers → `{ displayText: <input>, markers: [] }`
8. Typecheck baseline maintained.

## Tasks / Subtasks

- [x] Task 1: Write the extractor per the adversarial spec (AC: 1–6)
- [x] Task 2: Write the test suite (AC: 7) — 19 tests
- [x] Task 3: Confirm tests + typecheck pass (AC: 8) — 19/19 pass; typecheck baseline 79 maintained

## Implementation notes (2026-05-21)

- Module at `daemon/pipelines/lib/party-marker-extractor.mjs`, ~125 lines.
- Implementation walks line-by-line with an `insideFence` flag (per dev-note advice — adversarial-safer than one big regex). Fence regex matches both ` ``` ` and `~~~`.
- Marker regex `/^\[(CHECKPOINT_SUMMARY|ASK_HUMAN)\]:(.*)$/` enforces column-0 AND the trailing colon. Titles are post-colon text run through Story 19.5's `sanitize` (strips control + zero-width chars).
- CHECKPOINT_SUMMARY body collection: scan forward until blank line OR another marker OR fence opener OR EOF. Body lines are joined with `\n`; if empty, body is `undefined` (not empty string — distinguishes "no body provided" from "empty body").
- Last-wins dedup: walk markers backwards, keep first occurrence per kind (= LAST in source), then reverse + sort by canonical kind order (CHECKPOINT_SUMMARY before ASK_HUMAN).
- `displayText` post-processing: collapse 3+ blank lines to 2, then trim leading/trailing blank lines (so gaps between stripped markers don't leave dangling whitespace).
- 19 tests cover: happy path, empty input, no-markers input, ASK_HUMAN single-line, mixed markers, all 5 adversarial cases (fence, indent, missing-colon, last-wins, sanitize), body-terminator variants (blank/marker/fence/EOF), ASK_HUMAN with empty question, CHECKPOINT_SUMMARY with no body, non-string input rejection, displayText whitespace sanity.

## Dev Notes

- Don't use a single big regex — fenced-code-block awareness needs line-by-line iteration with a "currently inside a fence" flag. Easier to reason about + adversarial-safer.
- The extractor is pure (no side effects, no DDB). Event emission lives in the caller (`party-turn.mjs` post-round hook in Story 20.7).
- Per Free Explorer §13.4, ASK_HUMAN markers become Tier-1 entries in the unified inline-questions list (Epic 22). The extractor's job is just to recognize them; the inbox semantics ship later.
- See `plan.md` §12.2.2 for the contract sketch.
