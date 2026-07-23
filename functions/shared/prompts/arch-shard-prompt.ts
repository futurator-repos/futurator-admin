/**
 * Agentic Document Center (E3.3) — the subsystem-SHARD prompt (Architect /
 * Winston persona, sharded).
 *
 * Where `arch-gen-prompt.ts` produces a whole-project `architecture.md` in one
 * shot, this builder produces ONE shard of a god doc: a tight, citable summary
 * of a single SUBSYSTEM (module boundary, e.g. `src/auth`). The god doc is the
 * assembled projection of all shards (`doc-assembler.mjs`); each shard is keyed
 * by its `§sys:<path>` shardKey and GOVERNS its member code nodes.
 *
 * Load-bearing input discipline: the shard is synthesized STRICTLY from the
 * member files' existing knowledge articles (`knowledge/code/<slug>.md`,
 * compiled by the wave compiler) — NOT from re-reading source. Re-reading source
 * is forbidden (it is slow, it re-derives what the compiler already distilled,
 * and it defeats the "documents are graph-grounded" thesis). The articles are
 * inlined into the prompt by the daemon (the `{{MEMBER_ARTICLES}}` placeholder,
 * filled at run time like `{{PRIOR_ARTIFACTS}}`).
 *
 * Output is ATX-sectioned and fenced with delimiters the daemon parser keys on:
 *   ---ARCH_SHARD_MD--- … ---END_ARCH_SHARD_MD---
 * (mirroring the `---ARCHITECTURE_MD---` / `---END_ARCHITECTURE_MD---` contract;
 * a typo'd delimiter silently yields an undefined variable, so the
 * pipeline/prompt fence-parity test is mandatory.)
 */

/** Fenced-output delimiters — MUST match the pipeline extractor byte-for-byte. */
export const ARCH_SHARD_START_DELIMITER = '---ARCH_SHARD_MD---';
export const ARCH_SHARD_END_DELIMITER = '---END_ARCH_SHARD_MD---';

export interface ArchShardPromptArgs {
  /** The subsystem's shardKey — e.g. `§sys:src--auth`. */
  shardKey: string;
  /** Human boundary path — e.g. `src/auth`. Rendered as the shard's identity. */
  boundary: string;
  /** Member code nodeIds in this subsystem (e.g. `code/src--auth--login.ts`). */
  members: string[];
  /** Other subsystems this one depends on (their shardKeys) — for the boundary section. */
  depends?: string[];
  /**
   * Inlined member knowledge articles (the daemon fills `{{MEMBER_ARTICLES}}`
   * from `knowledge/code/*.md`). When omitted at build time the placeholder is
   * left in for daemon substitution (the same `.ts`/daemon seam as priorArtifacts).
   */
  memberArticles?: string;
}

/** Daemon-substituted placeholder for the inlined member articles. */
export const MEMBER_ARTICLES_PLACEHOLDER = '{{MEMBER_ARTICLES}}';

export function buildArchShardPrompt(args: ArchShardPromptArgs): string {
  const memberList = (args.members || []).map((m) => `- ${m}`).join('\n') || '- (none)';
  const dependsList =
    args.depends && args.depends.length > 0
      ? args.depends.map((d) => `- ${d}`).join('\n')
      : '- (no cross-subsystem dependencies)';
  const articles = args.memberArticles ?? MEMBER_ARTICLES_PLACEHOLDER;

  return `You are the Architect (Winston), documenting ONE subsystem of a larger
codebase. Produce a single SHARD of the architecture god doc: a tight, citable
summary of the \`${args.boundary}\` subsystem (shard key \`${args.shardKey}\`).
The shard is later assembled with every other subsystem's shard into one god
document, so keep it self-contained and scoped to THIS subsystem only.

## Execution discipline (READ FIRST — it keeps you fast and honest)
- ONE-SHOT generation, not an interactive task. Do NOT use TodoWrite and do NOT
  call ToolSearch — each attempt wastes a full model round-trip.
- Synthesize STRICTLY from the member knowledge articles inlined below. Do NOT
  re-Read the source files, do NOT Glob/find/Bash — the articles are the
  compiler's distilled, current truth and re-reading source is forbidden (it is
  slow and re-derives what is already known).
- Do not greet or narrate. Your FIRST action is emitting the document between the
  fences.

## Subsystem identity
- Boundary: \`${args.boundary}\`
- Shard key: \`${args.shardKey}\`
- Member files (this shard GOVERNS these):
${memberList}
- Depends on (other subsystems):
${dependsList}

## Member knowledge articles (your ONLY source — synthesize from these)
${articles}

## Length budget — HARD
This shard is concatenated with every other subsystem's shard into the god doc,
which is inlined into downstream context. Keep the WHOLE shard under **~600
words**. Prefer terse one-line rules and small tables over paragraphs. No code
samples longer than ~5 lines.

## Rules
- Use ATX headings (\`## Section Title\`) for every section — each becomes a
  citable section id in the shard's own manifest.
- Required sections (in order):
  1. \`## Responsibility\` — one paragraph: what this subsystem is for, in one
     breath. The fastest thing another shard can cite.
  2. \`## Key Modules\` — a terse table (module · role) drawn from the member
     articles. One row per member file that earns it; omit trivial files.
  3. \`## Interfaces\` — what this subsystem exposes to others and what it
     consumes from the subsystems it depends on (name the boundary, not internals).
  4. \`## Invariants\` — the rules a change inside this subsystem must uphold
     (the anti-drift surface for THIS boundary).
- Stay inside the boundary: do NOT document other subsystems' internals; refer to
  them by their boundary name only.
- No prose hand-waving: every line must be something a story can cite and a
  reviewer can check against the member articles.

## Output — between the fences, the full markdown shard, nothing else.
${ARCH_SHARD_START_DELIMITER}
# ${args.boundary}

## Responsibility
<one-paragraph statement of this subsystem's purpose>

## Key Modules
| Module | Role |
| --- | --- |
| <member> | <role> |

## Interfaces
<what it exposes / consumes>

## Invariants
<the rules a change here must uphold>
${ARCH_SHARD_END_DELIMITER}`;
}
