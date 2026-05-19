/**
 * prepin-default-skills.mjs — Pipeline v2 Phase 3-C Epic 2 (Story 2.2,
 * 2026-05-19).
 *
 * Pre-pins the starter's `defaultSkillLoadout` into the project's
 * `.claude/skills.manifest.yaml` between `apply-starter-augments` (which
 * creates the empty manifest scaffold per PR-71) and `npm-install`. The
 * subsequent `vendor-skills` step (Story 2.3) materializes each pinned
 * SKILL.md from the federation source into `.claude/skills/<name>/`.
 *
 * This step bypasses SKILL-SCOUT for the v1 cut (Epic 2's "quick win"
 * path). When Epic 3 ships SKILL-SCOUT T1/T2 wire-ins, that flow will
 * propose runtime additions ON TOP of the hardcoded prepin baseline.
 *
 * Idempotency: if the manifest has ANY existing skills declared (e.g. a
 * prior bootstrap pinned them, or SKILL-SCOUT later added some), this
 * step is a no-op skip. We never overwrite real skill state.
 *
 * Why placement matters: this step must run AFTER apply-starter-augments
 * (which writes the empty manifest scaffold) and BEFORE vendor-skills
 * (which reads the manifest entries and fetches the bodies). Putting it
 * before npm-install means the daemon doesn't need any npm deps at this
 * point — we use `yaml` (already on daemon's dependencies; see
 * federation-loader.mjs's import).
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseYaml, stringify as yamlStringify } from 'yaml';

const MANIFEST_REL_PATH = '.claude/skills.manifest.yaml';

/**
 * Parse a `<skill>@<source>` token into its components. Throws on malformed
 * input — the registry is trusted code and a malformed token is a bug we
 * want to catch loud (not silently skip a starter's intended loadout).
 *
 * @param {string} token
 * @returns {{ skill: string, source: string }}
 */
function parseLoadoutToken(token) {
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(`prepin: invalid loadout token (empty or non-string): ${JSON.stringify(token)}`);
  }
  const at = token.indexOf('@');
  if (at <= 0 || at === token.length - 1) {
    throw new Error(`prepin: invalid loadout token "${token}" (expected "skill@source")`);
  }
  const skill = token.slice(0, at);
  const source = token.slice(at + 1);
  // Sanity check on shape — federation source IDs and skill names are
  // lowercase-kebab. `@` is the only allowed special character.
  if (!/^[a-z0-9-]+$/.test(skill) || !/^[a-z0-9-]+$/.test(source)) {
    throw new Error(
      `prepin: invalid loadout token "${token}" (skill + source must match /^[a-z0-9-]+$/)`,
    );
  }
  return { skill, source };
}

/**
 * Run the prepin-default-skills step.
 *
 * @param {object}   args
 * @param {string}   args.worktreeDir          — absolute path to the project worktree
 * @param {string[] | null | undefined} args.defaultSkillLoadout
 *   Array of `<skill>@<source>` tokens from the starter's
 *   `BoilerplateMetadata.defaultSkillLoadout`. `null`/`undefined`/empty →
 *   step is a no-op skip.
 * @param {function} [args.onOutput]           — `(text) => void` log sink
 * @returns {Promise<{
 *   skipped: boolean,
 *   reason?: string,
 *   pinnedCount: number,
 *   pinned: Array<{ skill: string, source: string }>,
 * }>}
 */
export async function runPrepinDefaultSkills({
  worktreeDir,
  defaultSkillLoadout,
  onOutput,
}) {
  if (!worktreeDir) throw new Error('runPrepinDefaultSkills: worktreeDir required');

  const log = (msg) => {
    if (typeof onOutput === 'function') onOutput(msg + '\n');
  };

  // Stub boilerplates (sst/vite/mobile) declare null. Treat undefined +
  // empty array identically — all three skip with the same reason for
  // forensic consistency.
  if (!defaultSkillLoadout || defaultSkillLoadout.length === 0) {
    log('prepin-default-skills: no default loadout declared — skipping.');
    return { skipped: true, reason: 'no-default-loadout', pinnedCount: 0, pinned: [] };
  }

  const manifestPath = join(worktreeDir, MANIFEST_REL_PATH);
  if (!existsSync(manifestPath)) {
    // apply-starter-augments should have created the manifest already.
    // Missing means either a stub boilerplate (which we already
    // short-circuited above) or a wiring bug — bail with a recognizable
    // reason so the saga's attention-writer doesn't conflate this with a
    // real skill-sync failure.
    log(`prepin-default-skills: manifest not found at ${MANIFEST_REL_PATH} — skipping.`);
    return { skipped: true, reason: 'manifest-missing', pinnedCount: 0, pinned: [] };
  }

  let manifest;
  try {
    const raw = readFileSync(manifestPath, 'utf-8');
    manifest = parseYaml(raw);
  } catch (e) {
    throw new Error(`prepin: manifest parse failed at ${MANIFEST_REL_PATH}: ${e.message}`);
  }

  if (manifest === null || typeof manifest !== 'object') {
    throw new Error(`prepin: manifest is not an object at ${MANIFEST_REL_PATH}`);
  }

  // Idempotency: if SKILL-SCOUT or a prior prepin already populated any
  // bucket, leave the manifest alone. We never overwrite real decisions.
  const existingTotal =
    (Array.isArray(manifest.core) ? manifest.core.length : 0) +
    (Array.isArray(manifest.stack) ? manifest.stack.length : 0) +
    (Array.isArray(manifest.domain) ? manifest.domain.length : 0) +
    (Array.isArray(manifest.vendor) ? manifest.vendor.length : 0);
  if (existingTotal > 0) {
    log(
      `prepin-default-skills: manifest already has ${existingTotal} pinned skill(s) — skipping idempotent.`,
    );
    return { skipped: true, reason: 'manifest-non-empty', pinnedCount: 0, pinned: [] };
  }

  // Parse all tokens up-front so a malformed entry fails the step BEFORE
  // we touch the file. Half-written manifests are worse than no-op.
  const pinned = defaultSkillLoadout.map(parseLoadoutToken);

  // Pin into core[]. We deliberately don't try to classify by skill kind
  // (stack/domain/vendor) — that's SKILL-SCOUT's job. Default loadout
  // treats every entry as a `core` capability the project always wants.
  //
  // Version pin: `sha:HEAD` is a placeholder vendor-skills resolves to the
  // source's HEAD ref at sync time. Production rigor will replace these
  // with specific SHAs via SKILL-SCOUT T8 weekly refresh (Epic 3 follow-on).
  manifest.core = pinned.map(({ skill, source }) => ({
    source,
    skill,
    version: 'sha:HEAD',
  }));

  // Stamp provenance so forensic readers can tell prepin-pinned skills
  // apart from SKILL-SCOUT-pinned skills.
  manifest['generated-by'] = 'prepin-default-skills@v1';

  try {
    writeFileSync(manifestPath, yamlStringify(manifest), 'utf-8');
  } catch (e) {
    throw new Error(`prepin: manifest write failed at ${MANIFEST_REL_PATH}: ${e.message}`);
  }

  log(`prepin-default-skills: pinned ${pinned.length} skill(s) to core[].`);
  return { skipped: false, pinnedCount: pinned.length, pinned };
}
