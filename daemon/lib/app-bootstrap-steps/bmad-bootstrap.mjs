/**
 * bmad-bootstrap.mjs — Pipeline v2 / Story 1.4.3 step 5.
 *
 * Adapter that invokes the existing party-bootstrap pipeline against the new
 * App's worktree. We don't re-implement BMAD installation — we route to the
 * proven `runPartyBootstrap` so re-running is idempotent for free (its own
 * `installBmad` step already short-circuits on a healthy install).
 *
 * Skipped when:
 *   - `bmadEnabled === false` (operator opted out at App-create time), OR
 *   - the boilerplate type doesn't support BMAD (stub types).
 *
 * The adapter accepts `runPartyBootstrap` as an injected dep so the unit
 * test can mock it without spinning up the real party context. In production,
 * the daemon dispatcher calls this with the real implementation.
 *
 * @param {object}   args
 * @param {string}   args.appId
 * @param {string}   args.worktreeDir
 * @param {boolean}  args.bmadEnabled
 * @param {boolean}  args.bmadSupported
 * @param {object}   args.partyCtx       — same shape as `buildPartyCtx()`
 *                                          in agent-daemon.mjs
 * @param {function} args.runPartyBootstrap — injectable for tests
 * @param {string}   args.jobId
 * @param {function} [args.onOutput]
 */

export const APP_BOOTSTRAP_BMAD_STEP = 'bmad-bootstrap';

export async function runBmadBootstrap({
  appId,
  worktreeDir,
  bmadEnabled,
  bmadSupported,
  partyCtx,
  runPartyBootstrap,
  jobId,
  onOutput,
} = {}) {
  if (!appId) throw new Error('runBmadBootstrap: appId required');
  if (!worktreeDir) throw new Error('runBmadBootstrap: worktreeDir required');

  if (!bmadEnabled) {
    onOutput?.('stdout', 'bmad-bootstrap: skipped (bmadEnabled=false)\n');
    return { skipped: true, reason: 'bmad-disabled' };
  }
  if (!bmadSupported) {
    onOutput?.('stdout', 'bmad-bootstrap: skipped (type does not support BMAD)\n');
    return { skipped: true, reason: 'type-unsupported' };
  }
  if (typeof runPartyBootstrap !== 'function') {
    throw new Error('runBmadBootstrap: runPartyBootstrap function required');
  }

  // Synthesize a party-bootstrap-compatible "job" pointed at the new worktree.
  // The party pipeline mutates the party-projects DDB row; for app-bootstrap
  // we wrap `updateProjectState` in a no-op so we don't pollute that table.
  const bootstrapJob = {
    jobId,
    jobType: 'party-bootstrap',
    partyBootstrapPayload: {
      projectId: `app:${appId}`,
      projectPath: worktreeDir,
      forceReinstall: false,
      createFolder: false,
    },
  };

  const wrappedCtx = {
    ...partyCtx,
    updateProjectState: async () => {
      // App-bootstrap doesn't write to the party-projects table.
    },
  };

  await runPartyBootstrap(bootstrapJob, wrappedCtx);

  return { skipped: false };
}
