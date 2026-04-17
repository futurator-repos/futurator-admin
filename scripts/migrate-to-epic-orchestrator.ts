/**
 * EO-7.1 — In-Flight Job Migration.
 *
 * Invoked manually by a release manager around the orchestrator cutover.
 * Classifies legacy per-story agent-jobs (jobs without `phase: 'epic-dev'`)
 * and — with `--apply` — takes the reported actions.
 *
 * Usage:
 *   npx tsx scripts/migrate-to-epic-orchestrator.ts --dry-run
 *   npx tsx scripts/migrate-to-epic-orchestrator.ts --apply
 *
 * Audit trail: each run writes a JSONL audit file and a summary report under
 * `scripts/migrations/<iso-timestamp>/`. (The Epic 7 spec mentions a
 * `futurator-audit` DDB table; the project's only audits table has a
 * project-compliance schema that does not fit migration records, so we emit a
 * local JSONL audit instead — which is appropriate for a manual operator tool
 * and matches the convention of `scripts/migrate-project-descriptions.ts`.)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { deleteJob, scanAllJobs } from '../functions/shared/repositories/agent-jobs-repository';
import type { AgentJob, AgentJobStatus } from '../functions/shared/types/agent-orchestrator';

// ── Classification ───────────────────────────────────────────────────────

export type MigrationAction =
  | 'skip-already-orchestrator' // phase === 'epic-dev' — nothing to do
  | 'skip-terminal' // COMPLETED / FAILED — already done
  | 'drain-eligible' // RUNNING, near completion — let it finish naturally
  | 'convert-to-epic-dev' // PENDING — delete, next epic run uses orchestrator
  | 'block-migration-on'; // RUNNING, ambiguous — requires operator decision

export interface MigrationClassification {
  jobId: string;
  status: AgentJobStatus | 'UNKNOWN';
  phase: string | undefined;
  createdAt: string;
  epicId?: string;
  action: MigrationAction;
  reason: string;
}

/**
 * Pure classifier — no DDB access, easy to unit-test against fixtures.
 *
 * Near-complete heuristic: a RUNNING job whose `currentStepIndex` points at
 * the final pipeline step (or beyond) is "draining". Anything earlier is
 * ambiguous and must block migration.
 */
export function classifyJob(job: AgentJob): MigrationClassification {
  const base = {
    jobId: job.jobId,
    status: job.status ?? 'UNKNOWN',
    phase: job.phase,
    createdAt: job.createdAt,
    epicId: job.epicId,
  };

  if (job.phase === 'epic-dev') {
    return {
      ...base,
      action: 'skip-already-orchestrator',
      reason: 'Job is already on the orchestrator pipeline',
    };
  }

  if (job.status === 'COMPLETED' || job.status === 'FAILED') {
    return { ...base, action: 'skip-terminal', reason: `Job is ${job.status}` };
  }

  if (job.status === 'PENDING') {
    return {
      ...base,
      action: 'convert-to-epic-dev',
      reason: 'Legacy PENDING job — delete so the epic re-dispatches via the orchestrator',
    };
  }

  if (job.status === 'RUNNING') {
    const totalSteps = job.pipeline?.steps?.length ?? 0;
    const currentStep = job.currentStepIndex ?? 0;
    if (totalSteps > 0 && currentStep >= totalSteps - 1) {
      return {
        ...base,
        action: 'drain-eligible',
        reason: `On final pipeline step (${currentStep + 1}/${totalSteps}) — let it complete`,
      };
    }
    return {
      ...base,
      action: 'block-migration-on',
      reason: `RUNNING on step ${currentStep + 1}/${totalSteps || '?'} — operator must drain or abort before cutover`,
    };
  }

  return {
    ...base,
    action: 'block-migration-on',
    reason: `Unexpected status ${String(job.status)} — operator review required`,
  };
}

export interface ClassificationSummary {
  total: number;
  byAction: Record<MigrationAction, number>;
  classifications: MigrationClassification[];
  blockers: MigrationClassification[];
}

export function summarize(jobs: AgentJob[]): ClassificationSummary {
  const classifications = jobs.map(classifyJob);
  const byAction: Record<MigrationAction, number> = {
    'skip-already-orchestrator': 0,
    'skip-terminal': 0,
    'drain-eligible': 0,
    'convert-to-epic-dev': 0,
    'block-migration-on': 0,
  };
  for (const c of classifications) byAction[c.action] += 1;
  return {
    total: jobs.length,
    byAction,
    classifications,
    blockers: classifications.filter((c) => c.action === 'block-migration-on'),
  };
}

// ── CLI ──────────────────────────────────────────────────────────────────

interface AuditEntry {
  timestamp: string;
  mode: 'dry-run' | 'apply';
  jobId: string;
  action: MigrationAction;
  reason: string;
  taken: 'reported' | 'deleted' | 'left-running' | 'skipped';
  error?: string;
}

function parseArgs(argv: string[]): { dryRun: boolean; apply: boolean } {
  const dryRun = argv.includes('--dry-run');
  const apply = argv.includes('--apply');
  return { dryRun, apply };
}

async function writeAudit(
  outDir: string,
  summary: ClassificationSummary,
  entries: AuditEntry[],
  mode: 'dry-run' | 'apply',
): Promise<void> {
  await mkdir(outDir, { recursive: true });

  const jsonl = entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  await writeFile(join(outDir, 'migration-audit.jsonl'), jsonl, 'utf-8');

  const report = [
    `# Epic Orchestrator Migration — ${mode}`,
    `Date: ${new Date().toISOString()}`,
    '',
    `Total jobs scanned: ${summary.total}`,
    '',
    '## Action counts',
    ...Object.entries(summary.byAction).map(([k, v]) => `- ${k}: ${v}`),
    '',
    '## Blockers (require operator decision)',
    summary.blockers.length === 0
      ? '_None_'
      : summary.blockers.map((b) => `- ${b.jobId} (${b.status}) — ${b.reason}`).join('\n'),
    '',
  ].join('\n');
  await writeFile(join(outDir, 'report.md'), report, 'utf-8');
}

async function main(): Promise<void> {
  const { dryRun, apply } = parseArgs(process.argv.slice(2));

  if (dryRun === apply) {
    console.error('Pass exactly one of --dry-run or --apply');
    process.exit(2);
  }

  const mode = apply ? 'apply' : 'dry-run';
  console.log(`Migration mode: ${mode}`);
  console.log('Scanning agent-jobs table...');

  const jobs = await scanAllJobs();
  const summary = summarize(jobs);

  console.log(`\nScanned ${summary.total} jobs.`);
  console.log('Action counts:');
  for (const [k, v] of Object.entries(summary.byAction)) {
    console.log(`  ${k}: ${v}`);
  }

  const entries: AuditEntry[] = [];
  const now = () => new Date().toISOString();

  for (const c of summary.classifications) {
    if (!apply) {
      entries.push({
        timestamp: now(),
        mode: 'dry-run',
        jobId: c.jobId,
        action: c.action,
        reason: c.reason,
        taken: 'reported',
      });
      continue;
    }

    try {
      switch (c.action) {
        case 'convert-to-epic-dev':
          await deleteJob(c.jobId);
          entries.push({
            timestamp: now(),
            mode: 'apply',
            jobId: c.jobId,
            action: c.action,
            reason: c.reason,
            taken: 'deleted',
          });
          break;
        case 'drain-eligible':
          entries.push({
            timestamp: now(),
            mode: 'apply',
            jobId: c.jobId,
            action: c.action,
            reason: c.reason,
            taken: 'left-running',
          });
          break;
        case 'block-migration-on':
          entries.push({
            timestamp: now(),
            mode: 'apply',
            jobId: c.jobId,
            action: c.action,
            reason: c.reason,
            taken: 'reported',
          });
          break;
        default:
          entries.push({
            timestamp: now(),
            mode: 'apply',
            jobId: c.jobId,
            action: c.action,
            reason: c.reason,
            taken: 'skipped',
          });
      }
    } catch (err) {
      entries.push({
        timestamp: now(),
        mode: 'apply',
        jobId: c.jobId,
        action: c.action,
        reason: c.reason,
        taken: 'skipped',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'scripts', 'migrations', stamp);
  await writeAudit(outDir, summary, entries, mode);
  console.log(`\nAudit written to: ${outDir}`);

  if (summary.blockers.length > 0) {
    console.log(
      `\n⚠  ${summary.blockers.length} job(s) block migration — resolve before re-running --apply.`,
    );
    if (apply) process.exit(1);
  }
}

// Only run when invoked as a script, not when imported by tests.
const entryUrl = `file://${process.argv[1] ?? ''}`;
if (import.meta.url === entryUrl) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
