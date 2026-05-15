/**
 * cost-engine.mjs — Pipeline v2 Phase 2-D / Story 2-D-9-1 (PR-97) +
 *                   Story 2-D-16-1 (PR-99) cost-history.
 *
 * v2.5 §29 — the cost engine is **federated cost shims**. Each AWS
 * service kind has a pure function that estimates monthly USD for a
 * given service entry. Shims ship as skills (v2.3 federation) so
 * pricing updates land via SKILL-SCOUT, not core engine releases.
 *
 * This module ships the built-in shims for the six kinds COMPILER
 * generates today (s3, dynamodb, lambda, ecs-fargate, ecs-fargate-gpu,
 * bedrock-model-access). Other kinds register via `registerShim()`.
 *
 * Cost-history (Story 2-D-16): per-project monthly cost file written by
 * the drift cron (Story 3-S-3). Append-only — every monthly snapshot
 * stays for audit + rigor-promotion cost-delta comparison.
 */

import { appendFileSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';

// ── Built-in cost shims (v2.5 §29.3 shim skill format) ────────────────────

/**
 * Rough USD/month estimates. Numbers are order-of-magnitude — operators
 * promote to real Infracost / AWS Pricing API integration via Story
 * 3-C-9 (CodeArtifact MCP) when accuracy matters.
 */
const BUILTIN_SHIMS = {
  's3': (svc) => {
    // ~$0.023/GB; assume 10 GB unless declared.
    const gb = Number(svc.expectedGb ?? 10);
    return 0.023 * gb;
  },
  'dynamodb': (svc) => {
    if (svc.billing === 'provisioned') {
      const rcu = Number(svc['provisioned-rcu'] ?? 5);
      const wcu = Number(svc['provisioned-wcu'] ?? 5);
      return 0.13 * rcu + 0.65 * wcu;
    }
    // pay-per-request: 10 RCU × 1e6 + 10 WCU × 1e6 ≈ $1.25 + $6.25 ≈ $8 nominal
    return 8;
  },
  'lambda': (svc) => {
    const invocations = Number(svc.expectedMonthlyInvocations ?? 100_000);
    const avgMs = Number(svc.expectedAvgMs ?? 200);
    const memMb = Number(svc.memory ?? 256);
    // $0.20/1M requests + $1.67e-5 / GB-sec
    const reqCost = (invocations / 1_000_000) * 0.2;
    const computeCost = (invocations * (avgMs / 1000) * (memMb / 1024)) * 1.67e-5;
    return reqCost + computeCost;
  },
  'ecs-fargate': (svc) => {
    const cpu = Number(svc.cpu ?? 512);
    const mem = Number(svc.memory ?? 1024);
    const desired = Number(svc.desired ?? 1);
    // ~$0.04048/vCPU-hour + $0.004445/GB-hour, 24/7 = 730h
    const vcpu = cpu / 1024;
    const gb = mem / 1024;
    return (vcpu * 0.04048 + gb * 0.004445) * 730 * desired;
  },
  'ecs-fargate-gpu': (svc) => {
    const desired = Number(svc.desired ?? 0);
    // ECS Fargate-GPU pricing is roughly $0.50/hour per task (T4 GPU
    // baseline). When desired=0 (scale-to-zero), cost is dominated by
    // EventBridge wakeups — assume ~$5/month.
    if (desired === 0) return 5;
    return desired * 0.5 * 730;
  },
  'bedrock-model-access': (svc) => {
    const provisioned = Boolean(svc['provisioned-throughput']);
    if (provisioned) {
      // Anthropic Claude Sonnet 4 provisioned MU is ~$15/hour
      const units = Number(svc['provisioned-units'] ?? 1);
      return units * 15 * 730;
    }
    // On-demand: budget per model token usage — assume $50/mo baseline.
    return 50;
  },
  'cloudfront': () => 5, // freebie tier covers most projects
  'api-gateway': () => 5,
  'secrets-manager': (svc) => {
    const secretCount = Array.isArray(svc.secrets) ? svc.secrets.length : 1;
    return 0.4 * secretCount;
  },
  'sqs': () => 2,
  'sns': () => 1,
};

const registeredShims = new Map(Object.entries(BUILTIN_SHIMS));

/**
 * Register a custom cost shim for a service kind. Operators wire this
 * from a `cost-shim-<kind>` skill (PR-72 SKILL-SCOUT federation).
 *
 * @param {string} kind
 * @param {(service: object) => number} estimateFn  returns USD/month
 */
export function registerShim(kind, estimateFn) {
  if (typeof estimateFn !== 'function') {
    throw new Error(`cost-engine: shim for ${kind} must be a function`);
  }
  registeredShims.set(kind, estimateFn);
}

/**
 * Estimate the monthly cost of one service entry. Falls back to 0 for
 * unrecognized kinds (operator's responsibility to ship a shim skill).
 */
export function estimateService(service) {
  if (!service || typeof service !== 'object') return 0;
  const shim = registeredShims.get(service.kind);
  if (!shim) return 0;
  try {
    const usd = Number(shim(service));
    return Number.isFinite(usd) && usd >= 0 ? usd : 0;
  } catch {
    return 0;
  }
}

/**
 * Estimate the monthly cost of all services in one environment.
 *
 * @returns {{ totalUsd: number, perService: Array<{ name: string, kind: string, usd: number }>, unsupported: string[] }}
 */
export function estimateEnvironmentCost(env) {
  const services = Array.isArray(env?.services) ? env.services : [];
  const perService = [];
  const unsupported = [];
  let totalUsd = 0;
  for (const service of services) {
    if (!registeredShims.has(service.kind)) {
      unsupported.push(`${service.kind} (${service.name})`);
      perService.push({ name: String(service.name), kind: String(service.kind), usd: 0 });
      continue;
    }
    const usd = estimateService(service);
    totalUsd += usd;
    perService.push({ name: String(service.name), kind: String(service.kind), usd });
  }
  return { totalUsd, perService, unsupported };
}

/**
 * Estimate cost across all envs of a manifest. ARCHITECT uses this for
 * the cost-delta line on decision cards (v2.5 §46 — "Cost delta — per-
 * environment monthly USD change").
 */
export function estimateManifestCost(manifest) {
  const envs = manifest?.environments ?? {};
  const out = {};
  for (const [envName, env] of Object.entries(envs)) {
    out[envName] = estimateEnvironmentCost(env);
  }
  return out;
}

/**
 * Check the monthly cost against the manifest's cost-envelope. Returns
 * the list of (env, ratio) pairs that have crossed the alert-at or
 * monthly-usd-max threshold.
 */
export function checkCostEnvelope({ manifest, estimatedByEnv }) {
  const envelope = manifest?.['cost-envelope'] ?? {};
  const flags = [];
  for (const envName of ['dev', 'staging', 'production']) {
    const maxUsd = envelope?.[envName]?.['monthly-usd-max'];
    if (typeof maxUsd !== 'number') continue;
    const usd = estimatedByEnv?.[envName]?.totalUsd ?? 0;
    if (usd >= maxUsd) {
      flags.push({ env: envName, severity: 'high', estimatedUsd: usd, maxUsd, ratio: usd / maxUsd });
    } else {
      const alertAt = envelope[envName]?.['alert-at'];
      if (typeof alertAt === 'number' && usd >= alertAt) {
        flags.push({
          env: envName,
          severity: 'medium',
          estimatedUsd: usd,
          maxUsd,
          alertAt,
          ratio: usd / maxUsd,
        });
      }
    }
  }
  return flags;
}

// ── Cost history (Story 2-D-16-1 / PR-99) ─────────────────────────────────

/**
 * Append a monthly cost snapshot to per-project cost history. v2.5 §37
 * — track over rigor changes for trend visibility.
 *
 *   `<workingDir>/.deployment/cost-history.csv`
 *   timestamp,month,env,kind,usd
 *
 * Append-only; rigor-upgrade plans read this for cost-delta surfacing.
 */
export function appendCostHistoryRow({ workingDir, snapshot }) {
  const path = costHistoryPath(workingDir);
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, 'timestamp,month,env,kind,usd\n', 'utf-8');
  }
  appendFileSync(
    path,
    `${snapshot.timestamp},${snapshot.month},${snapshot.env},${snapshot.kind},${snapshot.usd.toFixed(4)}\n`,
    'utf-8',
  );
  return path;
}

function costHistoryPath(workingDir) {
  return join(workingDir, '.deployment', 'cost-history.csv');
}

/**
 * Read the full cost-history. Returns empty array when file missing.
 *
 * @returns {Array<{ timestamp: string, month: string, env: string, kind: string, usd: number }>}
 */
export function readCostHistory(workingDir) {
  const path = costHistoryPath(workingDir);
  if (!existsSync(path)) return [];
  const lines = readFileSync(path, 'utf-8').split('\n').filter(Boolean);
  if (lines.length < 2) return [];
  return lines.slice(1).map((line) => {
    const [timestamp, month, env, kind, usd] = line.split(',');
    return { timestamp, month, env, kind, usd: Number(usd) };
  });
}

/**
 * Roll up history to month-level per-env totals.
 *
 * @returns {Array<{ month: string, env: string, totalUsd: number }>}
 */
export function rollupCostHistory(workingDir) {
  const rows = readCostHistory(workingDir);
  const buckets = new Map(); // `${month}::${env}` → totalUsd
  for (const row of rows) {
    const key = `${row.month}::${row.env}`;
    buckets.set(key, (buckets.get(key) ?? 0) + row.usd);
  }
  return Array.from(buckets.entries())
    .map(([key, totalUsd]) => {
      const [month, env] = key.split('::');
      return { month, env, totalUsd };
    })
    .sort((a, b) => (a.month + a.env).localeCompare(b.month + b.env));
}

export const REGISTERED_SHIM_KINDS = () => Array.from(registeredShims.keys()).sort();
