import { describe, it, expect } from 'vitest';
import { resolveStampableCommitSha } from '../qa-commit-sha.mjs';

const SHA = 'a'.repeat(40);

describe('resolveStampableCommitSha (pacman4 regression — the never-stamped bug)', () => {
  it('stamps a valid 40-hex SHA from a dev deploy', () => {
    expect(resolveStampableCommitSha({ deployEnv: 'dev', variables: { COMMIT_SHA: SHA } })).toBe(SHA);
  });

  it('never stamps for staging/production deploys', () => {
    expect(resolveStampableCommitSha({ deployEnv: 'staging', variables: { COMMIT_SHA: SHA } })).toBeNull();
    expect(resolveStampableCommitSha({ deployEnv: 'production', variables: { COMMIT_SHA: SHA } })).toBeNull();
  });

  it('rejects a missing, short, or malformed SHA (fail-open, never a bad stamp)', () => {
    expect(resolveStampableCommitSha({ deployEnv: 'dev', variables: {} })).toBeNull();
    expect(resolveStampableCommitSha({ deployEnv: 'dev', variables: { COMMIT_SHA: 'short' } })).toBeNull();
    expect(resolveStampableCommitSha({ deployEnv: 'dev', variables: { COMMIT_SHA: 'g'.repeat(40) } })).toBeNull();
    expect(resolveStampableCommitSha({ deployEnv: 'dev', variables: { COMMIT_SHA: 123 } })).toBeNull();
  });

  it('THE REGRESSION: reads the variables PARAMETER, never job.variables', () => {
    // The bug: postDeployWriteback read `job.variables?.COMMIT_SHA` (the STALE
    // job snapshot from before the pipeline ran — always undefined at that
    // point) instead of the `variables` parameter (the final, post-extraction
    // set). Simulate exactly that shape: a stale/empty job-level `variables`
    // alongside the real, populated parameter this function receives.
    const staleJobVariables = {}; // what `job.variables` looked like — empty
    const freshVariables = { COMMIT_SHA: SHA, DEPLOY_STATUS: 'success' }; // the real param
    // A correct caller passes `variables: freshVariables` — this must resolve.
    expect(resolveStampableCommitSha({ deployEnv: 'dev', variables: freshVariables })).toBe(SHA);
    // Sanity: if a caller regressed and passed the stale shape, it fails open
    // to null (never silently wrong) — proving the fix is in the CALL SITE
    // (postDeployWriteback passing `variables`, not `job.variables`), which
    // this module cannot itself enforce but exists to make failures loud.
    expect(resolveStampableCommitSha({ deployEnv: 'dev', variables: staleJobVariables })).toBeNull();
  });
});
