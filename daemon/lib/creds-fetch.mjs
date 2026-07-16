// creds-fetch — fleet daemon Claude OAuth relay (Servers-module Task 19,
// design spec §6).
//
// Fleet daemons (Hetzner/Oracle/GCP VMs provisioned by the Servers module)
// don't have SSM access to the legacy OAuth pull, so they fetch credentials
// from the admin API instead, authenticated by their per-server enrollment
// token (`x-server-token`, NOT the operator JWT). On success the response
// body is written verbatim to the daemon's OAuth creds file with mode 0o600.
//
// Auth loss (401, token revoked) and the admin API being briefly unreachable
// (503, network error) are expected, recoverable conditions for a daemon
// that may be mid-provision or between Re-auth clicks — this function must
// NEVER throw. Callers get a boolean and decide retry cadence (boot,
// hourly-probe-failure, periodic ~6h — wired in agent-daemon.mjs).

import { writeFileSync } from 'node:fs';

/**
 * @param {object} opts
 * @param {string} opts.adminApiUrl - e.g. `https://hub.futurator.ai` (no trailing slash assumed elsewhere)
 * @param {string} opts.enrollToken - this server's enrollment token (env `ENROLL_TOKEN`)
 * @param {string} opts.credsPath - where to write the OAuth credentials JSON (env `CLAUDE_CREDENTIALS_PATH`)
 * @param {typeof fetch} [opts.fetchImpl] - injectable for tests; defaults to global fetch
 * @param {(level: string, msg: string, ctx?: object) => void} [opts.log] - injectable logger
 * @returns {Promise<boolean>} true if fresh credentials were written; false otherwise (never throws)
 */
export async function fetchAgentCredentials({
  adminApiUrl,
  enrollToken,
  credsPath,
  fetchImpl = fetch,
  log = () => {},
}) {
  try {
    const res = await fetchImpl(`${adminApiUrl}/api/servers/agent-credentials`, {
      headers: { 'x-server-token': enrollToken },
    });
    if (res.status !== 200) {
      log('warn', `[creds-fetch] agent-credentials fetch failed: HTTP ${res.status}`, {
        credsPath,
      });
      return false;
    }
    const body = await res.text();
    writeFileSync(credsPath, body, { mode: 0o600 });
    log('info', '[creds-fetch] wrote fresh agent credentials', { credsPath });
    return true;
  } catch (err) {
    log('warn', `[creds-fetch] agent-credentials fetch errored: ${err.message}`, { credsPath });
    return false;
  }
}
