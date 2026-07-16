// server-identity — which fleet-server row THIS daemon is (Servers-module
// Task 18, design spec §5.2).
//
// Fleet daemons (Hetzner/Oracle/GCP VMs provisioned by the Servers module)
// get an explicit SERVER_ID injected by cloud-init. The two pre-existing
// daemons predate the module and only carry the legacy DAEMON_SOURCE env, so
// they map onto the seeded rows (scripts/seed-servers.mjs): ec2 →
// `srv_ec2_main`, local (and anything unrecognized — a laptop daemon with no
// env at all must never impersonate EC2) → `srv_local_mac`. PURE.

/**
 * Resolve this daemon's ComputeServer id from its environment.
 *
 * @param {Record<string, string | undefined>} env - typically `process.env`
 * @returns {string} the `futurator-servers` serverId this daemon heartbeats
 *   as, polls `assignedServerId-status-index` with, and claims jobs under.
 */
export function resolveServerId(env) {
  if (env?.SERVER_ID) return env.SERVER_ID;
  if (env?.DAEMON_SOURCE === 'ec2') return 'srv_ec2_main';
  return 'srv_local_mac';
}
