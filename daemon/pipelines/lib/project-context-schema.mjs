/**
 * Project context pack schema — Pipeline v2 Phase 2-A Story 2-A-2-1 (PR-33).
 *
 * Codifies the shape of the object returned by `buildStoryContextPack`
 * (story-context-pack.mjs) and consumed by `serializeStoryContextPack`. The
 * shape grew by accretion through PR-11 (PROJECT_CONTEXT default), PR-15
 * (file contents inline), and the dino-runner-1 hardening pass; v2.5 §11
 * specifies it as a typed contract.
 *
 * ── Why pure-JS, not Zod ───────────────────────────────────────────────────
 *
 * The daemon's `package.json` has no zod dependency today. Adding one for a
 * single validator is heavier than the validator itself (~80 lines of pure
 * checks). When the daemon picks up other Zod use cases (e.g. PR-44 expanded
 * `Plan.kind` validation), promote this to a Zod schema in the same PR.
 *
 * ── Where it's enforced ────────────────────────────────────────────────────
 *
 * Inside `daemon/pipelines/lib/context-pack-resolver.mjs::runAssembler`,
 * immediately after the assembler returns. On validation failure:
 *   1. Log the validation errors with the failing field paths.
 *   2. Emit `attention.context-pack-invalid` (medium severity) — daemon
 *      caller path provides the planId.
 *   3. Fall back to `stubFailure(...)` so the pipeline continues with a
 *      minimal placeholder block (same behaviour as a missing-input case).
 *
 * Strict-mode rejects unknown top-level fields. Unknown nested fields are
 * tolerated (forward-compat with future PR-15-style accretions).
 */

const STRING = 'string';
const NUMBER = 'number';
const BOOLEAN = 'boolean';
const OBJECT = 'object';

const REQUIRED_TOP_LEVEL = [
  'version',
  'planMd',
  'storySpec',
  'projectTree',
  'fileDigests',
  'recentDiffs',
  'prevWorkSummaries',
  'knowledgeIndex',
  'runCommand',
  'meta',
];

/**
 * Validate a pack object returned by `buildStoryContextPack`.
 *
 * @param {unknown} pack
 * @returns {{ ok: true } | { ok: false, errors: string[] }}
 */
export function validateProjectContextPack(pack) {
  const errors = [];

  if (pack === null || typeof pack !== OBJECT) {
    return { ok: false, errors: ['root: expected object, got ' + (pack === null ? 'null' : typeof pack)] };
  }

  for (const field of REQUIRED_TOP_LEVEL) {
    if (!(field in pack)) errors.push(`missing required field: ${field}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  // version: positive integer
  if (typeof pack.version !== NUMBER || !Number.isInteger(pack.version) || pack.version < 1) {
    errors.push('version: expected positive integer');
  }
  // planMd, projectTree, recentDiffs, knowledgeIndex, runCommand: strings
  for (const f of ['planMd', 'projectTree', 'recentDiffs', 'knowledgeIndex', 'runCommand']) {
    if (typeof pack[f] !== STRING) errors.push(`${f}: expected string`);
  }

  // storySpec: nested object with id (string) + touchPoints (string[]) + acceptanceCriteria (array)
  const spec = pack.storySpec;
  if (spec === null || typeof spec !== OBJECT) {
    errors.push('storySpec: expected object');
  } else {
    if (typeof spec.id !== STRING || spec.id.length === 0) {
      errors.push('storySpec.id: expected non-empty string');
    }
    if (typeof spec.title !== STRING) errors.push('storySpec.title: expected string');
    if (typeof spec.description !== STRING) errors.push('storySpec.description: expected string');
    if (!Array.isArray(spec.touchPoints)) {
      errors.push('storySpec.touchPoints: expected array');
    } else {
      for (let i = 0; i < spec.touchPoints.length; i++) {
        if (typeof spec.touchPoints[i] !== STRING) {
          errors.push(`storySpec.touchPoints[${i}]: expected string`);
          break;
        }
      }
    }
    if (!Array.isArray(spec.acceptanceCriteria)) {
      errors.push('storySpec.acceptanceCriteria: expected array');
    }
    if (typeof spec.hasBrowserTests !== BOOLEAN) {
      errors.push('storySpec.hasBrowserTests: expected boolean');
    }
    // wave: number | null (assembler emits null for non-numeric)
    if (spec.wave !== null && typeof spec.wave !== NUMBER) {
      errors.push('storySpec.wave: expected number or null');
    }
  }

  // fileDigests: object whose values are { sha, head, lines, truncated? }
  const digests = pack.fileDigests;
  if (digests === null || typeof digests !== OBJECT) {
    errors.push('fileDigests: expected object');
  } else {
    for (const [path, d] of Object.entries(digests)) {
      if (d === null || typeof d !== OBJECT) {
        errors.push(`fileDigests["${path}"]: expected object`);
        continue;
      }
      if (typeof d.sha !== STRING) errors.push(`fileDigests["${path}"].sha: expected string`);
      if (typeof d.head !== STRING) errors.push(`fileDigests["${path}"].head: expected string`);
      if (typeof d.lines !== NUMBER) errors.push(`fileDigests["${path}"].lines: expected number`);
      if ('truncated' in d && typeof d.truncated !== BOOLEAN) {
        errors.push(`fileDigests["${path}"].truncated: expected boolean if present`);
      }
    }
  }

  // prevWorkSummaries: array of { storyId, title, summary }
  if (!Array.isArray(pack.prevWorkSummaries)) {
    errors.push('prevWorkSummaries: expected array');
  } else {
    for (let i = 0; i < pack.prevWorkSummaries.length; i++) {
      const s = pack.prevWorkSummaries[i];
      if (s === null || typeof s !== OBJECT) {
        errors.push(`prevWorkSummaries[${i}]: expected object`);
        continue;
      }
      if (typeof s.storyId !== STRING) errors.push(`prevWorkSummaries[${i}].storyId: expected string`);
      if (typeof s.title !== STRING) errors.push(`prevWorkSummaries[${i}].title: expected string`);
      if (typeof s.summary !== STRING) errors.push(`prevWorkSummaries[${i}].summary: expected string`);
    }
  }

  // meta: { truncated[], waveStartTime, projectDir }
  const meta = pack.meta;
  if (meta === null || typeof meta !== OBJECT) {
    errors.push('meta: expected object');
  } else {
    if (!Array.isArray(meta.truncated)) {
      errors.push('meta.truncated: expected array');
    }
    // waveStartTime: ISO string or null
    if (meta.waveStartTime !== null && typeof meta.waveStartTime !== STRING) {
      errors.push('meta.waveStartTime: expected ISO string or null');
    }
    if (typeof meta.projectDir !== STRING) {
      errors.push('meta.projectDir: expected string');
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Format validation errors for an attention item body. Returns a markdown
 * bullet list capped at 10 entries.
 */
export function formatValidationErrors(errors) {
  const head = errors.slice(0, 10).map((e) => `- ${e}`).join('\n');
  const overflow = errors.length > 10 ? `\n…and ${errors.length - 10} more` : '';
  return head + overflow;
}
