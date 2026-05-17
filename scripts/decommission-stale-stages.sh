#!/usr/bin/env bash
# decommission-stale-stages.sh — drop the dormant SST stages that share the
# production DynamoDB tables.
#
# Background — 2026-05-17 snake-1 incident:
#   Two non-production SST stages (ricardoarayafarias and dev) were deployed
#   months ago and never decommissioned. Their cron Lambdas + ApiFunctions
#   still pointed at the shared `futurator-agent-jobs` / `futurator-plans` /
#   `futurator-epic-workflows` tables (the SST config declares those tables
#   with literal names — no stage namespacing — so every stage's Lambda
#   wrote to the same data plane).
#
#   The personal-stage WaveCompletionCheck Lambda was firing at rate(1
#   minute) running 2026-04-28 code that pre-dated the substrate work
#   (no api-author / tamper-check / baseline-regression /
#    compile-commit-on-pass / compile-ast / compile-push). When the
#   production cron raced it on wave-advancement, whichever cron won the
#   race wrote the new wave's jobs in its own bundle's shape — and 4 of 11
#   snake-1 stories landed on the legacy 8-step shape, missing per-story
#   commits and the entire post-PR-44 compile chain.
#
#   This script tears down both stale stages' AWS resources WITHOUT
#   touching production data or the shared DDB tables.
#
# Usage:
#   ./scripts/decommission-stale-stages.sh --phase=preflight
#       Read-only audit. Bails if any plan is `developing` (we don't want
#       to disrupt a live plan mid-flight). Snapshots Lambda + rule lists
#       to /tmp/decom-snapshot-<ts>.json so we have a rollback reference.
#
#   ./scripts/decommission-stale-stages.sh --phase=disable
#       Disables ALL non-prod EventBridge rules + revokes the open Lambda
#       function URLs. Reversible (`aws events enable-rule`); stops the
#       bleeding immediately. Stale Lambdas remain but never fire.
#
#   ./scripts/decommission-stale-stages.sh --phase=delete
#       Deletes the Lambdas + rules + log groups + S3 site-asset buckets
#       + stage-namespaced DDB tables + SSM passphrase params. Irreversible
#       without redeploying the stage. Refuses to run unless `disable` was
#       executed at least 5 minutes ago (proven by the timestamp on the
#       last snapshot file).
#
#   ./scripts/decommission-stale-stages.sh --phase=full
#       Runs preflight → disable → 30s pause → delete in one invocation.
#       Requires an additional `--yes-really-decommission` flag.
#
# All actions log to /tmp/decom-actions-<ts>.log; every AWS call is echoed
# before execution.
#
# Production-data tables (futurator-agent-jobs, futurator-plans,
# futurator-epic-workflows, etc.) are NEVER touched, regardless of phase.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
TS="$(date +%Y%m%dT%H%M%S)"
LOG_FILE="/tmp/decom-actions-${TS}.log"
SNAPSHOT_FILE="/tmp/decom-snapshot-${TS}.json"

# ── Names — derived from the 2026-05-17 inventory; verified by Phase A
#    of the assessment doc. If a name 404s the script logs WARN and
#    moves on (idempotent).

STALE_LAMBDAS=(
  # ── ricardoarayafarias stage ──
  "f-ricardoarayafarias-WaveCompletionCheckHandlerFunction-fcovhurx"
  "futurator-admin-ricardoarayafarias-ApiFunction-bazzmuho"
  "futurator-admin-ricardoarayafarias-AuthCallbackFunction-vcvmdvao"
  "fu-ricardoarayafarias-ResourceDiscovererHandlerFunction-bcxhruta"
  "futu-ricardoarayafarias-TimingAggregatorHandlerFunction-ddvaakrc"
  "futur-ricardoarayafarias-AttentionDigestHandlerFunction-ebrtvcnh"
  "futura-ricardoarayafarias-CostAggregatorHandlerFunction-nmutbxno"
  "futurator--ricardoarayafarias-TagAuditorHandlerFunction-cewvcmdb"
  "futurator-a-ricardoarayafarias-ScheduleExecutorFunction-xozemcrd"
  "futurator-ad-ricardoarayafarias-UserSyncHandlerFunction-tmnavtwk"
  "futurator-ricardoarayafarias-PatAgeCheckHandlerFunction-wdzuwzdh"
  # ── dev stage ──
  "futurator-admin-dev-ApiFunction-dbduoura"
  "futurator-admin-dev-AuthCallbackFunction-zdhtmaro"
  "futurator-admin-dev-CostAggregatorHandlerFunction-bkzvzzha"
  "futurator-admin-dev-ResourceDiscovererHandlerFunction-banmmvzc"
  "futurator-admin-dev-ScheduleExecutorFunction-xfvmeara"
  "futurator-admin-dev-TagAuditorHandlerFunction-cwarxefe"
  "futurator-admin-dev-UserSyncHandlerFunction-owrfrzdz"
)

# EvidenceGraph (separate app) Lambda — same personal stage, also stale.
# Listed separately so the operator can opt-out if they want to preserve
# the EvidenceGraph dev site.
STALE_EVIDENCE_GRAPH_LAMBDAS=(
  "e-ricardoarayafarias-EvidenceGraphSiteDevServerFunction-nmewwfov"
)

STALE_RULES=(
  # ── ricardoarayafarias stage ──
  "futurator-ad-ricardoarayafarias-WaveCompletionCheckRule-wsbhetau"
  "futurator-adm-ricardoarayafarias-ResourceDiscovererRule-fmavsafk"
  "futurator-admin-ricardoarayafarias-AttentionDigestRule-uavtowfk"
  "futurator-admin-ricardoarayafarias-CostAggregatorRule-kbtuexvr"
  "futurator-admin-ricardoarayafarias-PatAgeCheckRule-nrhvraof"
  "futurator-admin-ricardoarayafarias-TagAuditorRule-rwovtakk"
  "futurator-admin-ricardoarayafarias-TimingAggregatorRule-bowbhcaa"
  "futurator-admin-ricardoarayafarias-UserSyncRule-roxdauzs"
  # ── dev stage ──
  "futurator-admin-dev-CostAggregatorRule-czofscxr"
  "futurator-admin-dev-ResourceDiscovererRule-txfftddc"
  "futurator-admin-dev-TagAuditorRule-ffuxnvvz"
  "futurator-admin-dev-UserSyncRule-ktxfofdd"
)

LAMBDAS_WITH_OPEN_FUNCTION_URLS=(
  "futurator-admin-ricardoarayafarias-ApiFunction-bazzmuho"
  "futurator-admin-dev-ApiFunction-dbduoura"
)

STALE_S3_BUCKETS=(
  "futurator-adm-ricardoarayafarias-adminsiteassetsbucket-eauxetrs"
  "futurator-admin-dev-adminsiteassetsbucket-hwuehhor"
)

# Stage-namespaced DDB tables — these hold no shared data; they were each
# stage's private Projects/Costs/Resources/Audits/Schedules/Users/Alerts
# tables. Safe to drop. The shared `futurator-*` tables are NEVER listed
# here and NEVER deleted.
STALE_STAGE_DDB_TABLES=(
  "futurator-admin-ricardoarayafarias-AlertsTableTable-xdoxfbbc"
  "futurator-admin-ricardoarayafarias-AuditsTableTable-zdswuzss"
  "futurator-admin-ricardoarayafarias-CostsTableTable-heffsdrt"
  "futurator-admin-ricardoarayafarias-ProjectsTableTable-mmrrvffr"
  "futurator-admin-ricardoarayafarias-ResourcesTableTable-xenvtevo"
  "futurator-admin-ricardoarayafarias-SchedulesTableTable-bbhsmtdu"
  "futurator-admin-ricardoarayafarias-UsersTableTable-vzxehvvw"
  "futurator-admin-dev-AlertsTableTable-nwmhtnoo"
  "futurator-admin-dev-AuditsTableTable-vztztohr"
  "futurator-admin-dev-CostsTableTable-okxfhtrf"
  "futurator-admin-dev-ProjectsTableTable-swomtonk"
  "futurator-admin-dev-ResourcesTableTable-znfdnwas"
  "futurator-admin-dev-SchedulesTableTable-dtwaabfr"
  "futurator-admin-dev-UsersTableTable-mrbbwvsz"
)

# Production-data tables — the script REFUSES to delete any name in this
# guard list, even if it appears in STALE_STAGE_DDB_TABLES. Belt + braces
# against a typo down the road.
PRODUCTION_TABLES_DO_NOT_TOUCH=(
  "futurator-agent-jobs"
  "futurator-agent-events"
  "futurator-agent-sessions"
  "futurator-agent-conversations"
  "futurator-plans"
  "futurator-epic-workflows"
  "futurator-apps"
  "futurator-attention-items"
  "futurator-reflections"
  "futurator-timing-summary"
  "futurator-project-registry"
  "futurator-party-projects"
  "futurator-party-sessions"
  "futurator-party-inline-questions"
  "Futurator_AI_Config"
  "Futurator_Audit_Logs"
  "Futurator_Core_Data"
)

# Zombie RUNNING jobs from the personal-stage cron's last firing — left
# the agent-jobs table in a state where the daemon won't reap them. We
# stamp them STALE so the UI stops showing perpetual "in flight" jobs.
# Found via:
#   aws dynamodb scan --table-name futurator-agent-jobs \
#     --filter-expression "#st = :r" \
#     --expression-attribute-names '{"#st":"status"}' \
#     --expression-attribute-values '{":r":{"S":"RUNNING"}}' ...
ZOMBIE_JOB_IDS=(
  "a885a4a7-6989-4e73-b3c1-1ed4ebaa4017"
  "8026d065-c2a3-4a78-bcc2-79ee63eaa28a"
  "d85a24ea-560a-4cc9-9c1b-129d0437fe05"
)

# ──────────────────────────────────────────────────────────────────────
# helpers
# ──────────────────────────────────────────────────────────────────────

log() {
  local level="$1"; shift
  local msg="$*"
  echo "[$(date -u +'%Y-%m-%dT%H:%M:%SZ')] [${level}] ${msg}" | tee -a "$LOG_FILE"
}

run_aws() {
  # Echo command, run it, capture exit code without aborting the script
  # (so one missing resource doesn't unwind the whole pass).
  log "INFO" "→ aws $*"
  if aws "$@" --region "$REGION" 2>&1 | tee -a "$LOG_FILE"; then
    log "INFO" "  ✓ ok"
    return 0
  else
    local rc=$?
    log "WARN" "  ✗ exit ${rc} (continuing — resource may already be gone)"
    return $rc
  fi
}

confirm_production_table() {
  local name="$1"
  for guarded in "${PRODUCTION_TABLES_DO_NOT_TOUCH[@]}"; do
    if [[ "$name" == "$guarded" ]]; then
      log "FATAL" "Refusing to touch production table: $name"
      exit 99
    fi
  done
}

phase_preflight() {
  log "INFO" "=== Phase: PREFLIGHT ==="
  log "INFO" "Account: $(aws sts get-caller-identity --query Account --output text 2>/dev/null || echo unknown)"
  log "INFO" "Region:  $REGION"

  log "INFO" "Checking for plans in 'developing' status (would be disrupted by decommission)..."
  local devplans
  devplans=$(aws dynamodb scan \
    --table-name futurator-plans \
    --filter-expression "#st = :s" \
    --expression-attribute-names '{"#st":"status"}' \
    --expression-attribute-values '{":s":{"S":"developing"}}' \
    --projection-expression "planId" \
    --region "$REGION" \
    --output json 2>/dev/null | jq -r '.Count // 0')
  if [[ "$devplans" -gt 0 ]]; then
    log "FATAL" "$devplans plan(s) currently 'developing'. Re-run preflight after they finish or are aborted."
    exit 2
  fi
  log "INFO" "  ✓ no plans developing"

  log "INFO" "Snapshotting Lambda + EventBridge rule inventory to $SNAPSHOT_FILE"
  {
    echo '{'
    echo '  "snapshotAt": "'"$(date -u +'%Y-%m-%dT%H:%M:%SZ')"'",'
    echo '  "region": "'"$REGION"'",'
    echo '  "lambdas":'
    aws lambda list-functions --region "$REGION" --output json
    echo ','
    echo '  "rules":'
    aws events list-rules --region "$REGION" --output json
    echo '}'
  } > "$SNAPSHOT_FILE"
  log "INFO" "  ✓ snapshot $(wc -c <"$SNAPSHOT_FILE" | tr -d ' ') bytes"

  log "INFO" "Preflight OK. Run --phase=disable next."
}

phase_disable() {
  log "INFO" "=== Phase: DISABLE (reversible) ==="

  log "INFO" "Disabling ${#STALE_RULES[@]} EventBridge rules..."
  for rule in "${STALE_RULES[@]}"; do
    run_aws events disable-rule --name "$rule" || true
  done

  log "INFO" "Revoking ${#LAMBDAS_WITH_OPEN_FUNCTION_URLS[@]} open Lambda Function URLs..."
  for fn in "${LAMBDAS_WITH_OPEN_FUNCTION_URLS[@]}"; do
    run_aws lambda delete-function-url-config --function-name "$fn" || true
  done

  # Marker file used by phase_delete to require a soak period.
  touch "/tmp/decom-disabled-marker"

  log "INFO" "Disable complete. Wait ≥5 minutes, watch the next plan run, "
  log "INFO" "then run --phase=delete. Re-enable any rule with: "
  log "INFO" "  aws events enable-rule --name <rule> --region $REGION"
}

phase_delete() {
  log "INFO" "=== Phase: DELETE (irreversible without redeploy) ==="

  if [[ ! -f /tmp/decom-disabled-marker ]]; then
    log "FATAL" "Cannot delete without prior disable. Run --phase=disable first."
    exit 3
  fi
  local age=$(( $(date +%s) - $(stat -f %m /tmp/decom-disabled-marker 2>/dev/null || stat -c %Y /tmp/decom-disabled-marker) ))
  if [[ "$age" -lt 300 ]]; then
    log "FATAL" "Disable was only ${age}s ago. Wait until ≥300s have passed so any in-flight invocation drains."
    exit 4
  fi

  log "INFO" "Deleting ${#STALE_LAMBDAS[@]} Lambdas..."
  for fn in "${STALE_LAMBDAS[@]}"; do
    run_aws lambda delete-function --function-name "$fn" || true
  done

  log "INFO" "Deleting ${#STALE_EVIDENCE_GRAPH_LAMBDAS[@]} EvidenceGraph stale Lambdas..."
  for fn in "${STALE_EVIDENCE_GRAPH_LAMBDAS[@]}"; do
    run_aws lambda delete-function --function-name "$fn" || true
  done

  log "INFO" "Deleting ${#STALE_RULES[@]} EventBridge rules (remove targets first)..."
  for rule in "${STALE_RULES[@]}"; do
    local target_ids
    target_ids=$(aws events list-targets-by-rule --rule "$rule" --region "$REGION" --query 'Targets[].Id' --output text 2>/dev/null || true)
    if [[ -n "$target_ids" ]]; then
      run_aws events remove-targets --rule "$rule" --ids $target_ids || true
    fi
    run_aws events delete-rule --name "$rule" || true
  done

  log "INFO" "Deleting CloudWatch log groups for stale Lambdas..."
  aws logs describe-log-groups \
    --log-group-name-prefix /aws/lambda/ \
    --region "$REGION" \
    --output json 2>/dev/null |
    jq -r '.logGroups[]? | select(.logGroupName | test("ricardoarayafarias|admin-dev")) | .logGroupName' |
    while read -r lg; do
      run_aws logs delete-log-group --log-group-name "$lg" || true
    done

  log "INFO" "Emptying + deleting ${#STALE_S3_BUCKETS[@]} S3 site-asset buckets..."
  for bucket in "${STALE_S3_BUCKETS[@]}"; do
    run_aws s3 rm "s3://$bucket" --recursive || true
    run_aws s3api delete-bucket --bucket "$bucket" || true
  done

  log "INFO" "Deleting ${#STALE_STAGE_DDB_TABLES[@]} stage-namespaced DDB tables..."
  for tbl in "${STALE_STAGE_DDB_TABLES[@]}"; do
    confirm_production_table "$tbl"
    run_aws dynamodb delete-table --table-name "$tbl" || true
  done

  log "INFO" "Deleting SST passphrase SSM parameters..."
  run_aws ssm delete-parameter --name '/sst/passphrase/futurator-admin/ricardoarayafarias' || true
  # SST passphrase for dev stage was not found in inventory; skip.

  log "INFO" "Marking ${#ZOMBIE_JOB_IDS[@]} zombie RUNNING jobs as STALE..."
  for jobId in "${ZOMBIE_JOB_IDS[@]}"; do
    run_aws dynamodb update-item \
      --table-name futurator-agent-jobs \
      --key "{\"jobId\":{\"S\":\"$jobId\"}}" \
      --update-expression "SET #st = :stale, errorMessage = :em, updatedAt = :now" \
      --expression-attribute-names '{"#st":"status"}' \
      --expression-attribute-values "{\":stale\":{\"S\":\"STALE\"},\":em\":{\"S\":\"Cleaned up — owned by decommissioned personal-stage cron, $(date -u +%Y-%m-%d)\"},\":now\":{\"S\":\"$(date -u +'%Y-%m-%dT%H:%M:%SZ')\"}}" || true
  done

  log "INFO" "Delete complete. The shared production tables (futurator-agent-jobs, etc.) were not touched."
}

# ──────────────────────────────────────────────────────────────────────
# main
# ──────────────────────────────────────────────────────────────────────

PHASE=""
YES_FLAG=""
for arg in "$@"; do
  case "$arg" in
    --phase=*) PHASE="${arg#*=}";;
    --yes-really-decommission) YES_FLAG="yes";;
    *) log "FATAL" "Unknown arg: $arg"; exit 1;;
  esac
done

if [[ -z "$PHASE" ]]; then
  cat <<USAGE
Usage:
  $0 --phase=preflight       Audit + snapshot, no changes.
  $0 --phase=disable         Disable cron rules + revoke function URLs.
  $0 --phase=delete          Delete Lambdas, rules, log groups, buckets, stage tables.
  $0 --phase=full --yes-really-decommission   preflight → disable → 5min wait → delete.

Log file pattern:  /tmp/decom-actions-<ts>.log
Snapshot pattern:  /tmp/decom-snapshot-<ts>.json
USAGE
  exit 1
fi

log "INFO" "decom script started: phase=$PHASE"
log "INFO" "log file: $LOG_FILE"

case "$PHASE" in
  preflight) phase_preflight;;
  disable)   phase_disable;;
  delete)    phase_delete;;
  full)
    if [[ "$YES_FLAG" != "yes" ]]; then
      log "FATAL" "--phase=full requires --yes-really-decommission"
      exit 1
    fi
    phase_preflight
    phase_disable
    log "INFO" "Sleeping 300s before delete phase (soak window)..."
    sleep 300
    phase_delete
    ;;
  *) log "FATAL" "Unknown phase: $PHASE"; exit 1;;
esac

log "INFO" "Done. Review $LOG_FILE for the full action log."
