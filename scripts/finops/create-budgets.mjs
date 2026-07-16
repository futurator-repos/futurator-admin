#!/usr/bin/env node
/**
 * scripts/finops/create-budgets.mjs
 *
 * Creates (or updates, idempotently) an AWS Budgets monthly COST budget for
 * Futurator-Admin, scoped to the cost-allocation tag App=futurator-admin,
 * limit $50 USD/month, with an email notification at 80% ACTUAL spend.
 *
 * The AWS Budgets API is a global service with a single us-east-1 endpoint —
 * every `aws budgets` call below is pinned `--region us-east-1` regardless of
 * where the underlying resources (eu-central-1) actually live. CostFilters
 * still target the resource-level tag.
 *
 * Dependency-free: shells out to the AWS CLI via child_process.execSync.
 *
 * Usage:
 *   node scripts/finops/create-budgets.mjs
 */

import { execSync } from 'node:child_process';
import { writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const PROFILE = 'FuturatorClaude';
const BUDGETS_REGION = 'us-east-1'; // AWS Budgets is global; single endpoint in us-east-1.
const BUDGET_NAME = 'futurator-admin-monthly';
const MONTHLY_LIMIT_USD = '50';
const NOTIFY_EMAIL = 'rica.araya.f@gmail.com';
const COST_ALLOCATION_TAG_KEY = 'App';
const COST_ALLOCATION_TAG_VALUE = 'futurator-admin';
const NOTIFICATION_THRESHOLD_PERCENT = 80;

function awsEnv() {
  return { ...process.env, AWS_EC2_METADATA_DISABLED: 'true' };
}

/** Run an AWS CLI command against the (global) Budgets endpoint, parse JSON. */
function awsBudgets(args) {
  const cmd = `aws budgets ${args} --region ${BUDGETS_REGION} --profile ${PROFILE} --output json`;
  const out = execSync(cmd, { env: awsEnv(), encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  const trimmed = out.trim();
  return trimmed.length > 0 ? JSON.parse(trimmed) : {};
}

/** Run an arbitrary AWS CLI command (e.g. sts), parse JSON. */
function awsCli(args) {
  const cmd = `aws ${args} --profile ${PROFILE} --output json`;
  const out = execSync(cmd, { env: awsEnv(), encoding: 'utf8', maxBuffer: 1024 * 1024 * 16 });
  const trimmed = out.trim();
  return trimmed.length > 0 ? JSON.parse(trimmed) : {};
}

function getAccountId() {
  const identity = awsCli('sts get-caller-identity');
  if (!identity.Account) {
    throw new Error('Could not resolve account id from `aws sts get-caller-identity`.');
  }
  return identity.Account;
}

function buildBudgetDefinition() {
  return {
    BudgetName: BUDGET_NAME,
    BudgetType: 'COST',
    TimeUnit: 'MONTHLY',
    BudgetLimit: {
      Amount: MONTHLY_LIMIT_USD,
      Unit: 'USD',
    },
    CostFilters: {
      TagKeyValue: [`user:${COST_ALLOCATION_TAG_KEY}$${COST_ALLOCATION_TAG_VALUE}`],
    },
    CostTypes: {
      IncludeCredit: true,
      IncludeDiscount: true,
      IncludeOtherSubscription: true,
      IncludeRecurring: true,
      IncludeRefund: true,
      IncludeSubscription: true,
      IncludeSupport: true,
      IncludeTax: true,
      IncludeUpfront: true,
      UseAmortized: false,
      UseBlended: false,
    },
  };
}

function buildNotificationsWithSubscribers() {
  return [
    {
      Notification: {
        NotificationType: 'ACTUAL',
        ComparisonOperator: 'GREATER_THAN',
        Threshold: NOTIFICATION_THRESHOLD_PERCENT,
        ThresholdType: 'PERCENTAGE',
      },
      Subscribers: [
        {
          SubscriptionType: 'EMAIL',
          Address: NOTIFY_EMAIL,
        },
      ],
    },
  ];
}

function budgetExists(accountId) {
  try {
    awsBudgets(
      `describe-budget --account-id ${accountId} --budget-name ${JSON.stringify(BUDGET_NAME)}`,
    );
    return true;
  } catch (err) {
    if (String(err.message || err).includes('NotFoundException')) return false;
    throw err;
  }
}

function writeJsonTempFile(prefix, data) {
  // Kept out of the CLI arg string to dodge shell-quoting issues with nested JSON.
  const path = join(tmpdir(), `${prefix}-${process.pid}-${Date.now()}.json`);
  writeFileSync(path, JSON.stringify(data), 'utf8');
  return path;
}

function createBudget(accountId) {
  const budgetPath = writeJsonTempFile('futurator-admin-budget', buildBudgetDefinition());
  const notificationsWithSubscribersPath = writeJsonTempFile(
    'futurator-admin-notifications',
    buildNotificationsWithSubscribers(),
  );
  try {
    awsBudgets(
      `create-budget --account-id ${accountId} ` +
        `--budget file://${budgetPath} ` +
        `--notifications-with-subscribers file://${notificationsWithSubscribersPath}`,
    );
  } finally {
    safeUnlink(budgetPath);
    safeUnlink(notificationsWithSubscribersPath);
  }
}

function updateBudget(accountId) {
  const budgetPath = writeJsonTempFile('futurator-admin-budget', buildBudgetDefinition());
  try {
    awsBudgets(`update-budget --account-id ${accountId} --new-budget file://${budgetPath}`);
  } finally {
    safeUnlink(budgetPath);
  }
  reconcileNotification(accountId);
}

/** Ensure the 80%-ACTUAL email notification exists; create it if missing. */
function reconcileNotification(accountId) {
  const existing = awsBudgets(
    `describe-notifications-for-budget --account-id ${accountId} ` +
      `--budget-name ${JSON.stringify(BUDGET_NAME)}`,
  );
  const hasTargetNotification = (existing.Notifications || []).some(
    (n) =>
      n.NotificationType === 'ACTUAL' &&
      n.ComparisonOperator === 'GREATER_THAN' &&
      n.ThresholdType === 'PERCENTAGE' &&
      Number(n.Threshold) === NOTIFICATION_THRESHOLD_PERCENT,
  );
  if (hasTargetNotification) return;

  const notification = buildNotificationsWithSubscribers()[0];
  const notificationPath = writeJsonTempFile('futurator-admin-notification', notification.Notification);
  const subscribersPath = writeJsonTempFile('futurator-admin-subscribers', notification.Subscribers);
  try {
    awsBudgets(
      `create-notification --account-id ${accountId} --budget-name ${JSON.stringify(BUDGET_NAME)} ` +
        `--notification file://${notificationPath} --subscribers file://${subscribersPath}`,
    );
  } finally {
    safeUnlink(notificationPath);
    safeUnlink(subscribersPath);
  }
}

function safeUnlink(path) {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup only
  }
}

function main() {
  const accountId = getAccountId();
  const exists = budgetExists(accountId);

  if (!exists) {
    createBudget(accountId);
    console.log(
      `[finops] created budget "${BUDGET_NAME}" — $${MONTHLY_LIMIT_USD}/mo, ` +
        `tag ${COST_ALLOCATION_TAG_KEY}=${COST_ALLOCATION_TAG_VALUE}, ` +
        `${NOTIFICATION_THRESHOLD_PERCENT}% ACTUAL alert -> ${NOTIFY_EMAIL} ` +
        `(account ${accountId}, Budgets endpoint us-east-1)`,
    );
    return;
  }

  updateBudget(accountId);
  console.log(
    `[finops] budget "${BUDGET_NAME}" already existed — updated to $${MONTHLY_LIMIT_USD}/mo ` +
      `and reconciled the ${NOTIFICATION_THRESHOLD_PERCENT}% ACTUAL alert -> ${NOTIFY_EMAIL} ` +
      `(account ${accountId}, Budgets endpoint us-east-1)`,
  );
}

main();
