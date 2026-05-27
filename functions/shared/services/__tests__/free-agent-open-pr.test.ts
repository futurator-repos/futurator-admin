import { describe, it, expect } from 'vitest';
import { parsePushOutput, buildPrBody } from '../free-agent-open-pr';

/**
 * 2026-05-27 PR B.d — push script output parsing + PR body templating.
 *
 * Coverage:
 *   - parsePushOutput: each exit shape from free-agent-commit-push.sh
 *   - buildPrBody: includes risk class chip, diff line counts, deep link,
 *     and reasons block formatting (with the no-reasons fallback)
 */

describe('parsePushOutput', () => {
  it('returns pushed with SHA on PUSHED line', () => {
    const out =
      'PUSHED: origin assist/applicator/12345678 @ abcd1234567890123456789012345678901234ab\nabcd1234567890123456789012345678901234ab\n';
    expect(parsePushOutput(out)).toEqual({
      kind: 'pushed',
      headSha: 'abcd1234567890123456789012345678901234ab',
    });
  });

  it('returns no-diff when the script bailed on rev-list count zero', () => {
    expect(parsePushOutput('NO_DIFF_VS_BASE: assist branch has no commits above main\n')).toEqual({
      kind: 'no-diff',
    });
  });

  it('returns secrets-hit with the pattern that triggered the scan', () => {
    expect(parsePushOutput('SECRETS_HIT: pattern=AKIA[0-9A-Z]{16}\n')).toEqual({
      kind: 'secrets-hit',
      pattern: 'AKIA[0-9A-Z]{16}',
    });
  });

  it('returns branch-mismatch with the detail', () => {
    expect(
      parsePushOutput("BRANCH_MISMATCH: HEAD is 'main', expected 'assist/applicator/12345678'"),
    ).toMatchObject({
      kind: 'branch-mismatch',
      detail: expect.stringContaining("HEAD is 'main'"),
    });
  });

  it('returns push-failed with reason + recovered SHA when commit landed locally', () => {
    const out =
      'PUSH_FAILED: AUTH_DENIED (PAT may lack contents:write or be expired)\nabcd1234567890123456789012345678901234ab\n';
    expect(parsePushOutput(out)).toEqual({
      kind: 'push-failed',
      reason: 'AUTH_DENIED',
      sha: 'abcd1234567890123456789012345678901234ab',
    });
  });

  it('returns push-failed without sha when the script didnt emit one', () => {
    expect(parsePushOutput('PUSH_FAILED: NETWORK\n')).toEqual({
      kind: 'push-failed',
      reason: 'NETWORK',
      sha: undefined,
    });
  });

  it('returns worktree-missing on the bail-out path', () => {
    expect(parsePushOutput('WORKTREE_MISSING: /home/ubuntu/...\n')).toEqual({
      kind: 'worktree-missing',
    });
  });

  it('returns unknown with truncated detail on unrecognized output', () => {
    const r = parsePushOutput('something weird happened\n');
    expect(r.kind).toBe('unknown');
    if (r.kind === 'unknown') {
      expect(r.detail).toContain('something weird');
    }
  });
});

describe('buildPrBody', () => {
  const baseArgs = {
    sessionId: 'abc12345-aaaa-bbbb-cccc-ddddeeeeffff',
    additions: 12,
    deletions: 3,
    filesChanged: 2,
    appBaseUrl: 'https://admin.futurator.ai',
  };

  it('includes the risk class chip', () => {
    const body = buildPrBody({ ...baseArgs, riskClass: 'red', riskReasons: ['touched daemon/'] });
    expect(body).toContain('`red`');
  });

  it('formats the diff summary with file count + line counts', () => {
    const body = buildPrBody({
      ...baseArgs,
      riskClass: 'yellow',
      riskReasons: ['touched functions/api/index.ts'],
    });
    expect(body).toContain('2 files, +12 / -3');
  });

  it('uses singular file when filesChanged === 1', () => {
    const body = buildPrBody({
      ...baseArgs,
      filesChanged: 1,
      riskClass: 'green',
      riskReasons: [],
    });
    expect(body).toContain('1 file,');
  });

  it('renders each reason as a bullet', () => {
    const body = buildPrBody({
      ...baseArgs,
      riskClass: 'red',
      riskReasons: ['reason A', 'reason B'],
    });
    expect(body).toContain('- reason A');
    expect(body).toContain('- reason B');
  });

  it('renders a no-reasons placeholder when reasons array is empty', () => {
    const body = buildPrBody({
      ...baseArgs,
      riskClass: 'green',
      riskReasons: [],
    });
    expect(body).toContain('no reasons recorded');
  });

  it('includes a session deep link with the encoded sessionId', () => {
    const body = buildPrBody({
      ...baseArgs,
      riskClass: 'green',
      riskReasons: [],
    });
    expect(body).toContain(
      `https://admin.futurator.ai/free-agent?session=${encodeURIComponent(baseArgs.sessionId)}`,
    );
  });

  it('uses the first 8 hex chars of sessionId as the link label', () => {
    const body = buildPrBody({
      ...baseArgs,
      riskClass: 'green',
      riskReasons: [],
    });
    expect(body).toContain('[abc12345]');
  });

  it('strips trailing slash from appBaseUrl before composing the link', () => {
    const body = buildPrBody({
      ...baseArgs,
      appBaseUrl: 'https://admin.futurator.ai/',
      riskClass: 'green',
      riskReasons: [],
    });
    expect(body).toContain(
      `https://admin.futurator.ai/free-agent?session=${encodeURIComponent(baseArgs.sessionId)}`,
    );
    expect(body).not.toContain('admin.futurator.ai//free-agent');
  });
});
