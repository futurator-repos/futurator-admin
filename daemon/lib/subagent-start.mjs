// subagent-start — the single seam through which injected guidance reaches the
// agents that actually write code (development-plan §5.3).
//
// ponytail's "one canonical source → many host adapters" pattern. There is ONE
// builder of injected system-prompt content; every harness gets a thin adapter
// off it. Today the content is the AC-aware laziness ruleset; Phase 3 folds in a
// facts pack (touched paths + bound ACs) and Phase 4 the active instincts. The
// builder is the place those compose, so call sites never re-assemble injection
// text and the OpenCode plugin later reads the same source.
//
// Adapters:
//   • claudeCodeAppendArgs(injection) → ['--append-system-prompt', text]  (the
//     spawn-args path used by epic-dev-pipeline today)
//   • (later) subagentStartHook(injection), openCodePlugin(injection)
//
// Off-by-default: when P3_LAZY_MODE is off and there's nothing else to inject,
// build() returns '' and the adapter returns [] — legacy spawn unchanged.

import { getLazyInstructions } from './inject-lazy.mjs';
import { flagMode } from './pipeline-flags.mjs';

/**
 * Build the combined injection text from all active sources. PURE.
 *
 * @param {{
 *   p3Flags?: Record<string,string>,
 *   facts?: string,           // Phase 3: facts pack (paths + bound ACs)
 *   instincts?: string[],     // Phase 4: active instincts for {role,touches}
 * }} opts
 * @returns {string} the system-prompt addendum ('' when nothing is active)
 */
export function buildInjection(opts = {}) {
  const blocks = [];

  const lazyMode = flagMode(opts.p3Flags, 'P3_LAZY_MODE'); // off | lite | full | ultra
  if (lazyMode && lazyMode !== 'off') {
    blocks.push(getLazyInstructions(lazyMode));
  }

  if (opts.facts && String(opts.facts).trim()) {
    blocks.push(`STORY FACTS\n\n${String(opts.facts).trim()}`);
  }

  const instincts = (opts.instincts || []).filter(Boolean);
  if (instincts.length) {
    blocks.push(`ACTIVE INSTINCTS (learned constraints for this scope)\n\n- ${instincts.join('\n- ')}`);
  }

  return blocks.join('\n\n---\n\n');
}

/** Claude Code adapter: spawn args. [] when there's nothing to inject. */
export function claudeCodeAppendArgs(injection) {
  const text = typeof injection === 'string' ? injection : buildInjection(injection);
  return text ? ['--append-system-prompt', text] : [];
}

/**
 * Convenience used at the spawn site: build from flags+context and return the
 * Claude Code append args in one call.
 */
export function buildSubagentInjectionArgs(opts = {}) {
  return claudeCodeAppendArgs(buildInjection(opts));
}
