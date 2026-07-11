#!/usr/bin/env bash
#
# run-local.sh — run the Futurator agent daemon on the operator's laptop to
# service 'local'-targeted Queues-module calls (the topbar Local/EC2 toggle).
#
# Safe to run CONCURRENTLY with the EC2 daemon:
#   - DAEMON_SOURCE=local     → claims only queue-request jobs whose target is
#                               'local' (target routing, job-router.mjs).
#   - DAEMON_QUEUE_ONLY=1      → claims ONLY queue-request jobs, never pipeline/
#                               party/free-agent jobs (those stay on EC2). Without
#                               this a laptop daemon would hijack production
#                               pipeline jobs and run them in the wrong place.
#
# Requirements on the laptop:
#   - AWS credentials in the default profile (or AWS_PROFILE set) with DynamoDB
#     access to the futurator-* tables (region us-east-1).
#   - `claude` CLI on PATH, authenticated (macOS Keychain / Max subscription).
#     The daemon's OAuth-file check will WARN (macOS keeps creds in the Keychain,
#     not a file) but the auth probe passes and spawned `claude` uses Keychain.
#   - `cd daemon && npm install` already run.
#
# Table names default to the production futurator-* tables (agent-daemon.mjs), so
# no per-table env is needed. Ctrl-C to stop.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export DAEMON_SOURCE=local
export DAEMON_QUEUE_ONLY=1
export AWS_REGION="${AWS_REGION:-us-east-1}"
# Local scratch for each queue run (EC2 uses /home/ubuntu/queue-runs; the API
# leaves workingDir unset for 'local' targets so the runner falls back here).
export QUEUE_RUN_ROOT="${QUEUE_RUN_ROOT:-$HOME/futurator-queue-runs}"
mkdir -p "$QUEUE_RUN_ROOT"

echo ">>> Starting LOCAL Futurator daemon (source=local, queue-only)"
echo "    QUEUE_RUN_ROOT=$QUEUE_RUN_ROOT  region=$AWS_REGION"
echo "    Claims only 'local'-targeted queue-request jobs; EC2 keeps the pipeline."
exec node agent-daemon.mjs
