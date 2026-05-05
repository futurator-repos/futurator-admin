/**
 * App/Plan v1 — PM-augmentation parser (Epic 4, Story 4.2).
 *
 * Parses the `---PM_AUGMENTATION_RESULT--- … ---END_PM_AUGMENTATION_RESULT---`
 * block emitted by the PM agent in augmentation mode. Output is YAML inside
 * the markers (mirrors the REVIEW_CRITERIA pattern from Epic C).
 *
 * Three failure modes — each routed back through the existing self-correction
 * pipeline (see `docs/concepts/pipelinev1-self-corrections-escalation.md`):
 *
 *   1. `pm_augmentation_result_block_missing` — wrapper tags absent
 *   2. `pm_augmentation_yaml_invalid`        — YAML inside tags fails to parse
 *   3. `pm_augmentation_schema_invalid`      — parsed YAML fails Zod validation
 *
 * Up to 2 retries with the parse error echoed in a reminder; after that, the
 * daemon escalates via the existing salvage path.
 */

import { parse as parseYaml } from 'yaml';

export const PM_AUGMENTATION_BLOCK_START = '---PM_AUGMENTATION_RESULT---';
export const PM_AUGMENTATION_BLOCK_END = '---END_PM_AUGMENTATION_RESULT---';

/**
 * Extractor entry the daemon merges into the PM-augmentation step's
 * `extractors` map. Captures the whole block (including markers) so the
 * parser below can re-validate envelope presence.
 */
export const PM_AUGMENTATION_EXTRACTOR = Object.freeze({
  type: 'between',
  startDelimiter: PM_AUGMENTATION_BLOCK_START,
  endDelimiter: PM_AUGMENTATION_BLOCK_END,
});

export class PmAugmentationParseError extends Error {
  constructor(code, details = {}) {
    super(`pm_augmentation_parse: ${code}`);
    this.name = 'PmAugmentationParseError';
    this.code = code;
    this.details = details;
  }
}

const ALLOWED_KINDS = new Set(['change', 'experiment', 'CLARIFICATION_NEEDED']);

/**
 * Parse a raw agent output and return the structured PM-augmentation result.
 * Throws PmAugmentationParseError on each of the three failure modes.
 *
 * @param {string} rawOutput  — full agent stdout/last-message content
 * @returns {{
 *   kind: 'change' | 'experiment' | 'CLARIFICATION_NEEDED',
 *   kind_confidence: number,
 *   iteration_label?: string,
 *   intent_restated?: string,
 *   reasoning?: string,
 *   no_touch_paths: string[],
 *   epics: Array<{ id: string, title: string, description?: string, stories: Array<{...}> }>,
 *   epic_dependencies?: Record<string, string[]>,
 *   notes_for_dev?: string,
 *   clarification_needed?: { question: string },
 * }}
 */
export function parsePmAugmentationResult(rawOutput) {
  if (typeof rawOutput !== 'string') {
    throw new PmAugmentationParseError('pm_augmentation_result_block_missing', {
      reason: 'agent output is not a string',
    });
  }

  const startIdx = rawOutput.indexOf(PM_AUGMENTATION_BLOCK_START);
  const endIdx = rawOutput.indexOf(PM_AUGMENTATION_BLOCK_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    throw new PmAugmentationParseError('pm_augmentation_result_block_missing', {
      reason: 'PM_AUGMENTATION_RESULT wrapper tags not found',
    });
  }

  const yamlBody = rawOutput
    .slice(startIdx + PM_AUGMENTATION_BLOCK_START.length, endIdx)
    .trim();

  let parsed;
  try {
    parsed = parseYaml(yamlBody);
  } catch (e) {
    throw new PmAugmentationParseError('pm_augmentation_yaml_invalid', {
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PmAugmentationParseError('pm_augmentation_schema_invalid', {
      reason: 'top-level YAML must be an object',
    });
  }

  // Schema validation — keep it minimal and explicit so error messages are useful.
  const issues = [];

  if (!parsed.kind || !ALLOWED_KINDS.has(parsed.kind)) {
    issues.push({
      path: 'kind',
      message: `kind must be one of: ${Array.from(ALLOWED_KINDS).join(', ')}; got "${parsed.kind}"`,
    });
  }

  if (parsed.kind === 'CLARIFICATION_NEEDED') {
    if (
      !parsed.clarification_needed ||
      typeof parsed.clarification_needed.question !== 'string' ||
      parsed.clarification_needed.question.trim().length === 0
    ) {
      issues.push({
        path: 'clarification_needed.question',
        message: 'CLARIFICATION_NEEDED requires a non-empty `clarification_needed.question`',
      });
    }
  } else {
    // For change/experiment kinds, validate the full plan shape.
    if (
      typeof parsed.kind_confidence !== 'number' ||
      parsed.kind_confidence < 0 ||
      parsed.kind_confidence > 1
    ) {
      issues.push({
        path: 'kind_confidence',
        message: 'kind_confidence must be a number in [0, 1]',
      });
    }

    if (!Array.isArray(parsed.no_touch_paths)) {
      issues.push({
        path: 'no_touch_paths',
        message: 'no_touch_paths must be an array of strings (may be empty)',
      });
    } else if (parsed.no_touch_paths.some((p) => typeof p !== 'string')) {
      issues.push({
        path: 'no_touch_paths',
        message: 'no_touch_paths entries must all be strings',
      });
    }

    if (!Array.isArray(parsed.epics) || parsed.epics.length === 0) {
      issues.push({
        path: 'epics',
        message: 'epics must be a non-empty array',
      });
    } else {
      parsed.epics.forEach((epic, ei) => {
        if (!epic || typeof epic !== 'object') {
          issues.push({ path: `epics[${ei}]`, message: 'epic must be an object' });
          return;
        }
        if (!epic.id || typeof epic.id !== 'string') {
          issues.push({ path: `epics[${ei}].id`, message: 'epic.id required' });
        }
        if (!epic.title || typeof epic.title !== 'string') {
          issues.push({ path: `epics[${ei}].title`, message: 'epic.title required' });
        }
        if (!Array.isArray(epic.stories) || epic.stories.length === 0) {
          issues.push({
            path: `epics[${ei}].stories`,
            message: 'epic.stories must be a non-empty array',
          });
        } else {
          epic.stories.forEach((s, si) => {
            if (!s || typeof s !== 'object') {
              issues.push({ path: `epics[${ei}].stories[${si}]`, message: 'story must be an object' });
              return;
            }
            if (!s.id) issues.push({ path: `epics[${ei}].stories[${si}].id`, message: 'id required' });
            if (!s.title) issues.push({ path: `epics[${ei}].stories[${si}].title`, message: 'title required' });
            if (!Array.isArray(s.acceptance_criteria) || s.acceptance_criteria.length === 0) {
              issues.push({
                path: `epics[${ei}].stories[${si}].acceptance_criteria`,
                message: 'acceptance_criteria must be a non-empty array',
              });
            }
          });
        }
      });
    }
  }

  if (issues.length > 0) {
    throw new PmAugmentationParseError('pm_augmentation_schema_invalid', { issues });
  }

  return parsed;
}
