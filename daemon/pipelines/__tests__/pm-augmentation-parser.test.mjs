import { describe, it, expect } from 'vitest';
import {
  parsePmAugmentationResult,
  PmAugmentationParseError,
  PM_AUGMENTATION_BLOCK_START,
  PM_AUGMENTATION_BLOCK_END,
} from '../lib/pm-augmentation-parser.mjs';

function wrap(yamlBody) {
  return `${PM_AUGMENTATION_BLOCK_START}\n${yamlBody}\n${PM_AUGMENTATION_BLOCK_END}`;
}

const VALID_BODY = `
kind: change
kind_confidence: 0.9
iteration_label: "v1.1 — mobile pass"
intent_restated: |
  Make dino3 playable on mobile devices.
reasoning: |
  Plan #1 AC scoped desktop only.
no_touch_paths:
  - "src/game/physics.ts"
  - "src/game/sprites/**"
epics:
  - id: e1
    title: "Mobile responsiveness pass"
    description: |
      Add touch input + responsive layout.
    stories:
      - id: e1s1
        title: "Replace keyboard input with touch handlers"
        description: |
          Add touch listeners alongside existing keyboard.
        acceptance_criteria:
          - "Tap on left half triggers move-left"
          - "Existing keyboard input continues to work"
        depends_on: []
notes_for_dev: |
  Wire all input through src/game/input.ts.
`;

describe('parsePmAugmentationResult — happy path', () => {
  it('parses a valid block', () => {
    const result = parsePmAugmentationResult(wrap(VALID_BODY));
    expect(result.kind).toBe('change');
    expect(result.kind_confidence).toBe(0.9);
    expect(result.iteration_label).toBe('v1.1 — mobile pass');
    expect(result.no_touch_paths).toEqual([
      'src/game/physics.ts',
      'src/game/sprites/**',
    ]);
    expect(result.epics).toHaveLength(1);
    expect(result.epics[0].stories).toHaveLength(1);
    expect(result.epics[0].stories[0].acceptance_criteria).toHaveLength(2);
  });

  it('parses a CLARIFICATION_NEEDED response', () => {
    const body = `
kind: CLARIFICATION_NEEDED
clarification_needed:
  question: "Do you mean mobile-only or both mobile and desktop?"
`;
    const result = parsePmAugmentationResult(wrap(body));
    expect(result.kind).toBe('CLARIFICATION_NEEDED');
    expect(result.clarification_needed.question).toContain('mobile-only');
  });
});

describe('parsePmAugmentationResult — failure modes', () => {
  it('throws pm_augmentation_result_block_missing when wrapper tags absent', () => {
    expect(() => parsePmAugmentationResult('just some prose, no tags')).toThrow(
      PmAugmentationParseError,
    );
    try {
      parsePmAugmentationResult('just some prose, no tags');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_result_block_missing');
    }
  });

  it('throws pm_augmentation_result_block_missing when only start tag is present', () => {
    expect(() =>
      parsePmAugmentationResult(`${PM_AUGMENTATION_BLOCK_START}\nkind: change`),
    ).toThrow(PmAugmentationParseError);
  });

  it('throws pm_augmentation_yaml_invalid on malformed YAML', () => {
    const malformed = wrap('kind: change\n  : ::: invalid yaml here');
    try {
      parsePmAugmentationResult(malformed);
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_yaml_invalid');
      expect(e.details.cause).toBeTruthy();
    }
  });

  it('throws pm_augmentation_schema_invalid on missing kind', () => {
    const body = `kind_confidence: 0.5\nepics: []`;
    try {
      parsePmAugmentationResult(wrap(body));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_schema_invalid');
      expect(e.details.issues.some((i) => i.path === 'kind')).toBe(true);
    }
  });

  it('throws pm_augmentation_schema_invalid on unknown kind', () => {
    const body = `
kind: refinement
kind_confidence: 0.9
no_touch_paths: []
epics:
  - id: e1
    title: x
    stories:
      - id: s1
        title: y
        acceptance_criteria: ["a"]
`;
    try {
      parsePmAugmentationResult(wrap(body));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_schema_invalid');
      expect(e.details.issues[0].path).toBe('kind');
    }
  });

  it('throws when CLARIFICATION_NEEDED has no question', () => {
    const body = `kind: CLARIFICATION_NEEDED`;
    try {
      parsePmAugmentationResult(wrap(body));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_schema_invalid');
      expect(e.details.issues[0].path).toBe('clarification_needed.question');
    }
  });

  it('throws when no_touch_paths is not an array', () => {
    const body = `
kind: change
kind_confidence: 0.9
no_touch_paths: "not an array"
epics:
  - id: e1
    title: x
    stories:
      - id: s1
        title: y
        acceptance_criteria: ["a"]
`;
    try {
      parsePmAugmentationResult(wrap(body));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_schema_invalid');
    }
  });

  it('throws when epics array is empty', () => {
    const body = `
kind: change
kind_confidence: 0.9
no_touch_paths: []
epics: []
`;
    try {
      parsePmAugmentationResult(wrap(body));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_schema_invalid');
      expect(e.details.issues.some((i) => i.path === 'epics')).toBe(true);
    }
  });

  it('throws when story has no acceptance criteria', () => {
    const body = `
kind: change
kind_confidence: 0.9
no_touch_paths: []
epics:
  - id: e1
    title: x
    stories:
      - id: s1
        title: y
        acceptance_criteria: []
`;
    try {
      parsePmAugmentationResult(wrap(body));
      throw new Error('should have thrown');
    } catch (e) {
      expect(e.code).toBe('pm_augmentation_schema_invalid');
      expect(
        e.details.issues.some((i) =>
          i.path.includes('acceptance_criteria'),
        ),
      ).toBe(true);
    }
  });

  it('rejects non-string raw input', () => {
    expect(() => parsePmAugmentationResult(null)).toThrow(PmAugmentationParseError);
    expect(() => parsePmAugmentationResult(123)).toThrow(PmAugmentationParseError);
  });
});
