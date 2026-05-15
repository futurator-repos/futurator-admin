/**
 * reflection-preflight.mjs — Pipeline v2 Phase 3 / Story 3-E-9-1 (PR-78).
 *
 * Pre-flight check on REFLECTOR proposals before they hit the Reflection
 * Inbox. v2.5 §39.1 baseline defense: REFLECTOR cannot propose a skill
 * whose `entrypoint` executes commands outside the allowlist
 * (npm / pnpm / uv / python / node / bash <local-script>).
 *
 * **The check does NOT block** — failed proposals still surface to the
 * operator but with a `flaggedForManualReview` badge so the friction is
 * intentional. Operator can still confirm; the visible flag prevents the
 * "rubber-stamp" failure mode where a malicious skill slips through.
 *
 * Future: REFLECTOR-REVIEWER (Story 3-E-10-1, defer-after-baseline) adds
 * a Haiku read-only second pass. That ships in addition to this baseline
 * — not as a replacement. v2.5 §39.2.
 */

const ALLOWLIST_COMMANDS = new Set([
  'npm',
  'pnpm',
  'uv',
  'python',
  'python3',
  'node',
]);

// `bash <local-script>` is allowed when the script is a local path (./
// or relative). `bash` alone or `bash -c '<cmd>'` is rejected — the
// `-c` form lets an attacker inline arbitrary commands.
const LOCAL_BASH_RE = /^bash\s+(\.\/[\w./-]+|[\w./-]+\.sh)\s*(\s+[\w./-]+)*$/;

/**
 * Inspect a single REFLECTOR proposal. Returns `{ allowed, reason }`.
 *
 * - For non-skill targets (claude-md, persona, pipeline-config, tool-
 *   wrapper): always allowed — no executable entrypoint to inspect.
 * - For skill targets without an `entrypoint`: allowed — pure-docs
 *   skills are the common case.
 * - For skill targets with an `entrypoint` outside the allowlist: not
 *   allowed (`{ allowed: false, reason: '<violation>' }`).
 *
 * @param {{
 *   target: string,
 *   action: string,
 *   content: string,
 *   skillName?: string,
 *   personaName?: string,
 *   [k: string]: unknown,
 * }} proposal
 * @returns {{ allowed: boolean, reason?: string }}
 */
export function checkProposal(proposal) {
  if (!proposal || typeof proposal !== 'object') {
    return { allowed: false, reason: 'proposal must be an object' };
  }
  if (proposal.target !== 'project-skill' && proposal.target !== 'org-skill') {
    return { allowed: true };
  }

  // Skills carry their entrypoint in the proposed `content` body as
  // either an explicit `entrypoint:` line (frontmatter / yaml) or
  // embedded inside the SKILL.md preamble. The proposal's `content` is
  // either the full SKILL.md text or the diff body that lands it.
  const entrypoint = extractEntrypoint(String(proposal.content || ''));
  if (entrypoint === null) {
    return { allowed: true };
  }
  return validateEntrypoint(entrypoint);
}

/**
 * Pull the entrypoint command string out of a proposal's content body.
 * Returns null when no entrypoint declared (pure-docs skills). Returns
 * the raw command string otherwise.
 */
export function extractEntrypoint(content) {
  // Match `entrypoint:` or `entrypoint :` at line start, with optional
  // quoting. Captures the rest of the line (trimmed).
  const m = content.match(/^entrypoint\s*:\s*(?:"([^"]+)"|'([^']+)'|([^\n#]+))/m);
  if (!m) return null;
  const raw = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  if (!raw) return null;
  return raw;
}

/**
 * Apply the allowlist to a raw entrypoint command. Pure function.
 */
export function validateEntrypoint(entrypoint) {
  const trimmed = String(entrypoint).trim();
  if (trimmed.length === 0) {
    return { allowed: true };
  }
  const head = trimmed.split(/\s+/)[0];
  if (ALLOWLIST_COMMANDS.has(head)) {
    return { allowed: true };
  }
  if (head === 'bash') {
    if (LOCAL_BASH_RE.test(trimmed)) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: 'bash entrypoint must invoke a local script (e.g. `bash ./scripts/run.sh`); inline -c form rejected',
    };
  }
  return {
    allowed: false,
    reason: `entrypoint "${head}" is outside the allowlist (npm | pnpm | uv | python | python3 | node | bash <local-script>)`,
  };
}

/**
 * Apply pre-flight to an entire REFLECTOR output's proposals. Returns
 * the proposals array with `flaggedForManualReview` + `flaggedReason`
 * set on the violators. Non-mutating — returns a new array.
 *
 * @param {Array<object>} proposals
 * @returns {Array<object & { flaggedForManualReview?: boolean, flaggedReason?: string }>}
 */
export function applyPreflight(proposals) {
  return proposals.map((p) => {
    const verdict = checkProposal(p);
    if (verdict.allowed) return { ...p };
    return {
      ...p,
      flaggedForManualReview: true,
      flaggedReason: verdict.reason,
    };
  });
}

export const ALLOWLIST_HEAD_COMMANDS = Array.from(ALLOWLIST_COMMANDS);
