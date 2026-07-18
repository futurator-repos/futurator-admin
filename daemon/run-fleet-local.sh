#!/usr/bin/env bash
#
# run-fleet-local.sh — run the Futurator agent daemon on the operator's
# laptop in FULL-PIPELINE mode (start|stop|status|logs), so this Mac behaves
# like a fleet worker box instead of a queue-only responder.
#
# Leave run-local.sh UNTOUCHED — it is the legacy queue-only runner
# (DAEMON_QUEUE_ONLY=1, claims only 'local'-targeted queue-request jobs).
# This script is the opposite: DAEMON_QUEUE_ONLY=0, so the daemon claims
# pipeline/party/free-agent jobs too, same as EC2.
#
# ── Identity contract (daemon/lib/server-identity.mjs, Servers module
#    Task 18 spec §5.2) ──
#   resolveServerId(env):
#     1. env.SERVER_ID set        → that literal id (a Servers-module fleet
#                                    box: Hetzner/Oracle/GCE, provisioned by
#                                    cloud-init with an explicit SERVER_ID).
#     2. env.DAEMON_SOURCE==='ec2' → 'srv_ec2_main'.
#     3. otherwise                 → 'srv_local_mac'.
#   This script MUST NEVER set SERVER_ID — that would make this daemon
#   impersonate a fleet box's server row (server-identity.mjs's own warning:
#   "a laptop daemon with no env at all must never impersonate EC2" applies
#   symmetrically to fleet rows). With SERVER_ID unset and DAEMON_SOURCE=local,
#   resolveServerId() lands on 'srv_local_mac' — the seeded row this script
#   heartbeats as, polls under, and claims jobs under.
#
# ── P3 env-flag parity (see envFindings in the task write-up / commit) ──
#   Every P3_* pipeline flag defaults through daemon/lib/pipeline-flags.mjs's
#   registry, and that registry's own doc comment states plainly: "daemon/.env
#   currently pins no P3_ flags, so these registry defaults are what actually
#   runs on the box today" — i.e. EC2 production achieves full-pipeline
#   behavior by setting NOTHING and trusting the registry defaults. True EC2
#   parity for this Mac is therefore to ALSO set nothing here: pinning values
#   that merely restate today's defaults would silently diverge from EC2 the
#   moment an operator changes the registry, which is exactly the drift this
#   script exists to avoid. PREWORK_GATE_ENABLED and the TOUCH_POINT_* flags
#   default to enabled directly in agent-daemon.mjs (opt OUT via ...=false),
#   so they need no explicit value either. AC_CARTOGRAPHER and
#   P3_QA_AUTOFIX_MAX are read only by the API/cron Lambdas (functions/api,
#   functions/cron) — this daemon process never touches them, so they do not
#   belong in a daemon env file at all.
#
# Requirements on the laptop (same as run-local.sh):
#   - AWS credentials in the default profile (or AWS_PROFILE set) with
#     DynamoDB access to the futurator-* tables (region eu-central-1 — this
#     Mac targets the migrated AWS account/region, not run-local.sh's legacy
#     us-east-1).
#   - `claude` CLI on PATH, authenticated (macOS Keychain / Max subscription).
#   - `cd daemon && npm install` already run.
#
# Usage:
#   ./run-fleet-local.sh start   — background the daemon, write a pidfile.
#   ./run-fleet-local.sh stop    — SIGTERM, wait for graceful shutdown, SIGKILL.
#   ./run-fleet-local.sh status  — pid liveness + recent log tail.
#   ./run-fleet-local.sh logs    — tail -f the daemon log.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── Identity guard — refuse to run if the caller's shell already exports
#    SERVER_ID. That would silently turn this into a fleet-box impersonator
#    (see the identity contract above). Fleet boxes are provisioned by
#    cloud-init, not this script.
if [[ -n "${SERVER_ID:-}" ]]; then
  echo "error: SERVER_ID is set in the environment (\"$SERVER_ID\")." >&2
  echo "       run-fleet-local.sh is the srv_local_mac identity and must run" >&2
  echo "       with SERVER_ID UNSET. unset it and re-run." >&2
  exit 1
fi

# ── Fixed identity + mode (NOT operator-overridable — these two ARE the
#    contract this script exists to enforce; see header). ──
export DAEMON_SOURCE=local
export DAEMON_QUEUE_ONLY=0

# ── Operator-overridable knobs (${VAR:-default} pattern, like run-local.sh). ──
export MAX_CONCURRENT="${MAX_CONCURRENT:-2}"
export AWS_REGION="${AWS_REGION:-eu-central-1}"
ROOT="${ROOT:-$HOME/FuturatorFleet}"
export PROJECTS_ROOT="${PROJECTS_ROOT:-$ROOT/projects}"
export FUTURATOR_WORKTREE_ROOT="${FUTURATOR_WORKTREE_ROOT:-$ROOT/worktrees}"
export FUTURATOR_EVENT_LOG_DIR="${FUTURATOR_EVENT_LOG_DIR:-$ROOT/logs/events}"
export FUTURATOR_MEMORY_ROOT="${FUTURATOR_MEMORY_ROOT:-$ROOT/memory}"
export QUEUE_RUN_ROOT="${QUEUE_RUN_ROOT:-$ROOT/queue-runs}"
# ── Bare-repo + legacy-projects roots (daemon/lib/story-worktree.mjs env
#    family, also consumed by the app-bootstrap saga's reposRoot). These two
#    default to /home/ubuntu/{repos,projects} inside the daemon, which is not
#    writable on a Mac — without the exports, app-bootstrap's bare-clone step
#    EACCESes and setupStoryWorktree throws 'bare repo missing'. Point them at
#    this host's roots (legacy projects root == PROJECTS_ROOT: same dirs).
#    NOTE: legacy step-based pipelines additionally shell out via
#    `sudo -u ubuntu` (story-worktree.mjs runGit, wave-merge-runner.mjs), which
#    has no equivalent on macOS — those paths remain effectively EC2-only even
#    with correct roots. app-bootstrap itself runs plain git and works here.
export FUTURATOR_BARE_REPOS_ROOT="${FUTURATOR_BARE_REPOS_ROOT:-$ROOT/repos}"
export FUTURATOR_LEGACY_PROJECTS_ROOT="${FUTURATOR_LEGACY_PROJECTS_ROOT:-$PROJECTS_ROOT}"

# ── Agentic VQA lane (daemon/lib/agentic-vqa-runner.mjs). The runner reads
#    BROWSER_AGENT_API_KEY ONLY — never ANTHROPIC_API_KEY, which would flip the
#    spawned `claude` CLI from the Max subscription to per-token billing. Source
#    the key from the operator's BrowserAgent project .env when present; absent
#    key ⇒ the agentic lane self-reports skipped (never fails QA).
BROWSER_AGENT_ENV="$HOME/GetReal/elevenLabsConcepts/BrowserAgent/.env"
if [ -z "${BROWSER_AGENT_API_KEY:-}" ] && [ -f "$BROWSER_AGENT_ENV" ]; then
  BROWSER_AGENT_API_KEY="$(grep '^ANTHROPIC_API_KEY=' "$BROWSER_AGENT_ENV" | head -1 | cut -d= -f2-)"
fi
export BROWSER_AGENT_API_KEY
export BROWSER_AGENT_URL="${BROWSER_AGENT_URL:-http://127.0.0.1:3010}"
export AGENTIC_VQA_MODE="${AGENTIC_VQA_MODE:-auto}"

LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/daemon.log"
PID_FILE="$ROOT/daemon.pid"
GRACEFUL_SHUTDOWN_WAIT_S=35 # daemon's own GRACEFUL_SHUTDOWN_MS defaults to 30000ms; +5s buffer

mkdir -p "$PROJECTS_ROOT" "$FUTURATOR_WORKTREE_ROOT" "$FUTURATOR_EVENT_LOG_DIR" \
  "$FUTURATOR_MEMORY_ROOT" "$QUEUE_RUN_ROOT" "$FUTURATOR_BARE_REPOS_ROOT" "$LOG_DIR"

pid_alive() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

cmd_start() {
  if ! command -v node >/dev/null 2>&1; then
    echo "error: node not found on PATH" >&2
    exit 1
  fi
  if ! command -v claude >/dev/null 2>&1; then
    echo "error: claude CLI not found on PATH (install + authenticate first)" >&2
    exit 1
  fi

  if [[ -f "$PID_FILE" ]]; then
    local existing_pid
    existing_pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if pid_alive "$existing_pid"; then
      echo "already running (pid $existing_pid) — see: $0 status"
      exit 1
    fi
    echo ">>> stale pidfile ($existing_pid not alive) — removing"
    rm -f "$PID_FILE"
  fi

  echo ">>> Starting FULL-PIPELINE local Futurator daemon (source=local, queue-only=0) as srv_local_mac"
  echo "    ROOT=$ROOT  region=$AWS_REGION  maxConcurrent=$MAX_CONCURRENT"
  echo "    log: $LOG_FILE"

  cd "$SCRIPT_DIR"
  nohup node agent-daemon.mjs >>"$LOG_FILE" 2>&1 &
  local pid=$!
  disown "$pid" 2>/dev/null || true
  echo "$pid" >"$PID_FILE"
  echo ">>> started (pid $pid)"
}

cmd_stop() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "not running (no pidfile at $PID_FILE)"
    exit 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if ! pid_alive "$pid"; then
    echo "not running (stale pidfile for pid $pid) — removing"
    rm -f "$PID_FILE"
    exit 0
  fi

  echo ">>> Sending SIGTERM to pid $pid (graceful shutdown, up to ${GRACEFUL_SHUTDOWN_WAIT_S}s)"
  kill -TERM "$pid" 2>/dev/null || true

  local waited=0
  while pid_alive "$pid" && [[ "$waited" -lt "$GRACEFUL_SHUTDOWN_WAIT_S" ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if pid_alive "$pid"; then
    echo ">>> pid $pid still alive after ${GRACEFUL_SHUTDOWN_WAIT_S}s — SIGKILL"
    kill -9 "$pid" 2>/dev/null || true
  fi

  rm -f "$PID_FILE"
  echo ">>> stopped"
}

cmd_status() {
  if [[ ! -f "$PID_FILE" ]]; then
    echo "STOPPED (no pidfile at $PID_FILE)"
    exit 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if pid_alive "$pid"; then
    echo "RUNNING (pid $pid)"
  else
    echo "STOPPED (stale pidfile for pid $pid)"
  fi
  if [[ -f "$LOG_FILE" ]]; then
    local last
    last="$(grep -ai 'heartbeat' "$LOG_FILE" 2>/dev/null | tail -1 || true)"
    if [[ -n "$last" ]]; then
      echo "last heartbeat-related log line:"
      echo "  $last"
    else
      echo "recent log tail (no heartbeat line found yet):"
      tail -n 5 "$LOG_FILE" | sed 's/^/  /'
    fi
  else
    echo "no log file yet at $LOG_FILE"
  fi
}

cmd_logs() {
  if [[ ! -f "$LOG_FILE" ]]; then
    echo "no log file yet at $LOG_FILE (has the daemon been started?)" >&2
    exit 1
  fi
  exec tail -f "$LOG_FILE"
}

case "${1:-}" in
  start) cmd_start ;;
  stop) cmd_stop ;;
  status) cmd_status ;;
  logs) cmd_logs ;;
  *)
    echo "Usage: $0 {start|stop|status|logs}" >&2
    exit 1
    ;;
esac
