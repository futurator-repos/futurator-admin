/**
 * Re-export the redactToken helper used by the daemon's git-clone module
 * so the runner masks PAT material in stdout/stderr/log lines with the
 * exact same logic the daemon uses.
 *
 * Single source of truth — if the daemon's redaction strategy changes,
 * the runner picks it up automatically.
 */
export { redactToken } from '../../../daemon/pipelines/lib/git-clone.mjs';
