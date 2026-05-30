# Backlog — daemon log-spam dedup/suppression (hardening)

> **Status:** Deferred follow-up (logged 2026-05-30). NOT urgent — logrotate
> (200 MB cap, daily, keep 3) caps the disk risk. This is the root-cause
> hardening so a future missing permission / hot error path can't spam again.

## Context (the 2026-05-30 disk-full incident)

`/var/log/futurator-daemon.log` grew to 5.8 GB and filled the EC2 root disk
(100%), which silently broke the pipeline (no worktree/build/rsync could
write). Root cause: the daemon role was missing `dynamodb:GetItem` on
`futurator-remediation-policies` and `futurator-agent-flags`; the
attention-poller (per open attention item) and the pause-check (every tick)
each logged a **verbose multi-line `AccessDenied` WARN every poll tick** —
measured at ~2,000 lines/min (48 MB/hour). With no rotation it grew unbounded.

Both IAM gaps were granted + logrotate installed (incident closed). This
backlog item is the remaining _code-level_ hardening.

## The weakness

The daemon logs repeating per-tick WARNs (IAM denials, and likely other hot
error paths) with **no dedup/suppression** — full ARN error string each time.
IAM is fixed now, but the _pattern_ is fragile: any future missing permission,
or a hot error in the poll loop, spams at the same rate.

## Proposed fix (pick one or combine)

1. **Log-once + suppress repeats:** a small `logOnce(key, level, msg)` /
   rate-limited logger keyed by message shape — emit the first occurrence, then
   `"…(suppressed N more in last 60s)"`. Apply to the attention-poller +
   paused-check WARNs first.
2. **Cache `AccessDenied` and stop re-attempting:** when a DDB lookup throws
   `AccessDenied`, cache that for the table+action for N minutes and skip the
   call (fail-open/closed as today) instead of re-hitting + re-logging every
   tick. Surface ONE attention item ("daemon role missing perm X") instead of
   log spam.
3. **Don't log the full ARN error on every tick** — log the table+action once;
   keep the verbose form behind a debug flag.

## Acceptance

- A simulated missing-permission (or any hot poll-loop error) produces O(1)
  log lines/min, not O(ticks).
- An operator gets a single durable signal (attention item) for a missing
  permission, not a 5.8 GB log.

## Related

- logrotate config: `/etc/logrotate.d/futurator-daemon` (the disk safety net).
- IAM: daemon role `develope-it-ec2-ssm` `dynamodb-access` inline policy.
