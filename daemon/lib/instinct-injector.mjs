// instinct-injector — splice active instincts into a dev spawn (development-plan §5.5).
//
// The bridge from the instinct store to the single-source SubagentStart seam:
// resolve the instincts relevant to this story's {role, touches}, then hand them
// to subagent-start's buildInjection (which already accepts an `instincts` array).
// Same one-canonical-source → many-host-adapters shape, so instincts ride the
// exact path laziness + facts do — and reach the OpenCode plugin later for free.

import { activeInstinctTexts } from './instinct-store.mjs';
import { buildInjection, claudeCodeAppendArgs } from './subagent-start.mjs';

/**
 * Build the spawn injection text for a story, folding active instincts in with
 * laziness + facts. Returns '' when nothing applies.
 *
 * @param {{ instincts?:object[], role?:string, touches?:string[], p3Flags?:object, facts?:string }} args
 */
export function buildInjectionWithInstincts({ instincts = [], role, touches = [], p3Flags, facts } = {}) {
  const texts = activeInstinctTexts(instincts, { role, touches });
  return buildInjection({ p3Flags, facts, instincts: texts });
}

/** Claude Code adapter: the --append-system-prompt args for this story. */
export function instinctInjectionArgs(args = {}) {
  return claudeCodeAppendArgs(buildInjectionWithInstincts(args));
}
