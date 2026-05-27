/**
 * skill-proposal-validator.mjs — Pipeline v2 Phase 3-C Epic 3 (Story
 * 3.1, 2026-05-20).
 *
 * Hand-rolled shape validator that mirrors
 * `functions/shared/pipelines/skill-scout-pipeline.ts::SkillScoutOutputSchema`
 * (Zod). The daemon is pure mjs and can't consume Zod types directly,
 * so we keep a daemon-side mirror — same pattern used by PR-32b
 * (RolePolicy) and PR-69 (federation-loader).
 *
 * Returns `{ ok: true, output }` on success, `{ ok: false, error }`
 * with a Zod-style `path: msg` string otherwise.
 *
 * **Keep in sync** with `SkillProposalSchema` + `SkillScoutOutputSchema`
 * in the TS module. The TS-side test (`skill-scout-pipeline.test.ts`)
 * is the canonical contract.
 */

const VALID_TRIGGERS = new Set(['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8']);
const VALID_KINDS = new Set(['add', 'remove', 'upgrade']);
const VALID_BUCKETS = new Set(['core', 'stack', 'domain', 'vendor']);
const VERSION_RE = /^(sha:[a-f0-9]{40}|tag:[A-Za-z0-9.+\-_]+)$/;

function fail(path, msg) {
  return { ok: false, error: `${path}: ${msg}` };
}

function validateProposal(p, idx) {
  const prefix = `proposals.${idx}`;
  if (!p || typeof p !== 'object' || Array.isArray(p)) {
    return fail(prefix, 'must be an object');
  }
  if (!VALID_KINDS.has(p.kind)) {
    return fail(`${prefix}.kind`, `must be one of: add | remove | upgrade`);
  }
  if (typeof p.source !== 'string' || p.source.length === 0) {
    return fail(`${prefix}.source`, 'must be non-empty string');
  }
  if (typeof p.skill !== 'string' || p.skill.length === 0) {
    return fail(`${prefix}.skill`, 'must be non-empty string');
  }
  if (!VALID_BUCKETS.has(p.manifestBucket)) {
    return fail(
      `${prefix}.manifestBucket`,
      'must be one of: core | stack | domain | vendor',
    );
  }
  if (typeof p.version !== 'string' || !VERSION_RE.test(p.version)) {
    return fail(
      `${prefix}.version`,
      'must match sha:<40-char-hex> or tag:<version>',
    );
  }
  if (typeof p.rationale !== 'string' || p.rationale.length === 0) {
    return fail(`${prefix}.rationale`, 'must be non-empty string');
  }
  if (typeof p.verifyNotes !== 'string' || p.verifyNotes.length === 0) {
    return fail(`${prefix}.verifyNotes`, 'must be non-empty string');
  }
  if (typeof p.confidence !== 'number' || p.confidence < 0 || p.confidence > 1) {
    return fail(`${prefix}.confidence`, 'must be number in [0, 1]');
  }
  return { ok: true };
}

/**
 * Strip the daemon's between-extractor framing to the bare JSON object.
 *
 * The daemon's `between` extractor (agent-daemon.mjs::runExtractors) slices
 * `[startDelimiter .. endDelimiter]` INCLUSIVE — so the captured value is
 * `---SKILL_PROPOSALS---\n{...}\n---END_SKILL_PROPOSALS---`, not the bare
 * `{...}`. `JSON.parse` then chokes on the leading `---` ("No number after
 * minus sign at position 1" — the brick-breaker-11 SKILL-SCOUT failure).
 *
 * Rather than change the shared extractor (WORK_SUMMARY / REVIEW_CRITERIA
 * consumers rely on the inclusive behaviour), we make the SKILL-SCOUT
 * validator delimiter-tolerant: extract the outermost `{ … }` object. This
 * also absorbs any prose the agent wrapped around the block.
 *
 * @param {string} raw
 * @returns {string} the JSON-object substring, or the trimmed input if no braces found
 */
export function stripToJsonObject(raw) {
  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
    return raw.trim();
  }
  return raw.slice(firstBrace, lastBrace + 1);
}

/**
 * Validate a SKILL-SCOUT between-marker payload.
 *
 * @param {string} raw  — raw text captured by the daemon's `between` extractor
 *                        (includes the `---SKILL_PROPOSALS---` delimiters)
 * @returns {{ ok: true, output: object } | { ok: false, error: string }}
 */
export function validateSkillProposalsBlock(raw) {
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return fail('<root>', 'raw payload is empty');
  }
  // Tolerate the between-extractor's inclusive delimiter framing.
  const jsonText = stripToJsonObject(raw);
  if (!jsonText.startsWith('{')) {
    return fail('<root>', 'no JSON object found between delimiters');
  }
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (e) {
    return fail('<root>', `JSON parse failed: ${e.message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fail('<root>', 'must be an object');
  }
  if (!VALID_TRIGGERS.has(parsed.trigger)) {
    return fail('trigger', `must be one of: ${[...VALID_TRIGGERS].join(' | ')}`);
  }
  if (typeof parsed.projectSlug !== 'string' || parsed.projectSlug.length === 0) {
    return fail('projectSlug', 'must be non-empty string');
  }
  if (!Array.isArray(parsed.proposals)) {
    return fail('proposals', 'must be an array');
  }
  for (let i = 0; i < parsed.proposals.length; i++) {
    const r = validateProposal(parsed.proposals[i], i);
    if (!r.ok) return r;
  }
  return { ok: true, output: parsed };
}
