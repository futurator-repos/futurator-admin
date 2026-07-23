// Single source of the AC-aware laziness ruleset, plus a thin args adapter.
// Pattern borrowed from ponytail: one builder, many host adapters. The skill
// markdown IS the source of truth — don't duplicate the text here.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SKILL = join(dirname(fileURLToPath(import.meta.url)), 'futurator-lazy-skill.md');
const MODES = new Set(['lite', 'full', 'ultra']);

/** Resolve any input to a runtime intensity. Unknown/empty/off → full. */
export function resolveMode(requested) {
  const m = String(requested || '').trim().toLowerCase();
  return MODES.has(m) ? m : 'full';
}

/** The ruleset text to append to a dev spawn's system prompt. */
export function getLazyInstructions(requested) {
  const mode = resolveMode(requested);
  const body = readFileSync(SKILL, 'utf8');
  return `LAZY DEV MODE ACTIVE — level: ${mode}. Minimum code to pass the bound AC.\n\n${body}`;
}

/** Claude Code adapter: spread into the spawn args. OpenCode gets its own adapter later. */
export function lazyArgs(requested) {
  return ['--append-system-prompt', getLazyInstructions(requested)];
}
