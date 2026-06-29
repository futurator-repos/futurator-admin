// system-prompt-split — static/dynamic prompt split for KV-cache reuse
// (development-plan §5.3). jcode's move.
//
// Anthropic's prompt cache rewards a STABLE prefix. The orchestrator/dev prompt
// today mixes invariant content (role rules, conventions, the lazy skill) with
// per-story content (this story's ACs, touched paths) in one -p blob, so the
// cache prefix changes every spawn and the ~27k-token cacheable prefix is re-paid.
// The fix: route the invariant block to --append-system-prompt (cacheable across
// spawns of the same role) and keep only the per-story delta in -p.
//
// PURE. The caller assembles the two halves; this just builds the args.

/**
 * @param {{ staticPrompt?: string, dynamicPrompt?: string }} parts
 * @returns {{ args: string[], promptArg: string|null }}
 *   args: the --append-system-prompt pair (or []) — splice BEFORE the -p prompt.
 */
export function splitSystemPrompt({ staticPrompt, dynamicPrompt } = {}) {
  const stat = (staticPrompt || '').trim();
  const dyn = (dynamicPrompt || '').trim();
  const args = stat ? ['--append-system-prompt', stat] : [];
  return { args, promptArg: dyn || null };
}

/**
 * Convenience: given the already-assembled full prompt and a marker, split at the
 * marker so callers can migrate incrementally. The text BEFORE the marker is the
 * cacheable static block; AFTER is the dynamic delta. When the marker is absent,
 * the whole thing stays dynamic (no behavior change — safe default).
 */
export function splitAtMarker(fullPrompt, marker = '<<<STORY>>>') {
  const text = String(fullPrompt || '');
  const idx = text.indexOf(marker);
  if (idx === -1) return splitSystemPrompt({ dynamicPrompt: text });
  return splitSystemPrompt({
    staticPrompt: text.slice(0, idx),
    dynamicPrompt: text.slice(idx + marker.length),
  });
}
