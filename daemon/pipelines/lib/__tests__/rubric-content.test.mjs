import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseRuleIds } from '../rubric-merge.mjs';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..', '..');
const defaultRubric = readFileSync(
  resolve(repoRoot, 'scripts', 'rubrics', 'default.md'),
  'utf8'
);
const overlayRubric = readFileSync(
  resolve(repoRoot, '.claude', 'review-rubric.md'),
  'utf8'
);

const CATEGORIES = ['CORR', 'CONV', 'TEST', 'MAINT', 'SEC'];

function rationaleAfter(md, ruleId) {
  const start = md.indexOf(`## ${ruleId}`);
  if (start < 0) return null;
  const nextRule = md.slice(start + 1).search(/^##\s+R-[A-Z]+-\d+/m);
  const end = nextRule < 0 ? md.length : start + 1 + nextRule;
  const block = md.slice(start, end);
  return /\*\*Rationale\*\*\s*:/i.test(block);
}

describe('scripts/rubrics/default.md', () => {
  it('covers all five rule categories', () => {
    const ids = parseRuleIds(defaultRubric);
    for (const cat of CATEGORIES) {
      expect(ids.some((id) => id.startsWith(`R-${cat}-`))).toBe(true);
    }
  });

  it('ships at least 5 rules per category', () => {
    const ids = parseRuleIds(defaultRubric);
    for (const cat of CATEGORIES) {
      const count = ids.filter((id) => id.startsWith(`R-${cat}-`)).length;
      expect(count, `category ${cat}`).toBeGreaterThanOrEqual(5);
    }
  });

  it('every rule has a Rationale line', () => {
    const ids = parseRuleIds(defaultRubric);
    for (const id of ids) {
      expect(rationaleAfter(defaultRubric, id), `${id} missing rationale`).toBe(true);
    }
  });

  it('uses the R-{CATEGORY}-{NNN} ID format exclusively', () => {
    const ids = parseRuleIds(defaultRubric);
    for (const id of ids) {
      expect(id).toMatch(/^R-(CORR|CONV|TEST|MAINT|SEC)-\d{3}$/);
    }
  });
});

describe('.claude/review-rubric.md', () => {
  it('includes the minimum rule IDs required by EO-1.4', () => {
    const ids = parseRuleIds(overlayRubric);
    const required = [
      'R-ARCH-001',
      'R-ARCH-002',
      'R-ARCH-003',
      'R-ARCH-004',
      'R-SAFE-001',
      'R-SAFE-002',
      'R-SAFE-003',
      'R-CONV-001',
      'R-TEST-001',
      'R-SEC-001',
      'R-SEC-002',
    ];
    for (const id of required) {
      expect(ids, `missing ${id}`).toContain(id);
    }
  });

  it('every overlay rule has a Rationale line', () => {
    const ids = parseRuleIds(overlayRubric);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      expect(rationaleAfter(overlayRubric, id), `${id} missing rationale`).toBe(true);
    }
  });
});
