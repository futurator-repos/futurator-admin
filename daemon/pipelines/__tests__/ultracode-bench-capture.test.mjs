import { describe, it, expect } from 'vitest';
import { splitPlanAndScript, extractScript } from '../ultracode-bench-capture.mjs';

describe('splitPlanAndScript', () => {
  it('script-only stdout (no prose) → empty planText, unchanged scriptJs', () => {
    const stdout = 'export const meta = {}\nconst x = 1;';
    expect(splitPlanAndScript(stdout)).toEqual({ planText: '', scriptJs: stdout.trim() });
  });

  it('plan prose before an unfenced script is split off', () => {
    const stdout = [
      'Here is my plan: scout the repo, then author two phases.',
      '',
      'export const meta = { agentCount: 2 };',
      'const y = 2;',
    ].join('\n');
    const { planText, scriptJs } = splitPlanAndScript(stdout);
    expect(planText).toBe('Here is my plan: scout the repo, then author two phases.');
    expect(scriptJs).toBe('export const meta = { agentCount: 2 };\nconst y = 2;');
  });

  it('fenced script: prose before the fence is the plan, fence contents are the script', () => {
    const stdout = [
      'PLAN: build-verify-fix, two phases.',
      '',
      '```js',
      'export const meta = { agentCount: 1 };',
      'const z = 3;',
      '```',
    ].join('\n');
    const { planText, scriptJs } = splitPlanAndScript(stdout);
    expect(planText).toBe('PLAN: build-verify-fix, two phases.');
    expect(scriptJs).toBe('export const meta = { agentCount: 1 };\nconst z = 3;');
  });

  it('plan text containing backticks (inline code) is preserved verbatim before the script', () => {
    const stdout = [
      'I will call `Workflow` then read `wf_<id>.json`.',
      '',
      'export const meta = {};',
    ].join('\n');
    const { planText, scriptJs } = splitPlanAndScript(stdout);
    expect(planText).toBe('I will call `Workflow` then read `wf_<id>.json`.');
    expect(scriptJs).toBe('export const meta = {};');
  });

  it('extractScript still returns scriptJs only (delegates to splitPlanAndScript)', () => {
    const stdout = 'some prose\n\nexport const meta = { a: 1 };';
    expect(extractScript(stdout)).toBe(splitPlanAndScript(stdout).scriptJs);
    expect(extractScript(stdout)).toBe('export const meta = { a: 1 };');
  });
});
