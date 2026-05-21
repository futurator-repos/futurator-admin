# Story 20.1: Party marker extractor (`[CHECKPOINT_SUMMARY]:` + `[ASK_HUMAN]:`)

Status: TODO

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

- [ ] Task 1: Write the extractor per the adversarial spec (AC: 1–6)
- [ ] Task 2: Write the test suite (AC: 7)
- [ ] Task 3: Confirm tests + typecheck pass (AC: 8)

## Dev Notes

- Don't use a single big regex — fenced-code-block awareness needs line-by-line iteration with a "currently inside a fence" flag. Easier to reason about + adversarial-safer.
- The extractor is pure (no side effects, no DDB). Event emission lives in the caller (`party-turn.mjs` post-round hook in Story 20.7).
- Per Free Explorer §13.4, ASK_HUMAN markers become Tier-1 entries in the unified inline-questions list (Epic 22). The extractor's job is just to recognize them; the inbox semantics ship later.
- See `plan.md` §12.2.2 for the contract sketch.
