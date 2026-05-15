/**
 * api-author-prompt.ts — Pipeline v2 Phase 2-A / Story 2-A-3-1 (PR-91).
 *
 * API-AUTHOR emits a frozen `.d.ts` between PM and TEST so TEST and DEV
 * agree on type names BEFORE any test or code is written. This closes
 * the brick-breaker incident class where TEST invented `destroyedIds`
 * and DEV invented `destroyedBrickIds` and the suite went red because
 * the names didn't match.
 *
 * v2.5 §15 — turn cap 2, `Write(${STORY_MODULE}/index.d.ts)` only.
 * Skipped under prototype rigor (PR-3 baseline).
 */

export interface ApiAuthorPromptArgs {
  /** Story id — surfaced for context only. */
  storyId: string;
  /** Story title. */
  storyTitle: string;
  /** Story acceptance criteria — drives the surface to declare. */
  acceptanceCriteria: string;
  /**
   * Module root the .d.ts will live under, e.g. `src/components/Game`
   * (resolves from touchPoints inference at dispatch time). The agent
   * writes EXACTLY `${moduleDir}/index.d.ts`.
   */
  moduleDir: string;
  /**
   * Existing public exports the daemon has scanned (`PROJECT_CONTEXT.
   * publicExports` from Story 2-A-2-2 / PR-42). The agent re-exports
   * compatible types from these instead of inventing new ones.
   */
  existingExports: {
    types: string[];
    constants: string[];
  };
}

export function buildApiAuthorPrompt(args: ApiAuthorPromptArgs): string {
  const existingBlock =
    args.existingExports.types.length === 0 && args.existingExports.constants.length === 0
      ? "(no existing types — this is the module's first definition)"
      : `Existing public types:  ${args.existingExports.types.join(', ') || '(none)'}
Existing constants:    ${args.existingExports.constants.join(', ') || '(none)'}`;

  return `\
You are API-AUTHOR. Your single output is a frozen TypeScript declaration
file at \`${args.moduleDir}/index.d.ts\` — the type surface TEST and DEV
will both import from.

STORY: ${args.storyId} — ${args.storyTitle}

ACCEPTANCE CRITERIA
===================
${args.acceptanceCriteria.trim()}

EXISTING TYPE SURFACE (do not invent new names where these fit)
================================================================
${existingBlock}

YOUR JOB
========
1. Read the AC. Identify the data shapes the story needs:
   - State types (the things components own)
   - Event types (the things components emit)
   - Function signatures (the things TEST will assert against)
2. Re-export existing types where they fit. Declare NEW types only when
   no existing type matches the AC's shape.
3. Write a single \`${args.moduleDir}/index.d.ts\` declaration file
   exporting every name TEST and DEV will need.
4. Use TypeScript discriminated unions for action/event shapes when the
   AC implies "the X happens when condition Y" — discriminated unions
   are TEST-friendly and DEV-friendly.

YOU MUST NOT
============
- Write any other file (the daemon's allowlist enforces this).
- Write implementation code. \`.d.ts\` is type-only by design.
- Invent names that conflict with existing exports.
- Skip naming a shape the AC implies. If you can't decide, declare the
  type with the most natural name and emit a comment block explaining
  the ambiguity — DEV will refine if needed.

OUTPUT
======
Write the file directly. The daemon's frozen-file gate will SHA-256 the
result; TEST and DEV import names from this file and tamper-check
(Story 2-A-5) rejects any attempt to mutate it.

No prose output. No \`---\` markers. Just the .d.ts content via the
Write tool.
`;
}
