import type { ComputeServer } from '@/types/servers';
import { heartbeatState } from '@/hooks/use-servers';

/**
 * Servers module — the state a card actually shows.
 *
 * `server.status` records the PROVISIONING LIFECYCLE, not liveness. Showing it
 * raw made cards read "ACTIVE" beside "last seen never" — srv_ec2_main claimed
 * ACTIVE for an instance that does not exist in the account at all. The
 * dispatcher was never fooled (it filters on heartbeat freshness); only the UI
 * was. So the badge is derived the same way the dispatcher decides: lifecycle
 * first, then liveness.
 */

export type ServerTone = 'success' | 'warning' | 'destructive' | 'muted';

export interface DerivedServerState {
  label: string;
  tone: ServerTone;
  /** Tooltip: what this state means and what happens next. */
  help: string;
}

export function deriveServerState(server: ComputeServer, now: number): DerivedServerState {
  switch (server.status) {
    case 'PROVISIONING':
      return {
        label: 'PROVISIONING',
        tone: 'warning',
        help: 'Asked the provider for the machine. Waiting for it to report running — usually under a minute.',
      };
    case 'BOOTSTRAPPING':
      return {
        label: 'BOOTSTRAPPING',
        tone: 'warning',
        help: 'The machine is running and installing itself: node, the Claude CLI, the daemon bundle, then its credentials. It becomes ACTIVE the moment its daemon first reports in. Stuck here for more than ~5 minutes means the setup script failed — check Actions → Retry, or destroy and re-add.',
      };
    case 'ERROR':
      return {
        label: 'ERROR',
        tone: 'destructive',
        help:
          server.statusMessage ||
          'Provisioning failed. No machine is billing; Retry mints fresh credentials and tries again.',
      };
    case 'PAUSED':
      return {
        label: 'PAUSED',
        tone: 'muted',
        help: 'Stopped at the provider — compute billing is paused. Enable it to start the machine again.',
      };
    case 'DEPROVISIONING':
      return {
        label: 'DESTROYING',
        tone: 'warning',
        help: 'Deleting the machine at the provider and revoking its keys.',
      };
    case 'DELETED':
      return { label: 'DELETED', tone: 'muted', help: 'Destroyed. Nothing is billing.' };
    case 'ACTIVE':
      break;
  }

  // Lifecycle says ACTIVE — but ACTIVE only means anything if a daemon is
  // actually reporting in. This is where the old badge lied.
  const beat = heartbeatState(server.lastHeartbeatAt, now);
  if (beat === 'fresh') {
    return {
      label: 'ACTIVE',
      tone: 'success',
      help: 'The daemon reported in within the last 60 seconds. The dispatcher can send this server work.',
    };
  }
  if (!server.lastHeartbeatAt) {
    return {
      label: 'UNREACHABLE',
      tone: 'warning',
      help: 'Provisioned, but its daemon has never reported in — so the machine may not exist, may have failed to install, or may never have been started. The dispatcher skips it. (Servers seeded by hand, like the old EC2 box, sit here until a daemon actually runs.)',
    };
  }
  if (beat === 'stale') {
    return {
      label: 'STALE',
      tone: 'warning',
      help: 'Last heartbeat was over 60 seconds ago. The dispatcher has stopped assigning new work; if it stays quiet past 2 minutes its in-flight jobs are reassigned.',
    };
  }
  return {
    label: 'OFFLINE',
    tone: 'destructive',
    help: 'No heartbeat for over 2 minutes — the daemon is down or the machine is gone. The dispatcher skips it and its unfinished jobs are re-dispatched elsewhere.',
  };
}

/**
 * What the Enabled toggle physically does, per provider.
 *
 * Only GCP can stop a VM without paying for it. Hetzner and Oracle bill stopped
 * instances at full price, so "disable" there is a dispatch decision, not a
 * cost decision — the card has to say so rather than implying scale-to-zero.
 */
export function disableBehaviour(server: ComputeServer): {
  stopsBilling: boolean;
  help: string;
  costWarning?: string;
} {
  if (server.provider === 'gcp') {
    return {
      stopsBilling: true,
      help: 'Disabling stops the VM at Google — compute billing pauses. Enabling starts it again (a couple of minutes to boot and re-register).',
    };
  }
  if (server.provider === 'local' || server.provider === 'aws') {
    return {
      stopsBilling: false,
      help: 'Disabling only tells the dispatcher to skip this server. The machine itself is not managed from here.',
    };
  }
  return {
    stopsBilling: false,
    help: 'Disabling tells the dispatcher to skip this server. The machine keeps running.',
    costWarning: `${server.provider === 'hetzner' ? 'Hetzner' : 'Oracle'} bills stopped machines at full price, so this does not save money — use Destroy to stop the cost.`,
  };
}
