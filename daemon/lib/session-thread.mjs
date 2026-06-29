// session-thread — cross-stage session reuse (development-plan §5.3).
//
// Threads a Claude session across pipeline stages via `--resume`, backed by the
// existing agent-sessions table (no new table). The reuse decision encodes the
// reviewer-independence resolution for MVP:
//   • dev → compile : SHARE the session (compile is mechanical extraction — no
//     judgment contamination; the biggest single win, ~the cache-creation tokens).
//   • dev → review  : NEVER share dev's reasoning transcript. Review warm-starts
//     the SUBSTRATE not the JUDGMENT — a fresh spawn resuming a read-only,
//     Haiku-primed "facts" session (bound-AC list + touched paths), so KV is warm
//     but the reviewer never inherits dev's conclusions.
//
// Gated by P3_SESSION_REUSE (off | dev_compile | full). `full` (which would let
// review share dev's session) stays BLOCKED on the open reviewer-independence
// question — this module refuses it for review by construction.

const SHARE_EDGES = new Set(['dev->compile', 'dev->test', 'compile->compile']);

/** Build `--resume <id>` args, or [] when there's no session to resume. */
export function resumeArgs(claudeSessionId) {
  return claudeSessionId ? ['--resume', String(claudeSessionId)] : [];
}

/**
 * Decide whether `toStage` may resume `fromStage`'s session.
 *
 * @param {{ fromStage:string, toStage:string, reuseMode:'off'|'dev_compile'|'full' }} args
 * @returns {{ share:boolean, kind:'share-session'|'facts-only'|'fresh', reason:string }}
 */
export function threadDecision({ fromStage, toStage, reuseMode = 'off' }) {
  if (reuseMode === 'off') return { share: false, kind: 'fresh', reason: 'session reuse off' };

  const edge = `${fromStage}->${toStage}`;

  // Review NEVER inherits dev's judgment — facts-only warm start regardless of mode.
  if (toStage === 'review') {
    return { share: false, kind: 'facts-only', reason: 'reviewer independence — facts-only warm start, never dev transcript' };
  }

  if (SHARE_EDGES.has(edge)) {
    return { share: true, kind: 'share-session', reason: `${edge} shares session (mechanical, no judgment contamination)` };
  }

  // `full` would broaden sharing, but only to non-review edges; review stays facts-only above.
  if (reuseMode === 'full') {
    return { share: true, kind: 'share-session', reason: `${edge} shared under full reuse` };
  }

  return { share: false, kind: 'fresh', reason: `${edge} not a share edge under ${reuseMode}` };
}

/**
 * Resolve the resume args for a stage transition. When sharing, resume the prior
 * session; when facts-only, resume the facts session id (if provided); else [].
 */
export function resolveStageResumeArgs({ fromStage, toStage, reuseMode, priorSessionId, factsSessionId }) {
  const d = threadDecision({ fromStage, toStage, reuseMode });
  if (d.kind === 'share-session') return { args: resumeArgs(priorSessionId), decision: d };
  if (d.kind === 'facts-only') return { args: resumeArgs(factsSessionId), decision: d };
  return { args: [], decision: d };
}
